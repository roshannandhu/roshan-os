package com.tabletcontrol.companion

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore-Backed Secure Credential Storage for RoshanOS.
 *
 * Encrypts runtime companion credentials using an AES-GCM key bound
 * to the Android System Keystore. Zero plaintext secrets are compiled into
 * or persisted unencrypted within the application.
 */
object CredentialStore {
    private const val TAG = "CredentialStore"
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val KEY_ALIAS = "RoshanOS_Master_Key"
    private const val PREFS_NAME = "roshanos_keystore_credentials"

    private const val KEY_ENCRYPTED_SECRET = "enc_companion_secret"
    private const val KEY_SECRET_IV = "enc_companion_iv"
    private const val KEY_CREDENTIAL_VERSION = "credential_version"
    private const val KEY_ROTATED_AT = "credential_rotated_at"

    private const val BEARER_PREFIX = "Bearer "
    private const val MAX_HEADER_LENGTH = 1024
    private const val AES_GCM_TAG_LENGTH = 128
    private const val MIN_PROVISIONING_SECRET_LENGTH = 43
    private const val MAX_PROVISIONING_SECRET_LENGTH = 256
    private const val MIN_LEGACY_SECRET_LENGTH = 16
    private const val MAX_LEGACY_SECRET_LENGTH = 1024
    private val BASE64_URL_SECRET = Regex("^[A-Za-z0-9_-]+$")

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Gets or generates the Keystore AES-GCM master key.
     */
    private fun getOrCreateMasterKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existingKey = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existingKey != null) {
            return existingKey
        }

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER
        )
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()

        keyGenerator.init(spec)
        val newKey = keyGenerator.generateKey()
        Log.i(TAG, "Generated new Android Keystore AES-256 GCM Master Key.")
        return newKey
    }

    private fun encrypt(plaintext: String): Pair<String, String> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateMasterKey())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Pair(
            Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            Base64.encodeToString(iv, Base64.NO_WRAP)
        )
    }

    private fun decrypt(ciphertextB64: String, ivB64: String): String? {
        return try {
            val ciphertext = Base64.decode(ciphertextB64, Base64.NO_WRAP)
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val spec = GCMParameterSpec(AES_GCM_TAG_LENGTH, iv)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateMasterKey(), spec)
            val plaintextBytes = cipher.doFinal(ciphertext)
            String(plaintextBytes, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Keystore decryption failed: ${e.message}")
            null
        }
    }

    /**
     * Checks if the device is provisioned with a Companion credential.
     */
    fun isEnrolled(context: Context): Boolean {
        return when (credentialState(context)) {
            CredentialState.READY,
            CredentialState.LEGACY_READY -> true
            CredentialState.UNENROLLED,
            CredentialState.CORRUPT -> false
        }
    }

    /**
     * Distinguishes a clean first-run state from invalidated/corrupt Keystore
     * data. A corrupt credential deliberately returns unenrolled so protected
     * local setup can re-pair instead of leaving RoshanCore permanently stuck.
     *
     * LEGACY_READY preserves already-enrolled field devices long enough for
     * the owner to rotate them. New provisioning always requires a 256-bit-or-
     * stronger base64url token.
     */
    @Synchronized
    fun credentialState(context: Context): CredentialState {
        val prefs = getPrefs(context)
        val encSecret = prefs.getString(KEY_ENCRYPTED_SECRET, null)
        val iv = prefs.getString(KEY_SECRET_IV, null)
        if (encSecret.isNullOrBlank() && iv.isNullOrBlank()) {
            return CredentialState.UNENROLLED
        }
        if (encSecret.isNullOrBlank() || iv.isNullOrBlank()) {
            return CredentialState.CORRUPT
        }
        val secret = decrypt(encSecret, iv) ?: return CredentialState.CORRUPT
        return when {
            isValidProvisioningSecret(secret) -> CredentialState.READY
            isValidLegacySecret(secret) -> CredentialState.LEGACY_READY
            else -> CredentialState.CORRUPT
        }
    }

    /**
     * Gets the decrypted Companion secret for internal loopback clients.
     * Returns null if UNENROLLED.
     */
    @Synchronized
    fun getSecret(context: Context): String? {
        val prefs = getPrefs(context)
        val encSecret = prefs.getString(KEY_ENCRYPTED_SECRET, null) ?: return null
        val iv = prefs.getString(KEY_SECRET_IV, null) ?: return null
        val secret = decrypt(encSecret, iv) ?: return null
        return secret.takeIf {
            isValidProvisioningSecret(it) || isValidLegacySecret(it)
        }
    }

    /**
     * Provisions or rotates the Companion credential using Keystore AES-GCM.
     */
    @Synchronized
    fun provisionCredential(context: Context, newSecret: String): Boolean {
        if (!isValidProvisioningSecret(newSecret)) {
            Log.w(TAG, "Refusing credential provisioning: Secret format is invalid.")
            return false
        }
        val (encSecret, iv) = encrypt(newSecret)
        val currentVersion = getPrefs(context).getInt(KEY_CREDENTIAL_VERSION, 0)
        getPrefs(context).edit()
            .putString(KEY_ENCRYPTED_SECRET, encSecret)
            .putString(KEY_SECRET_IV, iv)
            .putInt(KEY_CREDENTIAL_VERSION, currentVersion + 1)
            .putLong(KEY_ROTATED_AT, System.currentTimeMillis())
            .apply()
        Log.i(TAG, "Provisioned encrypted Companion credential (v${currentVersion + 1}).")
        return true
    }

    /**
     * Validates an incoming HTTP Authorization header against the Keystore credential.
     */
    fun validateHeader(context: Context, authorizationHeader: String?): ValidationResult {
        when (credentialState(context)) {
            CredentialState.UNENROLLED ->
                return ValidationResult.invalid("UNENROLLED: No credential provisioned on device.")
            CredentialState.CORRUPT ->
                return ValidationResult.invalid("CREDENTIAL_CORRUPT: Protected re-pairing is required.")
            CredentialState.READY,
            CredentialState.LEGACY_READY -> Unit
        }
        if (authorizationHeader == null) {
            return ValidationResult.invalid("Missing Authorization header.")
        }
        if (authorizationHeader.length > MAX_HEADER_LENGTH) {
            return ValidationResult.invalid("Authorization header is too long.")
        }
        if (!authorizationHeader.startsWith(BEARER_PREFIX)) {
            return ValidationResult.invalid("Authorization scheme must be Bearer.")
        }

        val providedSecret = authorizationHeader.substring(BEARER_PREFIX.length).trim()
        if (providedSecret.isEmpty()) {
            return ValidationResult.invalid("Bearer token is empty.")
        }

        val expectedSecret = getSecret(context) ?: return ValidationResult.invalid("Failed to decrypt stored credential.")
        val providedHash = hashSha256(providedSecret)
        val expectedHash = hashSha256(expectedSecret)

        return if (MessageDigest.isEqual(providedHash, expectedHash)) {
            ValidationResult.valid()
        } else {
            ValidationResult.invalid("Bearer token is invalid.")
        }
    }

    /**
     * Redacts Authorization headers from logs.
     */
    fun redactHeader(header: String?): String {
        if (header == null) return "[none]"
        return if (header.startsWith(BEARER_PREFIX)) "Bearer [REDACTED]" else "[REDACTED]"
    }

    /**
     * Returns public metadata summary for status endpoints.
     */
    fun getMetadata(context: Context): CredentialMetadata {
        val prefs = getPrefs(context)
        val state = credentialState(context)
        return CredentialMetadata(
            enrolled = state == CredentialState.READY ||
                state == CredentialState.LEGACY_READY,
            state = state.wireValue,
            credentialVersion = prefs.getInt(KEY_CREDENTIAL_VERSION, 0),
            lastRotatedAt = prefs.getLong(KEY_ROTATED_AT, 0L)
        )
    }

    /**
     * Controller-generated enrollment secrets are unpadded base64url and must
     * carry at least 256 bits of encoded material.
     */
    internal fun isValidProvisioningSecret(secret: String): Boolean =
        secret.length in MIN_PROVISIONING_SECRET_LENGTH..MAX_PROVISIONING_SECRET_LENGTH &&
            BASE64_URL_SECRET.matches(secret)

    private fun isValidLegacySecret(secret: String): Boolean =
        secret.length in MIN_LEGACY_SECRET_LENGTH..MAX_LEGACY_SECRET_LENGTH &&
            secret.none { it.code < 0x20 || it.code == 0x7f }

    private fun hashSha256(input: String): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
    }

    data class ValidationResult private constructor(
        val valid: Boolean,
        val errorMessage: String
    ) {
        companion object {
            fun valid() = ValidationResult(true, "")
            fun invalid(message: String) = ValidationResult(false, message)
        }
    }

    data class CredentialMetadata(
        val enrolled: Boolean,
        val state: String,
        val credentialVersion: Int,
        val lastRotatedAt: Long
    )

    enum class CredentialState(val wireValue: String) {
        UNENROLLED("unenrolled"),
        READY("ready"),
        LEGACY_READY("legacy_ready"),
        CORRUPT("credential_corrupt")
    }
}
