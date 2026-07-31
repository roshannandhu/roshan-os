package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class RoshanReadinessPolicyTest {
    private fun snapshot(
        homeReady: Boolean,
        everReady: Boolean,
        unreadySince: Long
    ) = RoshanRuntimeReadinessSnapshot(
        known = true,
        wifiConnected = homeReady,
        privateNetworkConnected = homeReady,
        requiredServicesReady = homeReady,
        homeReady = homeReady,
        hasEverBeenReady = everReady,
        unreadySinceElapsedMs = unreadySince,
        updatedAtElapsedMs = unreadySince,
        reasonCode = if (homeReady) "ready" else "services_recovery"
    )

    @Test
    fun firstBootFailureHasNoHomeGrace() {
        assertEquals(
            0L,
            RoshanReadinessPolicy.graceRemainingMs(
                snapshot(homeReady = false, everReady = false, unreadySince = 1_000L),
                1_001L
            )
        )
    }

    @Test
    fun previouslyReadyTabletGetsOnlyBoundedGrace() {
        val unavailable = snapshot(
            homeReady = false,
            everReady = true,
            unreadySince = 10_000L
        )
        assertEquals(119_000L, RoshanReadinessPolicy.graceRemainingMs(unavailable, 11_000L))
        assertEquals(0L, RoshanReadinessPolicy.graceRemainingMs(unavailable, 130_000L))
    }

    @Test
    fun readyStateNeverNeedsGrace() {
        assertEquals(
            0L,
            RoshanReadinessPolicy.graceRemainingMs(
                snapshot(homeReady = true, everReady = true, unreadySince = 0L),
                100_000L
            )
        )
    }
}
