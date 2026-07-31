# Architecture

## Chosen version-one topology

PHONE PWA
→ HTTPS / WebSocket over Tailscale
VPS CONTROLLER
→ controller web
→ Fastify API
→ authenticated session service
→ IP Webcam adapter
→ Fully Kiosk adapter
→ Companion adapter
→ optional media proxy
→ Tailscale
TABLET
→ IP Webcam
→ Fully Kiosk Browser when approved and installed
→ Companion Agent when built and approved
→ Tailscale

## Decisions reflected in the topology

1. Reuse IP Webcam for camera capture and listening audio. Its current service is healthy and its supported web interface exposes the relevant status, video, audio, zoom, focus, quality, and video-size integrations.
2. Use the VPS controller as the only browser-facing origin. The frontend never receives IP Webcam, Fully, or Companion credentials.
3. Start with the simplest route: proxy streams through the controller when real integration begins. Reassess direct phone-to-tablet media only after a measured latency and bandwidth test.
4. Keep Tailscale separate. It provides private connectivity and device identity; it is not embedded or modified.
5. Add a small native Companion Agent only for missing device status, speaker playback, carefully restricted recovery actions, and watchdog coordination.
6. Do not create a custom camera engine, custom VPN, Docker-on-tablet setup, WebRTC stack, or arbitrary remote shell.

## Backend boundaries

### Controller web

A React, TypeScript, Vite PWA presents LIVE, TALK, DISPLAY, and DEVICE views. It calls only the versioned controller API at the same HTTPS origin.

Phase 1 implements the four mobile-first screens with high-contrast, touch-safe controls, semantic tabs, pointer-based hold-to-talk interaction, accessible labels, focus styles, and an explicit mock-only status banner. The PWA does not request or render any real tablet media in this phase.

### Controller API

A TypeScript Fastify service owns authentication, CSRF protection, validation, rate limiting, adapters, audit records, temporary display content, and stream proxying. It returns typed success and error envelopes.

Phase 1 implements the session cookie, in-memory session store, constant-time local mock credential comparison, login rate limit, CSRF validation for mutations, typed error envelope, and a WebSocket talk lifecycle skeleton. Persistent admin accounts, Argon2id password hashes, audit storage, file persistence, and real stream proxying are deferred until their required deployment/security decisions are approved.

### Adapter layer

Adapters are the only code allowed to know component-specific URLs or commands.

- IpWebcamAdapter: status, streams, and only controls proven against the installed UI.
- FullyKioskAdapter: disabled until Fully is installed, licensed if required, and its remote API is verified.
- CompanionAdapter: status, PTT session, and safe controls through token-authenticated HTTPS/WebSocket requests.
- RootControlAdapter: internal to the Companion; accepts only fixed enum actions and never shell text.

### Tablet Companion Agent

A Kotlin Android application with a foreground service. It exposes a minimal authenticated service bound only to the private network where technically safe. Its modules are Talkback, DeviceStatus, AppControl, RootControl, Watchdog coordination, authentication, and boot recovery.

## Media design

- Video: IP Webcam stream proxied through the API for the first working release.
- Listening audio: a selected IP Webcam audio stream proxied through the API after browser compatibility testing.
- Talkback: browser PTT WebSocket to the controller, then controller-to-Companion WebSocket. Version one is half duplex.
- Display content: temporary backend-hosted pages/media, loaded by the Fully Kiosk adapter with an expiry and optional dashboard restoration.

## Existing automation integration

The active root CCTV scripts already own boot-time camera health recovery and can turn off the screen. Version-one Companion watchdog work must initially report health only. Any replacement or coordination change needs a separate approved design, manual test, rollback path, and bounded retry policy.

## Constraints

- Two cameras exist, but concurrent camera use is currently rejected by the camera service.
- The tablet has approximately 1.8 GiB RAM. Initial target is one stream at moderate resolution and 10–15 FPS.
- Neither camera reports flash hardware, so the UI must not advertise torch as actionable.
- Fully Kiosk is not installed; all display and kiosk features are pending installation/compatibility testing.
