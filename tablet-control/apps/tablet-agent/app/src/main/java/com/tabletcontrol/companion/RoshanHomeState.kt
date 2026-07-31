package com.tabletcontrol.companion

/**
 * Pure RoshanOS Home/setup state. Keeping this free of Android dependencies
 * makes the boot and reconnect rules deterministic and JVM-testable.
 *
 * The old pairingActive field has been removed — credential provisioning uses
 * ADB-only file handoff, not a displayed pairing code.
 */
data class RoshanHomeInputs(
    val wifiConnected: Boolean,
    val hasSavedNetwork: Boolean,
    val enrolled: Boolean,
    val ownerPinConfigured: Boolean,
    val wifiGraceActive: Boolean = false,
    val readinessKnown: Boolean = true,
    val privateNetworkConnected: Boolean = true,
    val requiredServicesReady: Boolean = true,
    val operationalGraceActive: Boolean = false
)

data class RoshanHomeUiState(
    val setupStep: SetupStep,
    val preserveCurrentContent: Boolean,
    val connectionLabel: String,
    val enrollmentLabel: String,
    val bannerTone: BannerTone
) {
    enum class SetupStep {
        WIFI,
        OWNER_PIN,
        ENROLLMENT,
        CONNECTING,
        RECOVERY,
        NONE
    }

    val showFirstRunWifiSetup: Boolean
        get() = setupStep == SetupStep.WIFI

    val showSetupGate: Boolean
        get() = setupStep != SetupStep.NONE

    enum class BannerTone {
        CONNECTED,
        ATTENTION,
        OFFLINE
    }
}

object RoshanHomeState {
    fun resolve(input: RoshanHomeInputs): RoshanHomeUiState {
        val setupStep = when {
            !input.wifiConnected && (!input.enrolled || !input.wifiGraceActive) ->
                RoshanHomeUiState.SetupStep.WIFI
            !input.ownerPinConfigured -> RoshanHomeUiState.SetupStep.OWNER_PIN
            !input.enrolled -> RoshanHomeUiState.SetupStep.ENROLLMENT
            input.wifiConnected &&
                !input.operationalGraceActive &&
                !input.readinessKnown ->
                RoshanHomeUiState.SetupStep.CONNECTING
            input.wifiConnected &&
                !input.operationalGraceActive &&
                !input.requiredServicesReady ->
                RoshanHomeUiState.SetupStep.RECOVERY
            else -> RoshanHomeUiState.SetupStep.NONE
        }
        val connectionLabel = when {
            input.wifiConnected && input.enrolled && !input.privateNetworkConnected ->
                "Private network offline"
            input.wifiConnected && input.enrolled && !input.requiredServicesReady ->
                "Service recovery"
            input.wifiConnected -> "Connected"
            input.hasSavedNetwork -> "Offline • Reconnecting"
            input.enrolled -> "Offline • Wi-Fi needed"
            else -> "Wi-Fi setup"
        }
        val enrollmentLabel = when {
            input.enrolled -> ""
            !input.ownerPinConfigured -> "Owner setup required"
            else -> "ADB provisioning required"
        }
        val tone = when {
            input.wifiConnected && input.enrolled -> RoshanHomeUiState.BannerTone.CONNECTED
            input.wifiConnected -> RoshanHomeUiState.BannerTone.ATTENTION
            else -> RoshanHomeUiState.BannerTone.OFFLINE
        }

        return RoshanHomeUiState(
            setupStep = setupStep,
            preserveCurrentContent =
                setupStep == RoshanHomeUiState.SetupStep.NONE,
            connectionLabel = connectionLabel,
            enrollmentLabel = enrollmentLabel,
            bannerTone = tone
        )
    }

    fun bannerText(state: RoshanHomeUiState): String {
        val parts = mutableListOf(state.connectionLabel)
        if (state.enrollmentLabel.isNotBlank()) {
            parts += state.enrollmentLabel
        }
        return parts.joinToString("  •  ")
    }

    fun formatDuration(totalSeconds: Long): String {
        val safeSeconds = totalSeconds.coerceAtLeast(0)
        return "%d:%02d".format(safeSeconds / 60, safeSeconds % 60)
    }
}

/**
 * Pure validation/formatting shared by the Android Wi-Fi and setup UIs.
 */
object RoshanSetupPolicy {
    data class WifiValidation(val valid: Boolean, val message: String = "")

    fun validateWifi(ssid: String, password: String?, secured: Boolean?): WifiValidation {
        val normalizedSsid = ssid.trim()
        if (normalizedSsid.isEmpty() || normalizedSsid.length > 32) {
            return WifiValidation(false, "Choose or enter a valid Wi-Fi network.")
        }
        val passwordRequired = secured == true
        if (passwordRequired && password.isNullOrEmpty()) {
            return WifiValidation(false, "Enter the Wi-Fi password.")
        }
        if (!password.isNullOrEmpty() && password.length !in 8..63) {
            return WifiValidation(false, "The Wi-Fi password must contain 8 to 63 characters.")
        }
        return WifiValidation(true)
    }

}
