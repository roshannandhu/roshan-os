# Phase 3A real-phone/PWA validation evidence

Date: 2026-07-24

## Redaction and scope

Phone identity, browser version, LAN addresses, temporary password, session secret, IP Webcam address, and media content are intentionally omitted. No media was recorded or stored. No tablet setting, camera control, application, root script, router, firewall, VPN, or VPS state was changed.

## Observed phone results

| Check                         | Result                                              |
| ----------------------------- | --------------------------------------------------- |
| Login                         | Pass                                                |
| Live MJPEG video              | Pass after an initial interrupted/retry state       |
| Microphone playback           | Pass after pressing Play/user interaction           |
| User gesture requirement      | Confirmed                                           |
| Local mute/unmute             | Pass                                                |
| Fullscreen                    | Pass                                                |
| Automatic reconnection        | Not fully confirmed; manual reconnect may be needed |
| Portrait/landscape            | Unavailable or did not behave correctly             |
| Camera switching              | Intentionally unavailable in this phase             |
| End-to-end latency            | Not accurately measured                             |
| Continuous stability duration | Not fully measured                                  |
| Background/screen-lock        | Not observed; no result claimed                     |
| PWA installation              | Not observed; no result claimed                     |

## Read-only reliability inspection

- IP Webcam process, foreground WebServer service, and TCP 8080 listener were present at inspection time.
- Existing boot automation scripts were present and untouched. The boot script contains boot-completion, user-unlock, start, and delay logic.
- One tablet-local status request received partial data and then exceeded its five-second timeout. This, together with the phone's initial interruption and possible need to open IP Webcam manually, is an unresolved reliability finding. No restart, setting change, or watchdog edit was made.

## LAN cleanup

The user confirmed `LAN_VALIDATION_REMOVED` after Ctrl+C and confirmed temporary LAN access was removed. No controller credentials or LAN settings were persisted. A later host check observed a separate wildcard Node listener that did not identify or respond as this controller; it was left untouched.
