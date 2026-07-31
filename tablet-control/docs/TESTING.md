# Testing

## Test evidence rules

Store reviewed, redacted results under test-results/. Do not store passwords, tokens, serial numbers, Wi-Fi identifiers, tailnet names, private addresses, raw audio, or private uploads.

Current result: Phase 0 read-only discovery passed. Phase 1 local verification passed: 8 automated tests, ESLint, strict TypeScript checks, Prettier check, and production builds. No real device-control, media-stream, or deployment test has been executed.

## Unit tests

- Input schemas and numerical range validation.
- Shared API response/error mapping.
- IP Webcam adapter timeout, JSON parsing, unexpected HTML, and unsupported response handling.
- Fully adapter request construction and secret redaction.
- Companion token validation and fixed root-action mapping.
- Session expiry, CSRF, login rate limiting, and logout.
- File MIME/size/name validation.
- PTT state machine, duration limit, disconnect/cancel paths, and restore delay.
- Watchdog attempt limits, exponential backoff, cooldown, and no-auto-reboot rule.

## Integration tests

- API against mock IP Webcam, mock Fully, and mock Companion services.
- Authentication to each state-changing API.
- Stream proxy headers and reconnect handling.
- WebSocket PTT lifecycle without retaining audio.
- Upload/display expiry and dashboard restoration.
- Adapter timeout and malformed-response behavior.
- Service recovery failure mapping.

## Manual device tests

Run only after the required action has been approved.

| Test                                              | Expected evidence                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| IP Webcam health                                  | Status response, process, and listener agree.                                |
| 30-minute video                                   | One active camera stream remains usable without runaway memory/heat.         |
| Extended video                                    | Several-hour run with periodic status collection and no hidden restart loop. |
| Listening audio                                   | Browser playback works after reconnect.                                      |
| Front/rear switch                                 | Verified one-at-a-time behavior and recovery if a restart is required.       |
| Torch                                             | Explicit unsupported result on present hardware.                             |
| Zoom/focus/quality/video size                     | Only accepted discovered values change behavior.                             |
| PTT press/release/cancel                          | Speaker audio starts/stops reliably; incoming listening restores.            |
| Echo                                              | Safe volume and restore delay avoid unacceptable feedback.                   |
| Display message/image/video/webpage/black/restore | Correct content, expiry, and dashboard return.                               |
| Volume/brightness/screen                          | Device state maps correctly; current boot script interactions remain safe.   |
| Application restart/reboot                        | Only after Phase 7 approval, with manual recovery path.                      |
| Wi-Fi/Tailscale loss                              | Clear degraded state and recovery without reboot loop.                       |
| Thermal/low-memory                                | Conservative stream setting remains stable.                                  |
| Tablet reboot                                     | Existing boot automation and later Companion behavior recover as documented. |

## Security tests

- Missing/incorrect/expired controller session.
- Missing/incorrect/replayed Companion token.
- Missing CSRF token and cross-origin request.
- Invalid numeric values and unsupported option values.
- Oversized/mislabelled uploads and traversal filenames.
- Generic shell-command attempt.
- Unauthenticated reboot/restart attempt.
- WebSocket without authentication or after session expiry.
- Secret/URL/audio leakage scan in server logs and test artifacts.
- LAN exposure test for IP Webcam after authentication/network remediation.

## Phase 2 evidence

- `readonly-integration.test.ts` verifies startup fail-closed configuration, GET-only status access, malformed-response mapping, stream cancellation, the localhost proxy cancellation path, and that a CSRF-authenticated camera POST is blocked before any upstream request.
- The real adapter maps timeout, authentication rejection, malformed status, stream failure, and offline/unreachable conditions to typed API errors without returning mock data.
- The live direct check reads only one status response and one non-persisted first chunk from each approved stream. The localhost proxy check repeats status/video/audio through Fastify, then cancels each connection.
- PWA unit tests validate mock login/tab behavior. The automated browser verifier was unavailable on this workstation, so visual browser media playback was not claimed as directly observed. The real controller proxy and browser-facing HTML elements were nevertheless exercised by local integration code.
- Native Tailscale reachability was not claimed: the current read-only result is trusted-LAN reachability; Tailscale needs a separately configured private endpoint and a read-only probe in a later approved check.

## Phase 3A evidence

- Phone validation confirmed login, visible video, microphone playback after a Play gesture, mute/unmute, and fullscreen.
- The first video session showed an interrupted/retry state. Eventual playback succeeded, but automatic reconnection, continuous stability duration, and true playback latency remain unverified. Manual reconnect may be needed.
- Orientation switching was unavailable or incorrect. Background/screen-lock behavior and installability were not observed, so no pass result is recorded.
- A read-only ADB inspection confirmed IP Webcam's process, foreground service, and TCP listener. The boot script contains boot-completion, user-unlock, start, and delay logic. A local status request received partial data before timing out once; no causal conclusion or state-changing recovery action was made.

