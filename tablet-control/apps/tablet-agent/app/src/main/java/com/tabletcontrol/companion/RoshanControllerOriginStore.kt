package com.tabletcontrol.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Owner-provisioned controller origin pin.
 *
 * The origin is not a credential, but is encrypted anyway so a writable prefs
 * backup cannot silently redirect the Authorization header to another host.
 * SharedPreferences remain private to the RoshanCore UID.
 */
object RoshanControllerOriginStore {
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val KEY_ALIAS = "RoshanOS_Update_Controller_Origin"
    private const val PREFS = "roshanos_update_controller_origin"
    private const val KEY_CIPHERTEXT = "origin_ciphertext"
    private const val KEY_IV = "origin_iv"
    private const val AES_GCM_TAG_LENGTH = 128
    private val ASSOCIATED_DATA =
        "com.tabletcontrol.companion:update-controller-origin:v1"
            .toByteArray(Charsets.UTF_8)

    data class Metadata(
        val configured: Boolean,
        val host: String?,
        val state: String
    )

    @Synchronized
    fun provision(context: Context, rawOrigin: String): Boolean {
        val validated = RoshanUpdatePolicy.validateControllerOrigin(rawOrigin).value
            ?: return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            cipher.updateAAD(ASSOCIATED_DATA)
            val ciphertext = cipher.doFinal(
                validated.canonicalOrigin.toByteArray(Charsets.UTF_8)
            )
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(
                    KEY_CIPHERTEXT,
                    Base64.encodeToString(ciphertext, Base64.NO_WRAP)
                )
                .putString(
                    KEY_IV,
                    Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
                )
                .commit()
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun get(context: Context): RoshanUpdatePolicy.ValidatedOrigin? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ciphertext = prefs.getString(KEY_CIPHERTEXT, null) ?: return null
        val iv = prefs.getString(KEY_IV, null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(
                    AES_GCM_TAG_LENGTH,
                    Base64.decode(iv, Base64.NO_WRAP)
                )
            )
            cipher.updateAAD(ASSOCIATED_DATA)
            val plaintext = String(
                cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)),
                Charsets.UTF_8
            )
            RoshanUpdatePolicy.validateControllerOrigin(plaintext).value
        } catch (_: Exception) {
            null
        }
    }

    fun metadata(context: Context): Metadata {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val hasCiphertext = prefs.contains(KEY_CIPHERTEXT)
        val hasIv = prefs.contains(KEY_IV)
        if (!hasCiphertext && !hasIv) {
            return Metadata(configured = false, host = null, state = "unconfigured")
        }
        val origin = get(context)
        return if (origin == null) {
            Metadata(configured = false, host = null, state = "corrupt")
        } else {
            Metadata(configured = true, host = origin.host, state = "ready")
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }
}
