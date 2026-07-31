# Phase 4A.1 installation and read-only verification

Date: 2026-07-24

## Result

The approved Phase 4A.1 tablet-side installation completed successfully. The shared CCTV helper was replaced in place with the reviewed auth-compatible helper, the auth-disabled state was preserved, and the live helper continued to report healthy watchdog cycles.

## Backup and replacement record

- Backup directory: `/data/local/tmp/cctv-backups/20260724-105534`
- Backup file: `/data/local/tmp/cctv-backups/20260724-105534/cctv-common-fixed.sh`
- Original helper SHA-256: `2e57677c915321a0b393e6dbddf3a3ab2035994e660be984a6fa381f1b00ce32`
- Backup SHA-256: `2e57677c915321a0b393e6dbddf3a3ab2035994e660be984a6fa381f1b00ce32`
- Live helper SHA-256 after replacement: `1ea1d134cd89e772feaea9f868b679505f334091a9484700b668161e6ce966fc`
- Live helper metadata after replacement: owner `shell`, group `shell`, mode `755`, SELinux `u:object_r:shell_data_file:s0`
- Backup directory metadata: owner `root`, group `root`, mode `700`, SELinux `u:object_r:shell_data_file:s0`

## Read-only verification

- `sh -n /data/local/tmp/cctv-common-fixed.sh` passed.
- Sourcing the helper in the shell exposed `full_health_check`, `check_http_response`, and `check_port` via `type`.
- `pidof com.pas.webcam` returned the running process id.
- TCP `8080` remained listening.
- `GET /` returned HTTP 200.
- `GET /status.json?show_avail=1` returned JSON.
- `/video` returned a multipart MJPEG chunk with `Content-Type: image/jpeg`.
- `/audio.wav` returned a WAV header beginning `RIFF ... WAVE`.
- The watchdog log showed healthy five-minute cycles at `10:37`, `10:42`, `10:47`, `10:52`, and `10:57` with no restart loop.
- No credential was stored or enabled.
- Temporary probe and staging files were cleaned up after verification.

## Notes

- Direct `sh -n` access to `/data/adb/service.d/*` from the tablet shell was blocked by the device's access policy, so the continuing watchdog log was used as the functional proof that the active caller path remained healthy.
- The helper update preserved the live file metadata by overwriting the existing file in place instead of replacing it with a fresh copy.
