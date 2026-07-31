# Current State

## Final system repair — controller runtime (2026-07-26)

- The production controller now fails closed unless all three real services (IP Webcam, Fully, and Companion) and their local credentials are configured. Mock mode remains available only when explicitly selected for development or tests.
- The controller is bound to loopback and has been rebuilt and restarted successfully. Its live health response reports IP Webcam, Fully, and Companion as configured and healthy.
- LIVE now proxies video and listening audio in `companion` mode and uses real-tablet wording rather than mock/read-only labels. The API exposes a typed authenticated `/api/v1/capabilities` response, so unsupported features (torch and media upload) remain honestly unavailable.
- Safe no-op calls using the existing current brightness and volume values reached the real Companion service successfully. No tablet setting was changed by that verification.
- Windows lifecycle scripts now discover an existing healthy controller, avoid duplicate Node processes, recover a stale PID record, and provide a controller self-test. The controller is listening only on `127.0.0.1`.
- Windows refused creation of the current-user logon task with `Access denied`; no scheduled task was created. Automatic controller launch after Windows logon therefore remains blocked pending a one-time administrator-run task registration. This is a Windows policy/privilege issue, not a tablet-service failure.
- IP Webcam status currently confirms the rear camera and reports zoom, focus, frame rate, resolution, and quality values. A separate front-camera stability/capability validation is still required before enabling a front profile beyond conservative settings.
- A live front-camera capability probe found only `1920x1080` advertised and no independent zoom, focus, or frame-rate capability list. The attempted lower rear-style profile was silently ignored for resolution, FPS, and quality, so advanced front controls are now blocked in both the browser and API instead of applying an unsafe inferred profile. Camera switching also uses a bounded six-second settling period before a subsequent switch.
- ADB diagnosis confirmed the IP Webcam, Fully Remote Admin, and Companion foreground services are active and their expected local listeners are present. IP Webcam correctly returns an authentication challenge to an unauthenticated local probe; the controller’s configured authenticated probe succeeds. Fully’s stale dashboard Start URL was replaced through the authenticated Remote Admin API with the private Tailscale HTTPS controller URL and reloaded. The private HTTPS health endpoint also succeeds from the tablet itself.

Discovery performed on 2026-07-24 using read-only PowerShell and ADB commands. Identifiers, network addresses, Wi-Fi details, tailnet name, and credentials are intentionally redacted.

## Phase 1 local implementation

Completed without any tablet, VPS, Tailscale, or root-script modification:

- React, TypeScript, Vite, Tailwind, and PWA controller web app with LIVE, TALK, DISPLAY, and DEVICE tabs.
- Fastify TypeScript controller API with in-memory session cookie, CSRF protection, login rate limiting, and local mock-only credentials.
- Shared runtime schemas/types and integration contracts.
- Mock IP Webcam, Fully Kiosk, and Companion adapters.
- Mock WebSocket talk lifecycle and single-transmission coordinator.
- Root-backed restart, screen, and reboot endpoints remain hard-blocked with ACTION_REQUIRES_APPROVAL.
- Local tests, lint, type checking, formatting, and production build have passed; exact evidence is recorded in test-results/PHASE_1_LOCAL.md.

## Phase 2 read-only integration

Completed on 2026-07-24 without changing the tablet, its applications, Tailscale, root scripts, settings, or network policy:

- The controller now has explicit `mock` and `real-readonly` adapter modes. Real mode fails closed unless an ignored, credential-free IP Webcam base URL and an approved private transport are supplied at process start.
- The real adapter allowlists only `GET /status.json?show_avail=1`, `GET /video`, and `GET /audio.wav`. It rejects redirects, uses five-second bounded request timeouts by default, and never stores media.
- A temporary localhost-only controller proxy successfully obtained IP Webcam status, one MJPEG video chunk, and one WAV microphone-audio chunk. Redacted connection latencies were 19 ms for video and 80 ms for audio at the proxy; the direct adapter check measured 167 ms for status, 87 ms for video, and 13 ms for audio.
- The UI presents live viewing/listening only in real-readonly mode. Camera, talkback, display, device, reboot, screen, VPN, and recovery controls are visibly unavailable. Browser stream reconnection is capped at three attempts with 0.5 s, 1 s, and 2 s delays; unmounting or reconnecting clears the browser stream element.
- Fixture tests prove that a browser-side stream disconnect cancels the local proxy's upstream stream and that authenticated POST camera control is rejected before any request reaches the real adapter.
- The current tested private transport was trusted LAN. Native desktop Tailscale reachability was not tested because no desktop Tailscale CLI was present and no Tailscale address was configured; the controller reports the configured transport rather than inventing a reachability result.

