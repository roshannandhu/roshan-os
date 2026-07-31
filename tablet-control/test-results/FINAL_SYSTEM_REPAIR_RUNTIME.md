# Final system repair — controller runtime evidence

Date: 2026-07-26

## Live checks

- Controller listener: loopback only.
- Controller health: healthy; real `companion` mode; IP Webcam, Fully, and Companion configured and healthy.
- Camera status: healthy; rear camera selected; zoom, focus, frame rate, resolution, and quality fields present.
- Capability response: real camera stream/control, listening audio, push-to-talk, Fully message/webpage/black/restore, and Companion telemetry/brightness/volume/mute are available. Torch, arbitrary media upload, and screen control remain unavailable.
- Companion no-op verification: brightness and volume requests were sent using the current values. Both completed successfully and did not alter tablet state.

## Local verification

- `npm run typecheck`: passed.
- `npm run test`: passed (56 tests).
- `npm run lint`: passed.
- `npm run build`: passed, including PWA output.
- `npm run controller:self-test`: passed. It verified that a second start finds the existing healthy controller rather than starting a duplicate process.

## Startup-task result

The Windows Task Scheduler API rejected registration of the limited current-user logon task with `Access denied`. No task was created and no account password was stored. The controller remains manually restartable through the provided scripts; automatic post-logon launch requires one administrator-run registration attempt.

## Front-camera safety assessment

- Front selection and return to rear were both verified; the final active camera is rear.
- Front status advertised only `1920x1080` video size and did not advertise independent focus, frame-rate, zoom, or quality lists.
- A conservative attempted front profile confirmed only 1x zoom and focus-off. The requested 640x480, 15 FPS, and quality 50 values were silently ignored by IP Webcam, so they are not claimed as supported.
- Advanced front controls are now rejected with a typed unsupported response. Switching waits a bounded six seconds before a consecutive switch to allow IP Webcam to release the old camera. No image, audio, screenshot, or video was recorded or retained.
