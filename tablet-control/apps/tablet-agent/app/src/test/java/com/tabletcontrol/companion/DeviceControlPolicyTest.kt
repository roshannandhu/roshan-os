package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceControlPolicyTest {
    @Test
    fun privilegedControlsAcceptOnlyClosedTypedValues() {
        assertTrue(DeviceControlPolicy.isValidBrightnessMode("manual"))
        assertTrue(DeviceControlPolicy.isValidBrightnessMode("automatic"))
        assertFalse(DeviceControlPolicy.isValidBrightnessMode("auto; reboot"))

        assertTrue(DeviceControlPolicy.isValidScreenTimeoutSeconds(15))
        assertTrue(DeviceControlPolicy.isValidScreenTimeoutSeconds(1800))
        assertFalse(DeviceControlPolicy.isValidScreenTimeoutSeconds(0))
        assertFalse(DeviceControlPolicy.isValidScreenTimeoutSeconds(1801))

        assertTrue(DeviceControlPolicy.isTypedLock("lock"))
        assertFalse(DeviceControlPolicy.isTypedLock("unlock"))
        assertTrue(DeviceControlPolicy.isConfirmedShutdown("shutdown", true))
        assertFalse(DeviceControlPolicy.isConfirmedShutdown("shutdown", false))
        assertFalse(DeviceControlPolicy.isConfirmedShutdown("reboot", true))
    }

    @Test
    fun foregroundParserAcceptsOnlyAndroidPackageIdentifiers() {
        assertEquals(
            "com.spotify.music",
            DeviceControlPolicy.parseForegroundPackage(
                "topResumedActivity=ActivityRecord{abc u0 com.spotify.music/.MainActivity t42}"
            )
        )
        assertEquals(
            "org.fossify.calendar",
            DeviceControlPolicy.parseForegroundPackage(
                "mCurrentFocus=Window{abc u0 org.fossify.calendar/org.fossify.calendar.Main}"
            )
        )
        assertNull(
            DeviceControlPolicy.parseForegroundPackage(
                "mResumedActivity: ActivityRecord{abc u0 com.good.app;reboot/.Main t4}"
            )
        )
        assertNull(DeviceControlPolicy.parseForegroundPackage("arbitrary diagnostic output"))
    }

    @Test
    fun foregroundClassificationDoesNotExposeTechnicalAppsAsApproved() {
        val approved = setOf("com.spotify.music")
        val technical = setOf("com.tailscale.ipn")

        assertEquals(
            "approved",
            DeviceControlPolicy.foregroundState(
                "com.spotify.music",
                "com.tabletcontrol.companion",
                approved,
                technical
            )
        )
        assertEquals(
            "technical",
            DeviceControlPolicy.foregroundState(
                "com.tailscale.ipn",
                "com.tabletcontrol.companion",
                approved,
                technical
            )
        )
        assertEquals(
            "roshanos",
            DeviceControlPolicy.foregroundState(
                "com.tabletcontrol.companion",
                "com.tabletcontrol.companion",
                approved,
                technical
            )
        )
        assertEquals(
            "unapproved",
            DeviceControlPolicy.foregroundState(
                "com.example.pending",
                "com.tabletcontrol.companion",
                approved,
                technical
            )
        )
        assertEquals(
            "unknown",
            DeviceControlPolicy.foregroundState(
                null,
                "com.tabletcontrol.companion",
                approved,
                technical
            )
        )
    }

    @Test
    fun bootRecoveryAndStorageHealthRemainHonest() {
        assertEquals("unknown", DeviceControlPolicy.bootRecoveryState(null, null))
        assertEquals("recovering", DeviceControlPolicy.bootRecoveryState(false, 0L))
        assertEquals("degraded", DeviceControlPolicy.bootRecoveryState(false, 100L))
        assertEquals("succeeded", DeviceControlPolicy.bootRecoveryState(true, 100L))

        assertEquals(
            DeviceControlPolicy.MIN_STORAGE_RESERVE_BYTES,
            DeviceControlPolicy.storageReserveBytes(2L * 1024L * 1024L * 1024L)
        )
        assertTrue(DeviceControlPolicy.isStorageLow(100L * 1024L * 1024L, 4L * 1024L * 1024L * 1024L))
        assertFalse(DeviceControlPolicy.isStorageLow(2L * 1024L * 1024L * 1024L, 8L * 1024L * 1024L * 1024L))
    }

    @Test
    fun destructiveActionGateRejectsRapidRepeats() {
        val gate = DeviceControlPolicy.ActionGate(60_000L)
        assertTrue(gate.tryAcquire(10_000L))
        assertFalse(gate.tryAcquire(69_999L))
        assertTrue(gate.tryAcquire(70_000L))
    }
}
