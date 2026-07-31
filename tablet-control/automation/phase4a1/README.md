# Phase 4A.1 proposed authentication-compatible CCTV health check

This directory is a local proposal only. It has not been copied to the tablet.

## Proposed tablet changes after approval

- Replace only `/data/local/tmp/cctv-common-fixed.sh` with the reviewed patch in `cctv-common-fixed.patch`.
- Create `/data/adb/cctv/` as root-owned mode `0700`.
- Create `/data/adb/cctv/ipwebcam-health.mode` as root-owned mode `0600`, initially containing `disabled`.
- Do **not** create the credential config until a later, separately approved authentication step. If needed, it will be `/data/adb/cctv/ipwebcam-auth.curl`, root-owned mode `0600`, parsed by curl with `--config` rather than sourced by the shell.

The helper uses the existing curl client. In enabled mode it uses `--anyauth` and the root-only curl config file, allowing curl to select Digest when the server offers it and Basic only when that is the server's available scheme. No password appears in a URL, shell argument, log, or repository file.

`401` remains a liveness-positive result so a credential/configuration error cannot trigger a restart loop. It is logged/classified separately from a valid authenticated `200`. Timeout/partial response and listener failures remain liveness-negative and retain the existing rate-limited recovery behavior.

Run the local model tests with:

```powershell
npx vitest run automation/phase4a1/health-model.test.ts
```
