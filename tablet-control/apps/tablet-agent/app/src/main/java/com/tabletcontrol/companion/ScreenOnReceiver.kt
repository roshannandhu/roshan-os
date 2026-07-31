package com.tabletcontrol.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Kept for binary compatibility with older installs. Screen state is not a
 * server lifecycle signal: waking the display must never launch an Activity or
 * take ownership of the external IP Webcam process.
 */
class ScreenOnReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_SCREEN_ON) {
            Log.d(TAG, "Screen-on observed; no foreground or external-app action required")
        }
    }

    private companion object {
        const val TAG = "ScreenOnReceiver"
    }
}
