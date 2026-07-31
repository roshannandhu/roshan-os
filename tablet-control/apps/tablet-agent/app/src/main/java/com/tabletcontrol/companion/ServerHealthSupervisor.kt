package com.tabletcontrol.companion

import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Read-mostly server supervisor. It owns the control-listener retry only; the
 * internal camera health manager and the existing root watchdog retain their
 * respective lifecycle ownership. External packages are never launched here.
 */
class ServerHealthSupervisor(
    context: Context,
    private val controlListenerProvider: () -> SimpleHttpServer.ListenerSnapshot?,
    private val recoverControlListener: () -> Boolean,
    private val wifiProvider: () -> WifiEnforcementManager.Snapshot?,
    private val cameraProvider: () -> CameraHealthManager.Snapshot?
) {
    data class ComponentHealth(
        val state: String,
        val checkedAtMs: Long,
        val lastHealthyAtMs: Long,
        val degradedReason: String?,
        val details: Map<String, Any?>
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("state", state)
            put("checkedAtMs", checkedAtMs)
            put("lastHealthyAtMs", lastHealthyAtMs)
            put("degradedReason", degradedReason ?: JSONObject.NULL)
            put("details", JSONObject().apply {
                details.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
            })
        }
    }

    data class Snapshot(
        val healthy: Boolean,
        val homeReady: Boolean,
        val supervisorStartedAtMs: Long,
        val reconciledAtMs: Long,
        val reconciliationReason: String,
        val degradedReasons: List<String>,
        val components: Map<String, ComponentHealth>
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("healthy", healthy)
            put("homeReady", homeReady)
            put("supervisorStartedAtMs", supervisorStartedAtMs)
            put("reconciledAtMs", reconciledAtMs)
            put("reconciliationReason", reconciliationReason)
            put("degradedReasons", JSONArray(degradedReasons))
            put("components", JSONObject().apply {
                components.forEach { (name, component) -> put(name, component.toJson()) }
            })
        }
    }

    private data class PackageState(
        val installed: Boolean,
        val enabled: Boolean,
        val visibilityReason: String?
    )

    private data class HttpProbe(
        val statusCode: Int?,
        val validJson: Boolean,
        val error: String?
    )

    private companion object {
        const val TAG = "ServerSupervisor"
        const val RECONCILE_INTERVAL_MS = 30_000L
        const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    }

    private val appContext = context.applicationContext
    private val connectivityManager =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val packageManager = appContext.packageManager
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "roshan-server-supervisor").apply { isDaemon = true }
    }
    private val running = AtomicBoolean(false)
    private val workerScheduled = AtomicBoolean(false)
    private val pendingReason = AtomicReference<String?>(null)
    private val controlRecoveryPending = AtomicBoolean(false)
    private val vpnRecoveryPending = AtomicBoolean(false)
    private val controlRetryCircuit = RetryCircuit(
        initialDelayMs = 1_000L,
        maximumDelayMs = 30_000L,
        maximumRetryAttempts = 5,
        cooldownMs = 120_000L
    )
    private val vpnRetryCircuit = RetryCircuit(
        initialDelayMs = 2_000L,
        maximumDelayMs = 60_000L,
        maximumRetryAttempts = 5,
        cooldownMs = 300_000L
    )

    @Volatile
    private var startedAtMs = 0L

    @Volatile
    private var currentSnapshot = startingSnapshot()

    private val periodicRunnable = object : Runnable {
        override fun run() {
            if (!running.get()) return
            requestReconciliation("periodic")
            handler.postDelayed(this, RECONCILE_INTERVAL_MS)
        }
    }

    private var controlRecoveryRunnable: Runnable? = null
    private var vpnRecoveryRunnable: Runnable? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        startedAtMs = System.currentTimeMillis()
        currentSnapshot = startingSnapshot()
        RoshanRuntimeReadiness.markStarting(appContext)
        requestReconciliation("supervisor_start")
        handler.postDelayed(periodicRunnable, RECONCILE_INTERVAL_MS)
        DiagnosticEventStore.info(
            appContext,
            component = "supervisor",
            event = "started",
            fields = mapOf("state" to "starting")
        )
        Log.i(TAG, "Structured server supervision started")
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        handler.removeCallbacks(periodicRunnable)
        controlRecoveryRunnable?.let { handler.removeCallbacks(it) }
        controlRecoveryRunnable = null
        controlRecoveryPending.set(false)
        vpnRecoveryRunnable?.let { handler.removeCallbacks(it) }
        vpnRecoveryRunnable = null
        vpnRecoveryPending.set(false)
        pendingReason.set(null)
        RoshanRuntimeReadiness.update(
            appContext,
            wifiConnected = false,
            privateNetworkConnected = false,
            requiredServicesReady = false,
            reasonCode = "stopped"
        )
        worker.shutdownNow()
        DiagnosticEventStore.info(
            appContext,
            component = "supervisor",
            event = "stopped"
        )
        Log.i(TAG, "Structured server supervision stopped")
    }

    fun requestReconciliation(reason: String) {
        if (!running.get()) return
        pendingReason.set(reason.take(120))
        scheduleWorker()
    }

    fun snapshot(): Snapshot = currentSnapshot

    fun snapshotJson(): JSONObject = currentSnapshot.toJson()

    private fun scheduleWorker() {
        if (!workerScheduled.compareAndSet(false, true)) return
        try {
            worker.execute {
                try {
                    while (running.get()) {
                        val reason = pendingReason.getAndSet(null) ?: break
                        reconcile(reason)
                    }
                } finally {
                    workerScheduled.set(false)
                    if (running.get() && pendingReason.get() != null) scheduleWorker()
                }
            }
        } catch (error: Exception) {
            workerScheduled.set(false)
            DiagnosticEventStore.error(
                appContext,
                component = "supervisor",
                event = "worker_rejected",
                fields = mapOf("error_class" to error.javaClass.simpleName)
            )
            Log.w(TAG, "Supervisor worker rejected reconciliation", error)
        }
    }

    private fun reconcile(reason: String) {
        val now = System.currentTimeMillis()
        try {
            val previousSnapshot = currentSnapshot
            val previous = currentSnapshot.components
            val components = linkedMapOf<String, ComponentHealth>()

            val control = controlListenerProvider()
            val controlHealthy = control?.listening == true
            components["controlListener"] = component(
                previous = previous["controlListener"],
                healthy = controlHealthy,
                state = if (controlHealthy) "healthy" else "degraded",
                checkedAtMs = now,
                reason = when {
                    control == null -> "control listener is not initialized"
                    control.lastError != null -> control.lastError
                    else -> "control listener is not bound"
                },
                details = mapOf(
                    "port" to control?.port,
                    "startedAtMs" to control?.startedAtMs,
                    "lastAcceptedAtMs" to control?.lastAcceptedAtMs,
                    "lastErrorAtMs" to control?.lastErrorAtMs
                )
            )
            reconcileControlListener(controlHealthy, now)

            val wifi = wifiProvider()
            val wifiHealthy =
                wifi?.enabled == true &&
                    wifi.connected == true &&
                    wifi.internetValidated == true
            components["wifi"] = component(
                previous = previous["wifi"],
                healthy = wifiHealthy,
                state = when {
                    wifiHealthy -> "healthy"
                    wifi == null ||
                        wifi.enabled == null ||
                        wifi.connected == null ||
                        wifi.internetValidated == null -> "unavailable"
                    else -> "degraded"
                },
                checkedAtMs = now,
                reason = when {
                    wifi == null -> "Wi-Fi reconciler is not initialized"
                    wifi.enabled == null -> "Wi-Fi enabled state is unavailable"
                    wifi.enabled == false -> "Wi-Fi is disabled"
                    wifi.connected == null -> "Wi-Fi connection state is unavailable"
                    wifi.connected == false -> "Wi-Fi has no connected network"
                    wifi.internetCapable == false ->
                        "Wi-Fi network does not advertise internet capability"
                    wifi.internetValidated == null ->
                        "Wi-Fi internet validation state is unavailable"
                    wifi.internetValidated == false ->
                        "Android has not validated internet access on Wi-Fi"
                    else -> null
                },
                details = mapOf(
                    "enabled" to wifi?.enabled,
                    "connected" to wifi?.connected,
                    "ssid" to wifi?.ssid,
                    "rssiDbm" to wifi?.rssiDbm,
                    "signalLevel" to wifi?.signalLevel,
                    "signalState" to wifi?.signalState,
                    "internetCapable" to wifi?.internetCapable,
                    "internetValidated" to wifi?.internetValidated,
                    "lastAvailableAtMs" to wifi?.lastAvailableAtMs,
                    "lastLostAtMs" to wifi?.lastLostAtMs,
                    "lastReconnectAttemptAtMs" to wifi?.lastReconnectAttemptAtMs,
                    "retryFailures" to wifi?.retryFailures,
                    "circuitOpen" to wifi?.circuitOpen,
                    "cooldownRemainingMs" to wifi?.cooldownRemainingMs,
                    "lastReason" to wifi?.lastReason
                )
            )

            val tailscalePackage = packageState(TAILSCALE_PACKAGE)
            val tailscaleProbe = TailscaleStateProbe.probe(appContext)
            val tailscaleHealthy =
                tailscalePackage.installed &&
                    tailscalePackage.enabled &&
                    tailscaleProbe.connected
            val vpnRetry = vpnRetryCircuit.snapshot(SystemClock.elapsedRealtime())
            components["vpnTailscale"] = component(
                previous = previous["vpnTailscale"],
                healthy = tailscaleHealthy,
                state = if (tailscaleHealthy) "healthy" else "degraded",
                checkedAtMs = now,
                reason = when {
                    !tailscalePackage.installed && !tailscaleProbe.connected ->
                        tailscalePackage.visibilityReason ?: "Tailscale package is not installed"
                    tailscalePackage.installed && !tailscalePackage.enabled ->
                        "Tailscale package is disabled"
                    !tailscaleProbe.vpnTransportPresent ->
                        "no VPN transport is active on the device"
                    !tailscaleProbe.connected ->
                        "active VPN does not carry a Tailscale signature " +
                            "(MagicDNS or tailnet address)"
                    else -> null
                },
                details = mapOf(
                    "packageInstalled" to tailscalePackage.installed,
                    "packageEnabled" to tailscalePackage.enabled,
                    "vpnTransportAvailable" to tailscaleProbe.vpnTransportPresent,
                    "tailnetAddressAvailable" to
                        (tailscaleProbe.tailnetIpv4Present || tailscaleProbe.tailnetIpv6Present),
                    "magicDnsPresent" to tailscaleProbe.magicDnsPresent,
                    "tailnetIpv4Present" to tailscaleProbe.tailnetIpv4Present,
                    "tailnetIpv6Present" to tailscaleProbe.tailnetIpv6Present,
                    "vpnValidated" to tailscaleProbe.validated,
                    "recoveryRetryFailures" to vpnRetry.failures,
                    "recoveryCircuitOpen" to vpnRetry.circuitOpen,
                    "recoveryCooldownRemainingMs" to vpnRetry.cooldownRemainingMs,
                    "packageVisibilityReason" to tailscalePackage.visibilityReason
                )
            )
            reconcileTailscale(wifiHealthy, tailscaleHealthy, SystemClock.elapsedRealtime())

            val camera = cameraProvider()
            val mediaPortListening = isLocalPortListening(CameraService.CAMERA_PORT)
            val cameraReady =
                camera?.state == CameraHealthManager.State.HEALTHY ||
                    camera?.state == CameraHealthManager.State.IDLE
            val internalMediaHealthy =
                CameraService.isRunning &&
                    mediaPortListening &&
                    cameraReady
            components["internalMedia"] = component(
                previous = previous["internalMedia"],
                healthy = internalMediaHealthy,
                state = if (internalMediaHealthy) "healthy" else "degraded",
                checkedAtMs = now,
                reason = when {
                    !CameraService.isRunning ->
                        CameraService.lastInitializationError ?: "internal media service is not running"
                    !mediaPortListening -> "internal media listener is not reachable"
                    camera == null -> "camera health manager is not initialized"
                    !cameraReady ->
                        camera.lastError ?: "camera state is ${camera.state.name.lowercase()}"
                    else -> null
                },
                details = mapOf(
                    "serviceRunning" to CameraService.isRunning,
                    "port" to CameraService.CAMERA_PORT,
                    "portListening" to mediaPortListening,
                    "cameraState" to camera?.state?.name,
                    "cameraCheckedAtMs" to camera?.checkedAtMs,
                    "cameraLastHealthyAtMs" to camera?.lastHealthyAtMs,
                    "cameraLastRecoveryAtMs" to camera?.lastRecoveryAtMs,
                    "cameraRetryFailures" to camera?.retryFailures,
                    "cameraCircuitOpen" to camera?.circuitOpen,
                    "generation" to CameraService.generation,
                    "lastInitializedAtMs" to CameraService.lastInitializedAtMs,
                    "lastInitializationError" to CameraService.lastInitializationError
                )
            )



            val remoteEnabled = RemoteControlManager.isEnabled(appContext)
            val remoteSelfTest = !remoteEnabled || RemoteControlManager.selfTest()
            components["remoteAgent"] = component(
                previous = previous["remoteAgent"],
                healthy = remoteSelfTest,
                state = when {
                    !remoteEnabled -> "standby"
                    remoteSelfTest -> "healthy"
                    else -> "degraded"
                },
                checkedAtMs = now,
                reason = if (remoteSelfTest) null else "typed root-command self-test failed",
                details = mapOf(
                    "enabledByOwner" to remoteEnabled,
                    "typedCommandSelfTest" to remoteSelfTest,
                    "genericShellAvailable" to (RootCommand.suBinary() != null),
                    "maxActionsPerMinute" to RemoteControlManager.MAX_ACTIONS_PER_MINUTE,
                    "maxScreenshotsPerMinute" to
                        RemoteControlManager.MAX_SCREENSHOTS_PER_MINUTE
                )
            )

            val displayMode = KioskController.displayMode(appContext)
            val currentUrl = KioskController.currentUrl(appContext)
            val signageActive =
                displayMode == KioskController.MODE_WEBPAGE &&
                    currentUrl?.let {
                        try {
                            android.net.Uri.parse(it).path == "/signage-player.html"
                        } catch (_: Exception) {
                            false
                        }
                    } == true
            val rendererHealthy =
                !signageActive ||
                    (KioskActivity.isVisible &&
                        KioskActivity.lastPageLoadedAtMs > 0L &&
                        KioskActivity.lastPageLoadedAtMs >= KioskActivity.lastPageErrorAtMs)
            components["signageService"] = component(
                previous = previous["signageService"],
                healthy = rendererHealthy,
                state = when {
                    !signageActive -> "standby"
                    rendererHealthy -> "healthy"
                    else -> "degraded"
                },
                checkedAtMs = now,
                reason = if (rendererHealthy) null else "signage renderer has no valid loaded page",
                details = mapOf(
                    "renderer" to "roshanos_kiosk",
                    "active" to signageActive,
                    "rendererVisible" to KioskActivity.isVisible,
                    "lastPageLoadedAtMs" to KioskActivity.lastPageLoadedAtMs,
                    "lastPageErrorAtMs" to KioskActivity.lastPageErrorAtMs,
                    "dashboardConfigured" to
                        KioskController.isDashboardConfigured(appContext),
                    "displayMode" to displayMode,
                    "currentUrlConfigured" to
                        !KioskController.currentUrl(appContext).isNullOrBlank()
                )
            )

            val memory = TelemetryProvider.memory(appContext)
            val storage = TelemetryProvider.storage()
            val storageReserveBytes =
                storage?.let { DeviceControlPolicy.storageReserveBytes(it.totalBytes) }
            val storageLow =
                storage?.let {
                    DeviceControlPolicy.isStorageLow(it.freeBytes, it.totalBytes)
                }
            val resourcesHealthy =
                memory != null &&
                    storage != null &&
                    !memory.lowMemory &&
                    storageLow == false
            components["resources"] = component(
                previous = previous["resources"],
                healthy = resourcesHealthy,
                state = when {
                    resourcesHealthy -> "healthy"
                    memory == null || storage == null -> "unavailable"
                    else -> "degraded"
                },
                checkedAtMs = now,
                reason = when {
                    memory == null -> "Android memory telemetry is unavailable"
                    storage == null -> "Android storage telemetry is unavailable"
                    memory.lowMemory -> "Android reports a low-memory condition"
                    storageLow == true -> "RoshanOS storage reserve is low"
                    else -> null
                },
                details = mapOf(
                    "memoryAvailableBytes" to memory?.availableBytes,
                    "memoryTotalBytes" to memory?.totalBytes,
                    "memoryLow" to memory?.lowMemory,
                    "memoryLowThresholdBytes" to memory?.lowMemoryThresholdBytes,
                    "storageFreeBytes" to storage?.freeBytes,
                    "storageTotalBytes" to storage?.totalBytes,
                    "storageLow" to storageLow,
                    "storageReserveBytes" to storageReserveBytes
                )
            )

            components["supervisor"] = component(
                previous = previous["supervisor"],
                healthy = true,
                state = "healthy",
                checkedAtMs = now,
                reason = null,
                details = mapOf(
                    "running" to running.get(),
                    "startedAtMs" to startedAtMs,
                    "reconciliationReason" to reason
                )
            )

            val degradedReasons = linkedSetOf<String>()
            if (!controlHealthy) addReason(degradedReasons, "controlListener", components)
            if (!wifiHealthy) addReason(degradedReasons, "wifi", components)
            if (!tailscaleHealthy) addReason(degradedReasons, "vpnTailscale", components)
            if (!internalMediaHealthy) {
                addReason(degradedReasons, "internalMedia", components)
            }
            if (remoteEnabled && !remoteSelfTest) {
                addReason(degradedReasons, "remoteAgent", components)
            }
            if (signageActive && !rendererHealthy) {
                addReason(degradedReasons, "signageService", components)
            }
            if (!resourcesHealthy) {
                addReason(degradedReasons, "resources", components)
            }

            // Home is gated only by the essential local services: the RoshanOS
            // control listener and platform resources. Tailscale (remote
            // controller), the root-only remote agent, camera/media, and
            // signage are optional capabilities: they are reported as degraded
            // diagnostics but never trap the tablet out of RoshanOS Home.
            val requiredServicesReady = controlHealthy && resourcesHealthy
            val homeReady = wifiHealthy && requiredServicesReady
            val nextSnapshot = Snapshot(
                healthy = controlHealthy &&
                    wifiHealthy &&
                    tailscaleHealthy &&
                    internalMediaHealthy &&
                    remoteSelfTest &&
                    rendererHealthy &&
                    resourcesHealthy,
                homeReady = homeReady,
                supervisorStartedAtMs = startedAtMs,
                reconciledAtMs = now,
                reconciliationReason = reason,
                degradedReasons = degradedReasons.toList(),
                components = components
            )
            currentSnapshot = nextSnapshot
            RoshanRuntimeReadiness.update(
                appContext,
                wifiConnected = wifiHealthy,
                privateNetworkConnected = tailscaleHealthy,
                requiredServicesReady = requiredServicesReady,
                requiredComponentsUnready = buildList {
                    if (!controlHealthy) add("controlListener")
                    if (!resourcesHealthy) add("resources")
                },
                reasonCode = when {
                    !wifiHealthy -> "wifi_required"
                    !requiredServicesReady -> "services_recovery"
                    else -> "ready"
                }
            )
            val previousState = when {
                previousSnapshot.reconciledAtMs == 0L -> "starting"
                previousSnapshot.healthy -> "healthy"
                else -> "degraded"
            }
            val nextState = if (nextSnapshot.healthy) "healthy" else "degraded"
            if (previousState != nextState) {
                val fields = mapOf(
                    "previous_state" to previousState,
                    "state" to nextState,
                    "degraded_count" to nextSnapshot.degradedReasons.size
                )
                if (nextSnapshot.healthy) {
                    DiagnosticEventStore.info(
                        appContext,
                        "supervisor",
                        "health_transition",
                        fields
                    )
                } else {
                    DiagnosticEventStore.warn(
                        appContext,
                        "supervisor",
                        "health_transition",
                        fields
                    )
                }
            }
        } catch (error: Exception) {
            publishSupervisorFailure(now, reason, error)
        }
    }

    private fun reconcileControlListener(healthy: Boolean, nowMs: Long) {
        if (healthy) {
            controlRetryCircuit.onSuccess()
            controlRecoveryRunnable?.let { handler.removeCallbacks(it) }
            controlRecoveryRunnable = null
            controlRecoveryPending.set(false)
            return
        }
        if (!controlRecoveryPending.compareAndSet(false, true)) return

        val plan = controlRetryCircuit.onFailure(nowMs)
        if (plan.disposition == RetryCircuit.Disposition.CIRCUIT_OPEN) {
            controlRecoveryPending.set(false)
            return
        }
        val runnable = Runnable {
            controlRecoveryRunnable = null
            controlRecoveryPending.set(false)
            if (!running.get()) return@Runnable
            try {
                worker.execute {
                    try {
                        recoverControlListener()
                    } catch (error: Exception) {
                        DiagnosticEventStore.error(
                            appContext,
                            component = "supervisor",
                            event = "control_recovery_failed",
                            fields = mapOf(
                                "error_class" to error.javaClass.simpleName
                            )
                        )
                        Log.w(TAG, "Control listener recovery failed", error)
                    } finally {
                        requestReconciliation("control_listener_recovery")
                    }
                }
            } catch (_: Exception) {
            }
        }
        controlRecoveryRunnable = runnable
        handler.postDelayed(runnable, plan.delayMs)
    }

    private fun reconcileTailscale(
        wifiHealthy: Boolean,
        tailscaleHealthy: Boolean,
        nowElapsedMs: Long
    ) {
        if (tailscaleHealthy) {
            vpnRetryCircuit.onSuccess()
            vpnRecoveryRunnable?.let { handler.removeCallbacks(it) }
            vpnRecoveryRunnable = null
            vpnRecoveryPending.set(false)
            return
        }
        // Never churn the VPN while Android has no validated underlying Wi-Fi.
        if (!wifiHealthy) {
            vpnRecoveryRunnable?.let { handler.removeCallbacks(it) }
            vpnRecoveryRunnable = null
            vpnRecoveryPending.set(false)
            return
        }
        if (!vpnRecoveryPending.compareAndSet(false, true)) return

        val plan = vpnRetryCircuit.onFailure(nowElapsedMs)
        if (plan.disposition == RetryCircuit.Disposition.CIRCUIT_OPEN) {
            vpnRecoveryPending.set(false)
            return
        }
        val runnable = Runnable {
            vpnRecoveryRunnable = null
            vpnRecoveryPending.set(false)
            if (!running.get()) return@Runnable
            try {
                worker.execute {
                    val reconciled =
                        DevicePolicyController.reconcileAlwaysOnVpn(appContext)
                    if (reconciled) {
                        DiagnosticEventStore.info(
                            appContext,
                            component = "supervisor",
                            event = "vpn_recovery_requested",
                            fields = mapOf(
                                "service" to "vpn",
                                "retry_attempt" to plan.retryAttempt
                            )
                        )
                    } else {
                        DiagnosticEventStore.warn(
                            appContext,
                            component = "supervisor",
                            event = "vpn_recovery_failed",
                            fields = mapOf(
                                "service" to "vpn",
                                "retry_attempt" to plan.retryAttempt
                            )
                        )
                    }
                    requestReconciliation("vpn_policy_recovery")
                }
            } catch (_: Exception) {
            }
        }
        vpnRecoveryRunnable = runnable
        handler.postDelayed(runnable, plan.delayMs)
    }

    private fun publishSupervisorFailure(nowMs: Long, reason: String, error: Exception) {
        val shouldRecordFailure =
            currentSnapshot.components["supervisor"]?.state != "degraded"
        val message = "supervisor reconciliation failed: ${error.message ?: error.javaClass.simpleName}"
        val components = currentSnapshot.components.toMutableMap()
        components["supervisor"] = component(
            previous = components["supervisor"],
            healthy = false,
            state = "degraded",
            checkedAtMs = nowMs,
            reason = message,
            details = mapOf(
                "running" to running.get(),
                "startedAtMs" to startedAtMs,
                "reconciliationReason" to reason
            )
        )
        currentSnapshot = Snapshot(
            healthy = false,
            homeReady = false,
            supervisorStartedAtMs = startedAtMs,
            reconciledAtMs = nowMs,
            reconciliationReason = reason,
            degradedReasons = (currentSnapshot.degradedReasons + message).distinct(),
            components = components
        )
        RoshanRuntimeReadiness.markSupervisorFailure(appContext)
        if (shouldRecordFailure) {
            DiagnosticEventStore.error(
                appContext,
                component = "supervisor",
                event = "reconciliation_failed",
                fields = mapOf(
                    "state" to "degraded",
                    "error_class" to error.javaClass.simpleName
                )
            )
        }
        Log.e(TAG, message, error)
    }

    private fun component(
        previous: ComponentHealth?,
        healthy: Boolean,
        state: String,
        checkedAtMs: Long,
        reason: String?,
        details: Map<String, Any?>
    ): ComponentHealth = ComponentHealth(
        state = state,
        checkedAtMs = checkedAtMs,
        lastHealthyAtMs = if (healthy) checkedAtMs else previous?.lastHealthyAtMs ?: 0L,
        degradedReason = if (healthy) null else reason,
        details = details
    )

    private fun addReason(
        target: MutableSet<String>,
        componentName: String,
        components: Map<String, ComponentHealth>
    ) {
        val reason = components[componentName]?.degradedReason ?: "component is degraded"
        target += "$componentName: $reason"
    }

    private fun packageState(packageName: String): PackageState {
        return try {
            @Suppress("DEPRECATION")
            val app = packageManager.getApplicationInfo(packageName, 0)
            val setting = packageManager.getApplicationEnabledSetting(packageName)
            val enabledBySetting =
                setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED &&
                    setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER &&
                    setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED
            PackageState(true, app.enabled && enabledBySetting, null)
        } catch (_: PackageManager.NameNotFoundException) {
            PackageState(
                installed = false,
                enabled = false,
                visibilityReason = "$packageName is missing or not visible to RoshanCore"
            )
        } catch (error: Exception) {
            PackageState(
                installed = false,
                enabled = false,
                visibilityReason = "package state unavailable: ${error.message}"
            )
        }
    }

    private fun isLocalPortListening(port: Int): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(java.net.InetSocketAddress("127.0.0.1", port), 500)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun probeJsonEndpoint(url: String): HttpProbe {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL(url).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 750
            connection.readTimeout = 750
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            if (status != 200) return HttpProbe(status, false, null)

            val input = connection.inputStream ?: return HttpProbe(status, false, "empty response")
            val output = java.io.ByteArrayOutputStream()
            input.use {
                val buffer = ByteArray(4 * 1024)
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 64 * 1024) {
                        return HttpProbe(status, false, "status response exceeded 64 KB")
                    }
                    output.write(buffer, 0, count)
                }
            }
            val text = output.toString(Charsets.UTF_8.name())
            try {
                JSONObject(text)
                HttpProbe(status, true, null)
            } catch (_: Exception) {
                HttpProbe(status, false, "status response was not JSON")
            }
        } catch (error: Exception) {
            HttpProbe(null, false, error.message ?: error.javaClass.simpleName)
        } finally {
            try {
                connection?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun startingSnapshot(): Snapshot {
        val now = System.currentTimeMillis()
        val starting = ComponentHealth(
            state = "starting",
            checkedAtMs = now,
            lastHealthyAtMs = 0L,
            degradedReason = "initial reconciliation has not completed",
            details = emptyMap()
        )
        return Snapshot(
            healthy = false,
            homeReady = false,
            supervisorStartedAtMs = startedAtMs,
            reconciledAtMs = 0L,
            reconciliationReason = "starting",
            degradedReasons = listOf("supervisor: initial reconciliation has not completed"),
            components = linkedMapOf(
                "controlListener" to starting,
                "wifi" to starting,
                "vpnTailscale" to starting,
                "internalMedia" to starting,
                "ipWebcamFallback" to starting,
                "remoteAgent" to starting,
                "signageService" to starting,
                "resources" to starting,
                "supervisor" to starting
            )
        )
    }
}