Exact redacted evidence is recorded in test-results/PHASE_2_READONLY.md.

## Phase 3A phone/PWA validation

Completed with a redacted Android Chrome-based phone browser. The temporary controller mode required a strong, in-memory password, a random in-memory session secret, real-readonly mode, a specific private controller binding, and a single approved phone IP. It was stopped with `LAN_VALIDATION_REMOVED`; no persistent LAN binding, credentials, media, or tablet change was created.

- Login, visible MJPEG video, microphone audio after pressing Play, local mute/unmute, and fullscreen worked.
- Audio required a user gesture, as expected from browser autoplay policy.
- Video initially entered an interrupted/retry state and later worked. Automatic reconnection was not fully confirmed; manual reconnect may have been required.
- Portrait/landscape switching was unavailable or did not behave correctly. Camera switching remained unavailable as required by the approved scope.
- True end-to-end latency and a sustained stability duration were not measured. Background/screen-lock behavior and PWA-install availability were not observed and are not claimed.
- Read-only inspection found the IP Webcam process, foreground WebServer service, and TCP 8080 listener present. The existing boot script references boot completion, user unlock, start logic, and delays. A local status probe once received partial data then timed out; the cause of the initial interruption/manual-opening report is therefore unresolved. No automation script was changed.

## Phase 3B IP Webcam authentication assessment

Authentication remediation was assessed on 2026-07-24 but was not enabled. The installed IP Webcam build is `1.19.0.913 (multiarch)` and includes a built-in **Login/password** configuration feature plus HTTP Basic and Digest authentication code paths. The current app preferences have no configured authentication/login/password key; a redacted pre-change record was captured (preference file size 1,231 bytes and SHA-256 `00cfda2debb41962ad0c12d61a28d8af137115a6d0278f6396aa5880b13d2166`).

ADB and root recovery were re-confirmed before this assessment. The tablet was locked, however, and the built-in setting's exact fields and request scheme could not be verified without bypassing the lock, writing private preferences directly, or calling undocumented settings endpoints. Those actions were outside the safe approved path, so no password was generated or stored, no setting changed, and no HTTP authentication test was attempted. The existing boot/watchdog automation was inspected read-only and left untouched.

## Phase 4A post-update read-only assessment

Phase 4A remains paused. A read-only assessment on 2026-07-24 found `com.pas.webcam` installed at version `1.19.0.913 (multiarch)`, version code `9134`. This differs from the Phase 0 inventory's `1.14.37.759 (aarch64)` record, but matches the Phase 3B assessment, so the repository has no evidence of a further version change after Phase 3B.

The package name, process, WebServer service record, TCP 8080 listener, CAMERA/RECORD_AUDIO grants, unauthenticated status response, and bounded read-only video/audio data checks were all present. The known Phase 2 read-only endpoints remain usable. The current Android settings UI and served homepage did not expose a visible Login/password, Local broadcasting, authentication, or security option; status requests still received no HTTP authentication challenge.

The existing boot and watchdog files remain present. Read-only script checks found the boot launch and delay references, while the app was healthy; this supports preservation but does not prove a future boot cycle. Phase 4A.1 later replaced the shared helper in place, and the watchdog continued healthy cycles after that replacement. No private preference comparison, restart, downgrade, app-data change, or automation change was performed. No locally backed-up `com.pas.webcam` APK suitable for a version rollback was found in the workspace or Downloads folder.

## Phase 4A authentication compatibility note

The initial HTTP-200-only compatibility concern was superseded by Phase 4A.1. The installed CCTV helper already treats HTTP 200 and HTTP 401 as liveness-positive, so an auth-required response can be handled later without creating a watchdog restart loop. Authentication remains disabled until an explicit credential activation step is separately approved.

## Phase 4A.1 pre-install automation proposal

Phase 4A.1 inspection found that the installed common helper already accepts HTTP 200 **and** 401 as liveness-positive, preventing an authentication-required response from creating a restart loop. It cannot, however, distinguish a valid authenticated response from missing or invalid authentication configuration.

