# Rollback Plan

## Phase 0 baseline

Phase 0 is documentation-only on the tablet. There is no tablet-side rollback action because no tablet setting, app, script, permission, service, or network configuration was changed.

The new local repository can be removed manually if desired; no existing cyberdeck files were changed.

## Preserve before every later modification

Before any approved tablet modification, capture a redacted baseline of:

- Installed package versions and enabled state.
- IP Webcam settings and current health behavior.
- Tailscale connected state without addresses or keys.
- Fully Kiosk settings once installed.
- Current root CCTV script checksums and paths.
- Current HOME/launcher resolution.
- Battery, storage, and service state.
- A tested physical or ADB recovery path.

Never overwrite the existing root CCTV scripts without copying a rollback version outside the active service directory and demonstrating the rollback on-device.

## Planned rollback by change type

| Change                                    | Rollback requirement                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Controller web/API local code             | Revert local Git commit or stop local process; no tablet impact.                                          |
| Fully Kiosk install/configuration         | Disable kiosk restrictions first, restore previous launcher/dashboard, retain an emergency exit method.   |
| Companion install                         | Stop/uninstall only with approval after proving the existing camera automation still works.               |
| IP Webcam authentication/network settings | Record prior settings, prove local recovery access, then retest LAN/Tailscale behavior.                   |
| Display integration                       | Restore dashboard URL and remove temporary content.                                                       |
| Root recovery action                      | Keep a fixed tested reverse action where possible; never batch restart/reboot.                            |
| Boot/watchdog integration                 | Restore the preserved original scripts, reboot only if separately approved, and confirm IP Webcam health. |
| VPS deployment                            | Stop containers/reverse proxy, remove only controller-specific configuration, and retain data backup.     |

## Recovery principle

Prefer the smallest reversible action: restore dashboard before restarting Fully, restart one failed app before considering any device reboot, and never use a factory reset, boot image, partition, or SELinux change for this project.

## Final-system-repair Windows runtime rollback

Before changing an ignored controller environment file, create a timestamped copy under the ignored `.local/backups/` directory and record only its existence and timestamp. Controller runtime changes in this repair are limited to non-secret bind/exposure variables and the localhost process lifecycle. Roll back by stopping the controller, restoring that exact local environment backup, and restarting it through the controller script. Tailscale Serve changes, if later applied, are separately reversible with the installed Tailscale CLI and must never use Funnel.
