# Phase 1 — Read-Only Repository and Live Deployment Audit Report

Date: 2026-07-26  
Repository: `E:\IMP PROJECT 2\TABLET ROOTED\tablet-control`  
Model: Read-only audit; no files changed except this report and `implementation_plan.md`.

---

## 1. Current Git State

| Item                                      | Value                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current branch                            | `final-system-repair`                                                                                                                                                            |
| HEAD commit                               | `fe52c73` — "Self-healing implementation: unbounded kiosk retries, Windows watchdog, startup task update"                                                                        |
| Tags                                      | `v1.0.0`                                                                                                                                                                         |
| Working-tree changes                      | `scripts/watchdog.ps1` modified (unstaged, 63 insertions, 24 deletions)                                                                                                          |
| Other branches                            | `main`, `post-v1-final-completion`                                                                                                                                               |
| Stash                                     | Empty                                                                                                                                                                            |
| Ignored files                             | `.env.local`, `.local/`, `apps/*/dist/`, `apps/*/node_modules/`, `apps/tablet-agent/.gradle/`, `apps/tablet-agent/app/build/`, `artifacts/`, `node_modules/`, `packages/*/dist/` |
| Uncommitted Android files                 | None (all tracked)                                                                                                                                                               |
| No commit created                         | **Confirmed**                                                                                                                                                                    |
| No files changed other than planning docs | **Confirmed**                                                                                                                                                                    |

### Latest relevant commits

- `fe52c73` — Self-healing: kiosk retries, watchdog, startup task
- `3cfec0e` — Preserve Companion 2.0 and recent App/Media fixes
- `f7c4db3` — Remote interaction features (Live Text, App Launch, Animated Messages)
- `0822a24` — Map frontend to live tablet capabilities
- `4a008f6` — Restore tablet dashboard through private HTTPS

---

## 2. Deployed API and Web Versions

| Component                 | Value                 | Source                                            |
| ------------------------- | --------------------- | ------------------------------------------------- |
| Controller API version    | `0.1.0`               | `GET /api/v1/version` → `apiBuildVersion`         |
| Web build version         | `0.1.0`               | `GET /api/v1/version` → `webBuildVersion`         |
| Git commit                | `local`               | `GET /api/v1/version` → `gitCommit` (env not set) |
| Adapter mode              | `companion`           | `GET /api/v1/version` → `adapterMode`             |
| Static bundle             | `served`              | `GET /api/v1/version` → `staticBundle`            |
| Service worker            | `enabled`             | `GET /api/v1/version` → `serviceWorker`           |
| Companion package version | `2.0` (versionCode 2) | `apps/tablet-agent/app/build.gradle.kts:22`       |

### Running controller process

| Property        | Value                    |
| --------------- | ------------------------ |
| PID             | 43584                    |
| Port            | 3001                     |
| Binding         | `127.0.0.1` (loopback)   |
| NODE_ENV        | production               |
| Tailscale serve | Configured for port 3001 |

---

## 3. Production Asset Result

| Endpoint                         | Status | Notes                                                    |
| -------------------------------- | ------ | -------------------------------------------------------- |
| `GET /` (index.html)             | 200    | Hashed assets: `index-Dsjbihkt.js`, `index-ffgzc3I3.css` |
| `GET /assets/index-Dsjbihkt.js`  | 200    | 298 KB — correct production bundle                       |
| `GET /assets/index-ffgzc3I3.css` | 200    | 24 KB — correct production CSS                           |
| `GET /manifest.webmanifest`      | 200    | 372 bytes, SVG icons                                     |
| `GET /registerSW.js`             | 200    | 134 bytes — SW registration                              |
| `GET /sw.js`                     | 200    | 1225 bytes — Workbox precache                            |
| `GET /workbox-39fa566e.js`       | 200    | 15 KB                                                    |
| `GET /pwa-192.svg`               | 200    | 367 bytes                                                |
| `GET /pwa-512.svg`               | 200    | 367 bytes                                                |
| `GET /api/v1/version`            | 200    | Unauthenticated, returns build info                      |
| `GET /api/v1/health`             | 200    | Reports all 3 services healthy                           |
| `GET /api/v1/capabilities`       | 401    | Correctly requires session                               |
| `GET /black`                     | 200    | Static black HTML page                                   |

**Finding:** The source `index.html` still contains `<script type="module" src="/src/main.tsx">` but the served `dist/index.html` correctly references hashed assets. The source reference is misleading for anyone reading `index.html` directly but does not affect production.

**Service worker:** Registers via `registerSW.js`, precaches `index.html`, hashed assets, manifest, and SVG icons. API routes use `NetworkOnly` handler — no credential caching.

