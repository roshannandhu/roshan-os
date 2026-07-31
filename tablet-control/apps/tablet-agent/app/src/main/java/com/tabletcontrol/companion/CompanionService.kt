package com.tabletcontrol.companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.IBinder
import android.os.SystemClock
import android.os.UserManager
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

class CompanionService : Service() {
    private val TAG = "CompanionService"
    private val CHANNEL_ID = "companion_channel"
    private val NOTIF_ID = 1

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val initializationLock = Any()
    private val crashGuardLock = Any()
    private var httpServer: SimpleHttpServer? = null
    private val audioLock = Any()
    private var audioTrack: AudioTrack? = null
    private var wifiEnforcementManager: WifiEnforcementManager? = null
    private var cameraHealthManager: CameraHealthManager? = null
    private var serverHealthSupervisor: ServerHealthSupervisor? = null
    private val cameraVideoClients = AtomicInteger(0)
    private val cameraAudioClients = AtomicInteger(0)
    private val cameraStreamLock = Any()
    private val shutdownGate =
        DeviceControlPolicy.ActionGate(DeviceControlPolicy.POWER_ACTION_MIN_INTERVAL_MS)
    private val diagnosticStateLock = Any()
    private var diagnosticInitialized = false
    private var lastMediaReadinessState: String? = null
    @Volatile
    private var directBootMode = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        startForeground(
            NOTIF_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )

        if (!isUserUnlocked()) {
            ensureDirectBootListener()
            return START_STICKY
        }

        val reconciliationReason = intent?.getStringExtra(EXTRA_RECONCILE_REASON)
            ?: if (intent?.action == ACTION_RECONCILE) {
                "service_reconcile"
            } else {
                "service_start"
            }
        DiagnosticEventStore.info(
            applicationContext,
            component = "core",
            event = "service_start",
            fields = mapOf(
                "reason" to diagnosticReconciliationReason(reconciliationReason)
            )
        )

        if (isRapidRestartCycle()) {
            Log.w(TAG, "Rapid restart detected — deferring full initialization")
            DiagnosticEventStore.warn(
                applicationContext,
                component = "core",
                event = "rapid_restart_deferred"
            )
            ensureDirectBootListener()
            if (!isUserUnlocked()) return START_STICKY
            Thread({
                try { Thread.sleep(15_000L) } catch (_: InterruptedException) {}
                handler.post {
                    ensureCoreInitialized()
                    serverHealthSupervisor?.requestReconciliation(reconciliationReason)
                }
            }, "roshan-restart-guard").apply { isDaemon = true; start() }
            return START_STICKY
        }

        ensureCoreInitialized()
        serverHealthSupervisor?.requestReconciliation(reconciliationReason)

