package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class FactoryResetSetupPolicyTest {
    @Test
    fun deviceOwnerAlwaysCompletesSetupBridge() {
        for (provisioned in listOf(false, true)) {
            for (wifi in listOf(false, true)) {
                assertEquals(
                    FactoryResetSetupPolicy.State.COMPLETE,
                    FactoryResetSetupPolicy.state(
                        isDeviceOwner = true,
                        isDeviceProvisioned = provisioned,
                        isWifiConnected = wifi
                    )
                )
            }
        }
    }

    @Test
    fun provisionedDeviceWithoutOwnerRequiresReset() {
        assertEquals(
            FactoryResetSetupPolicy.State.RESET_REQUIRED,
            FactoryResetSetupPolicy.state(
                isDeviceOwner = false,
                isDeviceProvisioned = true,
                isWifiConnected = true
            )
        )
    }

    @Test
    fun unprovisionedDeviceRequiresWifiBeforeEnrollment() {
        assertEquals(
            FactoryResetSetupPolicy.State.WIFI_REQUIRED,
            FactoryResetSetupPolicy.state(
                isDeviceOwner = false,
                isDeviceProvisioned = false,
                isWifiConnected = false
            )
        )
    }

    @Test
    fun unprovisionedWifiDeviceIsReadyForAndroidEnrollment() {
        assertEquals(
            FactoryResetSetupPolicy.State.READY_TO_ENROLL,
            FactoryResetSetupPolicy.state(
                isDeviceOwner = false,
                isDeviceProvisioned = false,
                isWifiConnected = true
            )
        )
    }
}
