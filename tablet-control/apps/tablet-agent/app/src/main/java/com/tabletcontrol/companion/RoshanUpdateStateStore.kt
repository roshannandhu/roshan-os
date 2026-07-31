package com.tabletcontrol.companion

import android.content.Context

/**
 * Durable, non-secret update journal. It intentionally never stores the
 * download URL, bearer credential, Authorization header, or APK bytes.
 */
object RoshanUpdateStateStore {
    private const val PREFS = "roshanos_update_state"
    private const val KEY_PHASE = "phase"
    private const val KEY_BASE_VERSION_CODE = "base_version_code"
    private const val KEY_BASE_VERSION_NAME = "base_version_name"
    private const val KEY_TARGET_VERSION_CODE = "target_version_code"
    private const val KEY_TARGET_VERSION_NAME = "target_version_name"
    private const val KEY_DOWNLOADED_BYTES = "downloaded_bytes"
    private const val KEY_EXPECTED_BYTES = "expected_bytes"
    private const val KEY_SESSION_ID = "session_id"
    private const val KEY_STARTED_AT_MS = "started_at_ms"
    private const val KEY_UPDATED_AT_MS = "updated_at_ms"
    private const val KEY_LAST_APPLIED_AT_MS = "last_applied_at_ms"
    private const val KEY_LAST_ROLLBACK_AT_MS = "last_rollback_at_ms"
    private const val KEY_LAST_ROLLED_BACK_FROM_VERSION_CODE =
        "last_rolled_back_from_version_code"
    private const val KEY_ERROR_CODE = "error_code"
    private const val KEY_ROLLBACK_REQUESTED = "rollback_requested"

    enum class Phase(val wireName: String) {
        IDLE("idle"),
        DOWNLOADING("downloading"),
        VERIFYING("verifying"),
        STAGING("staging"),
        COMMITTING("committing"),
        APPLIED("applied"),
        FAILED("failed"),
        ROLLBACK_COMMITTING("rollback_committing"),
        ROLLED_BACK("rolled_back");

        companion object {
            fun fromWireName(value: String?): Phase? =
                entries.firstOrNull { it.wireName == value }
        }
    }

    data class Snapshot(
        val phase: Phase,
        val baseVersionCode: Long?,
        val baseVersionName: String?,
        val targetVersionCode: Long?,
        val targetVersionName: String?,
        val downloadedBytes: Long,
        val expectedBytes: Long?,
        val sessionId: Int?,
        val startedAtMs: Long?,
        val updatedAtMs: Long?,
        val lastAppliedAtMs: Long?,
        val lastRollbackAtMs: Long?,
        val lastRolledBackFromVersionCode: Long?,
        val errorCode: String?,
        val rollbackRequested: Boolean
    ) {
        val inProgress: Boolean
            get() = RoshanUpdatePolicy.isInProgress(phase.wireName)
    }

    @Synchronized
    fun snapshot(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val storedPhase = prefs.getString(KEY_PHASE, Phase.IDLE.wireName)
        val parsedPhase = Phase.fromWireName(storedPhase)
        return Snapshot(
            phase = parsedPhase ?: Phase.FAILED,
            baseVersionCode = prefs.longOrNull(KEY_BASE_VERSION_CODE),
            baseVersionName = prefs.getString(KEY_BASE_VERSION_NAME, null),
            targetVersionCode = prefs.longOrNull(KEY_TARGET_VERSION_CODE),
            targetVersionName = prefs.getString(KEY_TARGET_VERSION_NAME, null),
            downloadedBytes = prefs.getLong(KEY_DOWNLOADED_BYTES, 0L).coerceAtLeast(0L),
            expectedBytes = prefs.longOrNull(KEY_EXPECTED_BYTES),
            sessionId = prefs.intOrNull(KEY_SESSION_ID),
            startedAtMs = prefs.longOrNull(KEY_STARTED_AT_MS),
            updatedAtMs = prefs.longOrNull(KEY_UPDATED_AT_MS),
            lastAppliedAtMs = prefs.longOrNull(KEY_LAST_APPLIED_AT_MS),
            lastRollbackAtMs = prefs.longOrNull(KEY_LAST_ROLLBACK_AT_MS),
            lastRolledBackFromVersionCode = prefs.longOrNull(
                KEY_LAST_ROLLED_BACK_FROM_VERSION_CODE
            ),
            errorCode = if (parsedPhase == null) {
                "STATE_CORRUPT"
            } else {
                prefs.getString(KEY_ERROR_CODE, null)
            },
            rollbackRequested = prefs.getBoolean(KEY_ROLLBACK_REQUESTED, false)
        )
    }

