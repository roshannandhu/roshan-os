# Phase 4D — Camera Controls

Date: 2026-07-24

## Scope

Implemented bidirectional camera control over the IP Webcam API in real-readonly mode. Camera controls bypass the mode gate; display, device, and talkback controls remain blocked until Companion Agent is present.

## Verified API command contract

Discovered from ipwebcam.js (the app's own served JavaScript):

| Control           | Method | Path                              | Notes                                            |
| ----------------- | ------ | --------------------------------- | ------------------------------------------------ |
| Camera switch     | GET    | `/settings/ffc?set=on\|off`       | `off`=rear, `on`=front                           |
| Zoom              | POST   | `/ptz?zoom=INDEX`                 | index = round((percent−100)/3); 100%=0, 400%=100 |
| Quality           | POST   | `/settings/quality?set=VALUE`     | 1–100                                            |
| FPS               | POST   | `/settings/frame_duration?set=NS` | nanoseconds; 30fps=33333333, 15fps=66666666      |
| Resolution        | GET    | `/settings/video_size?set=VALUE`  | raw string e.g. `1920x1080`                      |
| Focus mode        | GET    | `/settings/focusmode?set=VALUE`   | see focus notes below                            |
| Autofocus trigger | POST   | `/focus`                          | no state change to poll                          |
| Snapshot          | GET    | `/shot.jpg`                       | returns image/jpeg; no recording started         |

## Focus mode hardware discovery

Front camera (`ffc=on`) and rear camera (`ffc=off`) have different available focus modes:

| Camera         | Available focusmodes                                             |
| -------------- | ---------------------------------------------------------------- |
| Front (ffc=on) | `off` only                                                       |
| Rear (ffc=off) | `off`, `auto`, `macro`, `continuous-video`, `continuous-picture` |

Schema `CameraFocusSchema.mode` covers both sets. The device silently ignores unsupported modes (no error returned).

## Changes made

**`packages/shared-types/src/index.ts`**

- `CameraStatusSchema.resolution`: `z.string().nullable()` (was enum of 2 values)
- `CameraStatusSchema.fps`: `z.number().int().positive().nullable()` (was literal 30)
- `CameraStatusSchema`: added `focusMode` field
- `CameraFocusSchema.mode`: corrected enum — removed `"infinity"`, added `"off"` and `"continuous-picture"`
- `CameraFpsSchema.fps`: added literal `30` to the union
- `CameraResolutionSchema.resolution`: `z.string()` (was enum of 2 values)

**`packages/integration-contracts/src/index.ts`**

- Added `getSnapshot(): Promise<Uint8Array>` and `triggerAutofocus(): Promise<AdapterActionResult>` to `IpWebcamAdapter`

**`apps/controller-api/src/adapters/readonly-ip-webcam.ts`**

- Changed `private` → `protected` on `config`, `fetchImplementation`, `getResponse()`, `readBoundedJson()`, `basicAuthHeader()` for subclass access
- `getStatus()` now parses real string format: zoom as percent string → 1.0–4.0 multiplier; frame_duration → fps; ffc → activeCamera; focusmode field added
- Added `getSnapshot()` (GET /shot.jpg, bounded read, 2 MiB limit)
- Added `triggerAutofocus()` → `blockMutation()`
- Added `readBoundedBytes()` helper

**`apps/controller-api/src/adapters/readwrite-ip-webcam.ts`** (new file)

- `ReadWriteIpWebcamAdapter extends ReadOnlyIpWebcamAdapter`
- Implements: `selectCamera`, `setZoom`, `setFocus`, `triggerAutofocus`, `setFps`, `setResolution`, `setQuality`
- Camera switch polls up to 3×1s for state confirmation; times out with 504 TIMEOUT if not confirmed
- GET-based controls use parent's `getResponse()`; POST-based controls use own `sendControlPost()`

**`apps/controller-api/src/adapters/index.ts`**

- Now exports `ReadWriteIpWebcamAdapter` for real-readonly mode

**`apps/controller-api/src/adapters/mock.ts`**

- Added `focusMode: null` to status; `setFocus()` persists mode; `getSnapshot()` throws 501 UNSUPPORTED; `triggerAutofocus()` returns simulated

**`apps/controller-api/src/routes.ts`**

- Added `authorizeCameraControl()`: session + CSRF only, no mode check
- Camera control routes (select, zoom, focus, fps, resolution, quality) use `authorizeCameraControl` instead of `authorizeMutation`
- Added `GET /api/v1/camera/snapshot` (no CSRF — GET; returns JPEG binary)
- Added `POST /api/v1/camera/autofocus`
- `POST /api/v1/camera/restart` unchanged — still `authorizeMutation` (blocked)

**`apps/controller-web/src/api.ts`**

- Added `setFocus(mode: string)`, `triggerAutofocus()`
- `setFps` accepts `10 | 15 | 30`; `setResolution` accepts `string`

**`apps/controller-web/src/components.tsx`**

- LivePanel: camera selector, zoom slider, quality slider, FPS select (10/15/30), resolution dropdown (9 options), focus mode select (5 options), autofocus button, snapshot button (window.open when real-readonly)
- Unified `cameraControls` JSX shared between readOnly and non-readOnly branches
- LIVE badge shows active camera name instead of "READ-ONLY"

**`apps/controller-web/src/App.tsx`**

- `runCameraAction()`: like `runAction` but skips readOnly guard
- All camera callbacks use `runCameraAction`
- Sign-in notice for real-readonly updated to reflect camera controls are active

## Test results

### Unit / integration tests

| Suite          | Passed | Total  |
| -------------- | ------ | ------ |
| controller-api | 29     | 29     |
| controller-web | 27     | 27     |
| **Total**      | **56** | **56** |

Key new tests in `readonly-integration.test.ts`:

- Forwards camera quality POST to real adapter when authorized → 200
- Rejects camera control without CSRF token → 403, no adapter request made
- ReadWriteIpWebcamAdapter sends camera controls to IP Webcam directly

TypeScript: clean across all three packages.

### ADB real-device validation (2026-07-24)

Device: Lenovo Tab M8 HD, HNP06KSC, IP Webcam 1.19.0.913, port 8080 via `adb forward tcp:8080 tcp:8080`.

Baseline before tests: `ffc=on zoom=100 quality=49 video_size=1600x1000 focusmode=auto frame_duration=33333333`

| Control            | Command sent                                       | Result                                   | Verified state                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| Quality            | POST /settings/quality?set=70                      | PASS                                     | quality=70 confirmed                 |
| Camera switch      | GET /settings/ffc?set=off                          | PASS                                     | ffc=off confirmed                    |
| Zoom               | POST /ptz?zoom=11 (≈1.33x)                         | PASS                                     | zoom=133 confirmed                   |
| Focus mode (rear)  | GET /settings/focusmode?set=continuous-video       | PASS                                     | focusmode=continuous-video confirmed |
| Focus mode (front) | GET /settings/focusmode?set=continuous-video       | Expected fail: front only supports "off" | focusmode=auto unchanged             |
| FPS                | POST /settings/frame_duration?set=66666666 (15fps) | PASS                                     | frame_duration=66666666 confirmed    |
| Resolution         | GET /settings/video_size?set=1280x720              | PASS                                     | video_size=1280x720 confirmed        |
| Autofocus          | POST /focus                                        | PASS                                     | 200 OK returned                      |

All commands restored. Final state matches spec baseline: `ffc=off zoom=100 quality=49 video_size=1920x1080 focusmode=continuous-video frame_duration=33333333`.

## Device baseline (post-validation)

| Setting        | Value             |
| -------------- | ----------------- |
| ffc            | off (rear camera) |
| zoom           | 100 (1.0x)        |
| quality        | 49                |
| video_size     | 1920x1080         |
| focusmode      | continuous-video  |
| frame_duration | 33333333 (30fps)  |
