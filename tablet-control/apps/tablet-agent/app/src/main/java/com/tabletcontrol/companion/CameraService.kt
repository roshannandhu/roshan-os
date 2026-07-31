package com.tabletcontrol.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService

class CameraService : LifecycleService() {

    companion object {
        private const val TAG = "CameraService"
        private const val CHANNEL_ID = "camera_channel"
        private const val NOTIF_ID = 4040
        private const val MIN_REINITIALIZE_INTERVAL_MS = 2_000L
        private const val CAMERA_IDLE_RELEASE_MS = 5_000L

        const val CAMERA_PORT = 8081
        const val ACTION_REINITIALIZE =
            "com.tabletcontrol.companion.action.REINITIALIZE_CAMERA"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var streamClientCount: Int = 0
            private set

        @Volatile
        var audioClientCount: Int = 0
            private set

        @Volatile
        var generation: Long = 0
            private set

        @Volatile
        var lastInitializedAtMs: Long = 0
            private set

        @Volatile
        var lastInitializationError: String? = null
            private set

        fun ensureStarted(context: Context) {
            val appContext = context.applicationContext
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, CameraService::class.java)
            )
        }

        fun requestReinitialize(context: Context) {
            val appContext = context.applicationContext
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, CameraService::class.java).setAction(ACTION_REINITIALIZE)
            )
        }
    }

    private val lifecycleLock = Any()
    private var cameraManager: CameraManager? = null
    private var signalingServer: HttpSignalingServer? = null
    private var initialized = false
    private var lastReinitializeElapsedMs = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val idleReleaseRunnable = Runnable {
        synchronized(lifecycleLock) {
            if (streamClientCount == 0) {
                cameraManager?.releaseCameraForIdle()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "CameraService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        // Every foreground-service start is acknowledged immediately, including
        // explicit recovery actions. Android's camera/microphone disclosure stays.
        startForegroundWithNotification()

        synchronized(lifecycleLock) {
            when {
                intent?.action == ACTION_REINITIALIZE -> {
                    val now = SystemClock.elapsedRealtime()
                    if (lastReinitializeElapsedMs == 0L ||
                        now - lastReinitializeElapsedMs >= MIN_REINITIALIZE_INTERVAL_MS
                    ) {
                        lastReinitializeElapsedMs = now
                        Log.i(TAG, "Executing bounded camera reinitialization request")
                        tearDownComponents()
                        initializeComponents()
                    } else {
                        Log.w(TAG, "Ignoring duplicate camera reinitialization request")
                    }
                }

                !initialized -> initializeComponents()
                else -> Log.d(TAG, "Duplicate start reconciled with active generation $generation")
            }
        }
        return START_STICKY
    }

    private fun initializeComponents() {
        val manager = CameraManager(applicationContext)
        try {
            val server = HttpSignalingServer(
                applicationContext,
                CAMERA_PORT,
                manager,
                { CredentialStore.getSecret(applicationContext) },
                { targetLens ->
                    val lensFacing = if (targetLens == "front") {
                        CameraSelector.LENS_FACING_FRONT
                    } else {
                        CameraSelector.LENS_FACING_BACK
                    }
                    mainHandler.post {
                        cameraManager?.selectLens(this@CameraService, lensFacing)
                    }
                },
                { counts ->
                    streamClientCount = counts.video
                    audioClientCount = counts.audio
                    if (counts.video > 0) {
                        ensureCameraActive()
                    } else {
                        scheduleCameraIdleRelease()
                    }
                },
                onCameraDemand = { ensureCameraActive() },
                onCameraIdle = { scheduleCameraIdleRelease() }
            )
            server.start()

            cameraManager = manager
            signalingServer = server
            initialized = true
            isRunning = true
            generation += 1
            lastInitializedAtMs = System.currentTimeMillis()
            lastInitializationError = null
            Log.i(
                TAG,
                "Internal media server initialized on 127.0.0.1:$CAMERA_PORT; camera idle"
            )
        } catch (error: Exception) {
            try {
                manager.stop()
            } catch (_: Exception) {
            }
            initialized = false
            isRunning = false
            lastInitializationError = error.message ?: error.javaClass.simpleName
            Log.e(TAG, "Internal media initialization failed", error)
        }
    }

    private fun tearDownComponents() {
        mainHandler.removeCallbacks(idleReleaseRunnable)
        initialized = false
        isRunning = false
        try {
            signalingServer?.shutdown()
        } catch (_: Exception) {
        }
        signalingServer = null
        try {
            cameraManager?.stop()
        } catch (_: Exception) {
        }
        cameraManager = null
        streamClientCount = 0
        audioClientCount = 0
    }

    private fun ensureCameraActive() {
        mainHandler.removeCallbacks(idleReleaseRunnable)
        mainHandler.post {
            synchronized(lifecycleLock) {
                cameraManager?.startCamera(
                    this@CameraService,
                    cameraManager?.preferredLensFacing()
                        ?: CameraSelector.LENS_FACING_BACK
                )
            }
        }
    }

    private fun scheduleCameraIdleRelease() {
        mainHandler.removeCallbacks(idleReleaseRunnable)
        mainHandler.postDelayed(idleReleaseRunnable, CAMERA_IDLE_RELEASE_MS)
    }

    private fun startForegroundWithNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Camera and microphone service",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("RoshanOS media service")
            .setContentText("Camera and microphone start only for an authenticated viewer")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()

        startForeground(NOTIF_ID, notification)
    }

    override fun onDestroy() {
        synchronized(lifecycleLock) {
            tearDownComponents()
        }
        Log.i(TAG, "CameraService destroyed")
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }
}
