# Operations

## Current approved operating state

Phase 0 did not change the tablet. IP Webcam and Tailscale are running under the existing setup; root CCTV boot/watchdog automation remains authoritative.

Do not use this repository to restart applications, change tablet settings, install APKs, modify root scripts, turn off the screen, change networking, or deploy a VPS until the relevant approval is obtained.

## Development environment

- Use the tablet-control repository as the new controller project.
- Node.js and npm are available for the future web/API work.
- The Android SDK and ADB are installed locally but environment variables are not configured.
- Install/configure a JDK only after approval, before beginning the Kotlin Companion build.
- Keep real configuration outside Git. Copy .env.example only to a locally ignored .env file.

## Phase 1 local operation

Run npm run dev from the repository root. This first builds local shared contracts, then starts the API on loopback port 3000 and the Vite PWA on loopback port 5173. The PWA proxies only its local API path to the local API service.

The sign-in account is intentionally a local mock placeholder defined in source for this phase. It does not authorize a tablet command, does not represent a deployable password design, and must be replaced by the planned hashed account configuration before deployment.

Run npm test, npm run lint, npm run typecheck, npm run format:check, and npm run build before any review. These commands are local-only and do not contact the tablet.

## Observability design

The future controller should expose:

- Controller health endpoint.
- Per-adapter reachability, latency, and last successful probe time.
- Redacted event log for control actions.
- Explicit degraded/offline/unsupported state in the UI.
- No raw media, secrets, or network identity in logs.

## Routine checks after implementation

1. Verify controller health and an authenticated session.
2. Verify tablet health aggregation.
3. Confirm only expected private network paths are available.
4. Review bounded watchdog activity and last failure reason.
5. Confirm temporary display content has expired/deleted.
6. Review storage, thermal, camera, and Tailscale status.

## Incident guidance

- If IP Webcam is not healthy, do not issue a restart until its current root automation and logs are reviewed.
- If remote access is lost after a future kiosk change, use the documented physical/emergency recovery route before changing root automation.
- If Tailscale fails, avoid network-policy changes or automatic reboot loops; collect redacted diagnostics first.
- If display content is stuck, use the dashboard restore path only after Fully integration is tested.

## Phase 2 read-only operation

- Keep `TABLET_ADAPTER_MODE=mock` as the normal development default. Do not add real private values to `.env.example`, source, test fixtures, Git, or logs.
- To run the approved read-only integration locally, provide the private IP Webcam base URL only through an ignored process environment or ignored `.env`, set `TABLET_ADAPTER_MODE=real-readonly`, and select `TABLET_TRANSPORT=trusted-lan` or `tailscale` truthfully. Startup rejects a missing or invalid configuration.
- The API binds only to `127.0.0.1` or `localhost`; any other `CONTROLLER_BIND_HOST` is rejected. The Vite development proxy targets this local API only.
- Use `npm run test:readonly-live --workspace @tablet-control/controller-api` for the adapter-level, non-persisting status/video/audio probe and `npm run test:readonly-proxy --workspace @tablet-control/controller-api` for the localhost proxy path. Both cancel streams after the first chunk and send no tablet control command.
- Do not use these commands to expose a stream, leave a stream playing, or infer a Tailscale result without a configured Tailscale endpoint. If either check fails, collect only its redacted error code and stop; do not restart or reconfigure IP Webcam or Tailscale.

## Phase 3A temporary LAN validation

Use `scripts/start-phase3a-lan-validation.ps1` only for a user-attended validation. It prompts locally for a 20-character-or-longer temporary controller password, generates a session secret in memory, derives the existing private IP Webcam address through read-only ADB, and accepts only the provided phone IP. It builds the PWA, serves it from the same temporary controller origin, and must be stopped with Ctrl+C immediately after the validation.

If the phone cannot reach the controller, do not add firewall rules, router rules, VPN routes, or bind to a wildcard interface. Stop and report the failure. A normal controller start remains loopback-only. The script's `LAN_VALIDATION_REMOVED` message confirms its environment cleanup, not a modification to the tablet.

## Phase 3B authentication remediation procedure (deferred)

Do not treat IP Webcam as authenticated until the tablet is normally unlocked and the built-in Login/password setting can be observed, changed, and tested through its supported UI. Before retrying: re-check ADB/root recovery, capture a redacted preference metadata/hash record, and inspect the unmodified boot/watchdog health behavior. Use a strong unique credential only in ignored local process or `.env` configuration; never place it in a URL, source, documentation, fixture, log, screenshot, or Git.

The rollback path is to return to the same built-in Login/password screen, disable authentication or clear the credential, then re-check the original unauthenticated status behavior. Do not directly edit app preferences or substitute firewall, root-network, Tailscale-policy, or package-level workarounds. After enabling, prove unauthenticated status/video/audio requests are rejected and authenticated requests work before relying on the controller.

## Phase 4A.2a configuration persistence check

Before any future IP Webcam credential activation, confirm that `/data/adb/cctv/`, `ipwebcam-health.mode`, and `ipwebcam-auth.curl` still exist with their approved ownership and modes. Treat a missing path as an investigation and approval gate: do not recreate it repeatedly or enter credentials until mounts, relevant startup scripts, and recent watchdog evidence have been checked. Repeat this check after an app update or observed reboot; no reboot is required solely to test persistence.

## Phone interaction controls

- Open DEVICE → Open an app to launch an approved installed application. The list is generated by Companion; arbitrary package names are never accepted.
- Use Restore dashboard to leave a launched app. The rooted fallback is a fixed command targeting only the Wall Tablet kiosk activity.
- Use DISPLAY → Animated message for temporary typewriter text. Use Live text for debounced, persistent centered text, then Clear live text when finished.
- Hold the TALK control continuously while speaking. Releasing, cancelling, or leaving the control closes the microphone tracks, audio context, WebSocket, and tablet AudioTrack.
- After a controller update, use the existing in-app cache reload once if the installed PWA still shows the previous bundle.
