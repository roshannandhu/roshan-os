package com.tabletcontrol.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

internal class HttpSignalingServer(
    private val context: Context,
    port: Int,
    private val cameraManager: CameraManager,
    private val secretProvider: () -> String?,
    private val onSwitchCamera: (String) -> Unit,
    onClientCountsChanged: (MediaClientRegistry.Counts) -> Unit,
    private val onCameraDemand: () -> Unit,
    private val onCameraIdle: () -> Unit
) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        private const val TAG = "HttpSignaling"
        private const val AUDIO_SAMPLE_RATE = 16_000
        private const val AUTH_HEADER_MAX_LENGTH = 1_024
        private const val CREDENTIAL_RECHECK_MS = 2_000L
        private const val SNAPSHOT_STARTUP_TIMEOUT_MS = 5_000L
        private const val SNAPSHOT_POLL_MS = 50L
    }

    private data class AuthorizationGrant(val credentialDigest: ByteArray)

    private val stopping = AtomicBoolean(false)
    private val registry = MediaClientRegistry(
        maxVideoClients = MediaResourcePolicy.MAX_VIDEO_CLIENTS,
        maxAudioClients = MediaResourcePolicy.MAX_AUDIO_CLIENTS,
        onCountsChanged = onClientCountsChanged
    )
    private val activeStreams =
        Collections.synchronizedSet(mutableSetOf<ActiveStream>())

    override fun serve(session: IHTTPSession): Response {
        val path = session.uri.substringBefore('?')
        val authorization = authorize(session)
        if (authorization == null) {
            return jsonResponse(
                Response.Status.UNAUTHORIZED,
                JSONObject().put("ok", false).put("error", "unauthorized")
            )
        }
        if (stopping.get()) {
            return unavailable("media server is stopping")
        }

        Log.i(TAG, "${session.method.name} $path")
        return try {
            when (path) {
                "/status.json" -> statusResponse()
                "/shot.jpg" -> snapshotResponse()
                "/video", "/video.mjpg" -> videoResponse(authorization)
                "/audio", "/audio.wav" -> audioResponse(authorization)
                "/select" -> selectCameraResponse(session)
                else -> newFixedLengthResponse(
                    Response.Status.NOT_FOUND,
                    "text/plain",
                    "Not Found"
                )
            }
        } catch (error: Exception) {
            Log.e(TAG, "Request failed for $path", error)
            jsonResponse(
                Response.Status.INTERNAL_ERROR,
                JSONObject().put("ok", false).put("error", "media request failed")
            )
        }
    }

    fun shutdown() {
        if (!stopping.compareAndSet(false, true)) return
        registry.stopAccepting()
        val streams = synchronized(activeStreams) { activeStreams.toList() }
        streams.forEach(ActiveStream::cancel)
        try {
            stop()
        } catch (error: Exception) {
            Log.w(TAG, "NanoHTTPD stop failed: ${error.message}")
        }
    }

    private fun statusResponse(): Response {
        val counts = registry.snapshot()
        val json = cameraManager.getStatusJson(counts.video, counts.audio).apply {
            put("maxStreamClients", counts.maxVideo)
            put("maxAudioClients", counts.maxAudio)
        }
        return jsonResponse(Response.Status.OK, json)
    }

    private fun snapshotResponse(): Response {
        onCameraDemand()
        return try {
            val deadline = SystemClock.elapsedRealtime() + SNAPSHOT_STARTUP_TIMEOUT_MS
            var jpeg = cameraManager.getLatestJpegAndVerify()
            while (
                jpeg == null &&
                !stopping.get() &&
                SystemClock.elapsedRealtime() < deadline
            ) {
                Thread.sleep(SNAPSHOT_POLL_MS)
                jpeg = cameraManager.getLatestJpegAndVerify()
            }
            if (jpeg == null) {
                newFixedLengthResponse(
                    Response.Status.NO_CONTENT,
                    "text/plain",
                    "No fresh valid frame available"
                )
            } else {
                newFixedLengthResponse(
                    Response.Status.OK,
                    "image/jpeg",
                    ByteArrayInputStream(jpeg),
                    jpeg.size.toLong()
                ).apply {
                    addHeader("Cache-Control", "no-store")
                }
            }
        } finally {
            onCameraIdle()
        }
    }

    private fun videoResponse(grant: AuthorizationGrant): Response {
        val lease = registry.acquire(MediaClientRegistry.Kind.VIDEO)
            ?: return unavailable("video client limit reached")
        onCameraDemand()
        val stream = try {
            createStream(lease, pipeSize = 32 * 1024)
        } catch (error: Exception) {
            lease.close()
            throw error
        }
        startVideoProducer(stream, grant)

        return trackedChunkedResponse(
            "multipart/x-mixed-replace; boundary=mjpegboundary",
            stream
        )
    }

    private fun startVideoProducer(
        stream: ActiveStream,
        grant: AuthorizationGrant
    ) {
        val thread = Thread({
            var lastFrame: ByteArray? = null
            var nextCredentialCheckAt = 0L
            try {
                while (!stream.cancelled.get() && !stopping.get()) {
                    val now = SystemClock.elapsedRealtime()
                    if (now >= nextCredentialCheckAt) {
                        if (!credentialStillCurrent(grant)) break
                        nextCredentialCheckAt = now + CREDENTIAL_RECHECK_MS
                    }

                    val jpeg = cameraManager.getLatestJpeg()
                    if (jpeg != null && jpeg !== lastFrame) {
                        val header = buildString {
                            append("--mjpegboundary\r\n")
                            append("Content-Type: image/jpeg\r\n")
                            append("Content-Length: ${jpeg.size}\r\n\r\n")
                        }.toByteArray(Charsets.US_ASCII)
                        stream.output.write(header)
                        stream.output.write(jpeg)
                        stream.output.write("\r\n".toByteArray(Charsets.US_ASCII))
                        stream.output.flush()
                        lastFrame = jpeg
                    }
                    Thread.sleep(MediaResourcePolicy.STREAM_INTERVAL_MS)
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (_: Exception) {
                // Broken/closed pipe is the normal client-disconnect signal.
            } finally {
                stream.cancel()
            }
        }, "roshan-video-client")
        thread.isDaemon = true
        stream.thread = thread
        thread.start()
    }

    private fun audioResponse(grant: AuthorizationGrant): Response {
        val lease = registry.acquire(MediaClientRegistry.Kind.AUDIO)
            ?: return unavailable("audio client limit reached")
        val stream = try {
            createStream(lease, pipeSize = 16 * 1024)
        } catch (error: Exception) {
            lease.close()
            throw error
        }
        startAudioProducer(stream, grant)

        return trackedChunkedResponse("audio/wav", stream)
    }

    private fun startAudioProducer(
        stream: ActiveStream,
        grant: AuthorizationGrant
    ) {
        val thread = Thread({
            var recorder: AudioRecord? = null
            try {
                if (stream.cancelled.get() || !credentialStillCurrent(grant)) return@Thread
                if (ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    throw SecurityException("Microphone permission is not granted")
                }

                val channelConfig = AudioFormat.CHANNEL_IN_MONO
                val audioFormat = AudioFormat.ENCODING_PCM_16BIT
                val minimum = AudioRecord.getMinBufferSize(
                    AUDIO_SAMPLE_RATE,
                    channelConfig,
                    audioFormat
                )
                if (minimum <= 0) {
                    throw IllegalStateException("AudioRecord buffer unavailable: $minimum")
                }
                val bufferSize = minimum.coerceIn(4 * 1024, 16 * 1024)
                recorder = AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    AUDIO_SAMPLE_RATE,
                    channelConfig,
                    audioFormat,
                    bufferSize * 2
                )
                if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                    throw IllegalStateException("AudioRecord failed to initialize")
                }
                if (stream.cancelled.get()) return@Thread

                recorder.startRecording()
                if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    throw IllegalStateException("Microphone did not enter recording state")
                }
                stream.output.write(getWavHeader(AUDIO_SAMPLE_RATE, 1, 16))
                stream.output.flush()

                val buffer = ByteArray(bufferSize)
                var nextCredentialCheckAt =
                    SystemClock.elapsedRealtime() + CREDENTIAL_RECHECK_MS
                while (!stream.cancelled.get() && !stopping.get()) {
                    val now = SystemClock.elapsedRealtime()
                    if (now >= nextCredentialCheckAt) {
                        if (!credentialStillCurrent(grant)) break
                        nextCredentialCheckAt = now + CREDENTIAL_RECHECK_MS
                    }
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read < 0) {
                        throw IllegalStateException("AudioRecord read failed: $read")
                    }
                    if (read > 0) {
                        stream.output.write(buffer, 0, read)
                        stream.output.flush()
                    }
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (error: Exception) {
                if (!stream.cancelled.get() && !stopping.get()) {
                    Log.w(TAG, "Audio client ended: ${error.message}")
                }
            } finally {
                try {
                    if (recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        recorder.stop()
                    }
                } catch (_: Exception) {
                }
                try {
                    recorder?.release()
                } catch (_: Exception) {
                }
                stream.cancel()
            }
        }, "roshan-audio-client")
        thread.isDaemon = true
        stream.thread = thread
        thread.start()
    }

    private fun selectCameraResponse(session: IHTTPSession): Response {
        val cameraTarget = session.parms["lens"]
        if (cameraTarget != "front" && cameraTarget != "rear") {
            return jsonResponse(
                Response.Status.BAD_REQUEST,
                JSONObject().put("ok", false).put("error", "lens must be front or rear")
            )
        }
        onSwitchCamera(cameraTarget)
        return jsonResponse(
            Response.Status.OK,
            JSONObject().put("ok", true).put("selected", cameraTarget)
        )
    }

    private fun createStream(
        lease: MediaClientRegistry.Lease,
        pipeSize: Int
    ): ActiveStream {
        val input = DisconnectAwareInputStream(pipeSize)
        val output = PipedOutputStream(input)
        val stream = ActiveStream(lease, input, output)
        input.onClosed = stream::cancel
        activeStreams.add(stream)
        return stream
    }

    /**
     * NanoHTTPD 2.3.1 does not close a chunked response InputStream when socket
     * output throws. Closing in a finally block is therefore required to make a
     * remote disconnect release its lease, producer, and AudioRecord.
     */
    private fun trackedChunkedResponse(
        mimeType: String,
        stream: ActiveStream
    ): Response {
        return object : Response(
            Response.Status.OK,
            mimeType,
            stream.input,
            -1L
        ) {
            override fun send(outputStream: OutputStream) {
                try {
                    super.send(outputStream)
                } finally {
                    stream.cancel()
                }
            }
        }.apply {
            setChunkedTransfer(true)
            addHeader("Cache-Control", "no-store, no-cache, must-revalidate")
            addHeader("Connection", "close")
        }
    }

    private fun authorize(session: IHTTPSession): AuthorizationGrant? {
        val header = session.headers["authorization"]
            ?: session.headers["Authorization"]
            ?: return null
        if (header.length > AUTH_HEADER_MAX_LENGTH || !header.startsWith("Bearer ")) {
            return null
        }
        val provided = header.removePrefix("Bearer ")
        val expected = secretProvider()
        if (provided.isEmpty() || expected.isNullOrEmpty()) return null

        val providedDigest = sha256(provided)
        val expectedDigest = sha256(expected)
        return if (MessageDigest.isEqual(providedDigest, expectedDigest)) {
            AuthorizationGrant(expectedDigest)
        } else {
            null
        }
    }

    private fun credentialStillCurrent(grant: AuthorizationGrant): Boolean {
        val current = secretProvider() ?: return false
        return MessageDigest.isEqual(grant.credentialDigest, sha256(current))
    }

    private fun sha256(value: String): ByteArray =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))

    private fun unavailable(message: String): Response =
        jsonResponse(
            Response.Status.SERVICE_UNAVAILABLE,
            JSONObject().put("ok", false).put("error", message)
        ).apply {
            addHeader("Retry-After", "2")
        }

    private fun jsonResponse(status: Response.Status, json: JSONObject): Response =
        newFixedLengthResponse(status, "application/json", json.toString())

    private inner class ActiveStream(
        private val lease: MediaClientRegistry.Lease,
        val input: DisconnectAwareInputStream,
        val output: PipedOutputStream
    ) {
        val cancelled = AtomicBoolean(false)

        @Volatile
        var thread: Thread? = null

        fun cancel() {
            if (!cancelled.compareAndSet(false, true)) return
            activeStreams.remove(this)
            lease.close()
            try {
                output.close()
            } catch (_: Exception) {
            }
            try {
                input.closeSilently()
            } catch (_: Exception) {
            }
            thread?.interrupt()
        }
    }

    private class DisconnectAwareInputStream(pipeSize: Int) :
        PipedInputStream(pipeSize) {

        @Volatile
        var onClosed: (() -> Unit)? = null

        private val closed = AtomicBoolean(false)

        override fun close() {
            if (closed.compareAndSet(false, true)) {
                super.close()
                onClosed?.invoke()
            }
        }

        fun closeSilently() {
            if (closed.compareAndSet(false, true)) {
                super.close()
            }
        }
    }

    private fun getWavHeader(
        sampleRate: Int,
        channels: Int,
        bitsPerSample: Int
    ): ByteArray {
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = (channels * bitsPerSample / 8).toShort()
        return ByteArray(44).apply {
            this[0] = 'R'.code.toByte()
            this[1] = 'I'.code.toByte()
            this[2] = 'F'.code.toByte()
            this[3] = 'F'.code.toByte()
            this[4] = 0xff.toByte()
            this[5] = 0xff.toByte()
            this[6] = 0xff.toByte()
            this[7] = 0x7f.toByte()
            this[8] = 'W'.code.toByte()
            this[9] = 'A'.code.toByte()
            this[10] = 'V'.code.toByte()
            this[11] = 'E'.code.toByte()
            this[12] = 'f'.code.toByte()
            this[13] = 'm'.code.toByte()
            this[14] = 't'.code.toByte()
            this[15] = ' '.code.toByte()
            this[16] = 16
            this[20] = 1
            this[22] = channels.toByte()
            writeLittleEndianInt(this, 24, sampleRate)
            writeLittleEndianInt(this, 28, byteRate)
            this[32] = blockAlign.toByte()
            this[33] = (blockAlign.toInt() shr 8).toByte()
            this[34] = bitsPerSample.toByte()
            this[36] = 'd'.code.toByte()
            this[37] = 'a'.code.toByte()
            this[38] = 't'.code.toByte()
            this[39] = 'a'.code.toByte()
            this[40] = 0xff.toByte()
            this[41] = 0xff.toByte()
            this[42] = 0xff.toByte()
            this[43] = 0x7f.toByte()
        }
    }

    private fun writeLittleEndianInt(target: ByteArray, offset: Int, value: Int) {
        target[offset] = (value and 0xff).toByte()
        target[offset + 1] = ((value ushr 8) and 0xff).toByte()
        target[offset + 2] = ((value ushr 16) and 0xff).toByte()
        target[offset + 3] = ((value ushr 24) and 0xff).toByte()
    }
}