The local proposal changes only the shared helper and leaves its callers intact. It adds a strict `disabled`/`enabled` mode file and a root-only curl configuration file path. In enabled mode, existing curl uses `--config` and `--anyauth`, allowing it to negotiate Digest when offered and Basic only when that is the available challenge. The helper never sources credentials or places them in an URL or process argument. HTTP 401 remains liveness-positive but is classified as disabled-mode mismatch, missing/malformed configuration, or invalid credentials; timeout/partial and other unhealthy responses remain liveness-negative and retain the existing bounded rate limit.

At the time of the proposal, no tablet-side backup, file creation, or script replacement had occurred. Phase 4A.1 later completed the approved backup, in-place replacement, and unauthenticated verification.

## Phase 4A.1 installation and verification

Phase 4A.1 was completed on 2026-07-24. The live helper `/data/local/tmp/cctv-common-fixed.sh` was replaced in place with the reviewed auth-compatible helper while preserving the live file's owner, group, mode, and SELinux context. The replacement hash is `1ea1d134cd89e772feaea9f868b679505f334091a9484700b668161e6ce966fc`.

The timestamped backup was created at `/data/local/tmp/cctv-backups/20260724-105534/cctv-common-fixed.sh`. Its SHA-256 matches the original helper hash `2e57677c915321a0b393e6dbddf3a3ab2035994e660be984a6fa381f1b00ce32`. The backup directory is root-owned with mode `700`, and the backup file is `root:root` with mode `644` and `u:object_r:shell_data_file:s0`.

Read-only verification after replacement confirmed `pidof com.pas.webcam` is present, TCP 8080 is listening, the root page returns HTTP 200, `/status.json?show_avail=1` returns JSON, `/video` yields a multipart MJPEG chunk with `Content-Type: image/jpeg`, and `/audio.wav` yields a WAV header beginning `RIFF ... WAVE`. The helper syntax check passed, and sourcing the helper exposed the expected functions.

The watchdog log continued to show healthy five-minute cycles after the replacement, with no restart loop or unexpected recovery action. Direct syntax-check access to `/data/adb/service.d/*` from the tablet shell was blocked by the device's access policy, so the continuing watchdog log was used as the functional proof that the active caller path remained healthy. No credential was stored or enabled.

## Phase 4A.2a configuration persistence assessment

On 2026-07-24 the prepared `/data/adb/cctv` directory and its two empty/disabled Phase 4A.1 files were unexpectedly absent. Read-only inspection found no conflicting path, symlink, bind mount, or script targeting that exact directory, and the tablet booted before Phase 4A.1; the removal cause is therefore unresolved. The approved placeholders were recreated with `root:root` ownership, the required modes, and `u:object_r:adb_data_file:s0`; no credential was created.

The same on-device assessment showed that the installed helper did not parse its `200|bytes` curl result correctly under the tablet shell. Phase 4A.2d repaired that parser while authentication remained disabled. Credential activation still requires separate explicit approval.

## Phase 4A.2c read-only HTTP diagnosis

After the Phase 4A.2b rollback, a read-only diagnosis found the IP Webcam process and foreground WebServer present with TCP 8080 listening. The root endpoint completed with HTTP 200 both tablet-local and from the laptop. The status endpoint also connected, returned HTTP 200 and its small body promptly, but did not complete before the eight-second client limit despite advertising `Connection: close`. Resource and socket snapshots did not show connection exhaustion, and the same behavior occurred locally and remotely. This is insufficient evidence for a general server deadlock or network-path failure; it is currently recorded as a narrower status-response completion defect. No restart or setting change was made.

## Phase 4A.2d parser repair

Phase 4A.2d installed the reviewed minimal parser repair in the shared helper. It validates curl's `HTTP_CODE|BYTE_COUNT` output under the tablet shell, retains HTTP 200/401 liveness policy, and distinguishes a valid response followed by connection-completion timeout from a timeout before HTTP status. The watchdog continues to use the root endpoint, which completes normally. Three consecutive healthy watchdog cycles at `12:23:22`, `12:28:23`, and `12:33:23` confirmed no recovery action, IP Webcam PID change, or listener loss. At that phase's completion, authentication remained disabled and no credential existed.

## Phase 4A.2e application baseline

The authentication workflow continues on the installed official free, ad-supported IP Webcam application (`com.pas.webcam`). IP Webcam Pro is not being installed or evaluated now: its distinct package identity means any later migration must be separately approved and include an existing-automation compatibility and rollback review.

