package com.tabletcontrol.companion

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log

/**
 * Reconciles only frontend Activity entry points for technical packages.
 *
 * The packages themselves remain installed, enabled, unsuspended, and able to
 * run services. RoshanCore itself is always excluded. Restoring technical
 * frontends is allowed only during protected maintenance.
 *
 * This requires RoshanCore to be installed as a priv-app with the
 * CHANGE_COMPONENT_ENABLED_STATE allowlist entry. Development/user installs
 * fail safely without attempting a root or package-wide fallback.
 */
internal object TechnicalLauncherManager {
    private const val TAG = "TechnicalLaunchers"
    private const val CHANGE_COMPONENT_PERMISSION =
        "android.permission.CHANGE_COMPONENT_ENABLED_STATE"

    fun reconcile(context: Context, hiddenFromNormalUser: Boolean): Boolean {
        val packageManager = context.packageManager
        val discoveredFrontends = frontendActivityComponents(
            packageManager = packageManager,
            packageName = null
        )
        val targetPackages = TechnicalLauncherPolicy.targetPackages(
            declaredTechnicalPackages = ApprovedApps.technicalPackages(context),
            discoveredFrontendPackages =
                discoveredFrontends.components.mapTo(mutableSetOf()) { it.packageName },
            roshanCorePackage = context.packageName,
            isTechnical = { packageName ->
                ApprovedApps.isTechnical(context, packageName)
            }
        )
        val installedTargets = targetPackages.filterTo(mutableSetOf()) { packageName ->
            isInstalled(packageManager, packageName)
        }
        if (installedTargets.isEmpty()) return discoveredFrontends.succeeded

        var allOk = discoveredFrontends.succeeded
        val targetComponents = discoveredFrontends.components
            .filterTo(mutableSetOf()) { it.packageName in installedTargets }
        installedTargets.forEach { packageName ->
            val packageFrontends = frontendActivityComponents(
                packageManager = packageManager,
                packageName = packageName
            )
            allOk = allOk && packageFrontends.succeeded
            targetComponents += packageFrontends.components
        }
        if (targetComponents.isEmpty()) return allOk

        val protectedMaintenanceActive =
            !hiddenFromNormalUser && DevicePolicyController.isMaintenanceMode(context)
        val visibility = TechnicalLauncherPolicy.visibilityDecision(
            hiddenFromNormalUser = hiddenFromNormalUser,
            protectedMaintenanceActive = protectedMaintenanceActive
        )
        if (!visibility.requestAccepted) {
            allOk = false
            Log.e(
                TAG,
                "Technical launcher restore rejected outside protected maintenance; " +
                    "frontends remain hidden"
            )
        }

        if (
            context.checkSelfPermission(CHANGE_COMPONENT_PERMISSION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(
                TAG,
                "Privileged component-state permission unavailable; launcher state unchanged"
            )
            return false
        }

        targetComponents.forEach { component ->
            try {
                packageManager.setComponentEnabledSetting(
                    component,
                    if (visibility.hide) {
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    } else {
                        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                    },
                    PackageManager.DONT_KILL_APP
                )
            } catch (error: Exception) {
                allOk = false
                Log.w(
                    TAG,
                    "Could not update technical frontend ${component.flattenToShortString()}: " +
                        error.message
                )
            }
        }
        Log.i(
            TAG,
            "${if (visibility.hide) "Hidden" else "Restored"} " +
                "${targetComponents.size} technical frontend activities across " +
                "${installedTargets.size} packages"
        )
        return allOk
    }

    @Suppress("DEPRECATION")
    private fun isInstalled(
        packageManager: PackageManager,
        packageName: String
    ): Boolean =
        try {
            packageManager.getApplicationInfo(
                packageName,
                PackageManager.MATCH_DISABLED_COMPONENTS
            )
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        } catch (error: Exception) {
            Log.w(TAG, "Could not inspect technical package $packageName: ${error.message}")
            false
        }

    @Suppress("DEPRECATION")
    private fun frontendActivityComponents(
        packageManager: PackageManager,
        packageName: String?
    ): ComponentDiscovery {
        val intents = listOf(
            Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
                if (packageName != null) setPackage(packageName)
            },
            Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
                if (packageName != null) setPackage(packageName)
            }
        )
        val flags =
            PackageManager.MATCH_DISABLED_COMPONENTS or
                PackageManager.MATCH_DIRECT_BOOT_AWARE or
                PackageManager.MATCH_DIRECT_BOOT_UNAWARE
        val components = mutableSetOf<ComponentName>()
        var succeeded = true
        intents.forEach { intent ->
            try {
                packageManager.queryIntentActivities(intent, flags)
                    .mapNotNullTo(components) { resolved ->
                        val info = resolved.activityInfo ?: return@mapNotNullTo null
                        ComponentName(info.packageName, info.name)
                    }
            } catch (error: Exception) {
                succeeded = false
                Log.w(
                    TAG,
                    "Could not enumerate technical frontend activities" +
                        (packageName?.let { " for $it" } ?: "") +
                        ": ${error.message}"
                )
            }
        }
        return ComponentDiscovery(components, succeeded)
    }

    private data class ComponentDiscovery(
        val components: Set<ComponentName>,
        val succeeded: Boolean
    )
}

/**
 * Android-free policy core for package targeting and maintenance-only restore.
 */
internal object TechnicalLauncherPolicy {
    data class VisibilityDecision(
        val hide: Boolean,
        val requestAccepted: Boolean
    )

    fun visibilityDecision(
        hiddenFromNormalUser: Boolean,
        protectedMaintenanceActive: Boolean
    ): VisibilityDecision =
        if (hiddenFromNormalUser || !protectedMaintenanceActive) {
            VisibilityDecision(
                hide = true,
                requestAccepted = hiddenFromNormalUser
            )
        } else {
            VisibilityDecision(hide = false, requestAccepted = true)
        }

    fun targetPackages(
        declaredTechnicalPackages: Set<String>,
        discoveredFrontendPackages: Set<String>,
        roshanCorePackage: String,
        isTechnical: (String) -> Boolean
    ): Set<String> {
        val doNotDisable = setOf(
            "com.android.launcher3",
            "com.android.systemui",
            "com.android.settings",
            "com.tailscale.ipn"
        )
        return (declaredTechnicalPackages + discoveredFrontendPackages.filter(isTechnical))
            .asSequence()
            .map(String::trim)
            .filter(String::isNotEmpty)
            .filterNot { it == roshanCorePackage }
            .filterNot { it in doNotDisable }
            .toSet()
    }
}