    @Synchronized
    fun beginUpdate(
        context: Context,
        baseVersionCode: Long,
        baseVersionName: String?
    ): Boolean {
        if (snapshot(context).inProgress) return false
        val now = System.currentTimeMillis()
        return save(
            context,
            Snapshot(
                phase = Phase.DOWNLOADING,
                baseVersionCode = baseVersionCode,
                baseVersionName = baseVersionName,
                targetVersionCode = null,
                targetVersionName = null,
                downloadedBytes = 0L,
                expectedBytes = null,
                sessionId = null,
                startedAtMs = now,
                updatedAtMs = now,
                lastAppliedAtMs = snapshot(context).lastAppliedAtMs,
                lastRollbackAtMs = snapshot(context).lastRollbackAtMs,
                lastRolledBackFromVersionCode =
                    snapshot(context).lastRolledBackFromVersionCode,
                errorCode = null,
                rollbackRequested = false
            )
        )
    }

    @Synchronized
    fun recordDownloadProgress(
        context: Context,
        downloadedBytes: Long,
        expectedBytes: Long?
    ): Boolean = mutate(context) {
        it.copy(
            downloadedBytes = downloadedBytes.coerceAtLeast(0L),
            expectedBytes = expectedBytes?.takeIf { size -> size >= 0L },
            updatedAtMs = System.currentTimeMillis()
        )
    }

    @Synchronized
    fun markVerifying(context: Context, downloadedBytes: Long): Boolean = mutate(context) {
        it.copy(
            phase = Phase.VERIFYING,
            downloadedBytes = downloadedBytes.coerceAtLeast(0L),
            updatedAtMs = System.currentTimeMillis(),
            errorCode = null
        )
    }

    @Synchronized
    fun markStaging(
        context: Context,
        targetVersionCode: Long,
        targetVersionName: String?,
        rollbackRequested: Boolean
    ): Boolean = mutate(context) {
        it.copy(
            phase = Phase.STAGING,
            targetVersionCode = targetVersionCode,
            targetVersionName = targetVersionName,
            updatedAtMs = System.currentTimeMillis(),
            errorCode = null,
            rollbackRequested = rollbackRequested
        )
    }

    @Synchronized
    fun markCommitting(context: Context, sessionId: Int): Boolean = mutate(context) {
        it.copy(
            phase = Phase.COMMITTING,
            sessionId = sessionId,
            updatedAtMs = System.currentTimeMillis(),
            errorCode = null
        )
    }

    @Synchronized
    fun recordStagingSession(context: Context, sessionId: Int): Boolean = mutate(context) {
        it.copy(
            phase = Phase.STAGING,
            sessionId = sessionId,
            updatedAtMs = System.currentTimeMillis(),
            errorCode = null
        )
    }

    @Synchronized
    fun markApplied(
        context: Context,
        installedVersionCode: Long,
        installedVersionName: String?
    ): Boolean {
        val now = System.currentTimeMillis()
        return mutate(context) {
            it.copy(
                phase = Phase.APPLIED,
                targetVersionCode = installedVersionCode,
                targetVersionName = installedVersionName,
                sessionId = null,
                updatedAtMs = now,
                lastAppliedAtMs = now,
                errorCode = null
            )
        }
    }

