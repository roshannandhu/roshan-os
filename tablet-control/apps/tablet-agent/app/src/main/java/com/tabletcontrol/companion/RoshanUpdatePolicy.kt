package com.tabletcontrol.companion

import java.net.URI
import java.util.Locale

/**
 * Android-free policy for RoshanCore self updates.
 *
 * Keeping this class free of Android framework types makes the security
 * boundary directly testable by the host-side JVM suite.
 */
object RoshanUpdatePolicy {
    const val PACKAGE_NAME = "com.tabletcontrol.companion"
    const val MAX_URL_LENGTH = 2_048
    const val MAX_APK_BYTES = 128L * 1_024L * 1_024L
    const val CONNECT_TIMEOUT_MS = 10_000
    const val READ_TIMEOUT_MS = 15_000
    const val TOTAL_DOWNLOAD_TIMEOUT_MS = 120_000L

    private val sha256Pattern = Regex("^[0-9a-fA-F]{64}$")
    private val dnsNamePattern = Regex(
        "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+" +
            "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
    )

    data class ValidatedUrl(
        val uri: URI,
        val canonicalUrl: String,
        val host: String
    )

    data class ValidatedOrigin(
        val canonicalOrigin: String,
        val host: String
    )

    data class Validation<T>(
        val value: T? = null,
        val errorCode: String? = null
    ) {
        val valid: Boolean
            get() = value != null && errorCode == null
    }

    fun parseAllowedControllerHosts(csv: String): Set<String> =
        csv.split(',')
            .asSequence()
            .map(String::trim)
            .filter(String::isNotEmpty)
            .map { it.lowercase(Locale.US) }
            .filter(::isTailscaleDnsName)
            .toSet()

    fun validateControllerOrigin(rawValue: String): Validation<ValidatedOrigin> {
        if (rawValue.isEmpty() || rawValue.length > MAX_URL_LENGTH) {
            return Validation(errorCode = "INVALID_ORIGIN_LENGTH")
        }
        if (rawValue.any { it.code !in 0x21..0x7e }) {
            return Validation(errorCode = "INVALID_ORIGIN_CHARACTERS")
        }
        val uri = try {
            URI(rawValue)
        } catch (_: Exception) {
            return Validation(errorCode = "INVALID_CONTROLLER_ORIGIN")
        }
        if (
            uri.isOpaque ||
            !uri.scheme.equals("https", ignoreCase = true) ||
            uri.userInfo != null ||
            uri.rawQuery != null ||
            uri.rawFragment != null ||
            uri.port !in setOf(-1, 443) ||
            (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/")
        ) {
            return Validation(errorCode = "UNSAFE_CONTROLLER_ORIGIN")
        }
        val host = uri.host?.lowercase(Locale.US)
            ?: return Validation(errorCode = "INVALID_CONTROLLER_HOST")
        if (host.endsWith('.') || !isTailscaleDnsName(host)) {
            return Validation(errorCode = "CONTROLLER_HOST_NOT_TAILSCALE")
        }
        return Validation(
            value = ValidatedOrigin(
                canonicalOrigin = "https://$host",
                host = host
            )
        )
    }

    fun validateUpdateUrl(
        rawValue: String,
        allowedControllerHosts: Set<String>
    ): Validation<ValidatedUrl> {
        if (rawValue.isEmpty() || rawValue.length > MAX_URL_LENGTH) {
            return Validation(errorCode = "INVALID_URL_LENGTH")
        }
        if (rawValue.any { it.code !in 0x21..0x7e }) {
            return Validation(errorCode = "INVALID_URL_CHARACTERS")
        }

        val uri = try {
            URI(rawValue)
        } catch (_: Exception) {
            return Validation(errorCode = "INVALID_URL")
        }
        if (
            uri.isOpaque ||
            !uri.scheme.equals("https", ignoreCase = true) ||
            uri.userInfo != null ||
            uri.rawQuery != null ||
            uri.rawFragment != null ||
            uri.port !in setOf(-1, 443)
        ) {
            return Validation(errorCode = "UNSAFE_UPDATE_URL")
        }

        val host = uri.host?.lowercase(Locale.US)
            ?: return Validation(errorCode = "INVALID_UPDATE_HOST")
        if (
            host.endsWith('.') ||
            !isTailscaleDnsName(host) ||
            host !in allowedControllerHosts
        ) {
            return Validation(errorCode = "UPDATE_HOST_NOT_ALLOWED")
        }

        val rawPath = uri.rawPath
        if (rawPath.isNullOrBlank() || !rawPath.startsWith('/') || '\\' in rawPath) {
            return Validation(errorCode = "INVALID_UPDATE_PATH")
        }

        val canonical = URI(
            "https",
            null,
            host,
            if (uri.port == 443) 443 else -1,
            rawPath,
            null,
            null
        ).toASCIIString()
        return Validation(
            value = ValidatedUrl(
                uri = URI(canonical),
                canonicalUrl = canonical,
                host = host
            )
        )
    }

    fun normalizeSha256(value: String): String? =
        value.takeIf(sha256Pattern::matches)?.lowercase(Locale.US)

    fun isStrictUpgrade(installedVersionCode: Long, candidateVersionCode: Long): Boolean =
        installedVersionCode >= 0L && candidateVersionCode > installedVersionCode

    fun signerSetsExactlyMatch(
        installedSignerDigests: Collection<String>,
        candidateSignerDigests: Collection<String>
    ): Boolean {
        val installed = normalizeSignerSet(installedSignerDigests) ?: return false
        val candidate = normalizeSignerSet(candidateSignerDigests) ?: return false
        return installed.isNotEmpty() && installed == candidate
    }

    fun isInProgress(state: String): Boolean = state in setOf(
        "downloading",
        "verifying",
        "staging",
        "committing",
        "rollback_committing"
    )

    fun callbackMatches(
        expectedState: String,
        currentState: String,
        persistedOperationId: Int?,
        callbackOperationId: Int
    ): Boolean =
        currentState == expectedState &&
            callbackOperationId >= 0 &&
            persistedOperationId == callbackOperationId

    fun installResultErrorCode(status: Int): String = when (status) {
        -1 -> "USER_ACTION_REQUIRED"
        1 -> "INSTALL_FAILURE"
        2 -> "INSTALL_ABORTED"
        3 -> "INSTALL_BLOCKED"
        4 -> "INSTALL_CONFLICT"
        5 -> "INSTALL_INCOMPATIBLE"
        6 -> "INSTALL_INVALID"
        7 -> "INSTALL_STORAGE"
        8 -> "INSTALL_TIMEOUT"
        else -> "INSTALL_UNKNOWN_STATUS"
    }

    fun rollbackResultErrorCode(status: Int): String = when (status) {
        1 -> "ROLLBACK_FAILURE"
        2 -> "ROLLBACK_UNAVAILABLE"
        3 -> "ROLLBACK_INSTALL_FAILURE"
        else -> "ROLLBACK_UNKNOWN_STATUS"
    }

    private fun normalizeSignerSet(values: Collection<String>): Set<String>? {
        val normalized = values.map {
            normalizeSha256(it) ?: return null
        }.toSet()
        if (normalized.size != values.size) return null
        return normalized
    }

    private fun isTailscaleDnsName(host: String): Boolean =
        dnsNamePattern.matches(host) &&
            host != "ts.net" &&
            host.endsWith(".ts.net")
}
