package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TailscaleEnrollmentPolicyTest {
    private val validKey =
        "tskey-auth-k1234567890abcDEF-1234567890abcDEF"

    @Test
    fun acceptsOnlyExactTypedPayloadAndBoundedAuthKey() {
        val result = TailscaleEnrollmentPolicy.validateRequest(
            mapOf(
                "authKey" to validKey,
                "timeoutSeconds" to 120
            )
        )

        assertTrue(result.valid)
        assertEquals(validKey, result.request?.authKey)
        assertEquals(120, result.request?.timeoutSeconds)
        assertNull(result.errorCode)

        assertFalse(
            TailscaleEnrollmentPolicy.validateRequest(
                mapOf(
                    "authKey" to validKey,
                    "timeoutSeconds" to 120,
                    "arbitraryPolicy" to "value"
                )
            ).valid
        )
        assertFalse(
            TailscaleEnrollmentPolicy.validateRequest(
                mapOf("authKey" to validKey)
            ).valid
        )
    }

    @Test
    fun rejectsWhitespaceControlCharactersWrongPrefixesAndUnboundedTimeouts() {
        listOf(
            " $validKey",
            "$validKey\n",
            "auth-$validKey",
            "tskey-auth-short",
            "tskey-auth-${"a".repeat(300)}",
            "tskey-auth-valid;reboot"
        ).forEach { value ->
            assertFalse(value, TailscaleEnrollmentPolicy.isValidAuthKey(value))
        }

        listOf(29, 301, 120.5, Double.NaN).forEach { timeout ->
            assertFalse(
                timeout.toString(),
                TailscaleEnrollmentPolicy.validateRequest(
                    mapOf(
                        "authKey" to validKey,
                        "timeoutSeconds" to timeout
                    )
                ).valid
            )
        }
    }

    @Test
    fun consumptionNeedsConfiguredTailscaleVpnAndStrongNetworkProof() {
        val unconfigured = TailscaleEnrollmentPolicy.ConnectivityProof(
            alwaysOnVpnConfigured = false,
            vpnTransportDetected = true,
            vpnValidated = true,
            tailnetAddressDetected = true
        )
        val noVpn = unconfigured.copy(
            alwaysOnVpnConfigured = true,
            vpnTransportDetected = false
        )
        val validatedVpn = unconfigured.copy(
            alwaysOnVpnConfigured = true,
            tailnetAddressDetected = false
        )
        val tailnetVpn = unconfigured.copy(
            alwaysOnVpnConfigured = true,
            vpnValidated = false
        )

        assertFalse(unconfigured.enrollmentConnectivitySatisfied)
        assertFalse(noVpn.enrollmentConnectivitySatisfied)
        assertTrue(validatedVpn.enrollmentConnectivitySatisfied)
        assertTrue(tailnetVpn.enrollmentConnectivitySatisfied)
    }

    @Test
    fun completionPrioritizesProofAndOtherwiseTimesOutExactlyAtDeadline() {
        val absent = TailscaleEnrollmentPolicy.ConnectivityProof(
            alwaysOnVpnConfigured = true,
            vpnTransportDetected = false,
            vpnValidated = false,
            tailnetAddressDetected = false
        )
        val proven = absent.copy(
            vpnTransportDetected = true,
            tailnetAddressDetected = true
        )

        assertEquals(
            TailscaleEnrollmentPolicy.CompletionDecision.WAIT,
            TailscaleEnrollmentPolicy.completionDecision(999, 1_000, absent)
        )
        assertEquals(
            TailscaleEnrollmentPolicy.CompletionDecision.TIME_OUT,
            TailscaleEnrollmentPolicy.completionDecision(1_000, 1_000, absent)
        )
        assertEquals(
            TailscaleEnrollmentPolicy.CompletionDecision.SUCCEED,
            TailscaleEnrollmentPolicy.completionDecision(2_000, 1_000, proven)
        )
    }

    @Test
    fun recognizesOnlyTailscaleCgnatAndDocumentedIpv6Prefix() {
        assertTrue(
            TailscaleEnrollmentPolicy.isTailnetAddress(
                byteArrayOf(100, 64, 0, 1)
            )
        )
        assertTrue(
            TailscaleEnrollmentPolicy.isTailnetAddress(
                byteArrayOf(100, 127, 255.toByte(), 254.toByte())
            )
        )
        assertFalse(
            TailscaleEnrollmentPolicy.isTailnetAddress(
                byteArrayOf(100, 128.toByte(), 0, 1)
            )
        )
        assertFalse(
            TailscaleEnrollmentPolicy.isTailnetAddress(
                byteArrayOf(10, 0, 0, 1)
            )
        )

        val tailscaleV6 = ByteArray(16).apply {
            this[0] = 0xfd.toByte()
            this[1] = 0x7a
            this[2] = 0x11
            this[3] = 0x5c
            this[4] = 0xa1.toByte()
            this[5] = 0xe0.toByte()
        }
        assertTrue(TailscaleEnrollmentPolicy.isTailnetAddress(tailscaleV6))
        tailscaleV6[5] = 0xe1.toByte()
        assertFalse(TailscaleEnrollmentPolicy.isTailnetAddress(tailscaleV6))
    }
}
