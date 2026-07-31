# Phase 4A.2d helper-parser repair and watchdog verification

Date: 2026-07-24

## Scope

Authentication remained disabled. No credential was collected or stored, no IP Webcam setting changed, no service was restarted, and no media endpoint was requested.

## Root cause and minimal repair

Android's `/system/bin/sh` does not interpret the helper's unescaped `|` parameter-expansion pattern as the intended literal delimiter. A probe such as `200|1234` therefore left the parsed status empty and made a healthy root response appear unhealthy.

The reviewed repair in `automation/phase4a1/cctv-common-fixed-parser.patch` adds strict POSIX-safe parsing of the `HTTP_CODE|BYTE_COUNT` probe shape, uses escaped literal delimiters, and rejects malformed input. It also records a timeout after a valid HTTP response separately as `response-completion-timeout`; the watchdog's primary root endpoint must still complete normally and treats that state as unhealthy.

## Backup and installation

- Pre-install helper SHA-256: `1ea1d134cd89e772feaea9f868b679505f334091a9484700b668161e6ce966fc`.
- Post-install helper SHA-256: `b5c2516b50b6045331f216a1ff8400685adcda2157506ac2c349ad18f33404d9`.
- Backup: `/data/local/tmp/cctv-backups/20260724-122008-phase4a2d/cctv-common-fixed.sh`.
- Backup SHA-256: `1ea1d134cd89e772feaea9f868b679505f334091a9484700b668161e6ce966fc`.
- Backup directory: `root:root`, mode `0700`; backup file: `root:root`, mode `0600`, SELinux `u:object_r:shell_data_file:s0`.
- Live helper metadata after installation: `shell:shell`, mode `0755`, SELinux `u:object_r:shell_data_file:s0`.

## Verification

- `sh -n` passed; the helper sourced successfully and exposed the parser and full-health functions.
- The live root probe parsed HTTP 200 with a valid byte count. Direct HTTP and full helper health checks returned healthy.
- IP Webcam remained present and TCP 8080 remained listening.
- The configuration directory remained `root:root` mode `0700`; disabled mode and the empty root-only curl configuration remained unchanged.
- Startup and watchdog caller hashes remained unchanged.
- The known status-endpoint connection-completion behavior was not used as a parser-phase gate, and no video or audio request was made.

## Watchdog evidence

Three consecutive post-install cycles completed healthy, with no recovery event after installation, no IP Webcam PID change, and TCP 8080 still listening:

- `2026-07-24 12:23:22`
- `2026-07-24 12:28:23`
- `2026-07-24 12:33:23`

## Local verification

- Parser regression model: 24 tests passed.
- Full workspace tests, lint, formatting, strict typecheck, and production build passed.
