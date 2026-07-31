package com.tabletcontrol.companion

/**
 * Pure provisioning-mode selection kept separate from Android framework types
 * so the fully-managed-only decision can be covered by local JVM tests.
 */
internal object ProvisioningModeSelection {
    fun selectFullyManagedMode(
        allowedModes: List<Int>?,
        requireExplicitAllowedMode: Boolean,
        fullyManagedMode: Int
    ): Int? {
        if (allowedModes == null) {
            return if (requireExplicitAllowedMode) null else fullyManagedMode
        }
        return fullyManagedMode.takeIf { allowedModes.contains(it) }
    }
}
