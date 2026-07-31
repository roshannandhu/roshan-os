package com.tabletcontrol.companion

import android.content.Context
import android.util.Log

/**
 * Provisioning status for RoshanOS tablet.
 *
 * The old pairing-code flow has been replaced with secure ADB provisioning.
 * During installation, provision-tablet-via-adb.ps1 writes a credential into
 * the app-private files directory. AdbCredentialRecovery picks it up on the
 * next RoshanCore start and provisions it into the Android Keystore.
 *
 * This object exists for backward compatibility with state machine references
 * that check whether pairing is active. It always returns "not active" —
 * provisioning is handled entirely offline via ADB.
 */
object PairingManager {
    private const val TAG = "PairingManager"

    fun isPairingActive(): Boolean = false

    fun currentSession(): Nothing? = null

    fun closePairingMode() {
        Log.i(TAG, "Pairing mode is unused — credential provisioning uses ADB only.")
    }
}