        return START_STICKY
    }

    private fun isRapidRestartCycle(): Boolean {
        synchronized(crashGuardLock) {
            val prefs = applicationContext.getSharedPreferences(
                CRASH_GUARD_PREFS, Context.MODE_PRIVATE
            )
            val now = System.currentTimeMillis()
            val lastCrash = prefs.getLong(CRASH_GUARD_LAST_MS, 0L)
            val count = prefs.getInt(CRASH_GUARD_COUNT, 0)

            if (now - lastCrash > CRASH_GUARD_RESET_WINDOW_MS) {
                prefs.edit()
                    .putLong(CRASH_GUARD_LAST_MS, now)
                    .putInt(CRASH_GUARD_COUNT, 1)
                    .commit()
                return false
            }
            if (count >= CRASH_GUARD_MAX_RESTARTS) {
                return true
            }
            prefs.edit()
                .putLong(CRASH_GUARD_LAST_MS, now)
                .putInt(CRASH_GUARD_COUNT, count + 1)
                .commit()
            return false
        }
    }

    companion object {
        private const val MAX_VIDEO_CLIENTS = 3
        private const val MAX_AUDIO_CLIENTS = 1
        private const val CRASH_GUARD_PREFS = "companion_crash_guard"
        private const val CRASH_GUARD_LAST_MS = "last_crash_ms"
        private const val CRASH_GUARD_COUNT = "crash_count"
        private const val CRASH_GUARD_RESET_WINDOW_MS = 120_000L
        private const val CRASH_GUARD_MAX_RESTARTS = 3
        const val ACTION_RECONCILE = "com.tabletcontrol.companion.action.RECONCILE_SERVERS"
        const val EXTRA_RECONCILE_REASON = "reconcile_reason"

        private fun diagnosticReconciliationReason(reason: String): String = when {
            reason.startsWith("boot:") -> "boot_handoff"
            reason.startsWith("provisioning:") -> "provisioning"
            reason == "service_reconcile" -> reason
            reason == "service_start" -> reason
            else -> "internal_reconcile"
        }
    }

    override fun onDestroy() {
        synchronized(initializationLock) {
            serverHealthSupervisor?.stop()
            serverHealthSupervisor = null
            wifiEnforcementManager?.stop()
            wifiEnforcementManager = null
            cameraHealthManager?.stop()
            cameraHealthManager = null
            httpServer?.stop()
            httpServer = null
        }
        synchronized(audioLock) {
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
        }
        if (isUserUnlocked()) {
            DiagnosticEventStore.info(
                applicationContext,
                component = "core",
                event = "service_stopped"
            )
        }
        super.onDestroy()
    }

    private fun isUserUnlocked(): Boolean {
        return try {
            val userManager =
                getSystemService(Context.USER_SERVICE) as UserManager
            userManager.isUserUnlocked
        } catch (_: Exception) {
            false
        }
    }

    private fun ensureDirectBootListener(): Boolean {
        synchronized(initializationLock) {
            val existing = httpServer
            if (directBootMode && existing?.isRunning() == true) return true
            existing?.stop()

            val replacement = SimpleHttpServer(
                BuildConfig.COMPANION_PORT,
                ::handleDirectBootRequest
            )
            httpServer = replacement
            val started = replacement.start()
            directBootMode = started
            Log.i(
                TAG,
                if (started) {
                    "Direct-boot health listener started"
                } else {
                    "Direct-boot health listener unavailable"
                }
            )
            return started
        }
    }

    private fun handleDirectBootRequest(req: HttpRequest): HttpResponse {
        return when (DirectBootRequestPolicy.decide(req.method, req.path)) {
            DirectBootRequestPolicy.Decision.HEALTH ->
                ok(
                    JSONObject()
                        .put("service", "RoshanCore")
                        .put("healthy", httpServer?.isRunning() == true)
                        .put("userUnlocked", false)
                        .put("state", "direct_boot")
                        .put("apiVersion", 1)
                )
            DirectBootRequestPolicy.Decision.LOCKED ->
                err(
                    423,
                    "CONFLICT",
                    "RoshanCore protected routes are locked until the Android user unlocks."
                )
        }
    }

    private fun ensureCoreInitialized() {
        synchronized(initializationLock) {
            when (AdbCredentialRecovery.applyIfPresent(applicationContext)) {
                AdbCredentialRecovery.Result.APPLIED ->
                    DiagnosticEventStore.info(
                        applicationContext,
                        component = "credentials",
                        event = "adb_recovery_applied"
                    )
                AdbCredentialRecovery.Result.REFUSED ->
                    DiagnosticEventStore.warn(
                        applicationContext,
                        component = "credentials",
                        event = "adb_recovery_refused"
                    )
                AdbCredentialRecovery.Result.ABSENT -> Unit
            }
            // Reconcile Device Owner policy on every process generation. This
            // restores the fail-unlocked status-bar/lock-task state after a
            // process death and re-applies normal-user protections after boot.
            DevicePolicyController.applyDeviceOwnerPolicies(applicationContext)
            TailscaleEnrollmentManager.reconcileAfterProcessStart(applicationContext)
            TailscaleConnectionReconciler.reconcile(applicationContext)
            RoshanUpdateManager.reconcileAfterProcessStart(applicationContext)
            ensureControlListener()

            // Credential provisioning uses ADB-only file handoff via
            // AdbCredentialRecovery. No pairing mode is auto-enabled.

            if (serverHealthSupervisor == null) {
                serverHealthSupervisor = ServerHealthSupervisor(
                    context = applicationContext,
                    controlListenerProvider = { httpServer?.snapshot() },
                    recoverControlListener = { ensureControlListener() },
                    wifiProvider = { wifiEnforcementManager?.snapshot() },
                    cameraProvider = { cameraHealthManager?.snapshot() }
                )
            }

            if (wifiEnforcementManager == null) {
                wifiEnforcementManager = WifiEnforcementManager(applicationContext) { reason ->
                    serverHealthSupervisor?.requestReconciliation(reason)
                    if (reason.contains("available")) ensureInternalMediaStarted()
                }
            }
            if (cameraHealthManager == null) {
                cameraHealthManager = CameraHealthManager(applicationContext)
            }

            wifiEnforcementManager?.start()
            cameraHealthManager?.start()
            serverHealthSupervisor?.start()

            ensureInternalMediaStarted()
            if (!diagnosticInitialized) {
                diagnosticInitialized = true
                synchronized(crashGuardLock) {
                    applicationContext.getSharedPreferences(
                        CRASH_GUARD_PREFS, Context.MODE_PRIVATE
                    ).edit()
                        .remove(CRASH_GUARD_LAST_MS)
                        .remove(CRASH_GUARD_COUNT)
                        .commit()
                }
                TechnicalLauncherManager.reconcile(applicationContext, hiddenFromNormalUser = true)
                DiagnosticEventStore.info(
                    applicationContext,
                    component = "core",
                    event = "initialized",
                    fields = mapOf("state" to "ready")
                )
            }
        }
    }

    private fun ensureControlListener(): Boolean {
        synchronized(initializationLock) {
            val existing = httpServer
            if (!directBootMode && existing?.isRunning() == true) return true
            existing?.stop()
            directBootMode = false

            val replacement = SimpleHttpServer(
                BuildConfig.COMPANION_PORT,
                ::handleRequest
            )
            httpServer = replacement
            val started = replacement.start()
            directBootMode = false
            if (started) {
                DiagnosticEventStore.info(
                    applicationContext,
                    component = "core",
                    event = "control_listener_started",
                    fields = mapOf("state" to "listening")
                )
                Log.i(TAG, "Companion control listener started on ${BuildConfig.COMPANION_PORT}")
            } else {
                DiagnosticEventStore.error(
                    applicationContext,
                    component = "core",
                    event = "control_listener_failed",
                    fields = mapOf("state" to "not_listening")
                )
            }
            return started
        }
    }

    private fun ensureInternalMediaStarted(): Boolean {
        if (!CredentialStore.isEnrolled(applicationContext)) {
            recordMediaReadiness("waiting_enrollment", DiagnosticEventPolicy.Level.INFO)
            return false
        }
        val cameraGranted = ContextCompat.checkSelfPermission(
            applicationContext,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        val microphoneGranted = ContextCompat.checkSelfPermission(
            applicationContext,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (!cameraGranted || !microphoneGranted) {
            recordMediaReadiness(
                "permission_required",
                DiagnosticEventPolicy.Level.WARN
            )
            cameraHealthManager?.requestImmediateCheck()
            return false
        }

        return try {
            CameraService.ensureStarted(applicationContext)
            cameraHealthManager?.requestImmediateCheck()
            recordMediaReadiness("start_requested", DiagnosticEventPolicy.Level.INFO)
            true
        } catch (error: Exception) {
            recordMediaReadiness(
                "start_failed",
                DiagnosticEventPolicy.Level.ERROR,
                error.javaClass.simpleName
            )
            Log.e(TAG, "Internal media service start failed", error)
            false
        }
    }

    private fun recordMediaReadiness(
        state: String,
        level: DiagnosticEventPolicy.Level,
        errorClass: String? = null
    ) {
        synchronized(diagnosticStateLock) {
            if (lastMediaReadinessState == state) return
            lastMediaReadinessState = state
        }
        val fields = linkedMapOf<String, Any?>("state" to state)
        if (errorClass != null) fields["error_class"] = errorClass
        when (level) {
            DiagnosticEventPolicy.Level.INFO ->
                DiagnosticEventStore.info(
                    applicationContext,
                    "media",
                    "readiness_transition",
                    fields
                )
            DiagnosticEventPolicy.Level.WARN ->
                DiagnosticEventStore.warn(
                    applicationContext,
                    "media",
                    "readiness_transition",
                    fields
                )
            DiagnosticEventPolicy.Level.ERROR ->
                DiagnosticEventStore.error(
                    applicationContext,
                    "media",
                    "readiness_transition",
                    fields
                )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun handleRequest(req: HttpRequest): HttpResponse {
        if (req.path == "/health") {
            // Unauthenticated liveness is intentionally minimal for local
            // watchdogs and fail-safe APK updates. Component/package/network
            // diagnostics are available only on the authenticated
            // /api/v1/companion/server-health endpoint.
            return ok(
                JSONObject()
                    .put("service", "RoshanCore")
                    .put("healthy", httpServer?.isRunning() == true)
                    .put("apiVersion", 1)
            )
        }
        if (req.path == "/" || req.path == "/clock") {
            val clockHtml = """
                <!DOCTYPE html>
                <html lang="en">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                  <title>Ambient Clock</title>
                  <style>
                    @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&display=swap');
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                      background-color: #000000;
                      color: #00A2FF;
                      font-family: 'Big Shoulders Display', 'sans-serif-condensed', sans-serif;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      justify-content: center;
                      min-height: 100vh;
                      overflow: hidden;
                      user-select: none;
                    }
                    .clock-container {
                      text-align: center;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      justify-content: center;
                    }
                    .time {
                      font-size: 30vw;
                      line-height: 0.88;
                      letter-spacing: 0.01em;
                    }
                    .date {
                      font-size: 5.5vw;
                      letter-spacing: 0.08em;
                      margin-top: 1rem;
                      text-transform: uppercase;
                    }
                    @media (orientation: landscape) {
                      .time { font-size: 42vh; }
                      .date { font-size: 8vh; margin-top: 0.5rem; }
                    }
                  </style>
                </head>
                <body>
                  <div class="clock-container">
                    <div class="time" id="t">10:08</div>
                    <div class="date" id="d">SATURDAY, MAY 24</div>
                  </div>
                  <script>
                    function u() {
                      const n = new Date();
                      const timeStr = n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[AP]M/i, '');
                      const dateParts = n.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
                      document.getElementById('t').textContent = timeStr;
                      document.getElementById('d').textContent = dateParts.toUpperCase();
                    }
                    setInterval(u, 1000);
                    u();
                  </script>
                </body>
                </html>
            """.trimIndent()
            return HttpResponse(200, clockHtml, "text/html; charset=utf-8")
        }

        val authResult = CredentialStore.validateHeader(
            applicationContext,
            req.headers["authorization"]
        )
        if (!authResult.valid) {
            Log.w(TAG, "Auth failed: ${authResult.errorMessage} [Header: ${CredentialStore.redactHeader(req.headers["authorization"])}]")
            return err(401, "UNAUTHENTICATED", authResult.errorMessage)
        }

        return when {
            req.method == "GET"  && req.path == "/api/v1/companion/status"            -> handleStatus()
            req.method == "GET"  && req.path == "/api/v1/companion/server-health"     -> handleServerHealth()
            req.method == "GET"  && req.path == "/api/v1/companion/diagnostics"       -> handleDiagnostics()
            req.method == "POST" && req.path == "/api/v1/companion/diagnostics/clear" -> handleDiagnosticsClear(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/remote/status"      -> handleRemoteStatus()
            req.method == "POST" && req.path == "/api/v1/companion/remote/enabled"     -> handleRemoteEnabled(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/remote/screenshot"  -> handleRemoteScreenshot()
            req.method == "POST" && req.path == "/api/v1/companion/remote/tap"         -> handleRemoteTap(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/remote/swipe"       -> handleRemoteSwipe(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/remote/key"         -> handleRemoteKey(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/remote/text"        -> handleRemoteText(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/remote/close-app"   -> handleRemoteCloseApp(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/remote/audit"       -> handleRemoteAudit()
            req.method == "POST" && req.path == "/api/v1/companion/brightness"         -> handleBrightness(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/brightness/mode"    -> handleBrightnessMode(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/volume"             -> handleVolume(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/mute"               -> handleMute(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/orientation"        -> handleOrientation(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/apps"               -> ok(ApprovedApps.installed(applicationContext))
            req.method == "GET"  && req.path == "/api/v1/companion/apps/technical"     -> handleTechnicalApps()
            req.method == "POST" && req.path == "/api/v1/companion/apps/approve"       -> handleApproveApp(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/apps/revoke"        -> handleRevokeApp(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/apps/launch"        -> handleAppLaunch(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/media"              -> handleMedia(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/screen"             -> handleScreen(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/screen/timeout"     -> handleScreenTimeout(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/touch_lock"         -> handleTouchLock(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/device/lock"        -> handleDeviceLock(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/device/reboot"      -> handleDeviceReboot()
            req.method == "POST" && req.path == "/api/v1/companion/device/shutdown"    -> handleDeviceShutdown(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/services/restart"   -> handleServiceRestart(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/audio/start"        -> handleAudioStart()
            req.method == "POST" && req.path == "/api/v1/companion/audio/frame"        -> handleAudioFrame(req.rawBody)
            req.method == "POST" && req.path == "/api/v1/companion/audio/stop"         -> handleAudioStop()
            req.method == "GET"  && req.path == "/api/v1/companion/kiosk/status"        -> handleKioskStatus()
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/dashboard"     -> handleKioskDashboard(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/message"       -> handleKioskMessage(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/live-text"     -> handleKioskLiveText(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/clear-live-text" -> handleKioskClearLiveText()
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/webpage"       -> handleKioskWebpage(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/black"         -> handleKioskBlack()
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/clock"         -> handleKioskClock()
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/clock-color"   -> handleKioskClockColor(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/kiosk/restore"       -> handleKioskRestore()
            req.method == "GET"  && req.path == "/api/v1/companion/camera/status"        -> handleCameraStatus()
            req.method == "GET"  && req.path == "/api/v1/companion/camera/video"         -> handleCameraVideo()
            req.method == "GET"  && req.path == "/api/v1/companion/camera/audio"         -> handleCameraAudio()
            req.method == "GET"  && req.path == "/api/v1/companion/camera/snapshot"      -> handleCameraSnapshot()
            req.method == "POST" && req.path == "/api/v1/companion/camera/select"        -> handleCameraSelect(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/camera/health"        -> handleCameraHealth()
            req.method == "GET"  && req.path == "/api/v1/companion/dpc/status"          -> handleDpcStatus()
            req.method == "POST" && req.path == "/api/v1/companion/dpc/maintenance"     -> handleDpcMaintenance(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/tailscale/enroll" ->
                handleTailscaleEnrollment(req.body)
            req.method == "GET" && req.path ==
                "/api/v1/companion/tailscale/enrollment/status" ->
                ok(TailscaleEnrollmentManager.statusJson(applicationContext))
            req.method == "POST" && req.path == "/api/v1/companion/update/controller-origin" ->
                handleUpdateControllerOrigin(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/update/request" ->
                handleUpdateRequest(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/update/status" ->
                ok(RoshanUpdateManager.statusJson(applicationContext))
            req.method == "POST" && req.path == "/api/v1/companion/update/rollback" ->
                handleUpdateRollback(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/admin/pin/rate-limit/reset" ->
                handlePinRateLimitReset(req.body)
            req.method == "GET"  && req.path == "/api/v1/companion/location"               -> handleGetLocation()
            req.method == "POST" && req.path == "/api/v1/companion/location/mode"          -> handleSetLocationMode(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/device/find/sound"      -> handleFindSound(req.body)
            req.method == "POST" && req.path == "/api/v1/companion/device/find/sound/stop" -> handleFindSoundStop()
            else -> err(404, "NOT_FOUND", "Unknown route: ${req.method} ${req.path}")
        }
    }

    private fun handleTechnicalApps(): HttpResponse {
        val technicalSet = ApprovedApps.technicalPackages(applicationContext)
        val pm = applicationContext.packageManager
        val result = JSONArray()
        for (pkg in technicalSet) {
            val label = try {
                pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString()
            } catch (_: Exception) {
                pkg
            }
            result.put(JSONObject().apply {
                put("packageName", pkg)
                put("label", label)
            })
        }
        return ok(result)
    }

    private fun handleStatus(): HttpResponse {
        val ctx = applicationContext
        val memory = TelemetryProvider.memory(ctx)
        val storage = TelemetryProvider.storage()
        val connectivity = TelemetryProvider.connectivity(ctx)
        val foregroundApp = TelemetryProvider.foregroundApprovedApp(ctx)
        val update = TelemetryProvider.update(ctx)
        val serverSnapshot = serverHealthSupervisor?.snapshot()
        val data = JSONObject().apply {
            put("mode", "companion")
            put("online", true)
            put("batteryPercent", jsonValue(TelemetryProvider.batteryPercent(ctx)))
            put("charging", jsonValue(TelemetryProvider.isCharging(ctx)))
            put(
                "batteryTemperatureC",
                jsonValue(TelemetryProvider.batteryTemperatureC(ctx))
            )
            put("brightness", jsonValue(TelemetryProvider.brightness(ctx)))
            put("brightnessMode", jsonValue(TelemetryProvider.brightnessMode(ctx)))
            put("screenTimeoutMs", jsonValue(TelemetryProvider.screenTimeoutMs(ctx)))
            put(
                "screenOrientation",
                jsonValue(TelemetryProvider.screenOrientation(ctx))
            )
            put("screenOn", jsonValue(TelemetryProvider.isScreenOn(ctx)))
            put("keyguardLocked", jsonValue(TelemetryProvider.isKeyguardLocked(ctx)))
            put("deviceLocked", jsonValue(TelemetryProvider.isDeviceLocked(ctx)))
            put("displayMode", KioskController.displayMode(ctx))
            put("touchLock", KioskController.isTouchLocked(ctx))
            put("mediaVolume", jsonValue(TelemetryProvider.musicVolume(ctx)))
            put("mediaVolumeMax", jsonValue(TelemetryProvider.musicVolumeMax(ctx)))
            put(
                "storageFreeMb",
                jsonValue(storage?.freeBytes?.div(1_048_576L))
            )
            put("uptimeSeconds", TelemetryProvider.uptimeSeconds())
            put("connectivity", JSONObject().apply {
                put("wifiEnabled", jsonValue(connectivity.wifiEnabled))
                put("wifiConnected", jsonValue(connectivity.wifiConnected))
                put("wifiSsid", jsonValue(connectivity.ssid))
                put("wifiRssiDbm", jsonValue(connectivity.rssiDbm))
                put("wifiSignalLevel", jsonValue(connectivity.signalLevel))
                put("wifiSignalState", jsonValue(connectivity.signalState))
                put("internetCapable", jsonValue(connectivity.internetCapable))
                put("internetValidated", jsonValue(connectivity.internetValidated))
            })
            put("memory", JSONObject().apply {
                put("availableBytes", jsonValue(memory?.availableBytes))
                put("totalBytes", jsonValue(memory?.totalBytes))
                put("lowMemory", jsonValue(memory?.lowMemory))
                put(
                    "lowMemoryThresholdBytes",
                    jsonValue(memory?.lowMemoryThresholdBytes)
                )
            })
            put("foregroundApp", JSONObject().apply {
                put("state", foregroundApp.state)
                put("packageName", jsonValue(foregroundApp.packageName))
                put("label", jsonValue(foregroundApp.label))
            })
            put("boot", JSONObject().apply {
                put("lastBootAtMs", jsonValue(TelemetryProvider.lastBootAtMs()))
                put("uptimeSeconds", TelemetryProvider.uptimeSeconds())
                put(
                    "recoveryState",
                    DeviceControlPolicy.bootRecoveryState(
                        serverSnapshot?.homeReady,
                        serverSnapshot?.reconciledAtMs
                    )
                )
                put(
                    "recoveryVerifiedAtMs",
                    jsonValue(serverSnapshot?.reconciledAtMs?.takeIf { it > 0L })
                )
            })
            put("update", JSONObject().apply {
                put("state", update.state)
                put("versionName", jsonValue(update.versionName))
                put("versionCode", jsonValue(update.versionCode))
                put("firstInstalledAtMs", jsonValue(update.firstInstalledAtMs))
                put("lastAppliedAtMs", jsonValue(update.lastAppliedAtMs))
                // This build has no trustworthy public signal for a pending
                // system-image update, so report the state explicitly.
                put("pendingSystemUpdateState", "unknown")
            })
            val credentialMetadata = CredentialStore.getMetadata(ctx)
            put("enrolled", credentialMetadata.enrolled)
            put("credentialState", credentialMetadata.state)
            put("credentialVersion", credentialMetadata.credentialVersion)
            put("pinState", AdminPinStore.getState(ctx).name)
            put("pairingActive", false)
            put("remoteControl", RemoteControlManager.statusJson(ctx))
            put(
                "serverHealth",
                serverSnapshot?.toJson()
                    ?: JSONObject().put("healthy", false).put("state", "starting")
            )
        }
        return ok(data)
    }

    private fun handlePinRateLimitReset(bodyStr: String): HttpResponse {
        if (bodyStr.isNotBlank() && bodyStr.trim() != "{}") {
            return err(400, "BAD_REQUEST", "This action does not accept a request body.")
        }
        AdminPinStore.resetRateLimitAfterAuthenticatedOwner(applicationContext)
        return ok(
            JSONObject()
                .put("reset", true)
                .put("pinState", AdminPinStore.getState(applicationContext).name)
        )
    }

    private fun handleServerHealth(): HttpResponse {
        return ok(
            serverHealthSupervisor?.snapshotJson()
                ?: JSONObject()
                    .put("healthy", false)
                    .put("state", "starting")
        )
    }

    private fun handleDiagnostics(): HttpResponse =
        ok(DiagnosticEventStore.snapshot(applicationContext).toJson())

    private fun handleDiagnosticsClear(bodyStr: String): HttpResponse {
        if (bodyStr.isNotBlank() && bodyStr.trim() != "{}") {
            return err(400, "BAD_REQUEST", "This action does not accept a request body.")
        }
        val removedEntries = DiagnosticEventStore
            .snapshot(applicationContext)
            .events
            .size
        if (!DiagnosticEventStore.clear(applicationContext)) {
            return err(500, "INTERNAL_ERROR", "The diagnostic event journal could not be cleared.")
        }
        return ok(
            JSONObject()
                .put("cleared", true)
                .put("removedEntries", removedEntries)
                .put("remainingEntries", 0)
        )
    }

    private fun handleRemoteStatus(): HttpResponse =
        ok(RemoteControlManager.statusJson(applicationContext))

    private fun handleRemoteEnabled(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("enabled"))
            val enabledValue = input.get("enabled")
            require(enabledValue is Boolean)
            val enabled = enabledValue
            RemoteControlManager.setEnabled(applicationContext, enabled)
            serverHealthSupervisor?.requestReconciliation("remote_owner_setting_changed")
            ok(
                realAction(
                    if (enabled) {
                        "RoshanRemoteAgent enabled by owner."
                    } else {
                        "RoshanRemoteAgent disabled by owner."
                    }
                ).put("enabled", enabled)
            )
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected exactly {\"enabled\": true/false}.")
        }
    }

    private fun handleRemoteScreenshot(): HttpResponse {
        if (!RemoteControlManager.isEnabled(applicationContext)) {
            return err(409, "CONFLICT", "RoshanRemoteAgent is disabled.")
        }
        val png = RemoteControlManager.captureScreen(applicationContext)
            ?: return err(
                500,
                "INTERNAL_ERROR",
                "Screenshot capture failed or its device-side rate limit was reached."
            )
        return HttpResponse(
            status = 200,
            contentType = "image/png",
            streamBody = ByteArrayInputStream(png)
        )
    }

    private fun handleRemoteTap(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("x", "y"))
            val x = strictInt(input, "x", 0, 9_999)
            val y = strictInt(input, "y", 0, 9_999)
            remoteActionResult(
                RemoteControlManager.tap(applicationContext, x, y),
                "Remote tap accepted."
            )
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected bounded integer coordinates x and y.")
        }
    }

    private fun handleRemoteSwipe(body: String): HttpResponse {
        return try {
            val keys = setOf("startX", "startY", "endX", "endY", "durationMs")
            val input = strictObject(body, keys)
            val startX = strictInt(input, "startX", 0, 9_999)
            val startY = strictInt(input, "startY", 0, 9_999)
            val endX = strictInt(input, "endX", 0, 9_999)
            val endY = strictInt(input, "endY", 0, 9_999)
            val durationMs = strictInt(input, "durationMs", 50, 2_000)
            remoteActionResult(
                RemoteControlManager.swipe(
                    applicationContext,
                    startX,
                    startY,
                    endX,
                    endY,
                    durationMs
                ),
                "Remote swipe accepted."
            )
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Expected bounded integer start/end coordinates and durationMs 50-2000."
            )
        }
    }

    private fun handleRemoteKey(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("key"))
            val key = input.getString("key")
            require(key.length in 1..40)
            require(RemoteControlManager.RemoteKey.entries.any { it.name == key })
            remoteActionResult(
                RemoteControlManager.pressKey(applicationContext, key),
                "Allowlisted remote key accepted."
            )
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "The requested remote key is not allowlisted.")
        }
    }

    private fun handleRemoteText(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("text"))
            val text = input.getString("text")
            require(RemoteControlManager.isValidText(text))
            remoteActionResult(
                RemoteControlManager.inputText(applicationContext, text),
                "Bounded remote text accepted."
            )
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Text must be 1-120 characters from the RoshanRemoteAgent safe allowlist."
            )
        }
    }

    private fun handleRemoteCloseApp(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("packageName"))
            val packageName = input.getString("packageName")
            require(RemoteControlManager.isValidPackageName(packageName))
            if (
                !ApprovedApps.isApproved(applicationContext, packageName) ||
                ApprovedApps.isTechnical(applicationContext, packageName)
            ) {
                return err(
                    403,
                    "FORBIDDEN",
                    "Only an approved non-technical application can be closed."
                )
            }
            remoteActionResult(
                RemoteControlManager.closeApprovedApp(applicationContext, packageName),
                "Approved application closed."
            )
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "A valid approved Android package name is required.")
        }
    }

    private fun handleRemoteAudit(): HttpResponse =
        ok(RemoteControlManager.auditJson())

    private fun remoteActionResult(success: Boolean, message: String): HttpResponse {
        if (!RemoteControlManager.isEnabled(applicationContext)) {
            return err(409, "CONFLICT", "RoshanRemoteAgent is disabled.")
        }
        return if (success) {
            ok(realAction(message))
        } else {
            err(
                500,
                "INTERNAL_ERROR",
                "The typed action was rejected, rate-limited, or could not be executed."
            )
        }
    }

    private fun strictObject(body: String, expectedKeys: Set<String>): JSONObject {
        val input = JSONObject(body)
        val actualKeys = mutableSetOf<String>()
        val iterator = input.keys()
        while (iterator.hasNext()) {
            actualKeys += iterator.next()
        }
        require(actualKeys == expectedKeys)
        return input
    }

    private fun jsonValue(value: Any?): Any = value ?: JSONObject.NULL

    private fun strictInt(
        input: JSONObject,
        key: String,
        minimum: Int,
        maximum: Int
    ): Int {
        val raw = input.get(key)
        require(raw is Number)
        val asDouble = raw.toDouble()
        require(asDouble.isFinite() && asDouble == asDouble.toInt().toDouble())
        val value = asDouble.toInt()
        require(value in minimum..maximum)
        return value
    }

    private fun handleBrightness(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("value"))
            val value = strictInt(input, "value", 0, 255)
            if (RootCommand.setBrightness(value)) ok(realAction("Brightness set to $value"))
            else err(500, "INTERNAL_ERROR", "Root command failed.")
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"value\": 0-255}.")
        }
    }

    private fun handleBrightnessMode(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("mode"))
            val mode = input.get("mode")
            require(mode is String && DeviceControlPolicy.isValidBrightnessMode(mode))
            if (RootCommand.setBrightnessMode(mode)) {
                ok(realAction("Brightness mode set to $mode."))
            } else {
                err(500, "INTERNAL_ERROR", "Brightness mode command failed.")
            }
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"mode\":\"manual\"|\"automatic\"}."
            )
        }
    }

    private fun previousVolume(ctx: Context): Int =
        ctx.getSharedPreferences("companion", Context.MODE_PRIVATE)
            .getInt("previous_volume", 5)

    private fun setPreviousVolume(ctx: Context, value: Int) =
        ctx.getSharedPreferences("companion", Context.MODE_PRIVATE)
            .edit().putInt("previous_volume", value).apply()

    private fun handleVolume(body: String): HttpResponse {
        return try {
            val value = JSONObject(body).getInt("value")
            require(value in 0..15)
            if (TelemetryProvider.setMusicVolume(applicationContext, value, showUi = true)) {
                if (value > 0) setPreviousVolume(applicationContext, value)
                ok(realAction("Volume set to $value"))
            } else err(500, "INTERNAL_ERROR", "Root command failed.")
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"value\": 0-15}.")
        }
    }

    private fun handleMute(body: String): HttpResponse {
        return try {
            val muted = JSONObject(body).getBoolean("muted")
            val target = if (muted) 0 else previousVolume(applicationContext)
            if (TelemetryProvider.setMusicVolume(applicationContext, target, showUi = true)) {
                ok(realAction(if (muted) "Muted." else "Unmuted."))
            }
            else err(500, "INTERNAL_ERROR", "Root command failed.")
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"muted\": true/false}.")
        }
    }

    private fun handleOrientation(body: String): HttpResponse {
        return try {
            val orientation = JSONObject(body).getString("orientation")
            require(
                orientation == "auto" ||
                    orientation == "portrait" ||
                    orientation == "landscape" ||
                    orientation == "reverse-portrait" ||
                    orientation == "reverse-landscape"
            )
            if (RootCommand.setScreenOrientation(orientation)) {
                KioskController.setScreenOrientation(applicationContext, orientation)
                ok(realAction("Screen orientation set to $orientation."))
            } else {
                err(500, "INTERNAL_ERROR", "Screen orientation command failed.")
            }
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Expected a supported automatic or fixed screen orientation."
            )
        }
    }

    private fun handleScreen(body: String): HttpResponse {
        return try {
            val on = JSONObject(body).getBoolean("on")
            val success = if (on) RootCommand.wakeScreen() else RootCommand.sleepScreen()
            if (success) ok(realAction(if (on) "Screen woke." else "Screen slept."))
            else err(500, "INTERNAL_ERROR", "Root command failed.")
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"on\": true/false}.")
        }
    }

    private fun handleScreenTimeout(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("timeoutSeconds"))
            val seconds = strictInt(input, "timeoutSeconds", 15, 1800)
            require(DeviceControlPolicy.isValidScreenTimeoutSeconds(seconds))
            if (RootCommand.setScreenTimeoutSeconds(seconds)) {
                ok(realAction("Screen timeout set to $seconds seconds."))
            } else {
                err(500, "INTERNAL_ERROR", "Screen timeout command failed.")
            }
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Screen timeout must be one of 15, 30, 60, 120, 300, 600, or 1800 seconds."
            )
        }
    }

    private fun handleTouchLock(body: String): HttpResponse {
        return try {
            val input = strictObject(body, setOf("on"))
            val raw = input.get("on")
            require(raw is Boolean)
            val on = raw
            if (!KioskController.setTouchLock(applicationContext, on)) {
                return err(
                    409,
                    "CONFLICT",
                    if (on) {
                        "Access Lock could not attach its protected overlay and policy."
                    } else {
                        "Access Lock release could not be confirmed."
                    }
                )
            }
            ok(realAction(if (on) "Access Lock enabled." else "Access Lock disabled."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"on\": true/false}.")
        }
    }

    private fun handleDeviceLock(body: String): HttpResponse {
        val action = try {
            val input = strictObject(body, setOf("action"))
            input.get("action")
        } catch (_: Exception) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"action\":\"lock\"}."
            )
        }
        if (action !is String || !DeviceControlPolicy.isTypedLock(action)) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"action\":\"lock\"}."
            )
        }
        if (!DevicePolicyController.isDeviceOwner(applicationContext)) {
            return err(
                409,
                "NOT_CONFIGURED",
                "Device Owner is required to lock the managed screen."
            )
        }
        if (!DevicePolicyController.lockDevice(applicationContext)) {
            return err(500, "INTERNAL_ERROR", "Android rejected the managed lock action.")
        }
        DiagnosticEventStore.info(
            applicationContext,
            component = "power",
            event = "device_locked",
            fields = mapOf("source" to "authenticated_owner")
        )
        return ok(realAction("RoshanOS lock screen activated."))
    }

    private fun handleDeviceReboot(): HttpResponse {
        Thread({
            try {
                Thread.sleep(1_200L)
                if (!DevicePolicyController.rebootDevice(applicationContext)) {
                    RootCommand.rebootDevice()
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }, "roshan-owner-reboot").apply {
            isDaemon = true
            start()
        }
        return ok(realAction("RoshanOS reboot scheduled."))
    }

    private fun handleDeviceShutdown(body: String): HttpResponse {
        val confirmed = try {
            val input = strictObject(body, setOf("action", "confirm"))
            val action = input.get("action")
            val confirm = input.get("confirm")
            action is String &&
                confirm is Boolean &&
                DeviceControlPolicy.isConfirmedShutdown(action, confirm)
        } catch (_: Exception) {
            false
        }
        if (!confirmed) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"action\":\"shutdown\",\"confirm\":true}."
            )
        }
        if (!RootCommand.isRootAvailable()) {
            return err(
                409,
                "UNSUPPORTED",
                "This Android build does not expose supported RoshanOS shutdown control."
            )
        }
        if (!shutdownGate.tryAcquire(SystemClock.elapsedRealtime())) {
            return err(
                429,
                "RATE_LIMITED",
                "A shutdown action was accepted recently; wait before trying again."
            )
        }
        DiagnosticEventStore.warn(
            applicationContext,
            component = "power",
            event = "shutdown_scheduled",
            fields = mapOf("source" to "authenticated_owner")
        )
        Thread({
            try {
                Thread.sleep(1_200L)
                if (!RootCommand.shutdownDevice()) {
                    DiagnosticEventStore.error(
                        applicationContext,
                        component = "power",
                        event = "shutdown_failed"
                    )
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }, "roshan-owner-shutdown").apply {
            isDaemon = true
            start()
        }
        return ok(realAction("RoshanOS shutdown scheduled."))
    }

    private fun handleServiceRestart(body: String): HttpResponse {
        val service = try {
            JSONObject(body).getString("service")
        } catch (_: Exception) {
            return err(400, "VALIDATION_ERROR", "A supported service name is required.")
        }

        return when (service) {
            "media" -> {
                CameraService.requestReinitialize(applicationContext)
                ok(realAction("RoshanMedia restart requested."))
            }
            "vpn" -> {
                val reconciled =
                    DevicePolicyController.applyDeviceOwnerPolicies(applicationContext)
                WifiProvisioningManager.requestReconnect(applicationContext)
                if (reconciled) {
                    ok(realAction("Private-network policy and Wi-Fi were reconciled."))
                } else {
                    err(
                        409,
                        "NOT_CONFIGURED",
                        "Device Owner is required to reconcile the private network."
                    )
                }
            }
            "remote" -> {
                val enabled = RemoteControlManager.isEnabled(applicationContext)
                RemoteControlManager.setEnabled(applicationContext, enabled)
                serverHealthSupervisor?.requestReconciliation("owner_restart_remote")
                ok(realAction("RoshanRemoteAgent state was reconciled."))
            }
            "core" -> {
                Thread({
                    try {
                        Thread.sleep(1_200L)
                        synchronized(initializationLock) {
                            httpServer?.stop()
                            httpServer = null
                            ensureControlListener()
                            serverHealthSupervisor?.requestReconciliation(
                                "owner_restart_core"
                            )
                        }
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                    }
                }, "roshan-owner-core-restart").apply {
                    isDaemon = true
                    start()
                }
                ok(realAction("RoshanCore control listener restart scheduled."))
            }
            else -> err(
                400,
                "VALIDATION_ERROR",
                "Supported services are core, media, vpn, and remote."
            )
        }
    }

    private fun handleApproveApp(body: String): HttpResponse {
        return try {
            val json = JSONObject(body)
            val pkg = json.getString("packageName")
            if (!ApprovedApps.isApprovable(applicationContext, pkg) ||
                ApprovedApps.isTechnical(applicationContext, pkg)
            ) {
                return err(
                    400,
                    "VALIDATION_ERROR",
                    "Only a discovered non-technical application can be approved."
                )
            }
            val current = ApprovedApps.approvedPackages(applicationContext).toMutableSet()
            current.add(pkg)
            ApprovedApps.setApprovedPackages(applicationContext, current)
            // Refresh only an already-visible Home; never interrupt another app.
            KioskController.notifyApprovedAppsChanged(applicationContext)
            ok(realAction("$pkg approved."))
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"packageName\": \"...\"}.")
        }
    }

    private fun handleRevokeApp(body: String): HttpResponse {
        return try {
            val json = JSONObject(body)
            val pkg = json.getString("packageName")
            val current = ApprovedApps.approvedPackages(applicationContext).toMutableSet()
            current.remove(pkg)
            ApprovedApps.setApprovedPackages(applicationContext, current)
            KioskController.notifyApprovedAppsChanged(applicationContext)
            ok(realAction("$pkg revoked."))
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"packageName\": \"...\"}.")
        }
    }

    private fun handleAppLaunch(body: String): HttpResponse {
        return try {
            val appId = JSONObject(body).getString("appId")
            val label = ApprovedApps.launch(applicationContext, appId)
                ?: return err(404, "UNSUPPORTED", "The approved app is not installed.")
            ok(realAction("$label opened on the tablet."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected an approved application identifier.")
        }
    }

    private fun handleMedia(body: String): HttpResponse {
        return try {
            val action = JSONObject(body).getString("action")
            val keyCode = when (action) {
                "play-pause" -> 85 // KEYCODE_MEDIA_PLAY_PAUSE
                "next" -> 87 // KEYCODE_MEDIA_NEXT
                "previous" -> 88 // KEYCODE_MEDIA_PREVIOUS
                else -> return err(400, "VALIDATION_ERROR", "Unsupported media action.")
            }
            Thread {
                RootCommand.exec("monkey -p com.spotify.music -c android.intent.category.LAUNCHER 1")
                try { Thread.sleep(200) } catch (_: Exception) {}
                RootCommand.exec("input keyevent $keyCode")
            }.start()
            ok(realAction("Spotify media action $action dispatched."))
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"action\": \"play-pause\"|\"next\"|\"previous\"}.")
        }
    }

    private fun handleAudioStart(): HttpResponse {
        synchronized(audioLock) {
            audioTrack?.stop()
            audioTrack?.release()

            val sampleRate = 16000
            val channelConfig = AudioFormat.CHANNEL_OUT_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val minBufSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            
            audioTrack = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
                AudioFormat.Builder()
                    .setEncoding(audioFormat)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .build(),
                minBufSize,
                AudioTrack.MODE_STREAM,
                0
            )
            
            audioTrack?.play()
        }
        return ok(realAction("AudioTrack started at 16000Hz mono Int16."))
    }

    private fun handleAudioFrame(rawBody: ByteArray): HttpResponse {
        if (rawBody.isEmpty()) return err(400, "VALIDATION_ERROR", "Empty audio frame.")
        synchronized(audioLock) {
            val track = audioTrack ?: return err(400, "VALIDATION_ERROR", "Audio not started.")
            val written = track.write(rawBody, 0, rawBody.size)
            if (written < 0) return err(500, "INTERNAL_ERROR", "AudioTrack.write error: $written")
            return ok(realAction("Frame written: ${rawBody.size} bytes."))
        }
    }

    private fun handleAudioStop(): HttpResponse {
        synchronized(audioLock) {
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
        }
        return ok(realAction("AudioTrack stopped."))
    }

    private fun handleKioskStatus(): HttpResponse {
        val data = JSONObject().apply {
            put("installed", true)
            put("foreground", KioskActivity.isVisible)
            put("dashboardConfigured", KioskController.isDashboardConfigured(applicationContext))
            put("displayMode", KioskController.displayMode(applicationContext))
        }
        return ok(data)
    }

    private fun handleKioskDashboard(body: String): HttpResponse {
        return try {
            val url = JSONObject(body).getString("url")
            KioskController.configureDashboard(applicationContext, url)
            ok(realAction("RoshanOS Home configured and loaded."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected a credential-free HTTP or HTTPS dashboard URL.")
        }
    }

    private fun handleKioskMessage(body: String): HttpResponse {
        return try {
            val input = JSONObject(body)
            val text = input.getString("text").trim()
            val durationSeconds = input.optInt("durationSeconds", 5).let {
                if (it == 0) 5 else it
            }
            require(text.isNotEmpty() && text.length <= 500)
            require(durationSeconds in 1..300)
            KioskController.showMessage(applicationContext, text, durationSeconds)
            ok(realAction("Animated message displayed over the dashboard."))
        } catch (_: Exception) {
            err(
                400,
                "VALIDATION_ERROR",
                "Expected non-empty text up to 500 characters and a bounded duration."
            )
        }
    }

    private fun handleKioskLiveText(body: String): HttpResponse {
        return try {
            val text = JSONObject(body).getString("text").trim()
            require(text.isNotEmpty() && text.length <= 500)
            KioskController.showLiveText(applicationContext, text)
            ok(realAction("Live text updated on the tablet."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected non-empty live text up to 500 characters.")
        }
    }

    private fun handleKioskClearLiveText(): HttpResponse {
        KioskController.clearLiveText(applicationContext)
        return ok(realAction("Live text cleared from the tablet."))
    }

    private fun handleKioskWebpage(body: String): HttpResponse {
        return try {
            val url = JSONObject(body).getString("url")
            KioskController.showWebpage(applicationContext, url)
            ok(realAction("RoshanOS loaded the requested webpage."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected a credential-free HTTP or HTTPS URL.")
        }
    }

    private fun handleKioskBlack(): HttpResponse {
        KioskController.showBlack(applicationContext)
        return ok(realAction("RoshanOS display changed to black."))
    }

    private fun handleKioskClock(): HttpResponse {
        KioskController.showClockOnly(applicationContext)
        return ok(realAction("RoshanOS display changed to clock only."))
    }

    private fun handleKioskClockColor(body: String): HttpResponse {
        return try {
            val color = JSONObject(body).optString("color", "#00A2FF")
            KioskController.setClockColor(applicationContext, color)
            ok(realAction("Clock theme color updated to $color."))
        } catch (_: Exception) {
            err(400, "VALIDATION_ERROR", "Expected a valid hex color string.")
        }
    }

    private fun handleKioskRestore(): HttpResponse {
        if (!KioskController.restoreDashboard(applicationContext)) {
            return err(409, "NOT_CONFIGURED", "RoshanOS Home URL is not configured.")
        }
        return ok(realAction("RoshanOS Home restored."))
    }

    private fun handleCameraStatus(): HttpResponse {
        return proxyCameraGet("/status.json")
    }

    private fun handleCameraVideo(): HttpResponse {
        synchronized(cameraStreamLock) {
            if (cameraVideoClients.get() >= MAX_VIDEO_CLIENTS) {
                return err(429, "TOO_MANY_CLIENTS", "Maximum concurrent video streams: $MAX_VIDEO_CLIENTS")
            }
        }
        val conn = openCameraConnection("/video.mjpg")
        if (conn == null) {
            return err(502, "CAMERA_OFFLINE", "Camera service is not reachable.")
        }
        try {
            val responseCode = conn.responseCode
            if (responseCode != 200) {
                conn.disconnect()
                return err(502, "PROXY_ERROR", "Camera returned HTTP $responseCode")
            }
            val contentType = conn.contentType ?: "multipart/x-mixed-replace; boundary=mjpegboundary"
            if (!contentType.contains("multipart/x-mixed-replace") && !contentType.contains("image/")) {
                conn.disconnect()
                return err(502, "PROXY_ERROR", "Camera returned unexpected content type: $contentType")
            }
            cameraVideoClients.incrementAndGet()
            return HttpResponse(200, "", contentType, conn.inputStream, onClose = {
                cameraVideoClients.decrementAndGet()
                try { conn.disconnect() } catch (_: Exception) {}
            })
        } catch (e: Exception) {
            conn.disconnect()
            return err(502, "PROXY_ERROR", "Failed to connect to camera stream: ${e.message}")
        }
    }

    private fun handleCameraAudio(): HttpResponse {
        synchronized(cameraStreamLock) {
            if (cameraAudioClients.get() >= MAX_AUDIO_CLIENTS) {
                return err(429, "TOO_MANY_CLIENTS", "Maximum concurrent audio streams: $MAX_AUDIO_CLIENTS")
            }
            val current = cameraAudioClients.get()
            if (current > 0) {
                return err(409, "AUDIO_IN_USE", "Audio stream is already active ($current client). Only one audio stream allowed.")
            }
        }
        val conn = openCameraConnection("/audio.wav")
        if (conn == null) {
            return err(502, "CAMERA_OFFLINE", "Camera service is not reachable.")
        }
        try {
            val responseCode = conn.responseCode
            if (responseCode != 200) {
                conn.disconnect()
                return err(502, "PROXY_ERROR", "Camera returned HTTP $responseCode")
            }
            val contentType = conn.contentType ?: "audio/wav"
            if (!contentType.contains("audio/")) {
                conn.disconnect()
                return err(502, "PROXY_ERROR", "Camera returned unexpected content type: $contentType")
            }
            cameraAudioClients.incrementAndGet()
            return HttpResponse(200, "", contentType, conn.inputStream, onClose = {
                cameraAudioClients.decrementAndGet()
                try { conn.disconnect() } catch (_: Exception) {}
            })
        } catch (e: Exception) {
            conn.disconnect()
            return err(502, "PROXY_ERROR", "Failed to connect to audio stream: ${e.message}")
        }
    }

    private fun handleCameraSnapshot(): HttpResponse {
        val data = readCameraBytes("/shot.jpg") ?: return err(502, "CAMERA_OFFLINE", "Camera service is not reachable.")
        if (data.size < 4 ||
            data[0] != 0xff.toByte() ||
            data[1] != 0xd8.toByte() ||
            data[data.lastIndex - 1] != 0xff.toByte() ||
            data[data.lastIndex] != 0xd9.toByte()
        ) {
            return err(502, "MALFORMED_RESPONSE", "RoshanMedia returned an invalid JPEG.")
        }
        return HttpResponse(200, contentType = "image/jpeg", rawBody = data)
    }

    private fun handleCameraSelect(body: String): HttpResponse {
        return try {
            val json = JSONObject(body)
            val camera = json.optString("camera", "rear")
            if (camera != "front" && camera != "rear") {
                return err(400, "VALIDATION_ERROR", "Camera must be 'front' or 'rear'.")
            }
            val result = proxyCameraGet("/select?lens=$camera")
            result
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Expected {\"camera\": \"front\"|\"rear\"}.")
        }
    }

    private fun handleCameraHealth(): HttpResponse {
        val healthManager = cameraHealthManager
        val snapshot = healthManager?.snapshot()
        val data = JSONObject().apply {
            put("serviceRunning", CameraService.isRunning)
            put("state", snapshot?.state?.name ?: "UNKNOWN")
            put("lastError", snapshot?.lastError ?: JSONObject.NULL)
            put("checkedAtMs", snapshot?.checkedAtMs ?: 0L)
            put("lastHealthyAtMs", snapshot?.lastHealthyAtMs ?: 0L)
            put("lastRecoveryAtMs", snapshot?.lastRecoveryAtMs ?: 0L)
            put("consecutiveFailures", snapshot?.consecutiveFailures ?: 0)
            put("retryFailures", snapshot?.retryFailures ?: 0)
            put("circuitOpen", snapshot?.circuitOpen ?: false)
            put("cooldownRemainingMs", snapshot?.cooldownRemainingMs ?: 0L)
            put("generation", CameraService.generation)
            put("lastInitializedAtMs", CameraService.lastInitializedAtMs)
            put("lastInitializationError", CameraService.lastInitializationError ?: JSONObject.NULL)
            put("videoClients", cameraVideoClients.get())
            put("audioClients", cameraAudioClients.get())
        }
        return ok(data)
    }

    private fun openCameraConnection(path: String): HttpURLConnection? {
        return try {
            val secret = CredentialStore.getSecret(applicationContext) ?: ""
            val url = URL("http://127.0.0.1:${CameraService.CAMERA_PORT}$path")
            val conn = url.openConnection() as HttpURLConnection
            conn.setRequestProperty("Authorization", "Bearer $secret")
            conn.setRequestProperty("Accept", "*/*")
            conn.connectTimeout = 5_000
            conn.readTimeout = 0
            conn.doInput = true
            conn
        } catch (e: Exception) {
            Log.w(TAG, "Failed to open camera connection: ${e.message}")
            null
        }
    }

    private fun readCameraBytes(path: String): ByteArray? {
        var conn: HttpURLConnection? = null
        return try {
            conn = openCameraConnection(path)
            if (conn == null) return null
            conn.readTimeout = 10_000
            if (conn.responseCode != 200) return null
            conn.inputStream.use { input ->
                val maximumBytes = 1_048_576
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > maximumBytes) return null
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read camera bytes: ${e.message}")
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    private fun proxyCameraGet(path: String): HttpResponse {
        val data = readCameraBytes(path)
        if (data == null) {
            return err(502, "CAMERA_OFFLINE", "Camera service is not reachable.")
        }
        val contentType = try {
            val secret = CredentialStore.getSecret(applicationContext) ?: ""
            val conn = URL("http://127.0.0.1:${CameraService.CAMERA_PORT}$path").openConnection() as HttpURLConnection
            conn.setRequestProperty("Authorization", "Bearer $secret")
            conn.connectTimeout = 2_000
            conn.readTimeout = 2_000
            val ct = conn.contentType
            conn.disconnect()
            ct ?: "application/json"
        } catch (_: Exception) { "application/json" }
        return HttpResponse(200, String(data, Charsets.UTF_8), contentType)
    }

    private fun handleDpcStatus(): HttpResponse {
        val status = DevicePolicyController.getPolicyStatus(applicationContext)
        return ok(JSONObject(status))
    }

    private fun handleDpcMaintenance(body: String): HttpResponse {
        return try {
            val json = JSONObject(body)
            val action = json.optString("action", "status")
            when (action) {
                "enter" -> {
                    val duration = json.optInt("durationMinutes", 15)
                    DevicePolicyController.enterMaintenanceMode(applicationContext, duration)
                    ok(realAction("Maintenance mode enabled for $duration minutes."))
                }
                "exit" -> {
                    DevicePolicyController.exitMaintenanceMode(applicationContext)
                    ok(realAction("Maintenance mode disabled. Full restrictions restored."))
                }
                "status" -> {
                    ok(JSONObject(DevicePolicyController.getMaintenanceStatus(applicationContext)))
                }
                else -> err(400, "VALIDATION_ERROR", "Unknown maintenance action: $action")
            }
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Invalid maintenance request: ${e.message}")
        }
    }

    private fun handleTailscaleEnrollment(body: String): HttpResponse {
        val request = try {
            val input = strictObject(
                body,
                setOf("authKey", "timeoutSeconds")
            )
            val validation = TailscaleEnrollmentPolicy.validateRequest(
                mapOf(
                    "authKey" to input.get("authKey"),
                    "timeoutSeconds" to input.get("timeoutSeconds")
                )
            )
            validation.request ?: throw IllegalArgumentException(
                validation.errorCode ?: "INVALID_REQUEST"
            )
        } catch (_: Exception) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly a bounded Tailscale authKey and timeoutSeconds (30-300)."
            )
        }

        val result = TailscaleEnrollmentManager.requestEnrollment(
            applicationContext,
            request
        )
        if (!result.accepted) {
            val status = when (result.code) {
                "DEVICE_OWNER_REQUIRED" -> 403
                else -> 409
            }
            return err(
                status,
                result.code,
                "Tailscale enrollment was rejected; inspect the secret-free enrollment status."
            )
        }
        return ok(
            JSONObject()
                .put("accepted", true)
                .put("code", result.code)
                .put(
                    "enrollment",
                    TailscaleEnrollmentManager.statusJson(applicationContext)
                )
        )
    }

    private fun handleUpdateControllerOrigin(body: String): HttpResponse {
        val origin = try {
            val input = strictObject(body, setOf("origin"))
            val raw = input.get("origin")
            require(raw is String && raw.length in 1..RoshanUpdatePolicy.MAX_URL_LENGTH)
            raw
        } catch (_: Exception) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"origin\":\"https://controller.tailnet.ts.net\"}."
            )
        }
        val result = RoshanUpdateManager.configureControllerOrigin(
            applicationContext,
            origin
        )
        return updateActionResponse(result)
    }

    private fun handleUpdateRequest(body: String): HttpResponse {
        val request = try {
            val input = strictObject(body, setOf("url", "sha256"))
            val url = input.get("url")
            val sha256 = input.get("sha256")
            require(url is String && sha256 is String)
            Pair(url, sha256)
        } catch (_: Exception) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"url\":\"https://...\",\"sha256\":\"64 hex characters\"}."
            )
        }
        val result = RoshanUpdateManager.requestUpdate(
            applicationContext,
            request.first,
            request.second
        )
        return updateActionResponse(result)
    }

    private fun handleUpdateRollback(body: String): HttpResponse {
        val confirmed = try {
            val input = strictObject(body, setOf("confirm"))
            input.get("confirm") == true
        } catch (_: Exception) {
            false
        }
        if (!confirmed) {
            return err(
                400,
                "VALIDATION_ERROR",
                "Expected exactly {\"confirm\":true}."
            )
        }
        return updateActionResponse(
            RoshanUpdateManager.requestRollback(applicationContext)
        )
    }

    private fun updateActionResponse(
        result: RoshanUpdateManager.ActionResult
    ): HttpResponse {
        if (!result.accepted) {
            val validationErrors = setOf(
                "INVALID_CONTROLLER_ORIGIN",
                "INVALID_SHA256",
                "UPDATE_URL_REJECTED"
            )
            return err(
                if (result.code in validationErrors) 400 else 409,
                result.code,
                "RoshanCore update action was rejected."
            )
        }
        return ok(
            JSONObject()
                .put("accepted", true)
                .put("code", result.code)
                .put(
                    "update",
                    RoshanUpdateManager.statusJson(applicationContext)
                )
        )
    }

    private fun handleGetLocation(): HttpResponse {
        val locJson = LocationCollector.getLatestLocation(applicationContext)
        return ok(locJson)
    }

    private fun handleSetLocationMode(body: String): HttpResponse {
        return try {
            val mode = JSONObject(body).getString("mode")
            if (mode !in listOf(LocationCollector.MODE_OFF, LocationCollector.MODE_ON_DEMAND, LocationCollector.MODE_PERIODIC, LocationCollector.MODE_LOST_DEVICE)) {
                return err(400, "VALIDATION_ERROR", "Invalid location mode: $mode")
            }
            LocationCollector.setMode(applicationContext, mode)
            ok(realAction("Location tracking mode set to $mode."))
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Invalid request body: ${e.message}")
        }
    }

    private fun handleFindSound(body: String): HttpResponse {
        return try {
            val duration = JSONObject(body).optInt("durationSeconds", 15)
            val played = FindDeviceSound.play(applicationContext, duration)
            if (played) {
                KioskController.showMessage(applicationContext, "Find Device sound playing...", duration)
                ok(realAction("Find Device sound started for $duration seconds."))
            } else {
                err(500, "AUDIO_ERROR", "Failed to start ringtone audio player.")
            }
        } catch (e: Exception) {
            err(400, "VALIDATION_ERROR", "Invalid request: ${e.message}")
        }
    }

    private fun handleFindSoundStop(): HttpResponse {
        FindDeviceSound.stop(applicationContext)
        KioskController.clearLiveText(applicationContext)
        return ok(realAction("Find Device sound stopped."))
    }

    private fun ok(data: Any) = HttpResponse(
        200, JSONObject().put("ok", true).put("data", data).toString()
    )

    private fun realAction(message: String) =
        JSONObject().put("simulated", false).put("message", message)

    private fun err(status: Int, code: String, message: String) = HttpResponse(
        status,
        JSONObject().put("ok", false).put("error",
            JSONObject().put("code", code).put("message", message)
        ).toString()
    )

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification =
        Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .build()
}
