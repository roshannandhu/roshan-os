# Phase 7 — Push-to-Talk WebSocket Bridge

Date: 2026-07-25  
Status: **COMPLETE — all layers validated**

## What was built

Full audio pipeline from browser microphone to tablet speaker via WebSocket:

```
Browser (ScriptProcessorNode, 16kHz Int16)
  → WebSocket /api/v1/talk (controller-api)
    → POST /api/v1/companion/audio/frame (Companion HTTP, binary body)
      → AudioTrack.write() (Android, 16kHz CHANNEL_OUT_MONO PCM_16BIT)
```

## Audio format

| Parameter   | Value                             |
| ----------- | --------------------------------- |
| Sample rate | 16000 Hz                          |
| Channels    | Mono                              |
| Encoding    | PCM 16-bit signed                 |
| Frame size  | 1024 samples = 2048 bytes = 64 ms |

## Companion audio endpoints (new)

| Endpoint                             | Auth   | Description                                         |
| ------------------------------------ | ------ | --------------------------------------------------- |
| `POST /api/v1/companion/audio/start` | Bearer | Creates and starts `AudioTrack` at 16kHz mono Int16 |
| `POST /api/v1/companion/audio/frame` | Bearer | Writes binary PCM body to `AudioTrack.write()`      |
| `POST /api/v1/companion/audio/stop`  | Bearer | Stops and releases `AudioTrack`                     |

## Controller changes

**`packages/integration-contracts/src/index.ts`**

- Added `sendAudioFrame(data: Uint8Array): Promise<void>` to `CompanionAdapter` interface

**`apps/controller-api/src/adapters/readwrite-companion.ts`**

- `beginTalk()` → `POST /api/v1/companion/audio/start`
- `endTalk()` → `POST /api/v1/companion/audio/stop`
- `sendAudioFrame(data)` → `POST /api/v1/companion/audio/frame` with `application/octet-stream` body

**`apps/controller-api/src/adapters/mock.ts`**

- Added no-op `sendAudioFrame()` to `MockCompanionAdapter`

**`apps/controller-api/src/routes.ts`**

- WebSocket gate changed: `adapterMode === "real-readonly"` → `companion === undefined`  
  (talk allowed when Companion is configured, regardless of adapter mode)
- Binary frames now forwarded to `services.adapters.companion.sendAudioFrame(rawMessage)` instead of dropped

**`apps/controller-web/src/api.ts`**

- Removed `beginMockTalk()` / `endMockTalk()` stubs

**`apps/controller-web/src/App.tsx`**

- Added `talkWsRef`, `talkStreamRef`, `talkCtxRef`, `talkProcessorRef` refs
- `startTalk()`: opens WebSocket, sends `talk-start`, on server ack opens mic via `getUserMedia`, converts Float32 → Int16 at 16kHz via `ScriptProcessorNode`, streams binary frames
- `stopTalk()`: stops mic/AudioContext, sends `talk-stop`, closes WebSocket
- `cleanupTalk()`: idempotent teardown, called on unmount and on WebSocket close
- Mode guard: mock mode uses immediate transmitting flip; companion mode uses real WebSocket

**`apps/tablet-agent/app/src/main/java/com/tabletcontrol/companion/SimpleHttpServer.kt`**

- Replaced `BufferedReader` with byte-by-byte HTTP header reader + bulk `InputStream.read()` for body
- `rawBody: ByteArray` correctly populated for binary `application/octet-stream` requests
- Previous char-based reading corrupted binary audio frames

## Companion validation on real device (HNP06KSC)

| Step                                  | Request                                   | Response                                               |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Start AudioTrack                      | `POST /api/v1/companion/audio/start`      | 200 OK — `"AudioTrack started at 16000Hz mono Int16."` |
| Send 16 × 2048-byte 440Hz sine frames | `POST /api/v1/companion/audio/frame` × 16 | 200 OK × 16, all frames written                        |
| Stop AudioTrack                       | `POST /api/v1/companion/audio/stop`       | 200 OK — `"AudioTrack stopped."`                       |

1-second 440Hz tone audible on tablet speaker during frame sequence.

## Phase 8 — Boot Recovery (also completed this session)

**`apps/tablet-agent/app/src/main/AndroidManifest.xml`**

- `BootReceiver` changed from `android:enabled="false"` → `android:enabled="true"`

**Validation:**

- `adb shell su -c 'am broadcast -a android.intent.action.BOOT_COMPLETED -n com.tabletcontrol.companion/.BootReceiver'`
- Result: `Broadcast completed: result=0`, Companion responded healthy 4s later

**`scripts/adb-reconnect.ps1`** — helper script to re-establish ADB port forwards after tablet reboot:

```
adb wait-for-device
adb forward tcp:8080 tcp:8080  # IP Webcam
adb forward tcp:2323 tcp:2323  # Fully Kiosk
adb forward tcp:8765 tcp:8765  # Companion
```

## Test results

| Suite          | Passed | Total  |
| -------------- | ------ | ------ |
| controller-api | 29     | 29     |
| controller-web | 27     | 27     |
| **Total**      | **56** | **56** |

TypeScript: clean across all packages (0 errors).

## Known limitations

- `ScriptProcessorNode` is deprecated in the Web Audio API; upgrade to `AudioWorklet` if CPU or latency becomes a concern (current 64ms frames at 16kHz are acceptable for PTT)
- ADB port forwards must be re-run after tablet reboot until Phase 9 (Tailscale). Use `scripts/adb-reconnect.ps1`.
- Half-duplex: not needed in current UI (Talk tab and Live tab are mutually exclusive; audio stream is unmounted when switching to Talk tab)
