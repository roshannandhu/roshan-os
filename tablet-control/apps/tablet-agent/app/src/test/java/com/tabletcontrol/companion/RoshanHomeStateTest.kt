package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoshanHomeStateTest {
    @Test
    fun freshOfflineTabletUsesBrandedWifiSetup() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = false,
                hasSavedNetwork = false,
                enrolled = false,
                ownerPinConfigured = false
            )
        )

        assertTrue(state.showFirstRunWifiSetup)
        assertFalse(state.preserveCurrentContent)
        assertEquals("Wi-Fi setup", state.connectionLabel)
        assertEquals("Owner setup required", state.enrollmentLabel)
    }

    @Test
    fun enrolledWifiLossPreservesHomeAndReconnects() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = false,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                wifiGraceActive = true
            )
        )

        assertFalse(state.showFirstRunWifiSetup)
        assertTrue(state.preserveCurrentContent)
        assertEquals("Offline • Reconnecting", state.connectionLabel)
        assertEquals("", state.enrollmentLabel)
    }

    @Test
    fun sustainedWifiLossReturnsEnrolledTabletToRestrictedSetup() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = false,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                wifiGraceActive = false
            )
        )

        assertTrue(state.showFirstRunWifiSetup)
        assertFalse(state.preserveCurrentContent)
    }

    @Test
    fun firstRunProvisioningAndServiceRecoveryRemainGated() {
        val enrollment = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = false,
                ownerPinConfigured = true
            )
        )
        assertEquals(RoshanHomeUiState.SetupStep.ENROLLMENT, enrollment.setupStep)

        val recovery = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                privateNetworkConnected = true,
                requiredServicesReady = false
            )
        )
        assertEquals(RoshanHomeUiState.SetupStep.RECOVERY, recovery.setupStep)
    }

    @Test
    fun connectedUnenrolledTabletShowsAdbProvisioningRequirement() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = false,
                ownerPinConfigured = true
            )
        )

        assertFalse(state.showFirstRunWifiSetup)
        assertEquals("Connected", state.connectionLabel)
        assertEquals("ADB provisioning required", state.enrollmentLabel)
    }

    @Test
    fun connectedFirstRunTabletCannotReachHomeBeforeOwnerPinConfirmation() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = false,
                ownerPinConfigured = false
            )
        )

        assertTrue(state.showSetupGate)
        assertEquals(RoshanHomeUiState.SetupStep.OWNER_PIN, state.setupStep)
        assertFalse(state.preserveCurrentContent)
        assertEquals("Owner setup required", state.enrollmentLabel)
    }

    @Test
    fun offlineLegacyEnrollmentRequiresWifiBeforeOwnerPin() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = false,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = false
            )
        )

        assertEquals(RoshanHomeUiState.SetupStep.WIFI, state.setupStep)
        assertTrue(state.showSetupGate)
        assertFalse(state.preserveCurrentContent)
    }

    @Test
    fun wifiCredentialsAreValidatedWithoutPersistingThem() {
        assertFalse(RoshanSetupPolicy.validateWifi("", null, null).valid)
        assertFalse(RoshanSetupPolicy.validateWifi("Office", "", true).valid)
        assertFalse(RoshanSetupPolicy.validateWifi("Office", "short", true).valid)
        assertTrue(RoshanSetupPolicy.validateWifi("Guest", null, false).valid)
        assertTrue(RoshanSetupPolicy.validateWifi("Office", "correct-horse", true).valid)
    }

    @Test
    fun bannerTextShowsConnectionAndEnrollmentLabel() {
        val enrolled = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                privateNetworkConnected = true,
                requiredServicesReady = true
            )
        )
        assertEquals("Connected", RoshanHomeState.bannerText(enrolled))

        val unenrolled = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = false,
                ownerPinConfigured = true
            )
        )
        assertEquals("Connected  •  ADB provisioning required", RoshanHomeState.bannerText(unenrolled))
    }

    @Test
    fun optionalPrivateNetworkLossDoesNotGateEnrolledHome() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                readinessKnown = true,
                privateNetworkConnected = false,
                requiredServicesReady = true
            )
        )

        assertEquals(RoshanHomeUiState.SetupStep.NONE, state.setupStep)
        assertTrue(state.preserveCurrentContent)
        assertEquals("Private network offline", state.connectionLabel)
    }

    @Test
    fun requiredServiceRecoveryStillGatesEnrolledHome() {
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = true,
                hasSavedNetwork = true,
                enrolled = true,
                ownerPinConfigured = true,
                readinessKnown = true,
                privateNetworkConnected = true,
                requiredServicesReady = false
            )
        )

        assertEquals(RoshanHomeUiState.SetupStep.RECOVERY, state.setupStep)
        assertFalse(state.preserveCurrentContent)
    }
}
