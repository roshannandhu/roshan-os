# Phase 6 — Companion Agent

Date: 2026-07-24  
Status: **COMPLETE — all endpoints validated**

## What was built

A foreground Android service (`com.tabletcontrol.companion`) that exposes an HTTP API on port 8765. It provides:

- Read-only tablet telemetry (battery, brightness, screen state, storage, uptime)
- Root-based mutation commands (brightness, volume, mute, screen on/off)
- Bearer token authentication
- A disabled boot receiver (Phase 8 will enable it)

## APK details

| Field          | Value                                                                              |
| -------------- | ---------------------------------------------------------------------------------- |
| Package        | `com.tabletcontrol.companion`                                                      |
| Version        | 1.0 (versionCode 1)                                                                |
| Build tool     | AGP 8.5.0 + Kotlin 1.9.25 + Gradle 8.7                                             |
| JDK            | OpenJDK 17.0.2                                                                     |
| Min SDK        | 30 (Android 11)                                                                    |
| Install method | `adb install -r app/build/outputs/apk/debug/app-debug.apk`                         |
| Auth secret    | Compiled via `BuildConfig.COMPANION_SECRET` from `TABLET_COMPANION_SECRET` env var |

## HTTP API

Port: 8765, accessed via `adb forward tcp:8765 tcp:8765`  
Auth: `Authorization: Bearer {TABLET_COMPANION_SECRET}` header on all non-health routes

| Endpoint                            | Auth   | Status                                           |
| ----------------------------------- | ------ | ------------------------------------------------ |
| `GET /health`                       | None   | 200 OK — `{"ok":true,"data":{"healthy":true}}`   |
| `GET /api/v1/companion/status`      | Bearer | Returns battery/brightness/screen/storage/uptime |
| `POST /api/v1/companion/brightness` | Bearer | `{"value":0-255}` → root command                 |
| `POST /api/v1/companion/volume`     | Bearer | `{"value":0-15}` → root command                  |
| `POST /api/v1/companion/mute`       | Bearer | `{"muted":true/false}` → root command            |
| `POST /api/v1/companion/screen`     | Bearer | `{"on":true/false}` → root command               |

## Source files

All under `apps/tablet-agent/app/src/main/java/com/tabletcontrol/companion/`:

| File                   | Role                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CompanionService.kt`  | Foreground service; starts `SimpleHttpServer`; handles all HTTP routes                                                             |
| `SimpleHttpServer.kt`  | Raw TCP `ServerSocket` HTTP/1.1 server; 4-thread pool                                                                              |
| `TelemetryProvider.kt` | Reads battery (BatteryManager), brightness (Settings.System), screen state (WindowManager), storage (StatFs), uptime (SystemClock) |
| `RootCommand.kt`       | Executes `su -c` commands for brightness, volume, screen key events                                                                |
| `MainActivity.kt`      | Launcher activity; calls `startForegroundService` in `onResume`                                                                    |
| `BootReceiver.kt`      | `android:enabled="false"` — will be enabled in Phase 8                                                                             |

## Controller-side changes

**`apps/controller-api/src/adapters/readwrite-companion.ts`** (new)

- `ReadWriteCompanionAdapter implements CompanionAdapter`
- `call(method, path, body)`: Bearer auth header, AbortSignal timeout, error handling
- `getStatus()` → maps JSON to `TabletStatus` (`mode="companion"`)
- `beginTalk()` / `endTalk()` → throws 501 UNSUPPORTED (Phase 7)

**`apps/controller-api/src/config.ts`**

- Added `CompanionConfig` interface: `{ baseUrl, secret, requestTimeoutMs }`
- Added `companion: CompanionConfig | undefined` to `AppConfig`
- Parses `TABLET_COMPANION_SECRET` + `TABLET_COMPANION_PORT` from env

**`apps/controller-api/src/adapters/index.ts`**

- Wires `ReadWriteCompanionAdapter` when `config.companion` is set

**`packages/shared-types/src/index.ts`**

- Added `"companion"` to `AdapterModeSchema` to support `TabletStatus.mode = "companion"`

## Real-device validation (2026-07-25)

Magisk root granted to `com.tabletcontrol.companion` (UID 10177, policy=2).

Volume discovery: `media` binary absent on LineageOS 18.1; `settings put system volume_music VALUE` is the working path. Rewrote `RootCommand.setMusicVolume()` accordingly. `status` endpoint now includes `mediaVolume` from `Settings.System.volume_music`.

Baseline before tests: brightness=102, volume=5, screenOn=true.

| Operation          | Command                          | Result              | Verified                                                                      |
| ------------------ | -------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| Health (no auth)   | `GET /health`                    | 200 OK              | `healthy:true`                                                                |
| Status             | `GET /api/v1/companion/status`   | 200 OK              | battery:100, charging, temp:30, bright:102, screen:on, vol:5, storage:21922MB |
| Auth rejection     | No header                        | 401 UNAUTHENTICATED | confirmed                                                                     |
| Brightness → 150   | `POST /brightness {"value":150}` | 200 OK              | brightness:150 confirmed via status                                           |
| Volume → 10        | `POST /volume {"value":10}`      | 200 OK              | mediaVolume:10 confirmed via status                                           |
| Mute               | `POST /mute {"muted":true}`      | 200 OK              | volume_music set to 0                                                         |
| Unmute             | `POST /mute {"muted":false}`     | 200 OK              | volume_music restored to 10                                                   |
| Screen sleep       | `POST /screen {"on":false}`      | 200 OK              | screen went dark                                                              |
| Screen wake        | `POST /screen {"on":true}`       | 200 OK              | screen woke                                                                   |
| Restore brightness | `POST /brightness {"value":102}` | 200 OK              | confirmed                                                                     |
| Restore volume     | `POST /volume {"value":5}`       | 200 OK              | mediaVolume:5 confirmed                                                       |

Final state matches baseline: brightness=102, volume=5, screenOn=true.

## Test results

| Suite          | Passed | Total  |
| -------------- | ------ | ------ |
| controller-api | 29     | 29     |
| controller-web | 27     | 27     |
| **Total**      | **56** | **56** |

TypeScript: clean across all packages.

## Hard stops not crossed

- No boot receiver enabled
- No factory reset or irreversible action
- Root grant requires separate approval (not yet granted)
