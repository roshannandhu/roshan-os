# Phase 4A Credential Setup — Diagnosis and Repair

## Root Cause

`spawnSync(ADB, ['shell', 'su', '-c', cmd])` passes **four arguments** to ADB.
ADB joins them with spaces: `su -c <cmd>`. The device shell then tokenizes the
joined string at `&&`, so only the first clause (`test -d ...` or `dd if=...`)
runs as root; every subsequent clause runs as the unprivileged ADB shell user.

The manual PowerShell fixture passed **two arguments** to ADB: `shell` and the
entire `su -c '...'` string. ADB forwarded it verbatim; the device shell treated
the single-quoted compound command as one token, so every clause ran as root.

`cp` was an additional red herring: BusyBox `cp` unlinks the destination before
creating a new inode. The `u:r:magisk:s0` SELinux context lacks permission to
unlink or create files in `u:object_r:adb_data_file:s0` directories, so `cp`
always failed for a separate reason. The fix uses `dd` (in-place write, no
unlink/create) in every path.

## Fix

`buildAdbRootArgs(cmd)` returns `['shell', \`su -c '${cmd}'\`]`— the su
invocation is always **one argument** after`shell`. All root operations use
`adb(...buildAdbRootArgs(cmd))`.

`buildInstallCommand()` returns a single-quote-free POSIX compound command:

```
dd if=/data/local/tmp/ipwebcam-auth.curl.new of=/data/adb/cctv/ipwebcam-auth.curl conv=fsync 2>/dev/null
  && chown root:root /data/adb/cctv/ipwebcam-auth.curl
  && chmod 0600 /data/adb/cctv/ipwebcam-auth.curl
  && test -s /data/adb/cctv/ipwebcam-auth.curl
```

`buildTruncateCommand()` uses `dd if=/dev/null` for the same in-place reason.

## Non-Secret Fixture Test — 2026-07-24

Fixture content: `user = "fixture-test:FIXTURE_ONLY_NOT_A_CREDENTIAL"\n`

| Step                                                      | Result                       |
| --------------------------------------------------------- | ---------------------------- |
| Pre-state: credential file                                | 0 bytes, `root:root`, `0600` |
| Pre-state: auth mode                                      | `disabled`                   |
| adb push to `/data/local/tmp/ipwebcam-auth.curl.new`      | OK                           |
| `su -c 'dd ... && chown ... && chmod ... && test -s ...'` | OK (exit 0)                  |
| Size after install                                        | 52 bytes                     |
| Metadata after install                                    | `-rw------- 1 root root 52`  |
| `dd if=/dev/null` truncation                              | OK                           |
| Post-state: credential file                               | 0 bytes, `root:root`, `0600` |
| Post-state: auth mode                                     | `disabled`                   |
| IP Webcam HTTP after test                                 | `200`                        |
| Fixture content in terminal output                        | none                         |
| `.env.local`                                              | absent                       |

## Authentication Activation — 2026-07-24

Credentials generated (username `tablet-cam`, password auto-generated 32-char alphanumeric).
Injected into `IPWebcam.xml` via device-side shell script that reads from the protected curl
config file (`root:root 0600`) — credential values never appeared in ADB arguments or
terminal output. Shared-prefs patched via `awk` + `dd` (in-place, same inode), `chown 10191`
restores app ownership, `chmod 0660` restores app mode.

| Probe                                  | Result |
| -------------------------------------- | ------ |
| Unauthenticated `/`                    | 401    |
| Unauthenticated `/status.json`         | 401    |
| Unauthenticated `/video`               | 401    |
| Unauthenticated `/audio.wav`           | 401    |
| Authenticated `/` (curl -K config)     | 200    |
| Authenticated `/status.json` (curl -K) | 200    |

Health mode flipped to `enabled`. Watchdog runs authenticated probe (`curl --config
/data/adb/cctv/ipwebcam-auth.curl`). 3 manual health-check cycles: all `healthy`.
Watchdog remains at `enabled`.

## Reveal Utility Hardening — 2026-07-24

`.local/reveal-credentials.ps1` rewritten with:

- `-Field Username` / `-Field Password` mandatory parameter (one field at a time)
- `WDA_EXCLUDEFROMCAPTURE` (0x11) via `SetWindowDisplayAffinity` P/Invoke — excludes
  window from screenshots and screen-share on Windows 10 build 19041+; fails silently
- `Add_Deactivate` handler with 500 ms grace period — closes on focus loss
- Password masked with `● × 32` (fixed width); hold-to-reveal button reveals only
  while mouse button is held, masks on release or mouse-leave
- Credential references nulled at close; never printed to terminal

14 tests pass in `.local/test-reveal-credentials.ps1` covering PS 5.1 syntax, path
resolution, env-file parsing, WDA constant value, and security invariants.

## Unit Tests

36 tests pass in `.local/test-tablet-write.mjs` covering:

- Password generation (length, charset, uniqueness)
- Curl config format
- Install command structure (dd, conv=fsync, chown, chmod, test -s, no single quotes,
  device paths are fixed constants, no credential interpolation)
- Truncate command structure (dd if=/dev/null, no single quotes)
- `buildAdbRootArgs`: exactly 2 elements, first is 'shell', compound command is
  single-quoted, no host PowerShell/cmd parsing, throws on single quotes in cmd
- `ADB_SPAWN_OPTS.shell === false`, stdio captured
- ADB_EXE is absolute
- Env file round-trip, comment skipping, credential rollback logic
- Windows absolute temp paths, paths with spaces, adb push path is absolute