    @Synchronized
    fun markRollbackCommitting(
        context: Context,
        currentVersionCode: Long,
        currentVersionName: String?,
        targetVersionCode: Long,
        rollbackId: Int
    ): Boolean {
        val now = System.currentTimeMillis()
        return save(
            context,
            Snapshot(
                phase = Phase.ROLLBACK_COMMITTING,
                baseVersionCode = currentVersionCode,
                baseVersionName = currentVersionName,
                targetVersionCode = targetVersionCode,
                targetVersionName = null,
                downloadedBytes = 0L,
                expectedBytes = null,
                sessionId = rollbackId,
                startedAtMs = now,
                updatedAtMs = now,
                lastAppliedAtMs = snapshot(context).lastAppliedAtMs,
                lastRollbackAtMs = snapshot(context).lastRollbackAtMs,
                lastRolledBackFromVersionCode =
                    snapshot(context).lastRolledBackFromVersionCode,
                errorCode = null,
                rollbackRequested = true
            )
        )
    }

    @Synchronized
    fun markRolledBack(
        context: Context,
        installedVersionCode: Long,
        installedVersionName: String?
    ): Boolean {
        val now = System.currentTimeMillis()
        return mutate(context) {
            it.copy(
                phase = Phase.ROLLED_BACK,
                targetVersionCode = installedVersionCode,
                targetVersionName = installedVersionName,
                sessionId = null,
                updatedAtMs = now,
                lastRollbackAtMs = now,
                lastRolledBackFromVersionCode = it.baseVersionCode,
                errorCode = null
            )
        }
    }

    @Synchronized
    fun markFailed(context: Context, errorCode: String): Boolean = mutate(context) {
        it.copy(
            phase = Phase.FAILED,
            sessionId = null,
            updatedAtMs = System.currentTimeMillis(),
            errorCode = sanitizeErrorCode(errorCode)
        )
    }

    private fun mutate(
        context: Context,
        transform: (Snapshot) -> Snapshot
    ): Boolean = save(context, transform(snapshot(context)))

    private fun save(context: Context, value: Snapshot): Boolean {
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PHASE, value.phase.wireName)
            .putLong(KEY_DOWNLOADED_BYTES, value.downloadedBytes)
            .putBoolean(KEY_ROLLBACK_REQUESTED, value.rollbackRequested)
            .putNullableLong(KEY_BASE_VERSION_CODE, value.baseVersionCode)
            .putNullableString(KEY_BASE_VERSION_NAME, value.baseVersionName)
            .putNullableLong(KEY_TARGET_VERSION_CODE, value.targetVersionCode)
            .putNullableString(KEY_TARGET_VERSION_NAME, value.targetVersionName)
            .putNullableLong(KEY_EXPECTED_BYTES, value.expectedBytes)
            .putNullableInt(KEY_SESSION_ID, value.sessionId)
            .putNullableLong(KEY_STARTED_AT_MS, value.startedAtMs)
            .putNullableLong(KEY_UPDATED_AT_MS, value.updatedAtMs)
            .putNullableLong(KEY_LAST_APPLIED_AT_MS, value.lastAppliedAtMs)
            .putNullableLong(KEY_LAST_ROLLBACK_AT_MS, value.lastRollbackAtMs)
            .putNullableLong(
                KEY_LAST_ROLLED_BACK_FROM_VERSION_CODE,
                value.lastRolledBackFromVersionCode
            )
            .putNullableString(KEY_ERROR_CODE, value.errorCode)
        return editor.commit()
    }

    private fun sanitizeErrorCode(value: String): String =
        value.uppercase()
            .replace(Regex("[^A-Z0-9_]"), "_")
            .take(80)
            .ifBlank { "UNKNOWN_FAILURE" }

    private fun android.content.SharedPreferences.longOrNull(key: String): Long? =
        if (contains(key)) getLong(key, 0L) else null

    private fun android.content.SharedPreferences.intOrNull(key: String): Int? =
        if (contains(key)) getInt(key, 0) else null

    private fun android.content.SharedPreferences.Editor.putNullableLong(
        key: String,
        value: Long?
    ): android.content.SharedPreferences.Editor =
        if (value == null) remove(key) else putLong(key, value)

    private fun android.content.SharedPreferences.Editor.putNullableInt(
        key: String,
        value: Int?
    ): android.content.SharedPreferences.Editor =
        if (value == null) remove(key) else putInt(key, value)

    private fun android.content.SharedPreferences.Editor.putNullableString(
        key: String,
        value: String?
    ): android.content.SharedPreferences.Editor =
        if (value == null) remove(key) else putString(key, value)
}