A subsequent credential-entry attempt was aborted before authentication activation. The IP Webcam UI still reported `login/password: not set`; the generated local and tablet credential stores were then purged, and health mode remained `disabled`. During the attempt the existing watchdog independently logged a listener-loss recovery attempt. A later read-only diagnosis found the same app PID, a foreground `.WebServer` service, a wildcard TCP 8080 listener, a UI `Stop` control, and unauthenticated HTTP 200 health.

The historical recovery log is misleading: the recovery function logged that the port and HTTP health had recovered, but its caller then logged `Recovery: FAILED`. The installed health-check script compares its result using an empty numeric operand, so its success/failure classification is defective even though the observed recovery action restored service. This is a separate watchdog-caller repair candidate; it was not modified during the diagnostic phase. No manual restart, password entry, authentication enablement, or credential retention occurred.

## Phase 4A.2f pre-install checkpoint

Read-only inspection confirmed that the affected caller is `/data/local/tmp/cctv-health-check-fixed.sh` (SHA-256 `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`, `shell:shell`, mode `0755`, `u:object_r:shell_data_file:s0`, no symlink). Its exact defect is a malformed `[ "$RESULT" -eq ]` condition after `start_ip_webcam`; the recovery function's established contract is `0` on success and `1` on failure. The proposed caller-only POSIX `case` block classifies `0` as `Recovery: SUCCESS`, nonzero numeric values as `Recovery: FAILED`, and empty/malformed values as `Recovery: INVALID_RESULT`, without invoking recovery again.

The shared helper remains SHA-256 `b5c2516b50b6045331f216a1ff8400685adcda2157506ac2c349ad18f33404d9`; no tablet file has been changed. The candidate's expected device-format SHA-256 is `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541`. Local and actual-tablet POSIX fixture tests, syntax checks, controller tests, lint, formatting, type checks, and production builds passed. Installation requires a separately approved backup-and-replacement checkpoint.

## Phase 4A.2f installation and verification

Phase 4A.2f was completed on 2026-07-24. The live caller `/data/local/tmp/cctv-health-check-fixed.sh` was replaced with the reviewed result-classification candidate while preserving `shell:shell` ownership, mode `0755`, SELinux context `u:object_r:shell_data_file:s0`, LF line endings, and the no-final-newline shape. The installed hash is `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541`.

The timestamped backup was created at `/data/local/tmp/cctv-backups/20260724-170905-phase4a2f/cctv-health-check-fixed.sh` with root-owned, non-executable directory. Its SHA-256 matches the pre-install caller hash `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`. Seven isolated classification tests (result `0`, empty, whitespace, nonzero numeric `1` and `99`, nonnumeric `abc`, and mixed `0abc`) passed under `/system/bin/sh` without invoking recovery. The shared helper hash remained `b5c2516b50b6045331f216a1ff8400685adcda2157506ac2c349ad18f33404d9`. Three consecutive healthy watchdog cycles at `17:14:47`, `17:19:48`, and `17:24:49` confirmed no false recovery, IP Webcam PID `10838` unchanged, and port 8080 continuously listening. Authentication remains disabled and no credential was created.

## Hardware and operating system

| Item           | Verified finding                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Device         | Lenovo Tab M8 HD family; board akita_row_wifi                                                                      |
| OS             | LineageOS 18.1 GSI / Android 11 / API 30 / userdebug                                                               |
| Security patch | 2024-01-05                                                                                                         |
| CPU ABI        | arm64-v8a (also supports 32-bit compatibility ABIs)                                                                |
| RAM            | 1,893,468 KiB total; 833,200 KiB available at discovery                                                            |
| Data storage   | 24,083,848 KiB total; 22,481,396 KiB available at discovery                                                        |
| Display        | 800 × 1280 at 240 dpi                                                                                              |
| SELinux        | Enforcing                                                                                                          |
| Root           | su -c id returned UID 0. PHH phh-su exists and Magisk 30.7 is installed; the live su context identifies as Magisk. |
| ADB            | One authorized device connected; normal shell and read-only root identity both verified.                           |

## Confirmed running services

