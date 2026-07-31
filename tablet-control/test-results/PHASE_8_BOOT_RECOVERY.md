# Phase 8 â€” Boot Recovery

Date: 2026-07-25  
Status: **COMPLETE â€” real reboot validated**

## Pre-reboot checklist

| Check                                | Result                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| ADB connected                        | HNP06KSC device                                                                       |
| `scripts/adb-reconnect.ps1` present  | âœ“                                                                                   |
| Fully exit PIN documented            | <FULLY_EXIT_PIN> (stored in .env.local as FULLY_EXIT_PIN) (env TABLET_FULLY_EXIT_PIN) |
| Fully uninstall command              | `adb uninstall de.ozerov.fully`                                                       |
| Companion disable command            | `adb shell pm disable com.tabletcontrol.companion/.BootReceiver`                      |
| Companion uninstall command          | `adb uninstall com.tabletcontrol.companion`                                           |
| CCTV script hashes                   | camera.sh=49e5de, watchdog.sh=fc4977, common.sh=183c9b                                |
| No Device Owner                      | confirmed (dpm returned nothing)                                                      |
| Launcher3 enabled                    | com.android.launcher3 enabled                                                         |
| No reboot loop in watchdog           | only cctv-install.sh references reboot (not running watchdog)                         |
| SELinux                              | Enforcing (unchanged)                                                                 |
| IP Webcam watchdog ownership         | existing shell automation (21-cctv-watchdog.sh)                                       |
| Companion does not restart IP Webcam | confirmed â€” separate services                                                       |
| Rollback commands documented         | above                                                                                 |

## Pre-reboot baseline (2026-07-25 10:08:52)

| Service             | State                                                           |
| ------------------- | --------------------------------------------------------------- |
| IP Webcam           | PID 18712, port 8080 wildcard, auth=401                         |
| Companion           | healthy, battery=100%, brightness=102, volume=5, uptime=116767s |
| Fully               | installed (de.ozerov.fully), activity running                   |
| Tailscale           | running PID 2253, tun0 IP=100.127.196.63                        |
| Watchdog last cycle | 10:08:23 HEALTH CHECK COMPLETED (healthy)                       |
| Git                 | clean (untracked build artifacts only)                          |

## Reboot

Normal reboot issued via `adb reboot` at **10:11:20**.

## Boot timeline

| Event                              | Time     | Elapsed                  |
| ---------------------------------- | -------- | ------------------------ |
| Reboot command sent                | 10:11:20 | 0s                       |
| Device offline                     | 10:11:42 | +22s                     |
| ADB returned (`wait-for-device`)   | 10:12:48 | +88s                     |
| `adb-reconnect.ps1` run            | 10:12:58 | +98s                     |
| `sys.boot_completed=1`             | 10:13:10 | +110s                    |
| Root available (`su -c id`)        | 10:13:21 | +121s                    |
| Tailscale tun0 up (100.127.196.63) | 10:13:21 | +121s                    |
| Companion alive (via BootReceiver) | 10:13:21 | +121s                    |
| Fully alive                        | 10:13:21 | +121s                    |
| IP Webcam port 8080 listening      | 10:13:44 | +144s                    |
| IP Webcam auth-required confirmed  | 10:14:01 | +161s                    |
| Companion health confirmed         | 10:14:01 | +161s                    |
| Fully Remote Admin available       | 10:15:30 | +250s (after `am start`) |

**Note:** Fully Remote Admin (port 2323) only starts after the main `FullyActivity` is launched. In normal kiosk operation this happens automatically when the screen wakes and Fully displays its dashboard. For automated post-reboot testing, `am start -n de.ozerov.fully/.FullyActivity` triggers initialization.

## Post-reboot functional checks

| Check                          | Result                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| Companion telemetry            | battery=100%, brightness=102 (baseline), volume=5 (baseline), uptime=312s |
| IP Webcam auth                 | 401 UNAUTHORIZED âœ“                                                      |
| Fully Remote Admin             | 200 OK, battery=100%                                                      |
| Display showToast              | OK                                                                        |
| Fully loadStartURL             | OK                                                                        |
| Brightness 102â†’150â†’102     | read-back confirmed, restored                                             |
| Volume 5â†’8â†’5               | read-back confirmed, restored                                             |
| PTT audio/startâ†’frameâ†’stop | all 200 OK                                                                |

## Watchdog cycles

3 complete authenticated watchdog cycles observed after reboot.

| Cycle | Time     | Status                           | PID  | Temp |
| ----- | -------- | -------------------------------- | ---- | ---- |
| 1     | 10:17:30 | HEALTH CHECK COMPLETED (healthy) | 4073 | 340  |
| 2     | 10:22:30 | HEALTH CHECK COMPLETED (healthy) | 4073 | 340  |
| 3     | 10:27:31 | HEALTH CHECK COMPLETED (healthy) | 4073 | 340  |

No false recovery. No shell error. No listener loss. No unexpected IP Webcam restart. No competing recovery ownership. Companion and Fully remain healthy throughout.

## BootReceiver validation

- **Synthetic test (Phase 7+8 commit):** `am broadcast -a BOOT_COMPLETED -n .BootReceiver` via root â†’ Companion healthy in 4s
- **Real reboot:** Companion appeared at `boot_completed+11s` without any manual intervention

## Rollback commands

| Action               | Command                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Disable BootReceiver | `adb shell pm disable com.tabletcontrol.companion/.BootReceiver` |
| Uninstall Companion  | `adb uninstall com.tabletcontrol.companion`                      |
| Uninstall Fully      | `adb uninstall de.ozerov.fully`                                  |
| Restore ADB forwards | `scripts\adb-reconnect.ps1`                                      |
| Fully exit           | enter PIN <FULLY_EXIT_PIN> in Fully UI                           |
| Emergency ADB        | `adb shell` (always available regardless of Fully state)         |