---

## 4. Current Authentication Architecture

### Controller authentication (browser → controller)

- Session cookie with signed+encrypted cookie value (`@fastify/cookie`)
- CSRF token required for all state-changing requests
- In-memory session store (sessions lost on restart)
- Login rate limited: 10 requests/minute
- Session TTL: 8 hours
- Secure flag on cookie in production mode

### Companion authentication (controller → Companion)

- Bearer token in `Authorization` header: `Bearer <secret>`
- Secret from `TABLET_COMPANION_SECRET` env var stored in `BuildConfig.COMPANION_SECRET`
- Compared with simple string inequality `auth != "Bearer ${secret}"` — **NOT constant-time**

### Key architectural correctness

| Requirement                                   | Status                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Controller → Companion authenticated request  | ✅ Correct direction                                               |
| Browser receives Companion secret             | ✅ Never                                                           |
| Secret in gitignored server-side config       | ✅ `.env.local`                                                    |
| Secret in Android application-private storage | ❌ Stored in BuildConfig (compiled, not encrypted runtime storage) |
| Android Keystore backing                      | ❌ Not used                                                        |
| Constant-time comparison                      | ❌ Simple string comparison                                        |
| Secret rotation                               | ❌ No mechanism                                                    |

---

## 5. Hard-Coded Development Secret

**YES** — One hard-coded fallback exists:

- `apps/tablet-agent/app/build.gradle.kts:26`:
  ```
  val companionSecret = System.getenv("TABLET_COMPANION_SECRET") ?: "dev-secret-change-before-use"
  ```

This is a fallback if the env var is not set at build time. There is no equivalent fallback in the controller config (controller requires explicit env var).

No other secrets appear in tracked files. The Fully Kiosk exit PIN was previously inadvertently committed and was rotated/replaced with `<FULLY_EXIT_PIN>` in commit history.

---

## 6. Windows and Companion Authentication Match

The controller and Companion share the same secret through the `TABLET_COMPANION_SECRET` environment variable:

- Controller reads `TABLET_COMPANION_SECRET` at runtime from `.env.local` → `config.companion.secret`
- Companion is built with `TABLET_COMPANION_SECRET` compiled into `BuildConfig.COMPANION_SECRET`

**They match** because the same env var value is used at runtime (controller) and was used at build time (Companion APK). However, no automated verification currently confirms they are in sync — a mismatch produces a 401 from Companion, which the controller reports as "Companion rejected the authorization header."

---

## 7. Existing Feature Matrix

Classification key: ✅ implemented and wired, ⚠️ partial/needs work, ❌ absent, 🔲 not physically tested, 🚫 unsupported

