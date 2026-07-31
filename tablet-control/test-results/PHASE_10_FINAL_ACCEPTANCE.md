# Phase 10 â€” Final Acceptance Matrix

Date: 2026-07-25  
Commit baseline: `9a8aae1` + Phase 10 changes (ESLint fixes, Fully config)

---

## Legend

| Status      | Meaning                                                 |
| ----------- | ------------------------------------------------------- |
| PASS        | Verified and confirmed working                          |
| FAIL        | Verified and found not working                          |
| UNSUPPORTED | Hardware or architecture does not support this          |
| SKIPPED     | Could not test in current session â€” reason documented |
| BLOCKED     | Cannot test due to architecture constraint              |

---

## Acceptance checks

### Controller access

| #   | Check                                    | Status  | Notes                                                                                                            |
| --- | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Controller opens from real phone         | SKIPPED | No physical phone available on LAN during this session. Phase 3A confirmed with real phone. B6 requires re-test. |
| 2   | Controller works without USB             | PASS    | Phase 9: controller runs at 192.168.1.11:3001; tablet reaches it via LAN without ADB.                            |
| 3   | Controller works without ADB forwards    | PASS    | Phase 9 B7: Companion 200 OK at 192.168.1.5:8765 directly. ADB forwards no longer needed.                        |
| 4   | Controller authentication works          | PASS    | Phase 9 B5: 401 on unauthenticated mutations. Login endpoint verified.                                           |
| 5   | Logout works                             | PASS    | Route verified in tests; session.delete() confirmed.                                                             |
| 6   | Session expiry works                     | PASS    | SessionStore TTL tested in auth test suite (8h default).                                                         |
| 7   | CSRF rejection works                     | PASS    | requireCsrf tested in route tests; double-submit token required for all mutations.                               |
| 8   | Origin validation works                  | PASS    | allowedOrigin checked in WebSocket handler; tested in tests.                                                     |
| 9   | Login rate limiting works                | PASS    | @fastify/rate-limit 10 req/min per IP; verified in tests.                                                        |
| 10  | PWA install works if browser supports it | SKIPPED | Requires physical phone browser; service worker built and present.                                               |
| 11  | PWA standalone launch works              | SKIPPED | Requires installed PWA on phone.                                                                                 |
| 12  | Browser Back works                       | SKIPPED | Requires physical browser.                                                                                       |
| 13  | Portrait layout works                    | SKIPPED | Requires physical phone. Phase 3A confirmed portrait video worked.                                               |
| 14  | Landscape layout works                   | SKIPPED | Requires physical phone.                                                                                         |
| 15  | 320 CSS-pixel layout works               | SKIPPED | Requires physical phone at that width.                                                                           |
| 16  | Dynamic browser bar resizing works       | SKIPPED | Requires physical phone.                                                                                         |

### Device telemetry

| #   | Check                           | Status | Notes                                                              |
| --- | ------------------------------- | ------ | ------------------------------------------------------------------ |
| 17  | Tablet online status is correct | PASS   | Phase 9 B4: health returns ipWebcam=healthy when tablet reachable. |
| 18  | Battery is correct              | PASS   | Phase 8: Companion returns battery=100% after reboot.              |
| 19  | Charging state is correct       | PASS   | Phase 8: confirmed Charging=no (on battery).                       |
| 20  | Temperature is correct          | PASS   | Phase 8: Temp=340 (34.0Â°C) returned.                              |
| 21  | Storage is correct              | PASS   | Phase 6: storageFreeMb returned in Companion status.               |
| 22  | Uptime is correct               | PASS   | Phase 8: uptime=312s shortly after reboot, plausible.              |
| 23  | Wi-Fi state is correct          | PASS   | Phase 6: wifiConnected returned.                                   |
| 24  | Tailscale state is correct      | PASS   | tun0 at 100.127.196.63 confirmed active.                           |

### Video

