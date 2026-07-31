package com.tabletcontrol.companion

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.UserManager
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Device Policy Controller — manages Device Owner restrictions.
 *
 * IMPORTANT: Never use setApplicationHidden for packages that need background
 * services (IP Webcam, Tailscale). Use kiosk-level filtering in ApprovedApps
 * instead. setApplicationHidden kills ALL activities AND services.
 */
object DevicePolicyController {
    private const val TAG = "DevicePolicyController"
    private const val PREFS = "dpc_state"
    private const val KEY_MAINTENANCE = "maintenance_mode"
    private const val KEY_MAINTENANCE_EXPIRY = "maintenance_expiry"
    private const val MAX_MAINTENANCE_MINUTES = 60
    private val maintenanceHandler = Handler(Looper.getMainLooper())
    private var maintenanceExpiryRunnable: Runnable? = null
    private val selfUpdateInstallWindowLock = Any()

    data class SelfUpdateInstallWindowResult<T>(
        val value: T?,
        val errorCode: String?
    ) {
        val succeeded: Boolean
            get() = value != null && errorCode == null
    }

    fun getAdminComponent(ctx: Context): ComponentName {
        return ComponentName(ctx, TabletDeviceAdminReceiver::class.java)
    }

    fun isDeviceOwner(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(ctx.packageName)
    }

    /**
     * Android 11 checks DISALLOW_INSTALL_APPS when a PackageInstaller session
     * is created, even when the caller is the Device Owner. Open only that one
     * restriction around [createSession], then restore it before any APK bytes
     * are written. Other package-management protections remain active.
     */
    fun <T> createSelfUpdateSession(
        ctx: Context,
        createSession: () -> T
    ): SelfUpdateInstallWindowResult<T> = synchronized(selfUpdateInstallWindowLock) {
        val dpm =
            ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val userManager = ctx.getSystemService(Context.USER_SERVICE) as UserManager
        val isOwner = dpm.isDeviceOwnerApp(ctx.packageName)
        val wasRestricted = try {
            userManager.hasUserRestriction(UserManager.DISALLOW_INSTALL_APPS)
        } catch (_: Exception) {
            return@synchronized SelfUpdateInstallWindowResult(
                value = null,
                errorCode = "INSTALL_RESTRICTION_STATE_UNKNOWN"
            )
        }

        if (wasRestricted && !isOwner) {
            return@synchronized SelfUpdateInstallWindowResult(
                value = null,
                errorCode = "INSTALL_RESTRICTED_AND_NOT_DEVICE_OWNER"
            )
        }

        if (wasRestricted) {
            try {
                dpm.clearUserRestriction(
                    getAdminComponent(ctx),
                    UserManager.DISALLOW_INSTALL_APPS
                )
            } catch (_: Exception) {
                return@synchronized SelfUpdateInstallWindowResult(
                    value = null,
                    errorCode = "INSTALL_RESTRICTION_OPEN_FAILED"
                )
            }
            if (userManager.hasUserRestriction(UserManager.DISALLOW_INSTALL_APPS)) {
                try {
                    dpm.addUserRestriction(
                        getAdminComponent(ctx),
                        UserManager.DISALLOW_INSTALL_APPS
                    )
                } catch (_: Exception) {
                    // The restriction is still active from at least one source;
                    // report failure and let normal policy reconciliation retry.
                }
                return@synchronized SelfUpdateInstallWindowResult(
                    value = null,
                    errorCode = "INSTALL_RESTRICTION_STILL_ACTIVE"
                )
            }
        }

        var value: T? = null
        var createError: String? = null
        try {
            value = createSession()
        } catch (_: Exception) {
            createError = "PACKAGE_SESSION_CREATE_FAILED"
        } finally {
            if (wasRestricted) {
                try {
                    dpm.addUserRestriction(
                        getAdminComponent(ctx),
                        UserManager.DISALLOW_INSTALL_APPS
                    )
                } catch (_: Exception) {
                    createError = "INSTALL_RESTRICTION_RESTORE_FAILED"
                }
                if (!userManager.hasUserRestriction(UserManager.DISALLOW_INSTALL_APPS)) {
                    createError = "INSTALL_RESTRICTION_RESTORE_FAILED"
                }
            }
        }

        SelfUpdateInstallWindowResult(
            value = value,
            errorCode = createError
        )
    }

    fun rebootDevice(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return false
        return try {
            dpm.reboot(getAdminComponent(ctx))
            true
        } catch (error: Exception) {
            Log.e(TAG, "Device Owner reboot failed: ${error.message}")
            false
        }
    }

