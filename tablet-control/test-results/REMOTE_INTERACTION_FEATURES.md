# Remote interaction feature verification

Date: 2026-07-26

## Implemented

- Added a fixed, typed allowlist of benign installed applications. The controller cannot submit an arbitrary Android package name, activity, intent, or shell command.
- Added authenticated app-list and app-launch routes in Companion and controller-api, plus mobile controls in the DEVICE tab.
- Added two distinct centered transparent text modes:
  - Animated message: 45 ms per character, then bounded automatic dismissal.
  - Live text: debounced phone input, immediate tablet update, persistent until Clear.
- Repaired push-to-talk private-HTTPS WebSocket origin validation. Exact same-origin and the explicit development origin are accepted; cross-origin and missing production origins are rejected.
- The browser now requests microphone permission while the hold gesture is active, resumes the audio context, resamples the browser input to 16 kHz mono PCM16, and routes the processor output through a muted gain node to avoid phone-side echo.
- Restore dashboard now uses a fixed root activity-start command after Android blocked a background activity launch following an app switch.

## Automated verification

- Controller API: 37 tests passed.
- Controller web: 29 tests passed.
- ESLint passed.
- Prettier completed and the repository is formatted.
- Strict TypeScript passed.
- Production controller/PWA build passed.
- Android `assembleDebug`, `testDebugUnitTest`, and `lintDebug` passed.
- Origin tests cover private reverse-proxy same-origin acceptance, configured local-origin acceptance, cross-origin rejection, and missing-origin rejection.
- UI tests cover animated/live-text controls and launching only an app returned by the approved list.

## Real tablet verification

- Existing Companion data was preserved with an in-place APK update.
- Companion process, foreground service, authenticated API, and controller lifecycle remained healthy.
- An unauthenticated app-list request was rejected.
- Nine approved installed applications were returned; security-sensitive and controller-critical packages are absent from the allowlist.
- An approved VLC launch reached the real tablet.
- The first dashboard-return test exposed Android background-activity blocking. After the fixed root fallback was installed, VLC launch and dashboard restoration both passed.
- Live text was present as a native tablet accessibility node and was removed by Clear.
- Animated text was present as a native tablet accessibility node during its display interval.
- Controller-to-tablet live-text update and clear routes returned real, non-simulated success.
- The authenticated talk WebSocket accepted start, relayed one silent PCM frame, and accepted stop.

## Boundaries

- No camera or microphone media was recorded or persisted.
- The bounded talk test used silence; audible speech from the physical phone microphone still requires one user-attended confirmation.
- No arbitrary app launching, remote shell API, Settings/Magisk/Tailscale/Termux/IP Webcam/Fully/Companion launching, or package installation route was added.
- Private network values, credentials, session cookies, and authorization headers are not included in this report.
- The temporary UI hierarchy used for text verification was deleted immediately.
