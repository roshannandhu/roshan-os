package com.tabletcontrol.companion

import android.content.Context
import android.view.WindowManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Typed, owner-controlled remote interaction for the rooted development tablet.
 *
 * There is intentionally no generic shell method or endpoint. Every command is
 * assembled from bounded integers, a fixed key allowlist, or a package already
 * approved by RoshanOS. Remote control is disabled by default.
 */
object RemoteControlManager {
    private const val PREFS = "remote_control"
    private const val KEY_ENABLED = "enabled"
    const val MAX_ACTIONS_PER_MINUTE = 90
    const val MAX_SCREENSHOTS_PER_MINUTE = 30
    private const val MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
    private const val MAX_AUDIT_EVENTS = 100
    private val SAFE_TEXT = Regex("[A-Za-z0-9 .,!?@_+\\-]+")
    private val SAFE_PACKAGE =
        Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")

    private val actionTimes = ArrayDeque<Long>()
    private val screenshotTimes = ArrayDeque<Long>()
    private val auditEvents = ArrayDeque<AuditEvent>()

    enum class RemoteKey(val androidKeyCode: String) {
        BACK("KEYCODE_BACK"),
        HOME("KEYCODE_HOME"),
        RECENTS("KEYCODE_APP_SWITCH"),
        ENTER("KEYCODE_ENTER"),
        DPAD_UP("KEYCODE_DPAD_UP"),
        DPAD_DOWN("KEYCODE_DPAD_DOWN"),
        DPAD_LEFT("KEYCODE_DPAD_LEFT"),
        DPAD_RIGHT("KEYCODE_DPAD_RIGHT"),
        MEDIA_PLAY_PAUSE("KEYCODE_MEDIA_PLAY_PAUSE"),
        MEDIA_NEXT("KEYCODE_MEDIA_NEXT"),
        MEDIA_PREVIOUS("KEYCODE_MEDIA_PREVIOUS"),
        VOLUME_UP("KEYCODE_VOLUME_UP"),
        VOLUME_DOWN("KEYCODE_VOLUME_DOWN")
    }

