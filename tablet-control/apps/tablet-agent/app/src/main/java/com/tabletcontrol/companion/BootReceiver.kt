package com.tabletcontrol.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager
import android.util.Log

/**
 * Boot has one responsibility: hand off to the silent RoshanCore coordinator.
 * External server packages are observed by the supervisor and are never launched
 * from this receiver.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in SUPPORTED_ACTIONS) return

        val pendingResult = goAsync()
        val appContext = context.applicationContext
        Thread({
            val userUnlocked = try {
                val userManager =
                    appContext.getSystemService(Context.USER_SERVICE) as UserManager
                userManager.isUserUnlocked
            } catch (_: Exception) {
                false
            }
            try {
                if (
                    action == Intent.ACTION_MY_PACKAGE_REPLACED &&
                    userUnlocked
                ) {
                    RoshanUpdateManager.onPackageReplaced(appContext)
                }
                if (userUnlocked) {
                    DiagnosticEventStore.info(
                        appContext,
                        component = "boot",
                        event = "handoff_requested",
                        fields = mapOf("trigger" to triggerCode(action))
                    )
                }
                if (action == Intent.ACTION_BOOT_COMPLETED && userUnlocked) {
                    // Maintenance and Access Lock are temporary owner sessions.
                    // A real reboot must restore ordinary unlocked policy.
                    DevicePolicyController.exitMaintenanceMode(appContext)
                }
                appContext.startForegroundService(
                    Intent(appContext, CompanionService::class.java)
                        .setAction(CompanionService.ACTION_RECONCILE)
                        .putExtra(CompanionService.EXTRA_RECONCILE_REASON, "boot:$action")
                )
                if (userUnlocked) {
                    DiagnosticEventStore.info(
                        appContext,
                        component = "boot",
                        event = "handoff_completed",
                        fields = mapOf("trigger" to triggerCode(action))
                    )
                }
                Log.i(TAG, "Silent RoshanCore handoff completed for $action")
            } catch (error: Exception) {
                if (userUnlocked) {
                    DiagnosticEventStore.error(
                        appContext,
                        component = "boot",
                        event = "handoff_failed",
                        fields = mapOf(
                            "trigger" to triggerCode(action),
                            "error_class" to error.javaClass.simpleName
                        )
                    )
                }
                Log.e(TAG, "RoshanCore handoff failed for $action", error)
            } finally {
                pendingResult.finish()
            }
        }, "roshan-boot-handoff").start()
    }

    private companion object {
        const val TAG = "CompanionBoot"

        val SUPPORTED_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_USER_UNLOCKED,
            Intent.ACTION_MY_PACKAGE_REPLACED
        )

        fun triggerCode(action: String): String = when (action) {
            Intent.ACTION_BOOT_COMPLETED -> "boot_completed"
            Intent.ACTION_LOCKED_BOOT_COMPLETED -> "locked_boot_completed"
            Intent.ACTION_USER_UNLOCKED -> "user_unlocked"
            Intent.ACTION_MY_PACKAGE_REPLACED -> "package_replaced"
            else -> "unsupported"
        }
    }
}
