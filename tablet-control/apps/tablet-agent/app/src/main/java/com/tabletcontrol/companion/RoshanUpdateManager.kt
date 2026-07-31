package com.tabletcontrol.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection
import kotlin.math.min

/**
 * Owner-controlled, silent RoshanCore self-update coordinator.
 *
 * Security invariants:
 * - no generic shell or installer UI;
 * - no URL, credential, Authorization header, or APK is persisted in the
 *   update journal;
 * - only the separately owner-pinned Tailscale controller origin is accepted;
 * - candidate package, signer set, digest, and strict version increase are all
 *   verified before PackageInstaller sees the APK;
 * - STATUS_PENDING_USER_ACTION is a hard failure and its Intent is never
 *   launched.
 */
object RoshanUpdateManager {
    const val INSTALL_SELF_UPDATES_PERMISSION =
        "android.permission.INSTALL_SELF_UPDATES"

    private const val UPDATE_CACHE_DIRECTORY = "roshanos-update"
    private const val DOWNLOAD_PART_FILE = "candidate.apk.part"
    private const val DOWNLOAD_APK_FILE = "candidate.apk"
    private const val COMMIT_RESULT_TIMEOUT_MS = 10L * 60L * 1_000L
    private const val PROGRESS_COMMIT_BYTES = 1L * 1_024L * 1_024L

