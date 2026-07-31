# Controller API Specification

All endpoints are under /api/v1. Browser clients use same-origin HTTPS and never call tablet components directly.

Phase 1 implementation note: the listed API exists as a local mock controller where applicable. Camera, display, brightness, volume, and talk interactions mutate only in-memory adapter state. Root-backed restart, screen, and reboot routes return ACTION_REQUIRES_APPROVAL; no real tablet endpoint is contacted.

## Response envelope

Success:

{
"ok": true,
"data": {}
}

Failure:

{
"ok": false,
"error": {
"code": "CAMERA_OFFLINE",
"message": "IP Webcam did not respond.",
"recoverable": true
}
}

## Read-only endpoints

| Method | Path                  | Notes                                              |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | /api/v1/health        | Controller process health only.                    |
| GET    | /api/v1/tablet/status | Aggregated, redacted device status.                |
| GET    | /api/v1/tablet/health | Per-adapter reachability and degraded states.      |
| GET    | /api/v1/camera/status | IP Webcam status mapped to shared types.           |
| GET    | /api/v1/camera/stream | Authenticated media proxy or temporary stream URL. |
| GET    | /api/v1/camera/audio  | Authenticated selected listening-audio proxy.      |

## Camera endpoints

| Method | Path                      | Body / validation                                                  |
| ------ | ------------------------- | ------------------------------------------------------------------ |
| POST   | /api/v1/camera/select     | camera: front or rear; only after installed endpoint is verified.  |
| POST   | /api/v1/camera/torch      | enabled boolean; returns UNSUPPORTED on current no-flash hardware. |
| POST   | /api/v1/camera/zoom       | zoom number constrained to discovered range.                       |
| POST   | /api/v1/camera/focus      | mode from discovered allowlist.                                    |
| POST   | /api/v1/camera/fps        | fps integer from discovered allowlist.                             |
| POST   | /api/v1/camera/resolution | resolution value from discovered allowlist.                        |
| POST   | /api/v1/camera/quality    | quality integer constrained to discovered range.                   |
| POST   | /api/v1/camera/restart    | Disabled until root recovery phase approval.                       |
| POST   | /api/v1/camera/snapshot   | Disabled until action path and lifecycle are verified.             |

## Display endpoints

| Method | Path                            | Body / validation                                                    |
| ------ | ------------------------------- | -------------------------------------------------------------------- |
| POST   | /api/v1/display/message         | text, style enum, alignment enum, duration seconds, restore boolean. |
| POST   | /api/v1/display/live-text       | Centered transparent text, persistent until cleared.                 |
| POST   | /api/v1/display/live-text/clear | Clear the current live/animated text overlay.                        |
| POST   | /api/v1/display/image           | Validated multipart image plus duration and restore controls.        |
| POST   | /api/v1/display/video           | Validated multipart video plus duration and restore controls.        |
| POST   | /api/v1/display/webpage         | Parsed allowed URL, duration, and restore controls.                  |
| POST   | /api/v1/display/black           | Duration and restore controls.                                       |
| POST   | /api/v1/display/restore         | Restore configured dashboard.                                        |

Display endpoints return NOT_CONFIGURED until Fully Kiosk is installed and verified.

## Device and service endpoints

| Method | Path                                 | State                                                       |
| ------ | ------------------------------------ | ----------------------------------------------------------- |
| POST   | /api/v1/device/brightness            | Future Companion/Fully validated range.                     |
| POST   | /api/v1/device/volume                | Future Companion/Fully validated range.                     |
| POST   | /api/v1/device/mute                  | Future Companion/Fully implementation.                      |
| GET    | /api/v1/device/apps                  | Installed members of the fixed approved-app allowlist.      |
| POST   | /api/v1/device/apps/launch           | Launch one typed approved app identifier; no package input. |
| POST   | /api/v1/device/screen                | Disabled until existing automation interaction is resolved. |
| POST   | /api/v1/device/reboot                | Disabled pending explicit approval and local validation.    |
| POST   | /api/v1/services/ip-webcam/restart   | Disabled pending root recovery phase.                       |
| POST   | /api/v1/services/fully-kiosk/restart | Disabled pending Fully installation and approval.           |
| POST   | /api/v1/services/companion/restart   | Enabled only after Companion installation and verification. |
| POST   | /api/v1/services/tailscale/restart   | Disabled pending explicit approval and local validation.    |

## Talk WebSocket

Path: /api/v1/talk

Client lifecycle:

1. Authenticated client sends talk-start.
2. Server checks a single active PTT lease and mutes listening audio state for that session.
3. Client sends binary audio frames.
4. Server relays frames only to the authenticated Companion.
5. Client sends talk-stop, disconnects, backgrounds, exceeds timeout, or cancels a pointer gesture.
6. Server flushes/ends playback and restores listening after a configurable short delay.

Server-side limits:

- One transmission per tablet.
- Maximum frame size and total session duration.
- Stop on malformed message, token failure, connection loss, or timeout.
- No audio content retained or logged.

## Error codes

| Code                     | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| UNAUTHENTICATED          | No valid controller session.                                 |
| FORBIDDEN                | Authenticated but not authorized.                            |
| CSRF_REJECTED            | State-changing request failed CSRF validation.               |
| TABLET_OFFLINE           | Controller cannot reach tablet adapter.                      |
| CAMERA_OFFLINE           | IP Webcam health check failed.                               |
| UNSUPPORTED              | Capability not available on device or installed component.   |
| NOT_CONFIGURED           | Required component or secret is absent.                      |
| VALIDATION_ERROR         | Input is invalid or outside a discovered allowlist.          |
| ACTION_REQUIRES_APPROVAL | Safety-gated action has not been enabled.                    |
| CONFLICT                 | An exclusive resource, such as PTT lease, is already active. |
