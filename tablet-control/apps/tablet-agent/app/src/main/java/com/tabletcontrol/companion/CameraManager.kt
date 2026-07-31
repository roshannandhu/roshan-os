package com.tabletcontrol.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager as SystemCameraManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Size
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class CameraManager(private val context: Context) {
    companion object {
        private const val TAG = "CameraManager"
        private const val STALE_FRAME_MS = 10_000L
        private const val SNAPSHOT_MAX_AGE_MS = 5_000L
    }

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "roshan-camera-analysis").apply { isDaemon = true }
    }
    private val closed = AtomicBoolean(false)
    private val frameGate =
        MonotonicFrameGate(MediaResourcePolicy.ANALYSIS_INTERVAL_NS)

    @Volatile
    private var cameraProvider: ProcessCameraProvider? = null

    @Volatile
    private var camera: Camera? = null

    @Volatile
    private var imageCapture: ImageCapture? = null

    @Volatile
    private var imageAnalysis: ImageAnalysis? = null

    @Volatile
    private var currentLensFacing = CameraSelector.LENS_FACING_BACK

    @Volatile
    private var latestJpegFrame: ByteArray? = null

    @Volatile
    private var lastFrameTimeMs = 0L

    @Volatile
    private var lastFrameElapsedMs = 0L

    @Volatile
    private var frameCount = 0L

    @Volatile
    private var lastError: String? = null

    @Volatile
    private var restartCount = 0

    @Volatile
    private var lastDownscaledSize: String? = null

    @Volatile
    private var isCameraBound = false

    @Volatile
    private var pendingLifecycleOwner: LifecycleOwner? = null

    init {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (closed.get()) return@addListener
            try {
                cameraProvider = future.get()
                Log.i(TAG, "ProcessCameraProvider initialized")
                pendingLifecycleOwner?.let { owner ->
                    startCamera(owner, currentLensFacing)
                }
            } catch (error: Exception) {
                recordError("provider initialization failed", error)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    fun startCamera(
        lifecycleOwner: LifecycleOwner,
        lensFacing: Int = CameraSelector.LENS_FACING_BACK
    ) {
        if (closed.get()) return
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post {
                startCamera(lifecycleOwner, lensFacing)
            }
            return
        }

        if (isCameraBound && currentLensFacing == lensFacing) return
        currentLensFacing = lensFacing
        pendingLifecycleOwner = lifecycleOwner
        val provider = cameraProvider
        if (provider == null) {
            Log.i(TAG, "ProcessCameraProvider is not ready; start remains pending")
            return
        }

        try {
            imageAnalysis?.clearAnalyzer()
            provider.unbindAll()
            isCameraBound = false
            latestJpegFrame = null
            lastFrameTimeMs = 0L
            lastFrameElapsedMs = 0L

            val selector = CameraSelector.Builder()
                .requireLensFacing(currentLensFacing)
                .build()
            val targetSize = Size(
                MediaResourcePolicy.TARGET_WIDTH,
                MediaResourcePolicy.TARGET_HEIGHT
            )

            val capture = ImageCapture.Builder()
                .setTargetResolution(targetSize)
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setJpegQuality(MediaResourcePolicy.JPEG_QUALITY)
                .build()
            val analysis = ImageAnalysis.Builder()
                .setTargetResolution(targetSize)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setImageQueueDepth(2)
                .build()
                .also { useCase ->
                    useCase.setAnalyzer(executor) { image ->
                        val nowNs = SystemClock.elapsedRealtimeNanos()
                        if (!frameGate.tryAcquire(nowNs) || closed.get()) {
                            image.close()
                        } else {
                            processImageProxy(image)
                        }
                    }
                }

            camera = provider.bindToLifecycle(
                lifecycleOwner,
                selector,
                capture,
                analysis
            )
            imageCapture = capture
            imageAnalysis = analysis
            isCameraBound = true
            lastError = null
            Log.i(
                TAG,
                "Camera bound at ${MediaResourcePolicy.TARGET_WIDTH}x" +
                    "${MediaResourcePolicy.TARGET_HEIGHT}, <=10 fps; lens=$currentLensFacing"
            )
        } catch (error: Exception) {
            isCameraBound = false
            imageCapture = null
            imageAnalysis = null
            recordError(classifyBindFailure(error), error)
        }
    }

    fun selectLens(lifecycleOwner: LifecycleOwner, lensFacing: Int) {
        require(
            lensFacing == CameraSelector.LENS_FACING_FRONT ||
                lensFacing == CameraSelector.LENS_FACING_BACK
        )
        if (isCameraBound) {
            startCamera(lifecycleOwner, lensFacing)
        } else {
            currentLensFacing = lensFacing
            pendingLifecycleOwner = null
            lastError = null
        }
    }

    fun preferredLensFacing(): Int = currentLensFacing

    /**
     * Releases the CameraX use cases while keeping the local media server and
     * provider ready for the next authenticated demand.
     */
    fun releaseCameraForIdle() {
        if (closed.get()) return
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { releaseCameraForIdle() }
            return
        }
        pendingLifecycleOwner = null
        imageAnalysis?.clearAnalyzer()
        try {
            cameraProvider?.unbindAll()
        } catch (_: Exception) {
        }
        isCameraBound = false
        camera = null
        imageCapture = null
        imageAnalysis = null
        latestJpegFrame = null
        lastFrameTimeMs = 0L
        lastFrameElapsedMs = 0L
        lastError = null
        Log.i(TAG, "Camera released while RoshanMedia remains ready")
    }

    private fun processImageProxy(image: ImageProxy) {
        try {
            val width = image.width
            val height = image.height
            val bounded = MediaResourcePolicy.dimensionsAreBounded(width, height)
            if (!bounded) logDownscaledDelivery(width, height)

            val nv21 = yuv420888ToNv21(image)
            val output = ByteArrayOutputStream(width * height / 2)
            val compressed = YuvImage(
                nv21,
                ImageFormat.NV21,
                width,
                height,
                null
            ).compressToJpeg(
                Rect(0, 0, width, height),
                MediaResourcePolicy.JPEG_QUALITY,
                output
            )
            if (!compressed) {
                lastError = "JPEG compression failed"
                return
            }

            var jpegBytes = output.toByteArray()
            val rotationDegrees = image.imageInfo.rotationDegrees
            jpegBytes = if (bounded) {
                if (rotationDegrees != 0) {
                    rotateJpeg(jpegBytes, rotationDegrees) ?: return
                } else {
                    jpegBytes
                }
            } else {
                resizeJpegToBudget(jpegBytes, rotationDegrees) ?: return
            }

            storeValidFrame(jpegBytes)
        } catch (error: Exception) {
            recordError("frame processing failed", error)
        } finally {
            image.close()
        }
    }

    private fun logDownscaledDelivery(width: Int, height: Int) {
        val size = "${width}x$height"
        if (lastDownscaledSize != size) {
            lastDownscaledSize = size
            Log.w(
                TAG,
                "Camera delivered $size frames; downscaling to fit the media budget"
            )
        }
    }

    /**
     * Decodes a JPEG, applies rotation, and downscales it to fit the media
     * budget. Returns null when the frame cannot be decoded or re-encoded.
     * The source frame is not mutated.
     */
    private fun resizeJpegToBudget(jpeg: ByteArray, rotationDegrees: Int): ByteArray? {
        val source = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
        var bitmap: Bitmap = source
        return try {
            if (rotationDegrees != 0) {
                val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
                val rotated = Bitmap.createBitmap(
                    source,
                    0,
                    0,
                    source.width,
                    source.height,
                    matrix,
                    true
                )
                if (rotated !== source) source.recycle()
                bitmap = rotated
            }

            val width = bitmap.width
            val height = bitmap.height
            val scale = Math.min(
                MediaResourcePolicy.TARGET_WIDTH.toFloat() / width,
                MediaResourcePolicy.TARGET_HEIGHT.toFloat() / height
            ).coerceAtMost(1f)
            val resized: Bitmap
            if (scale < 1f) {
                resized = Bitmap.createScaledBitmap(
                    bitmap,
                    Math.max(1, (width * scale).toInt()),
                    Math.max(1, (height * scale).toInt()),
                    true
                )
                if (resized !== bitmap) bitmap.recycle()
            } else {
                resized = bitmap
            }

            val output = ByteArrayOutputStream(
                (resized.width * resized.height * 3 / 2)
                    .coerceAtMost(MediaResourcePolicy.MAX_JPEG_BYTES)
            )
            if (resized.compress(
                    Bitmap.CompressFormat.JPEG,
                    MediaResourcePolicy.JPEG_QUALITY,
                    output
                )
            ) {
                val bytes = output.toByteArray()
                if (MediaResourcePolicy.hasValidJpegEnvelope(bytes)) bytes else null
            } else {
                null
            }
        } catch (error: Exception) {
            recordError("frame downscale failed", error)
            null
        } finally {
            if (bitmap !== source && !bitmap.isRecycled) bitmap.recycle()
            if (source !== bitmap && !source.isRecycled) source.recycle()
        }
    }

    private fun rotateJpeg(jpeg: ByteArray, rotationDegrees: Int): ByteArray? {
        val source = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        if (source == null) {
            lastError = "frame decode failed before rotation"
            return null
        }

        var rotated: Bitmap? = null
        return try {
            val matrix = Matrix().apply {
                postRotate(rotationDegrees.toFloat())
            }
            rotated = Bitmap.createBitmap(
                source,
                0,
                0,
                source.width,
                source.height,
                matrix,
                true
            )
            val output = ByteArrayOutputStream(jpeg.size.coerceAtMost(
                MediaResourcePolicy.MAX_JPEG_BYTES
            ))
            if (rotated?.compress(
                    Bitmap.CompressFormat.JPEG,
                    MediaResourcePolicy.JPEG_QUALITY,
                    output
                ) != true
            ) {
                lastError = "rotated JPEG compression failed"
                null
            } else {
                output.toByteArray()
            }
        } finally {
            if (rotated !== source) rotated?.recycle()
            source.recycle()
        }
    }

    private fun yuv420888ToNv21(image: ImageProxy): ByteArray {
        val width = image.width
        val height = image.height
        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val yBuffer = yPlane.buffer.duplicate()
        val uBuffer = uPlane.buffer.duplicate()
        val vBuffer = vPlane.buffer.duplicate()
        val nv21 = ByteArray(width * height * 3 / 2)
        var outputOffset = 0

        for (row in 0 until height) {
            val rowStart = yBuffer.position() + row * yPlane.rowStride
            for (column in 0 until width) {
                nv21[outputOffset++] = yBuffer.get(rowStart + column * yPlane.pixelStride)
            }
        }

        val chromaHeight = height / 2
        val chromaWidth = width / 2
        val uStart = uBuffer.position()
        val vStart = vBuffer.position()
        for (row in 0 until chromaHeight) {
            for (column in 0 until chromaWidth) {
                val vIndex = vStart + row * vPlane.rowStride + column * vPlane.pixelStride
                val uIndex = uStart + row * uPlane.rowStride + column * uPlane.pixelStride
                nv21[outputOffset++] = vBuffer.get(vIndex)
                nv21[outputOffset++] = uBuffer.get(uIndex)
            }
        }
        return nv21
    }

    fun switchCamera(lifecycleOwner: LifecycleOwner): Boolean {
        if (closed.get()) return false
        val newLens = if (currentLensFacing == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        restartCount += 1
        startCamera(lifecycleOwner, newLens)
        return true
    }

    fun takeSnapshot(callback: (ByteArray?) -> Unit) {
        val capture = imageCapture
        if (capture == null || closed.get()) {
            callback(getLatestJpegAndVerify(SNAPSHOT_MAX_AGE_MS))
            return
        }

        capture.takePicture(
            executor,
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        val buffer = image.planes.firstOrNull()?.buffer?.duplicate()
                        if (buffer == null) {
                            callback(getLatestJpegAndVerify(SNAPSHOT_MAX_AGE_MS))
                            return
                        }
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)
                        if (isValidJpeg(bytes)) {
                            storeValidFrame(bytes)
                            callback(bytes)
                        } else {
                            val resized = resizeJpegToBudget(bytes, 0)
                            if (resized != null && isValidJpeg(resized)) {
                                storeValidFrame(resized)
                                callback(resized)
                            } else {
                                lastError = "snapshot was not a valid bounded JPEG"
                                callback(getLatestJpegAndVerify(SNAPSHOT_MAX_AGE_MS))
                            }
                        }
                    } catch (error: Exception) {
                        recordError("snapshot processing failed", error)
                        callback(getLatestJpegAndVerify(SNAPSHOT_MAX_AGE_MS))
                    } finally {
                        image.close()
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    recordError("snapshot capture failed", exception)
                    callback(getLatestJpegAndVerify(SNAPSHOT_MAX_AGE_MS))
                }
            }
        )
    }

    fun getLatestJpeg(): ByteArray? {
        val frame = latestJpegFrame ?: return null
        val ageMs = SystemClock.elapsedRealtime() - lastFrameElapsedMs
        return if (ageMs in 0 until STALE_FRAME_MS) frame else null
    }

    fun getLatestJpegAndVerify(maxAgeMs: Long = SNAPSHOT_MAX_AGE_MS): ByteArray? {
        val frame = latestJpegFrame ?: return null
        val ageMs = SystemClock.elapsedRealtime() - lastFrameElapsedMs
        if (ageMs !in 0..maxAgeMs || !isValidJpeg(frame)) {
            if (!isValidJpeg(frame)) lastError = "stored JPEG validation failed"
            return null
        }
        return frame
    }

    private fun storeValidFrame(bytes: ByteArray): Boolean {
        if (!isValidJpeg(bytes)) {
            lastError = "frame was not a valid bounded JPEG"
            return false
        }
        latestJpegFrame = bytes
        lastFrameTimeMs = System.currentTimeMillis()
        lastFrameElapsedMs = SystemClock.elapsedRealtime()
        frameCount += 1L
        lastError = null
        return true
    }

    private fun isValidJpeg(bytes: ByteArray?): Boolean {
        if (!MediaResourcePolicy.hasValidJpegEnvelope(bytes)) return false
        val nonNullBytes = bytes ?: return false
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        BitmapFactory.decodeByteArray(nonNullBytes, 0, nonNullBytes.size, options)
        return options.outMimeType == "image/jpeg" &&
            MediaResourcePolicy.dimensionsAreBounded(options.outWidth, options.outHeight)
    }

    fun getCameraIdOwned(): String? {
        if (!isCameraBound || camera == null) return null
        return try {
            val systemManager =
                context.getSystemService(Context.CAMERA_SERVICE) as SystemCameraManager
            systemManager.cameraIdList.firstOrNull { id ->
                val facing = systemManager.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.LENS_FACING)
                (facing == CameraCharacteristics.LENS_FACING_BACK &&
                    currentLensFacing == CameraSelector.LENS_FACING_BACK) ||
                    (facing == CameraCharacteristics.LENS_FACING_FRONT &&
                        currentLensFacing == CameraSelector.LENS_FACING_FRONT)
            }
        } catch (_: CameraAccessException) {
            null
        }
    }

    fun isCameraAvailable(): Boolean {
        return try {
            val systemManager =
                context.getSystemService(Context.CAMERA_SERVICE) as SystemCameraManager
            systemManager.cameraIdList.any { id ->
                val facing = systemManager.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.LENS_FACING)
                (facing == CameraCharacteristics.LENS_FACING_BACK &&
                    currentLensFacing == CameraSelector.LENS_FACING_BACK) ||
                    (facing == CameraCharacteristics.LENS_FACING_FRONT &&
                        currentLensFacing == CameraSelector.LENS_FACING_FRONT)
            }
        } catch (_: CameraAccessException) {
            false
        }
    }

    fun getStatusJson(videoClients: Int = 0, audioClients: Int = 0): JSONObject {
        val frameAgeMs = if (lastFrameElapsedMs > 0L) {
            (SystemClock.elapsedRealtime() - lastFrameElapsedMs).coerceAtLeast(0L)
        } else {
            -1L
        }
        val healthy = isCameraBound &&
            frameAgeMs in 0 until STALE_FRAME_MS &&
            lastError == null

        return JSONObject().apply {
            put(
                "state",
                when {
                    healthy -> "healthy"
                    isCameraBound -> "stale"
                    lastError != null -> "degraded"
                    else -> "idle"
                }
            )
            put("running", isCameraBound)
            put("cameraBound", isCameraBound)
            put("serviceReady", !closed.get())
            put("frameCount", frameCount)
            put("lastFrameTime", lastFrameTimeMs)
            put("frameAgeMs", frameAgeMs)
            put(
                "activeCamera",
                if (currentLensFacing == CameraSelector.LENS_FACING_BACK) "rear" else "front"
            )
            put("streamClients", videoClients)
            put("audioClients", audioClients)
            put("maxStreamClients", MediaResourcePolicy.MAX_VIDEO_CLIENTS)
            put("maxAudioClients", MediaResourcePolicy.MAX_AUDIO_CLIENTS)
            put("targetWidth", MediaResourcePolicy.TARGET_WIDTH)
            put("targetHeight", MediaResourcePolicy.TARGET_HEIGHT)
            put("maxFps", 10)
            put("lastError", lastError ?: JSONObject.NULL)
            put("restartCount", restartCount)
        }
    }

    fun stop() {
        if (!closed.compareAndSet(false, true)) return
        pendingLifecycleOwner = null
        imageAnalysis?.clearAnalyzer()
        val provider = cameraProvider
        if (provider != null) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                try {
                    provider.unbindAll()
                } catch (_: Exception) {
                }
            } else {
                Handler(Looper.getMainLooper()).post {
                    try {
                        provider.unbindAll()
                    } catch (_: Exception) {
                    }
                }
            }
        }
        isCameraBound = false
        cameraProvider = null
        camera = null
        imageCapture = null
        imageAnalysis = null
        latestJpegFrame = null
        lastFrameTimeMs = 0L
        lastFrameElapsedMs = 0L
        frameCount = 0L
        lastError = null
        executor.shutdownNow()
    }

    private fun classifyBindFailure(error: Exception): String {
        val normalized = error.message.orEmpty().lowercase()
        return if (
            "in use" in normalized ||
            "busy" in normalized ||
            "max cameras" in normalized ||
            "camera unavailable" in normalized
        ) {
            "camera busy"
        } else {
            "camera bind failed"
        }
    }

    private fun recordError(prefix: String, error: Throwable) {
        val detail = (error.message ?: error.javaClass.simpleName)
            .replace('\n', ' ')
            .take(180)
        lastError = "$prefix: $detail"
        Log.e(TAG, lastError, error)
    }
}
