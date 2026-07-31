# RoshanOS Factory-Reset Provisioning

This is the production recovery path for a tablet whose RoshanOS DPC is preinstalled at
`/system/priv-app/RoshanCore/RoshanCore.apk`.

## The boundary that must not be blurred

A preinstalled, privileged, or system application is **not automatically Device Owner**.
Android's Managed Provisioning flow must assign
`com.tabletcontrol.companion/.TabletDeviceAdminReceiver` while the device is still
unprovisioned. RoshanOS deliberately checks the existing Device Owner state; it does not
attempt to grant that authority to itself.

Once Setup Wizard has completed and Android records the device as provisioned, an
application cannot promote itself to Device Owner. Rebooting, opening RoshanOS, enabling
legacy device-admin access, running a background service, or having root available does
not create a standards-compliant Device Owner. The supported recovery is to factory-reset
the tablet and provision it again before completing Setup Wizard.

`adb shell dpm set-device-owner ...` is a development aid, not the production recovery
path. It is accepted only under Android's restricted unprovisioned/no-account conditions
and must not be presented as a way to repair an already configured tablet.

## Prerequisites

- The release APK has been built, signed, verified, and embedded at
  `/system/priv-app/RoshanCore/RoshanCore.apk`.
- The resource-only Setup Wizard overlay has been built, signed, verified to contain no
  `classes.dex`, and embedded at
  `/system/product/overlay/RoshanSetupWizardOverlay/RoshanSetupWizardOverlay.apk`.
- The embedded APK keeps the package name `com.tabletcontrol.companion`, the same signing
  identity expected by future updates, and the receiver
  `.TabletDeviceAdminReceiver`.
- The image includes Android's Setup Wizard and Managed Provisioning support for fully
  managed devices. For this exact backed image, that means
  `org.lineageos.setupwizard` and `com.android.managedprovisioning`.
- The privileged-permission allowlist grants the preinstalled RoshanCore package
  `android.permission.DISPATCH_PROVISIONING_MESSAGE`. The setup bridge uses this
  signature-or-privileged permission only to enter Android's protected trusted-source
  Managed Provisioning flow; it does not assign Device Owner itself.
- Any third-party package expected to survive a reset has also been deliberately embedded
  in an immutable system partition. The ROM manifest defines optional, caller-supplied
  paths for Tailscale and IP Webcam, but does not contain their APKs, URLs, or checksums.
  An ordinary `/data/app` installation is erased by a factory reset.
- The operator has the local Wi-Fi details and current enrollment information. Neither
  is stored in this repository.
- The operator has backed up any required user data and explicitly approved the
  destructive factory reset.

Run the host-side consistency check before preparing or installing an image:

```text
node rom/scripts/validate-provisioning-artifacts.mjs
```

If Tailscale or IP Webcam must remain installed after reset, prepare the image with
independently obtained, approved APK files:

```text
bash rom/scripts/prepare-working-image.sh \
  --tailscale-apk "$TAILSCALE_APK_PATH" \
  --ip-webcam-apk "$IP_WEBCAM_APK_PATH" \
  INPUT_SYSTEM_IMG OUTPUT_RAW_IMG
```

The script accepts only package IDs `com.tailscale.ipn` and `com.pas.webcam`, copies the
supplied bytes unchanged into non-privileged `/system/app` directories, and rejects
duplicates. Omitting either option is a supported but explicitly degraded image result
for that package's reset persistence. The repository never downloads or substitutes an
APK and does not assert redistribution rights.

## Executable setup entry and dormant QR reference

The exact backed LineageOS 18.1 Setup Wizard was inspected. Its welcome activity has no
QR, six-tap, or trusted-source launch handler. Therefore, a six-tap-and-scan sequence is
**not an executable enrollment path on this target** and must not be used as a factory
reset acceptance claim.

The executable target-specific path is
`com.tabletcontrol.companion/.RoshanSetupActivity`:

- It is a factory-reset `MAIN`/`HOME`/`DEFAULT` activity with intent priority `10`, above
  the preserved Lineage Setup Wizard HOME priority for the unprovisioned phase.
- It requires Wi-Fi before exposing the enrollment action.
- It launches the system-only
  `com.android.managedprovisioning` trusted-source alias with
  `android.app.action.PROVISION_MANAGED_DEVICE_FROM_TRUSTED_SOURCE`.
- It passes only the preinstalled RoshanCore admin component and
  `EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED=true`.
- It does not pass Wi-Fi secrets, a download URL, an APK checksum, admin extras,
  controller credentials, a provisioning trigger, or a request to skip Android consent.
- Android Managed Provisioning remains responsible for showing the required
  device-management and privacy disclosures and for assigning Device Owner.