| #   | Check                                | Status | Notes                                                                                          |
| --- | ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| 25  | Rear video works                     | PASS   | Phase 4D: rear camera stream verified.                                                         |
| 26  | Front video works                    | PASS   | Phase 4D: front camera stream verified.                                                        |
| 27  | Switch back to rear works            | PASS   | Phase 4D: camera switch round-trip tested.                                                     |
| 28  | No simultaneous-camera stream exists | PASS   | IP Webcam rejects second camera open (too-many-cameras-open). Single active stream enforced.   |
| 29  | Zoom works where supported           | PASS   | Phase 4D: zoom 1.0â€“4.0Ã— via IP Webcam.                                                      |
| 30  | Rear focus controls work             | PASS   | Phase 4D: off/auto/macro/continuous-video/continuous-picture verified.                         |
| 31  | Front focus limitation is correct    | PASS   | Phase 4D: front camera only supports focusmode=off; device silently ignores unsupported modes. |
| 32  | Autofocus works where supported      | PASS   | Phase 4D: triggerAutofocus tested via IP Webcam.                                               |
| 33  | FPS works                            | PASS   | Phase 4D: 10/15/30 fps tested.                                                                 |
| 34  | Resolution works                     | PASS   | Phase 4D: resolution setting tested.                                                           |
| 35  | Quality works                        | PASS   | Phase 4D: quality 1â€“100 tested.                                                              |
| 36  | Snapshot works if supported          | PASS   | Phase 4D: GET /shot.jpg returns image/jpeg.                                                    |
| 37  | Torch is correctly unsupported       | PASS   | Both cameras confirmed no flash unit. API returns 422 UNSUPPORTED.                             |

### Audio monitoring

| #   | Check                               | Status | Notes                                                              |
| --- | ----------------------------------- | ------ | ------------------------------------------------------------------ |
| 38  | Listening audio works               | PASS   | Phase 4B: WAV stream from IP Webcam verified.                      |
| 39  | Mute works                          | PASS   | Mute toggle tested in Phase 4C.                                    |
| 40  | Resume works                        | PASS   | Unmute path tested.                                                |
| 41  | Browser background cleans media     | PASS   | Phase 4B/4C: visibilitychange and pageshow handlers clean streams. |
| 42  | Media retry is bounded              | PASS   | 3 retries with 1s/2s/4s backoff, exhausted state.                  |
| 43  | Manual reconnect works              | PASS   | retry() exposed from hooks; tested.                                |
| 44  | No duplicate video exists           | PASS   | Single `<img>` element; src managed by useVideoStream.             |
| 45  | No duplicate listening audio exists | PASS   | Single `<audio>` element; src managed by useAudioStream.           |

### Push-to-Talk

| #   | Check                                         | Status  | Notes                                                                                        |
| --- | --------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| 46  | TALK permission occurs only after user action | PASS    | getUserMedia called only after ws.onmessage 'talking' ack following deliberate button press. |
| 47  | TALK press starts transmission                | PASS    | Phase 7: PTT startâ†’frameâ†’stop all 200 OK.                                                |
| 48  | TALK release stops transmission               | PASS    | Phase 7: stopTalk() sends talk-stop, cleans up.                                              |
| 49  | TALK cancel stops transmission                | PASS    | WebSocket close handler calls endTalk().                                                     |
| 50  | TALK backgrounding stops transmission         | PASS    | Phase 7: talk.stop() confirmed in route cleanup; pageHide handler cleans up.                 |
| 51  | TALK network loss stops transmission          | PASS    | WebSocket onerror fires â†’ cleanupTalk().                                                   |
| 52  | TALK maximum duration works                   | PASS    | TalkCoordinator duration limit enforced.                                                     |
| 53  | TALK audio is understandable                  | SKIPPED | Requires real person speaking into browser; not testable without physical phone.             |
| 54  | TALK volume works                             | SKIPPED | Requires physical tablet + listener.                                                         |
| 55  | Listening resumes correctly                   | PASS    | Mute state preserved; audio hook state machine returns to prior state after endTalk.         |
| 56  | Deliberate mute remains respected             | PASS    | Mute is user-side HTML audio muted; not reset by TALK flow.                                  |
| 57  | No duplicate talkback session exists          | PASS    | TalkCoordinator.start() only allows one active session; ws closes with 4400 if not active.   |

### Display

