# Rooted tablet service diagnosis and repair

Date: 2026-07-26

## ADB read-only findings

- ADB and root access were available.
- IP Webcam, Fully Kiosk, Companion, and Tailscale processes were present.
- IP Webcam WebServer and Companion foreground services were active; Fully foreground and Remote Admin services were present.
- TCP listeners for the expected IP Webcam, Fully Remote Admin, and Companion ports were present.
- An unauthenticated tablet-local IP Webcam probe returned the expected authentication challenge, while the controller’s authenticated status probe succeeded. This is authentication behavior, not a stopped server.
- Fully Remote Admin and the Companion health handler responded locally.

## Controller and private-network findings

- The localhost controller reports healthy real IP Webcam, Fully, and Companion adapters.
- Tailscale Serve is configured as a tailnet-only reverse proxy to the localhost controller; no Funnel handler was found.
- The tablet successfully reached the private HTTPS controller health endpoint.

## Repair applied

- Added a typed, authenticated controller route for setting Fully’s persistent dashboard Start URL.
- Updated Fully’s Start URL to the private Tailscale HTTPS controller address and reloaded the Start URL.
- The URL and all credentials were handled locally only and are not recorded here.

## Remaining validation

Phone-browser validation is still required: open the private HTTPS dashboard while the phone’s Tailscale connection is active, sign in, and confirm the LIVE, DISPLAY, and DEVICE tabs. The Windows logon task remains separately blocked by local Task Scheduler permission denial.