`rom/provisioning/android-enterprise-qr-preinstalled-dpc.template.json` remains a
secret-free reference for a future Setup Wizard or external provisioning station that
has a separately proven QR entry point. It is dormant on this exact backed Setup Wizard
and is not the production entry point. Its reference payload contains only:

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.tabletcontrol.companion/.TabletDeviceAdminReceiver"
}
```

There is intentionally no download URL, APK checksum, Wi-Fi password, enrollment token,
admin extras, or controller credential. If a future operator-local QR payload needs
Wi-Fi bootstrap data, generate it outside the repository, restrict access to it, and
destroy it after use.

Do not add download or signature-checksum fields to the trusted-source bridge or use the
dormant QR reference to imply target support. Managed Provisioning resolves the DPC
already present in the system image.

## Setup Wizard branding boundary

The immutable static RRO package
`com.tabletcontrol.roshanos.setupwizard.overlay` targets
`org.lineageos.setupwizard`. It maps only the welcome logo and the Setup Wizard,
operating-system-name, welcome, and completion strings to RoshanOS resources. The APK is
required to be resource-only and must contain no executable code.

The overlay does not replace, patch, or re-sign the platform-signed Lineage Setup Wizard,
does not alter its activity logic, and cannot create a QR handler. After Managed
Provisioning establishes Device Owner, RoshanOS disables `RoshanSetupActivity`, starts
service reconciliation, and explicitly returns to the preserved, resource-branded
Lineage Setup Wizard. Android then owns completion of `DEVICE_PROVISIONED` and
`USER_SETUP_COMPLETE`. Only after that lifecycle completes should `KioskActivity` be the
normal RoshanOS HOME.

The RRO source and image recipe are safe offline changes. Visual branding, overlay
enablement, setup completion, HOME resolution, and persistence across a real second
factory reset still require physical-device proof.

## One-off Tailscale enrollment after reset

An embedded Tailscale APK survives a reset, but its identity does not. RoshanCore supports
a narrow Device Owner operation for a controller or authorized provisioning station to
deliver a **new one-off, tag-scoped Tailscale auth key at runtime**:

```http
POST /api/v1/companion/tailscale/enroll
Authorization: Bearer <current RoshanCore companion credential>
Content-Type: application/json

