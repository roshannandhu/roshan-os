# Phase 5 — Fully Kiosk Browser Integration

Date: 2026-07-24  
Status: **COMPLETE**

## Installation record

| Field          | Value                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| Package        | `de.ozerov.fully`                                                           |
| Version        | 1.57.1 (versionCode 101361)                                                 |
| Source         | `https://www.fully-kiosk.com/files/2025/01/Fully-Kiosk-Browser-v1.57.1.apk` |
| SHA-256        | `7867b11e830286eb3f9c4521305603f4225f003e49ea27908eb2e18454125368`          |
| Cert           | Alexey Ozerov, C=DE                                                         |
| Install method | `adb install` (free APK, no Device Owner)                                   |

## Remote Admin API configuration

| Setting              | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| Remote Admin enabled | `remoteAdmin=true` in SharedPreferences                 |
| LAN-only restriction | `remoteAdminLan=true`                                   |
| Port                 | 2323 (default)                                          |
| ADB forward          | `adb forward tcp:2323 tcp:2323`                         |
| Password             | Stored in `.env.local` as `TABLET_FULLY_ADMIN_PASSWORD` |
| Start URL            | `about:blank` (configured in SharedPreferences)         |

## SharedPreferences configuration method

Correct key names (camelCase, no `pref_` prefix) discovered from Fully's 415-line prefs file:

- `remoteAdmin` (boolean)
- `remoteAdminPassword` (string)
- `remoteAdminLan` (boolean)
- `startURL` (not `startUrl`)
- `kioskPin` (not `exitPin`)
- `keepScreenOn` (boolean)
- `kioskMode` (boolean)

Write method: `printf '...' "$PW" | adb shell "su -c 'cat > /data/local/tmp/fkb_update.sed'"` then `sed -i -f /data/local/tmp/fkb_update.sed /data/data/de.ozerov.fully/shared_prefs/de.ozerov.fully_preferences.xml`. Credentials flow through stdin, never appear in terminal or ADB command args.

## Remote Admin command discovery

Tested against Fully 1.57.1. All free-tier commands accept `?type=json` for JSON responses (default is HTML).

| Command                                         | Status    | Notes                                                         |
| ----------------------------------------------- | --------- | ------------------------------------------------------------- |
| `getDeviceInfo`                                 | 200 OK    | Returns battery, brightness, screen state, storage, RAM, etc. |
| `showToast` + `text=`                           | 200 OK    | Toast notification on screen                                  |
| `loadURL` + `url=`                              | 200 OK    | Browser navigates to URL                                      |
| `loadStartURL`                                  | 200 OK    | Reloads configured start URL                                  |
| `setStringSetting&key=screenBrightness&value=N` | 200 OK    | Sets brightness 0–255                                         |
| `screenOn`                                      | 200 OK    | Wakes screen (requires no admin)                              |
| `screenOff`                                     | 200 Error | Requires device admin (PLUS/Device Owner)                     |
| `showMessageOverlay`                            | 404       | Wrong command name — use `showToast`                          |
| `setScreenOn`                                   | 404       | Wrong command name — use `screenOn`/`screenOff`               |

## showBlack() workaround

`screenOff` requires device admin (not available in free tier without Device Owner). Workaround: load a local black HTML file:

1. `black.html` deployed to `/sdcard/black.html` via ADB: `<html><body style="margin:0;background:#000"></body></html>`
2. `showBlack()` → `loadURL?url=file:///sdcard/black.html` → OK

`data:` URIs rejected by Fully with "Invalid URL" error.

## Code changes

**`packages/integration-contracts/src/index.ts`** — no changes (interface already defined)

**`apps/controller-api/src/config.ts`**

- Added `FullyKioskConfig` interface: `{ port, adminPassword, requestTimeoutMs }`
- Added `fully: FullyKioskConfig | undefined` to `AppConfig`
- Parses `TABLET_FULLY_ADMIN_PASSWORD` and `TABLET_FULLY_REMOTE_PORT` from env
- When `TABLET_FULLY_ADMIN_PASSWORD` is present, `config.fully` is set automatically

**`apps/controller-api/src/adapters/readwrite-fully-kiosk.ts`** (new)

- `ReadWriteFullyKioskAdapter implements FullyKioskAdapter`
- `call(cmd, extra)`: builds URL with password, calls Remote Admin, asserts `status="OK"`
- `showMessage(text)` → `showToast`
- `showMedia()` → throws 501 UNSUPPORTED (controller-served media endpoint is Phase 6)
- `showWebpage(url)` → `loadURL`
- `showBlack()` → `loadURL?url=file:///sdcard/black.html`
- `restoreDashboard()` → `loadStartURL`
- `getDisplayMode()` → tracks state locally (no Remote Admin query for current URL)

**`apps/controller-api/src/adapters/index.ts`**

- Imports `ReadWriteFullyKioskAdapter`
- In `real-readonly` mode: if `config.fully` is present, uses real Fully adapter; otherwise falls back to mock

**`apps/controller-api/src/routes.ts`**

- Added `GET /black` (public, no auth): returns minimal black HTML page for future `adb reverse` use

## Test results

| Suite          | Passed | Total  |
| -------------- | ------ | ------ |
| controller-api | 29     | 29     |
| controller-web | 27     | 27     |
| **Total**      | **56** | **56** |

TypeScript: clean across all packages.

## Real-device ADB validation (2026-07-24)

Device: Lenovo Tab M8 HD, HNP06KSC, Fully 1.57.1, port 2323 via `adb forward tcp:2323 tcp:2323`.

| Operation           | Command                                 | Result                                                              |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Remote Admin health | `getDeviceInfo`                         | 200 OK — `batteryLevel: 100, screenOn: true, screenBrightness: 102` |
| Show toast          | `showToast&text=Phase5+Validation`      | 200 OK — toast visible on device                                    |
| Show black          | `loadURL&url=file:///sdcard/black.html` | 200 OK — screen turned black                                        |
| Show webpage        | `loadURL&url=about:blank`               | 200 OK                                                              |
| Restore dashboard   | `loadStartURL`                          | 200 OK — Fully reloaded start URL                                   |

## What remains blocked

- `showMedia()` — throws 501 UNSUPPORTED until controller-served media endpoint (Phase 6)
- `screenOff` (full screen blank) — requires Device Owner or PLUS; current workaround covers the use case
- `showBlack()` requires `black.html` to be deployed on device; setup step needed

## Hard stops not crossed

- No Fully PLUS activation
- No Device Owner provisioning
- No kiosk mode enabled
- No irreversible changes made
