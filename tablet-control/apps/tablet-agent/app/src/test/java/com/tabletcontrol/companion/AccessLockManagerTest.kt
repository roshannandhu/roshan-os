package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessLockManagerTest {
    private fun newState() = AccessLockStateMachine(
        defaultDurationMs = 300_000L,
        maximumDurationMs = 1_800_000L,
        minimumDurationMs = 1_000L
    )

    @Test
    fun defaultLockExpiresAgainstSuppliedMonotonicTime() {
        val state = newState()
        val locked = state.lock(nowElapsedRealtime = 10_000L, requestedDurationMs = null)

        assertTrue(locked.active)
        assertEquals(310_000L, locked.expiresAtElapsedRealtime)
        assertEquals(1L, state.snapshot(309_999L).remainingMs)
        val expired = state.snapshot(310_000L)
        assertFalse(expired.active)
        assertTrue(expired.policyClearUnconfirmed)
        assertTrue(expired.reportedLocked)
    }

    @Test
    fun requestedDurationIsBoundedAtBothEnds() {
        val state = newState()

        val short = state.lock(5_000L, 1L)
        assertEquals(1_000L, short.remainingMs)

        val long = state.lock(6_000L, Long.MAX_VALUE)
        assertEquals(1_800_000L, long.remainingMs)
    }

    @Test
    fun remoteReleaseInvalidatesPendingExpiryGeneration() {
        val state = newState()
        val first = state.lock(100L, null)

        state.release(policyClearConfirmed = true)
        val second = state.lock(200L, null)

        assertFalse(state.isCurrentGeneration(first.generation))
        assertTrue(state.isCurrentGeneration(second.generation))
    }

    @Test
    fun freshProcessStateIsAlwaysUnlocked() {
        val previousProcess = newState()
        previousProcess.lock(100L, null)

        val restartedProcess = newState()

        assertFalse(restartedProcess.snapshot(200L).active)
        assertEquals(0L, restartedProcess.snapshot(200L).remainingMs)
    }

    @Test
    fun explicitReleaseIsImmediate() {
        val state = newState()
        state.lock(100L, null)

        val released = state.release(policyClearConfirmed = true)

        assertFalse(released.active)
        assertFalse(released.policyClearUnconfirmed)
        assertFalse(released.reportedLocked)
        assertEquals(0L, released.expiresAtElapsedRealtime)
    }

    @Test
    fun failedPolicyClearNeverReportsAConfirmedUnlock() {
        val state = newState()
        state.lock(100L, null)

        val unconfirmed = state.release(policyClearConfirmed = false)

        assertFalse(unconfirmed.active)
        assertTrue(unconfirmed.policyClearUnconfirmed)
        assertTrue(unconfirmed.reportedLocked)
    }

    @Test
    fun successfulRetryClearsUnconfirmedPolicyState() {
        val state = newState()
        state.lock(100L, null)
        state.release(policyClearConfirmed = false)

        val confirmed = state.release(policyClearConfirmed = true)

        assertFalse(confirmed.active)
        assertFalse(confirmed.policyClearUnconfirmed)
        assertFalse(confirmed.reportedLocked)
    }

    @Test
    fun unconfirmedPolicyStateIsStillProcessOnly() {
        val previousProcess = newState()
        previousProcess.lock(100L, null)
        assertTrue(
            previousProcess.release(policyClearConfirmed = false).reportedLocked
        )

        val restartedProcess = newState()

        assertFalse(restartedProcess.snapshot(200L).reportedLocked)
    }
}