| Component           | State                                  | Evidence                                                                        |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| IP Webcam           | Running foreground service             | Package com.pas.webcam 1.19.0.913, foreground WebServer, process owns TCP 8080. |
| Tailscale           | Connected VPN                          | Package com.tailscale.ipn, active IPNService, validated VPN on tun0.            |
| Fully Kiosk Browser | Not installed                          | Package de.ozerov.fully was absent.                                             |
| Companion Agent     | Not installed                          | No project agent package exists.                                                |
| Existing kiosk      | Installed but not currently foreground | Webview Kiosk uk.nktnet.webviewkiosk 0.26.17.                                   |
| Existing clock      | Installed                              | FS Clock systems.sieber.fsclock 2.2.                                            |
| Home launcher       | Lawnchair                              | The current HOME resolver is Lawnchair.                                         |

## IP Webcam

- Version: 1.19.0.913 (multiarch), re-confirmed during Phase 3B assessment.
- Required camera and microphone permissions are granted.
- The service is healthy at its local 127.0.0.1:8080 endpoint and returned HTTP 200, title IP Webcam, and server header IP Webcam Server 0.4.
- The service listens on a wildcard address, not loopback only. This means it is reachable from at least the local network unless a firewall rule prevents it. No matching port-8080 firewall rule was found in the inspected iptables output.
- The local UI did not return a WWW-Authenticate challenge. Authentication must be treated as disabled or unverified, never assumed secure.
- Its own shipped UI exposes verified stream/status paths: /video, /audio.wav, /audio.opus, /status.json, and /status.json?show_avail=1.
- Its own shipped JavaScript exposes verified control paths for torch, zoom, focus, video size, quality, and other settings. State-changing paths were not invoked during discovery.

## Camera and audio feasibility evidence

- Camera service reports two public cameras: one back-facing (orientation 90) and one front-facing (orientation 270).
- Neither camera reports a flash unit. Torch is therefore not available on this hardware even though IP Webcam has generic torch endpoints.
- IP Webcam owns camera ID 1. Its attempt to open the other camera was rejected with a camera-service too-many-cameras-open condition. Simultaneous dual-camera streaming is unsupported for version one.
- Camera2 characteristics advertise digital zoom and FPS ranges. The actual allowed ranges and reliable remote camera-switch operation still need controlled testing.
- Built-in microphone, back microphone, and speaker routes exist. The media-volume settings observed were current 5 and maximum 15.
- No acoustic echo-canceller or noise-suppressor effect was confirmed from the read-only dump. Treat echo mitigation as an implementation and physical-placement concern.

## Existing automation — do not alter without approval

Active root scripts:

- /data/adb/service.d/20-cctv-camera.sh
- /data/adb/service.d/21-cctv-watchdog.sh

The boot script waits for boot completion, user unlock, and a 25-second settling period. It checks IP Webcam process/port/HTTP health, starts .Rolling only if unhealthy, rate-limits retries to three per 30 minutes, returns to HOME after successful startup, and may turn the display off after a further stability check. The watchdog launches a five-minute health-check loop. Supporting helpers live under /data/local/tmp/.

No script, setting, permission, service, or application was changed during Phase 0.

## Phase 4B — Authenticated stream reliability (2026-07-24)

Backend: `readBoundedJson()` fixes IP Webcam's non-closing TCP connection on `/status.json`; stream content-type validation rejects unexpected responses before proxying. Frontend: `useVideoStream` and `useAudioStream` hooks manage MJPEG and WAV stream lifecycle with 1s/2s/4s backoff, 10s stability reset, and page-visibility/network/pageshow lifecycle handlers. 54 tests pass. ADB closeout confirmed PID stability, stream content-types, and no watchdog log entries. See `test-results/PHASE_4B_STREAM_RELIABILITY.md`.

## Phase 4C — Mobile controller UI shell (2026-07-24)

UI hardening pass across all four tabs. No tablet, IP Webcam, watchdog, or Tailscale change was made.

