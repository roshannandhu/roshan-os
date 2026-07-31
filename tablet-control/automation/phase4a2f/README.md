# Phase 4A.2f watchdog recovery-result classification repair

This folder contains the pre-install candidate for only `/data/local/tmp/cctv-health-check-fixed.sh`.

- `cctv-health-check-fixed.original.sh` is a logical LF copy of the live caller at the pre-install checkpoint. The live file has no terminal newline.
- `cctv-health-check-fixed.repaired.sh` changes only the recovery-result classification after `start_ip_webcam` returns.
- `cctv-health-check-fixed.result-classification.patch` is the reviewed minimal diff.
- `recovery-result-classification.fixture.sh` is an isolated POSIX test with no tablet paths, service commands, or persistent effects.

Before any installation, compare the live caller SHA-256 with `ed725a85bfbb17d5455de68db9c5a16f7754ff887a686e3fdc9ea91097ce7484`. Transfer the candidate as LF with no final newline; its expected device-format SHA-256 is `611afa71b7e2dbfff2da7c867a9bf88d31d76dced97b0a51ae135a257af7d541`.

The backup proposal is `/data/local/tmp/cctv-backups/<timestamp>-phase4a2f/cctv-health-check-fixed.sh`, in a root-owned non-executable directory. Rollback would restore only that file, preserve `shell:shell`, mode `0755`, `u:object_r:shell_data_file:s0`, and verify the backed-up SHA-256 before rechecking process/listener health. No installation occurs without a separate approval.
