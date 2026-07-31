# Frontend capability repair

Date: 2026-07-26

## Findings

- The production controller can reach the configured IP Webcam, Fully Kiosk, and Companion services. The earlier phone UI failures were not caused by an unavailable controller-to-tablet path.
- The web client had retained Phase 1 mock wording and fake healthy fallback values. A failed or stale initial request could therefore look like a working mock tablet or an unavailable Companion integration.
- The client expected an obsolete version-response shape and did not load the controller capability map. This made real controls appear misleadingly unavailable.
- Image/video upload is intentionally unsupported by the current controller; it is now visibly disabled rather than presented as a functional action.

## Repair

- Replaced optimistic fallback data with offline/not-reported state.
- Added authenticated capability loading and bound Talk, Display, and Device controls to the controller's real capability response.
- Removed mock/simulated wording from real control labels.
- Corrected version display and converted malformed controller responses into a typed, actionable error.
- Corrected the API error handler's strict TypeScript narrowing.

## Verification

- Strict TypeScript: passed.
- Automated tests: 56 passed.
- ESLint: passed.
- Production build: passed.
- Controller lifecycle self-test: passed after serving the rebuilt bundle.
- No tablet app, setting, media stream, credential, or network policy was changed during this repair.

## Phone follow-up

The installed PWA may still have an old JavaScript bundle. Use its **Clear App Cache & Reload** control once, sign in again, then test a single reversible action such as brightness or volume. If it still fails, capture the exact on-screen error and tab name; the controller now returns typed failures instead of a false mock state.
