package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class DirectBootRequestPolicyTest {
    @Test
    fun onlyGetHealthIsAvailableBeforeUserUnlock() {
        assertEquals(
            DirectBootRequestPolicy.Decision.HEALTH,
            DirectBootRequestPolicy.decide("GET", "/health")
        )
        listOf(
            "POST" to "/health",
            "GET" to "/api/v1/companion/status",
            "POST" to "/api/v1/companion/pair",
            "GET" to "/",
            "GET" to "/clock"
        ).forEach { (method, path) ->
            assertEquals(
                DirectBootRequestPolicy.Decision.LOCKED,
                DirectBootRequestPolicy.decide(method, path)
            )
        }
    }
}
