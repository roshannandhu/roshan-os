package com.tabletcontrol.companion

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Private, reboot-persistent, atomically rewritten diagnostic event ring.
 *
 * This store never reads logcat and accepts only the structured, sanitized event
 * shape enforced by [DiagnosticEventPolicy]. It lives in no-backup app storage,
 * is erased by factory reset/app-data removal, and has both entry and byte caps.
 */
internal object DiagnosticEventStore {
    private const val DIRECTORY_NAME = "diagnostics"
    private const val FILE_NAME = "events-v1.json"

    private data class PersistedState(
        val nextSequence: Long,
        val events: List<DiagnosticEventPolicy.Event>
    )

    data class Snapshot(
        val generatedAtMs: Long,
        val events: List<DiagnosticEventPolicy.Event>
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("schemaVersion", DiagnosticEventPolicy.SCHEMA_VERSION)
            put("generatedAtMs", generatedAtMs)
            put("entryCount", events.size)
            put(
                "oldestSequence",
                events.firstOrNull()?.sequence ?: JSONObject.NULL
            )
            put(
                "newestSequence",
                events.lastOrNull()?.sequence ?: JSONObject.NULL
            )
            put("limits", JSONObject().apply {
                put("maxEntries", DiagnosticEventPolicy.MAX_ENTRIES)
                put("maxFileBytes", DiagnosticEventPolicy.MAX_FILE_BYTES)
                put("maxFieldsPerEntry", DiagnosticEventPolicy.MAX_FIELDS)
                put(
                    "maxFieldValueChars",
                    DiagnosticEventPolicy.MAX_FIELD_VALUE_CHARS
                )
            })
            put("events", JSONArray().apply {
                events.forEach { event -> put(eventToJson(event)) }
            })
        }
    }

    private val lock = Any()

    fun info(
        context: Context,
        component: String,
        event: String,
        fields: Map<String, Any?> = emptyMap()
    ): Boolean = record(
        context,
        DiagnosticEventPolicy.Level.INFO,
        component,
        event,
        fields
    )

    fun warn(
        context: Context,
        component: String,
        event: String,
        fields: Map<String, Any?> = emptyMap()
    ): Boolean = record(
        context,
        DiagnosticEventPolicy.Level.WARN,
        component,
        event,
        fields
    )

    fun error(
        context: Context,
        component: String,
        event: String,
        fields: Map<String, Any?> = emptyMap()
    ): Boolean = record(
        context,
        DiagnosticEventPolicy.Level.ERROR,
        component,
        event,
        fields
    )

    fun snapshot(context: Context): Snapshot = synchronized(lock) {
        val events = try {
            readState(fileFor(context)).events
        } catch (_: Exception) {
            emptyList()
        }
        Snapshot(
            generatedAtMs = System.currentTimeMillis(),
            events = events
        )
    }

    fun clear(context: Context): Boolean = synchronized(lock) {
        try {
            fileFor(context).delete()
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun record(
        context: Context,
        level: DiagnosticEventPolicy.Level,
        component: String,
        event: String,
        fields: Map<String, Any?>
    ): Boolean = synchronized(lock) {
        try {
            val atomicFile = fileFor(context)
            val current = readState(atomicFile)
            val sequence = current.nextSequence
                .coerceAtLeast((current.events.lastOrNull()?.sequence ?: 0L) + 1L)
                .coerceAtLeast(1L)
            val candidate = DiagnosticEventPolicy.create(
                sequence = sequence,
                timestampMs = System.currentTimeMillis(),
                level = level,
                component = component,
                event = event,
                fields = fields
            )
            if (DiagnosticEventPolicy.isDuplicate(current.events.lastOrNull(), candidate)) {
                return@synchronized false
            }

            var events = DiagnosticEventPolicy.retainNewest(current.events + candidate)
            var nextSequence = if (sequence == Long.MAX_VALUE) 1L else sequence + 1L
            var bytes = encodeState(PersistedState(nextSequence, events))
            while (bytes.size > DiagnosticEventPolicy.MAX_FILE_BYTES && events.isNotEmpty()) {
                events = events.drop(1)
                bytes = encodeState(PersistedState(nextSequence, events))
            }
            if (bytes.size > DiagnosticEventPolicy.MAX_FILE_BYTES) {
                return@synchronized false
            }
            if (events.none { it.sequence == candidate.sequence }) {
                return@synchronized false
            }

            if (nextSequence <= 0L) nextSequence = 1L
            writeAtomically(
                atomicFile,
                encodeState(PersistedState(nextSequence, events))
            )
        } catch (_: Exception) {
            false
        }
    }

    private fun fileFor(context: Context): AtomicFile {
        val appContext = context.applicationContext
        val directory = File(appContext.noBackupFilesDir, DIRECTORY_NAME)
        if (!directory.exists() && !directory.mkdirs()) {
            throw IllegalStateException("diagnostic directory unavailable")
        }
        return AtomicFile(File(directory, FILE_NAME))
    }

    private fun readState(atomicFile: AtomicFile): PersistedState {
        val baseFile = atomicFile.baseFile
        if (!baseFile.isFile) return PersistedState(1L, emptyList())
        if (baseFile.length() !in 1..DiagnosticEventPolicy.MAX_FILE_BYTES.toLong()) {
            return PersistedState(1L, emptyList())
        }

        val bytes = atomicFile.openRead().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > DiagnosticEventPolicy.MAX_FILE_BYTES) {
                    return PersistedState(1L, emptyList())
                }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }

        return try {
            val root = JSONObject(bytes.toString(Charsets.UTF_8))
            if (root.optInt("schemaVersion", -1) != DiagnosticEventPolicy.SCHEMA_VERSION) {
                return PersistedState(1L, emptyList())
            }
            val source = root.optJSONArray("events") ?: JSONArray()
            val parsed = mutableListOf<DiagnosticEventPolicy.Event>()
            for (index in 0 until source.length()) {
                parseEvent(source.optJSONObject(index))?.let(parsed::add)
            }
            val retained = DiagnosticEventPolicy.retainNewest(
                parsed
                    .distinctBy { it.sequence }
                    .sortedBy { it.sequence }
            )
            val minimumNext = (retained.lastOrNull()?.sequence ?: 0L)
                .let { if (it == Long.MAX_VALUE) 1L else it + 1L }
                .coerceAtLeast(1L)
            val storedNext = root.optLong("nextSequence", minimumNext)
            PersistedState(
                nextSequence = storedNext.coerceAtLeast(minimumNext),
                events = retained
            )
        } catch (_: Exception) {
            PersistedState(1L, emptyList())
        }
    }

    private fun parseEvent(json: JSONObject?): DiagnosticEventPolicy.Event? {
        if (json == null) return null
        val level = DiagnosticEventPolicy.Level.fromWireValue(
            json.optString("level", "")
        ) ?: return null
        val fieldsJson = json.optJSONObject("fields") ?: JSONObject()
        val fields = linkedMapOf<String, Any?>()
        val keys = fieldsJson.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            fields[key] = fieldsJson.optString(key, "")
        }
        return DiagnosticEventPolicy.create(
            sequence = json.optLong("sequence", 1L),
            timestampMs = json.optLong("timestampMs", 0L),
            level = level,
            component = json.optString("component", "unknown"),
            event = json.optString("event", "unknown"),
            fields = fields
        )
    }

    private fun encodeState(state: PersistedState): ByteArray {
        val root = JSONObject()
            .put("schemaVersion", DiagnosticEventPolicy.SCHEMA_VERSION)
            .put("nextSequence", state.nextSequence)
            .put("events", JSONArray().apply {
                state.events.forEach { event -> put(eventToJson(event)) }
            })
        return root.toString().toByteArray(Charsets.UTF_8)
    }

    private fun writeAtomically(atomicFile: AtomicFile, bytes: ByteArray): Boolean {
        if (bytes.size > DiagnosticEventPolicy.MAX_FILE_BYTES) return false
        val output = atomicFile.startWrite()
        return try {
            output.write(bytes)
            atomicFile.finishWrite(output)
            atomicFile.baseFile.length() <= DiagnosticEventPolicy.MAX_FILE_BYTES
        } catch (_: Exception) {
            atomicFile.failWrite(output)
            false
        }
    }

    private fun eventToJson(event: DiagnosticEventPolicy.Event): JSONObject =
        JSONObject()
            .put("sequence", event.sequence)
            .put("timestampMs", event.timestampMs)
            .put("level", event.level.wireValue)
            .put("component", event.component)
            .put("event", event.event)
            .put("fields", JSONObject().apply {
                event.fields.forEach { (key, value) -> put(key, value) }
            })
}
