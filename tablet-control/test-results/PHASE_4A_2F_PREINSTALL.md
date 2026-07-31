# Phase 4A.2f — pre-install checkpoint

Date: 2026-07-24

## Scope and current baseline

- No tablet file was changed.
- Authentication mode is `disabled`; the root-only curl-auth file is empty.
- IP Webcam PID `10838` was present; `.WebServer` was foreground, TCP 8080 was listening, and a bounded root request returned HTTP 200.
- The caller is `/data/local/tmp/cctv-health-check-fixed.sh`, not a symlink, with SHA-256 `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`, owner/group `shell:shell`, mode `0755`, and context `u:object_r:shell_data_file:s0`.
- Shared helper SHA-256: `b5c2516b50b6045331f216a1ff8400685adcda2157506ac2c349ad18f33404d9` (unchanged).
- Startup-script SHA-256 values: `20-cctv-camera.sh` `21915ef7dfa7651e28378b35a1ff5e3f5c1ca08f7bce85598bc5acc7dd70f6d7`; `21-cctv-watchdog.sh` `2b1d428bdce6aca78334be0e6310b4d23504f566f38bc532251b24616560e44d`; watchdog-daemon `eab9654028be8bec2fd4233f2be28acba6005329b9c49fecd04a126a30f1af8b`.

## Reproduced root cause

`start_ip_webcam` uses its normal POSIX return contract: `0` after successful bounded `.Rolling` recovery, `1` after failure/lock contention. The caller captures `$?` into `RESULT`, then runs the malformed literal condition `[ "$RESULT" -eq ]`. The missing right-hand numeric operand—not command output, substitution, scope, pipeline, unset-variable behavior, or logging—causes a successful `0` to follow the false branch and log `Recovery: FAILED`.

## Candidate and exact diff

Only the caller's result-classification block changes. The recovery function, its `.Rolling` launch action, timing, cooldowns, rate limits, startup scripts, and shared helper are unchanged.

| Item                 | Device-format SHA-256                                              |
| -------------------- | ------------------------------------------------------------------ |
| Live/original caller | `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484` |
| Proposed caller      | `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541` |

The candidate uses a POSIX `case` on `RESULT`: `0` logs `Recovery: SUCCESS`; numeric nonzero logs `Recovery: FAILED`; empty or malformed logs `Recovery: INVALID_RESULT`. The original local artifact matches the live caller after LF normalization and preservation of its no-final-newline shape. The reviewed patch is at `automation/phase4a2f/cctv-health-check-fixed.result-classification.patch`.

## Regression results

- Exact legacy empty-operand defect reproduced.
- Success, failure, empty, unset, whitespace-only, newline, carriage return, and nonnumeric results covered.
- Mixed recovery output and command-substitution semantics covered.
- The fixture proves classification makes no second recovery invocation.
- Fixture passed under local POSIX `sh` and tablet `/system/bin/sh`.
- Candidate passed `sh -n` under both shells.
- Controller API: 14 tests passed. Controller web: 2 tests passed.
- ESLint, Prettier check, strict TypeScript checks, and production builds passed.

## Proposed backup and rollback

On separate installation approval only, create `/data/local/tmp/cctv-backups/<timestamp>-phase4a2f/` as root-owned and non-executable, then copy only the caller into it. Verify the backup hash matches the live baseline before replacement. Preserve `shell:shell`, mode `0755`, context `u:object_r:shell_data_file:s0`, LF line endings, and no final newline.

If any installation verification fails, restore only the backed-up caller, reapply its original owner/mode/context, verify its original hash, confirm the IP Webcam PID/listener remain available, confirm no watchdog loop, leave the shared helper installed, and keep authentication disabled.
