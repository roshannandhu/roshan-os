# ROSHANOS STAGE 0 & STAGE 1 AUDIT ARCHITECTURE (FINAL CORRECTION)

**Status:** STAGE 1 APPLICATION ACCEPTANCE ACTIVE  
**Package Identity:** `com.tabletcontrol.companion`  
**Architecture:** SINGLE PRIVILEGED APK (`/system/priv-app/RoshanCore/RoshanCore.apk`)  
**Target Hardware:** Lenovo Tab M8 HD (TB-8505F / `akita_row_wifi`), MediaTek MT6761, 2 GB RAM  
**Base OS:** LineageOS 18.1 GSI (`lineage_arm64_bvS`, Android 11), PHH SuperUser Root

---

## 1. Core Architectural Rules

1. **Package Identity Preserved (`com.tabletcontrol.companion`):**
   The application package identity remains `com.tabletcontrol.companion`. Changing package identity is strictly prohibited.

2. **Single Privileged APK (`RoshanCore.apk`):**
   RoshanOS v1 deploys as a single privileged APK at `/system/priv-app/RoshanCore/RoshanCore.apk` containing `KioskActivity` (RoshanLauncher), `CompanionService` (supervisor), `DevicePolicyController` (DPC), `CameraService` (RoshanMedia), `BootReceiver`, and `TabletDeviceAdminReceiver`.
   Tailscale and IP Webcam may optionally be embedded from operator-supplied APKs under
   `/system/app` for factory-reset persistence. They remain separate, non-privileged
   packages; the repository does not bundle or download them.

3. **No Technical Launcher Entry Point in Release:**
   `MainActivity` is enabled for protected intra-app owner maintenance, but remains unexported (`exported="false"`) with no `MAIN`/`LAUNCHER` intent filter. `KioskActivity` is the sole `MAIN`/`HOME`/`DEFAULT` entry point. Local administration is reached exclusively through the protected interface inside `KioskActivity`.

4. **Zero-Privilege Default Allowlist:**
   No privileged permissions (`STATUS_BAR`, `WRITE_SECURE_SETTINGS`, `MANAGE_DEVICE_ADMINS`, `CHANGE_COMPONENT_ENABLED_STATE`) are requested. Standard Android Device Owner APIs (`DevicePolicyManager`) authorize all policy enforcement natively.

5. **Application Hiding vs. UI Filtering:**
   `DevicePolicyManager.setApplicationHidden(..., true)` is **NEVER** called on technical background services (`com.tailscale.ipn`, `com.pas.webcam`, `com.tabletcontrol.companion`). Background packages remain enabled in Android OS while being filtered out of `RoshanLauncher` app grid UI via `ApprovedApps.kt`.

6. **Dynamic Lock-Task Allowlisting:**
   `DevicePolicyController.setLockTaskPackages()` dynamically merges `ApprovedApps.approvedPackages(ctx)` with `com.tabletcontrol.companion` and system media pickers. Any change to approved app state automatically regenerates the Device Policy lock-task allowlist.

7. **Strict SELinux Extended Attribute Validation:**
   Host staging scripts (`rom/scripts/prepare-working-image.sh`) inspect UID/GID (`0:0`), octal mode (`0644`/`0755`), file SHA256 checksums, and `security.selinux` extended attributes before declaring image readiness. Optional external APKs are first checked with Android tooling for their exact package IDs, rejected if duplicated in the source image, and verified byte-for-byte unchanged after injection.

---

## 2. Merged Manifest Component Table

| Component                        | Class                                                        | Exported State                | Category / Protection                                    | Role                                |
| :------------------------------- | :----------------------------------------------------------- | :---------------------------- | :------------------------------------------------------- | :---------------------------------- |
| `MainActivity`                   | `com.tabletcontrol.companion.MainActivity`                   | `false` (Enabled, unexported) | None                                                     | Protected owner maintenance screen  |
| `KioskActivity`                  | `com.tabletcontrol.companion.KioskActivity`                  | `true`                        | `MAIN`, `HOME`, `DEFAULT`                                | **Sole System Home Launcher**       |
| `GetProvisioningModeActivity`    | `com.tabletcontrol.companion.GetProvisioningModeActivity`    | `true`                        | `BIND_DEVICE_ADMIN`; `GET_PROVISIONING_MODE`             | Fully-managed provisioning selector |
| `PolicyComplianceActivity`       | `com.tabletcontrol.companion.PolicyComplianceActivity`       | `true`                        | `BIND_DEVICE_ADMIN`; `ADMIN_POLICY_COMPLIANCE`           | Policy-compliance callback          |
| `ProvisioningSuccessfulActivity` | `com.tabletcontrol.companion.ProvisioningSuccessfulActivity` | `true`                        | `BIND_DEVICE_ADMIN`; `PROVISIONING_SUCCESSFUL`           | Legacy success callback             |
| `CompanionService`               | `com.tabletcontrol.companion.CompanionService`               | `false`                       | `dataSync\|location`                                     | **RoshanCore Supervisor**           |
| `CameraService`                  | `com.tabletcontrol.companion.CameraService`                  | `false`                       | `camera\|microphone`                                     | **RoshanMediaService**              |
| `BootReceiver`                   | `com.tabletcontrol.companion.BootReceiver`                   | `true`                        | `BOOT_COMPLETED`, `USER_UNLOCKED`, `MY_PACKAGE_REPLACED` | **Boot Coordinator**                |
| `TabletDeviceAdminReceiver`      | `com.tabletcontrol.companion.TabletDeviceAdminReceiver`      | `true`                        | `BIND_DEVICE_ADMIN`; admin/provisioning-complete actions | **Device Policy Admin Receiver**    |

The production factory-reset and Device Owner recovery sequence is documented in
[`FACTORY_RESET_PROVISIONING.md`](FACTORY_RESET_PROVISIONING.md). A privileged system APK
does not self-assign Device Owner after Setup Wizard has completed.

---

## 3. Dynamic Lock-Task & Package Approval Flow

```text
[ Admin Approves / Revokes App via Phone Controller API ]
                           ↓
[ ApprovedApps Database Updated (KEY_APPROVED) ]
                           ↓
[ DevicePolicyController.updateLockTaskAllowlist(context) Triggered ]
                           ↓
[ DPM setLockTaskPackages(admin, approvedSet + com.tabletcontrol.companion) ]
                           ↓
[ RoshanLauncher UI Grid Refreshed ]
```
