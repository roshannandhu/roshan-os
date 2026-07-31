# RoshanOS ROM Integration and Image Preparation

This directory contains configuration manifests, staging templates, provisioning
artifacts, and host build scripts for producing a modified LineageOS 18.1 GSI system
image for the Lenovo Tab M8 (TB-8505F).

> [!WARNING]
> **READ-ONLY / NON-FLASHING STAGE:** The scripts in this folder operate strictly on
> local image-file copies on the host workstation (Linux or WSL2). They do not execute
> fastboot flash or wipe commands.

For a reversible live-device integration check on an already provisioned
`userdebug` tablet, `scripts/install-as-system-app.ps1` can stage the current
same-signer APK, priv-app allowlist, power/data-save sysconfig, and boot animation
through Android's supported `adb root` + `adb remount` development overlay. The
command requires `-ConfirmDevelopmentOverlay`, captures every replaced file,
reboots, validates Device Owner/health/system-package state and hashes, and rolls
the staged files back on validation failure. It never uninstalls or clears the
Device Owner package.

That overlay is a development test, not a factory-reset-persistent image. Only an
offline image created from the exact base system image, verified and flashed
under a separate destructive-change approval, can satisfy the production
factory-reset claim.

## Directory structure

```text
rom/
|-- README.md
|-- manifest/
|   `-- components.json                 # Placement, intents, and DPC identity
|-- provisioning/
|   `-- android-enterprise-qr-preinstalled-dpc.template.json
|-- branding/
|   `-- roshanos-boot.svg              # Editable exact-text boot artwork
|-- scripts/
|   |-- build-bootanimation.ps1         # Deterministic 800x1280 animation package
|   |-- inspect-image.sh                # Read-only GSI/filesystem/AVB inspector
|   |-- prepare-working-image.sh        # Offline working-copy preparation
|   `-- validate-provisioning-artifacts.mjs
|-- tests/
|   `-- prepare-working-image-fixture-test.sh
`-- staging/
    `-- system/
        |-- README.md                   # Staging structure guidelines
        |-- priv-app/                   # Target directory for RoshanOS APK
        `-- etc/                        # Target permission XML and sysconfig
```

## Workflow

1. **Inspect:** Run `bash rom/scripts/inspect-image.sh <path-to-system.img>` to inspect the
   sparse header, ext4 block allocation, and AVB metadata.
2. **Validate artifacts:** From the repository root, run
   `node rom/scripts/validate-provisioning-artifacts.mjs`. This read-only check compares
   the ROM metadata and secret-free QR template with the application manifest.
3. **Prepare an offline image:** Run `bash rom/scripts/prepare-working-image.sh` to convert,
   resize, mount, and stage APKs and XML allowlists into a working-copy image. Android
   ext4 images using `shared_blocks` are expanded first and then materialized only in the
   isolated copy before the script attempts a writable mount.
4. **Verify:** Inspect the resulting raw/sparse image with `e2fsck` before declaring it
   ready.

## RoshanOS boot branding

`rom/branding/roshanos-boot.svg` is the editable, exact-text source. Build the Android
animation package on Windows with:

```text
powershell -ExecutionPolicy Bypass -File rom/scripts/build-bootanimation.ps1
```

The script renders one deterministic 800x1280 PNG frame and stores it without
compression in `rom/staging/system/media/bootanimation.zip`. Image preparation validates
and installs that package as `/system/media/bootanimation.zip`; it never changes a live
device.

## Factory-reset enrollment

Preinstalling `RoshanCore.apk` does not make it Device Owner. Production enrollment must
run through Android Managed Provisioning while the device is still in Setup Wizard.
Follow [`docs/FACTORY_RESET_PROVISIONING.md`](../docs/FACTORY_RESET_PROVISIONING.md).

The QR JSON under `rom/provisioning/` is a host-side operator artifact. It is not staged
into `/system` and intentionally contains no Wi-Fi password, download URL, checksum,
enrollment token, or controller credential.

## Optional external-app persistence

Tailscale and IP Webcam are not bundled, downloaded, or redistributed by this repository.
An operator who has independently obtained and approved the APKs can make their package
files survive a factory reset by passing them explicitly:

```text
bash rom/scripts/prepare-working-image.sh \
  --tailscale-apk "$TAILSCALE_APK_PATH" \
  --ip-webcam-apk "$IP_WEBCAM_APK_PATH" \
  INPUT_SYSTEM_IMG OUTPUT_RAW_IMG
```

Before any working image is created, the script uses the first available Android SDK
tool from `apkanalyzer`, `aapt2`, or `aapt` to require these exact package IDs:

- Tailscale: `com.tailscale.ipn`
- IP Webcam: `com.pas.webcam`

The unchanged APK bytes are placed in non-privileged immutable locations:

- `/system/app/RoshanTailscale/Tailscale.apk`
- `/system/app/RoshanIpWebcam/IPWebcam.apk`

The script rejects repeated options, one file supplied for both roles, an APK with the
wrong package ID, an existing target-directory collision, or the same package anywhere
in the mounted system image. Source and destination SHA-256 values must match before
publication.

Omitting either option is allowed but is printed as
`DEGRADED (caller APK omitted)`. No URL, substitute APK, or expected checksum is
invented. An omitted package is not scanned or claimed from the base image; its status
therefore remains degraded. Embedding a package preserves its APK, not its `/data`
state: Tailscale authentication, IP Webcam configuration, and other runtime credentials
must still be created again after a factory reset.

To verify only the caller-supplied APK identities without requiring root or touching an
image:

```text
bash rom/scripts/prepare-working-image.sh \
  --validate-apks-only \
  --tailscale-apk "$TAILSCALE_APK_PATH" \
  --ip-webcam-apk "$IP_WEBCAM_APK_PATH"
```

The no-mount fixture suite is:

```text
bash rom/tests/prepare-working-image-fixture-test.sh
```

That fixture stubs the three SDK-tool output formats to exercise parser and rejection
logic; it does not treat its placeholder files as real APKs and never opens an image.
