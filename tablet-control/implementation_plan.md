# Wall Tablet Control — Corrected Implementation Plan

## Current State Summary

Production controller live at `127.0.0.1:3001` serving hashed PWA assets and proxying to the tablet Companion (192.168.1.5:8765). Companion Agent v2.0 is installed and running on Android. Fully Kiosk Browser is installed. IP Webcam provides camera streams. The controller runs in `companion` mode behind Tailscale serve.

## Phase 1 — Deployment and Authentication Audit

Inspect the existing configuration and deployment. Confirm whether Windows and Companion secrets match. Verify that the Companion uses constant-time comparison and that no secret leaks to the browser.

**Files to inspect:**

- `.env.local` (gitignored) — controller-side Companion secret and admin credentials
- `apps/tablet-agent/app/build.gradle.kts:26-28` — `BuildConfig.COMPANION_SECRET` from `TABLET_COMPANION_SECRET` env
- `apps/controller-api/src/config.ts:436-441` — `TABLET_COMPANION_SECRET` env-var parsing
- `apps/controller-api/src/adapters/readwrite-companion.ts:16` — Bearer token in Authorization header
- `apps/tablet-agent/app/src/main/java/.../CompanionService.kt:81-84` — auth comparison

**Findings so far (Phase 1 read-only):**

- The Companion stores the secret in `BuildConfig.COMPANION_SECRET` (compiled, not encrypted runtime storage).
- Authentication uses simple string equality, NOT constant-time comparison.
- The controller sends the secret as `Authorization: Bearer <secret>` to Companion — correct direction.
- The browser never receives the Companion secret.
- A hard-coded fallback `"dev-secret-change-before-use"` exists in `build.gradle.kts:26`.
- No Android Keystore or EncryptedSharedPreferences is used.
- No secret rotation mechanism exists.

**Phase 1 action items:**

- Replace the hard-coded fallback `"dev-secret-change-before-use"` in `build.gradle.kts`.
- Add constant-time comparison in `CompanionService.kt` auth check.
- Confirm the secret in `.env.local` matches what was used to build the installed Companion APK.
- Document rotation procedure.

## Phase 2 — Production Build Correction

**Issue:** The source `index.html` references `/src/main.tsx`. The production `dist/` serves correct hashed assets, but the source should not be used as a fallback.

**Files to modify:**

- `apps/controller-web/index.html` — remove `/src/main.tsx` source reference
- `apps/controller-web/vite.config.ts` — confirm VitePWA config and SPA fallback

**Verification:**

- Confirm `dist/index.html` references hashed `assets/index-<hash>.js` only
- Confirm `GET /api/v1/version` returns correct build identifiers
- Confirm service-worker registration succeeds
- Confirm Fastify serves static files and `/black` page

## Phase 3 — Apps Inventory and Control

**Already implemented:**

- `ApprovedApps.kt` — PackageManager-based inventory of 9 approved app IDs
- `POST /api/v1/companion/apps/launch` in Companion — uses `monkey` root command
- `GET /api/v1/device/apps` controller route proxies to Companion
- `POST /api/v1/device/apps/launch` controller route proxies to Companion
- AppsPanel frontend component displaying installed apps with launch buttons

**Remaining issues:**

- App launch uses root `monkey` shell command instead of direct Android Intent. Refactor to `PackageManager.getLaunchIntentForPackage` + `startActivity` if non-root allows.
- Only 9 hardcoded apps. Consider making allowlist configurable via Companion preferences.
- Admin Diagnostics view to list technical apps needs implementation — currently invisible to the UI.

**Files to modify:**

- `apps/tablet-agent/.../ApprovedApps.kt` — Intent-based launch, configurable allowlist
- `apps/tablet-agent/.../CompanionService.kt` — add `GET /api/v1/companion/apps/technical` for admin diagnostics
- `apps/controller-api/src/routes.ts` — add `/api/v1/device/apps/technical` proxy route
- Frontend: AdminPanel or new DiagnosticsPanel

## Phase 4 — Display System

**Already implemented:**

