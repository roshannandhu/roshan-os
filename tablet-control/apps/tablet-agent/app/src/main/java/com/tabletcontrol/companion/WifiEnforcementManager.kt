package com.tabletcontrol.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class WifiEnforcementManager(
    context: Context,
    private val onNetworkStateChanged: (String) -> Unit = {}
) {
    data class Snapshot(
        val enabled: Boolean?,
        val connected: Boolean?,
        val internetCapable: Boolean?,
        val internetValidated: Boolean?,
        val ssid: String?,
        val rssiDbm: Int?,
        val signalLevel: Int?,
        val signalState: String?,
        val checkedAtMs: Long,
        val lastAvailableAtMs: Long,
        val lastLostAtMs: Long,
        val lastReconnectAttemptAtMs: Long,
        val lastReason: String?,
        val retryFailures: Int,
        val circuitOpen: Boolean,
        val cooldownRemainingMs: Long
    )

    private companion object {
        const val TAG = "WifiReconciler"
        const val VERIFY_DELAY_MS = 5_000L
    }

    private val appContext = context.applicationContext
    private val wifiManager =
        appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val connectivityManager =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val handler = Handler(Looper.getMainLooper())
    private val commandExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "roshan-wifi-reconcile").apply { isDaemon = true }
    }
    private val started = AtomicBoolean(false)
    private val retryCircuit = RetryCircuit(
        initialDelayMs = 2_000L,
        maximumDelayMs = 60_000L,
        maximumRetryAttempts = 6,
        cooldownMs = 300_000L
    )

    @Volatile
    private var callbackRegistered = false

    @Volatile
    private var lastAvailableAtMs = 0L

    @Volatile
    private var lastLostAtMs = 0L

    @Volatile
    private var lastReconnectAttemptAtMs = 0L

    @Volatile
    private var lastReason: String? = "starting"

    private var reconnectRunnable: Runnable? = null
    private val verificationRunnable = Runnable {
        if (!started.get()) return@Runnable
        if (hasUsableWifi()) {
            markAvailable("wifi_verified")
        } else {
            scheduleReconnect("wifi_reconnect_not_verified")
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            handler.post {
                if (hasUsableWifi()) {
                    markAvailable("wifi_available")
                } else {
                    lastReason = "wifi_awaiting_internet_validation"
                    handler.removeCallbacks(verificationRunnable)
                    handler.postDelayed(verificationRunnable, VERIFY_DELAY_MS)
                    onNetworkStateChanged("wifi_awaiting_internet_validation")
                }
            }
        }

        override fun onLost(network: Network) {
            handler.post {
                if (hasUsableWifi()) {
                    markAvailable("alternate_wifi_available")
                } else {
                    lastLostAtMs = System.currentTimeMillis()
                    lastReason = "wifi_lost"
                    onNetworkStateChanged("wifi_lost")
                    scheduleReconnect("wifi_lost")
                }
            }
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities
        ) {
            if (networkCapabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                handler.post {
                    if (
                        networkCapabilities.hasCapability(
                            NetworkCapabilities.NET_CAPABILITY_INTERNET
                        ) &&
                        networkCapabilities.hasCapability(
                            NetworkCapabilities.NET_CAPABILITY_VALIDATED
                        )
                    ) {
                        markAvailable("wifi_capabilities_validated")
                    } else {
                        lastReason = "wifi_awaiting_internet_validation"
                        onNetworkStateChanged("wifi_awaiting_internet_validation")
                    }
                }
            }
        }
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        try {
            connectivityManager.registerNetworkCallback(request, networkCallback)
            callbackRegistered = true
        } catch (error: Exception) {
            lastReason = "network callback registration failed: ${error.message}"
            Log.e(TAG, "Could not register Wi-Fi network callback", error)
        }

        if (hasUsableWifi()) {
            markAvailable("wifi_available_at_start")
        } else {
            scheduleReconnect("wifi_unavailable_at_start")
        }
    }

    fun stop() {
        if (!started.compareAndSet(true, false)) return
        if (callbackRegistered) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback)
            } catch (_: Exception) {
            }
            callbackRegistered = false
        }
        cancelReconnect()
        handler.removeCallbacks(verificationRunnable)
        commandExecutor.shutdownNow()
    }

    fun snapshot(nowMs: Long = System.currentTimeMillis()): Snapshot {
        val retry = retryCircuit.snapshot(nowMs)
        val connectivity = TelemetryProvider.connectivity(appContext)
        return Snapshot(
            enabled = connectivity.wifiEnabled,
            connected = connectivity.wifiConnected,
            internetCapable = connectivity.internetCapable,
            internetValidated = connectivity.internetValidated,
            ssid = connectivity.ssid,
            rssiDbm = connectivity.rssiDbm,
            signalLevel = connectivity.signalLevel,
            signalState = connectivity.signalState,
            checkedAtMs = nowMs,
            lastAvailableAtMs = lastAvailableAtMs,
            lastLostAtMs = lastLostAtMs,
            lastReconnectAttemptAtMs = lastReconnectAttemptAtMs,
            lastReason = lastReason,
            retryFailures = retry.failures,
            circuitOpen = retry.circuitOpen,
            cooldownRemainingMs = retry.cooldownRemainingMs
        )
    }

    private fun markAvailable(reason: String) {
        if (!started.get()) return
        lastAvailableAtMs = System.currentTimeMillis()
        lastReason = reason
        retryCircuit.onSuccess()
        cancelReconnect()
        handler.removeCallbacks(verificationRunnable)
        onNetworkStateChanged(reason)
        Log.i(TAG, "Wi-Fi connectivity reconciled")
    }

    private fun scheduleReconnect(reason: String) {
        if (!started.get() || reconnectRunnable != null) return
        lastReason = reason
        val now = System.currentTimeMillis()
        val plan = retryCircuit.onFailure(now)
        val runnable = Runnable {
            reconnectRunnable = null
            if (!started.get()) return@Runnable
            if (hasUsableWifi()) {
                markAvailable("wifi_available_before_retry")
                return@Runnable
            }
            attemptReconnect()
        }
        reconnectRunnable = runnable
        handler.postDelayed(runnable, plan.delayMs)
        onNetworkStateChanged(
            if (plan.circuitOpen) "wifi_reconnect_circuit_open" else "wifi_reconnect_scheduled"
        )
        Log.w(
            TAG,
            "Wi-Fi retry ${plan.retryAttempt} scheduled in ${plan.delayMs}ms; " +
                "circuitOpen=${plan.circuitOpen}"
        )
    }

    private fun attemptReconnect() {
        lastReconnectAttemptAtMs = System.currentTimeMillis()
        lastReason = "wifi_reconnect_attempt"
        onNetworkStateChanged("wifi_reconnect_attempt")

        commandExecutor.execute {
            try {
                if (!wifiManager.isWifiEnabled) enableWifi()
                RootCommand.exec("cmd wifi reconnect")
            } catch (error: Exception) {
                lastReason = "wifi reconnect command failed: ${error.message}"
                Log.w(TAG, "Wi-Fi reconnect command failed", error)
            } finally {
                handler.post {
                    if (started.get()) {
                        handler.removeCallbacks(verificationRunnable)
                        handler.postDelayed(verificationRunnable, VERIFY_DELAY_MS)
                    }
                }
            }
        }
    }

    private fun enableWifi() {
        var enabled = false
        try {
            @Suppress("DEPRECATION")
            enabled = wifiManager.setWifiEnabled(true)
        } catch (_: Exception) {
        }
        if (!enabled) RootCommand.exec("svc wifi enable")
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { handler.removeCallbacks(it) }
        reconnectRunnable = null
    }

    private fun hasUsableWifi(): Boolean {
        return try {
            connectivityManager.allNetworks.any { network ->
                val capabilities =
                    connectivityManager.getNetworkCapabilities(network) ?: return@any false
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            }
        } catch (_: Exception) {
            false
        }
    }
}
