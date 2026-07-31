# Phase 10 â€” Recovery Checkpoint (C1)

Date: 2026-07-25  
Status: **COMPLETE â€” all recovery paths verified before Fully configuration changes**

---

## Pre-change verification

All items below were confirmed before any Fully Kiosk setting changes.

### ADB and root recovery

| Check                               | Result                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| ADB device connected                | `HNP06KSC device` âœ“                                       |
| Root available                      | `uid=0(root) gid=0(root) context=u:r:magisk:s0` âœ“         |
| `scripts/adb-reconnect.ps1` present | âœ“                                                         |
| ADB forward for Fully (2323)        | `adb forward tcp:2323 tcp:2323` restores local Fully access |
| ADB forward for Companion (8765)    | `adb forward tcp:8765 tcp:8765`                             |
| ADB forward for IP Webcam (8080)    | `adb forward tcp:8080 tcp:8080`                             |

### Service health

| Service            | State                                         |
| ------------------ | --------------------------------------------- |
| Tailscale          | tun0 UP, 100.127.196.63/32 âœ“                |
| IP Webcam          | Port 8080 listening, auth=401 âœ“             |
| Companion          | HTTP 200 healthy âœ“                          |
| Fully Remote Admin | Port 2323 listening âœ“                       |
| Watchdog           | 5-min cycles healthy (PID 4073, 11:47:39) âœ“ |

### Package state

| Package                       | State                                                 |
| ----------------------------- | ----------------------------------------------------- |
| `de.ozerov.fully`             | installed, enabled âœ“                                |
| `com.tabletcontrol.companion` | installed, enabled âœ“                                |
| `com.android.launcher3`       | installed, enabled âœ“                                |
| Device Owner                  | NONE (dumpsys device_policy returned empty state) âœ“ |

### Rollback commands (exact, safe to run at any time)

```
# Stop Fully:
adb shell am force-stop de.ozerov.fully

# Restore Fully start URL to blank (rollback):
# (via Remote Admin API â€” password from .env.local TABLET_FULLY_ADMIN_PASSWORD)

# Uninstall Fully:
adb uninstall de.ozerov.fully

# Exit Fully kiosk:
# Enter PIN <FULLY_EXIT_PIN> in Fully UI (pref_exit_pin=<FULLY_EXIT_PIN> confirmed in prefs)

# Disable Companion auto-start:
adb shell pm disable com.tabletcontrol.companion/.BootReceiver

# Stop Companion:
adb shell am force-stop com.tabletcontrol.companion

# Uninstall Companion:
adb uninstall com.tabletcontrol.companion

# Restore ADB forwards after reboot:
scripts\adb-reconnect.ps1

# Kill any running controller:
# Stop-Process -Name node (on controller PC)
```

### Current Fully settings baseline (before C2 changes)

| Key                                    | Current Value                                   |
| -------------------------------------- | ----------------------------------------------- |
| `pref_start_url` / `startURL`          | `about:blank`                                   |
| `launchOnBoot`                         | `false`                                         |
| `pref_fullscreen`                      | `true`                                          |
| `keepScreenOn` / `pref_keep_screen_on` | `true`                                          |
| `remoteAdmin` / `pref_remote_admin`    | `true`                                          |
| `remoteAdminLan`                       | `true`                                          |
| `pref_remote_admin_port`               | `2323`                                          |
| `pref_exit_pin`                        | `<FULLY_EXIT_PIN>`                              |
| `kioskMode` / `pref_kiosk`             | `false`                                         |
| `disableHomeButton`                    | `true`                                          |
| `disableVolumeButtons`                 | `true`                                          |
| `disablePowerButton`                   | `true`                                          |
| `showStatusBar`                        | `false`                                         |
| `showActionBar`                        | `false`                                         |
| `showNavigationBar`                    | `false`                                         |
| `restartOnCrash`                       | `true`                                          |
| `forceScreenOrientation`               | `0` (auto)                                      |
| `lastVersionInfo`                      | `1.57.1`                                        |
| `advancedKioskProtection`              | `true`                                          |
| `mdmDisableADB`                        | `true` (no-op: no Device Owner, ADB unaffected) |

**Rollback values for C2 changes:**

| Key            | Rollback value |
| -------------- | -------------- |
| `startURL`     | `about:blank`  |
| `launchOnBoot` | `false`        |

### Fully version

`de.ozerov.fully` v1.57.1 (versionCode 101361, free version).

### Dashboard URL

Target controller dashboard: `http://192.168.1.11:3001/`  
Rollback: `about:blank`

### Recovery documentation reference

- `docs/ROLLBACK.md` â€” rollback principles
- `test-results/PHASE_8_BOOT_RECOVERY.md` â€” real reboot recovery validated
- `scripts/adb-reconnect.ps1` â€” ADB reconnect helper

### mdmDisableADB note

Fully prefs show `mdmDisableADB=true`. This setting is an MDM feature that requires Device Owner activation. No Device Owner is configured on this device. The setting is a no-op: ADB remains available and is confirmed working. This setting predates our project and was not modified.

### No lockout risk

- Exit PIN <FULLY_EXIT_PIN> confirmed in prefs.
- `kioskMode=false` â€” kiosk mode is not active.
- `pref_kiosk=false` â€” kiosk mode not active.
- Physical exit works: tap back or home, enter PIN <FULLY_EXIT_PIN>.
- ADB `am force-stop de.ozerov.fully` available at any time.
- Launcher3 remains enabled and accessible after Fully exit.
- Android Settings accessible after Fully exit.
