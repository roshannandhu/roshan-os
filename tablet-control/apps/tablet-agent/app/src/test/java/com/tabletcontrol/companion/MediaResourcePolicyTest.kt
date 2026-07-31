package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaResourcePolicyTest {
    @Test
    fun clientLimitsAreStrictAndIndependent() {
        val registry = MediaClientRegistry(maxVideoClients = 2, maxAudioClients = 1)
        val videoOne = registry.acquire(MediaClientRegistry.Kind.VIDEO)
        val videoTwo = registry.acquire(MediaClientRegistry.Kind.VIDEO)
        val audio = registry.acquire(MediaClientRegistry.Kind.AUDIO)

        assertNotNull(videoOne)
        assertNotNull(videoTwo)
        assertNotNull(audio)
        assertNull(registry.acquire(MediaClientRegistry.Kind.VIDEO))
        assertNull(registry.acquire(MediaClientRegistry.Kind.AUDIO))
        assertEquals(2, registry.snapshot().video)
        assertEquals(1, registry.snapshot().audio)

        audio!!.close()
        assertEquals(2, registry.snapshot().video)
        assertEquals(0, registry.snapshot().audio)
        videoOne!!.close()
        assertEquals(1, registry.snapshot().video)
    }

    @Test
    fun leaseCloseIsIdempotentAndShutdownRejectsNewClients() {
        val registry = MediaClientRegistry(maxVideoClients = 1, maxAudioClients = 1)
        val lease = registry.acquire(MediaClientRegistry.Kind.VIDEO)!!

        lease.close()
        lease.close()
        assertEquals(0, registry.snapshot().video)

        registry.stopAccepting()
        assertNull(registry.acquire(MediaClientRegistry.Kind.VIDEO))
        assertNull(registry.acquire(MediaClientRegistry.Kind.AUDIO))
    }

    @Test
    fun clientCountCallbackMakesCameraDemandAndIdleTransitionsObservable() {
        val observedVideoCounts = mutableListOf<Int>()
        val registry = MediaClientRegistry(
            maxVideoClients = 1,
            maxAudioClients = 1
        ) { counts ->
            observedVideoCounts += counts.video
        }

        val audio = registry.acquire(MediaClientRegistry.Kind.AUDIO)!!
        val video = registry.acquire(MediaClientRegistry.Kind.VIDEO)!!
        video.close()
        audio.close()

        assertEquals(listOf(0, 1, 0, 0), observedVideoCounts)
        assertEquals(0, registry.snapshot().video)
    }

    @Test
    fun frameGateCapsProcessingRateUsingMonotonicTime() {
        val gate = MonotonicFrameGate(100L)

        assertTrue(gate.tryAcquire(1_000L))
        assertFalse(gate.tryAcquire(1_099L))
        assertTrue(gate.tryAcquire(1_100L))
        assertTrue("Clock reset starts a new epoch", gate.tryAcquire(5L))
    }

    @Test
    fun jpegEnvelopeAndDimensionsAreBounded() {
        val jpeg = byteArrayOf(
            0xff.toByte(),
            0xd8.toByte(),
            0x00,
            0xff.toByte(),
            0xd9.toByte()
        )

        assertTrue(MediaResourcePolicy.hasValidJpegEnvelope(jpeg))
        assertFalse(MediaResourcePolicy.hasValidJpegEnvelope(byteArrayOf(1, 2, 3, 4)))
        assertTrue(MediaResourcePolicy.dimensionsAreBounded(640, 480))
        assertFalse(MediaResourcePolicy.dimensionsAreBounded(1280, 720))
    }
}
