package com.tabletcontrol.companion

/**
 * Minimal route policy before credential-encrypted storage is available.
 */
internal object DirectBootRequestPolicy {
    enum class Decision {
        HEALTH,
        LOCKED
    }

    fun decide(method: String, path: String): Decision =
        if (method == "GET" && path == "/health") {
            Decision.HEALTH
        } else {
            Decision.LOCKED
        }
}
