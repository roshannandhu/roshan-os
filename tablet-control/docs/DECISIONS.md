# Decisions

## Decision: Create a separate tablet-control repository

Context:
The workspace already contains unrelated cyberdeck files and is not a Git repository.

Options:
Use the existing files as the project; initialize the workspace root; create an isolated project directory.

Chosen option:
Create tablet-control as its own Git repository.

Reason:
It preserves existing work, provides clear history, and follows the requested structure.

Risks:
The user must distinguish the new controller project from the existing cyberdeck dashboard.

Revisit when:
The user explicitly requests a monorepo migration.

## Decision: Reuse IP Webcam for version-one capture

Context:
IP Webcam is installed, running, and exposes a healthy local status/web interface.

Options:
Build a custom camera engine; use IP Webcam; install additional camera servers.

Chosen option:
Use IP Webcam.

Reason:
It already provides camera ownership, video/audio endpoints, and many control surfaces; a custom capture stack is unnecessary.

## Decision: Retain the installed official free IP Webcam build for Phase 4A.2e

The tablet currently runs the official free, ad-supported IP Webcam application (`com.pas.webcam`). Continue the approved authentication workflow against that installed build; do not install, migrate to, or evaluate IP Webcam Pro during this phase.

IP Webcam Pro uses a different package identity, so a migration would require a separately approved compatibility review and update plan for the existing CCTV automation before any installation or package change.

Risks:
Its current wildcard unauthenticated listener is a security concern, and some control values remain unverified.

Revisit when:
Controlled stability testing proves an unmet requirement.

## Decision: One active camera only

Context:
The camera service reports two cameras, but rejects a second concurrent open request while IP Webcam owns camera ID 1.

Options:
Attempt simultaneous streams; switch one camera at a time.

Chosen option:
One active camera at a time.

Reason:
It matches live hardware behavior and protects a low-memory tablet.

Risks:
Remote switch endpoint and restart requirements remain unknown.

Revisit when:
A controlled device test demonstrates stable simultaneous streaming.

## Decision: Do not implement torch

Context:
Both exposed cameras report no flash unit.

Options:
Show a generic torch control; hide it and return unsupported if requested.

Chosen option:
Do not present an actionable torch control.

Reason:
The hardware capability is absent.

Risks:
A vendor-specific capability could be missed, but the generic Android camera report is strong evidence.

Revisit when:
A manual camera test proves a usable light exists.

## Decision: VPS as the only browser-facing controller origin

Context:
The user wants one unified phone interface without spreading component credentials through the browser.

Options:
PWA calls tablet services directly; VPS gateway; hybrid direct media from day one.

Chosen option:
Authenticated VPS controller, initially proxying media when integrated.

Reason:
It centralizes authentication, avoids browser cross-origin/mixed-content problems, and keeps secrets server-side.

Risks:
Media proxying uses VPS bandwidth and can add latency.

Revisit when:
Measured latency/bandwidth makes direct Tailscale media worthwhile.

## Decision: Keep Tailscale separate

Context:
Tailscale is installed and provides a connected private VPN.

Options:
Embed/modify Tailscale; use it as an independent network layer.

Chosen option:
Use it unchanged as the private transport.

Reason:
It provides encryption, identity, NAT traversal, and device routing without custom VPN work.

Risks:
Tailscale status must be represented without exposing private network details.

Revisit when:
None for version one.

## Decision: Companion Agent has no arbitrary shell endpoint

Context:
Root is available, but a general remote shell would be dangerous.

Options:
Generic shell API; fixed allowlisted root actions; no root actions.

Chosen option:
Fixed, disabled-by-default enum actions with manual validation before exposure.

Reason:
It supports narrow recovery needs while preventing command injection and scope creep.

Risks:
Some recovery cases may require physical/ADB support until a fixed action is added.

Revisit when:
A new recovery action has a precise, tested, reversible contract.

## Decision: Preserve existing root CCTV automation during early phases

Context:
Two active root scripts already start/check IP Webcam and may turn off the screen.

Options:
Replace immediately; modify in place; preserve and observe.

Chosen option:
Preserve and observe.

Reason:
It is working production behavior with boot and screen implications. Changing it now would violate the no-modification scope.

Risks:
Future watchdog behavior needs coordination to avoid duplicate restart loops.

Revisit when:
A complete tested migration and rollback plan is approved.

## Decision: Use in-memory mock adapters for Phase 1

Context:
Phase 1 was approved only for local controller development, with no tablet modification or real control integration.

Options:
Call discovered tablet endpoints; create mock-only adapters; defer all API work.

Chosen option:
Create typed mock IP Webcam, Fully Kiosk, and Companion adapters backed by in-memory state.

Reason:
It validates the API, UI, authentication, and test structure without touching any tablet service or carrying real credentials.

Risks:
Mocks cannot prove real service compatibility, stream latency, or device behavior.

Revisit when:
Phase 2 read-only real integration is explicitly approved.

## Decision: Add a real IP Webcam adapter only as read-only mode

Context:
Phase 2 approved live status, video, microphone listening, latency, and reachability diagnostics, but prohibited all tablet state changes.

Options:
Keep mocks only; reuse generic IP Webcam controls; add a constrained read-only adapter behind the existing interface.

Chosen option:
Add `real-readonly` alongside `mock`, with a fail-closed configuration and a strict GET allowlist for status, video, and WAV audio.

Reason:
It exercises the existing service without changing camera state or copying private connection information into the client, source, or test evidence. Existing mock adapters remain the default for tests and offline development.

Risks:
The IP Webcam listener remains unauthenticated or unverified for authentication on a wildcard port. Browser audio playback remains subject to user-gesture, codec, background, and mobile-PWA limitations. Native Tailscale reachability has not yet been measured from this workstation.

Revisit when:
The user explicitly approves a separate phase for authentication/network remediation, browser-device validation, or any tablet controls.

## Decision: Fail closed for temporary phone validation

Context:
Phase 3A required a real phone/PWA test but prohibited public exposure, firewall changes, weak authentication, and any durable LAN-access change.

Chosen option:
Serve the production PWA from the Fastify controller only in an explicit `lan-validation` mode. Require a specific private bind IP, a specific private phone IP, real-readonly mode, built web assets, and strong temporary in-memory credentials.

Reason:
This creates the smallest practical browser-access path while retaining the normal loopback-only default. It also ensures all browser media requests remain same-origin controller requests rather than direct tablet URLs.

Revisit when:
A separately approved HTTPS/private-origin deployment design exists. Do not broaden the temporary LAN path for ordinary use.

## Decision: Defer IP Webcam authentication until its supported setting can be safely verified

Context:
Phase 3B approved built-in IP Webcam authentication remediation. Read-only inspection established that the installed build contains a Login/password feature and Basic/Digest authentication code, but the tablet was locked before the supported configuration fields and resulting challenge mechanism could be verified.

Options:
Bypass the lock or edit private preferences directly; call an undocumented settings endpoint; defer until the normal in-app setting is available.

Chosen option:
Defer. Preserve the existing application, preferences, boot/watchdog scripts, and network configuration unchanged.

Reason:
The first two options would bypass the requested safe built-in workflow and could create an unrecoverable authentication/automation mismatch. A precise setting, credential handling method, request scheme, authenticated-read test, unauthenticated-rejection test, and rollback path are required before enabling the high-impact change.

Revisit when:
The tablet can be normally unlocked for a user-attended, built-in Login/password configuration and verification session.
