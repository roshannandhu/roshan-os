package com.tabletcontrol.companion

import android.content.Context
import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * One-shot ADB credential provisioning for RoshanOS tablet.
 *
 * During installation, the provision-tablet-via-adb.ps1 script writes a new
 * controller credential into the app-private file named [FILE_NAME] via
 * `adb shell su -c`, then chowns it to the app UID. RoshanCore validates
 * ownership, permissions, file type, size, UTF-8, and credential format,
 * deletes the plaintext file, and only then stores the credential in the
 * Android Keystore via [CredentialStore.provisionCredential].
 *
 * Release/system APKs use this as their primary provisioning path — the old
 * FLAG_DEBUGGABLE-only restriction is removed because ownership and
 * permissions validation are sufficient for a rooted device where `su`
 * writes the file on behalf of the ADB-connected PC.
 */
object AdbCredentialRecovery {
    private const val TAG = "AdbCredentialRecovery"
    internal const val FILE_NAME = ".adb-credential-rotation"
    internal const val MAX_SECRET_BYTES = 256
    private const val GROUP_OR_OTHER_PERMISSION_BITS = 0x3f

    enum class Result {
        ABSENT,
        APPLIED,
        REFUSED
    }

    fun applyIfPresent(context: Context): Result {
        val target = File(context.filesDir, FILE_NAME)
        if (!target.exists()) return Result.ABSENT

        val candidate = try {
            validatePrivateFile(target)
            parsePayload(readBounded(target))
                ?: return refuseAndDelete(target, "invalid_payload")
        } catch (_: Exception) {
            return refuseAndDelete(target, "unreadable_file")
        }

        // Delete before provisioning so no plaintext remains if Keystore
        // provisioning throws or the process is killed immediately afterward.
        if (!target.delete()) {
            Log.w(TAG, "ADB credential recovery refused: cleanup_failed")
            return Result.REFUSED
        }

        return try {
            if (CredentialStore.provisionCredential(context, candidate)) {
                Log.i(TAG, "ADB credential recovery applied from owner-only stdin handoff.")
                Result.APPLIED
            } else {
                Log.w(TAG, "ADB credential recovery refused: provisioning_failed")
                Result.REFUSED
            }
        } catch (_: Exception) {
            Log.e(TAG, "ADB credential recovery refused: keystore_failure")
            Result.REFUSED
        }
    }

    private fun validatePrivateFile(target: File) {
        val expectedParent = target.parentFile?.canonicalFile
            ?: throw IllegalStateException("missing parent")
        if (expectedParent != target.canonicalFile.parentFile) {
            throw IllegalStateException("path escaped private files directory")
        }

        val stat = Os.lstat(target.absolutePath)
        if ((stat.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG) {
            throw IllegalStateException("not a regular file")
        }
        if (stat.st_uid != Process.myUid()) {
            throw IllegalStateException("wrong owner")
        }
        if (stat.st_mode and GROUP_OR_OTHER_PERMISSION_BITS != 0) {
            throw IllegalStateException("permissions are not owner-only")
        }
        if (stat.st_size <= 0L || stat.st_size > MAX_SECRET_BYTES + 2L) {
            throw IllegalStateException("invalid size")
        }
    }

    private fun readBounded(target: File): ByteArray {
        FileInputStream(target).use { input ->
            val output = ByteArray(MAX_SECRET_BYTES + 3)
            var total = 0
            while (total < output.size) {
                val count = input.read(output, total, output.size - total)
                if (count < 0) break
                total += count
            }
            if (total > MAX_SECRET_BYTES + 2) {
                throw IllegalStateException("payload too large")
            }
            return output.copyOf(total)
        }
    }

    internal fun parsePayload(raw: ByteArray): String? {
        if (raw.isEmpty() || raw.size > MAX_SECRET_BYTES + 2) return null
        val decoded = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(raw))
                .toString()
        } catch (_: Exception) {
            return null
        }
        val candidate = when {
            decoded.endsWith("\r\n") -> decoded.dropLast(2)
            decoded.endsWith("\n") -> decoded.dropLast(1)
            else -> decoded
        }
        if (candidate.any { it == '\r' || it == '\n' }) return null
        return candidate.takeIf(CredentialStore::isValidProvisioningSecret)
    }

    private fun refuseAndDelete(target: File, reason: String): Result {
        if (!target.delete()) {
            Log.e(TAG, "ADB credential recovery refused: $reason; cleanup_failed")
        } else {
            Log.w(TAG, "ADB credential recovery refused: $reason")
        }
        return Result.REFUSED
    }
}