## Remote interaction feature evidence (2026-07-26)

- 37 controller API tests and 29 controller web tests passed.
- Strict TypeScript, ESLint, formatting, production PWA build, Android assemble, Android unit-test task, and Android lint passed.
- Real-tablet checks covered unauthenticated app-list rejection, approved app discovery, launch, dashboard restoration, animated text, live-text update/clear, and Companion health after an in-place APK update.
- The authenticated controller WebSocket completed talk start, one silent PCM frame, and talk stop. Same-origin and rejection behavior are unit-tested.
- A user-attended phone check is still required to confirm audible speech from the physical phone microphone; no such result is inferred from the silent frame test.
- See `test-results/REMOTE_INTERACTION_FEATURES.md`.

## Phase 3B authentication assessment evidence

- ADB connectivity and root recovery were re-confirmed. A redacted baseline record captured the IP Webcam preference-file size and SHA-256 only; no preference values or credentials were exported.
- APK and installed-state inspection found the built-in Login/password feature and Basic/Digest authentication implementation evidence in IP Webcam 1.19.0.913.
- The current preferences did not contain an authentication/login/password key. The tablet was locked before the exact in-app setting, fields, and challenge scheme could be verified. No lock bypass, preference edit, undocumented setting request, credential creation, or authentication request was made.
- No unauthenticated-rejection/authenticated-success verification can be claimed. Existing boot/watchdog scripts remained unmodified.

## Phase 4A post-update assessment evidence

- Read-only package inspection recorded `com.pas.webcam` version `1.19.0.913 (multiarch)`, version code `9134`. It differs from the Phase 0 inventory version but matches the Phase 3B record.
- Process, WebServer service record, TCP 8080 listener, CAMERA and RECORD_AUDIO grants, unauthenticated status, and bounded first-data checks for video and WAV audio all succeeded.
- The normal Android settings UI and served homepage did not present a visible authentication option. The unauthenticated status response did not provide a `WWW-Authenticate` challenge.
- Boot/watchdog files, boot launch reference, and boot delay reference remained present. No startup reboot-cycle claim was made, and no script was changed.
- No safe local IP Webcam rollback APK was found in the workspace or Downloads folder. No rollback action was attempted.

## Phase 4A authentication compatibility evidence

- The supported Cheats interface was approved for authentication configuration, but no value was entered.
- `20-cctv-camera.sh` and the launched watchdog daemon load the shared CCTV helper. At the initial assessment the helper was treated as HTTP-200-only, but Phase 4A.1 later confirmed the installed helper already treats HTTP 200 and HTTP 401 as liveness-positive in addition to process and TCP-listener checks.
- That initial compatibility concern is why Phase 4A stopped before credential entry or server restart. Phase 4A.1 later kept authentication disabled while adding the auth-compatible helper path.
- ADB/root recovery and the unauthenticated process/service/listener/status/video/audio baseline remained healthy. No credential, media, configuration, or automation change occurred.

## Phase 4A.1 pre-install automation tests

- Local model tests reproduce the installed helper's HTTP 200/401 liveness behavior and cover unauthenticated success, authentication-required response, valid/invalid credential states, missing/malformed configuration, timeout/partial response, listener/liveness failure, retry cooldown, and rejected shell-metacharacter credential input.
- The proposed helper uses the tablet's existing curl client, which reports support for `--config`, `--anyauth`, and `--digest`. No additional binary is needed.
- Tablet-side installation and unauthenticated compatibility verification were later completed under the explicit Phase 4A.1 approval checkpoint.

## Phase 4A.1 installation and verification evidence

- Backup path: `/data/local/tmp/cctv-backups/20260724-105534/cctv-common-fixed.sh`.
- Backup SHA-256: `2e57677c915321a0b393e6dbddf3a3ab2035994e660be984a6fa381f1b00ce32`, matching the original helper hash before replacement.
- Live helper SHA-256 after replacement: `1ea1d134cd89e772feaea9f868b679505f334091a9484700b668161e6ce966fc`.
- Live helper metadata after replacement: owner `shell`, group `shell`, mode `755`, SELinux `u:object_r:shell_data_file:s0`.
- Backup directory metadata: owner `root`, group `root`, mode `700`, SELinux `u:object_r:shell_data_file:s0`.
- `sh -n /data/local/tmp/cctv-common-fixed.sh` passed, and sourcing the helper exposed the expected functions with `type`.
- `GET /` returned HTTP 200, `/status.json?show_avail=1` returned JSON, `/video` returned a multipart MJPEG chunk, and `/audio.wav` returned a WAV header.
- `pidof com.pas.webcam` and the TCP 8080 listener remained present, and the watchdog log showed healthy five-minute cycles with no restart loop.
- Local quality gates passed: `npx vitest run automation/phase4a1/health-model.test.ts`, `npm run test`, `npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm run build`.

