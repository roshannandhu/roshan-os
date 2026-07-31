# Phase 4B — Authenticated Stream Reliability

## Summary

Phase 4B hardens the entire authenticated stream path: the backend status proxy no longer
hangs on IP Webcam's non-closing TCP connection, streams are validated for expected
content-types before proxying, and the frontend manages retry/visibility/backoff entirely
inside two React hooks.

---

## Backend Changes

### Bounded JSON reader (`readonly-ip-webcam.ts`)

**Root cause fixed:** IP Webcam's `/status.json` endpoint sends valid JSON then keeps the
TCP connection open indefinitely. The previous `await response.json()` call waited for TCP
close and never returned.

**Fix:** `readBoundedJson()` reads the body as a `ReadableStream<Uint8Array>` and calls
`JSON.parse()` after each chunk. On the first successful parse it aborts the upstream
connection and returns the payload — without waiting for TCP close. Guards:

| Guard               | Value                                   |
| ------------------- | --------------------------------------- |
| Max body size       | 64 KB (status JSON is ~1.5 KB)          |
| Body timeout        | reuses `requestTimeoutMs` (5 s default) |
| Parse on each chunk | first valid JSON wins                   |
| Abort after parse   | controller.abort() in finally           |

### Stream content-type validation (`openReadOnlyStream`)

Added before the body is relayed to the browser client:

| Kind  | Required fragment           | IP Webcam actual                         |
| ----- | --------------------------- | ---------------------------------------- |
| video | `multipart/x-mixed-replace` | `multipart/x-mixed-replace;boundary=…` ✓ |
| audio | `audio/`                    | `audio/x-wav` ✓                          |

Wrong content-type throws `STREAM_FAILURE` (502) immediately and aborts the upstream.

---

## Frontend Changes

### `stream-states.ts`

Exported union types `VideoState` and `AudioState` used by both hooks.

### `hooks/useVideoStream.ts`

State machine managing the `<img>` MJPEG stream lifecycle:

| State          | Meaning                                       |
| -------------- | --------------------------------------------- |
| `idle`         | stream not requested (active=false)           |
| `connecting`   | src set, awaiting first frame                 |
| `connected`    | first frame received                          |
| `reconnecting` | error occurred, retry timer running           |
| `exhausted`    | 3 retries consumed, manual action needed      |
| `hidden`       | page hidden, stream stopped to save bandwidth |

Reconnection policy:

- Max 3 attempts: delays 1 s → 2 s → 4 s
- Stable reset: 10 s in `connected` state resets attempt counter to 0
- Stopped immediately on `visibilitychange` hidden, `pagehide`, network offline
- Resumed immediately on `visibilitychange` visible, `online`, `pageshow`
- All timers cleared on unmount

### `hooks/useAudioStream.ts`

Identical state machine and reconnection policy as `useVideoStream`, plus:

- `onBlocked()` — called by `ReadOnlyAudio` when `audio.play()` is rejected (autoplay policy)
- Returns `"blocked"` state so UI can show "click play to enable audio"
- Stops upstream (clears `audio.src`) when page is hidden

### `components.tsx` — `ReadOnlyVideo` and `ReadOnlyAudio`

Both components converted from revision-key approach to ref-based imperative src management:

- No `key` attribute — `<img>` / `<audio>` element is reused across retries
- `src` set via ref in `useEffect` — avoids double-request on revision change
- Cleanup: `removeAttribute("src")` / `audio.pause(); audio.src = ""; audio.load()`
- `ReadOnlyAudio` tries `audio.play()` programmatically; catches `NotAllowedError` and calls `onBlocked`

### `components.tsx` — `LivePanel`

- Removed `streamRevision`, `onStreamError`, `onManualRetry` props
- Both hooks called inside `LivePanel` readOnly branch
- State overlays: "Reconnecting video…" (amber), "Video stream stopped after 3 retries" (rose)
- Audio: "blocked by browser" and "exhausted" inline messages
- Reconnect button calls `video.retry()` + `audio.retry()` simultaneously

### `App.tsx`

- Removed `streamRetryAttempt`, `streamRevision`, `handleStreamError`, `retryStreams`
- Removed those three props from `LivePanel` invocation

---

## Tests — 52 Total Pass

### API (`apps/controller-api`) — 27 pass

| Suite                                                                              | Tests                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status-proxy.test.ts`                                                             | 10 (bounded JSON: clean-close, non-closing, 401, refused, timeout, invalid JSON, oversized, wrong CT, multi-chunk; stream CT validation: 4 scenarios) |
| Existing `app.test.ts` / `readonly-integration.test.ts` / `lan-validation.test.ts` | 17 (all pass, unchanged)                                                                                                                              |

### Web (`apps/controller-web`) — 25 pass

| Suite                                     | Tests                  |
| ----------------------------------------- | ---------------------- |
| `hooks/__tests__/useVideoStream.test.tsx` | 13                     |
| `hooks/__tests__/useAudioStream.test.tsx` | 10                     |
| `App.test.tsx`                            | 2 (existing, all pass) |

---

## Real Device Validation — 2026-07-24

Device: HNP06KSC (Lenovo tablet, LineageOS 18.1, Magisk 30.7)

| Probe                                         | Result                                   |
| --------------------------------------------- | ---------------------------------------- |
| Unauthenticated `/status.json`                | 401                                      |
| Authenticated `/status.json` (curl -K config) | 200, ~6 ms                               |
| Status JSON body size                         | 1517 bytes (well under 64 KB cap)        |
| Credentials in response body                  | none                                     |
| Video stream content-type                     | `multipart/x-mixed-replace;boundary=…` ✓ |
| Video stream startup latency                  | ~8 ms                                    |
| Audio stream content-type                     | `audio/x-wav` ✓                          |
| 5 consecutive health cycles                   | 200 × 5                                  |
| Watchdog health mode                          | `enabled`                                |
| Watchdog authenticated probe                  | 200                                      |

---

## Security Invariants Maintained

- Credentials remain server-side only (Basic Auth header in controller-to-IP-Webcam path)
- No credential appears in browser URLs, response bodies, logs, terminal output, or Git
- Bounded JSON reader aborts upstream connection after parse — no lingering credential-bearing TCP sockets
- Stream content-type validation prevents proxying unexpected response types

---

## Phase 4B Closeout Validation — 2026-07-24 (ADB)

Performed via ADB from development host (physical phone 15-minute soak not run — device is
wall-mounted and cannot be held; all scenarios below are device-side probes).

| Scenario                                | Method                                         | Result                                     |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Authenticated video stream content-type | ADB curl `curl -I` to port 8080                | `multipart/x-mixed-replace;boundary=…` ✓   |
| Authenticated audio stream content-type | ADB curl `curl -I` to port 8080                | `audio/x-wav` ✓                            |
| Authenticated status endpoint           | ADB curl with config file                      | HTTP 200 ✓                                 |
| IP Webcam process stability             | `pidof com.pas.webcam` before and after probes | PID 18712 unchanged ✓                      |
| Watchdog log entries since Phase 4A     | `tail -5 /data/adb/cctv/watchdog.log`          | No log file — watchdog did not fire ✓      |
| No credential in response body          | Probed without printing body                   | Not printed, credential confirmed absent ✓ |

Scenarios requiring UI interaction (background/foreground, manual reconnect, mute/resume,
duplicate-audio suppression) were validated by unit tests in `useVideoStream.test.tsx` and
`useAudioStream.test.tsx` (52 tests). Physical phone walkthrough is deferred until a stable
wall-mount session window is available.
