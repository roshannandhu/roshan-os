package com.tabletcontrol.companion

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * PBKDF2-HMAC-SHA256 Administrator PIN Manager for RoshanOS.
 *
 * Requirements & Behavior:
 * - NO DEFAULT / RECOVERY PIN EXITS IN THE APPLICATION.
 * - Initial state is PIN_NOT_CONFIGURED.
 * - Initial PIN setup requires physical interaction inside KioskActivity admin.
 * - Uses PBKDF2-HMAC-SHA256 with 50,000 iterations (~200ms delay on MT6761) and a 16-byte random salt.
 * - Enforces durable escalating cooldowns after each five failed attempts.
 * - After five cooldown cycles, local verification requires an authenticated
 *   owner rate-limit reset, ADB recovery during development, or factory reset.
 * - Process restart maintains cooldown/recovery-lock state.
 */
object AdminPinStore {
    private const val TAG = "AdminPinStore"
    private const val PREFS_NAME = "roshanos_admin_pin_prefs"

    private const val KEY_PIN_SALT = "admin_pin_salt"
    private const val KEY_PIN_HASH = "admin_pin_hash"
    private const val KEY_ITERATIONS = "admin_pin_iterations"
    private const val KEY_FAILED_ATTEMPTS = "admin_pin_failed_attempts"
    private const val KEY_COOLDOWN_UNTIL = "admin_pin_cooldown_until"
    private const val KEY_COOLDOWN_CYCLES = "admin_pin_cooldown_cycles"
    private const val KEY_RECOVERY_LOCKED = "admin_pin_recovery_locked"

    private const val PBKDF2_ALGORITHM = "PBKDF2WithHmacSHA256"
    private const val BENCHMARKED_ITERATIONS = 50_000 // Measured ~180-220ms delay on MediaTek MT6761
    private const val KEY_LENGTH_BITS = 256
    private const val MAX_FAILED_ATTEMPTS = 5
    private const val MAX_COOLDOWN_CYCLES = 5
    private const val BASE_COOLDOWN_DURATION_MS = 60_000L
    private const val MAX_COOLDOWN_DURATION_MS = 60 * 60 * 1000L

    enum class State {
        PIN_NOT_CONFIGURED,
        READY,
        COOLDOWN,
        LOCKED_RECOVERY_REQUIRED
    }

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Gets the current PIN state.
     */
    fun getState(context: Context): State {
        val prefs = getPrefs(context)
        val now = System.currentTimeMillis()
        if (prefs.getBoolean(KEY_RECOVERY_LOCKED, false)) {
            return State.LOCKED_RECOVERY_REQUIRED
        }
        val cooldownUntil = prefs.getLong(KEY_COOLDOWN_UNTIL, 0L)

        if (now < cooldownUntil) {
            return State.COOLDOWN
        }

        val storedHash = prefs.getString(KEY_PIN_HASH, null)
        val storedSalt = prefs.getString(KEY_PIN_SALT, null)

        return if (storedHash.isNullOrBlank() || storedSalt.isNullOrBlank()) {
            State.PIN_NOT_CONFIGURED
        } else {
            State.READY
        }
    }

    /**
     * Configures or rotates the administrator PIN using PBKDF2-HMAC-SHA256.
     * MUST be called via physical interaction inside local administration.
     */
    @Synchronized
    fun setPin(context: Context, newPin: String): Boolean {
        if (!newPin.matches(Regex("\\d{6,12}"))) {
            Log.w(TAG, "Refusing PIN setup: PIN must contain 6 to 12 digits.")
            return false
        }

        val saltBytes = ByteArray(16).apply { SecureRandom().nextBytes(this) }
        val hashBytes = pbkdf2(newPin, saltBytes, BENCHMARKED_ITERATIONS)

        val saltB64 = Base64.encodeToString(saltBytes, Base64.NO_WRAP)
        val hashB64 = Base64.encodeToString(hashBytes, Base64.NO_WRAP)

        getPrefs(context).edit()
            .putString(KEY_PIN_SALT, saltB64)
            .putString(KEY_PIN_HASH, hashB64)
            .putInt(KEY_ITERATIONS, BENCHMARKED_ITERATIONS)
            .putInt(KEY_FAILED_ATTEMPTS, 0)
            .putLong(KEY_COOLDOWN_UNTIL, 0L)
            .putInt(KEY_COOLDOWN_CYCLES, 0)
            .putBoolean(KEY_RECOVERY_LOCKED, false)
            .apply()

        Log.i(TAG, "Administrator PIN configured successfully via PBKDF2-HMAC-SHA256 (50k iters).")
        return true
    }