| Feature             | Web UI                     | Controller API                     | Companion/Kiosk                                | Live capability                   | Physical proof              |
| ------------------- | -------------------------- | ---------------------------------- | ---------------------------------------------- | --------------------------------- | --------------------------- |
| Apps inventory      | ✅ AppsPanel               | ✅ `GET /device/apps`              | ✅ `ApprovedApps.kt`                           | ✅ 9 approved apps listed         | ✅ Verified in Phase 6 docs |
| App launch          | ✅ AppsPanel launch btn    | ✅ `POST /device/apps/launch`      | ✅ `ApprovedApps.launch()` via monkey          | ✅ VLC launch verified            | ✅ Phase 6                  |
| Return Home         | ✅ DevicePanel restore btn | ✅ `POST /display/restore`         | ✅ `KioskController.restoreDashboard()`        | ✅ Dashboard return verified      | ✅ Phase 6                  |
| Hold-to-talk        | ✅ TalkPanel hold btn      | ✅ WebSocket `/api/v1/talk`        | ✅ `POST /audio/start` + AudioTrack            | ✅ 1kHz tone verified             | ✅ Phase 7                  |
| Tap-to-talk         | ❌ Not implemented         | ⚠️ Same WS supports start/stop     | ✅ Same endpoints                              | Not tested                        | ❌                          |
| Tablet listening    | ✅ AudioStream hook        | ✅ `GET /camera/audio` (IP Webcam) | ❌ Not in Companion                            | ✅ IP Webcam mic stream           | 🔲 Not physically tested    |
| Display text        | ✅ DisplayPanel message    | ✅ `POST /display/message`         | ✅ `POST /kiosk/message`                       | ✅ Animated message verified      | ✅ Phase 6                  |
| Live text           | ✅ DisplayPanel live-text  | ✅ `POST /display/live-text`       | ✅ `POST /kiosk/live-text`                     | ✅ Live text verified             | ✅ Phase 6                  |
| Display image       | ✅ UI button wired         | ✅ `POST /display/image`           | ❌ `showMedia()` → 501                         | Not tested                        | 🚫 UNSUPPORTED              |
| Display video       | ✅ UI button wired         | ✅ `POST /display/video`           | ❌ `showMedia()` → 501                         | Not tested                        | 🚫 UNSUPPORTED              |
| Display webpage     | ✅ DisplayPanel URL input  | ✅ `POST /display/webpage`         | ✅ `POST /kiosk/webpage`                       | ✅ WebView verified               | ✅ Phase 5                  |
| Black screen        | ✅ DisplayPanel button     | ✅ `POST /display/black`           | ✅ `POST /kiosk/black`                         | ✅ Black page verified            | ✅ Phase 5                  |
| Restore Home        | ✅ DevicePanel button      | ✅ `POST /display/restore`         | ✅ `POST /kiosk/restore`                       | ✅ Dashboard restored             | ✅ Phase 6                  |
| Orientation control | ✅ DevicePanel selector    | ✅ `POST /device/orientation`      | ✅ `POST /companion/orientation` + RootCommand | Wired but not physically verified | 🔲                          |
| MediaSession status | ❌ Not implemented         | ❌ Not implemented                 | ❌ No MediaController                          | Not available                     | ❌                          |
| Spotify launch      | ✅ Part of approved apps   | ✅ Same app launch path            | ✅ In approved apps list                       | Not tested                        | 🔲                          |
| Music controls      | ✅ MusicPanel buttons      | ✅ `POST /device/media`            | ✅ `POST /companion/media` via keyevent        | ✅ Play/pause verified            | ✅ Phase 6                  |
| Touch lock          | ✅ AdminPanel toggle       | ✅ `POST /device/touch_lock`       | ✅ `POST /companion/touch_lock` + overlay      | Wired, safety not ready           | 🔲 Not tested               |
| Smooth volume       | ✅ DevicePanel slider      | ✅ `POST /device/volume`           | ✅ `TelemetryProvider.setMusicVolume()`        | ✅ Verified                       | ✅ Phase 6                  |
| Smooth brightness   | ✅ DevicePanel slider      | ✅ `POST /device/brightness`       | ✅ `RootCommand.setBrightness()`               | ✅ Verified                       | ✅ Phase 6                  |

---

## 8. Routes That Exist

### Controller API routes (in `routes.ts`)

#### Public (no auth required)

| Route             | Method    | Status     | Notes                          |
| ----------------- | --------- | ---------- | ------------------------------ |
| `/api/v1/health`  | GET       | 200 (live) | Reports all 3 adapters         |
| `/api/v1/version` | GET       | 200 (live) | Build info, adapter mode       |
| `/black`          | GET       | 200 (live) | Static black HTML page         |
| `/api/v1/talk`    | WebSocket | Varies     | Talk WS with origin validation |

#### Session-required (auth, no CSRF)

| Route                     | Method | Notes                      |
| ------------------------- | ------ | -------------------------- |
| `/api/v1/capabilities`    | GET    | Per-feature capability map |
| `/api/v1/tablet/status`   | GET    | Merged tablet telemetry    |
| `/api/v1/tablet/health`   | GET    | Adapter health             |
| `/api/v1/camera/status`   | GET    | IP Webcam status           |
| `/api/v1/camera/stream`   | GET    | MJPEG video proxy          |
| `/api/v1/camera/audio`    | GET    | WAV audio proxy            |
| `/api/v1/camera/snapshot` | GET    | JPEG snapshot              |
| `/api/v1/device/apps`     | GET    | Installed approved apps    |

#### Session + CSRF required (mutations)

