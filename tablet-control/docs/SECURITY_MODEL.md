# Security Model

## Security objectives

- Remote control is private to the authorized administrator.
- A browser never receives tablet component passwords or Companion tokens.
- The Companion can never become a general remote root shell.
- Camera and display services are not exposed publicly.
- Logs, reports, tests, and Git history contain no secrets or private addresses.

## Current exposure finding

IP Webcam currently listens on wildcard TCP 8080 and its local homepage returned HTTP 200 without a WWW-Authenticate challenge. This is a high-priority LAN exposure risk. Tailscale does not by itself stop another device on the same Wi-Fi network from reaching a wildcard listener.

Before any remote controller deployment, obtain approval to review and change the IP Webcam authentication/network configuration, then re-test from a non-authorized LAN client. No such change was made in Phase 0.

## Network boundaries

| Path                       | Required controls                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Phone → controller         | Tailscale reachability, HTTPS, authenticated secure cookie session, CSRF for state-changing browser requests. |
| Controller → IP Webcam     | Tailscale/private route only, server-side credential, timeout, allowlisted requests.                          |
| Controller → Fully         | Tailscale/private route only, server-side Remote Admin password, no credential in URL logs.                   |
| Controller → Companion     | Tailscale/private route only, Authorization header token, constant-time comparison, TLS where feasible.       |
| Internet → any tablet port | Denied. No public port forwarding, public firewall opening, or public reverse proxy for tablet services.      |

## Authentication and authorization

### Controller

- One administrator account in version one.
- Argon2id password hash.
- Secure, HttpOnly, SameSite session cookie.
- CSRF token/origin checking for each state-changing request.
- Login rate limiting and short session lifetime.
- Explicit logout and server-side session invalidation.

### Companion

Application launch is not a general Android intent or shell surface. The browser submits a typed app ID, the API validates it, and Companion resolves it against a compiled allowlist. Settings, Magisk, Tailscale, Termux, IP Webcam, Fully, Companion itself, package stores, launchers, and device-management tools are excluded.

Push-to-talk requires an authenticated session and an exact permitted WebSocket origin. The private reverse proxy is validated from its forwarded protocol/host, while cross-origin and missing production origins are rejected. No wildcard origin is used.

- Pair with a random high-entropy token created out of band.
- Use Authorization headers or a WebSocket handshake, never query strings.
- Compare tokens in constant time.
- Support a documented rotation procedure.
- Never log the token, audio content, or complete credential-bearing URLs.

## Command safety

Root-backed actions are represented internally as a fixed enum:

- REBOOT_DEVICE
- RESTART_IP_WEBCAM
- RESTART_FULLY_KIOSK
- RESTART_TAILSCALE
- SCREEN_ON
- SCREEN_OFF
- SET_BRIGHTNESS
- SET_MEDIA_VOLUME

Each action has a fixed implementation, numerical bounds, timeout, expected result, structured error, and audit event. The API contains no generic shell endpoint. User input is never concatenated into a shell command, package name, filename, or URL.

The reboot and restart actions remain disabled until explicit approval and manual, local validation.

## Upload and display safety

- Accept images and video only after MIME sniffing, extension validation, size limits, and safe generated names.
- Store uploads outside static source paths.
- Serve temporary display content through short-lived opaque identifiers.
- Delete expired content and record only minimal metadata.
- Restrict webpage display to HTTP/HTTPS URLs after parsing and SSRF policy validation.
- Never allow file paths, data URLs, local-network probes, or controller metadata endpoints through the webpage-display feature.

## Logging and reports

Permitted: timestamp, command category, target adapter, result, latency, and redacted error category.

Forbidden: passwords, session IDs, pairing tokens, Wi-Fi identifiers, MAC addresses, tablet serials, tailnet names, Tailscale addresses, complete credential-bearing URLs, raw audio, and private uploaded media.

## Kiosk limitation

Kiosk mode can deter casual use and accidental uninstall. It cannot make an Android device absolutely uninstall-proof against a person with root, recovery access, unlocked bootloader control, or physical ownership. Emergency access and rollback remain requirements.

## Phase 2 read-only enforcement

Phase 2 does not remediate the existing unauthenticated wildcard IP Webcam exposure. Its real adapter is a local development integration only: it accepts a private URL only from ignored environment variables, never writes the value to logs or Git, and binds the controller process to 127.0.0.1 or localhost. It must not be used to publish, forward, or proxy IP Webcam to a LAN or public interface.

- `TABLET_ADAPTER_MODE=real-readonly` requires `TABLET_IP_WEBCAM_BASE_URL`; an absent, malformed, credential-bearing, or non-HTTP(S) URL stops startup rather than falling back to mock success.
- The only real requests are allowlisted GETs to the documented status, video, and WAV-audio paths. Redirects are rejected, and adapter mutation methods throw `ACTION_REQUIRES_APPROVAL` without constructing a network request.
- Every real request has an abortable timeout. Stream cancellation aborts the upstream fetch when the local browser disconnects; browser retries are bounded to three attempts and never continue indefinitely.
- POST routes first require a local session and CSRF token, then are unconditionally blocked in real-readonly mode. A test uses a fixture server request counter to prove no upstream request is made.
- No raw audio/video, stream URL, tablet address, Tailscale address, credentials, or tokens are persisted in source, test results, or application logs.

## Phase 3A temporary LAN validation boundary

The temporary validation path is separate from normal operation. It permits LAN binding only when all of the following are true: `lan-validation` mode is selected, the bind address and approved phone address are private IPv4 values, built PWA serving is enabled, real-readonly mode is selected, and strong temporary controller/session secrets are supplied. Requests from all other remote client addresses receive `FORBIDDEN` before controller routes or static PWA assets are served.

The launch script keeps the IP Webcam address, temporary password, and generated session secret only in its process environment. It performs no firewall, router, tablet, or VPN change, and removes those values when it exits. LAN PWA installation may be unavailable because browser service workers normally require a secure context; no certificate or HTTPS workaround was introduced.

## Phase 3B authentication assessment and blocked remediation

The installed IP Webcam build includes a built-in Login/password feature and HTTP Basic/Digest authentication code paths, but authentication remains disabled/unverified. A redacted pre-change preference record was captured before any change. ADB and root recovery are available.

The tablet was locked during the assessment. The controller did not bypass the lock, alter private app preferences, invoke an undocumented settings endpoint, or create a credential. Therefore it did not claim an authentication scheme, send a credential-bearing request, or weaken the existing network boundary. Until the normal in-app setting can be configured and verified, wildcard port 8080 remains a high-priority trusted-LAN exposure risk.