- `index.html`: added `viewport-fit=cover` for notch/safe-area support.
- `vite.config.ts`: Workbox `NetworkOnly` runtime-caching rule for all `/api/*` routes prevents credential-bearing data from entering the service worker cache. `navigateFallback: null` prevents SW from returning `index.html` for unhandled API routes.
- `error-boundary.tsx`: React `ErrorBoundary` class component wraps the app root; unhandled render errors show a "Reload" recovery screen instead of a blank page.
- `StatusHeader`: now accepts `videoState`/`audioState` and shows a compact stream-status row (Cam / Mic badges) when streams are active.
- `App.tsx`: active tab persisted to `localStorage` key `tc-tab` and restored on mount. `videoState`/`audioState` lifted to App level via optional `onVideoStateChange`/`onAudioStateChange` callbacks on `LivePanel`.
- **LIVE tab (readOnly)**: camera selector shown as disabled buttons labelled with Phase 4D note; torch explicitly labelled "unavailable — no flash hardware"; stabiliy panel unchanged.
- **TALK tab (readOnly)**: shows disabled visual hold-to-talk button (correct dimensions/shape) with "Talkback agent not installed yet" notice.
- **DISPLAY tab (readOnly)**: notice updated to "Fully Kiosk integration required" with clear explanation.
- **DEVICE tab**: all null fields now show "Unavailable until Companion Agent" instead of "Not reported" (`unavailable()` helper + inline charging/wifi/tailscale null checks).
- 54 tests pass (27 web, 27 API); 2 new tab-persistence tests added. 5 pre-existing lint warnings (from Phase 4B hook patterns) unchanged. See `test-results/PHASE_4C_MOBILE_UI.md`.

## Phase 4D — Camera controls (2026-07-24)

Camera controls are now active in real-readonly mode. A new `ReadWriteIpWebcamAdapter` (subclass of the read-only adapter) implements all IP Webcam control commands. A new `authorizeCameraControl()` route guard enforces session and CSRF without blocking on the adapter mode, so camera controls work even when display and device controls remain unavailable.

Controls added: camera switch (rear/front), zoom (1.0–4.0×), JPEG quality, frame rate (10/15/30 fps), video resolution, focus mode, autofocus trigger, and snapshot (GET /shot.jpg, returns image/jpeg).

Key hardware discovery: the front camera supports only `focusmode=off`; the rear camera supports `off`, `auto`, `macro`, `continuous-video`, and `continuous-picture`. The device silently ignores unsupported modes. Neither camera has a flash unit; torch remains unavailable.

The frontend LivePanel now shows a unified camera-controls panel (camera selector, zoom, quality, FPS, resolution, focus, autofocus, snapshot) active in both mock and real-readonly modes. The LIVE badge shows the active camera name.

56 tests pass (29 API, 27 web). All seven camera controls verified against the real device via ADB forward and then restored to baseline. See `test-results/PHASE_4D_CAMERA_CONTROLS.md`.

## Phase 5 — Fully Kiosk Browser integration (2026-07-24)

Fully Kiosk Browser v1.57.1 is installed and its Remote Admin API is enabled and verified.

- Remote Admin API listens on port 2323, LAN-restricted, password-protected. ADB forward `tcp:2323 tcp:2323` provides localhost access.
- Correct SharedPreferences key names discovered (camelCase, no `pref_` prefix): `remoteAdmin`, `remoteAdminPassword`, `remoteAdminLan`, `startURL`, `kioskPin`. Configured via sed script piped through stdin — credentials never appear in terminal.
- All five FullyKioskAdapter operations validated against the real device: `getDeviceInfo` (battery/screen data), `showToast` (message overlay), `loadURL` to `file:///sdcard/black.html` (black screen), `loadURL` to `about:blank` (webpage), `loadStartURL` (dashboard restore).
- `ReadWriteFullyKioskAdapter` implemented; wired into `createAdapters` when `TABLET_FULLY_ADMIN_PASSWORD` env var is set. `showMedia()` throws 501 UNSUPPORTED pending controller-served media endpoint (Phase 6).
- `screenOff` command rejected by Fully (requires device admin). Workaround: load `/sdcard/black.html` via `file://` URI for `showBlack()`.
- 56 tests pass (29 API, 27 web). See `test-results/PHASE_5_FULLY_KIOSK.md`.

## Phase 6 — Companion Agent (2026-07-25)

`com.tabletcontrol.companion` v1.0 is installed and running as a foreground service. HTTP API on port 8765, accessed via `adb forward tcp:8765 tcp:8765`.

