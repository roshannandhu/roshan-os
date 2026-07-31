package com.tabletcontrol.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialStorePolicyTest {
    @Test
    fun acceptsControllerGeneratedBase64UrlSecret() {
        assertTrue(
            CredentialStore.isValidProvisioningSecret(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
            )
        )
    }

    @Test
    fun rejectsLegacyShortOrNonBase64UrlSecretsForNewProvisioning() {
        assertFalse(CredentialStore.isValidProvisioningSecret("legacy-secret-123"))
        assertFalse(
            CredentialStore.isValidProvisioningSecret(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN!@#$%^&*()"
            )
        )
    }
}