- `KioskActivity.kt` — WebView-based kiosk with message, live-text, webpage, black, restore
- `KioskController.kt` — SharedPreferences display-mode state management
- Companion kiosk endpoints: `POST /kiosk/message`, `/kiosk/live-text`, `/kiosk/clear-live-text`, `/kiosk/black`, `/kiosk/restore`, `/kiosk/webpage`, `/kiosk/dashboard`
- Controller `fullyKiosk` adapter (`ReadWriteCompanionKioskAdapter`) connects Companion kiosk endpoints
- Controller routes: `POST /api/v1/display/message`, `/display/live-text`, `/display/live-text/clear`, `/display/black`, `/display/restore`, `/display/webpage`
- Frontend DisplayPanel wired to all supported display actions

**Not implemented:**

- `showMedia()` throws 501 UNSUPPORTED — no controller-served media upload/serve pipeline
- No temporary-media expiry for uploaded content
- No content-confirmation callback (controller does not poll to confirm message rendered)
- `image` and `video` display not supported through kiosk

**Files to modify (for media support):**

- `apps/controller-api/src/adapters/readwrite-companion-kiosk.ts` — implement `showMedia()`
- Companion: new endpoints for media upload/serve
- Frontend DisplayPanel: enable media upload controls

## Phase 5 — Orientation

**Already implemented:**

- Companion `POST /api/v1/companion/orientation` calls `RootCommand.setScreenOrientation()` using `settings put system accelerometer_rotation/user_rotation`
- Controller `POST /api/v1/device/orientation` proxies to Companion
- Frontend DevicePanel has orientation selector
- TelemetryProvider reports current orientation

**Remaining issues:**

- No physical orientation-change verification was performed during this audit (see report).
- Orientation is applied via system settings, not a per-app window policy. Verify it persists correctly in the kiosk Activity.

**Files to modify:**

- `apps/tablet-agent/.../KioskActivity.kt` — apply orientation from saved policy when activity resumes
- `apps/tablet-agent/.../KioskController.kt` — store orientation preference

## Phase 6 — Touch Lock

**Already implemented:**

- Companion `POST /api/v1/companion/touch_lock` calls `KioskController.setTouchLock()`
- `KioskActivity.kt` — transparent overlay `touchLockView` blocks touch events
- Controller `POST /api/v1/device/touch_lock` proxy route
- Frontend AdminPanel has touch lock toggle

**Missing safety safeguards (DO NOT ENABLE until implemented):**

- Automatic timeout after configurable period
- Local administrator unlock (PIN-based, similar to kiosk admin exit)
- ADB emergency recovery command
- Fail-unlocked if kiosk activity dies
- Disabled after reboot by default
- Physical unlock tested before lock
- First physical lock test limited to 30 seconds

**Files to modify:**

- `apps/tablet-agent/.../KioskActivity.kt` — add timeout, fail-unlocked, reboot reset
- `apps/tablet-agent/.../KioskController.kt` — add timeout configuration, ADB recovery command
- `apps/tablet-agent/.../CompanionService.kt` — validate touch lock safety before enabling

## Phase 7 — Music and MediaSession

**Already implemented:**

- Companion `POST /api/v1/companion/media` — `input keyevent KEYCODE_MEDIA_PLAY_PAUSE/NEXT/PREVIOUS`
- Controller `POST /api/v1/device/media` proxy
- Frontend MusicPanel with play/pause/next/previous buttons
- Spotify is in the approved apps list and can be launched

**Missing (requires new Android code):**

- No `MediaSession` integration — current implementation uses key events, not MediaController API
- No track/artist/album metadata
- No playback state reporting
- No seek, duration, or position
- No media volume control through MediaSession (volume uses `AudioManager.setStreamVolume`)
- No Spotify OAuth (Phase 1 deliberately avoids this)

**Files to create/modify (Android):**

- `apps/tablet-agent/.../MediaSessionProvider.kt` — proposed new file: wraps `MediaController` for active session metadata
- `apps/tablet-agent/.../CompanionService.kt` — add endpoints: `GET /media/status`, `POST /media/seek`, `POST /media/volume`

**Controller routes to add:**

- `GET /api/v1/device/media/status`
- `POST /api/v1/device/media/seek`
- `POST /api/v1/device/media/volume`

**Frontend:**

- Update MusicPanel with track info, playback bar, seek, volume

## Phase 8 — Talkback Audio Repair and Both Modes

**Already implemented:**

