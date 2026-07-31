package com.tabletcontrol.companion

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class TabletDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        val result = ProvisioningFinalizer.finalizeFullyManagedDevice(
            context,
            ProvisioningFinalizer.Trigger.ADMIN_ENABLED
        )
        if (result.isFullyManagedDevice) {
            Log.i(TAG, "RoshanOS Device Owner admin enabled.")
        } else {
            Log.i(TAG, "Device admin enabled; awaiting fully managed provisioning.")
        }
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        val result = ProvisioningFinalizer.finalizeFullyManagedDevice(
            context,
            ProvisioningFinalizer.Trigger.PROFILE_PROVISIONING_COMPLETE
        )
        if (result.isFullyManagedDevice) {
            Log.i(TAG, "Legacy fully managed provisioning callback completed.")
        } else {
            Log.w(TAG, "Rejected non-Device-Owner provisioning completion callback.")
        }
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.i(TAG, "RoshanOS device admin disabled.")
    }

    private companion object {
        const val TAG = "TabletDPC"
    }
}
