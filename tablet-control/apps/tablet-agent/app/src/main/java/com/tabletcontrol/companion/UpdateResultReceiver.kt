package com.tabletcontrol.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

/**
 * Explicit PendingIntent target for PackageInstaller and RollbackManager.
 * It is unexported and has no intent filter.
 */
class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_INSTALL_RESULT -> {
                val operationId = intent.getIntExtra(EXTRA_OPERATION_ID, -1)
                val reportedSessionId = intent.getIntExtra(
                    PackageInstaller.EXTRA_SESSION_ID,
                    operationId
                )
                if (operationId < 0 || reportedSessionId != operationId) return
                val status = intent.getIntExtra(
                    PackageInstaller.EXTRA_STATUS,
                    PackageInstaller.STATUS_FAILURE
                )
                RoshanUpdateManager.handleInstallResult(
                    context.applicationContext,
                    operationId,
                    status
                )
            }
            ACTION_ROLLBACK_RESULT -> {
                val operationId = intent.getIntExtra(EXTRA_OPERATION_ID, -1)
                if (operationId < 0) return
                val status = intent.getIntExtra(
                    ROLLBACK_EXTRA_STATUS,
                    ROLLBACK_STATUS_FAILURE
                )
                RoshanUpdateManager.handleRollbackResult(
                    context.applicationContext,
                    operationId,
                    status
                )
            }
        }
    }

    companion object {
        const val ACTION_INSTALL_RESULT =
            "com.tabletcontrol.companion.action.ROSHAN_UPDATE_INSTALL_RESULT"
        const val ACTION_ROLLBACK_RESULT =
            "com.tabletcontrol.companion.action.ROSHAN_UPDATE_ROLLBACK_RESULT"
        const val EXTRA_OPERATION_ID =
            "com.tabletcontrol.companion.extra.ROSHAN_UPDATE_OPERATION_ID"
        private const val ROLLBACK_EXTRA_STATUS =
            "android.content.rollback.extra.STATUS"
        private const val ROLLBACK_STATUS_FAILURE = 1
    }
}
