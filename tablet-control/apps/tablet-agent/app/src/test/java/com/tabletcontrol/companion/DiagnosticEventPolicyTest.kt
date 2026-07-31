package com.tabletcontrol.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticEventPolicyTest {
    @Test
    fun sensitiveKeysAndValuesNeverSurviveSanitization() {
        val event = DiagnosticEventPolicy.create(
            sequence = 7,
            timestampMs = 1234,
            level = DiagnosticEventPolicy.Level.WARN,
            component = "core",
            event = "privacy_check",
            fields = linkedMapOf(
                "authorization" to "Bearer top-secret",
                "request_body" to "{\"password\":\"unsafe\"}",
                "reason" to "token=abc123",
                "state" to "https://owner:password@example.invalid/path",
                "result" to "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz123456",
                "service" to "pin:1234",
                "source" to "safe_owner_action",
                "enabled" to true
            )
        )

        assertFalse(event.fields.containsKey("authorization"))
        assertFalse(event.fields.containsKey("request_body"))
        assertEquals(DiagnosticEventPolicy.REDACTED, event.fields["reason"])
        assertEquals(DiagnosticEventPolicy.REDACTED, event.fields["state"])
        assertEquals(DiagnosticEventPolicy.REDACTED, event.fields["result"])
        assertEquals(DiagnosticEventPolicy.REDACTED, event.fields["service"])
        assertEquals("safe_owner_action", event.fields["source"])
        assertEquals("true", event.fields["enabled"])
    }

    @Test
    fun identifiersFieldsAndValuesHaveHardBounds() {
        val event = DiagnosticEventPolicy.create(
            sequence = -1,
            timestampMs = -1,
            level = DiagnosticEventPolicy.Level.INFO,
            component = "CORE ".repeat(30),
            event = "Started / with unsafe free text ".repeat(10),
            fields = linkedMapOf(
                "trigger" to "t".repeat(300),
                "reason" to "fixed_reason",
                "state" to "healthy",
                "previous_state" to "starting",
                "result" to "success",
                "service" to "core",
                "source" to "boot",
                "enabled" to true,
                "healthy" to true,
                "unknown" to "must_not_be_stored"
            )
        )

        assertEquals(1L, event.sequence)
        assertEquals(0L, event.timestampMs)
        assertTrue(event.component.length <= DiagnosticEventPolicy.MAX_COMPONENT_CHARS)
        assertTrue(event.event.length <= DiagnosticEventPolicy.MAX_EVENT_CHARS)
        assertTrue(event.fields.size <= DiagnosticEventPolicy.MAX_FIELDS)
        assertTrue(
            event.fields.values.all {
                it.length <= DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS
            }
        )
        assertFalse(event.fields.containsKey("unknown"))
    }

    @Test
    fun ringKeepsNewestEntriesWithinCountBound() {
        val events = (1L..400L).map { sequence ->
            DiagnosticEventPolicy.create(
                sequence = sequence,
                timestampMs = sequence * 1_000,
                level = DiagnosticEventPolicy.Level.INFO,
                component = "supervisor",
                event = "health_transition",
                fields = mapOf("state" to "healthy")
            )
        }

        val retained = DiagnosticEventPolicy.retainNewest(events)

        assertEquals(DiagnosticEventPolicy.MAX_ENTRIES, retained.size)
        assertEquals(145L, retained.first().sequence)
        assertEquals(400L, retained.last().sequence)
    }

    @Test
    fun ringAlsoHonorsConservativeByteBound() {
        val fields = linkedMapOf<String, Any?>(
            "trigger" to "a".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "reason" to "b".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "state" to "c".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "previous_state" to "d".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "result" to "e".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "service" to "f".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "source" to "g".repeat(DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS),
            "error_class" to "IllegalStateException"
        )
        val events = (1L..DiagnosticEventPolicy.MAX_ENTRIES.toLong()).map { sequence ->
            DiagnosticEventPolicy.create(
                sequence = sequence,
                timestampMs = sequence,
                level = DiagnosticEventPolicy.Level.ERROR,
                component = "supervisor",
                event = "bounded_failure",
                fields = fields
            )
        }

        val retained = DiagnosticEventPolicy.retainNewest(events)
        val estimatedBytes = 128 + retained.sumOf(
            DiagnosticEventPolicy::estimatedEncodedBytes
        )

        assertTrue(retained.isNotEmpty())
        assertTrue(retained.size < DiagnosticEventPolicy.MAX_ENTRIES)
        assertTrue(estimatedBytes <= DiagnosticEventPolicy.MAX_FILE_BYTES)
        assertEquals(events.last().sequence, retained.last().sequence)
    }

    @Test
    fun exactDuplicatesAreSuppressedOnlyInsideWindow() {
        val first = DiagnosticEventPolicy.create(
            sequence = 1,
            timestampMs = 1_000,
            level = DiagnosticEventPolicy.Level.INFO,
            component = "wifi",
            event = "connectivity_transition",
            fields = mapOf("state" to "connected")
        )
        val duplicate = first.copy(sequence = 2, timestampMs = 30_000)
        val later = first.copy(
            sequence = 3,
            timestampMs = 1_000 + DiagnosticEventPolicy.DUPLICATE_WINDOW_MS + 1
        )
        val different = duplicate.copy(
            sequence = 4,
            fields = mapOf("state" to "disconnected")
        )

        assertTrue(DiagnosticEventPolicy.isDuplicate(first, duplicate))
        assertFalse(DiagnosticEventPolicy.isDuplicate(first, later))
        assertFalse(DiagnosticEventPolicy.isDuplicate(first, different))
    }

    @Test
    fun fixedLifecycleReasonsRemainMachineReadable() {
        val event = DiagnosticEventPolicy.create(
            sequence = 1,
            timestampMs = 1,
            level = DiagnosticEventPolicy.Level.INFO,
            component = "core",
            event = "lifecycle",
            fields = mapOf(
                "reason" to "service_stopping",
                "trigger" to "package_replaced",
                "state" to "healthy"
            )
        )

        assertEquals("service_stopping", event.fields["reason"])
        assertEquals("package_replaced", event.fields["trigger"])
        assertEquals("healthy", event.fields["state"])
    }
}