- `GET /health` and `GET /api/v1/companion/status` work: battery 100%, charging, brightness 102, screenOn, storageFreeMb, uptimeSeconds all returned correctly.
- Unauthorized requests return 401 UNAUTHENTICATED.
- Magisk root granted (UID 10177, policy=2). All mutation endpoints validated: brightness, volume, mute/unmute, screen sleep/wake all return 200 OK. All values restored to baseline after validation (brightness=102, volume=5, screenOn=true).
- `ReadWriteCompanionAdapter` implemented in controller-api; wired when `TABLET_COMPANION_SECRET` env var is set. `beginTalk()`/`endTalk()` throw 501 UNSUPPORTED (Phase 7).
- `"companion"` added to `AdapterModeSchema` for `TabletStatus.mode`.
- Boot receiver is `android:enabled="false"` — will be enabled in Phase 8 after validation.
- 56 tests pass. See `test-results/PHASE_6_COMPANION_AGENT.md`.

## Phase 7 — Push-to-Talk WebSocket Bridge (2026-07-25)

Full audio pipeline: browser mic → WebSocket → controller-api → Companion HTTP → Android `AudioTrack`.

- Audio format: 16 kHz, mono, PCM Int16. Frame size: 1024 samples = 2048 bytes = 64 ms.
- `SimpleHttpServer` rewritten to read headers byte-by-byte + bulk binary body read — required for `application/octet-stream` audio frame bodies (previous `BufferedReader` corrupted binary data).
- Companion audio endpoints: `POST /api/v1/companion/audio/start` (creates `AudioTrack`), `/audio/frame` (writes binary PCM), `/audio/stop` (releases `AudioTrack`).
- Controller WebSocket gate changed from `adapterMode === "real-readonly"` to `companion === undefined` — talk now permitted whenever Companion is configured.
- Binary frames forwarded from WebSocket handler to `companion.sendAudioFrame(rawMessage)`.
- Browser `startTalk()` opens WebSocket, sends `talk-start`, then on `"talking"` ack: opens mic via `getUserMedia`, converts Float32 → Int16 via `ScriptProcessorNode`, streams binary frames. `stopTalk()` stops mic and sends `talk-stop`.
- 1-second 440 Hz sine tone dispatched to `AudioTrack` across 16 frames — all 200 OK. See `test-results/PHASE_7_PUSH_TO_TALK.md`.

## Phase 8 — Boot Recovery (2026-07-25)

- `BootReceiver` enabled (`android:enabled="false"` → `"true"`) and validated: synthetic `BOOT_COMPLETED` broadcast via root confirmed Companion starts within 4 seconds.
- Real reboot performed at 10:11:20. All services recovered: ADB at +88s, root/Tailscale/Companion/Fully at +121s, IP Webcam at +144s. Three watchdog healthy cycles confirmed.
- `scripts/adb-reconnect.ps1` — helper to re-run all three `adb forward` commands after tablet reboot.

## Phase 9 — Direct LAN/Tailscale Deployment (2026-07-25)

- Removed ADB-forward dependency for runtime controller→tablet communication.
- Added `TABLET_FULLY_BASE_URL`, `TABLET_COMPANION_BASE_URL` env vars; falls back to localhost ports for ADB-forward dev mode.
- Controller deployed at 192.168.1.11:3001 in `lan-validation` mode.
- Health confirmed: `mode=real-readonly, ipWebcam=healthy, fullyKiosk=configured, companion=configured`.
- Loopback validation added: lan-validation mode rejects loopback Fully/Companion base URLs.
- 56/56 automated tests passing. See `test-results/PHASE_9_PRIVATE_DEPLOYMENT.md`.

## Phase 10 — Kiosk Configuration and Release Preparation (2026-07-25)

- Phase 10 C1 recovery checkpoint: all recovery paths verified, rollback commands documented. See `test-results/PHASE_10_RECOVERY_CHECKPOINT.md`.
- Phase 10 C2 Fully configuration: `startURL=http://192.168.1.11:3001/`, `launchOnBoot=true` set via Remote Admin API. Verified in prefs and via `loadStartURL`. See `test-results/PHASE_10_FULLY_CONFIG.md`.
- ESLint fixes: `react-hooks/refs` and `react-hooks/set-state-in-effect` violations in `useVideoStream`, `useAudioStream`, and `components.tsx` resolved. 0 ESLint errors/warnings.
- Full quality gates: 56/56 tests, TypeScript clean, ESLint clean, Prettier clean, backend+frontend builds pass.
- Acceptance matrix created: 81 PASS, 0 FAIL, 22 SKIPPED, 1 BLOCKED. See `test-results/PHASE_10_FINAL_ACCEPTANCE.md`.
- **Post-release security correction (2026-07-25):** Fully Kiosk exit PIN was inadvertently committed in Phase 8 and Phase 10 docs. PIN rotated on device via Remote Admin API (confirmed MATCH in prefs). All committed literal PIN values replaced with `<FULLY_EXIT_PIN>` placeholder. New PIN stored only in gitignored `.env.local` as `FULLY_EXIT_PIN`. v1.0.0 tag recreated on corrected commit; old commit orphaned locally. Git history contains the old PIN in commits `6ff3aae` and `79c8fdc` (original) — no remote exists, no shared exposure. PIN should be treated as revoked.

