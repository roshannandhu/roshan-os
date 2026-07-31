# Implementation Plan

No phase begins before the preceding phase has documented acceptance evidence.

## Phase 0 — completed: discovery and architecture

Delivered:

- Environment and ADB verification.
- Read-only root identity verification.
- Current state, inventory, feasibility, architecture, security, API, testing, operations, rollback, and decisions documents.
- IP Webcam UI and JavaScript inspection.
- Existing root CCTV boot/watchdog inspection.
- New Git repository without source implementation.

Acceptance evidence: documentation records only verified live state; no tablet configuration or service was modified.

## Phase 1 — controller skeleton — completed

Build locally only:

- TypeScript workspace with strict configuration.
- Shared types and integration contracts.
- Fastify API with mock adapters.
- React PWA four-tab UI.
- Login/session/CSRF skeleton.
- Health/status page and structured errors.
- Unit and integration tests using mock tablet services.

Acceptance criteria:

- Web/API build and tests run locally — passed.
- No real tablet endpoint or secret is needed — verified by mock-only adapters and no ADB/tablet calls.
- Camera, display, device, and talk actions return mocked/disabled states clearly — implemented.

Implementation evidence:

- 8 automated tests passed: 6 API/talk tests and 2 PWA interaction tests.
- ESLint, TypeScript checking, Prettier verification, and production PWA/API build passed.
- Git commits are separated into the Phase 0 discovery baseline and the Phase 1 implementation.

## Phase 2 — read-only real integration

After controller code review, connect only to read-only endpoints:

- IP Webcam status, video, and listening-audio proxy.
- Tailscale reachability reporting.
- Fully device info only after it is installed and explicitly approved.
- Companion health only after it exists.

Acceptance criteria:

- Time-bounded health reporting.
- Video and audio reconnect behavior demonstrated.
- No state-changing tablet action is called.

## Phase 3 — safe camera controls

After exact request values are discovered and user approval is obtained, implement camera select, zoom, focus, video size, quality, snapshot if verified, and FPS if verified.

Acceptance criteria:

- Each input is an allowlisted option.
- Current no-flash hardware returns an explicit unsupported torch result.
- Changes survive a simple reconnection test without exposing arbitrary URLs.

## Phase 4 — Fully Kiosk display integration

Install/test Fully Kiosk only with approval. Do not purchase or activate PLUS automatically.

Implement dashboard, message, image, video, webpage, black-screen page, and timed restore only for features the installed edition supports.

## Phase 5 — Companion status and safe device controls

Create and test the Kotlin Companion Agent after JDK/Android build prerequisites are available. Implement device status, brightness/volume where normal Android APIs allow, secure pairing, and health reporting.

## Phase 6 — push-to-talk

Implement half-duplex PTT, speaker playback, cancellation handling, timeout, incoming-listening mute, restore delay, and failure recovery.

## Phase 7 — root-backed recovery

Only after explicit approval and manual command-by-command testing, expose allowlisted IP Webcam/Fully/Tailscale restart, screen, and reboot actions. No generic shell channel is ever added.

## Phase 8 — watchdog and boot recovery

Coordinate with the existing root CCTV scripts. Preserve their current behavior until a tested replacement/integration plan and rollback are approved.

## Phase 9 — deployment and kiosk lockdown

After local review and explicit approval: deploy the VPS controller on the tailnet, install the Companion, configure Fully, test remote recovery, and then enable limited kiosk restrictions.

## Phase 10 — optional packaging

Evaluate Capacitor packaging only after the PWA works. Use it only if browser networking or background-audio constraints require native integration.

## Prerequisites and blockers

- A JDK is required before building the Kotlin Companion Agent. Java, javac, and Gradle are currently unavailable on PATH.
- Android SDK exists but ANDROID_HOME and ANDROID_SDK_ROOT are unset.
- Fully Kiosk is not installed and must not be installed without approval.
- The high-priority IP Webcam authentication/LAN exposure should be resolved before external controller deployment.
