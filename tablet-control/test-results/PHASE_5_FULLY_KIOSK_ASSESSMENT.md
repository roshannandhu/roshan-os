# Phase 5 — Fully Kiosk Assessment

Date: 2026-07-24  
Status: **Assessment complete. Hard stop: installation requires approval.**

## Current device state

| Item                       | State                                 |
| -------------------------- | ------------------------------------- |
| `de.ozerov.fully`          | NOT installed                         |
| Google Play Store          | NOT present (LineageOS without GApps) |
| Sideload (unknown sources) | ENABLED (`install_non_market_apps=1`) |
| Device Owner               | NOT set (`provisioningState=0`)       |
| Free storage               | 22.4 GB                               |
| Foreground app             | FS Clock (`systems.sieber.fsclock`)   |

## Installation path

No Play Store is present. The only viable installation path is the official APK from the Fully Kiosk website (`fully-kiosk.com/download`), sideloaded via `adb install` or downloaded directly on-device.

This requires explicit approval per the "unofficial APK installs" hard stop.

## Remote Admin API (available in free version)

Fully Kiosk has a built-in HTTP Remote Admin server. All commands share one endpoint:

```
GET http://[device]:2323/?cmd=[command]&password=[password]
```

Port is configurable in settings (default 2323). Password is set in Fully's settings UI.

| FullyKioskAdapter method | Command                                               | Notes                                               |
| ------------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| `showMessage(text)`      | `showMessageOverlay&text=[text]`                      | Optional: `textSize`, `backgroundColor`, `duration` |
| `showWebpage(url)`       | `loadURL&url=[url]`                                   |                                                     |
| `showBlack()`            | `setScreenOn&on=false`                                | Turns off display                                   |
| `restoreDashboard()`     | `loadStartURL`                                        | Reloads configured start URL                        |
| `getDisplayMode()`       | No direct API                                         | State must be tracked on controller side            |
| (device info)            | `getDeviceInfo`                                       | JSON: battery, brightness, uptime, free space       |
| (brightness)             | `setStringSetting&key=screenBrightness&value=[0-255]` |                                                     |

`getDeviceInfo` returns fields useful for `TabletStatus`: battery level/charging, screen brightness, free storage, uptime. This partially overlaps with the Companion Agent's role.

## What PLUS features are required

| Feature                                        | Free | PLUS               |
| ---------------------------------------------- | ---- | ------------------ |
| Remote Admin (loadURL, overlay, screen on/off) | Yes  | Yes                |
| `getDeviceInfo` / `getBatteryInfo`             | Yes  | Yes                |
| Remote file manager / media push               | No   | Yes                |
| Screenshot capture                             | No   | Yes                |
| Device Owner / kiosk lockdown                  | No   | Yes (requires DPC) |
| Start URL + browser UI                         | Yes  | Yes                |

Our `FullyKioskAdapter` interface (`showMessage`, `showMedia`, `showWebpage`, `showBlack`, `restoreDashboard`) maps entirely to free-tier commands, **except `showMedia`** — displaying an image or video file by file name requires either a file push (PLUS) or a locally-reachable URL that Fully can load. This is a design constraint.

**`showMedia` options without PLUS:**

1. Controller serves the file as a local HTTP endpoint → Fully loads it as `loadURL` pointing to `http://127.0.0.1:[controller-port]/api/v1/media/[id]`
2. Re-define `showMedia` to accept a URL rather than a file name (aligns better with how Fully works)

## Integration plan (post-approval)

1. Install Fully Kiosk free APK via `adb install`
2. In Fully Settings UI: set start URL, enable Remote Admin, set Admin password (stored as `TABLET_FULLY_REMOTE_PASSWORD` in `.env.local`), set port 2323
3. `adb forward tcp:2323 tcp:2323` for local controller access
4. Write `ReadWriteFullyKioskAdapter` implementing `FullyKioskAdapter` — HTTP calls to `http://127.0.0.1:2323/`
5. Update `adapterMode` to add `real-fully` or extend `real-readonly` to include Fully adapter
6. Update routes so display endpoints route to real adapter when Fully is configured
7. Test all adapter methods; `showMedia` will use URL approach

## What remains blocked without Fully

Display tab routes (`/api/v1/display/*`) currently call `authorizeMutation` which blocks in `real-readonly` mode and routes to the mock adapter. The existing `MockFullyKioskAdapter` handles mock mode correctly.

Companion Agent is still not installed — device controls (brightness, volume) remain blocked. Fully's `getDeviceInfo` can provide battery and brightness read-only, which partially fills the gap.

## Hard stops not crossed

- No Fully PLUS purchase or activation
- No Device Owner provisioning
- No permanent kiosk lockdown
- No application data cleared
- No APK installed yet (requires approval)
