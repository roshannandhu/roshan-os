package com.tabletcontrol.companion

/**
 * Android-free validation and completion policy for one-off Tailscale
 * enrollment. Auth keys are accepted only as transient method arguments; this
 * type never serializes, logs, or retains them.
 */
internal object TailscaleEnrollmentPolicy {
    const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    const val AUTH_KEY_POLICY = "AuthKey"
    const val FORCE_ENABLED_POLICY = "ForceEnabled"
    const val ONBOARDING_FLOW_POLICY = "OnboardingFlow"
    const val ONBOARDING_FLOW_HIDE = "hide"

    const val MIN_TIMEOUT_SECONDS = 30
    const val MAX_TIMEOUT_SECONDS = 300
    const val MIN_AUTH_KEY_LENGTH = 32
    const val MAX_AUTH_KEY_LENGTH = 256

    private val authKeyPattern =
        Regex("""\Atskey-auth-[A-Za-z0-9_-]+\z""")

    data class Request(
        val authKey: String,
        val timeoutSeconds: Int
    )

    data class ValidationResult(
        val request: Request?,
        val errorCode: String?
    ) {
        val valid: Boolean
            get() = request != null && errorCode == null
    }

    data class ConnectivityProof(
        val alwaysOnVpnConfigured: Boolean,
        val vpnTransportDetected: Boolean,
        val vpnValidated: Boolean,
        val tailnetAddressDetected: Boolean
    ) {
        /**
         * Connectivity is sufficient to finish an enrollment attempt only
         * when Android confirms that the configured always-on package owns a
         * VPN transport. Callers must also prove that the attempt began
         * disconnected before treating this as credential consumption.
         */
        val enrollmentConnectivitySatisfied: Boolean
            get() =
                alwaysOnVpnConfigured &&
                    vpnTransportDetected &&
                    (vpnValidated || tailnetAddressDetected)
    }

    enum class CompletionDecision {
        WAIT,
        SUCCEED,
        TIME_OUT
    }

    fun validateRequest(fields: Map<String, Any?>): ValidationResult {
        if (fields.keys != setOf("authKey", "timeoutSeconds")) {
            return ValidationResult(null, "INVALID_FIELDS")
        }
        val authKey = fields["authKey"] as? String
            ?: return ValidationResult(null, "INVALID_AUTH_KEY")
        val timeoutNumber = fields["timeoutSeconds"] as? Number
            ?: return ValidationResult(null, "INVALID_TIMEOUT")
        val timeoutDouble = timeoutNumber.toDouble()
        if (!timeoutDouble.isFinite() ||
            timeoutDouble != timeoutDouble.toInt().toDouble()
        ) {
            return ValidationResult(null, "INVALID_TIMEOUT")
        }
        val timeoutSeconds = timeoutDouble.toInt()
        if (timeoutSeconds !in MIN_TIMEOUT_SECONDS..MAX_TIMEOUT_SECONDS) {
            return ValidationResult(null, "INVALID_TIMEOUT")
        }
        if (!isValidAuthKey(authKey)) {
            return ValidationResult(null, "INVALID_AUTH_KEY")
        }
        return ValidationResult(
            Request(
                authKey = authKey,
                timeoutSeconds = timeoutSeconds
            ),
            null
        )
    }

    fun isValidAuthKey(value: String): Boolean =
        value.length in MIN_AUTH_KEY_LENGTH..MAX_AUTH_KEY_LENGTH &&
            value == value.trim() &&
            authKeyPattern.matches(value)

    fun completionDecision(
        nowElapsedMs: Long,
        deadlineElapsedMs: Long,
        proof: ConnectivityProof
    ): CompletionDecision = when {
        proof.enrollmentConnectivitySatisfied -> CompletionDecision.SUCCEED
        nowElapsedMs >= deadlineElapsedMs -> CompletionDecision.TIME_OUT
        else -> CompletionDecision.WAIT
    }

    fun isTailnetAddress(addressBytes: ByteArray): Boolean {
        if (addressBytes.size == 4) {
            val first = addressBytes[0].toInt() and 0xff
            val second = addressBytes[1].toInt() and 0xff
            return first == 100 && second in 64..127
        }
        if (addressBytes.size != 16) return false
        return (
            (addressBytes[0].toInt() and 0xff) == 0xfd &&
                (addressBytes[1].toInt() and 0xff) == 0x7a &&
                (addressBytes[2].toInt() and 0xff) == 0x11 &&
                (addressBytes[3].toInt() and 0xff) == 0x5c &&
                (addressBytes[4].toInt() and 0xff) == 0xa1 &&
                (addressBytes[5].toInt() and 0xff) == 0xe0
            )
    }
}
