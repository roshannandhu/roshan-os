# RoshanOS System Staging Directory (Single-APK Architecture)

This hierarchy mirrors Android's `/system` partition layout. It stages the single
privileged `RoshanCore.apk` (`com.tabletcontrol.companion`) and the required XML files
for offline image assembly.

## Target hierarchy

```text
rom/staging/system/
|-- media/
|   `-- bootanimation.zip               # Deterministic RoshanOS boot branding
|-- priv-app/
|   `-- RoshanCore/
|       `-- RoshanCore.apk              # com.tabletcontrol.companion
`-- etc/
    |-- permissions/
    |   `-- privapp-permissions-roshan.xml
    `-- sysconfig/
        `-- roshan-sysconfig.xml
```

## Metadata and SELinux checklist

When the working-copy image is mounted in Linux or WSL2, every staged object must have:

- Ownership `0:0` (`root:root`).
- File mode `0644` and directory mode `0755`.
- SELinux label `u:object_r:system_file:s0` for:
  - `/system/priv-app/RoshanCore/RoshanCore.apk`
  - `/system/etc/permissions/privapp-permissions-roshan.xml`
  - `/system/etc/sysconfig/roshan-sysconfig.xml`
  - `/system/media/bootanimation.zip`
  - Caller-supplied optional APK directories and files under `/system/app`, when used

Verify the result with `getfattr -n security.selinux <filepath>` and
`sha256sum <filepath>`.

## Provisioning boundary

Only RoshanCore, the two XML files, and the generated RoshanOS boot animation belong in
this repository staging tree. The
Android Enterprise QR template is a host-side provisioning artifact and must not be
copied into the system image.

Tailscale and IP Webcam are never stored in this staging tree. When the operator supplies
an independently approved APK through `--tailscale-apk` or `--ip-webcam-apk`,
`prepare-working-image.sh` validates its exact package ID and copies it unchanged
directly into one of these non-privileged system-app locations in the isolated image:

```text
/system/app/RoshanTailscale/Tailscale.apk
/system/app/RoshanIpWebcam/IPWebcam.apk
```

The directories use `0755`, APK files use `0644`, ownership is `0:0`, and the label is
`u:object_r:system_file:s0`. An omitted APK is reported as degraded rather than sourced
or synthesized by the repository.

Embedding the APK as a privileged system application preserves it across a factory
reset, but does not assign Device Owner. After a reset, the operator must use Android
Managed Provisioning before completing Setup Wizard. See
[`docs/FACTORY_RESET_PROVISIONING.md`](../../../docs/FACTORY_RESET_PROVISIONING.md).