    private val operationRunning = AtomicBoolean(false)
    private val processReconciled = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "roshanos-signed-update").apply { isDaemon = true }
    }

    data class ActionResult(
        val accepted: Boolean,
        val code: String
    )

    private data class InstalledPackage(
        val versionCode: Long,
        val versionName: String?,
        val signerDigests: Set<String>
    )

    private data class CandidatePackage(
        val versionCode: Long,
        val versionName: String?,
        val signerDigests: Set<String>
    )

    private data class DownloadedApk(
        val file: File,
        val byteCount: Long,
        val sha256: ByteArray
    )

    private class UpdateFailure(val code: String) : Exception()

    fun configureControllerOrigin(
        context: Context,
        origin: String
    ): ActionResult {
        if (!DevicePolicyController.isDeviceOwner(context)) {
            return ActionResult(false, "DEVICE_OWNER_REQUIRED")
        }
        if (RoshanUpdatePolicy.validateControllerOrigin(origin).value == null) {
            return ActionResult(false, "INVALID_CONTROLLER_ORIGIN")
        }
        return if (RoshanControllerOriginStore.provision(context, origin)) {
            DiagnosticEventStore.info(
                context,
                component = "update",
                event = "controller_origin_configured"
            )
            ActionResult(true, "CONTROLLER_ORIGIN_CONFIGURED")
        } else {
            ActionResult(false, "CONTROLLER_ORIGIN_STORE_FAILED")
        }
    }

    fun requestUpdate(
        context: Context,
        rawUrl: String,
        rawSha256: String
    ): ActionResult {
        val appContext = context.applicationContext
        val origin = RoshanControllerOriginStore.get(appContext)
            ?: return ActionResult(false, "CONTROLLER_ORIGIN_NOT_CONFIGURED")
        val validatedUrl = RoshanUpdatePolicy.validateUpdateUrl(
            rawUrl,
            setOf(origin.host)
        ).value ?: return ActionResult(false, "UPDATE_URL_REJECTED")
        val expectedSha256 = RoshanUpdatePolicy.normalizeSha256(rawSha256)
            ?: return ActionResult(false, "INVALID_SHA256")
        if (!hasInstallCapability(appContext)) {
            return ActionResult(false, "SILENT_INSTALL_CAPABILITY_MISSING")
        }
        if (CredentialStore.getSecret(appContext) == null) {
            return ActionResult(false, "CREDENTIAL_UNAVAILABLE")
        }
        val installed = installedPackage(appContext)
            ?: return ActionResult(false, "INSTALLED_PACKAGE_UNREADABLE")
        if (!operationRunning.compareAndSet(false, true)) {
            return ActionResult(false, "UPDATE_ALREADY_IN_PROGRESS")
        }
        if (
            !RoshanUpdateStateStore.beginUpdate(
                appContext,
                installed.versionCode,
                installed.versionName
            )
        ) {
            operationRunning.set(false)
            return ActionResult(false, "UPDATE_ALREADY_IN_PROGRESS")
        }

        executor.execute {
            runUpdate(
                appContext,
                validatedUrl,
                expectedSha256,
                installed
            )
        }
        DiagnosticEventStore.info(
            appContext,
            component = "update",
            event = "request_accepted"
        )
        return ActionResult(true, "UPDATE_ACCEPTED")
    }

    fun requestRollback(context: Context): ActionResult {
        val appContext = context.applicationContext
        if (!DevicePolicyController.isDeviceOwner(appContext)) {
            return ActionResult(false, "DEVICE_OWNER_REQUIRED")
        }
        val state = RoshanUpdateStateStore.snapshot(appContext)
        if (state.inProgress || !operationRunning.compareAndSet(false, true)) {
            return ActionResult(false, "UPDATE_ALREADY_IN_PROGRESS")
        }
        val installed = installedPackage(appContext)
            ?: run {
                operationRunning.set(false)
                return ActionResult(false, "INSTALLED_PACKAGE_UNREADABLE")
            }
        val availability = RoshanRollbackBridge.availability(appContext)
        val rollback = availability.availableRollback
        if (!availability.available || rollback == null) {
            operationRunning.set(false)
            return ActionResult(
                false,
                availability.reasonCode ?: "NO_ROLLBACK_AVAILABLE"
            )
        }
        if (installed.versionCode != rollback.versionRolledBackFrom) {
            operationRunning.set(false)
            return ActionResult(false, "ROLLBACK_VERSION_MISMATCH")
        }
        if (
            !RoshanUpdateStateStore.markRollbackCommitting(
                appContext,
                currentVersionCode = installed.versionCode,
                currentVersionName = installed.versionName,
                targetVersionCode = rollback.versionRolledBackTo,
                rollbackId = rollback.rollbackId
            )
        ) {
            operationRunning.set(false)
            return ActionResult(false, "UPDATE_STATE_PERSIST_FAILED")
        }
        val committed = RoshanRollbackBridge.commit(appContext, rollback)
        operationRunning.set(false)
        if (!committed) {
            RoshanUpdateStateStore.markFailed(appContext, "ROLLBACK_COMMIT_FAILED")
            return ActionResult(false, "ROLLBACK_COMMIT_FAILED")
        }
        scheduleResultReconciliation(
            appContext,
            RoshanUpdateStateStore.Phase.ROLLBACK_COMMITTING,
            rollback.rollbackId,
            RoshanUpdateStateStore.snapshot(appContext).updatedAtMs
        )
        DiagnosticEventStore.warn(
            appContext,
            component = "update",
            event = "rollback_committed",
            fields = mapOf("source" to "authenticated_owner")
        )
        return ActionResult(true, "ROLLBACK_ACCEPTED")
    }

    fun reconcileAfterProcessStart(context: Context) {
        if (!processReconciled.compareAndSet(false, true)) return
        reconcile(context.applicationContext, packageWasReplaced = false)
    }

    fun onPackageReplaced(context: Context) {
        reconcile(context.applicationContext, packageWasReplaced = true)
    }

    fun handleInstallResult(
        context: Context,
        sessionId: Int,
        status: Int
    ) {
        val appContext = context.applicationContext
        val persisted = RoshanUpdateStateStore.snapshot(appContext)
        if (
            !RoshanUpdatePolicy.callbackMatches(
                expectedState =
                    RoshanUpdateStateStore.Phase.COMMITTING.wireName,
                currentState = persisted.phase.wireName,
                persistedOperationId = persisted.sessionId,
                callbackOperationId = sessionId
            )
        ) {
            return
        }
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                // Package replacement may be delivered immediately before or
                // after this callback. Reconcile against the installed version.
                reconcile(appContext, packageWasReplaced = false)
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                abandonPersistedSession(appContext)
                RoshanUpdateStateStore.markFailed(
                    appContext,
                    "USER_ACTION_REQUIRED"
                )
                DiagnosticEventStore.error(
                    appContext,
                    component = "update",
                    event = "installer_ui_rejected"
                )
            }
            else -> {
                abandonPersistedSession(appContext)
                RoshanUpdateStateStore.markFailed(
                    appContext,
                    RoshanUpdatePolicy.installResultErrorCode(status)
                )
            }
        }
        operationRunning.set(false)
        cleanUpdateCache(appContext)
    }

    fun handleRollbackResult(
        context: Context,
        rollbackId: Int,
        status: Int
    ) {
        val appContext = context.applicationContext
        val persisted = RoshanUpdateStateStore.snapshot(appContext)
        if (
            !RoshanUpdatePolicy.callbackMatches(
                expectedState =
                    RoshanUpdateStateStore.Phase.ROLLBACK_COMMITTING.wireName,
                currentState = persisted.phase.wireName,
                persistedOperationId = persisted.sessionId,
                callbackOperationId = rollbackId
            )
        ) {
            return
        }
        if (status == 0) {
            reconcile(appContext, packageWasReplaced = false)
        } else {
            RoshanUpdateStateStore.markFailed(
                appContext,
                RoshanUpdatePolicy.rollbackResultErrorCode(status)
            )
        }
        operationRunning.set(false)
    }

    fun statusJson(context: Context): JSONObject {
        val appContext = context.applicationContext
        val state = RoshanUpdateStateStore.snapshot(appContext)
        val installed = installedPackage(appContext)
        val origin = RoshanControllerOriginStore.metadata(appContext)
        val rollback = RoshanRollbackBridge.availability(appContext)
        val selfUpdatePermission = hasSelfUpdatePermission(appContext)
        return JSONObject().apply {
            put("state", state.phase.wireName)
            put("currentVersionCode", jsonValue(installed?.versionCode))
            put("currentVersionName", jsonValue(installed?.versionName))
            put("baseVersionCode", jsonValue(state.baseVersionCode))
            put("baseVersionName", jsonValue(state.baseVersionName))
            put("targetVersionCode", jsonValue(state.targetVersionCode))
            put("targetVersionName", jsonValue(state.targetVersionName))
            put("startedAtMs", jsonValue(state.startedAtMs))
            put("updatedAtMs", jsonValue(state.updatedAtMs))
            put("lastAppliedAtMs", jsonValue(state.lastAppliedAtMs))
            put("lastRollbackAtMs", jsonValue(state.lastRollbackAtMs))
            put(
                "lastRolledBackFromVersionCode",
                jsonValue(state.lastRolledBackFromVersionCode)
            )
            put("errorCode", jsonValue(state.errorCode))
            put("progress", JSONObject().apply {
                put("downloadedBytes", state.downloadedBytes)
                put("expectedBytes", jsonValue(state.expectedBytes))
            })
            put("controllerOrigin", JSONObject().apply {
                put("configured", origin.configured)
                put("state", origin.state)
                put("host", jsonValue(origin.host))
            })
            put("installCapability", JSONObject().apply {
                put(
                    "deviceOwner",
                    DevicePolicyController.isDeviceOwner(appContext)
                )
                put("selfUpdatePermissionGranted", selfUpdatePermission)
                put(
                    "silentSelfUpdateCapable",
                    DevicePolicyController.isDeviceOwner(appContext) ||
                        selfUpdatePermission
                )
                put("installerUiAllowed", false)
            })
            put("rollback", JSONObject().apply {
                put("platformApiPresent", rollback.platformApiPresent)
                put("permissionGranted", rollback.permissionGranted)
                put("supported", rollback.supported)
                put("available", rollback.available)
                put(
                    "rollbackId",
                    jsonValue(rollback.availableRollback?.rollbackId)
                )
                put(
                    "versionRolledBackFrom",
                    jsonValue(
                        rollback.availableRollback?.versionRolledBackFrom
                    )
                )
                put(
                    "versionRolledBackTo",
                    jsonValue(rollback.availableRollback?.versionRolledBackTo)
                )
                put("reasonCode", jsonValue(rollback.reasonCode))
                put("requestedForLastUpdate", state.rollbackRequested)
                put("dataPolicy", "retain")
                put("bootFailureAutoRollbackGuaranteed", false)
            })
        }
    }

    private fun runUpdate(
        context: Context,
        updateUrl: RoshanUpdatePolicy.ValidatedUrl,
        expectedSha256Hex: String,
        installedAtRequest: InstalledPackage
    ) {
        var sessionId: Int? = null
        try {
            val downloaded = downloadApk(
                context,
                updateUrl,
                expectedSha256Hex
            )
            if (
                !RoshanUpdateStateStore.markVerifying(
                    context,
                    downloaded.byteCount
                )
            ) {
                throw UpdateFailure("UPDATE_STATE_PERSIST_FAILED")
            }
            if (
                !MessageDigest.isEqual(
                    downloaded.sha256,
                    hexToBytes(expectedSha256Hex)
                )
            ) {
                throw UpdateFailure("SHA256_MISMATCH")
            }

            val candidate = inspectCandidate(context, downloaded.file)
            if (candidate.signerDigests.isEmpty()) {
                throw UpdateFailure("CANDIDATE_SIGNATURE_MISSING")
            }
            if (
                !RoshanUpdatePolicy.signerSetsExactlyMatch(
                    installedAtRequest.signerDigests,
                    candidate.signerDigests
                )
            ) {
                throw UpdateFailure("SIGNING_CERT_MISMATCH")
            }
            if (
                !RoshanUpdatePolicy.isStrictUpgrade(
                    installedAtRequest.versionCode,
                    candidate.versionCode
                )
            ) {
                throw UpdateFailure("VERSION_NOT_STRICTLY_HIGHER")
            }
            if (
                RoshanUpdateStateStore.snapshot(context)
                    .lastRolledBackFromVersionCode == candidate.versionCode
            ) {
                throw UpdateFailure("PREVIOUSLY_ROLLED_BACK_VERSION")
            }

            // Re-check the installed package immediately before creating the
            // session so an out-of-band update cannot create a version race.
            val installedNow = installedPackage(context)
                ?: throw UpdateFailure("INSTALLED_PACKAGE_UNREADABLE")
            if (
                installedNow.versionCode != installedAtRequest.versionCode ||
                !RoshanUpdatePolicy.signerSetsExactlyMatch(
                    installedAtRequest.signerDigests,
                    installedNow.signerDigests
                )
            ) {
                throw UpdateFailure("INSTALLED_PACKAGE_CHANGED")
            }

            val params = PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL
            ).apply {
                setAppPackageName(RoshanUpdatePolicy.PACKAGE_NAME)
                setSize(downloaded.byteCount)
                setInstallReason(PackageManager.INSTALL_REASON_POLICY)
            }
            val rollbackEnable = RoshanRollbackBridge.requestEnableRollback(
                context,
                params
            )
            if (
                !RoshanUpdateStateStore.markStaging(
                    context,
                    candidate.versionCode,
                    candidate.versionName,
                    rollbackEnable.requested
                )
            ) {
                throw UpdateFailure("UPDATE_STATE_PERSIST_FAILED")
            }

            val installer = context.packageManager.packageInstaller
            val createResult = DevicePolicyController.createSelfUpdateSession(
                context
            ) {
                installer.createSession(params)
            }
            sessionId = createResult.value
            val createdSessionId = sessionId
            if (!createResult.succeeded || createdSessionId == null) {
                if (createdSessionId != null) {
                    abandonSessionSafely(installer, createdSessionId)
                }
                throw UpdateFailure(
                    createResult.errorCode ?: "PACKAGE_SESSION_CREATE_FAILED"
                )
            }
            if (
                !RoshanUpdateStateStore.recordStagingSession(
                    context,
                    createdSessionId
                )
            ) {
                abandonSessionSafely(installer, createdSessionId)
                throw UpdateFailure("UPDATE_STATE_PERSIST_FAILED")
            }

            installer.openSession(createdSessionId).use { session ->
                val output = session.openWrite(
                    "RoshanCore.apk",
                    0L,
                    downloaded.byteCount
                )
                try {
                    downloaded.file.inputStream().use { input ->
                        val buffer = ByteArray(64 * 1_024)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                    }
                    session.fsync(output)
                } finally {
                    output.close()
                }

                if (
                    !RoshanUpdateStateStore.markCommitting(
                        context,
                        createdSessionId
                    )
                ) {
                    throw UpdateFailure("UPDATE_STATE_PERSIST_FAILED")
                }
                val callback = PendingIntent.getBroadcast(
                    context,
                    createdSessionId,
                    Intent(context, UpdateResultReceiver::class.java)
                        .setAction(UpdateResultReceiver.ACTION_INSTALL_RESULT)
                        .putExtra(
                            UpdateResultReceiver.EXTRA_OPERATION_ID,
                            createdSessionId
                        ),
                    PendingIntent.FLAG_CANCEL_CURRENT or mutablePendingIntentFlag()
                )
                session.commit(callback.intentSender)
            }
            scheduleResultReconciliation(
                context,
                RoshanUpdateStateStore.Phase.COMMITTING,
                createdSessionId,
                RoshanUpdateStateStore.snapshot(context).updatedAtMs
            )
            DiagnosticEventStore.info(
                context,
                component = "update",
                event = "package_session_committed",
                fields = mapOf(
                    "rollback_requested" to rollbackEnable.requested
                )
            )
        } catch (failure: UpdateFailure) {
            sessionId?.let {
                abandonSessionSafely(
                    context.packageManager.packageInstaller,
                    it
                )
            }
            RoshanUpdateStateStore.markFailed(context, failure.code)
            DiagnosticEventStore.error(
                context,
                component = "update",
                event = "update_failed",
                fields = mapOf("error_code" to failure.code)
            )
        } catch (error: Exception) {
            sessionId?.let {
                abandonSessionSafely(
                    context.packageManager.packageInstaller,
                    it
                )
            }
            val code = "UPDATE_${error.javaClass.simpleName.uppercase()}"
                .replace(Regex("[^A-Z0-9_]"), "_")
                .take(80)
            RoshanUpdateStateStore.markFailed(context, code)
            DiagnosticEventStore.error(
                context,
                component = "update",
                event = "update_failed",
                fields = mapOf("error_code" to code)
            )
        } finally {
            operationRunning.set(false)
            cleanUpdateCache(context)
        }
    }

    private fun downloadApk(
        context: Context,
        updateUrl: RoshanUpdatePolicy.ValidatedUrl,
        expectedSha256Hex: String
    ): DownloadedApk {
        val secret = CredentialStore.getSecret(context)
            ?: throw UpdateFailure("CREDENTIAL_UNAVAILABLE")
        val directory = File(context.cacheDir, UPDATE_CACHE_DIRECTORY)
        if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory) {
            throw UpdateFailure("UPDATE_CACHE_UNAVAILABLE")
        }
        val partial = File(directory, DOWNLOAD_PART_FILE)
        val complete = File(directory, DOWNLOAD_APK_FILE)
        partial.delete()
        complete.delete()

        val connection = try {
            updateUrl.uri.toURL().openConnection(Proxy.NO_PROXY) as HttpsURLConnection
        } catch (_: Exception) {
            throw UpdateFailure("HTTPS_CONNECTION_FAILED")
        }
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = RoshanUpdatePolicy.CONNECT_TIMEOUT_MS
            connection.readTimeout = RoshanUpdatePolicy.READ_TIMEOUT_MS
            connection.useCaches = false
            connection.setRequestProperty("Authorization", "Bearer $secret")
            connection.setRequestProperty(
                "Accept",
                "application/vnd.android.package-archive, application/octet-stream"
            )
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("Cache-Control", "no-store")

            val startedAt = SystemClock.elapsedRealtime()
            val status = connection.responseCode
            if (status in 300..399) throw UpdateFailure("HTTP_REDIRECT_REJECTED")
            if (status != HttpURLConnection.HTTP_OK) {
                throw UpdateFailure("HTTP_STATUS_REJECTED")
            }
            val expectedLength = connection.getHeaderFieldLong(
                "Content-Length",
                -1L
            )
            if (
                expectedLength == 0L ||
                expectedLength > RoshanUpdatePolicy.MAX_APK_BYTES
            ) {
                throw UpdateFailure("APK_SIZE_REJECTED")
            }

            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            var lastProgress = 0L
            FileOutputStream(partial).use { output ->
                connection.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1_024)
                    while (true) {
                        val elapsed = SystemClock.elapsedRealtime() - startedAt
                        val remaining =
                            RoshanUpdatePolicy.TOTAL_DOWNLOAD_TIMEOUT_MS - elapsed
                        if (remaining <= 0L) {
                            throw UpdateFailure("DOWNLOAD_TOTAL_TIMEOUT")
                        }
                        connection.readTimeout = min(
                            RoshanUpdatePolicy.READ_TIMEOUT_MS.toLong(),
                            remaining
                        ).coerceAtLeast(1L).toInt()
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > RoshanUpdatePolicy.MAX_APK_BYTES) {
                            throw UpdateFailure("APK_SIZE_REJECTED")
                        }
                        output.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        if (total - lastProgress >= PROGRESS_COMMIT_BYTES) {
                            RoshanUpdateStateStore.recordDownloadProgress(
                                context,
                                total,
                                expectedLength.takeIf { it >= 0L }
                            )
                            lastProgress = total
                        }
                    }
                }
                output.fd.sync()
            }
            if (total <= 0L || (expectedLength >= 0L && total != expectedLength)) {
                throw UpdateFailure("APK_LENGTH_MISMATCH")
            }
            val actualDigest = digest.digest()
            if (
                !MessageDigest.isEqual(
                    actualDigest,
                    hexToBytes(expectedSha256Hex)
                )
            ) {
                throw UpdateFailure("SHA256_MISMATCH")
            }
            if (!partial.renameTo(complete)) {
                throw UpdateFailure("APK_ATOMIC_RENAME_FAILED")
            }
            return DownloadedApk(
                file = complete,
                byteCount = total,
                sha256 = actualDigest
            )
        } finally {
            connection.disconnect()
        }
    }

    @Suppress("DEPRECATION")
    private fun inspectCandidate(context: Context, apk: File): CandidatePackage {
        val info = context.packageManager.getPackageArchiveInfo(
            apk.absolutePath,
            PackageManager.GET_SIGNING_CERTIFICATES
        ) ?: throw UpdateFailure("APK_PARSE_FAILED")
        if (info.packageName != RoshanUpdatePolicy.PACKAGE_NAME) {
            throw UpdateFailure("PACKAGE_NAME_MISMATCH")
        }
        return CandidatePackage(
            versionCode = info.longVersionCode,
            versionName = info.versionName,
            signerDigests = signerDigests(info)
        )
    }

    @Suppress("DEPRECATION")
    private fun installedPackage(context: Context): InstalledPackage? {
        return try {
            val info = context.packageManager.getPackageInfo(
                RoshanUpdatePolicy.PACKAGE_NAME,
                PackageManager.GET_SIGNING_CERTIFICATES
            )
            InstalledPackage(
                versionCode = info.longVersionCode,
                versionName = info.versionName,
                signerDigests = signerDigests(info)
            ).takeIf { it.signerDigests.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    private fun signerDigests(info: PackageInfo): Set<String> {
        val signingInfo = info.signingInfo ?: return emptySet()
        return signingInfo.apkContentsSigners
            .map { signature ->
                MessageDigest.getInstance("SHA-256")
                    .digest(signature.toByteArray())
                    .joinToString("") { byte -> "%02x".format(byte) }
            }
            .toSet()
    }

    private fun reconcile(context: Context, packageWasReplaced: Boolean) {
        val state = RoshanUpdateStateStore.snapshot(context)
        val installed = installedPackage(context) ?: return
        when (state.phase) {
            RoshanUpdateStateStore.Phase.COMMITTING -> {
                if (state.targetVersionCode == installed.versionCode) {
                    RoshanUpdateStateStore.markApplied(
                        context,
                        installed.versionCode,
                        installed.versionName
                    )
                    DiagnosticEventStore.info(
                        context,
                        component = "update",
                        event = "update_applied"
                    )
                } else if (
                    packageWasReplaced ||
                    resultTimedOut(state.updatedAtMs)
                ) {
                    abandonPersistedSession(context)
                    RoshanUpdateStateStore.markFailed(
                        context,
                        "INSTALLED_VERSION_DID_NOT_MATCH_TARGET"
                    )
                } else if (uncommittedInstallerSession(context, state.sessionId)) {
                    abandonPersistedSession(context)
                    RoshanUpdateStateStore.markFailed(
                        context,
                        "PACKAGE_COMMIT_INTERRUPTED"
                    )
                } else {
                    state.sessionId?.let { sessionId ->
                        scheduleResultReconciliation(
                            context,
                            RoshanUpdateStateStore.Phase.COMMITTING,
                            sessionId,
                            state.updatedAtMs
                        )
                    }
                }
            }
            RoshanUpdateStateStore.Phase.ROLLBACK_COMMITTING -> {
                if (state.targetVersionCode == installed.versionCode) {
                    RoshanUpdateStateStore.markRolledBack(
                        context,
                        installed.versionCode,
                        installed.versionName
                    )
                    DiagnosticEventStore.warn(
                        context,
                        component = "update",
                        event = "rollback_applied",
                        fields = mapOf("source" to "authenticated_owner")
                    )
                } else if (
                    packageWasReplaced ||
                    resultTimedOut(state.updatedAtMs)
                ) {
                    RoshanUpdateStateStore.markFailed(
                        context,
                        "ROLLBACK_VERSION_DID_NOT_MATCH_TARGET"
                    )
                } else {
                    state.sessionId?.let { rollbackId ->
                        scheduleResultReconciliation(
                            context,
                            RoshanUpdateStateStore.Phase.ROLLBACK_COMMITTING,
                            rollbackId,
                            state.updatedAtMs
                        )
                    }
                }
            }
            RoshanUpdateStateStore.Phase.DOWNLOADING,
            RoshanUpdateStateStore.Phase.VERIFYING,
            RoshanUpdateStateStore.Phase.STAGING -> {
                if (state.targetVersionCode == installed.versionCode) {
                    RoshanUpdateStateStore.markApplied(
                        context,
                        installed.versionCode,
                        installed.versionName
                    )
                } else {
                    abandonPersistedSession(context)
                    RoshanUpdateStateStore.markFailed(
                        context,
                        "UPDATE_PROCESS_INTERRUPTED"
                    )
                }
                cleanUpdateCache(context)
            }
            else -> Unit
        }
    }

    private fun resultTimedOut(updatedAtMs: Long?): Boolean {
        val updatedAt = updatedAtMs ?: return false
        val now = System.currentTimeMillis()
        return now < updatedAt || now - updatedAt > COMMIT_RESULT_TIMEOUT_MS
    }

    private fun scheduleResultReconciliation(
        context: Context,
        expectedPhase: RoshanUpdateStateStore.Phase,
        operationId: Int,
        updatedAtMs: Long?
    ) {
        val updatedAt = updatedAtMs ?: System.currentTimeMillis()
        val elapsed = (System.currentTimeMillis() - updatedAt).coerceAtLeast(0L)
        val delay = (COMMIT_RESULT_TIMEOUT_MS - elapsed)
            .coerceIn(1_000L, COMMIT_RESULT_TIMEOUT_MS)
        executor.schedule(
            {
                val state = RoshanUpdateStateStore.snapshot(context)
                if (
                    RoshanUpdatePolicy.callbackMatches(
                        expectedState = expectedPhase.wireName,
                        currentState = state.phase.wireName,
                        persistedOperationId = state.sessionId,
                        callbackOperationId = operationId
                    )
                ) {
                    reconcile(context, packageWasReplaced = false)
                }
            },
            delay,
            TimeUnit.MILLISECONDS
        )
    }

    private fun uncommittedInstallerSession(
        context: Context,
        sessionId: Int?
    ): Boolean {
        val id = sessionId ?: return false
        return try {
            context.packageManager.packageInstaller
                .getSessionInfo(id)
                ?.isCommitted == false
        } catch (_: Exception) {
            false
        }
    }

    private fun abandonPersistedSession(context: Context) {
        val sessionId = RoshanUpdateStateStore.snapshot(context).sessionId ?: return
        abandonSessionSafely(context.packageManager.packageInstaller, sessionId)
    }

    private fun abandonSessionSafely(
        installer: PackageInstaller,
        sessionId: Int
    ) {
        try {
            installer.abandonSession(sessionId)
        } catch (_: Exception) {
        }
    }

    private fun cleanUpdateCache(context: Context) {
        val directory = File(context.cacheDir, UPDATE_CACHE_DIRECTORY)
        File(directory, DOWNLOAD_PART_FILE).delete()
        File(directory, DOWNLOAD_APK_FILE).delete()
        if (directory.isDirectory && directory.list()?.isEmpty() == true) {
            directory.delete()
        }
    }

    private fun hasInstallCapability(context: Context): Boolean =
        DevicePolicyController.isDeviceOwner(context) ||
            hasSelfUpdatePermission(context)

    private fun hasSelfUpdatePermission(context: Context): Boolean =
        context.packageManager.checkPermission(
            INSTALL_SELF_UPDATES_PERMISSION,
            context.packageName
        ) == PackageManager.PERMISSION_GRANTED

    private fun mutablePendingIntentFlag(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }

    private fun hexToBytes(value: String): ByteArray =
        ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }

    private fun jsonValue(value: Any?): Any = value ?: JSONObject.NULL
}