| Route                                 | Method | Notes                             |
| ------------------------------------- | ------ | --------------------------------- |
| `/api/v1/auth/login`                  | POST   | 10/min rate limit                 |
| `/api/v1/auth/logout`                 | POST   | Invalidates session               |
| `/api/v1/auth/session`                | GET    | Session info                      |
| `/api/v1/camera/select`               | POST   | Camera switch                     |
| `/api/v1/camera/orientation`          | POST   | Image orientation                 |
| `/api/v1/camera/zoom`                 | POST   | 1.0-4.0×                          |
| `/api/v1/camera/focus`                | POST   | Focus mode                        |
| `/api/v1/camera/autofocus`            | POST   | Trigger AF                        |
| `/api/v1/camera/fps`                  | POST   | 10/15/30                          |
| `/api/v1/camera/resolution`           | POST   | Video resolution                  |
| `/api/v1/camera/quality`              | POST   | JPEG quality                      |
| `/api/v1/camera/torch`                | POST   | Returns 422 (no flash)            |
| `/api/v1/camera/restart`              | POST   | Returns 409 (requires approval)   |
| `/api/v1/display/message`             | POST   | Animated overlay                  |
| `/api/v1/display/live-text`           | POST   | Persistent text                   |
| `/api/v1/display/live-text/clear`     | POST   | Clear live text                   |
| `/api/v1/display/image`               | POST   | Returns 501 (unsupported)         |
| `/api/v1/display/video`               | POST   | Returns 501 (unsupported)         |
| `/api/v1/display/webpage`             | POST   | HTTPS/HTTP URL                    |
| `/api/v1/display/dashboard-start-url` | POST   | Configure dashboard               |
| `/api/v1/display/black`               | POST   | Black screen                      |
| `/api/v1/display/restore`             | POST   | Restore dashboard                 |
| `/api/v1/device/brightness`           | POST   | 0-255                             |
| `/api/v1/device/volume`               | POST   | 0-15                              |
| `/api/v1/device/mute`                 | POST   | Toggle mute                       |
| `/api/v1/device/orientation`          | POST   | auto/portrait/landscape/reverse-* |
| `/api/v1/device/touch_lock`           | POST   | Enable/disable                    |
| `/api/v1/device/apps/launch`          | POST   | Launch approved app               |
| `/api/v1/device/media`                | POST   | play-pause/next/previous          |
| `/api/v1/device/screen`               | POST   | Returns 409 (requires approval)   |
| `/api/v1/device/reboot`               | POST   | Returns 409 (requires approval)   |
| `/api/v1/services/:service/restart`   | POST   | Returns 409 (requires approval)   |

### Companion API routes (Kotlin `CompanionService.kt`)

| Route                                     | Method | Auth   | Notes                                         |
| ----------------------------------------- | ------ | ------ | --------------------------------------------- |
| `/health`                                 | GET    | No     | Public health check                           |
| `/api/v1/companion/status`                | GET    | Bearer | Full telemetry                                |
| `/api/v1/companion/brightness`            | POST   | Bearer | Root: `settings put system screen_brightness` |
| `/api/v1/companion/volume`                | POST   | Bearer | `AudioManager.setStreamVolume`                |
| `/api/v1/companion/mute`                  | POST   | Bearer | Toggle to 0 or previous                       |
| `/api/v1/companion/orientation`           | POST   | Bearer | Root: `settings put system user_rotation`     |
| `/api/v1/companion/apps`                  | GET    | Bearer | PackageManager inventory                      |
| `/api/v1/companion/apps/launch`           | POST   | Bearer | Root: `monkey -p`                             |
| `/api/v1/companion/media`                 | POST   | Bearer | Root: `input keyevent`                        |
| `/api/v1/companion/screen`                | POST   | Bearer | Root: wake/sleep                              |
| `/api/v1/companion/touch_lock`            | POST   | Bearer | KioskActivity overlay                         |
| `/api/v1/companion/audio/start`           | POST   | Bearer | Create AudioTrack (16kHz, mono, Int16)        |
| `/api/v1/companion/audio/frame`           | POST   | Bearer | Binary PCM body                               |
| `/api/v1/companion/audio/stop`            | POST   | Bearer | Release AudioTrack                            |
| `/api/v1/companion/kiosk/status`          | GET    | Bearer | Display mode, foreground, configured          |
| `/api/v1/companion/kiosk/dashboard`       | POST   | Bearer | Configure and load dashboard URL              |
| `/api/v1/companion/kiosk/message`         | POST   | Bearer | Animated overlay text                         |
| `/api/v1/companion/kiosk/live-text`       | POST   | Bearer | Persistent text overlay                       |
| `/api/v1/companion/kiosk/clear-live-text` | POST   | Bearer | Clear text overlay                            |
| `/api/v1/companion/kiosk/webpage`         | POST   | Bearer | WebView load URL                              |
| `/api/v1/companion/kiosk/black`           | POST   | Bearer | Black screen mode                             |
| `/api/v1/companion/kiosk/restore`         | POST   | Bearer | Restore dashboard                             |

---

## 9. Routes That Are Missing

| Route                                 | Priority | Reason                                                    |
| ------------------------------------- | -------- | --------------------------------------------------------- |
| `GET /api/v1/device/media/status`     | Medium   | No MediaSession metadata (track, artist, playback state)  |
| `POST /api/v1/device/media/seek`      | Low      | Seek requires MediaSession integration                    |
| `POST /api/v1/device/media/volume`    | Low      | Media volume via slider works; dedicated route not needed |
| `GET /api/v1/device/apps/technical`   | Low      | Admin diagnostics view not implemented                    |
| `POST /api/v1/companion/media/status` | Medium   | Companion-side MediaSession provider needed first         |
| `POST /api/v1/companion/media/volume` | Low      | Companion already has `/volume` and `/mute`               |

