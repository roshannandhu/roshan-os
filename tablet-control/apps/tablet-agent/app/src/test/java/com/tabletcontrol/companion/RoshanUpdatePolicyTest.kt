package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoshanUpdatePolicyTest {
    private val controllerHost = "rogbook.tailba9d1b.ts.net"
    private val allowedHosts = setOf(controllerHost)

    @Test
    fun acceptsOnlyPinnedCredentialFreeTailscaleHttpsUrl() {
        val result = RoshanUpdatePolicy.validateUpdateUrl(
            "https://$controllerHost/api/v1/updates/RoshanCore-4.apk",
            allowedHosts
        )

        assertTrue(result.valid)
        assertEquals(controllerHost, result.value?.host)
        assertEquals(
            "https://$controllerHost/api/v1/updates/RoshanCore-4.apk",
            result.value?.canonicalUrl
        )
    }

    @Test
    fun rejectsCredentialsQueriesFragmentsAndNonHttpsUrls() {
        val rejected = listOf(
            "http://$controllerHost/update.apk",
            "https://user:secret@$controllerHost/update.apk",
            "https://$controllerHost/update.apk?token=secret",
            "https://$controllerHost/update.apk#secret",
            "https://$controllerHost:8443/update.apk",
            "https://$controllerHost"
        )

        rejected.forEach { value ->
            assertFalse(value, RoshanUpdatePolicy.validateUpdateUrl(value, allowedHosts).valid)
        }
    }

    @Test
    fun rejectsUnpinnedOrLookalikeHosts() {
        val rejected = listOf(
            "https://other.tailba9d1b.ts.net/update.apk",
            "https://$controllerHost.evil.example/update.apk",
            "https://ts.net/update.apk",
            "https://100.64.0.1/update.apk"
        )

        rejected.forEach { value ->
            assertEquals(
                value,
                "UPDATE_HOST_NOT_ALLOWED",
                RoshanUpdatePolicy.validateUpdateUrl(value, allowedHosts).errorCode
            )
        }
    }

    @Test
    fun parsesOnlyValidTailscaleControllerNamesFromBuildConfiguration() {
        assertEquals(
            setOf("one.tailnet.ts.net", "two.tailnet.ts.net"),
            RoshanUpdatePolicy.parseAllowedControllerHosts(
                " ONE.tailnet.ts.net,invalid.example,two.tailnet.ts.net "
            )
        )
    }

    @Test
    fun controllerOriginIsStrictTailscaleHttpsOriginWithoutUrlMaterial() {
        val accepted = RoshanUpdatePolicy.validateControllerOrigin(
            "https://$controllerHost/"
        )
        assertTrue(accepted.valid)
        assertEquals("https://$controllerHost", accepted.value?.canonicalOrigin)

        listOf(
            "http://$controllerHost",
            "https://owner@$controllerHost",
            "https://$controllerHost/path",
            "https://$controllerHost?token=value",
            "https://$controllerHost#fragment",
            "https://example.com"
        ).forEach { value ->
            assertFalse(value, RoshanUpdatePolicy.validateControllerOrigin(value).valid)
        }
    }

    @Test
    fun validatesChecksumsVersionsAndExactSignerSets() {
        val a = "a".repeat(64)
        val b = "b".repeat(64)

        assertEquals(a, RoshanUpdatePolicy.normalizeSha256(a.uppercase()))
        assertNull(RoshanUpdatePolicy.normalizeSha256("not-a-sha256"))
        assertTrue(RoshanUpdatePolicy.isStrictUpgrade(3L, 4L))
        assertFalse(RoshanUpdatePolicy.isStrictUpgrade(4L, 4L))
        assertFalse(RoshanUpdatePolicy.isStrictUpgrade(5L, 4L))
        assertTrue(RoshanUpdatePolicy.signerSetsExactlyMatch(listOf(a, b), listOf(b, a)))
        assertFalse(RoshanUpdatePolicy.signerSetsExactlyMatch(listOf(a), listOf(b)))
        assertFalse(RoshanUpdatePolicy.signerSetsExactlyMatch(listOf(a), listOf(a, b)))
        assertFalse(RoshanUpdatePolicy.signerSetsExactlyMatch(listOf(a, a), listOf(a)))
    }

    @Test
    fun statusPolicyDistinguishesUserInteractionFromInstallFailure() {
        assertEquals("USER_ACTION_REQUIRED", RoshanUpdatePolicy.installResultErrorCode(-1))
        assertEquals("INSTALL_BLOCKED", RoshanUpdatePolicy.installResultErrorCode(3))
        assertEquals("ROLLBACK_UNAVAILABLE", RoshanUpdatePolicy.rollbackResultErrorCode(2))
        assertTrue(RoshanUpdatePolicy.isInProgress("committing"))
        assertFalse(RoshanUpdatePolicy.isInProgress("applied"))
        assertNotNull(RoshanUpdatePolicy.installResultErrorCode(Int.MIN_VALUE))
    }

    @Test
    fun callbackMustMatchBothPersistedPhaseAndOperationId() {
        assertTrue(
            RoshanUpdatePolicy.callbackMatches(
                expectedState = "committing",
                currentState = "committing",
                persistedOperationId = 42,
                callbackOperationId = 42
            )
        )
        assertFalse(
            RoshanUpdatePolicy.callbackMatches(
                expectedState = "committing",
                currentState = "applied",
                persistedOperationId = null,
                callbackOperationId = 42
            )
        )
        assertFalse(
            RoshanUpdatePolicy.callbackMatches(
                expectedState = "committing",
                currentState = "committing",
                persistedOperationId = 43,
                callbackOperationId = 42
            )
        )
    }
}
