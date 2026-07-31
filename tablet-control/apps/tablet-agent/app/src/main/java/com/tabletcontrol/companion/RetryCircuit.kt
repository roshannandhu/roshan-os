package com.tabletcontrol.companion

/**
 * Pure, clock-driven retry state. Callers own scheduling so this class can be
 * exercised by local JVM tests without Android's Handler/Looper.
 */
internal class RetryCircuit(
    private val initialDelayMs: Long,
    private val maximumDelayMs: Long,
    private val maximumRetryAttempts: Int,
    private val cooldownMs: Long
) {
    init {
        require(initialDelayMs > 0)
        require(maximumDelayMs >= initialDelayMs)
        require(maximumRetryAttempts > 0)
        require(cooldownMs > 0)
    }

    internal enum class Disposition {
        RETRY,
        CIRCUIT_OPEN
    }

    internal data class Plan(
        val disposition: Disposition,
        val delayMs: Long,
        val retryAttempt: Int,
        val circuitOpen: Boolean
    )

    internal data class Snapshot(
        val failures: Int,
        val circuitOpen: Boolean,
        val cooldownRemainingMs: Long
    )

    private var failures = 0
    private var circuitOpenedAtMs: Long? = null

    @Synchronized
    fun onFailure(nowMs: Long): Plan {
        refreshExpiredCircuit(nowMs)

        val openedAt = circuitOpenedAtMs
        if (openedAt != null) {
            return Plan(
                disposition = Disposition.CIRCUIT_OPEN,
                delayMs = remainingCooldown(nowMs, openedAt),
                retryAttempt = failures,
                circuitOpen = true
            )
        }

        if (failures >= maximumRetryAttempts) {
            circuitOpenedAtMs = nowMs
            return Plan(
                disposition = Disposition.CIRCUIT_OPEN,
                delayMs = cooldownMs,
                retryAttempt = failures,
                circuitOpen = true
            )
        }

        failures += 1
        return Plan(
            disposition = Disposition.RETRY,
            delayMs = exponentialDelay(failures),
            retryAttempt = failures,
            circuitOpen = false
        )
    }

    @Synchronized
    fun onSuccess() {
        failures = 0
        circuitOpenedAtMs = null
    }

    @Synchronized
    fun snapshot(nowMs: Long): Snapshot {
        refreshExpiredCircuit(nowMs)
        val openedAt = circuitOpenedAtMs
        return Snapshot(
            failures = failures,
            circuitOpen = openedAt != null,
            cooldownRemainingMs = if (openedAt == null) 0L else remainingCooldown(nowMs, openedAt)
        )
    }

    private fun refreshExpiredCircuit(nowMs: Long) {
        val openedAt = circuitOpenedAtMs ?: return
        if (nowMs - openedAt >= cooldownMs) {
            failures = 0
            circuitOpenedAtMs = null
        }
    }

    private fun remainingCooldown(nowMs: Long, openedAtMs: Long): Long =
        (cooldownMs - (nowMs - openedAtMs).coerceAtLeast(0L)).coerceAtLeast(0L)

    private fun exponentialDelay(attempt: Int): Long {
        var delay = initialDelayMs
        repeat((attempt - 1).coerceAtLeast(0)) {
            if (delay >= maximumDelayMs || delay > maximumDelayMs / 2L) {
                return maximumDelayMs
            }
            delay = (delay * 2L).coerceAtMost(maximumDelayMs)
        }
        return delay
    }
}
