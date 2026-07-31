# Phase 4A post-update read-only assessment

Date: 2026-07-24

## Scope

Phase 4A authentication work is paused. This assessment used only package/service/UI inspection and bounded unauthenticated GET requests. It did not change settings, private preferences, app data, automation, service lifecycle, or network configuration. No media was saved.

## Version comparison

| Record              | Version name                                | Version code | Result                             |
| ------------------- | ------------------------------------------- | ------------ | ---------------------------------- |
| Phase 0 inventory   | `1.14.37.759 (aarch64)`                     | Not recorded | Historic baseline                  |
| Phase 2 integration | No divergent installed-app version recorded | Not recorded | Endpoint contract baseline         |
| Phase 3B assessment | `1.19.0.913 (multiarch)`                    | Not recorded | Matches current version name       |
| Current assessment  | `1.19.0.913 (multiarch)`                    | `9134`       | Package `com.pas.webcam` unchanged |

The repository therefore records an update between the Phase 0 inventory and Phase 3B. It has no evidence of a further version change after Phase 3B.

## Read-only service checks

- Package process: present.
- WebServer service record: present.
- TCP 8080 listener: present.
- Camera and microphone runtime grants: present.
- `GET /status.json?show_avail=1`: returned data without authentication.
- `GET /video`: returned bounded stream data.
- `GET /audio.wav`: returned bounded stream data.
- The served homepage is present; known status, video, and audio endpoints remain usable.

## Authentication/UI result

The normal Android IP Webcam settings UI and served homepage did not expose a visible Login/password, Local broadcasting, authentication, or security option. The unauthenticated status response did not include `WWW-Authenticate`. Authentication remains disabled/unverified; no credential was created or supplied.

## Automation/settings and rollback result

The existing boot and watchdog script files are present. Read-only checks found the boot script's launch and delay references, and the app is currently healthy. This is evidence that the existing setup appears preserved, not proof of future boot-cycle behavior. No private-preference diff was performed because that is out of scope.

No local APK with package `com.pas.webcam` was found in the workspace or Downloads folder, so no safe rollback version is currently backed up in those locations. No rollback, downgrade, uninstall, clear-data operation, restart, or script modification was attempted.
