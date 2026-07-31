package com.tabletcontrol.companion

import android.content.Context
import android.content.Intent
import android.os.SystemClock

data class RoshanRuntimeReadinessSnapshot(
    val known: Boolean,
    val wifiConnected: Boolean,
    val privateNetworkConnected: Boolean,
    val requiredServicesReady: Boolean,
    val homeReady: Boolean,
    val hasEverBeenReady: Boolean,
    val unreadySinceElapsedMs: Long,
    val updatedAtElapsedMs: Long,
    val reasonCode: String,
    val requiredComponentsUnready: List<String> = emptyList()
)

/**
 * Android-free grace policy used by Home and its unit tests. A tablet which
 * was already operational remains useful briefly during a transient outage;
 * first boot and sustained failures are gated immediately/after the bound.
 */
internal object RoshanReadinessPolicy {
    const val TRANSIENT_FAILURE_GRACE_MS = 120_000L

    fun graceRemainingMs(
        snapshot: RoshanRuntimeReadinessSnapshot,
        nowElapsedMs: Long
    ): Long {
        if (snapshot.homeReady ||
            !snapshot.hasEverBeenReady ||
            snapshot.unreadySinceElapsedMs <= 0L
        ) {
            return 0L
        }
        return (
            TRANSIENT_FAILURE_GRACE_MS -
                (nowElapsedMs - snapshot.unreadySinceElapsedMs).coerceAtLeast(0L)
            ).coerceAtLeast(0L)
    }
}

/**
 * Process-local readiness bridge between the health supervisor and RoshanOS
 * Home. No credentials, URLs, SSIDs, or free-form exception text are stored.
 */
object RoshanRuntimeReadiness {
    const val ACTION_READINESS_CHANGED =
        "com.tabletcontrol.companion.action.READINESS_CHANGED"

    @Volatile
    private var state = startingState()

    fun snapshot(): RoshanRuntimeReadinessSnapshot = state

    @Synchronized
    fun markStarting(context: Context) {
        val previous = state
        state = startingState().copy(
            hasEverBeenReady = previous.hasEverBeenReady
        )
        notifyChanged(context)
    }

    @Synchronized
    fun update(
        context: Context,
        wifiConnected: Boolean,
        privateNetworkConnected: Boolean,
        requiredServicesReady: Boolean,
        reasonCode: String,
        requiredComponentsUnready: List<String> = emptyList()
    ) {
        val now = SystemClock.elapsedRealtime()
        val previous = state
        // Tailscale only powers the remote controller; RoshanOS Home itself is
        // ready with usable Wi-Fi and the essential local services.
        val ready = wifiConnected && requiredServicesReady
        val everReady = previous.hasEverBeenReady || ready
        val unreadySince = when {
            ready -> 0L
            previous.homeReady -> now
            previous.unreadySinceElapsedMs > 0L -> previous.unreadySinceElapsedMs
            else -> now
        }
        val next = RoshanRuntimeReadinessSnapshot(
            known = true,
            wifiConnected = wifiConnected,
            privateNetworkConnected = privateNetworkConnected,
            requiredServicesReady = requiredServicesReady,
            homeReady = ready,
            hasEverBeenReady = everReady,
            unreadySinceElapsedMs = unreadySince,
            updatedAtElapsedMs = now,
            reasonCode = normalizeReason(reasonCode),
            requiredComponentsUnready = requiredComponentsUnready
        )
        state = next
        if (next.copy(updatedAtElapsedMs = previous.updatedAtElapsedMs) != previous) {
            notifyChanged(context)
        }
    }

    @Synchronized
    fun markSupervisorFailure(context: Context) {
        val previous = state
        val now = SystemClock.elapsedRealtime()
        state = previous.copy(
            known = true,
            requiredServicesReady = false,
            homeReady = false,
            requiredComponentsUnready = emptyList(),
            unreadySinceElapsedMs = when {
                previous.homeReady -> now
                previous.unreadySinceElapsedMs > 0L -> previous.unreadySinceElapsedMs
                else -> now
            },
            updatedAtElapsedMs = now,
            reasonCode = "supervisor_failure"
        )
        notifyChanged(context)
    }

    private fun startingState() = RoshanRuntimeReadinessSnapshot(
        known = false,
        wifiConnected = false,
        privateNetworkConnected = false,
        requiredServicesReady = false,
        homeReady = false,
        hasEverBeenReady = false,
        unreadySinceElapsedMs = 0L,
        updatedAtElapsedMs = 0L,
        reasonCode = "starting"
    )

    private fun normalizeReason(value: String): String = when (value) {
        "ready",
        "wifi_required",
        "private_network_required",
        "services_recovery",
        "supervisor_failure",
        "stopped" -> value
        else -> "services_recovery"
    }

    private fun notifyChanged(context: Context) {
        context.applicationContext.sendBroadcast(
            Intent(ACTION_READINESS_CHANGED).setPackage(context.packageName)
        )
    }
}
