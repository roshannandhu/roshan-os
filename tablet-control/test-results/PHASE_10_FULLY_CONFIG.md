# Phase 10 â€” Fully Kiosk Configuration (C2)

Date: 2026-07-25  
Status: **COMPLETE â€” minimal kiosk settings applied; all recovery paths verified**

---

## Pre-change state

See `test-results/PHASE_10_RECOVERY_CHECKPOINT.md` for full baseline.

Key pre-change values:

| Key                           | Before        | After                       |
| ----------------------------- | ------------- | --------------------------- |
| `startURL` / `pref_start_url` | `about:blank` | `http://192.168.1.11:3001/` |
| `launchOnBoot`                | `false`       | `true`                      |

All other settings unchanged from pre-C2 baseline.

---

## Changes applied

### Method

Settings changed via Fully Remote Admin API (`setStringSetting`, `setBooleanSetting` commands).  
Password sourced from `.env.local` `TABLET_FULLY_ADMIN_PASSWORD` â€” never logged.

### Commands issued

```
cmd=setStringSetting&key=startURL&value=http://192.168.1.11:3001/    â†’ OK
cmd=setStringSetting&key=pref_start_url&value=http://192.168.1.11:3001/ â†’ OK
cmd=setBooleanSetting&key=launchOnBoot&value=true                    â†’ OK
cmd=loadStartURL                                                      â†’ OK
```

### Verification from prefs file

```
<string name="startURL">http://192.168.1.11:3001/</string>
<string name="pref_start_url">http://192.168.1.11:3001/</string>
<boolean name="launchOnBoot" value="true" />
```

### Controller reachability from tablet

```
GET http://192.168.1.11:3001/api/v1/health  (from tablet at 192.168.1.5)
â†’ 200 OK
{"ok":true,"data":{"mode":"real-readonly","controller":"healthy",
  "adapters":{"ipWebcam":"healthy","fullyKiosk":"configured","companion":"configured"}}}
```

### loadStartURL response

```
cmd=loadStartURL â†’ {"status":"OK"}
```

Fully navigated to `http://192.168.1.11:3001/` while controller was running.

---

## Post-change verification

| Check                          | Result                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| Remote Admin still works       | âœ“ â€” `getDeviceInfo` and `loadStartURL` return OK             |
| Watchdog healthy after changes | âœ“ â€” 11:47:39 and 11:52:40 cycles both HEALTH CHECK COMPLETED |
| No false recovery              | âœ“ â€” IP Webcam PID 4073 unchanged                             |
| Exit PIN <FULLY_EXIT_PIN>      | âœ“ â€” `pref_exit_pin=<FULLY_EXIT_PIN>` confirmed in prefs      |
| Kiosk mode still disabled      | âœ“ â€” `kioskMode=false`, `pref_kiosk=false`                    |
| No lockout                     | âœ“ â€” ADB, launcher3, Settings all accessible                  |

---

## Settings not changed (and reason)

| Setting                   | Current value | Decision                                                            |
| ------------------------- | ------------- | ------------------------------------------------------------------- |
| `kioskMode`               | false         | Not activating â€” requires Device Owner or blocks ADB              |
| `forceScreenOrientation`  | 0 (auto)      | Auto works correctly; wall mount can use portrait auto              |
| `forceImmersive`          | false         | Full-screen via `pref_fullscreen=true` is sufficient                |
| `advancedKioskProtection` | true          | Already enabled pre-project; preserves basic kiosk UI               |
| `disableHomeButton`       | true          | Already enabled pre-project                                         |
| `disableVolumeButtons`    | true          | Already enabled pre-project                                         |
| `removeStatusBar`         | false         | Not required; status bar already hidden via `disableStatusBar=true` |
| `removeNavigationBar`     | false         | Not required for free version                                       |
| Cloud/MQTT/Webhook        | all disabled  | Not enabling remote cloud features                                  |
| `singleAppMode`           | false         | Not enabling â€” blocks exit and ADB may be affected                |

---

## Dashboard URL dependency

The dashboard URL `http://192.168.1.11:3001/` requires the controller to be running.

- If the controller is **not running** when Fully loads the start URL, Fully shows a network error page. This is expected.
- The controller can be started manually on the PC, after which `loadStartURL` restores the dashboard.
- When both the controller and tablet are on the same Wi-Fi, boot order should be: controller starts first, then tablet starts fully and loads the URL.

---

## Rollback

To revert to blank start URL:

```
cmd=setStringSetting&key=startURL&value=about:blank
cmd=setStringSetting&key=pref_start_url&value=about:blank
cmd=setBooleanSetting&key=launchOnBoot&value=false
```

Or: `adb uninstall de.ozerov.fully` then reinstall from backup APK.