{"authKey":"tskey-auth-...","timeoutSeconds":120}
```

The JSON object must contain exactly those two keys. `timeoutSeconds` must be an integer
from 30 through 300. RoshanCore accepts only a bounded printable Tailscale auth-key form;
it does not accept caller-selected managed-configuration keys. The endpoint cannot
cryptographically determine whether a Tailscale key is reusable, tagged, or
least-privilege. The controller enrollment authority must generate a one-off key with
the correct tags and discard it immediately after the request.

RoshanCore requires that it is Device Owner and that `com.tailscale.ipn` is installed and
enabled. It reads the target APK's declared Android restrictions before applying them.
For the validated Tailscale 1.96.4 artifact, it applies:

- transient `AuthKey`;
- `ForceEnabled=true`, because that exact APK still declares the legacy policy; and
- `OnboardingFlow=hide`.

Android Device Owner always-on VPN policy, with lockdown deliberately disabled for Wi-Fi
recovery, remains the primary connection/reconnection control. `ForceEnabled` is retained
only for compatibility with the inspected APK; Tailscale has deprecated that policy and
RoshanCore does not invent the replacement `AlwaysOn.Enabled` key when the Android APK
does not declare it.

An enrollment request made while Tailscale is already connected must be rejected as
`TAILSCALE_ALREADY_CONNECTED` **before the auth key is placed** in managed
configuration. An existing VPN transport or Tailnet address can prove connectivity, but
it can never prove that a newly supplied credential was consumed.

Credential consumption is proven only by a fresh attempt that begins with Tailscale
disconnected, temporarily places the new key, and then reaches the successful
`TAILNET_CONNECTED` state with live connectivity proof. Only that sequence may report
`credentialConsumptionProven=true`. A pre-existing transport, a stale address, policy
application alone, or elapsed time must never be used to infer consumption.

RoshanCore removes `AuthKey` from Tailscale's application restrictions after that fresh
success while preserving non-secret restrictions. It also removes the key on timeout or
ordinary failure. If RoshanCore is restarted during enrollment, startup scrubs any
orphaned `AuthKey` before exposing the full authenticated listener and marks the
interrupted attempt failed. The status route contains codes, timestamps, policy support,
connectivity booleans, and the explicit consumption-proof boolean only:

```http
GET /api/v1/companion/tailscale/enrollment/status
Authorization: Bearer <current RoshanCore companion credential>
```

It never returns or stores the key in RoshanCore preferences, update journals,
diagnostics, or logs. The transient value necessarily exists in Tailscale's managed
application-restrictions bundle until consumption, timeout, failure, or restart cleanup.
If Android rejects cleanup, status reports `AUTH_KEY_CLEAR_FAILED` rather than claiming
success.

This does **not** yet make reset enrollment fully remote or automatic. RoshanCore's
listener intentionally rejects ordinary LAN peers, and a reset tablet has no Tailnet
route. Before a controller-side enrollment authority and secure bootstrap transport are
implemented, an authorized provisioning station must first create the new RoshanCore
companion credential and deliver the request through device loopback (for example, a
protected USB/ADB-forward maintenance flow). No reusable auth key belongs in the QR
payload, system image, repository, command history, screenshots, or logs.

## Exact target recovery sequence

1. Factory-reset the tablet from an explicitly authorized maintenance session. This
   erases `/data`, including Wi-Fi networks, RoshanOS runtime credentials, enrollment,
   private-network state, and application data. The APK embedded in `/system` remains.
2. Boot the offline-prepared image. Before enrollment, HOME must resolve to
   `RoshanSetupActivity`, not `KioskActivity` and not a technical server frontend. The
   setup UI must show RoshanOS branding; no six-tap or QR gesture is involved.
3. With no saved network after reset, Roshan Setup must block Home and present only its
   Wi-Fi setup. Enter Wi-Fi locally. The password remains Android runtime state and is
   not built into the image or dormant QR reference.
4. Once Wi-Fi is connected, choose **Begin protected enrollment**. RoshanSetup verifies
   that fully managed provisioning is allowed, resolves only the system Managed
   Provisioning trusted-source alias, and launches it.
5. Confirm the operating-system device-management and privacy disclosures. Canceling
   must leave the device unowned and locked in Roshan Setup with a safe retry path.
   Approving lets Android Managed Provisioning resolve the preinstalled receiver and
   assign it as Device Owner.
6. Managed Provisioning invokes the applicable RoshanOS callbacks:
   `GET_PROVISIONING_MODE`, `ADMIN_POLICY_COMPLIANCE`,
   `PROVISIONING_SUCCESSFUL` on legacy flows, `DEVICE_ADMIN_ENABLED`, and
   `PROFILE_PROVISIONING_COMPLETE`. RoshanOS finalization applies policy and starts its
   supervisor only after Android reports that the package is Device Owner.
7. RoshanOS disables `RoshanSetupActivity` after Device Owner is confirmed and returns
   explicitly to the preserved, resource-branded Lineage Setup Wizard. Complete that
   wizard so Android, rather than RoshanCore, records the platform setup-completion
   flags.
8. HOME must then resolve to `KioskActivity`; the disabled bridge must not reappear in
   Recents, the app grid, or normal HOME selection.
9. In protected owner maintenance, create a **new** RoshanOS/controller pairing
   credential. Verify that any separately embedded Tailscale and IP Webcam packages are
   present. Through an authorized bootstrap channel, have the controller/provisioning
   station deliver a newly generated one-off Tailscale auth key to the enrollment
   endpoint above. First verify that an already-connected attempt returns
   `TAILSCALE_ALREADY_CONNECTED` before key placement. Then disconnect Tailscale and
   perform a fresh attempt. Accept `credentialConsumptionProven=true` only when that
   fresh attempt reaches `TAILNET_CONNECTED` with live proof, and verify
   `transientAuthKeyPresent=false`. Reconfigure the temporary IP Webcam fallback if it
   is still in use. A package that existed only under `/data/app` must be restored from a
   separately approved, verified artifact; this repository does not invent or embed a
   download URL. An embedded APK survives, but its erased application data and
   credentials do not. Do not restore credentials from screenshots, logs, QR images,
   old device backups, or shell history.
10. Reboot once and verify Device Owner, setup-component state, HOME resolution, overlay
    state, service recovery, and absence of technical activities before the tablet is
    returned to normal use.

Android-required camera, microphone, foreground-service, VPN, device-management, and
other privacy disclosures or indicators remain visible. RoshanOS does not suppress them.

## Physical factory-reset acceptance

Offline builds and validators cannot satisfy the factory-reset claim. An authorized
operator must record evidence from the exact signed image and physical tablet for every
item below:

1. Before the reset, record the base-image hash, RoshanCore APK hash and signer, Setup
   Wizard overlay hash and signer, optional external-APK hashes, and a tested recovery
   or rollback path.
2. Obtain separate approval for the destructive reset or flash. Confirm that required
   user data is backed up and that USB/recovery access is available if first boot fails.
3. On the first clean boot, prove the RoshanOS boot animation and resource-branded setup
   appear, `RoshanSetupActivity` owns pre-enrollment HOME, no technical activity opens,
   and no technical package appears in RoshanOS Home.
4. Prove the no-Wi-Fi gate blocks Home, invalid or canceled Wi-Fi does not bypass setup,
   and restored Wi-Fi advances only to the protected enrollment action.
5. Cancel Android's management consent once and prove the device remains unprovisioned
   and safely retryable. Then approve it and record the exact Device Owner component.
6. Prove the setup bridge becomes disabled, the preserved Setup Wizard completes the
   Android setup flags, and post-enrollment HOME resolves to `KioskActivity`.
7. Create new controller credentials through protected maintenance. Do not restore
   erased secrets from the image or repository.
8. Prove the Tailscale rejection and fresh-consumption rules: connected-before-start
   returns `TAILSCALE_ALREADY_CONNECTED` with no key placement; a disconnected fresh
   attempt alone may reach `TAILNET_CONNECTED` and
   `credentialConsumptionProven=true`; the transient key is absent afterward.
9. Reboot and prove the setup bridge stays disabled, RoshanOS Home returns, required
   services recover silently, Wi-Fi/Tailscale recovery behaves correctly, and mandatory
   Android privacy indicators remain.
10. Perform a second separately authorized factory reset on the same flashed image and
    repeat the first-boot enrollment checks. This second reset is the decisive proof
    that APKs, permissions, branding resources, and setup entry are image-persistent
    rather than remnants of `/data` or a development remount overlay.

Record failures as failures. A build, manifest check, emulator result, ADB inspection of
the already provisioned tablet, or successful first reset does not substitute for the
second-reset persistence evidence.

## Read-only verification

With authorized USB debugging, use:

```text
adb shell dumpsys device_policy
adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME
adb shell dumpsys package com.tabletcontrol.companion
adb shell cmd overlay list
adb shell settings get global device_provisioned
adb shell settings get secure user_setup_complete
```

Expected results must be interpreted by lifecycle phase:

- Before enrollment, HOME resolves to
  `com.tabletcontrol.companion/.RoshanSetupActivity`, both setup-completion flags are
  `0`, and no Device Owner is assigned.
- After enrollment and Setup Wizard completion, Device Owner is
  `com.tabletcontrol.companion/.TabletDeviceAdminReceiver`.
- `RoshanSetupActivity` is disabled after Device Owner confirmation.
- Both setup-completion flags are `1`, and HOME resolves to
  `com.tabletcontrol.companion/.KioskActivity`.
- The static `com.tabletcontrol.roshanos.setupwizard.overlay` is listed as enabled for
  `org.lineageos.setupwizard`.
- `MainActivity` is enabled for protected intra-app navigation, but is unexported and has
  no `MAIN`/`LAUNCHER` filter.
- Provisioning callback activities have no launcher category and use
  `android.permission.BIND_DEVICE_ADMIN`.
- `BootReceiver` is direct-boot aware and registered for
  `LOCKED_BOOT_COMPLETED`, `BOOT_COMPLETED`, `USER_UNLOCKED`, and
  `MY_PACKAGE_REPLACED`. Spoofable OEM quick-boot broadcasts are not registered.

Before the Android user unlocks, RoshanCore runs only a direct-boot-safe foreground
shell and minimal listener. `GET /health` reports `state=direct_boot`; every protected
route returns HTTP 423. The service does not read credentials, policy preferences,
diagnostics, Wi-Fi enrollment, or media state from credential-protected storage in that
phase. `USER_UNLOCKED` replaces the minimal listener with the authenticated control
listener and starts normal policy, network, media, and supervisor reconciliation.
Tailscale may itself be unavailable before unlock, so the pre-unlock health listener is
guaranteed only on device loopback/ADB; this must not be described as pre-unlock remote
management.

If Access Lock is part of the deployment, verify the overlay app-op separately from
Device Owner status. The special overlay app-op is not silently created by this QR
payload and must be handled only by protected owner maintenance or an authorized
provisioning station.

## Safety

The dormant QR template and validation helper are host-side artifacts. They are not
copied into `/system`, do not contain secrets, and do not run ADB, fastboot, mount,
flash, wipe, or factory-reset commands. The setup overlay changes resources only. No
repository helper performs the destructive recovery sequence on behalf of the operator.

## Android references

- [Provision devices for device management](https://source.android.com/docs/devices/admin/provision)
- [Dedicated-device provisioning](https://developer.android.com/work/dpc/dedicated-devices)
- [`DevicePolicyManager` provisioning extras](https://developer.android.com/reference/android/app/admin/DevicePolicyManager)
- [Tailscale Android MDM deployment](https://tailscale.com/docs/integrations/mdm/android)
- [Tailscale system policy keys](https://tailscale.com/kb/1315/mdm-keys)
