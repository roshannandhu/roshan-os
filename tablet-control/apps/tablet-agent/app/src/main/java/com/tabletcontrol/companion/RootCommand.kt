package com.tabletcontrol.companion

import android.util.Log
import java.util.concurrent.TimeUnit

object RootCommand {
    private const val TAG = "CompanionRoot"
    private const val FIXED_QUERY_TIMEOUT_SECONDS = 3L
    private const val MAX_FIXED_QUERY_CHARS = 8 * 1024

    private val SU_CANDIDATES = arrayOf(
        "/sbin/su",
        "/system/xbin/su",
        "/system/bin/su",
        "su"
    )

    @Volatile
    private var resolvedSu: String? = null

    @Volatile
    private var suResolved = false

    /**
     * Resolves a working privileged binary once and caches it. Tries the
     * absolute Magisk paths first because app-process PATH does not always
     * include /sbin, then falls back to a bare `su` lookup. Never prompts:
     * the companion UID must already be allow-listed in the root manager.
     */
    fun suBinary(): String? {
        if (suResolved) return resolvedSu
        synchronized(this) {
            if (suResolved) return resolvedSu
            var found: String? = null
            for (candidate in SU_CANDIDATES) {
                if (candidate.startsWith("/")) {
                    val file = java.io.File(candidate)
                    if (!file.exists() || !file.canExecute()) continue
                }
                if (candidateOk(candidate)) {
                    found = candidate
                    break
                }
            }
            resolvedSu = found
            suResolved = true
            if (found == null) {
                Log.e(TAG, "No working su binary found on this device.")
            } else {
                Log.i(TAG, "Resolved privileged binary: $found")
            }
            return found
        }
    }

    fun exec(cmd: String): Boolean {
        val su = suBinary() ?: return false
        return try {
            val process = Runtime.getRuntime().exec(arrayOf(su, "-c", cmd))
            val exitCode = process.waitFor()
            if (exitCode != 0) {
                Log.w(TAG, "Root command exited $exitCode: $cmd")
            }
            exitCode == 0
        } catch (e: Exception) {
            Log.e(TAG, "Root command failed: $cmd", e)
            false
        }
    }

    private fun candidateOk(candidate: String): Boolean {
        return try {
            val process = ProcessBuilder(candidate, "-c", "true")
                .redirectErrorStream(true)
                .start()
            val finished = process.waitFor(2, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                false
            } else {
                process.exitValue() == 0
            }
        } catch (_: Exception) {
            false
        }
    }

    fun setBrightness(value: Int): Boolean {
        require(value in 0..255) { "Brightness must be 0–255" }
        return exec("settings put system screen_brightness $value")
    }

    fun setBrightnessMode(mode: String): Boolean {
        require(DeviceControlPolicy.isValidBrightnessMode(mode))
        val androidMode = if (mode == "automatic") 1 else 0
        return exec("settings put system screen_brightness_mode $androidMode")
    }

    fun setScreenTimeoutSeconds(seconds: Int): Boolean {
        require(DeviceControlPolicy.isValidScreenTimeoutSeconds(seconds))
        return exec("settings put system screen_off_timeout ${seconds * 1000L}")
    }

    fun setScreenOrientation(orientation: String): Boolean {
        val rotation = when (orientation) {
            "portrait" -> 0
            "landscape" -> 1
            "reverse-portrait" -> 2
            "reverse-landscape" -> 3
            "auto" -> null
            else -> throw IllegalArgumentException("Unsupported screen orientation.")
        }
        return if (rotation == null) {
            exec("settings put system accelerometer_rotation 1")
        } else {
            exec(
                "settings put system accelerometer_rotation 0 && " +
                    "settings put system user_rotation $rotation"
            )
        }
    }

    fun wakeScreen(): Boolean = exec("input keyevent KEYCODE_WAKEUP")

    fun sleepScreen(): Boolean = exec("input keyevent KEYCODE_SLEEP")

    fun rebootDevice(): Boolean = exec("svc power reboot || reboot")

    fun shutdownDevice(): Boolean = exec("svc power shutdown || reboot -p")

    fun isRootAvailable(): Boolean =
        fixedOutput("id -u")?.trim() == "0"

    /**
     * Fixed, read-only activity query. No caller data enters the command.
     */
    fun currentForegroundPackage(): String? {
        val output = fixedOutput(
            "dumpsys activity activities | " +
                "grep -m 1 -E 'topResumedActivity|mResumedActivity|mFocusedApp|mCurrentFocus'"
        ) ?: return null
        return DeviceControlPolicy.parseForegroundPackage(output)
    }

    fun bringKioskToForeground(): Boolean =
        exec(
            "am start --user 0 -n " +
                "com.tabletcontrol.companion/.KioskActivity >/dev/null 2>&1"
        )

    private fun fixedOutput(command: String): String? {
        val su = suBinary() ?: return null
        var process: Process? = null
        return try {
            process = ProcessBuilder(su, "-c", command)
                .redirectErrorStream(true)
                .start()
            if (!process.waitFor(FIXED_QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroy()
                if (process.isAlive) process.destroyForcibly()
                return null
            }
            if (process.exitValue() != 0) return null
            process.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val output = CharArray(MAX_FIXED_QUERY_CHARS + 1)
                val count = reader.read(output)
                if (count < 0 || count > MAX_FIXED_QUERY_CHARS) null
                else String(output, 0, count)
            }
        } catch (_: Exception) {
            null
        } finally {
            try {
                process?.inputStream?.close()
            } catch (_: Exception) {
            }
            try {
                process?.errorStream?.close()
            } catch (_: Exception) {
            }
            try {
                process?.outputStream?.close()
            } catch (_: Exception) {
            }
        }
    }
}
