package com.tabletcontrol.companion

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Idempotent handoff from Android's managed-provisioning lifecycle into
 * RoshanCore. This object never attempts to assign Device Owner itself:
 * ownership must already have been established by Android Setup/Managed
 * Provisioning (QR, zero-touch, NFC, or another standards-compliant flow).
 */
internal object ProvisioningFinalizer {
    private const val TAG = "RoshanProvisioning"

    enum class Trigger(val reason: String) {
        ADMIN_ENABLED("admin_enabled"),
        POLICY_COMPLIANCE("policy_compliance"),
        PROVISIONING_SUCCESSFUL("provisioning_successful"),
        PROFILE_PROVISIONING_COMPLETE("profile_provisioning_complete")
    }

    data class Result(
        val isFullyManagedDevice: Boolean,
        val policiesApplied: Boolean,
        val serviceStartRequested: Boolean
    ) {
        val canCompleteProvisioning: Boolean
            get() = isFullyManagedDevice && serviceStartRequested
    }

    fun finalizeFullyManagedDevice(context: Context, trigger: Trigger): Result {
        val appContext = context.applicationContext
        val dpm = appContext.getSystemService(Context.DEVICE_POLICY_SERVICE)
            as DevicePolicyManager

        if (!dpm.isDeviceOwnerApp(appContext.packageName)) {
            Log.w(
                TAG,
                "Ignoring ${trigger.reason}: RoshanOS is not the Device Owner."
            )
            return Result(
                isFullyManagedDevice = false,
                policiesApplied = false,
                serviceStartRequested = false
            )
        }

        val policiesApplied = try {
            DevicePolicyController.applyDeviceOwnerPolicies(appContext)
        } catch (error: Exception) {
            Log.e(TAG, "Initial Device Owner policy reconciliation failed.", error)
            false
        }

        val serviceStartRequested = try {
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, CompanionService::class.java)
                    .setAction(CompanionService.ACTION_RECONCILE)
                    .putExtra(
                        CompanionService.EXTRA_RECONCILE_REASON,
                        "provisioning:${trigger.reason}"
                    )
            )
            true
        } catch (error: Exception) {
            Log.e(TAG, "RoshanCore provisioning handoff failed.", error)
            false
        }

        if (!policiesApplied) {
            // CompanionService retries the same idempotent policy reconciliation.
            // Optional packages (for example Tailscale during staged enrollment)
            // must not force Android Managed Provisioning to roll back.
            Log.w(TAG, "Provisioning completed with policies pending reconciliation.")
        }

        return Result(
            isFullyManagedDevice = true,
            policiesApplied = policiesApplied,
            serviceStartRequested = serviceStartRequested
        )
    }
}
