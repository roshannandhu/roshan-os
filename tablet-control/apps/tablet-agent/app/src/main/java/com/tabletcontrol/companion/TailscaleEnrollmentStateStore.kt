package com.tabletcontrol.companion

import android.content.Context

/**
 * Persists only non-secret enrollment outcome metadata. In particular, this
 * store has no field capable of holding an auth key or request body.
 */
internal object TailscaleEnrollmentStateStore {
    private const val PREFS = "tailscale_enrollment_state"
    private const val KEY_STATE = "state"
    private const val KEY_CODE = "code"
    private const val KEY_STARTED_AT_MS = "started_at_ms"
    private const val KEY_FINISHED_AT_MS = "finished_at_ms"
    private const val KEY_DEADLINE_AT_MS = "deadline_at_ms"
    private const val KEY_TIMEOUT_SECONDS = "timeout_seconds"
    private const val KEY_ALWAYS_ON = "always_on"
    private const val KEY_VPN = "vpn"
    private const val KEY_VALIDATED = "validated"
    private const val KEY_TAILNET_ADDRESS = "tailnet_address"

    data class Snapshot(
        val state: String,
        val code: String,
        val startedAtMs: Long,
        val finishedAtMs: Long,
        val deadlineAtMs: Long,
        val timeoutSeconds: Int,
        val alwaysOnVpnConfigured: Boolean,
        val vpnTransportDetected: Boolean,
        val vpnValidated: Boolean,
        val tailnetAddressDetected: Boolean
    )

    fun load(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Snapshot(
            state = normalizeState(prefs.getString(KEY_STATE, null)),
            code = normalizeCode(prefs.getString(KEY_CODE, null)),
            startedAtMs = prefs.getLong(KEY_STARTED_AT_MS, 0L).coerceAtLeast(0L),
            finishedAtMs = prefs.getLong(KEY_FINISHED_AT_MS, 0L).coerceAtLeast(0L),
            deadlineAtMs = prefs.getLong(KEY_DEADLINE_AT_MS, 0L).coerceAtLeast(0L),
            timeoutSeconds = prefs.getInt(KEY_TIMEOUT_SECONDS, 0).coerceIn(
                0,
                TailscaleEnrollmentPolicy.MAX_TIMEOUT_SECONDS
            ),
            alwaysOnVpnConfigured = prefs.getBoolean(KEY_ALWAYS_ON, false),
            vpnTransportDetected = prefs.getBoolean(KEY_VPN, false),
            vpnValidated = prefs.getBoolean(KEY_VALIDATED, false),
            tailnetAddressDetected = prefs.getBoolean(KEY_TAILNET_ADDRESS, false)
        )
    }

    fun save(context: Context, snapshot: Snapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_STATE, normalizeState(snapshot.state))
            .putString(KEY_CODE, normalizeCode(snapshot.code))
            .putLong(KEY_STARTED_AT_MS, snapshot.startedAtMs.coerceAtLeast(0L))
            .putLong(KEY_FINISHED_AT_MS, snapshot.finishedAtMs.coerceAtLeast(0L))
            .putLong(KEY_DEADLINE_AT_MS, snapshot.deadlineAtMs.coerceAtLeast(0L))
            .putInt(
                KEY_TIMEOUT_SECONDS,
                snapshot.timeoutSeconds.coerceIn(
                    0,
                    TailscaleEnrollmentPolicy.MAX_TIMEOUT_SECONDS
                )
            )
            .putBoolean(KEY_ALWAYS_ON, snapshot.alwaysOnVpnConfigured)
            .putBoolean(KEY_VPN, snapshot.vpnTransportDetected)
            .putBoolean(KEY_VALIDATED, snapshot.vpnValidated)
            .putBoolean(KEY_TAILNET_ADDRESS, snapshot.tailnetAddressDetected)
            .apply()
    }

    private fun normalizeState(value: String?): String = when (value) {
        "enrolling",
        "succeeded",
        "failed" -> value
        else -> "never_requested"
    }

    private fun normalizeCode(value: String?): String {
        if (value.isNullOrBlank()) return "NONE"
        return value
            .take(64)
            .filter { it in 'A'..'Z' || it in '0'..'9' || it == '_' }
            .ifBlank { "UNKNOWN" }
    }
}