- Companion `POST /audio/start` creates `AudioTrack` at 16 kHz, mono, PCM 16-bit
- Companion `POST /audio/frame` writes binary PCM body to AudioTrack
- Companion `POST /audio/stop` releases AudioTrack
- Controller WebSocket gate at `/api/v1/talk` with origin validation
- Browser `startTalk()`: opens mic, creates AudioContext, ScriptProcessorNode converts Float32→Int16, sends via WebSocket
- Hold-to-talk in TalkPanel

**Issues to address:**

1. **ScriptProcessorNode** is deprecated. Replace with **AudioWorklet** for lower-latency, non-deprecated audio capture.
2. **Sample rate**: `new AudioContext({ sampleRate: 16000 })` may not be supported by all browsers. Should detect actual device sample rate and resample in the AudioWorklet.
3. **No defined binary frame header**: Audio frames are sent as raw Int16 buffers via WebSocket. No session ID, sequence number, or timestamp.
4. **No jitter buffer** on Companion side — frames written directly to AudioTrack as they arrive.
5. **No duplicate rejection**.
6. **No tap-to-talk mode** — only hold-to-talk is implemented.
7. **No tablet-listening half-duplex** — the `/api/v1/camera/audio` endpoint provides IP Webcam microphone, but there is no automatic muting of talkback when listening is active.

**Wire format (revised):**

JSON session-start: `{"type":"talk-start","sessionId":"<uuid>","sampleRate":<actual>,"channels":1}`
Binary PCM frames: 4-byte session ID prefix + 4-byte sequence number (big-endian) + 2-byte timestamp delta (ms, big-endian) + PCM payload
JSON session-stop: `{"type":"talk-stop","sessionId":"<uuid>"}`

**Companion side:**

- Bounded jitter buffer (e.g. 3 frames)
- Duplicate sequence-number rejection
- Clean `AudioTrack` lifecycle with flush on stop

**Browser side:**

- AudioWorkletProcessor for Float32→Int16 conversion and sample-rate conversion
- Detect actual `AudioContext.sampleRate` and resample to 16 kHz in worklet
- Tap-to-talk: toggle button starts/stops session; hold-to-talk: press-and-hold

**Files to modify:**

- `apps/controller-web/src/App.tsx` — AudioWorklet replacement, both modes
- `apps/controller-web/src/components.tsx` — TalkPanel: add tap-to-talk toggle
- `apps/controller-web/` — new `talk-worklet.ts` AudioWorklet file
- `apps/tablet-agent/.../CompanionService.kt` — jitter buffer, duplicate rejection, binary frame parsing
- `apps/controller-api/src/talk.ts` — session ID tracking, sample rate in lease

## Phase 9 — Smooth Volume and Brightness

**Already implemented:**

- Companion `POST /brightness` — `settings put system screen_brightness <0-255>`
- Companion `POST /volume` — `AudioManager.setStreamVolume(STREAM_MUSIC, <0-15>, FLAG_SHOW_UI)`
- Companion `POST /mute` — toggle to 0 or previous volume
- Controller routes proxy to Companion
- Frontend sliders for brightness and volume, mute toggle

**Issues:**

- Volume uses `FLAG_SHOW_UI` which shows Android volume popup. Disable for smoother experience.
- Brightness uses system setting directly (requires root). Could use `Activity.setBrightness()` in kiosk activity for non-root path.
- No volume/brightness ramp (smooth transition).

**Files to modify:**

- `apps/tablet-agent/.../TelemetryProvider.kt` — remove `FLAG_SHOW_UI` from `setMusicVolume`
- `apps/tablet-agent/.../KioskActivity.kt` — optional `setBrightness()` on the activity window
- `apps/tablet-agent/.../CompanionService.kt` — optional ramp endpoints

## Phase 10 — Capability-Driven Frontend

**Already implemented (post-repair):**

- Controller returns `GET /api/v1/capabilities` with per-feature booleans
- Frontend checks capabilities before enabling controls
- Display, device, talk sections are conditionally rendered

**Remaining:**

- Capability polling: frontend currently fetches capabilities once on login. Add periodic refresh or WebSocket push for capability changes.
- Error states: when Companion goes offline, capabilities should reflect that.
- Individual feature error boundaries: a failure in Talk should not disable Display.

**Files to modify:**

- `apps/controller-web/src/App.tsx` — periodic capability refresh, error isolation
- `apps/controller-web/src/components.tsx` — per-feature error display