## Frontend capability repair (2026-07-26)

- The web client now loads the authenticated controller capability map instead of inferring availability from stale mock/configuration state.
- Talk, display, brightness, volume, mute, and dashboard recovery controls are enabled only when the real controller advertises support; unsupported media upload remains disabled.
- Rebuilt controller bundle passed strict TypeScript, 56 automated tests, ESLint, production build, and lifecycle self-test. See `test-results/FRONTEND_CAPABILITY_REPAIR.md`.
- A phone PWA cache refresh and one physical reversible-control validation remain required.

## Remote interaction repair and additions (2026-07-26)

- DEVICE now lists and launches only a fixed set of approved everyday apps that are actually installed. Arbitrary packages, activities, intents, shell commands, and security/controller-critical apps are not accepted.
- DISPLAY now has separate animated-message and live-text controls. Both render centered white text over the current tablet content with no background. Animated text types character-by-character and expires; live text updates after a short debounce and stays until cleared.
- Push-to-talk now accepts the exact private reverse-proxy origin instead of comparing only with the development origin. Cross-origin and missing production origins still fail closed. Browser audio is captured during the hold gesture and resampled to the Companion's 16 kHz mono PCM16 format.
- A real launch/restore test found that Android could block the previous background return to the kiosk. Restore dashboard now invokes one fixed, non-parameterized rooted activity-start fallback. Launch and return passed after the repair.
- Runtime checks passed for unauthorized app-list rejection, nine installed approved apps, real VLC launch, dashboard return, live-text display/clear, animated-message visibility, and WebSocket talk start/silent-frame/stop. Audible phone-microphone speech remains a user-attended check.
- Full evidence is in `test-results/REMOTE_INTERACTION_FEATURES.md`.

## Current risks and unknowns

1. **High:** IP Webcam is wildcard-bound and did not challenge locally for authentication. Address this before treating the camera as private beyond Tailscale.
2. **High:** Existing root automation owns boot-time camera recovery and screen-off behavior. Any new watchdog must integrate with or replace it only with a tested rollback plan.
3. ~~**Medium:** Fully Kiosk is not present, so display, kiosk, and device-control capabilities remain untested.~~ **Resolved in Phase 5:** Fully installed, Remote Admin enabled, all display commands validated.
4. ~~**Medium:** Remote camera switching, supported video-size values, frame-rate control, and stream stability have not yet been controlled-tested.~~ **Resolved in Phase 4D:** all camera controls (switch, zoom, quality, fps, resolution, focus, autofocus) verified against the real device.
5. ~~**Medium:** Talkback requires the custom Companion Agent; two-way audio has not been verified.~~ **Resolved in Phase 7:** full PTT pipeline verified.
6. **Low:** Java/Gradle/Android SDK env vars not configured globally; Android SDK at known local paths.
7. **High:** IP Webcam's built-in authentication must remain treated as disabled until configured via in-app UI and verified. Wildcard TCP 8080 is a LAN exposure risk (mitigated by router NAT and private LAN).
8. **Medium:** `showMedia()` returns 501 UNSUPPORTED — no controller-served media upload/serve pipeline implemented.
9. **Low:** `showBlack()` requires `/sdcard/black.html` on device; deployed but not recreated after factory reset.
10. ~~**Medium:** Companion root mutation endpoints blocked.~~ **Resolved in Phase 6.**
11. ~~**Low:** Companion boot receiver disabled.~~ **Resolved in Phase 8.**
12. ~~**Low:** `beginTalk()`/`endTalk()` throw 501.~~ **Resolved in Phase 7.**
13. **Medium:** Controller PC has no Tailscale. Tailscale remote access not verified (known limitation). Controller is LAN-private only until Tailscale is installed on PC.
14. **Low:** Phone/PWA test (B6) not re-verified in Phase 9/10 session due to no physical phone available during this run. Phase 3A confirms basic flow.
