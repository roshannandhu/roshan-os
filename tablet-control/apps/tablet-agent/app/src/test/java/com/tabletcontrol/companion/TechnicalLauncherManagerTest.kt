package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TechnicalLauncherManagerTest {
    @Test
    fun targetsEveryDeclaredTechnicalPackageExceptRoshanCore() {
        val targets = TechnicalLauncherPolicy.targetPackages(
            declaredTechnicalPackages = setOf(
                "com.tabletcontrol.companion",
                "com.tabletcontrol.camera",
                "com.tailscale.ipn",
                "com.pas.webcam",
                "com.topjohnwu.magisk",
                "com.termux",
                "app.lawnchair",
                "com.android.launcher3",
                "com.android.settings"
            ),
            discoveredFrontendPackages = emptySet(),
            roshanCorePackage = "com.tabletcontrol.companion",
            isTechnical = { false }
        )

        assertFalse("RoshanCore must retain its Home Activity", "com.tabletcontrol.companion" in targets)
        assertEquals(
            setOf(
                "com.tabletcontrol.camera",
                "com.pas.webcam",
                "com.topjohnwu.magisk",
                "com.termux",
                "app.lawnchair"
            ),
            targets
        )
    }

    @Test
    fun includesDiscoveredPrefixClassifiedTechnicalFrontends() {
        val targets = TechnicalLauncherPolicy.targetPackages(
            declaredTechnicalPackages = setOf("com.tailscale.ipn"),
            discoveredFrontendPackages = setOf(
                "com.termux.api",
                "com.tabletcontrol.legacy",
                "org.example.approved"
            ),
            roshanCorePackage = "com.tabletcontrol.companion",
            isTechnical = { packageName ->
                packageName.startsWith("com.termux") ||
                    packageName.startsWith("com.tabletcontrol.")
            }
        )

        assertTrue("com.termux.api" in targets)
        assertTrue("com.tabletcontrol.legacy" in targets)
        assertFalse("org.example.approved" in targets)
    }

    @Test
    fun restoreIsAllowedOnlyDuringProtectedMaintenance() {
        val normalModeRestore = TechnicalLauncherPolicy.visibilityDecision(
            hiddenFromNormalUser = false,
            protectedMaintenanceActive = false
        )
        assertTrue(normalModeRestore.hide)
        assertFalse(normalModeRestore.requestAccepted)

        val maintenanceRestore = TechnicalLauncherPolicy.visibilityDecision(
            hiddenFromNormalUser = false,
            protectedMaintenanceActive = true
        )
        assertFalse(maintenanceRestore.hide)
        assertTrue(maintenanceRestore.requestAccepted)
    }

    @Test
    fun normalUserReconciliationAlwaysHidesFrontends() {
        val decision = TechnicalLauncherPolicy.visibilityDecision(
            hiddenFromNormalUser = true,
            protectedMaintenanceActive = true
        )

        assertTrue(decision.hide)
        assertTrue(decision.requestAccepted)
    }
}
