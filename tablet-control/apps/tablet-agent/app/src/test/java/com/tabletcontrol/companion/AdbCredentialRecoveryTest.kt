package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AdbCredentialRecoveryTest {
    private val validSecret = "A".repeat(64)

    @Test
    fun acceptsBase64UrlCredentialWithOneTerminalNewline() {
        assertEquals(
            validSecret,
            AdbCredentialRecovery.parsePayload("$validSecret\n".toByteArray())
        )
        assertEquals(
            validSecret,
            AdbCredentialRecovery.parsePayload("$validSecret\r\n".toByteArray())
        )
    }

    @Test
    fun rejectsLegacyShortWhitespaceAndMultilinePayloads() {
        assertNull(AdbCredentialRecovery.parsePayload("legacy-secret".toByteArray()))
        assertNull(AdbCredentialRecovery.parsePayload(" $validSecret".toByteArray()))
        assertNull(AdbCredentialRecovery.parsePayload("$validSecret\nextra".toByteArray()))
    }

    @Test
    fun rejectsOversizedAndMalformedUtf8Payloads() {
        assertNull(
            AdbCredentialRecovery.parsePayload(
                "A".repeat(AdbCredentialRecovery.MAX_SECRET_BYTES + 1).toByteArray()
            )
        )
        assertNull(AdbCredentialRecovery.parsePayload(byteArrayOf(0xc3.toByte(), 0x28)))
    }
}
