# ROSHANOS PRIVILEGED PERMISSION & NETWORK SECURITY AUDIT

**Application ID:** `com.tabletcontrol.companion`  
**Target Package:** `/system/priv-app/RoshanCore/RoshanCore.apk`  
**Android Level:** Android 11 (API 30)  
**Audit Status:** ZERO-PRIVILEGE BASELINE & LOCALHOST NETWORK SECURITY VERIFIED

---

## 1. Activity Export & Entry Point Matrix

| Activity        | Enabled | Exported | Intent Filter             | Function                                                                                                                                         |
| :-------------- | :------ | :------- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MainActivity`  | `true`  | `false`  | None                      | **Internal Protected Admin Screen.** Enables intra-app launch from `KioskActivity` after PIN/gesture authentication. Hides icon from app drawer. |
| `KioskActivity` | `true`  | `true`   | `MAIN`, `HOME`, `DEFAULT` | **Sole System Home Launcher.** Handles user app grid, clock, signage, and admin recovery gesture.                                                |

---

## 2. Network Security Architecture (`network_security_config.xml`)

Global `android:usesCleartextTraffic="true"` has been removed. The application enforces:

```xml
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">localhost</domain>
    </domain-config>
</network-security-config>
```

- **Production Phone Transport:** Mandatory HTTPS via private TLS tunnel.
- **Internal Loopback Transport:** Restricted cleartext permitted only for `127.0.0.1` loopback IPC between `CompanionService` (port 8765) and `CameraService` (port 8081).
- **External LAN Transport:** Plain HTTP to external IPs is strictly blocked by Android Network Security.

---

## 3. Evidence Status Matrix

| Test Suite                   | Status                | Description                                                                     |
| :--------------------------- | :-------------------- | :------------------------------------------------------------------------------ |
| **Merged APK Manifest**      | **APK MANIFEST PASS** | `MainActivity` enabled=true, exported=false; `KioskActivity` sole Home launcher |
| **Network Security Config**  | **AUTOMATED PASS**    | `network_security_config.xml` restricting cleartext strictly to loopback        |
| **Physical Brightness Test** | **NOT TESTED**        | Pending human confirmation during physical phone run                            |
| **Physical Volume & Mute**   | **NOT TESTED**        | Pending human confirmation during physical phone run                            |
| **App Approval & Lock-Task** | **NOT TESTED**        | Pending physical verification of dynamic lock-task allowlist                    |
| **Protected Admin Recovery** | **NOT TESTED**        | Pending PIN/gesture intra-app launch test                                       |
