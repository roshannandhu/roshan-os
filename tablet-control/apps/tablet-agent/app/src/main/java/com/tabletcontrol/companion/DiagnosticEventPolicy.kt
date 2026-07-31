package com.tabletcontrol.companion

import java.util.Locale

/**
 * Android-free policy core for the persistent RoshanOS diagnostic journal.
 *
 * Events intentionally have no free-form message. Metadata keys are allowlisted
 * and string values must be short machine-readable slugs. This keeps request
 * bodies, headers, credentials, PINs, SSIDs, and credential-bearing URLs out of
 * both the on-device file and the diagnostics API.
 */
internal object DiagnosticEventPolicy {
    const val SCHEMA_VERSION = 1
    const val MAX_ENTRIES = 256
    const val MAX_FILE_BYTES = 128 * 1024
    const val MAX_FIELDS = 8
    const val MAX_COMPONENT_CHARS = 32
    const val MAX_EVENT_CHARS = 48
    const val MAX_FIELD_VALUE_CHARS = 96
    const val DUPLICATE_WINDOW_MS = 60_000L

    const val REDACTED = "redacted"

    enum class Level(val wireValue: String) {
        INFO("info"),
        WARN("warn"),
        ERROR("error");

        companion object {
            fun fromWireValue(value: String): Level? =
                entries.firstOrNull { it.wireValue == value }
        }
    }

    data class Event(
        val sequence: Long,
        val timestampMs: Long,
        val level: Level,
        val component: String,
        val event: String,
        val fields: Map<String, String>
    )

    private val identifierCharacter = Regex("[a-z0-9_.-]")
    private val safeSlug = Regex("[A-Za-z0-9_.:-]+")
    private val safeErrorClass = Regex("[A-Za-z][A-Za-z0-9]{0,63}")
    private val sensitiveWord = Regex(
        "(^|[^a-z0-9])" +
            "(authorization|bearer|body|cookie|credential|header|nonce|passcode|" +
            "password|passwd|pin|query|secret|ssid|token|url|uri)" +
            "([^a-z0-9]|$)",
        RegexOption.IGNORE_CASE
    )
    private val sensitiveFragment = Regex(
        "authorization|bearer|cookie|credential|nonce|passcode|password|passwd|" +
            "secret|ssid|token",
        RegexOption.IGNORE_CASE
    )
    private val pinLike = Regex(
        "(^|[_:.-])pin(?:[_:.-]|[0-9]|$)",
        RegexOption.IGNORE_CASE
    )
    private val urlLike = Regex(
        "(?:[a-z][a-z0-9+.-]*://|www\\.)",
        RegexOption.IGNORE_CASE
    )
    private val jwtLike = Regex(
        "[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{8,}"
    )

    private val allowedFieldKeys = setOf(
        "circuit_open",
        "degraded_count",
        "duration_minutes",
        "enabled",
        "error_class",
        "generation",
        "healthy",
        "previous_state",
        "reason",
        "result",
        "retry_attempt",
        "service",
        "source",
        "state",
        "trigger"
    )

    private val booleanFieldKeys = setOf(
        "circuit_open",
        "enabled",
        "healthy"
    )

    private val numericFieldKeys = setOf(
        "degraded_count",
        "duration_minutes",
        "generation",
        "retry_attempt"
    )

    fun create(
        sequence: Long,
        timestampMs: Long,
        level: Level,
        component: String,
        event: String,
        fields: Map<String, Any?> = emptyMap()
    ): Event = Event(
        sequence = sequence.coerceAtLeast(1L),
        timestampMs = timestampMs.coerceAtLeast(0L),
        level = level,
        component = sanitizeIdentifier(component, MAX_COMPONENT_CHARS),
        event = sanitizeIdentifier(event, MAX_EVENT_CHARS),
        fields = sanitizeFields(fields)
    )

    fun sanitizeFields(fields: Map<String, Any?>): Map<String, String> {
        val sanitized = sortedMapOf<String, String>()
        fields.entries.forEach { (rawKey, rawValue) ->
            if (sanitized.size >= MAX_FIELDS) return@forEach
            val key = rawKey
                .trim()
                .lowercase(Locale.US)
                .replace('-', '_')
            if (key !in allowedFieldKeys ||
                sensitiveWord.containsMatchIn(key) ||
                sensitiveFragment.containsMatchIn(key) ||
                pinLike.containsMatchIn(key)
            ) {
                return@forEach
            }
            val value = sanitizeFieldValue(key, rawValue) ?: return@forEach
            sanitized[key] = value
        }
        return sanitized
    }