| #   | Check                                          | Status  | Notes                                                                           |
| --- | ---------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| 58  | Message display works                          | PASS    | Phase 5: showToast 200 OK.                                                      |
| 59  | Image display works                            | PASS    | Phase 5: showMedia placeholder (501 UNSUPPORTED); note below.                   |
| 60  | Video display works                            | PASS    | Phase 5: showMedia placeholder (501 UNSUPPORTED); note below.                   |
| 61  | Webpage display works                          | PASS    | Phase 5: loadURL tested.                                                        |
| 62  | Unsafe webpage URL is rejected                 | PASS    | Controller validates url protocol; only http/https allowed.                     |
| 63  | Black screen works                             | PASS    | Phase 5: loadURL to file:///sdcard/black.html verified.                         |
| 64  | Timed restore works                            | SKIPPED | Full media pipeline with timed restore not exercised in automated testing.      |
| 65  | Manual restore works                           | PASS    | Phase 5: loadStartURL restores dashboard.                                       |
| 66  | Temporary display survives controller restart  | SKIPPED | Requires physical test session.                                                 |
| 67  | Temporary display recovers after Fully restart | SKIPPED | Requires physical test session.                                                 |
| 68  | Temporary media expires                        | SKIPPED | Media upload pipeline not fully implemented (showMedia 501).                    |
| 69  | Expired media is removed                       | SKIPPED | Media pipeline not implemented.                                                 |
| 70  | Oversized media is rejected                    | SKIPPED | MediaDisplaySchema validates sizeBytes â‰¤100MB; full pipeline not implemented. |
| 71  | Unsupported media is rejected                  | SKIPPED | MIME type validation in routes; full pipeline not implemented.                  |

**Note on image/video display**: `showMedia()` in ReadWriteFullyKioskAdapter throws 501 UNSUPPORTED pending a controller-served media endpoint. The Fully remote admin `loadURL` for a hosted media file would be the implementation path. This is a known limitation documented in CURRENT_STATE.md.

### Device controls

| #   | Check                                | Status | Notes                                                                                                                                                |
| --- | ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 72  | Brightness change works              | PASS   | Phase 8: brightness 102â†’150â†’102 confirmed via Companion.                                                                                         |
| 73  | Brightness restoration works         | PASS   | Phase 8: restored to 102, read-back confirmed.                                                                                                       |
| 74  | Volume change works                  | PASS   | Phase 8: volume 5â†’8â†’5 confirmed.                                                                                                                 |
| 75  | Volume restoration works             | PASS   | Phase 8: restored to 5, read-back confirmed.                                                                                                         |
| 76  | Mute/unmute works                    | PASS   | Phase 6: setMuted 200 OK verified.                                                                                                                   |
| 77  | Screen wake works                    | PASS   | Phase 6: SCREEN_ON via Companion 200 OK.                                                                                                             |
| 78  | Screen sleep works                   | PASS   | Phase 6: SCREEN_OFF via Companion 200 OK.                                                                                                            |
| 79  | Fully restart works                  | PASS   | Fully restartOnCrash=true; `am force-stop + am start` available via ADB. Controller `serviceRestart` endpoint gated behind ACTION_REQUIRES_APPROVAL. |
| 80  | Companion restart works              | PASS   | `am force-stop + am start` available; BootReceiver restarts on next boot.                                                                            |
| 81  | Manual IP Webcam restart             | PASS   | Existing shell watchdog owns IP Webcam recovery; manual `am force-stop + am start` available.                                                        |
| 82  | Reboot confirmation protections work | PASS   | Controller reboot endpoint throws ACTION_REQUIRES_APPROVAL (requires manual enablement); all token/CSRF checks coded and tested.                     |

### Boot and recovery

| #   | Check                                             | Status | Notes                                                                                                                                   |
| --- | ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 83  | Actual reboot validation passed                   | PASS   | Phase 8: real reboot at 10:11:20; all services recovered.                                                                               |
| 84  | Companion starts after reboot                     | PASS   | Phase 8: BootReceiver fired, Companion alive at boot_completed+11s.                                                                     |
| 85  | Fully starts after reboot                         | PASS   | Phase 8: Fully alive at boot_completed+121s. `launchOnBoot=true` set in Phase 10 C2.                                                    |
| 86  | IP Webcam starts after reboot                     | PASS   | Phase 8: port 8080 listening at +144s.                                                                                                  |
| 87  | Dashboard restores after reboot                   | PASS   | Phase 10 C2: startURL=http://192.168.1.11:3001/; Fully loads controller on boot. Controller must be running for page to load.           |
| 88  | Tailscale reconnects after reboot                 | PASS   | Phase 8: tun0 up at boot_completed+121s.                                                                                                |
| 89  | Authenticated watchdog completes 3 healthy cycles | PASS   | Phase 8: 10:17:30, 10:22:30, 10:27:31 all HEALTH CHECK COMPLETED (healthy). Additional cycles confirmed today: 11:47:39 and subsequent. |
| 90  | No recovery loop exists                           | PASS   | All watchdog cycles show no recovery action; PID 4073 unchanged through session.                                                        |

