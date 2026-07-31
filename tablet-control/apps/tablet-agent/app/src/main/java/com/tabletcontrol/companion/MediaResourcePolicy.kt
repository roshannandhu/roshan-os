package com.tabletcontrol.companion

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pure resource limits shared by the in-process camera pipeline and HTTP
 * streams. Kept Android-free so low-memory and concurrency invariants can be
 * covered by ordinary JVM tests.
 */
internal object MediaResourcePolicy {
    const val TARGET_WIDTH = 640
    const val TARGET_HEIGHT = 480
    const val MAX_FRAME_PIXELS = TARGET_WIDTH * TARGET_HEIGHT
    const val MAX_JPEG_BYTES = 512 * 1024
    const val JPEG_QUALITY = 65
    const val ANALYSIS_INTERVAL_NS = 100_000_000L // 10 fps
    const val STREAM_INTERVAL_MS = 100L // 10 fps
    const val MAX_VIDEO_CLIENTS = 2
    const val MAX_AUDIO_CLIENTS = 1

    fun hasValidJpegEnvelope(bytes: ByteArray?): Boolean {
        if (bytes == null || bytes.size !in 4..MAX_JPEG_BYTES) return false
        return bytes[0] == 0xff.toByte() &&
            bytes[1] == 0xd8.toByte() &&
            bytes[bytes.lastIndex - 1] == 0xff.toByte() &&
            bytes[bytes.lastIndex] == 0xd9.toByte()
    }

    fun dimensionsAreBounded(width: Int, height: Int): Boolean {
        if (width <= 0 || height <= 0) return false
        return width.toLong() * height.toLong() <= MAX_FRAME_PIXELS.toLong()
    }
}

internal class MonotonicFrameGate(private val minimumIntervalNs: Long) {
    init {
        require(minimumIntervalNs > 0L)
    }

    private var lastAcceptedAtNs: Long? = null

    @Synchronized
    fun tryAcquire(nowNs: Long): Boolean {
        val previous = lastAcceptedAtNs
        if (previous != null && nowNs >= previous &&
            nowNs - previous < minimumIntervalNs
        ) {
            return false
        }
        // A backwards clock jump is treated as a new monotonic epoch.
        lastAcceptedAtNs = nowNs
        return true
    }
}

internal class MediaClientRegistry(
    private val maxVideoClients: Int,
    private val maxAudioClients: Int,
    private val onCountsChanged: (Counts) -> Unit = {}
) {
    enum class Kind {
        VIDEO,
        AUDIO
    }

    data class Counts(
        val video: Int,
        val audio: Int,
        val maxVideo: Int,
        val maxAudio: Int
    )

    class Lease internal constructor(
        val kind: Kind,
        private val registry: MediaClientRegistry
    ) : AutoCloseable {
        private val closed = AtomicBoolean(false)

        override fun close() {
            if (closed.compareAndSet(false, true)) {
                registry.release(kind)
            }
        }
    }

    private var videoClients = 0
    private var audioClients = 0
    private var accepting = true

    init {
        require(maxVideoClients > 0)
        require(maxAudioClients > 0)
    }

    @Synchronized
    fun acquire(kind: Kind): Lease? {
        if (!accepting) return null
        when (kind) {
            Kind.VIDEO -> {
                if (videoClients >= maxVideoClients) return null
                videoClients += 1
            }
            Kind.AUDIO -> {
                if (audioClients >= maxAudioClients) return null
                audioClients += 1
            }
        }
        notifyCounts()
        return Lease(kind, this)
    }

    @Synchronized
    fun snapshot(): Counts =
        Counts(videoClients, audioClients, maxVideoClients, maxAudioClients)

    @Synchronized
    fun stopAccepting() {
        accepting = false
    }

    @Synchronized
    private fun release(kind: Kind) {
        when (kind) {
            Kind.VIDEO -> videoClients = (videoClients - 1).coerceAtLeast(0)
            Kind.AUDIO -> audioClients = (audioClients - 1).coerceAtLeast(0)
        }
        notifyCounts()
    }

    private fun notifyCounts() {
        onCountsChanged(
            Counts(videoClients, audioClients, maxVideoClients, maxAudioClients)
        )
    }
}