## Phase 4A.2a configuration recreation assessment

- The approved Phase 4A.1 configuration directory and its two placeholder files were unexpectedly absent. Read-only inspection found `/data/adb/` persistent, sufficient free storage, no conflicting path, symlink, or mount at `/data/adb/cctv`, and no active script that references or deletes that exact path. The recorded tablet boot preceded Phase 4A.1, so a later reboot did not explain the absence. The cause remains undetermined.
- The directory was recreated only after those checks: `/data/adb/cctv` is `root:root` mode `0700`, and both files are `root:root` mode `0600` with SELinux context `u:object_r:adb_data_file:s0`. The disabled-mode file is nine bytes; the curl configuration file is empty. No credential was created or stored.
- The helper safely read the disabled-mode file. The IP Webcam process, TCP 8080 listener, and unauthenticated status endpoint remained available.
- A direct on-device invocation exposed a shell-compatibility defect in the installed helper's `200|bytes` response parsing: the HTTP code was empty even though curl returned HTTP 200. Its aggregate HTTP health check therefore returned false. Existing watchdog-log entries showed earlier healthy cycles, but a new normal watchdog cycle cannot be claimed. Authentication activation remains blocked pending separately approved remediation of that helper defect.

## Phase 4A.2c read-only HTTP diagnostic evidence

- The tablet-local and laptop-direct root probes both completed with HTTP 200. The corresponding status probes both connected, returned HTTP 200 and 289 bytes, then timed out waiting for the server to complete the response.
- The status response advertises `Connection: close` but did not close within the bounded client timeout. There was no evidence of connection exhaustion, process CPU/memory growth, relevant recent exception logs, or a remote-network-only failure.
- The localhost process expected to provide the controller camera-status route returned HTTP 404, so a live controller-proxy comparison was unavailable. No stream endpoint was requested during this diagnostic phase.
- See `test-results/PHASE_4A2C_HTTP_DIAGNOSTIC.md` for the redacted evidence and the conclusion that a restart is not justified by this evidence alone.

## Phase 4A.2d parser repair and watchdog evidence

- The parser regression model now covers 24 cases, including the Android-shell literal-delimiter regression and the distinction between a timeout before HTTP response and a valid response that times out during connection completion.
- The installed helper correctly classified the live root HTTP 200 response as healthy. It preserved the disabled authentication configuration and the unchanged startup/watchdog callers.
- Three post-install watchdog cycles (`12:23:22`, `12:28:23`, and `12:33:23`) completed healthy without recovery, IP Webcam PID change, or listener loss.

## Phase 4A.2f recovery-result repair: pre-install and installation evidence

- An isolated POSIX fixture reproduced the historical malformed test: a successful recovery return of `0` was routed to `Recovery: FAILED` by `[ "$RESULT" -eq ]`.
- The proposed replacement classifies explicit success, explicit failure, empty/unset, whitespace-only, newline, carriage-return, and nonnumeric values; it also covers mixed function output, command substitution, and proves a malformed result does not invoke recovery a second time.
- The fixture passed under local POSIX `sh` and the tablet's `/system/bin/sh` without touching tablet files, services, settings, or credentials. The caller candidate passed `sh -n` under both shells.
- Full local controller regression tests (14 API + 2 web), lint, Prettier check, strict TypeScript checks, and production builds passed before and after the install checkpoint.
- The approved backup-and-replacement installation completed on 2026-07-24. The installed caller SHA-256 is `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541`; the backup is at `/data/local/tmp/cctv-backups/20260724-170905-phase4a2f/cctv-health-check-fixed.sh` with pre-install hash `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`. Seven isolated classification tests passed on-device under `/system/bin/sh` with zero real recovery invocations.
- Three post-install watchdog cycles (`17:14:47`, `17:19:48`, and `17:24:49`) completed healthy with no false recovery, no IP Webcam PID change (PID `10838`), and port 8080 continuously listening.
- See `test-results/PHASE_4A_2F_PREINSTALL.md` and `test-results/PHASE_4A_2F_INSTALLATION.md` for complete evidence.
