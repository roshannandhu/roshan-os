package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProvisioningModeSelectionTest {
    private val fullyManaged = 1
    private val managedProfile = 2

    @Test
    fun `selects fully managed when explicitly allowed`() {
        assertEquals(
            fullyManaged,
            ProvisioningModeSelection.selectFullyManagedMode(
                allowedModes = listOf(managedProfile, fullyManaged),
                requireExplicitAllowedMode = true,
                fullyManagedMode = fullyManaged
            )
        )
    }

    @Test
    fun `rejects managed profile only provisioning`() {
        assertNull(
            ProvisioningModeSelection.selectFullyManagedMode(
                allowedModes = listOf(managedProfile),
                requireExplicitAllowedMode = true,
                fullyManagedMode = fullyManaged
            )
        )
    }

    @Test
    fun `requires allowlist on Android 12 and newer`() {
        assertNull(
            ProvisioningModeSelection.selectFullyManagedMode(
                allowedModes = null,
                requireExplicitAllowedMode = true,
                fullyManagedMode = fullyManaged
            )
        )
    }

    @Test
    fun `accepts missing allowlist on Android 10 and 11`() {
        assertEquals(
            fullyManaged,
            ProvisioningModeSelection.selectFullyManagedMode(
                allowedModes = null,
                requireExplicitAllowedMode = false,
                fullyManagedMode = fullyManaged
            )
        )
    }

    @Test
    fun `rejects empty allowlist on every platform`() {
        assertNull(
            ProvisioningModeSelection.selectFullyManagedMode(
                allowedModes = emptyList(),
                requireExplicitAllowedMode = false,
                fullyManagedMode = fullyManaged
            )
        )
    }
}
