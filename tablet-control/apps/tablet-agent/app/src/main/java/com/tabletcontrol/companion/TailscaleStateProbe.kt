package com.tabletcontrol.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.InetAddress

/**
 * Truthful, app-independent Tailscale VPN detection.
 *
 * A plain "any VPN transport" check is not a truthful Tailscale state because
 * unrelated VPNs would report healthy. This probe requires the distinctive
 * Tailscale signatures on the active VPN network:
 *
 * 1. MagicDNS server 100.100.100.100 (and fd7a:115c:a1e0::53) as a DNS server
 *    of the VPN network's LinkProperties.
 * 2. A tailnet IPv4 address inside the 100.64.0.0/10 CGNAT range.
 * 3. A tailnet IPv6 address under the fd7a:115c:a1e0::/48 prefix.
 *
 * A VPN transport plus at least one of the above signatures is reported as
 * Tailscale-connected; the flags are also surfaced so callers can verify why.
 */
internal object TailscaleStateProbe {
    private val MAGIC_DNS_IPV4 = byteArrayOf(100, 100, 100, 100)
    private val TAILNET_PREFIX_IPV4: Pair<Int, Int> = 100 to 64 // 100.64.0.0/10
    private const val TAILNET_IPV6_PREFIX = "fd7a:115c:a1e0"

    data class Result(
        val vpnTransportPresent: Boolean,
        val magicDnsPresent: Boolean,
        val tailnetIpv4Present: Boolean,
        val tailnetIpv6Present: Boolean,
        val validated: Boolean
    ) {
        val connected: Boolean
            get() =
                vpnTransportPresent &&
                    (magicDnsPresent || tailnetIpv4Present || tailnetIpv6Present)
    }

    fun probe(context: Context): Result {
        return try {
            val connectivity =
                context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            var vpnTransport = false
            var magicDns = false
            var tailnetIpv4 = false
            var tailnetIpv6 = false
            var validated = false
            connectivity.allNetworks.forEach { network ->
                val capabilities = connectivity.getNetworkCapabilities(network) ?: return@forEach
                if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@forEach
                vpnTransport = true
                if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    validated = true
                }
                val link = connectivity.getLinkProperties(network) ?: return@forEach
                if (linkHasMagicDns(link)) magicDns = true
                if (linkHasTailnetIpv4(link)) tailnetIpv4 = true
                if (linkHasTailnetIpv6(link)) tailnetIpv6 = true
            }
            Result(
                vpnTransportPresent = vpnTransport,
                magicDnsPresent = magicDns,
                tailnetIpv4Present = tailnetIpv4,
                tailnetIpv6Present = tailnetIpv6,
                validated = validated
            )
        } catch (_: Exception) {
            Result(
                vpnTransportPresent = false,
                magicDnsPresent = false,
                tailnetIpv4Present = false,
                tailnetIpv6Present = false,
                validated = false
            )
        }
    }

    private fun linkHasMagicDns(link: LinkProperties): Boolean {
        return link.dnsServers.any { dns ->
            dns.address.contentEquals(MAGIC_DNS_IPV4)
        }
    }

    private fun linkHasTailnetIpv4(link: LinkProperties): Boolean {
        return link.linkAddresses.any { addressInfo ->
            val address = addressInfo.address
            address is Inet4Address &&
                address.address.size == 4 &&
                (address.address[0].toInt() and 0xff) == TAILNET_PREFIX_IPV4.first &&
                (address.address[1].toInt() and 0xff) in TAILNET_PREFIX_IPV4.second..127
        }
    }

    private fun linkHasTailnetIpv6(link: LinkProperties): Boolean {
        return link.linkAddresses.any { addressInfo ->
            addressInfo.address.hostAddress?.lowercase()
                ?.startsWith(TAILNET_IPV6_PREFIX) == true
        }
    }

    fun tailnetIpv4Address(context: Context): InetAddress? {
        return try {
            val connectivity =
                context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            connectivity.allNetworks.forEach { network ->
                val capabilities = connectivity.getNetworkCapabilities(network) ?: return@forEach
                if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@forEach
                val link = connectivity.getLinkProperties(network) ?: return@forEach
                link.linkAddresses.forEach { addressInfo ->
                    val address = addressInfo.address
                    if (address is Inet4Address &&
                        (address.address[0].toInt() and 0xff) == TAILNET_PREFIX_IPV4.first &&
                        (address.address[1].toInt() and 0xff) in TAILNET_PREFIX_IPV4.second..127
                    ) {
                        return address
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }
}
