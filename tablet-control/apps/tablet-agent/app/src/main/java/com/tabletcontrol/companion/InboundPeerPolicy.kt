package com.tabletcontrol.companion

import java.net.InetAddress

/**
 * Source-address boundary for the plaintext RoshanCore listener.
 *
 * Traffic is accepted only when another encrypted/local transport already
 * protects it: device loopback (including ADB forward) or Tailscale's assigned
 * IPv4/IPv6 ranges. Authentication is still required after this check.
 */
internal object InboundPeerPolicy {
    private enum class TransportClass {
        LOOPBACK,
        TAILNET,
        OTHER
    }

    fun isAllowed(remoteAddress: InetAddress?, localAddress: InetAddress?): Boolean {
        val remote = classify(remoteAddress)
        val local = classify(localAddress)
        return remote != TransportClass.OTHER && remote == local
    }

    internal fun isAllowedAddressBytes(bytes: ByteArray): Boolean =
        classifyAddressBytes(bytes) != TransportClass.OTHER

    private fun classify(address: InetAddress?): TransportClass {
        if (address == null) return TransportClass.OTHER
        if (address.isLoopbackAddress) return TransportClass.LOOPBACK
        return classifyAddressBytes(address.address)
    }

    private fun classifyAddressBytes(bytes: ByteArray): TransportClass {
        return when {
            bytes.size == 4 && isIpv4Loopback(bytes) -> TransportClass.LOOPBACK
            bytes.size == 4 && isTailnetIpv4(bytes) -> TransportClass.TAILNET
            bytes.size == 16 && isIpv6Loopback(bytes) -> TransportClass.LOOPBACK
            bytes.size == 16 && isTailnetIpv6(bytes) -> TransportClass.TAILNET
            bytes.size == 16 -> classifyMappedIpv4(bytes)
            else -> TransportClass.OTHER
        }
    }

    private fun isIpv4Loopback(bytes: ByteArray): Boolean =
        unsigned(bytes[0]) == 127

    private fun isTailnetIpv4(bytes: ByteArray): Boolean {
        val first = unsigned(bytes[0])
        val second = unsigned(bytes[1])
        return first == 100 && second in 64..127
    }

    private fun isIpv6Loopback(bytes: ByteArray): Boolean =
        bytes.take(15).all { it == 0.toByte() } && bytes[15] == 1.toByte()

    private fun isTailnetIpv6(bytes: ByteArray): Boolean =
        unsigned(bytes[0]) == 0xfd &&
            unsigned(bytes[1]) == 0x7a &&
            unsigned(bytes[2]) == 0x11 &&
            unsigned(bytes[3]) == 0x5c &&
            unsigned(bytes[4]) == 0xa1 &&
            unsigned(bytes[5]) == 0xe0

    private fun classifyMappedIpv4(bytes: ByteArray): TransportClass {
        val mappedPrefix =
            bytes.take(10).all { it == 0.toByte() } &&
                unsigned(bytes[10]) == 0xff &&
                unsigned(bytes[11]) == 0xff
        if (!mappedPrefix) return TransportClass.OTHER
        val ipv4 = bytes.copyOfRange(12, 16)
        return when {
            isIpv4Loopback(ipv4) -> TransportClass.LOOPBACK
            isTailnetIpv4(ipv4) -> TransportClass.TAILNET
            else -> TransportClass.OTHER
        }
    }

    private fun unsigned(value: Byte): Int = value.toInt() and 0xff
}