    data class AuditEvent(
        val timestamp: Long,
        val action: String,
        val success: Boolean
    )

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_ENABLED, false)

    fun statusJson(context: Context): JSONObject {
        val (width, height) = screenDimensions(context)
        return JSONObject().apply {
            put("enabled", isEnabled(context))
            put("allowedKeys", JSONArray().apply {
                RemoteKey.entries.forEach { put(it.name) }
            })
            put("screenWidth", width)
            put("screenHeight", height)
            put("maxActionsPerMinute", MAX_ACTIONS_PER_MINUTE)
            put("maxScreenshotsPerMinute", MAX_SCREENSHOTS_PER_MINUTE)
        }
    }

    fun selfTest(): Boolean {
        val su = RootCommand.suBinary() ?: return false
        return try {
            val process = ProcessBuilder(su, "-c", "true")
                .redirectErrorStream(true)
                .start()
            val finished = process.waitFor(2, TimeUnit.SECONDS)
            if (!finished) process.destroyForcibly()
            finished && process.exitValue() == 0
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply()
        actionTimes.clear()
        screenshotTimes.clear()
        recordAudit("remote-${if (enabled) "enabled" else "disabled"}", true)
    }

    fun captureScreen(context: Context): ByteArray? {
        if (!isEnabled(context) || !consumeRate(screenshotTimes, MAX_SCREENSHOTS_PER_MINUTE)) {
            recordAudit("screenshot", false)
            return null
        }

        val result = runForBytes("screencap -p", MAX_SCREENSHOT_BYTES, 5)
        val valid = result != null &&
            result.size >= 8 &&
            result[0] == 0x89.toByte() &&
            result[1] == 0x50.toByte() &&
            result[2] == 0x4e.toByte() &&
            result[3] == 0x47.toByte()
        recordAudit("screenshot", valid)
        return result?.takeIf { valid }
    }

    fun tap(context: Context, x: Int, y: Int): Boolean {
        if (!canAct(context) || !validPoint(context, x, y)) {
            recordAudit("tap", false)
            return false
        }
        return runTypedAction("tap", "input tap $x $y")
    }

    fun swipe(
        context: Context,
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMs: Int
    ): Boolean {
        if (!canAct(context) ||
            !validPoint(context, startX, startY) ||
            !validPoint(context, endX, endY) ||
            durationMs !in 50..2_000
        ) {
            recordAudit("swipe", false)
            return false
        }
        return runTypedAction(
            "swipe",
            "input swipe $startX $startY $endX $endY $durationMs"
        )
    }

    fun pressKey(context: Context, keyName: String): Boolean {
        if (!canAct(context)) {
            recordAudit("key", false)
            return false
        }
        val key = try {
            RemoteKey.valueOf(keyName.trim().uppercase())
        } catch (_: IllegalArgumentException) {
            recordAudit("key", false)
            return false
        }
        return runTypedAction("key-${key.name.lowercase()}", "input keyevent ${key.androidKeyCode}")
    }

    fun inputText(context: Context, text: String): Boolean {
        if (!canAct(context) ||
            text.length !in 1..120 ||
            !isValidText(text)
        ) {
            recordAudit("text", false)
            return false
        }

        // The strict character allowlist excludes a single quote, shell control
        // operators, substitutions, slashes, and newlines. Quoting therefore
        // prevents glob expansion while Android's input command receives %s for
        // spaces.
        val encoded = text.replace("%", "").replace(" ", "%s")
        return runTypedAction("text", "input text '$encoded'")
    }

    fun closeApprovedApp(context: Context, packageName: String): Boolean {
        if (!canAct(context) ||
            !isValidPackageName(packageName) ||
            !ApprovedApps.isApproved(context, packageName) ||
            ApprovedApps.isTechnical(context, packageName)
        ) {
            recordAudit("close-app", false)
            return false
        }
        return runTypedAction("close-app", "am force-stop --user 0 $packageName")
    }

    @Synchronized
    fun auditJson(): JSONArray {
        val result = JSONArray()
        auditEvents.forEach { event ->
            result.put(JSONObject().apply {
                put("timestamp", event.timestamp)
                put("action", event.action)
                put("success", event.success)
            })
        }
        return result
    }

    internal fun isValidText(text: String): Boolean =
        text.length in 1..120 && text.matches(SAFE_TEXT)

    internal fun isValidPackageName(packageName: String): Boolean =
        packageName.length in 3..255 && packageName.matches(SAFE_PACKAGE)

    private fun canAct(context: Context): Boolean =
        isEnabled(context) && consumeRate(actionTimes, MAX_ACTIONS_PER_MINUTE)

    @Synchronized
    private fun consumeRate(queue: ArrayDeque<Long>, limit: Int): Boolean {
        val now = System.currentTimeMillis()
        while (queue.isNotEmpty() && now - queue.first() >= 60_000L) {
            queue.removeFirst()
        }
        if (queue.size >= limit) return false
        queue.addLast(now)
        return true
    }

    private fun validPoint(context: Context, x: Int, y: Int): Boolean {
        val (width, height) = screenDimensions(context)
        return x in 0 until width && y in 0 until height
    }

    private fun screenDimensions(context: Context): Pair<Int, Int> {
        return try {
            val window = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            @Suppress("DEPRECATION")
            val metrics = android.util.DisplayMetrics().also {
                window.defaultDisplay.getRealMetrics(it)
            }
            Pair(metrics.widthPixels.coerceAtLeast(1), metrics.heightPixels.coerceAtLeast(1))
        } catch (_: Exception) {
            Pair(1, 1)
        }
    }

    private fun runTypedAction(action: String, command: String): Boolean {
        val su = RootCommand.suBinary() ?: return false.also { recordAudit(action, false) }
        val success = try {
            val process = ProcessBuilder(su, "-c", command)
                .redirectErrorStream(true)
                .start()
            val finished = process.waitFor(5, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                false
            } else {
                process.exitValue() == 0
            }
        } catch (_: Exception) {
            false
        }
        recordAudit(action, success)
        return success
    }

    private fun runForBytes(command: String, maxBytes: Int, timeoutSeconds: Long): ByteArray? {
        val su = RootCommand.suBinary() ?: return null
        return try {
            val process = ProcessBuilder(su, "-c", command)
                .redirectErrorStream(false)
                .start()
            val output = ByteArrayOutputStream()
            val tooLarge = AtomicBoolean(false)
            val outputReader = Thread({
                val buffer = ByteArray(16 * 1024)
                try {
                    while (true) {
                        val count = process.inputStream.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > maxBytes) {
                            tooLarge.set(true)
                            process.destroyForcibly()
                            break
                        }
                        output.write(buffer, 0, count)
                    }
                } catch (_: Exception) {
                }
            }, "roshan-remote-screenshot").apply {
                isDaemon = true
                start()
            }
            val errorReader = Thread({
                try {
                    process.errorStream.use { error ->
                        val buffer = ByteArray(4 * 1024)
                        while (error.read(buffer) >= 0) {
                            // Drain without retaining potentially sensitive command output.
                        }
                    }
                } catch (_: Exception) {
                }
            }, "roshan-remote-screenshot-error").apply {
                isDaemon = true
                start()
            }

            val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
            }
            outputReader.join(1_000)
            errorReader.join(1_000)
            if (!finished || tooLarge.get() || process.exitValue() != 0) null
            else output.toByteArray()
        } catch (_: Exception) {
            null
        }
    }

    @Synchronized
    private fun recordAudit(action: String, success: Boolean) {
        auditEvents.addLast(AuditEvent(System.currentTimeMillis(), action, success))
        while (auditEvents.size > MAX_AUDIT_EVENTS) {
            auditEvents.removeFirst()
        }
    }
}