    fun lockDevice(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return false
        return try {
            dpm.lockNow()
            true
        } catch (error: Exception) {
            Log.e(TAG, "Device Owner lock failed: ${error.message}")
            false
        }
    }

    /**
     * Ensures a managed package is not in a disabled state.
     * Uses Device Owner authority to re-enable it if needed.
     */
    fun ensurePackageEnabled(context: Context, packageName: String) {
        if (!isDeviceOwner(context)) return
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
            val admin = getAdminComponent(context)
            if (!dpm.isApplicationHidden(admin, packageName)) return
            dpm.setApplicationHidden(admin, packageName, false)
            Log.i(TAG, "Re-enabled package: $packageName")
        } catch (e: Exception) {
            Log.w(TAG, "Could not ensure package enabled: $packageName", e)
        }
    }

    fun reconcileAlwaysOnVpn(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return false
        return try {
            // Lockdown remains false so Wi-Fi setup/recovery is still possible
            // when Tailscale identity or connectivity is unavailable.
            dpm.setAlwaysOnVpnPackage(getAdminComponent(ctx), "com.tailscale.ipn", false)
            true
        } catch (error: Exception) {
            Log.w(TAG, "Always-on Tailscale reconciliation failed: ${error.message}")
            false
        }
    }

    /**
     * Apply all Device Owner policies. Safe to call multiple times (idempotent).
     * Called from CompanionService.onStartCommand() and BootReceiver.
     */
    fun applyDeviceOwnerPolicies(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = getAdminComponent(ctx)

        if (!dpm.isDeviceOwnerApp(ctx.packageName)) {
            // RoshanCore's final priv-app permission exists before enrollment,
            // so technical launcher entry points can remain absent throughout
            // first boot. A development/user install simply fails safely here.
            TechnicalLauncherManager.reconcile(ctx, hiddenFromNormalUser = true)
            Log.w(TAG, "Not Device Owner — cannot apply policies.")
            return false
        }

        // The reset-persistent manifest default is enabled so this component
        // wins HOME on a clean /data partition. Once Android has assigned
        // Device Owner, it must never compete with normal RoshanOS Home.
        var allOk = RoshanSetupLifecycle.disableEntry(ctx)
        if (!allOk) {
            Log.w(TAG, "Factory-reset setup HOME entry could not be disabled.")
        }

        // 1. User restrictions
        val inMaintenance = isMaintenanceMode(ctx)
        val restrictions = mutableMapOf(
            UserManager.DISALLOW_FACTORY_RESET to "factory reset",
            UserManager.DISALLOW_ADD_USER to "add user",
            UserManager.DISALLOW_SAFE_BOOT to "safe boot",
            UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA to "mount media"
        )

        // A fresh/reset tablet must retain Android Wi-Fi onboarding until it is
        // connected or has at least one saved network.
        val wifiOnboarded = hasConnectedOrSavedWifi(ctx)
        val restrictWifiChanges = wifiOnboarded && !inMaintenance
        try {
            if (restrictWifiChanges) {
                restrictions[UserManager.DISALLOW_CONFIG_WIFI] = "Wi-Fi config"
            } else {
                dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_WIFI)
                Log.i(TAG, "Wi-Fi policy left open for setup/maintenance.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to update Wi-Fi onboarding restrictions: ${e.message}")
            allOk = false
        }

        // Package installation/removal/control is relaxed only during a
        // protected maintenance session. DISALLOW_APPS_CONTROL prevents a
        // normal user from force-stopping, disabling, or clearing server apps.
        if (inMaintenance) {
            try {
                arrayOf(
                    UserManager.DISALLOW_INSTALL_APPS,
                    UserManager.DISALLOW_UNINSTALL_APPS,
                    UserManager.DISALLOW_APPS_CONTROL
                ).forEach { restriction ->
                    dpm.clearUserRestriction(admin, restriction)
                }
                Log.i(TAG, "Maintenance mode active — package-management restrictions relaxed.")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to clear install restrictions during maintenance: ${e.message}")
            }
        } else {
            restrictions[UserManager.DISALLOW_INSTALL_APPS] = "install apps"
            restrictions[UserManager.DISALLOW_UNINSTALL_APPS] = "uninstall apps"
            restrictions[UserManager.DISALLOW_APPS_CONTROL] = "application control"
        }

        // 1a. Clear unsupported DISALLOW_CHANGE_WIFI_STATE if previously set
        // by an older build. This restriction causes system_server WTF on
        // Phh-Treble GSIs and must never be applied.
        try {
            dpm.clearUserRestriction(admin, UserManager.DISALLOW_CHANGE_WIFI_STATE)
        } catch (_: Exception) {}

        for ((key, desc) in restrictions) {
            try {
                dpm.addUserRestriction(admin, key)
                Log.d(TAG, "Applied restriction '$desc'")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to apply restriction '$desc': ${e.message}")
                allOk = false
            }
        }

        // 2. Status bar and lock-task restrictions are scoped to temporary
        // Access Lock. Normal approved-app use must not inherit those controls.
        if (!setAccessLockPolicy(ctx, AccessLockManager.isLocked(ctx))) {
            allOk = false
        }

        // 3. Set persistent preferred Home activity
        try {
            val filter = IntentFilter(android.content.Intent.ACTION_MAIN).apply {
                addCategory(android.content.Intent.CATEGORY_HOME)
                addCategory(android.content.Intent.CATEGORY_DEFAULT)
            }
            val homeComponent = ComponentName(ctx, KioskActivity::class.java)
            dpm.addPersistentPreferredActivity(admin, filter, homeComponent)
            Log.d(TAG, "Persistent preferred Home set to KioskActivity")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to set persistent Home: ${e.message}")
            allOk = false
        }

        // 4. Lock-task allowlist — dynamically generated from ApprovedApps + companion + system pickers
        if (!updateLockTaskAllowlist(ctx)) {
            allOk = false
        }

        // 5. Protect server packages from normal-user removal, while allowing
        // deliberate owner maintenance.
        val protectedPackages = arrayOf(
            ctx.packageName,
            "com.tailscale.ipn",
            "com.pas.webcam"
        )
        for (pkg in protectedPackages) {
            try {
                dpm.setUninstallBlocked(admin, pkg, !inMaintenance)
                Log.d(TAG, "Uninstall blocked=${!inMaintenance} for $pkg")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to update uninstall block for $pkg: ${e.message}")
                allOk = false
            }
        }

        // 6. Device Owner grants the runtime permissions RoshanCore needs.
        val roshanCorePermissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION
        )
        for (permission in roshanCorePermissions) {
            try {
                val granted = dpm.setPermissionGrantState(
                    admin,
                    ctx.packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
                )
                if (!granted) {
                    Log.w(TAG, "Device Owner did not grant $permission")
                    allOk = false
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to grant $permission: ${e.message}")
                allOk = false
            }
        }

        // 7. Keep Tailscale always-on, but deliberately leave lockdown off so
        // Wi-Fi/onboarding recovery remains possible if the tunnel is down.
        try {
            if (!reconcileAlwaysOnVpn(ctx)) {
                throw IllegalStateException("Device Owner rejected always-on VPN")
            }
            Log.i(TAG, "Tailscale configured as always-on VPN (lockdown=false).")
        } catch (e: Exception) {
            Log.w(
                TAG,
                "Tailscale always-on VPN unavailable or unprovisioned: ${e.message}"
            )
            allOk = false
        }

        // 8. Ensure critical background services are NOT hidden via DPM
        // (Never use setApplicationHidden for packages needing background services)
        val mustNotHide = listOf(
            "com.pas.webcam",       // IP Webcam — needs background streaming
            "com.tailscale.ipn",    // Tailscale — needs background VPN
            "com.tabletcontrol.companion" // Self
        )
        for (pkg in mustNotHide) {
            try {
                if (dpm.isApplicationHidden(admin, pkg)) {
                    dpm.setApplicationHidden(admin, pkg, false)
                    Log.i(TAG, "CRITICAL: Unhid $pkg — background services require it")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to ensure $pkg remains visible to services: ${e.message}")
                allOk = false
            }
        }

        // 9. Ensure IP Webcam and Tailscale are NOT suspended (suspending kills background services)
        try {
            dpm.setPackagesSuspended(admin, arrayOf("com.pas.webcam", "com.tailscale.ipn"), false)
            Log.d(TAG, "Confirmed IP Webcam and Tailscale are NOT suspended")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unsuspend IP Webcam/Tailscale: ${e.message}")
            allOk = false
        }

        // 10. Disable only technical launcher entry points. Never disable,
        // hide, suspend, or kill the package because its service must continue.
        if (!TechnicalLauncherManager.reconcile(ctx, hiddenFromNormalUser = !inMaintenance)) {
            allOk = false
        }

        if (allOk) {
            Log.i(TAG, "All Device Owner policies applied successfully.")
        } else {
            Log.w(TAG, "Some policies failed to apply — see warnings above.")
        }

        return allOk
    }

    /**
     * Dynamically updates the Device Policy lock-task allowlist from ApprovedApps database.
     */
    fun updateLockTaskAllowlist(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = getAdminComponent(ctx)

        if (!dpm.isDeviceOwnerApp(ctx.packageName)) {
            Log.w(TAG, "Not Device Owner — skipping lock task allowlist update.")
            return false
        }

        return try {
            val approved = ApprovedApps.approvedPackages(ctx)
            val lockTaskPackages = mutableSetOf(
                ctx.packageName,
                "com.android.camera2",
                "com.android.documentsui"
            ).apply {
                addAll(approved)
            }
            dpm.setLockTaskPackages(admin, lockTaskPackages.toTypedArray())
            Log.i(TAG, "Dynamic lock-task allowlist updated: ${lockTaskPackages.size} packages permitted.")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update dynamic lock task allowlist: ${e.message}")
            false
        }
    }

    /**
     * Applies only the policies needed while temporary Access Lock is active.
     * The active state is never persisted; CompanionService/BootReceiver calls
     * applyDeviceOwnerPolicies after process start and restores the unlocked
     * policy automatically.
     */
    fun setAccessLockPolicy(ctx: Context, active: Boolean): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = getAdminComponent(ctx)

        if (!dpm.isDeviceOwnerApp(ctx.packageName)) {
            Log.w(TAG, "Not Device Owner — Access Lock policy unavailable.")
            return false
        }

        var allOk = true
        val shouldRestrict = active && !isMaintenanceMode(ctx)

        try {
            dpm.setStatusBarDisabled(admin, shouldRestrict)
            Log.d(TAG, "Access Lock status bar disabled=$shouldRestrict")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to set Access Lock status bar policy: ${e.message}")
            allOk = false
        }

        try {
            val features = if (shouldRestrict) {
                DevicePolicyManager.LOCK_TASK_FEATURE_NONE
            } else {
                DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO or
                    DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS or
                    DevicePolicyManager.LOCK_TASK_FEATURE_HOME or
                    DevicePolicyManager.LOCK_TASK_FEATURE_OVERVIEW or
                    DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS or
                    DevicePolicyManager.LOCK_TASK_FEATURE_KEYGUARD
            }
            dpm.setLockTaskFeatures(admin, features)
            Log.d(TAG, "Access Lock task features=$features")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to set Access Lock task features: ${e.message}")
            allOk = false
        }

        return allOk
    }

    @Suppress("DEPRECATION")
    private fun hasConnectedOrSavedWifi(ctx: Context): Boolean {
        val connected = try {
            val connectivity =
                ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val capabilities =
                connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        } catch (e: Exception) {
            Log.w(TAG, "Unable to inspect active Wi-Fi transport: ${e.message}")
            false
        }
        if (connected) return true

        val canReadWifiConfiguration =
            ContextCompat.checkSelfPermission(
                ctx,
                Manifest.permission.ACCESS_WIFI_STATE
            ) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(
                    ctx,
                    Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
        if (!canReadWifiConfiguration) return false

        return try {
            val wifi = ctx.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifi.connectionInfo?.networkId?.let { it >= 0 } == true ||
                !wifi.configuredNetworks.isNullOrEmpty()
        } catch (e: Exception) {
            // Fail open: if Android/OEM blocks saved-network inspection, do not
            // risk making fresh Wi-Fi onboarding impossible.
            Log.w(TAG, "Unable to inspect saved Wi-Fi networks: ${e.message}")
            false
        }
    }

    // --- Maintenance Mode ---

    fun isMaintenanceMode(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_MAINTENANCE, false)) return false
        val expiry = prefs.getLong(KEY_MAINTENANCE_EXPIRY, 0)
        if (expiry <= 0L || System.currentTimeMillis() >= expiry) {
            // Expired — exit maintenance
            exitMaintenanceMode(ctx)
            return false
        }
        scheduleMaintenanceExpiry(ctx.applicationContext, expiry)
        return true
    }

    fun enterMaintenanceMode(ctx: Context, durationMinutes: Int = 15) {
        val boundedMinutes = durationMinutes.coerceIn(1, MAX_MAINTENANCE_MINUTES)
        val expiry = System.currentTimeMillis() + boundedMinutes * 60_000L
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_MAINTENANCE, true)
            .putLong(KEY_MAINTENANCE_EXPIRY, expiry)
            .apply()
        scheduleMaintenanceExpiry(ctx.applicationContext, expiry)
        Log.i(TAG, "Entered maintenance mode (expires in $boundedMinutes minutes)")
        // Re-apply policies with relaxed restrictions
        applyDeviceOwnerPolicies(ctx)
        KioskController.notifyLockPolicyChanged(ctx)
    }

    fun exitMaintenanceMode(ctx: Context) {
        maintenanceExpiryRunnable?.let(maintenanceHandler::removeCallbacks)
        maintenanceExpiryRunnable = null
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_MAINTENANCE, false)
            .remove(KEY_MAINTENANCE_EXPIRY)
            .apply()
        Log.i(TAG, "Exited maintenance mode")
        // Re-apply full restrictions
        applyDeviceOwnerPolicies(ctx)
        KioskController.bringToForeground(ctx)
    }

    @Synchronized
    private fun scheduleMaintenanceExpiry(ctx: Context, expiresAtMs: Long) {
        maintenanceExpiryRunnable?.let(maintenanceHandler::removeCallbacks)
        maintenanceExpiryRunnable = null
        if (expiresAtMs <= 0L) return

        val delayMs = (expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0L)
        val runnable = Runnable {
            maintenanceExpiryRunnable = null
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val stillActive = prefs.getBoolean(KEY_MAINTENANCE, false)
            val storedExpiry = prefs.getLong(KEY_MAINTENANCE_EXPIRY, 0L)
            if (stillActive && storedExpiry > 0L &&
                System.currentTimeMillis() >= storedExpiry
            ) {
                exitMaintenanceMode(ctx)
            } else if (stillActive) {
                scheduleMaintenanceExpiry(ctx, storedExpiry)
            }
        }
        maintenanceExpiryRunnable = runnable
        maintenanceHandler.postDelayed(runnable, delayMs)
    }

    fun getMaintenanceStatus(ctx: Context): Map<String, Any> {
        val inMaintenance = isMaintenanceMode(ctx)
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val expiry = prefs.getLong(KEY_MAINTENANCE_EXPIRY, 0)
        return mapOf(
            "active" to inMaintenance,
            "expiresAt" to if (inMaintenance) expiry else 0,
            "remainingSeconds" to if (inMaintenance && expiry > 0)
                maxOf(0, (expiry - System.currentTimeMillis()) / 1000) else 0
        )
    }

    /**
     * Report current restriction status for phone ADMIN diagnostics.
     */
    fun getPolicyStatus(ctx: Context): Map<String, Any> {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = getAdminComponent(ctx)
        val um = ctx.getSystemService(Context.USER_SERVICE) as UserManager

        val restrictions = listOf(
            "no_factory_reset" to UserManager.DISALLOW_FACTORY_RESET,
            "no_add_user" to UserManager.DISALLOW_ADD_USER,
            "no_safe_boot" to UserManager.DISALLOW_SAFE_BOOT,
            "no_config_wifi" to UserManager.DISALLOW_CONFIG_WIFI,
            "no_install_apps" to UserManager.DISALLOW_INSTALL_APPS,
            "no_uninstall_apps" to UserManager.DISALLOW_UNINSTALL_APPS,
            "no_apps_control" to UserManager.DISALLOW_APPS_CONTROL,
            "no_mount_media" to UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA
        )
        // DISALLOW_CHANGE_WIFI_STATE deliberately excluded — causes
        // system_server WTF on Phh-Treble GSIs and offers no benefit
        // beyond DISALLOW_CONFIG_WIFI for the managed-kiosk use case.

        val restrictionStatus = mutableMapOf<String, Boolean>()
        for ((key, restriction) in restrictions) {
            restrictionStatus[key] = um.hasUserRestriction(restriction)
        }

        return mapOf(
            "deviceOwner" to dpm.isDeviceOwnerApp(ctx.packageName),
            "restrictions" to restrictionStatus,
            "statusBarDisabled" to
                (AccessLockManager.isLocked(ctx) && !isMaintenanceMode(ctx)),
            "maintenance" to getMaintenanceStatus(ctx),
            "lockTaskPackagesCount" to try {
                dpm.getLockTaskPackages(admin).size
            } catch (_: Exception) { 0 }
        )
    }
}
