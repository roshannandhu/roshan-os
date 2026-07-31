package com.tabletcontrol.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.VersionedPackage
import android.os.Build

/**
 * Guarded adapter around Android 10/11's hidden SystemApi rollback surface.
 *
 * The public Android SDK does not expose RollbackManager. Reflection is used
 * only after checking the privileged permission, and every failure is reported
 * as unavailable. There is no shell fallback and no automatic rollback claim.
 */
object RoshanRollbackBridge {
    const val MANAGE_ROLLBACKS_PERMISSION = "android.permission.MANAGE_ROLLBACKS"
    private const val ROLLBACK_SERVICE = "rollback"
    private const val ROLLBACK_DATA_POLICY_RETAIN = 2

    data class AvailableRollback(
        val rollbackId: Int,
        val versionRolledBackFrom: Long,
        val versionRolledBackTo: Long
    )

    data class Availability(
        val platformApiPresent: Boolean,
        val permissionGranted: Boolean,
        val availableRollback: AvailableRollback?,
        val reasonCode: String?
    ) {
        val supported: Boolean
            get() = platformApiPresent && permissionGranted
        val available: Boolean
            get() = supported && availableRollback != null
    }

    data class EnableResult(
        val requested: Boolean,
        val reasonCode: String?
    )

    fun requestEnableRollback(
        context: Context,
        params: PackageInstaller.SessionParams
    ): EnableResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return EnableResult(false, "ROLLBACK_API_UNAVAILABLE")
        }
        if (!hasManagePermission(context)) {
            return EnableResult(false, "ROLLBACK_PERMISSION_MISSING")
        }
        return try {
            val method = params.javaClass.getMethod(
                "setEnableRollback",
                Boolean::class.javaPrimitiveType,
                Int::class.javaPrimitiveType
            )
            // RETAIN preserves enrollment, controller-origin pinning, and the
            // durable rollback journal across a code rollback.
            method.invoke(params, true, ROLLBACK_DATA_POLICY_RETAIN)
            EnableResult(true, null)
        } catch (_: Exception) {
            EnableResult(false, "ROLLBACK_API_INACCESSIBLE")
        }
    }

    fun availability(context: Context): Availability {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return Availability(
                platformApiPresent = false,
                permissionGranted = false,
                availableRollback = null,
                reasonCode = "ROLLBACK_API_UNAVAILABLE"
            )
        }
        val permissionGranted = hasManagePermission(context)
        if (!permissionGranted) {
            return Availability(
                platformApiPresent = serviceAndMethodsPresent(context),
                permissionGranted = false,
                availableRollback = null,
                reasonCode = "ROLLBACK_PERMISSION_MISSING"
            )
        }

        return try {
            val manager = context.getSystemService(ROLLBACK_SERVICE)
                ?: return Availability(true, true, null, "ROLLBACK_SERVICE_UNAVAILABLE")
            val method = manager.javaClass.getMethod("getAvailableRollbacks")
            val rollbacks = method.invoke(manager) as? List<*>
                ?: return Availability(true, true, null, "ROLLBACK_RESPONSE_INVALID")
            val matching = rollbacks.asSequence()
                .mapNotNull(::readMatchingRollback)
                .firstOrNull()
            Availability(
                platformApiPresent = true,
                permissionGranted = true,
                availableRollback = matching,
                reasonCode = if (matching == null) "NO_ROLLBACK_AVAILABLE" else null
            )
        } catch (_: SecurityException) {
            Availability(true, false, null, "ROLLBACK_PERMISSION_REJECTED")
        } catch (_: Exception) {
            Availability(false, true, null, "ROLLBACK_API_INACCESSIBLE")
        }
    }

    fun commit(
        context: Context,
        rollback: AvailableRollback
    ): Boolean {
        if (!hasManagePermission(context)) return false
        return try {
            val manager = context.getSystemService(ROLLBACK_SERVICE) ?: return false
            val callback = PendingIntent.getBroadcast(
                context,
                rollback.rollbackId,
                Intent(context, UpdateResultReceiver::class.java)
                    .setAction(UpdateResultReceiver.ACTION_ROLLBACK_RESULT)
                    .putExtra(
                        UpdateResultReceiver.EXTRA_OPERATION_ID,
                        rollback.rollbackId
                    ),
                PendingIntent.FLAG_CANCEL_CURRENT or mutablePendingIntentFlag()
            )
            val causes = listOf(
                VersionedPackage(
                    RoshanUpdatePolicy.PACKAGE_NAME,
                    rollback.versionRolledBackFrom
                )
            )
            val method = manager.javaClass.getMethod(
                "commitRollback",
                Int::class.javaPrimitiveType,
                List::class.java,
                IntentSender::class.java
            )
            method.invoke(
                manager,
                rollback.rollbackId,
                causes,
                callback.intentSender
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun readMatchingRollback(rollbackInfo: Any?): AvailableRollback? {
        rollbackInfo ?: return null
        return try {
            val rollbackId = rollbackInfo.javaClass
                .getMethod("getRollbackId")
                .invoke(rollbackInfo) as? Int ?: return null
            val packages = rollbackInfo.javaClass
                .getMethod("getPackages")
                .invoke(rollbackInfo) as? List<*> ?: return null
            val matching = packages.firstOrNull { packageInfo ->
                packageInfo != null &&
                    packageInfo.javaClass
                        .getMethod("getPackageName")
                        .invoke(packageInfo) == RoshanUpdatePolicy.PACKAGE_NAME
            } ?: return null
            val from = matching.javaClass
                .getMethod("getVersionRolledBackFrom")
                .invoke(matching) as? VersionedPackage ?: return null
            val to = matching.javaClass
                .getMethod("getVersionRolledBackTo")
                .invoke(matching) as? VersionedPackage ?: return null
            if (
                from.packageName != RoshanUpdatePolicy.PACKAGE_NAME ||
                to.packageName != RoshanUpdatePolicy.PACKAGE_NAME ||
                from.longVersionCode <= to.longVersionCode
            ) {
                return null
            }
            AvailableRollback(
                rollbackId = rollbackId,
                versionRolledBackFrom = from.longVersionCode,
                versionRolledBackTo = to.longVersionCode
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun serviceAndMethodsPresent(context: Context): Boolean {
        return try {
            val manager = context.getSystemService(ROLLBACK_SERVICE) ?: return false
            manager.javaClass.getMethod("getAvailableRollbacks")
            manager.javaClass.getMethod(
                "commitRollback",
                Int::class.javaPrimitiveType,
                List::class.java,
                IntentSender::class.java
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun hasManagePermission(context: Context): Boolean =
        context.packageManager.checkPermission(
            MANAGE_ROLLBACKS_PERMISSION,
            context.packageName
        ) == PackageManager.PERMISSION_GRANTED

    private fun mutablePendingIntentFlag(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
}