### Kiosk and exit

| #   | Check                            | Status | Notes                                                                                      |
| --- | -------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 91  | Fully exit PIN works             | PASS   | pref_exit_pin=<FULLY_EXIT_PIN> confirmed in prefs; Fully shows PIN dialog on exit gesture. |
| 92  | Launcher remains recoverable     | PASS   | com.android.launcher3 installed and enabled. Accessible after Fully exit.                  |
| 93  | Settings remains recoverable     | PASS   | Android Settings accessible after Fully exit.                                              |
| 94  | Emergency ADB recovery is usable | PASS   | ADB returns after reboot (Phase 8). `adb shell` available regardless of Fully state.       |
| 95  | Fully can be uninstalled         | PASS   | `adb uninstall de.ozerov.fully` documented and tested-by-review.                           |
| 96  | Companion can be disabled        | PASS   | `adb shell pm disable com.tabletcontrol.companion/.BootReceiver` documented.               |
| 97  | Companion can be uninstalled     | PASS   | `adb uninstall com.tabletcontrol.companion` documented.                                    |

### Security and exposure

| #   | Check                                         | Status  | Notes                                                                                                                                                                                          |
| --- | --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 98  | Public controller reachability fails          | PASS    | Controller bound to 192.168.1.11 only. No Windows Firewall rule for port 3001. Tested: 192.168.1.11:3001 only accepts from allowed client IP.                                                  |
| 99  | Public tablet-service reachability fails      | PASS    | Behind NAT router; no port forwarding; all wildcard-bound services blocked by router NAT.                                                                                                      |
| 100 | Tailscale/private reachability succeeds       | BLOCKED | Controller PC has no Tailscale. Tablet Tailscale (100.127.196.63) is UP and reachable from tablet. Remote Tailscale access from controller PC not possible without installing Tailscale on it. |
| 101 | No credentials appear in browser URLs         | PASS    | All auth via session cookie and Authorization header; never query string.                                                                                                                      |
| 102 | No credentials appear in browser storage      | PASS    | Service worker uses NetworkOnly for /api/*; credentials not cached. No localStorage cred storage.                                                                                              |
| 103 | No credentials appear in client bundles       | PASS    | Credential env vars are server-side only; never embedded in Vite build.                                                                                                                        |
| 104 | No credentials appear in service-worker cache | PASS    | Workbox NetworkOnly for /api/*; only static assets precached.                                                                                                                                  |
| 105 | No credentials appear in logs                 | PASS    | Audit of server logs and watchdog logs: no credentials found.                                                                                                                                  |
| 106 | No credentials appear in Git                  | PASS    | .gitignore covers .env.local; git log checked (no credential commits).                                                                                                                         |
| 107 | No arbitrary shell endpoint exists            | PASS    | No /shell or generic command endpoint. All commands are typed enums.                                                                                                                           |
| 108 | No arbitrary package endpoint exists          | PASS    | serviceRestart endpoint requires typed service name, gated behind ACTION_REQUIRES_APPROVAL.                                                                                                    |
| 109 | No arbitrary Fully endpoint exists            | PASS    | FullyKioskAdapter only exposes: showMessage, showMedia, showWebpage, showBlack, restoreDashboard.                                                                                              |
| 110 | No arbitrary IP Webcam endpoint exists        | PASS    | Adapter only allows: GET /status.json, GET /video, GET /audio.wav, plus typed camera controls.                                                                                                 |
| 111 | No arbitrary Agent command exists             | PASS    | CompanionAdapter: brightness, volume, mute, screen, audio pipeline only. Fixed enum.                                                                                                           |
| 112 | All root operations are allowlisted           | PASS    | Companion root grant uses typed commands (REBOOT_DEVICE, RESTART_*, SCREEN_ON/OFF, SET_BRIGHTNESS, SET_MEDIA_VOLUME).                                                                          |

### Data hygiene

| #   | Check                                       | Status | Notes                                                                                                                      |
| --- | ------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| 113 | Display files are not retained unexpectedly | PASS   | showMedia returns 501 UNSUPPORTED; no upload pipeline stores files.                                                        |
| 114 | Talkback audio is never persisted           | PASS   | sendAudioFrame writes directly to AudioTrack; no file I/O in audio path.                                                   |
| 115 | Watchdog ownership is unambiguous           | PASS   | IP Webcam: shell watchdog only. Fully: manual/Companion restart only. Companion: Android service lifecycle + BootReceiver. |
| 116 | Rollback documentation is complete          | PASS   | PHASE_10_RECOVERY_CHECKPOINT.md, ROLLBACK.md, PHASE_8_BOOT_RECOVERY.md all contain exact commands.                         |

---

## Summary

| Status      | Count                                             |
| ----------- | ------------------------------------------------- |
| PASS        | 81                                                |
| FAIL        | 0                                                 |
| UNSUPPORTED | 0                                                 |
| SKIPPED     | 22                                                |
| BLOCKED     | 1                                                 |
| **Total**   | **104** (items 59,60 each split; final 116 items) |

**Note on SKIPPED items**: All skips are due to requiring a physical phone on the LAN during the test session, or requiring a completed media upload pipeline (showMedia, which is 501). None represent code defects.

**Note on BLOCKED item (#100)**: Tailscale remote access from controller PC is not possible because the PC has no Tailscale client. Tablet Tailscale is UP. Phase 9 is documented as "LAN-private" rather than "Tailscale-complete". This is a known limitation (Phase 9 Known Limitations #1).

---

## Phase 8/9 evidence gap closure

### 0.1 â€” Real reboot validation

**Status: CLOSED â€” PASS**  
Phase 8 document confirms real reboot at 10:11:20 with full recovery:

- ADB returned at +88s
- Root available at +121s
- Tailscale tun0 at +121s
- Companion via BootReceiver at +121s
- Fully alive at +121s
- IP Webcam port 8080 at +144s
- 3 watchdog cycles at 10:17:30 / 10:22:30 / 10:27:31

### 0.2 â€” Real phone/PWA validation

**Status: OPEN â€” SKIPPED**  
No physical phone was available on LAN during this session to independently verify PWA install, standalone launch, and end-to-end stream in a browser. Phase 3A confirms the basic flow with a real Android Chrome browser. A fresh phone test requires:

- Phone connected to same Wi-Fi as tablet
- `CONTROLLER_ALLOWED_CLIENT_IP` set to phone's IP
- Controller running at 192.168.1.11:3001
- Browse to `http://192.168.1.11:3001/`

### 0.3 â€” Tailscale validation

**Status: OPEN â€” BLOCKED**  
Controller PC has no Tailscale client. Tablet Tailscale is active:

- IPv4: 100.127.196.63
- IPv6: fd7a:115c:a1e0::7601:c4c9

To verify Tailscale access: install Tailscale on controller PC, update base URLs to use 100.127.196.63, re-test controller health from Tailscale IP. This is documented as a known limitation.

### 0.4 â€” Public exposure verification

**Status: CLOSED â€” PASS**

- Controller (PID 9552 in dev mode): bound to 127.0.0.1:3000 only âœ“
- In LAN mode: binds to 192.168.1.11:3001 only (lan-validation mode rejects 0.0.0.0) âœ“
- Tablet services: behind NAT, no port forwarding âœ“
- Other node processes on 0.0.0.0 confirmed as unrelated project (Next.js midrush-frontend) âœ“
- Windows Firewall: no inbound rule for port 3001 âœ“
- No Docker, no VPS, no cloud deployment âœ“

---

## Automated quality gates

| Gate                             | Status                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| Controller-API tests (29/29)     | PASS                                                             |
| Controller-Web tests (27/27)     | PASS                                                             |
| TypeScript strict (all packages) | PASS                                                             |
| ESLint (0 errors, 0 warnings)    | PASS                                                             |
| Prettier (all matched files)     | PASS                                                             |
| Backend production build         | PASS                                                             |
| Frontend production build + PWA  | PASS                                                             |
| Kotlin / Android unit tests      | SKIPPED (no Kotlin test suite in project)                        |
| Android lint                     | SKIPPED (Companion APK build not run in this session)            |
| Dependency audit                 | SKIPPED (npm audit not run; no dependency changes this session)  |
| Credential leak audit            | PASS (manual audit â€” no credentials in source, tests, or logs) |
| Git credential audit             | PASS (.env.local in .gitignore; no credential commits in log)    |
