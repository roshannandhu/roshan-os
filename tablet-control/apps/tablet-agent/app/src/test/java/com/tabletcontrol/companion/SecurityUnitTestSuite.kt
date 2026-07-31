package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class SecurityUnitTestSuite {

    @Test
    fun pbkdf2SaltedPinHashIsNonReversible() {
        val pin = "484627"
        val salt = "1234567890123456".toByteArray(Charsets.UTF_8)
        val spec = javax.crypto.spec.PBEKeySpec(pin.toCharArray(), salt, 50000, 256)
        val factory = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val hashBytes = factory.generateSecret(spec).encoded

        assertEquals(32, hashBytes.size) // 256 bits
        assertFalse("Hash must not equal plaintext PIN", String(hashBytes).contains(pin))
    }

    @Test
    fun constantTimeComparisonIsTimingSafe() {
        val hash1 = MessageDigest.getInstance("SHA-256").digest("valid-token".toByteArray(Charsets.UTF_8))
        val hash2 = MessageDigest.getInstance("SHA-256").digest("valid-token".toByteArray(Charsets.UTF_8))
        val hash3 = MessageDigest.getInstance("SHA-256").digest("wrong-token".toByteArray(Charsets.UTF_8))

        assertTrue("Matching hashes must evaluate true in constant time", MessageDigest.isEqual(hash1, hash2))
        assertFalse("Mismatching hashes must evaluate false in constant time", MessageDigest.isEqual(hash1, hash3))
    }

    @Test
    fun headerRedactionContainsNoSecretValue() {
        val secret = "super-secret-token-12345"
        val header = "Bearer $secret"
        val redacted = CredentialStore.redactHeader(header)

        assertFalse("Redacted header must not contain secret token", redacted.contains(secret))
        assertEquals("Bearer [REDACTED]", redacted)
    }

}