---

## 10. Features Implemented but Not Wired

| Feature                                               | Status                           | Reason                                           |
| ----------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `showMedia()` (image/video)                           | Route exists, adapter throws 501 | No controller-served media upload/serve pipeline |
| Screen on/off (`/api/v1/device/screen`)               | Route exists, returns 409        | Requires explicit approval                       |
| Device reboot (`/api/v1/device/reboot`)               | Route exists, returns 409        | Requires explicit approval                       |
| Service restart (`/api/v1/services/:service/restart`) | Route exists, returns 409        | Requires explicit approval                       |
| Camera restart (`/api/v1/camera/restart`)             | Route exists, returns 409        | Requires explicit approval                       |
| Torch (`/api/v1/camera/torch`)                        | Route exists, returns 422        | No flash hardware                                |

---

## 11. Features Requiring New Android Work

| Feature                       | Android work needed                                                       | Priority | Notes                                     |
| ----------------------------- | ------------------------------------------------------------------------- | -------- | ----------------------------------------- |
| MediaSession integration      | New `MediaSessionProvider.kt` for track metadata, playback state, seek    | High     | Current keyevent-based control is limited |
| Constant-time auth comparison | Modify `CompanionService.kt:82` to use `MessageDigest.isEqual` or similar | High     | Security hardening                        |
| Android Keystore for secret   | New `EncryptedSecretStore.kt`                                             | Medium   | Replace BuildConfig storage               |
| Jitter buffer for talkback    | Modify `handleAudioStart`/`handleAudioFrame`                              | Medium   | Current frame-by-frame is fragile         |
| Touch lock safety safeguards  | Add timeout, fail-unlocked, reboot-reset to `KioskActivity.kt`            | Medium   | Required before enabling                  |
| Orientation persistence       | Modify `KioskActivity.kt` to apply saved orientation                      | Low      | Currently uses system setting             |
| Internal health monitoring    | Modify `CompanionService.kt` for self-restart of HTTP server              | Low      | Companion crash recovery                  |

---

## 12. Corrected Implementation Plan Location

The corrected plan has been written to:

- `E:\IMP PROJECT 2\TABLET ROOTED\tablet-control\implementation_plan.md`

Key corrections from the previous (unapproved) plan:

1. No user choice required for paths — existing `.env.local` mechanism is sufficient.
2. No `secret.txt` — the env-var/BuildConfig mechanism is already functional.
3. No SHA-256 fingerprint as auth secret — PIN hash is for kiosk exit only.
4. Companion is correctly identified as Kotlin/Android at `apps/tablet-agent/app/src/main/java/.../`.
5. Auth direction is correct: Controller → Companion (Bearer token).
6. No libsamplerate needed until measurements prove it.
7. Binary PCM frames defined with a 10-byte binary header (session+seq+timestamp), not inside JSON.
8. Each phase has concrete files, routes, classes, tests, and acceptance criteria.
9. No browser-facing secret fingerprint route exists or is proposed.
10. Existing implementations are clearly separated from missing ones.

---

## 13. No Files Changed Other Than Planning/Evidence Documents

**Confirmed.** The only files created/modified during this audit:

- `implementation_plan.md` — rewritten corrected plan
- `docs/PHASE_1_AUDIT_REPORT.md` — this report

No `.env.local`, source code, configuration, or build artifacts were modified.

---

## 14. No Commit Created

**Confirmed.** The repository working tree remains unchanged except for the pre-existing unstaged `scripts/watchdog.ps1` modification.

---

## 15. Recommended First Build-Agent Task

**Task:** Audit and harden Companion authentication

**Scope:**

1. Read `apps/tablet-agent/app/src/main/java/com/tabletcontrol/companion/CompanionService.kt` — specifically the auth comparison at line 82.
2. Replace the current inequality comparison with a constant-time comparison function.
3. Remove the hard-coded fallback `"dev-secret-change-before-use"` in `build.gradle.kts:26` so the build fails if `TABLET_COMPANION_SECRET` is not set.
4. Verify both changes: the server will still start with the env var set, and will fail without it.
5. Run `npm test` to confirm no regressions.

**Files to modify:**

- `apps/tablet-agent/app/src/main/java/.../CompanionService.kt`
- `apps/tablet-agent/app/build.gradle.kts`

**Verification:** Unit tests pass; companion rejects wrong secret with 401; accepts correct secret.
