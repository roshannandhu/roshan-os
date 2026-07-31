package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RetryCircuitTest {
    @Test
    fun exponentialBackoffIsBoundedAndThenOpensCircuit() {
        val retry = RetryCircuit(
            initialDelayMs = 100,
            maximumDelayMs = 250,
            maximumRetryAttempts = 3,
            cooldownMs = 1_000
        )

        assertEquals(100L, retry.onFailure(0).delayMs)
        assertEquals(200L, retry.onFailure(100).delayMs)
        assertEquals(250L, retry.onFailure(300).delayMs)

        val open = retry.onFailure(550)
        assertEquals(RetryCircuit.Disposition.CIRCUIT_OPEN, open.disposition)
        assertTrue(open.circuitOpen)
        assertEquals(1_000L, open.delayMs)
    }

    @Test
    fun openCircuitSuppressesRetriesUntilCooldownExpires() {
        val retry = RetryCircuit(
            initialDelayMs = 10,
            maximumDelayMs = 20,
            maximumRetryAttempts = 1,
            cooldownMs = 100
        )

        assertEquals(RetryCircuit.Disposition.RETRY, retry.onFailure(0).disposition)
        retry.onFailure(10)

        val held = retry.onFailure(50)
        assertEquals(RetryCircuit.Disposition.CIRCUIT_OPEN, held.disposition)
        assertEquals(60L, held.delayMs)

        val afterCooldown = retry.onFailure(110)
        assertEquals(RetryCircuit.Disposition.RETRY, afterCooldown.disposition)
        assertEquals(1, afterCooldown.retryAttempt)
    }

    @Test
    fun successClosesCircuitAndResetsBackoff() {
        val retry = RetryCircuit(
            initialDelayMs = 25,
            maximumDelayMs = 100,
            maximumRetryAttempts = 2,
            cooldownMs = 500
        )

        retry.onFailure(0)
        retry.onFailure(25)
        retry.onFailure(75)
        assertTrue(retry.snapshot(100).circuitOpen)

        retry.onSuccess()
        val snapshot = retry.snapshot(100)
        assertFalse(snapshot.circuitOpen)
        assertEquals(0, snapshot.failures)
        assertEquals(25L, retry.onFailure(100).delayMs)
    }
}
