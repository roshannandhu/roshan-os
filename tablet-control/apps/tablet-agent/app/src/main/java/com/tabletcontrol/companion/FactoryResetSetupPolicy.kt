package com.tabletcontrol.companion

/**
 * Pure decision table for the factory-reset setup entry point.
 *
 * Device Owner assignment remains Android Managed Provisioning's job. The
 * setup Activity only selects the next standards-compliant step.
 */
internal object FactoryResetSetupPolicy {
    enum class State {
        COMPLETE,
        RESET_REQUIRED,
        WIFI_REQUIRED,
        READY_TO_ENROLL
    }

    fun state(
        isDeviceOwner: Boolean,
        isDeviceProvisioned: Boolean,
        isWifiConnected: Boolean
    ): State = when {
        isDeviceOwner -> State.COMPLETE
        isDeviceProvisioned -> State.RESET_REQUIRED
        !isWifiConnected -> State.WIFI_REQUIRED
        else -> State.READY_TO_ENROLL
    }
}
