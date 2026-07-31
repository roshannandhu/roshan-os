# Phase 4A.1 pre-install authentication-compatible automation proposal

Date: 2026-07-24

## Files inspected

Active startup/watchdog files:

- `/data/adb/service.d/20-cctv-camera.sh`
- `/data/adb/service.d/21-cctv-watchdog.sh`
- `/data/local/tmp/cctv-common-fixed.sh`
- `/data/local/tmp/cctv-watchdog-daemon.sh`

All discovered callers of the common helper were inspected: the active boot script, watchdog daemon, status helper, fixed boot-script copy, and fixed health-check helper. The active boot and watchdog paths both load the common helper.

Current file metadata, ownership, permissions, SELinux context where available, and SHA-256 values were read-only captured. The same metadata and hashes will be captured again immediately before any write and stored in the tablet-side backup manifest.

## Current behavior reproduced

The installed helper's `check_http_response` treats both HTTP 200 and HTTP 401 as liveness-positive. That prevents an auth-required server from being mistaken for a dead server, but provides no diagnostic distinction between valid authentication, missing configuration, and invalid credentials.

## Available HTTP client capability

The tablet already has curl and toybox. Curl reports support for `--config`, `--anyauth`, and `--digest`; wget and busybox are absent. No additional binary is proposed.

## Proposed smallest change

Modify only `/data/local/tmp/cctv-common-fixed.sh`; do not change any caller, service.d script, timing, camera setting, or IP Webcam setting.

Add these root-owned files only after approval:

| Path                                  | Owner/mode       | Initial content | Purpose                                                                                                     |
| ------------------------------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `/data/adb/cctv/`                     | root:root `0700` | Directory       | Isolated security configuration directory; the existing `/data/local/tmp/cctv` directory is world-readable. |
| `/data/adb/cctv/ipwebcam-health.mode` | root:root `0600` | `disabled`      | Strict literal mode, read without shell evaluation.                                                         |
| `/data/adb/cctv/ipwebcam-auth.curl`   | root:root `0600` | Empty           | Prepared but not populated curl credential file.                                                            |

In disabled mode or when the mode file is absent, the helper keeps the current unauthenticated request behavior. In enabled mode, it uses curl `--config` with the root-only credential file and `--anyauth`; credentials never occur in an URL, query string, log, repository file, or process argument. The curl config is parsed by curl, not sourced by the shell. The mode file accepts exactly `disabled` or `enabled`; other content is classified invalid.

HTTP 401 is liveness-positive and classified separately as `auth-required-while-disabled`, `auth-config-missing-or-invalid`, or `auth-invalid`. It does not initiate a restart. HTTP timeout/partial response, TCP listener failure, or other HTTP failure remains liveness-negative and follows the existing three-per-30-minute rate limit.

## Exact diff and local tests

The exact helper diff is [cctv-common-fixed.patch](../automation/phase4a1/cctv-common-fixed.patch). The local model and tests are in the same directory. `npx vitest run automation/phase4a1/health-model.test.ts` passed with 8 tests.

## Proposed installation and rollback commands (not executed)

Before installation, create one timestamped backup outside active execution paths, verify its SHA-256 manifest, and preserve the original owner, mode, and SELinux context:

```sh
su -c 'set -eu; stamp=$(date +%Y%m%d-%H%M%S); backup=/data/adb/cctv-backups/$stamp; mkdir -p "$backup"; chmod 700 "$backup"; cp -p /data/local/tmp/cctv-common-fixed.sh "$backup/cctv-common-fixed.sh"; sha256sum /data/local/tmp/cctv-common-fixed.sh > "$backup/manifest.sha256"; stat -c "%a|%U|%G|%s" /data/local/tmp/cctv-common-fixed.sh > "$backup/metadata.txt"; ls -Zd /data/local/tmp/cctv-common-fixed.sh >> "$backup/metadata.txt"; sha256sum -c "$backup/manifest.sha256"'
```

After a reviewed, staged replacement, rollback is:

```sh
su -c 'set -eu; backup=/data/adb/cctv-backups/REVIEWED_TIMESTAMP; sha256sum -c "$backup/manifest.sha256"; cp -p "$backup/cctv-common-fixed.sh" /data/local/tmp/cctv-common-fixed.sh; chown shell:shell /data/local/tmp/cctv-common-fixed.sh; chmod 755 /data/local/tmp/cctv-common-fixed.sh; chcon u:object_r:shell_data_file:s0 /data/local/tmp/cctv-common-fixed.sh'
```

No duplicate executable service script is proposed. Authentication remains disabled, no real credential exists, and no tablet script has been modified.
