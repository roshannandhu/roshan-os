# Phase 4A.2f installation and verification

Date: 2026-07-24

## Result

The approved Phase 4A.2f tablet-side installation completed successfully. The CCTV health-check caller was replaced with the reviewed result-classification candidate, all metadata was restored, isolated classification tests passed under the tablet's `/system/bin/sh`, and three consecutive healthy watchdog cycles were observed with no false recovery, no process restart, and no listener loss.

## Backup and replacement record

- Backup directory: `/data/local/tmp/cctv-backups/20260724-170905-phase4a2f`
- Backup file: `/data/local/tmp/cctv-backups/20260724-170905-phase4a2f/cctv-health-check-fixed.sh`
- Backup directory metadata: owner `root`, group `root`, mode `644` (non-executable)
- Pre-install caller SHA-256: `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`
- Backup SHA-256 (confirmed byte-identical): `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`
- Installed caller SHA-256: `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541`
- Installed caller metadata: owner `shell`, group `shell`, mode `0755`, SELinux `u:object_r:shell_data_file:s0`
- LF line endings and no-final-newline preserved.

## Pre-installation checks (all passed)

| Check                 | Expected                        | Result |
| --------------------- | ------------------------------- | ------ |
| Not a symlink         | regular file (`-rwxr-xr-x`)     | ✓      |
| Live caller SHA-256   | `ed725a85…ce7484`               | ✓      |
| Owner / group         | `shell:shell`                   | ✓      |
| Mode                  | `0755`                          | ✓      |
| SELinux context       | `u:object_r:shell_data_file:s0` | ✓      |
| Shared helper SHA-256 | `b5c2516b…404d9`                | ✓      |
| Authentication mode   | `disabled`                      | ✓      |
| Credential file       | 0 bytes (empty)                 | ✓      |

## Post-installation verification

- `sh -n /data/local/tmp/cctv-health-check-fixed.sh` passed.
- `/system/bin/sh -n /data/local/tmp/cctv-health-check-fixed.sh` passed.
- Shared helper SHA-256 after replacement: `b5c2516b50b6045331f216a1ff8400685adcda2157506ac2c349ad18f33404d9` (unchanged).

## Isolated classification tests (all passed under `/system/bin/sh`)

| Input                | Expected                   | Got                          |
| -------------------- | -------------------------- | ---------------------------- |
| `0`                  | `Recovery: SUCCESS`        | `Recovery: SUCCESS` ✓        |
| `""` (empty)         | `Recovery: INVALID_RESULT` | `Recovery: INVALID_RESULT` ✓ |
| `"   "` (whitespace) | `Recovery: INVALID_RESULT` | `Recovery: INVALID_RESULT` ✓ |
| `1` (nonzero)        | `Recovery: FAILED`         | `Recovery: FAILED` ✓         |
| `99` (nonzero)       | `Recovery: FAILED`         | `Recovery: FAILED` ✓         |
| `abc` (nonnumeric)   | `Recovery: INVALID_RESULT` | `Recovery: INVALID_RESULT` ✓ |
| `0abc` (mixed)       | `Recovery: INVALID_RESULT` | `Recovery: INVALID_RESULT` ✓ |

The test fixture invoked `start_ip_webcam` zero times; no real recovery was triggered.

## Three post-installation watchdog cycles

| #   | Timestamp                    | Outcome | Recovery invoked | IP Webcam PID | Port 8080 |
| --- | ---------------------------- | ------- | ---------------- | ------------- | --------- |
| 1   | 2026-07-24 17:14:47–17:14:48 | healthy | no               | 10838         | LISTEN    |
| 2   | 2026-07-24 17:19:48–17:19:48 | healthy | no               | 10838         | LISTEN    |
| 3   | 2026-07-24 17:24:49–17:24:49 | healthy | no               | 10838         | LISTEN    |

All success criteria met: three consecutive healthy cycles, no false recovery, no process restart (PID 10838 stable throughout), no listener loss, no restart loop, no empty-operand shell error, no caller regression.

## CI and build results

- Controller API: 14 tests passed (vitest).
- Controller Web: 2 tests passed (vitest).
- ESLint: passed (0 errors, 0 warnings).
- Prettier check: all files use Prettier code style.
- Strict TypeScript typecheck: passed for all workspaces.
- Production builds: passed (packages, controller-api, controller-web/Vite+PWA).
