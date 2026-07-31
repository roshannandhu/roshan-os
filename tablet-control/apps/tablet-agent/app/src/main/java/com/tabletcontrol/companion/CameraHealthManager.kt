package com.tabletcontrol.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class CameraHealthManager(context: Context) {

    enum class State {
        HEALTHY,
        IDLE,
        STARTING,
        STALE_FRAMES,
        CAMERA_BUSY,
        PERMISSION_REQUIRED,
        RECOVERING,
        COOLDOWN,
        FAILED_SAFE
    }

    data class Snapshot(
        val state: State,
        val checkedAtMs: Long,
        val lastHealthyAtMs: Long,
        val lastRecoveryAtMs: Long,
        val consecutiveFailures: Int,
        val lastError: String?,
        val retryFailures: Int,
        val circuitOpen: Boolean,
        val cooldownRemainingMs: Long
    )

    private data class ProbeResult(
        val healthy: Boolean,
        val state: State,
        val reason: String?
    )

    companion object {
        private const val TAG = "CameraHealth"
        private const val CHECK_INTERVAL_MS = 30_000L
        private const val RECOVERY_CONFIRM_MS = 5_000L
        private const val MAX_CONSECUTIVE_FAILURES = 3
    }

    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private val probeExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "roshan-camera-health").apply { isDaemon = true }
    }
    private val running = AtomicBoolean(false)
    private val checkInFlight = AtomicBoolean(false)
    private val retryCircuit = RetryCircuit(
        initialDelayMs = 2_000L,
        maximumDelayMs = 60_000L,
        maximumRetryAttempts = 3,
        cooldownMs = 300_000L
    )

    @Volatile
    private var state = State.STARTING

    @Volatile
    private var consecutiveFailures = 0

    @Volatile
    private var lastCheckedAtMs = 0L

    @Volatile
    private var lastHealthyAtMs = 0L

    @Volatile
    private var lastRecoveryAtMs = 0L

    @Volatile
    private var lastReportedError: String? = null

    @Volatile
    private var pendingRecovery = false

    private val checkRunnable = Runnable {
        if (!running.get() || !checkInFlight.compareAndSet(false, true)) return@Runnable
        probeExecutor.execute {
            val result = probe()
            handler.post {
                checkInFlight.set(false)
                if (!running.get()) return@post
                applyProbe(result)
                scheduleCheck(CHECK_INTERVAL_MS)
            }
        }
    }

    private val recoveryRunnable = Runnable {
        pendingRecovery = false
        if (!running.get()) return@Runnable
        state = State.RECOVERING
        lastRecoveryAtMs = System.currentTimeMillis()
        try {
            CameraService.requestReinitialize(appContext)
            Log.i(TAG, "Camera reinitialization action dispatched")
        } catch (error: Exception) {
            lastReportedError = "camera reinitialization dispatch failed: ${error.message}"
            Log.e(TAG, "Could not dispatch camera reinitialization", error)
        }
        scheduleCheck(RECOVERY_CONFIRM_MS)
    }

    fun start() {
        if (!running.compareAndSet(false, true)) return
        state = State.STARTING
        Log.i(TAG, "Camera health supervision started")
        scheduleCheck(0L)
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        handler.removeCallbacks(checkRunnable)
        handler.removeCallbacks(recoveryRunnable)
        pendingRecovery = false
        probeExecutor.shutdownNow()
        Log.i(TAG, "Camera health supervision stopped")
    }

    fun requestImmediateCheck() {
        if (running.get()) scheduleCheck(0L)
    }

    fun getState(): State = state

    fun getLastError(): String? = lastReportedError

    fun snapshot(nowMs: Long = System.currentTimeMillis()): Snapshot {
        val retry = retryCircuit.snapshot(SystemClock.elapsedRealtime())
        return Snapshot(
            state = state,
            checkedAtMs = lastCheckedAtMs,
            lastHealthyAtMs = lastHealthyAtMs,
            lastRecoveryAtMs = lastRecoveryAtMs,
            consecutiveFailures = consecutiveFailures,
            lastError = lastReportedError,
            retryFailures = retry.failures,
            circuitOpen = retry.circuitOpen,
            cooldownRemainingMs = retry.cooldownRemainingMs
        )
    }

    private fun scheduleCheck(delayMs: Long) {
        handler.removeCallbacks(checkRunnable)
        if (running.get()) handler.postDelayed(checkRunnable, delayMs)
    }

    private fun probe(): ProbeResult {
        var connection: HttpURLConnection? = null
        return try {
            val secret = CredentialStore.getSecret(appContext)
            if (secret.isNullOrBlank()) {
                return ProbeResult(
                    false,
                    State.PERMISSION_REQUIRED,
                    "awaiting device enrollment credential"
                )
            }
            val cameraGranted = ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
            val microphoneGranted = ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
            if (!cameraGranted || !microphoneGranted) {
                return ProbeResult(
                    false,
                    State.PERMISSION_REQUIRED,
                    "camera or microphone runtime permission is required"
                )
            }
            connection = URL(
                "http://127.0.0.1:${CameraService.CAMERA_PORT}/status.json"
            ).openConnection() as HttpURLConnection
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.setRequestProperty(
                "Authorization",
                "Bearer $secret"
            )
            connection.setRequestProperty("Accept", "application/json")

            when (val responseCode = connection.responseCode) {
                401 -> ProbeResult(
                    false,
                    State.RECOVERING,
                    "camera credential changed; reinitialization required"
                )
                200 -> classifyStatus(connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
                else -> ProbeResult(false, State.RECOVERING, "camera HTTP $responseCode")
            }
        } catch (error: Exception) {
            ProbeResult(
                false,
                State.RECOVERING,
                "camera unreachable: ${error.message ?: error.javaClass.simpleName}"
            )
        } finally {
            try {
                connection?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun classifyStatus(body: String): ProbeResult {
        return try {
            val json = JSONObject(body)
            val serverState = json.optString("state", "stopped")
            val cameraRunning = json.optBoolean("running", false)
            val frameAgeMs = json.optLong("frameAgeMs", -1L)
            val rawError = json.opt("lastError")
            val lastError = if (rawError == null || rawError == JSONObject.NULL) {
                null
            } else {
                rawError.toString()
            }
            val normalizedError = lastError?.lowercase()

            when {
                normalizedError?.contains("permission") == true ||
                    normalizedError?.contains("denied") == true ->
                    ProbeResult(false, State.PERMISSION_REQUIRED, lastError)

                normalizedError?.contains("busy") == true ||
                    normalizedError?.contains("in use") == true ->
                    ProbeResult(false, State.CAMERA_BUSY, lastError)

                cameraRunning && serverState == "healthy" &&
                    frameAgeMs in 0 until 10_000L && lastError == null ->
                    ProbeResult(true, State.HEALTHY, null)

                serverState == "idle" && !cameraRunning && lastError == null ->
                    ProbeResult(true, State.IDLE, null)

                !cameraRunning || serverState == "stopped" ->
                    ProbeResult(false, State.STARTING, lastError ?: "camera has not started")

                else ->
                    ProbeResult(false, State.STALE_FRAMES, lastError ?: "camera frames are stale")
            }
        } catch (error: Exception) {
            ProbeResult(
                false,
                State.RECOVERING,
                "invalid camera health response: ${error.message ?: error.javaClass.simpleName}"
            )
        }
    }

    private fun applyProbe(result: ProbeResult) {
        val now = System.currentTimeMillis()
        lastCheckedAtMs = now

        if (result.healthy) {
            if (state != result.state) {
                Log.i(TAG, "Camera health restored after $consecutiveFailures failed probes")
            }
            state = result.state
            consecutiveFailures = 0
            lastHealthyAtMs = now
            lastReportedError = null
            pendingRecovery = false
            handler.removeCallbacks(recoveryRunnable)
            retryCircuit.onSuccess()
            return
        }

        state = result.state
        lastReportedError = result.reason
        consecutiveFailures += 1

        if (result.state == State.PERMISSION_REQUIRED) {
            // Recovery must not loop against an Android privacy decision.
            Log.w(TAG, "Camera recovery held in ${result.state}: ${result.reason}")
            return
        }
        if (result.state == State.CAMERA_BUSY) {
            // Rebinding can recover once the competing camera owner releases it,
            // but the shared RetryCircuit strictly bounds attempts and cooldown.
            Log.w(TAG, "Camera is in use; bounded recovery remains eligible")
        }
        if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES || pendingRecovery) return

        val plan = retryCircuit.onFailure(SystemClock.elapsedRealtime())
        if (plan.disposition == RetryCircuit.Disposition.CIRCUIT_OPEN) {
            state = State.COOLDOWN
            Log.w(TAG, "Camera recovery circuit open for ${plan.delayMs}ms")
            return
        }

        state = State.RECOVERING
        pendingRecovery = true
        handler.removeCallbacks(recoveryRunnable)
        handler.postDelayed(recoveryRunnable, plan.delayMs)
        Log.w(
            TAG,
            "Camera recovery ${plan.retryAttempt} scheduled in ${plan.delayMs}ms: ${result.reason}"
        )
    }
}
