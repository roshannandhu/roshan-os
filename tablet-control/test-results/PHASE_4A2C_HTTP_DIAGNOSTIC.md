# Phase 4A.2c read-only IP Webcam HTTP diagnosis

Date: 2026-07-24

## Scope and safeguards

Only bounded, unauthenticated GET probes were made. No stream endpoint was requested in this diagnostic phase, no media was stored, and no application, automation, network, camera, or authentication setting changed.

## Process, service, and resource state

- ADB and root access were available.
- The IP Webcam process was present in sleeping state, with the WebServer foreground-service markers present.
- TCP 8080 was listening with a `0,128` receive/send queue and no established, half-open, or TIME-WAIT connections at sampling time.
- The process had 158 threads, 312 file descriptors (56 sockets), approximately 172 MiB resident memory, and a five-second CPU-time increase of three ticks with no RSS increase. This snapshot does not indicate connection or resource exhaustion.
- Camera and audio package markers were visible in their Android service dumps, but those dumps did not provide an unambiguous active-owner summary.

## Bounded HTTP findings

The root endpoint completed normally from both locations. The status endpoint connected and returned HTTP 200 with a small response body promptly, but did not complete before the eight-second curl limit.

| Location      | Endpoint                    | Result                                                                               |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Tablet-local  | `/`                         | HTTP 200, 40,812 bytes, completed.                                                   |
| Tablet-local  | `/status.json?show_avail=1` | HTTP 200 and 289 bytes shortly after connect; curl timed out waiting for completion. |
| Laptop direct | `/`                         | HTTP 200, 40,812 bytes, completed.                                                   |
| Laptop direct | `/status.json?show_avail=1` | HTTP 200 and 289 bytes shortly after connect; curl timed out waiting for completion. |

The status response includes `Connection: close` but no `Content-Length` or `Transfer-Encoding`; the server did not close the connection before the client limit. This behavior is reproduced locally and remotely, so it is not a LAN routing failure.

The currently listening localhost controller process returned HTTP 404 for the expected camera-status route, so no real controller-proxy comparison was available in this session.

## Logs and watchdog

- A tightly filtered recent logcat window contained no matching IP Webcam/WebServer exception, ANR, out-of-memory, too-many-open-files, broken-pipe, socket-timeout, camera-error, or audio-error entry.
- The watchdog recorded healthy cycles at `11:32:36`, `11:37:37`, and `11:48:19`.
- It also recorded one failed recovery attempt at `11:42:57` to `11:43:18`. The following healthy cycle means this is not evidence of an active restart loop, but the restored legacy helper's parser defect leaves a false-recovery risk.

## Conclusion

Classification: **insufficient evidence** for a server deadlock, connection exhaustion, camera/audio handler stall, or remote-network failure. The evidence supports a narrower status-handler response-completion defect: the response begins normally but does not close despite its header. The root handler is currently healthy.

A normal IP Webcam UI restart is not justified by this evidence alone. If the incomplete status response persists for user-facing clients, any restart decision should be separately approved and should account for the helper parser defect to avoid a false watchdog recovery.
