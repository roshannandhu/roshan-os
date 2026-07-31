# Phase 9 — Private Tailscale/LAN Deployment

Date: 2026-07-25  
Status: **COMPLETE — ADB-forward dependency removed; all services accessible directly via LAN**

---

## B1 — Service inventory

| Service            | Protocol | Tablet address        | Bind               | Auth                      |
| ------------------ | -------- | --------------------- | ------------------ | ------------------------- |
| IP Webcam          | HTTP     | 192.168.1.5:8080      | wildcard (0.0.0.0) | Basic (username+password) |
| Fully Remote Admin | HTTP     | 192.168.1.5:2323      | wildcard           | query-string password     |
| Companion          | HTTP     | 192.168.1.5:8765      | wildcard           | Bearer secret             |
| Tailscale          | VPN      | 100.127.196.63 (tun0) | tun0               | WireGuard                 |

Controller PC: 192.168.1.11 (Wi-Fi). No Tailscale installed on controller PC.  
All tablet services are wildcard-bound → reachable on both wlan0 (LAN) and tun0 (Tailscale).

---

## B2 — Direct reachability (no ADB forward)

Tested from 192.168.1.11 (controller PC):

| Service   | URL                     | Result                |
| --------- | ----------------------- | --------------------- |
| IP Webcam | http://192.168.1.5:8080 | 401 (auth required) ✓ |
| Fully     | http://192.168.1.5:2323 | 200 OK ✓              |
| Companion | http://192.168.1.5:8765 | 200 healthy ✓         |

ADB forwarding is NOT required for controller → tablet communication when on the same LAN.

---

## B3 — Config changes (no ADB forward required)

Added to `apps/controller-api/src/config.ts`:

- `TABLET_FULLY_BASE_URL` — if set, Fully uses this URL; else falls back to `http://127.0.0.1:{TABLET_FULLY_REMOTE_PORT}`
- `TABLET_COMPANION_BASE_URL` — if set, Companion uses this URL; else falls back to `http://127.0.0.1:{TABLET_COMPANION_PORT}`
- `parseServiceBaseUrl()` — validates HTTP URL, rejects credentials embedded in URL
- `isLoopbackBaseUrl()` — detects loopback addresses
- lan-validation mode now rejects loopback Fully/Companion base URLs (fail-closed)

Changed `FullyKioskConfig.port: number` → `FullyKioskConfig.baseUrl: string`  
Updated `ReadWriteFullyKioskAdapter` to use `baseUrl` instead of constructing localhost URL from port.

Added to `.env.local`:

```
TABLET_FULLY_BASE_URL=http://192.168.1.5:2323
TABLET_COMPANION_BASE_URL=http://192.168.1.5:8765
TABLET_IP_WEBCAM_BASE_URL=http://192.168.1.5:8080
CONTROLLER_ADMIN_PASSWORD=(generated, see .env.local)
CONTROLLER_SESSION_SECRET=(generated, see .env.local)
```

---

## B4 — Controller deployed on 192.168.1.11

Start script: `scripts/start-lan.ps1`

Config validated at startup:

```
CONTROLLER_BIND_HOST=192.168.1.11
CONTROLLER_PORT=3001 (adjustable)
CONTROLLER_EXPOSURE_MODE=lan-validation
CONTROLLER_SERVE_WEB=true
CONTROLLER_ALLOWED_CLIENT_IP=192.168.1.11 (or tablet IP for B6)
TABLET_ADAPTER_MODE=real-readonly
TABLET_TRANSPORT=trusted-lan
```

Health check result:

```
GET http://192.168.1.11:3001/api/v1/health
→ 200 OK
{
  "mode": "real-readonly",
  "controller": "healthy",
  "adapters": {
    "ipWebcam": "healthy",
    "fullyKiosk": "configured",
    "companion": "configured"
  }
}
```

**Limitation:** Controller PC has no Tailscale installed. Access requires same-LAN Wi-Fi. If Tailscale is installed on the controller PC in future, switch `TABLET_IP_WEBCAM_BASE_URL` etc. to `http://100.127.196.63:{port}`.

---

## B5 — Authentication verification

All auth controls confirmed implemented:

- Session cookies: HttpOnly, SameSite=Strict, signed with `CONTROLLER_SESSION_SECRET`
- CSRF: double-submit token required for all mutations
- Rate limiting: 10 req/min per IP via `@fastify/rate-limit`
- IP allowlist: only `CONTROLLER_ALLOWED_CLIENT_IP` and loopback can reach any route
- Unauthenticated mutation: `POST /api/v1/device/brightness` → `401 Unauthorized` ✓

---

## B6 — PWA verification (direct LAN)

PWA served at `http://192.168.1.11:3001/` when `CONTROLLER_SERVE_WEB=true`.  
Static files from `apps/controller-web/dist/` including `manifest.webmanifest` and service worker.  
To test: connect device on same Wi-Fi, set `CONTROLLER_ALLOWED_CLIENT_IP` to device IP, navigate to `http://192.168.1.11:3001/`.

**Note:** B6 requires physical device test. Set `CONTROLLER_ALLOWED_CLIENT_IP=192.168.1.5` to allow tablet's browser (Fully WebView or stock Android browser).

---

## B7 — Network interruption tests

| Test                          | Result                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| Companion direct LAN (no ADB) | `GET http://192.168.1.5:8765/api/v1/companion/status` → 200 OK ✓      |
| Controller backend restart    | Health returns `configured` after restart, no stale state ✓           |
| Baseline adapter state        | `ipWebcam=healthy`, `fullyKiosk=configured`, `companion=configured` ✓ |

WebSocket talk reconnect: handled in browser by `useAudioStream` hook (exponential backoff, 3 attempts). WiFi disconnect causes WebSocket close → `cleanupTalk()` fires → user must re-press PTT.

---

## B8 — Public exposure audit

| Check                                       | Result                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| `127.0.0.1:3001` reachable                  | NO — bound to 192.168.1.11 only ✓                        |
| Wildcard (0.0.0.0) binding                  | NO — `parseBindHost` rejects 0.0.0.0 unless private IP ✓ |
| Internet-routable IP binding                | Rejected by `isPrivateIpv4()` in lan-validation mode ✓   |
| Tablet services on internet                 | NO — all behind NAT router, no port forwarding ✓         |
| Tailscale exit node                         | NOT configured ✓                                         |
| Controller admin password exposed to client | NO — never sent in API responses ✓                       |
| Tablet service URLs in client JS            | NO — all backend-only env vars ✓                         |

---

## Test suite results

| Suite          | Passed | Total  |
| -------------- | ------ | ------ |
| controller-api | 29     | 29     |
| controller-web | 27     | 27     |
| **Total**      | **56** | **56** |

TypeScript: clean across all packages.

---

## Known limitations

1. **No Tailscale on controller PC**: must be on same Wi-Fi as tablet. Add Tailscale to PC and switch base URLs to `100.127.196.63` for remote access.
2. **Single allowed-client IP**: `CONTROLLER_ALLOWED_CLIENT_IP` accepts one IP. Multi-device or dynamic IP access requires code change.
3. **B6 physical test**: PWA service worker and camera stream not fully verified without an actual browser device connecting over LAN.
4. **ADB still used for build/deploy**: `adb install` needed to push Companion APK. ADB forwarding no longer needed for runtime operation.
