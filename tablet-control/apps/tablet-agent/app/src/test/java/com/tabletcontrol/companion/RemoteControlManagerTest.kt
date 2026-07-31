package com.tabletcontrol.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteControlManagerTest {
    @Test
    fun safeTextAllowlistRejectsShellSyntaxAndNewlines() {
        assertTrue(RemoteControlManager.isValidText("RoshanOS tablet 01!"))
        assertFalse(RemoteControlManager.isValidText("hello; reboot"))
        assertFalse(RemoteControlManager.isValidText("$(id)"))
        assertFalse(RemoteControlManager.isValidText("line one\nline two"))
        assertFalse(RemoteControlManager.isValidText(""))
        assertFalse(RemoteControlManager.isValidText("a".repeat(121)))
    }

    @Test
    fun packageValidationAcceptsOnlyCanonicalAndroidNames() {
        assertTrue(RemoteControlManager.isValidPackageName("com.example.reader"))
        assertTrue(RemoteControlManager.isValidPackageName("org.videolan.vlc"))
        assertFalse(RemoteControlManager.isValidPackageName("com.example.reader;reboot"))
        assertFalse(RemoteControlManager.isValidPackageName("../data/app"))
        assertFalse(RemoteControlManager.isValidPackageName("single"))
    }
}
