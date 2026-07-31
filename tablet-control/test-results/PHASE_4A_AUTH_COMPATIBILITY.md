# Phase 4A documented-Cheats authentication compatibility assessment

Date: 2026-07-24

## Result

**Blocked before credential entry.** The documented Cheats interface was not used to set Login or Password because authentication would break existing CCTV automation that is outside the approved modification scope.

## Redacted baseline

- ADB and root recovery: verified.
- IP Webcam package/version: `com.pas.webcam`, `1.19.0.913 (multiarch)`, version code `9134`.
- Process, WebServer service record, and TCP 8080 listener: present.
- Unauthenticated status: accepted.
- Bounded video and WAV-audio GET checks: returned data.

## Exact compatibility finding

`/data/adb/service.d/20-cctv-camera.sh` loads the shared CCTV helper. The watchdog starter launches a daemon that also loads that helper. At the time of this initial assessment the helper was treated as an HTTP-200-only liveness check, but Phase 4A.1 later confirmed the installed helper already treats HTTP 200 and HTTP 401 as liveness-positive. The helper also checks the process and TCP listener.

Enabling Login/Password would have caused the older HTTP-200-only assumption to fail, which is why Phase 4A stopped before credential entry. The existing scripts and helper were not changed during this initial assessment; Phase 4A.1 later added an auth-compatible helper while leaving authentication disabled.

## Actions not taken

- No Login or Password value was generated, displayed, entered, stored, logged, or committed.
- No IP Webcam setting or service lifecycle action was performed.
- No private preference, APK, app-data, network, or automation change was performed.
- No media was saved.

## Required next approval

To enable IP Webcam authentication, approve a separately scoped automation compatibility change with a tested rollback plan, or explicitly approve an alternative supported health-check design. Until then, keep authentication disabled and do not proceed to Phase 4B or camera controls.
