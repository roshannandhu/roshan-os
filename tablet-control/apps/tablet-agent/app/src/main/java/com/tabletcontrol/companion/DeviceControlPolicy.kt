package com.tabletcontrol.companion

/**
 * Android-free validation and classification rules for owner device controls.
 *
 * Keeping these rules separate makes it possible to prove that every privileged
 * operation is a closed, typed command. No caller-controlled shell text passes
 * through this policy.
 */
internal object DeviceControlPolicy {
    const val POWER_ACTION_MIN_INTERVAL_MS = 60_000L
    const val MIN_STORAGE_RESERVE_BYTES = 256L * 1024L * 1024L
    const val MAX_STORAGE_RESERVE_BYTES = 1024L * 1024L * 1024L

    val allowedScreenTimeoutSeconds = setOf(15, 30, 60, 120, 300, 600, 1800)
    val allowedBrightnessModes = setOf("manual", "automatic")

    private val packagePattern =
        Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val resumedActivityPatterns = listOf(
        Regex(
            """(?:topResumedActivity|mResumedActivity|mFocusedApp)[^\r\n]*?\bu\d+\s+([A-Za-z][A-Za-z0-9_.]*)/"""
        ),
        Regex(
            """mCurrentFocus[^\r\n]*?\bu\d+\s+([A-Za-z][A-Za-z0-9_.]*)/"""
        )
    )

    fun isValidBrightnessMode(mode: String): Boolean =
        mode in allowedBrightnessModes

    fun isValidScreenTimeoutSeconds(seconds: Int): Boolean =
        seconds in allowedScreenTimeoutSeconds

    fun isConfirmedShutdown(action: String, confirmed: Boolean): Boolean =
        action == "shutdown" && confirmed

    fun isTypedLock(action: String): Boolean = action == "lock"

    /**
     * Parses only a package identifier from fixed `dumpsys activity` output.
     * Free-form output and shell fragments are never returned.
     */
    fun parseForegroundPackage(output: String): String? {
        if (output.isBlank() || output.length > 64 * 1024) return null
        return resumedActivityPatterns
            .asSequence()
            .mapNotNull { pattern -> pattern.find(output)?.groupValues?.getOrNull(1) }
            .firstOrNull { candidate -> packagePattern.matches(candidate) }
    }

    fun foregroundState(
        packageName: String?,
        roshanPackage: String,
        approvedPackages: Set<String>,
        technicalPackages: Set<String>
    ): String = when {
        packageName == null -> "unknown"
        packageName == roshanPackage -> "roshanos"
        packageName in technicalPackages -> "technical"
        packageName in approvedPackages -> "approved"
        else -> "unapproved"
    }

    fun bootRecoveryState(homeReady: Boolean?, reconciledAtMs: Long?): String = when {
        homeReady == null || reconciledAtMs == null -> "unknown"
        reconciledAtMs <= 0L -> "recovering"
        homeReady -> "succeeded"
        else -> "degraded"
    }

    fun storageReserveBytes(totalBytes: Long): Long {
        if (totalBytes <= 0L) return MIN_STORAGE_RESERVE_BYTES
        return (totalBytes / 20L)
            .coerceAtLeast(MIN_STORAGE_RESERVE_BYTES)
            .coerceAtMost(MAX_STORAGE_RESERVE_BYTES)
    }

    fun isStorageLow(freeBytes: Long, totalBytes: Long): Boolean =
        freeBytes < 0L ||
            totalBytes <= 0L ||
            freeBytes < storageReserveBytes(totalBytes)

    class ActionGate(private val minimumIntervalMs: Long) {
        init {
            require(minimumIntervalMs > 0L)
        }

        private var lastAcceptedAtMs: Long? = null

        @Synchronized
        fun tryAcquire(nowMs: Long): Boolean {
            require(nowMs >= 0L)
            val previous = lastAcceptedAtMs
            if (previous != null && nowMs - previous < minimumIntervalMs) return false
            lastAcceptedAtMs = nowMs
            return true
        }
    }
}