    /**
     * Verifies an entered PIN against the stored PBKDF2 hash.
     * Returns Unconfigured if no PIN has been set yet. Fails closed.
     */
    @Synchronized
    fun verifyPin(context: Context, enteredPin: String): PinVerificationResult {
        val currentState = getState(context)
        val prefs = getPrefs(context)
        val now = System.currentTimeMillis()

        if (currentState == State.COOLDOWN) {
            val cooldownUntil = prefs.getLong(KEY_COOLDOWN_UNTIL, 0L)
            val remainingSec = ((cooldownUntil - now) / 1000L).coerceAtLeast(1)
            Log.w(TAG, "PIN check blocked: Cooldown active ($remainingSec seconds remaining).")
            return PinVerificationResult.Cooldown(remainingSec)
        }

        if (currentState == State.LOCKED_RECOVERY_REQUIRED) {
            Log.w(TAG, "PIN check blocked: Protected owner recovery is required.")
            return PinVerificationResult.RecoveryLocked
        }

        if (currentState == State.PIN_NOT_CONFIGURED) {
            Log.w(TAG, "PIN check rejected: Administrator PIN is not configured.")
            return PinVerificationResult.Unconfigured
        }

        val saltB64 = prefs.getString(KEY_PIN_SALT, null) ?: return PinVerificationResult.Failed(0)
        val hashB64 = prefs.getString(KEY_PIN_HASH, null) ?: return PinVerificationResult.Failed(0)
        val iterations = prefs.getInt(KEY_ITERATIONS, BENCHMARKED_ITERATIONS)

        val saltBytes = Base64.decode(saltB64, Base64.NO_WRAP)
        val storedHashBytes = Base64.decode(hashB64, Base64.NO_WRAP)
        val computedHashBytes = pbkdf2(enteredPin, saltBytes, iterations)

        val isMatch = MessageDigest.isEqual(computedHashBytes, storedHashBytes)

        return if (isMatch) {
            prefs.edit()
                .putInt(KEY_FAILED_ATTEMPTS, 0)
                .putLong(KEY_COOLDOWN_UNTIL, 0L)
                .putInt(KEY_COOLDOWN_CYCLES, 0)
                .putBoolean(KEY_RECOVERY_LOCKED, false)
                .apply()
            PinVerificationResult.Success
        } else {
            val failedAttempts = prefs.getInt(KEY_FAILED_ATTEMPTS, 0) + 1
            if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
                val cooldownCycles = prefs.getInt(KEY_COOLDOWN_CYCLES, 0) + 1
                if (cooldownCycles >= MAX_COOLDOWN_CYCLES) {
                    prefs.edit()
                        .putInt(KEY_FAILED_ATTEMPTS, 0)
                        .putLong(KEY_COOLDOWN_UNTIL, 0L)
                        .putInt(KEY_COOLDOWN_CYCLES, cooldownCycles)
                        .putBoolean(KEY_RECOVERY_LOCKED, true)
                        .apply()
                    Log.w(TAG, "PIN verification locked after repeated cooldown cycles.")
                    PinVerificationResult.RecoveryLocked
                } else {
                    val multiplier = 1L shl (cooldownCycles - 1)
                    val durationMs =
                        (BASE_COOLDOWN_DURATION_MS * multiplier)
                            .coerceAtMost(MAX_COOLDOWN_DURATION_MS)
                    val newCooldown = now + durationMs
                    prefs.edit()
                        .putInt(KEY_FAILED_ATTEMPTS, 0)
                        .putLong(KEY_COOLDOWN_UNTIL, newCooldown)
                        .putInt(KEY_COOLDOWN_CYCLES, cooldownCycles)
                        .apply()
                    val seconds = durationMs / 1_000L
                    Log.w(
                        TAG,
                        "Max PIN attempts exceeded. Cooldown cycle $cooldownCycles activated."
                    )
                    PinVerificationResult.Cooldown(seconds)
                }
            } else {
                prefs.edit().putInt(KEY_FAILED_ATTEMPTS, failedAttempts).apply()
                val remainingAttempts = MAX_FAILED_ATTEMPTS - failedAttempts
                Log.w(TAG, "Invalid PIN attempt ($failedAttempts/$MAX_FAILED_ATTEMPTS).")
                PinVerificationResult.Failed(remainingAttempts)
            }
        }
    }

    /**
     * Resets/erases configured PIN (simulating factory reset).
     */
    @Synchronized
    fun resetPin(context: Context) {
        getPrefs(context).edit().clear().apply()
        Log.i(TAG, "Administrator PIN preferences cleared.")
    }

    /**
     * Clears only brute-force counters. It neither reveals nor changes the PIN
     * and is called solely after Companion bearer authentication.
     */
    @Synchronized
    fun resetRateLimitAfterAuthenticatedOwner(context: Context) {
        getPrefs(context).edit()
            .putInt(KEY_FAILED_ATTEMPTS, 0)
            .putLong(KEY_COOLDOWN_UNTIL, 0L)
            .putInt(KEY_COOLDOWN_CYCLES, 0)
            .putBoolean(KEY_RECOVERY_LOCKED, false)
            .apply()
        Log.i(TAG, "Owner PIN rate-limit state reset by authenticated owner.")
    }

    private fun pbkdf2(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, KEY_LENGTH_BITS)
        val factory = SecretKeyFactory.getInstance(PBKDF2_ALGORITHM)
        return factory.generateSecret(spec).encoded
    }

    sealed class PinVerificationResult {
        object Success : PinVerificationResult()
        object Unconfigured : PinVerificationResult()
        data class Failed(val attemptsRemaining: Int) : PinVerificationResult()
        data class Cooldown(val secondsRemaining: Long) : PinVerificationResult()
        object RecoveryLocked : PinVerificationResult()
    }
}
