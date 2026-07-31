# Phase 4C — Mobile Controller UI Shell

## Summary

Phase 4C hardens the controller into a polished mobile-first application shell. No tablet,
IP Webcam, watchdog, Tailscale, camera control, or Fully Kiosk change was made.

---

## Changes by Area

### PWA and Viewport

| Change               | File             | Detail                                                                                                                             |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `viewport-fit=cover` | `index.html`     | Enables safe-area insets for notch/home-indicator devices                                                                          |
| NetworkOnly SW rule  | `vite.config.ts` | Workbox runtime cache excludes all `/api/*` routes; `navigateFallback: null` prevents SW from returning `index.html` for API paths |

### Resilience

| Change               | File                 | Detail                                                                                          |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| Error boundary       | `error-boundary.tsx` | React class component; unhandled render errors show "Something went wrong" with a Reload button |
| Error boundary mount | `main.tsx`           | `<ErrorBoundary>` wraps `<App>` inside `<StrictMode>`                                           |

### Status Header

- Accepts `videoState: VideoState` and `audioState: AudioState` as props
- Shows compact "Cam: live / Mic: retrying" badge row when either stream is not idle
- Badge colours: emerald (connected), amber (connecting/reconnecting/hidden/paused), rose (exhausted/blocked)
- Row hidden entirely when both states are idle (avoids noise in mock mode)

### App Shell

- `activeTab` initialised from `localStorage.getItem("tc-tab")` (falls back to `"live"`)
- Tab changes write to `localStorage.setItem("tc-tab", tab)` via `handleTabChange()`
- Switching away from LIVE tab resets `videoState` and `audioState` to `"idle"` so the status header clears immediately
- `LivePanel` accepts optional `onVideoStateChange` / `onAudioStateChange` callbacks; App passes them only when `readOnly`, using spread to satisfy `exactOptionalPropertyTypes`

### LIVE Tab (readOnly)

- Camera selector now renders two disabled `<button>` elements (rear / front) with `cursor-not-allowed` styling
- Note below buttons: "Camera switching available after camera-control verification (Phase 4D)"
- Torch notice: "Torch unavailable — this tablet has no camera flash hardware" in a subdued info box
- Status latency and transport metadata preserved

### TALK Tab (readOnly)

- Replaced plain text notice with a disabled hold-to-talk button matching the mock layout (208×208 rounded, `Radio` icon, "HOLD TO TALK" label)
- Button has `disabled`, `aria-disabled="true"`, and `cursor-not-allowed`; no microphone request is ever made
- Notice: "Talkback agent not installed yet. Two-way audio requires Phase 5 Companion Agent."
- Secondary note: "Live listening (read-only) is available from the Live tab."

### DISPLAY Tab (readOnly)

- Notice updated from "Display controls are unavailable in read-only mode" to
  "Fully Kiosk integration required" with explanatory text

### DEVICE Tab

- `unavailable()` helper default message changed from "Not reported" to
  "Unavailable until Companion Agent"
- Inline null checks for `charging`, `wifiConnected`, `tailscaleConnected` updated to the same message
- Storage and other Companion-only fields already used `unavailable()` so they pick up the change automatically

---

## Tests — 54 Total Pass

### Web (`apps/controller-web`) — 27 pass

| Suite                                     | Tests | New in 4C           |
| ----------------------------------------- | ----- | ------------------- |
| `App.test.tsx`                            | 4     | 2 (tab persistence) |
| `hooks/__tests__/useVideoStream.test.tsx` | 13    | 0                   |
| `hooks/__tests__/useAudioStream.test.tsx` | 10    | 0                   |

New tests:

- "saves the active tab to localStorage when switching"
- "restores the active tab from localStorage on mount"

### API (`apps/controller-api`) — 27 pass

No changes; all 27 tests continue to pass.

---

## Build Verification

| Check                        | Result                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tsc -b` (web)               | Pass — no errors                                                                                                 |
| `tsc -p tsconfig.json` (API) | Pass — no errors                                                                                                 |
| `vite build` (web)           | Pass — `sw.js` + `workbox-*.js` generated                                                                        |
| SW NetworkOnly rule          | Confirmed via grep: `pathname.startsWith` and `NetworkOnly` both present in `dist/sw.js`                         |
| API build                    | Pass                                                                                                             |
| Lint                         | 5 pre-existing errors from Phase 4B hook patterns (refs-in-render, setState-in-effect) — 0 new errors introduced |

---

## Security Invariants Maintained

- No credential appears in Git, terminal output, or documentation
- `/api/*` routes excluded from SW cache — no credential-bearing response is stored
- `navigateFallback: null` — SW cannot serve stale index.html in place of API errors
- Error boundary logs to console only; no sensitive data in the error display

---

## ADB Device Check — 2026-07-24

| Probe                | Result                                          |
| -------------------- | ----------------------------------------------- |
| IP Webcam PID        | 18712 — unchanged through Phase 4C session      |
| TCP 8080 listener    | Present                                         |
| Authenticated status | HTTP 200                                        |
| Video content-type   | `multipart/x-mixed-replace;boundary=…` ✓        |
| Audio content-type   | `audio/x-wav` ✓                                 |
| Watchdog log entries | No new entries — no watchdog recovery triggered |

No tablet, IP Webcam setting, watchdog script, Tailscale configuration, camera control,
or Fully Kiosk change was made during Phase 4C.
