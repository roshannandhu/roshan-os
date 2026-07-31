package com.tabletcontrol.companion

import java.net.InetAddress
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InboundPeerPolicyTest {
    @Test
    fun loopbackAndCompleteTailscaleIpv4RangeAreAllowed() {
        assertAllowed("127.0.0.1")
        assertAllowed("127.255.255.254")
        assertAllowed("100.64.0.0")
        assertAllowed("100.127.255.255")

        assertRejected("100.63.255.255")
        assertRejected("100.128.0.0")
    }

    @Test
    fun tailscaleIpv6PrefixAndIpv6LoopbackAreAllowed() {
        assertAllowed("::1")
        assertAllowed("fd7a:115c:a1e0::1")
        assertAllowed("fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff")

        assertRejected("fd7a:115c:a1df:ffff::1")
        assertRejected("fd7a:115c:a1e1::1")
    }

    @Test
    fun lanPublicAndLinkLocalPeersAreRejected() {
        listOf(
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.20",
            "169.254.1.1",
            "8.8.8.8",
            "fe80::1",
            "2001:4860:4860::8888"
        ).forEach(::assertRejected)
    }

    @Test
    fun sourceAndDestinationMustBelongToTheSameProtectedTransport() {
        assertTrue(
            InboundPeerPolicy.isAllowed(
                InetAddress.getByName("127.0.0.1"),
                InetAddress.getByName("127.0.0.1")
            )
        )
        assertTrue(
            InboundPeerPolicy.isAllowed(
                InetAddress.getByName("100.80.237.40"),
                InetAddress.getByName("100.127.196.63")
            )
        )
        assertFalse(
            InboundPeerPolicy.isAllowed(
                InetAddress.getByName("100.80.237.40"),
                InetAddress.getByName("192.168.1.20")
            )
        )
        assertFalse(
            InboundPeerPolicy.isAllowed(
                InetAddress.getByName("192.168.1.20"),
                InetAddress.getByName("100.127.196.63")
            )
        )
        assertFalse(
            InboundPeerPolicy.isAllowed(
                InetAddress.getByName("127.0.0.1"),
                InetAddress.getByName("100.127.196.63")
            )
        )
    }

    @Test
    fun onlyAllowedIpv4ValuesPassWhenIpv4Mapped() {
        val mappedTailnet = ByteArray(16).apply {
            this[10] = 0xff.toByte()
            this[11] = 0xff.toByte()
            this[12] = 100
            this[13] = 100
            this[14] = 10
            this[15] = 20
        }
        val mappedLan = mappedTailnet.copyOf().apply {
            this[12] = 192.toByte()
            this[13] = 168.toByte()
        }
        assertTrue(InboundPeerPolicy.isAllowedAddressBytes(mappedTailnet))
        assertFalse(InboundPeerPolicy.isAllowedAddressBytes(mappedLan))
    }

    private fun assertAllowed(value: String) {
        val address = InetAddress.getByName(value)
        assertTrue(value, InboundPeerPolicy.isAllowed(address, address))
    }

    private fun assertRejected(value: String) {
        val address = InetAddress.getByName(value)
        assertFalse(
            value,
            InboundPeerPolicy.isAllowed(address, InetAddress.getByName("192.168.1.20"))
        )
    }
}