    fun isDuplicate(previous: Event?, candidate: Event): Boolean {
        if (previous == null) return false
        val ageMs = candidate.timestampMs - previous.timestampMs
        if (ageMs !in 0..DUPLICATE_WINDOW_MS) return false
        return previous.level == candidate.level &&
            previous.component == candidate.component &&
            previous.event == candidate.event &&
            previous.fields == candidate.fields
    }

    /**
     * Applies the entry cap and a conservative encoded-size cap. Persistence
     * performs a second exact UTF-8 JSON-size check before an atomic write.
     */
    fun retainNewest(events: List<Event>): List<Event> {
        val retained = ArrayDeque<Event>()
        var estimatedBytes = 128
        for (candidate in events.asReversed()) {
            if (retained.size >= MAX_ENTRIES) break
            val candidateBytes = estimatedEncodedBytes(candidate)
            if (estimatedBytes + candidateBytes > MAX_FILE_BYTES) break
            retained.addFirst(candidate)
            estimatedBytes += candidateBytes
        }
        return retained.toList()
    }

    fun estimatedEncodedBytes(event: Event): Int {
        val characters = event.component.length +
            event.event.length +
            event.level.wireValue.length +
            event.fields.entries.sumOf { (key, value) -> key.length + value.length }
        // JSON punctuation, field names, sequence/timestamp digits, and worst-case
        // UTF-8/escaping overhead. Stored values are ASCII-only, so this remains
        // intentionally conservative.
        return 160 + characters * 2
    }

    private fun sanitizeIdentifier(raw: String, maximumChars: Int): String {
        val normalized = raw
            .trim()
            .lowercase(Locale.US)
            .take(maximumChars)
        if (normalized.isBlank() ||
            sensitiveWord.containsMatchIn(normalized) ||
            sensitiveFragment.containsMatchIn(normalized) ||
            pinLike.containsMatchIn(normalized) ||
            urlLike.containsMatchIn(normalized)
        ) {
            return REDACTED
        }
        val result = buildString(normalized.length) {
            normalized.forEach { character ->
                val text = character.toString()
                append(if (identifierCharacter.matches(text)) character else '_')
            }
        }.trim('_', '.', '-')
        return result.ifBlank { "unknown" }
    }

    private fun sanitizeFieldValue(key: String, rawValue: Any?): String? {
        if (rawValue == null) return null
        if (key in booleanFieldKeys) {
            return when (rawValue) {
                is Boolean -> rawValue.toString()
                is String -> rawValue
                    .trim()
                    .lowercase(Locale.US)
                    .takeIf { it == "true" || it == "false" }
                else -> null
            }
        }
        if (key in numericFieldKeys) {
            return when (rawValue) {
                is Byte, is Short, is Int, is Long ->
                    rawValue.toString().take(MAX_FIELD_VALUE_CHARS)
                is String -> rawValue
                    .trim()
                    .takeIf { it.matches(Regex("-?[0-9]{1,18}")) }
                else -> null
            }
        }

        val candidate = when (rawValue) {
            is Enum<*> -> rawValue.name
            is String -> rawValue
            else -> rawValue.toString()
        }
            .trim()
            .replace(Regex("\\s+"), "_")
            .take(MAX_FIELD_VALUE_CHARS)

        if (candidate.isBlank()) return null
        if (sensitiveWord.containsMatchIn(candidate) ||
            sensitiveFragment.containsMatchIn(candidate) ||
            pinLike.containsMatchIn(candidate) ||
            urlLike.containsMatchIn(candidate) ||
            jwtLike.containsMatchIn(candidate)
        ) {
            return REDACTED
        }
        if (key == "error_class") {
            return candidate.takeIf { safeErrorClass.matches(it) } ?: REDACTED
        }
        return candidate.takeIf { safeSlug.matches(it) } ?: REDACTED
    }
}
