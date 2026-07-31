package com.tabletcontrol.companion

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * Silent Android Enterprise handler that declares RoshanOS as a
 * fully-managed-device DPC only. It intentionally does not start services:
 * Android requires control to return to Setup immediately after mode selection.
 */
class GetProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action != DevicePolicyManager.ACTION_GET_PROVISIONING_MODE) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val allowedModes =
            intent.getIntegerArrayListExtra(
                DevicePolicyManager.EXTRA_PROVISIONING_ALLOWED_PROVISIONING_MODES
            )
        val selectedMode = ProvisioningModeSelection.selectFullyManagedMode(
            allowedModes = allowedModes,
            // Android 12+ requires the selected value to be in the supplied
            // allowlist. Android 10/11 predate that extra, so its absence is
            // valid there and fully managed is the only mode we return.
            requireExplicitAllowedMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
            fullyManagedMode =
                DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
        )

        if (selectedMode == null) {
            Log.w(TAG, "Managed Provisioning did not allow fully managed mode.")
            setResult(RESULT_CANCELED)
        } else {
            val result = Intent().putExtra(
                DevicePolicyManager.EXTRA_PROVISIONING_MODE,
                selectedMode
            )
            // Do not skip Android's education/disclosure UI. RoshanOS only
            // suppresses its own technical screens, not system disclosures.
            setResult(RESULT_OK, result)
        }
        finish()
    }

    private companion object {
        const val TAG = "RoshanProvisioning"
    }
}

/**
 * Android 10+ admin-integrated finalization callback. No RoshanOS Activity is
 * launched; the no-display activity applies policy, starts the foreground core
 * service, returns the result to Setup, and closes immediately.
 */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action != DevicePolicyManager.ACTION_ADMIN_POLICY_COMPLIANCE) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val result = ProvisioningFinalizer.finalizeFullyManagedDevice(
            applicationContext,
            ProvisioningFinalizer.Trigger.POLICY_COMPLIANCE
        )
        setResult(if (result.canCompleteProvisioning) RESULT_OK else RESULT_CANCELED)
        finish()
    }
}

/**
 * Android 8-11 legacy success callback retained for pre-Android-12 fully
 * managed provisioning. It is harmlessly idempotent if the receiver callback
 * or policy-compliance callback also runs.
 */
class ProvisioningSuccessfulActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action != DevicePolicyManager.ACTION_PROVISIONING_SUCCESSFUL) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val result = ProvisioningFinalizer.finalizeFullyManagedDevice(
            applicationContext,
            ProvisioningFinalizer.Trigger.PROVISIONING_SUCCESSFUL
        )
        setResult(if (result.canCompleteProvisioning) RESULT_OK else RESULT_CANCELED)
        finish()
    }
}
