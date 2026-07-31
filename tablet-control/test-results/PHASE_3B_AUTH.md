# Phase 3B IP Webcam authentication remediation assessment

Date: 2026-07-24

## Scope and redaction

This is a read-only pre-change assessment. Tablet addresses, stream URLs, credentials, serials, private media, and private preference values are intentionally omitted. No media was recorded or stored.

## Preconditions and backup record

- ADB connectivity: verified.
- Root recovery (`su -c id`): verified.
- Installed IP Webcam version: `1.19.0.913 (multiarch)`.
- Relevant preference record: `IPWebcam.xml` was 1,231 bytes before the assessment; SHA-256 was `00cfda2debb41962ad0c12d61a28d8af137115a6d0278f6396aa5880b13d2166`.
- No preference values were copied into this repository. The observed preference keys contained no current authentication/login/password key.
- Existing CCTV boot/watchdog automation was inspected read-only and was not modified.

## Built-in capability finding

Read-only installed-app inspection found a built-in **Login/password** feature and HTTP Basic/Digest authentication implementation evidence. This establishes that the app has an authentication capability, but does not establish which scheme the currently installed configuration screen will enable.

## Result: remediation deferred without state change

The tablet was locked before the exact built-in setting, input fields, and resulting HTTP challenge could be safely verified. The assessment did not bypass the lock, write private preferences, call undocumented settings routes, generate a credential, or restart IP Webcam.

Therefore these required tests are intentionally **not claimed**:

- unauthenticated status/video/audio rejection;
- authenticated status/video/audio success;
- controller adapter authentication;
- startup/watchdog operation after authentication.

## Safe retry and rollback

Retry only with normal, user-authorized access to the in-app Login/password setting. Capture the same redacted baseline first; enable one strong unique credential via the supported UI; keep it only in ignored local configuration; then test rejected unauthenticated reads and successful authenticated reads without putting credentials in URLs.

If the feature affects existing startup/watchdog health behavior, return to that same built-in setting and disable authentication or clear the credential. Do not edit preferences directly or replace this remediation with firewall, root-network, VPN-policy, or package changes without separate approval.