## Phase 11 — Boot and Recovery

**Already implemented:**

- `BootReceiver.kt` enabled (was disabled, now enabled) — starts CompanionService on BOOT_COMPLETED
- Companion foreground service uses `START_STICKY`
- Windows watchdog (`scripts/watchdog.ps1`) monitors controller health and restarts if needed
- ADB reconnect helper (`scripts/adb-reconnect.ps1`)

**Issues:**

- Watchdog currently restarts controller on ANY health check failure, including optional feature unavailability. Must only restart on critical failures (process dead, listener down, version/health endpoints failing).
- Watchdog currently checks health but does not verify the static web index is served.
- No Companion watchdog on Android side — Companion does not self-monitor or restart if HTTP server fails.
- No recovery actions if Companion crashes (Android may not restart a foreground service that crashes vs being stopped).

**Files to modify:**

- `scripts/watchdog.ps1` — more granular health checking, feature-independent error states
- `apps/tablet-agent/.../CompanionService.kt` — add internal health monitoring and self-restart for HTTP server
- `apps/tablet-agent/.../BootReceiver.kt` — add delay for Wi-Fi readiness

## Phase 12 — Automated Tests

**Current state:** 56 tests pass (29 API, 27 web).

**Test gaps to fill per component:**

| Component               | Existing tests                     | Gaps                                             |
| ----------------------- | ---------------------------------- | ------------------------------------------------ |
| Auth                    | Session, login, logout, CSRF       | No rate-limit test, no session expiry test       |
| Companion adapter       | Status, brightness, volume         | No mute, orientation, touch-lock, talk tests     |
| Companion kiosk adapter | Message, live-text, black, restore | No webpage, dashboard URL tests                  |
| Talk coordinator        | Start/stop, conflict               | No timeout, session cleanup tests                |
| Web: App                | Tab persistence, login flow        | No capability-gating tests                       |
| Web: Talk               | Audio stream hook                  | No WebSocket mock, no talk lifecycle test        |
| Web: Streams            | Video/audio hooks                  | No retry-exhaustion test                         |
| ApprovedApps            | None                               | No unit test for PackageManager interaction      |
| CompanionService        | None                               | No HTTP handler test (no Android test framework) |

**Files to create/modify:**

- `apps/controller-api/src/app.test.ts` — additional auth, capability, and adapter tests
- `apps/controller-web/src/App.test.tsx` — capability-gating, error-boundary tests
- `apps/controller-web/src/hooks/__tests__/useAudioStream.test.tsx` — WebSocket talk flow

## Phase 13 — Physical Acceptance

Test every feature on the physical tablet with a phone browser over Tailscale.

**Acceptance matrix (from Phase 10):**

| Feature             | Status                                   |
| ------------------- | ---------------------------------------- |
| Camera stream       | Physically verified                      |
| Camera switch       | Physically verified                      |
| Camera controls     | Physically verified                      |
| Snapshot            | Physically verified                      |
| Apps inventory      | Physically verified                      |
| App launch          | Physically verified                      |
| Return Home         | Physically verified                      |
| Display message     | Physically verified                      |
| Live text           | Physically verified                      |
| Display webpage     | Physically verified                      |
| Black screen        | Physically verified                      |
| Restore dashboard   | Physically verified                      |
| Brightness          | Physically verified                      |
| Volume              | Physically verified                      |
| Mute                | Physically verified                      |
| Orientation         | Not physically tested                    |
| Touch lock          | Not physically tested (safety not ready) |
| Push-to-talk        | Not physically tested                    |
| Media controls      | Physically verified                      |
| Spotify launch      | Not physically tested                    |
| Image/video display | Not implemented                          |
| MediaSession status | Not implemented                          |

**Phase 13 action items:**

1. Physical orientation test across all 5 modes
2. Physical push-to-talk test with actual speech
3. Physical Spotify launch test
4. Re-test with phone PWA over Tailscale HTTPS
5. 30-second touch lock physical test (only after safety safeguards are implemented)

## Phase 14 — Documentation and Release

- Update `README.md` with final architecture diagram
- Document `.env.local` required variables and example values
- Document Companion APK build and deployment process
- Record known limitations in `docs/KNOWN_ISSUES.md`
- Create release checklist
- Tag release `v2.0.0`
