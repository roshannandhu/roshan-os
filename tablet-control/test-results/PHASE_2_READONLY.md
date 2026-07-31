# Phase 2 read-only integration evidence

Date: 2026-07-24

Scope: local controller integration with the already-running IP Webcam service. No tablet configuration, IP Webcam state, Tailscale configuration, root script, camera setting, audio setting, service lifecycle, VPS, firewall, or public exposure was changed.

## Sanitisation

Private IP addresses, Tailscale addresses, stream URLs, credentials, tokens, serial numbers, and media content are intentionally omitted. Media was read only until one first chunk was received, then the connection was cancelled; no media was recorded or persisted.

## Automated verification

| Check                      | Result                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration tests | Pass: 12 API tests and 2 web tests                                                                                                                             |
| Real-mode configuration    | Pass: missing base URL fails closed; loopback binding validation is covered by strict configuration                                                            |
| GET-only guard             | Pass: fixture observed only GET requests for status/video; real adapter mutations never construct a request                                                    |
| POST/control safety        | Pass: authenticated and CSRF-valid `POST /api/v1/camera/zoom` returned `ACTION_REQUIRES_APPROVAL`; fixture upstream request count remained zero                |
| Stream cleanup             | Pass: cancelling an adapter stream and closing a localhost proxy stream closed the fixture upstream connection                                                 |
| Typed errors               | Pass: malformed JSON/HTML is `MALFORMED_RESPONSE`; timeout is `TIMEOUT`; stream failure is `STREAM_FAILURE`; unauthorized/offline paths have structured errors |

## Live GET-only results

The tests used an in-memory, redacted trusted-LAN endpoint derived only for the process lifetime.

| Capability                        | Result                                             | Redacted latency                                                   |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /status.json?show_avail=1`   | HTTP 200 and typed status accepted                 | 167 ms adapter check                                               |
| `GET /video`                      | MJPEG response; first chunk received and cancelled | 87 ms direct adapter; 19 ms through localhost controller proxy     |
| `GET /audio.wav`                  | WAV response; first chunk received and cancelled   | 13 ms direct adapter; 80 ms through localhost controller proxy     |
| Local controller status route     | Authenticated read-only route succeeded            | successful (no address disclosed)                                  |
| Trusted-LAN TCP/HTTP reachability | Reachable, status endpoint returned HTTP 200       | successful                                                         |
| Tailscale reachability            | Not measured                                       | desktop Tailscale CLI absent; no Tailscale endpoint was configured |

Direct header-only availability checks also observed successful HTTP responses for the approved status, video, and WAV-audio paths. A legacy Opus audio endpoint was not used by the controller after its availability probe did not establish a usable connection.

## Browser/PWA findings

- Live video is delivered to the PWA as a local-controller MJPEG `<img>` stream. It is cleaned up when the component unmounts or reconnects.
- Live microphone listening uses a local-controller `<audio>` element. Browser autoplay rules require a user gesture, and background/mobile-PWA audio behavior and codec support remain device/browser dependent.
- Automatic video reconnection is capped at three retries (0.5 s, 1 s, 2 s); a user must manually reconnect after that.
- The workstation did not have the automated browser-verification helper installed, so visual playback and audible output were not claimed as directly observed. API proxy transport and first-chunk stream delivery passed.

## Safety conclusion

`tabletControlCommandsSent` was zero for both live checks. No POST, control endpoint, ADB write, root command, service restart, configuration change, app change, network-policy change, or media recording occurred.
