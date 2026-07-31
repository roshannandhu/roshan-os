package com.tabletcontrol.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager

/**
 * RoshanOS-owned Wi-Fi provisioning helpers.
 *
 * Android 10+ permits the legacy saved-network APIs for Device Owner and system
 * applications. RoshanCore is both in the finished image. No password or SSID
 * is logged, returned by the control API, or persisted by RoshanCore itself;
 * Android's Wi-Fi service owns the resulting network configuration.
 */
object WifiProvisioningManager {
    data class NetworkOption(
        val ssid: String,
        val signalLevel: Int,
        val secured: Boolean
    )

    sealed class ConnectResult {
        object Started : ConnectResult()
        data class Rejected(val reason: String) : ConnectResult()
    }

    fun isConnected(context: Context): Boolean {
        val connectivity =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return try {
            // When Tailscale is the active VPN, activeNetwork is TRANSPORT_VPN.
            // Inspect every network so the validated underlying Wi-Fi remains
            // visible to RoshanOS setup and reconnect state.
            connectivity.allNetworks.any { network ->
                val capabilities = connectivity.getNetworkCapabilities(network) ?: return@any false
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            }
        } catch (_: SecurityException) {
            false
        }
    }

    @Suppress("DEPRECATION")
    fun currentSsid(context: Context): String? {
        if (!isConnected(context)) return null
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            wifi.connectionInfo?.ssid
                ?.removeSurrounding("\"")
                ?.takeUnless { it.isBlank() || it.equals("<unknown ssid>", ignoreCase = true) }
        } catch (_: SecurityException) {
            null
        }
    }

    @Suppress("DEPRECATION")
    fun hasSavedNetwork(context: Context): Boolean {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            wifi.configuredNetworks?.isNotEmpty() == true
        } catch (_: SecurityException) {
            false
        }
    }

    @Suppress("DEPRECATION")
    fun scan(context: Context): List<NetworkOption> {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (!wifi.isWifiEnabled) {
            try {
                wifi.isWifiEnabled = true
            } catch (_: Exception) {
                return emptyList()
            }
        }

        try {
            wifi.startScan()
        } catch (_: SecurityException) {
            return emptyList()
        }

        return try {
            wifi.scanResults
                .asSequence()
                .filter { it.SSID.isNotBlank() }
                .groupBy(ScanResult::SSID)
                .mapNotNull { (ssid, results) ->
                    val strongest = results.maxByOrNull { it.level } ?: return@mapNotNull null
                    NetworkOption(
                        ssid = ssid,
                        signalLevel = WifiManager.calculateSignalLevel(strongest.level, 5),
                        secured = strongest.capabilities.contains("WEP") ||
                            strongest.capabilities.contains("PSK") ||
                            strongest.capabilities.contains("SAE") ||
                            strongest.capabilities.contains("EAP")
                    )
                }
                .sortedWith(
                    compareByDescending<NetworkOption> { it.signalLevel }
                        .thenBy { it.ssid.lowercase() }
                )
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    @Suppress("DEPRECATION")
    fun connect(
        context: Context,
        ssid: String,
        password: String?,
        secured: Boolean? = null
    ): ConnectResult {
        val normalizedSsid = ssid.trim()
        val validation = RoshanSetupPolicy.validateWifi(normalizedSsid, password, secured)
        if (!validation.valid) {
            return ConnectResult.Rejected(validation.message)
        }
        if (!DevicePolicyController.isDeviceOwner(context) &&
            context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM == 0
        ) {
            return ConnectResult.Rejected("RoshanOS provisioning permission is not active.")
        }

        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            if (!wifi.isWifiEnabled) wifi.isWifiEnabled = true

            val configuration = WifiConfiguration().apply {
                SSID = quoteWifiValue(normalizedSsid)
                hiddenSSID = false
                status = WifiConfiguration.Status.ENABLED
                if (password.isNullOrEmpty() && secured != true) {
                    allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
                } else {
                    preSharedKey = quoteWifiValue(password.orEmpty())
                    allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
                }
            }

            val existing = wifi.configuredNetworks
                ?.firstOrNull { it.SSID == configuration.SSID }
            val networkId = if (existing == null) {
                wifi.addNetwork(configuration)
            } else {
                configuration.networkId = existing.networkId
                wifi.updateNetwork(configuration)
            }

            if (networkId < 0 || !wifi.enableNetwork(networkId, true)) {
                ConnectResult.Rejected("Android rejected the Wi-Fi configuration.")
            } else {
                wifi.reconnect()
                ConnectResult.Started
            }
        } catch (_: SecurityException) {
            ConnectResult.Rejected("RoshanOS does not have permission to configure Wi-Fi.")
        } catch (_: Exception) {
            ConnectResult.Rejected("Wi-Fi could not be configured.")
        }
    }

    /**
     * Best-effort reconnect for an enrolled tablet. This never opens Settings
     * and never removes or rewrites the user's saved Android Wi-Fi networks.
     */
    @Suppress("DEPRECATION")
    fun requestReconnect(context: Context) {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        try {
            if (!wifi.isWifiEnabled) wifi.isWifiEnabled = true
            wifi.reconnect()
        } catch (_: Exception) {
            // The Home state remains usable and will try again on the next cycle.
        }
    }

    private fun quoteWifiValue(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
