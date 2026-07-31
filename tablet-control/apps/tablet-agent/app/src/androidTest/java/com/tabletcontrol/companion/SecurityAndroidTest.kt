package com.tabletcontrol.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecurityAndroidTest {

    /**
     * Always use the instrumentation APK's isolated context/UID. Using
     * targetContext here would mutate the enrolled RoshanCore application's
     * real preferences and Android Keystore namespace.
     */
    private val context get() = InstrumentationRegistry.getInstrumentation().context

    @Before
    fun setUp() {
        assertTrue(
            "Security instrumentation must run in the isolated test package.",
            context.packageName.endsWith(".test")
        )
        AdminPinStore.resetPin(context)
        context.getSharedPreferences("roshanos_keystore_credentials", 0).edit().clear().commit()
    }

    @Test
    fun testAndroidKeyStoreKeyCreationAndCredentialStore() {
        val testSecret = "device-specific-test-secret-256bit-length"
        val provisionSuccess = CredentialStore.provisionCredential(context, testSecret)
        assertTrue("Credential provisioning must succeed", provisionSuccess)
        assertTrue("Device must report ENROLLED", CredentialStore.isEnrolled(context))

        val retrievedSecret = CredentialStore.getSecret(context)
        assertNotNull("Retrieved secret must not be null", retrievedSecret)
        assertEquals("Retrieved secret must match provisioned value", testSecret, retrievedSecret)
    }

    @Test
    fun testUnauthenticatedRequestFailsClosedWhenUnenrolled() {
        // Reset prefs to simulate unenrolled state
        context.getSharedPreferences("roshanos_keystore_credentials", 0).edit().clear().commit()

        assertFalse("Device must report UNENROLLED", CredentialStore.isEnrolled(context))
        val result = CredentialStore.validateHeader(context, "Bearer some-token")
        assertFalse("Header validation must fail closed when UNENROLLED", result.valid)
        assertTrue("Error message must mention UNENROLLED", result.errorMessage.contains("UNENROLLED"))
    }

    @Test
    fun testAdminPinStoreFirstRunOnboardingAndCooldown() {
        assertEquals("Initial state must be PIN_NOT_CONFIGURED", AdminPinStore.State.PIN_NOT_CONFIGURED, AdminPinStore.getState(context))

        val checkUnconfigured = AdminPinStore.verifyPin(context, "123456")
        assertTrue("Unconfigured verification must return Unconfigured", checkUnconfigured is AdminPinStore.PinVerificationResult.Unconfigured)

        val setSuccess = AdminPinStore.setPin(context, "123456")
        assertTrue("Setting initial PIN must succeed", setSuccess)
        assertEquals("State after setup must be READY", AdminPinStore.State.READY, AdminPinStore.getState(context))

        val checkValid = AdminPinStore.verifyPin(context, "123456")
        assertTrue("Correct PIN verification must return Success", checkValid is AdminPinStore.PinVerificationResult.Success)

        // Test 5 consecutive failures triggering Cooldown
        for (i in 1..4) {
            val res = AdminPinStore.verifyPin(context, "000000")
            assertTrue("Failed attempt $i must return Failed", res is AdminPinStore.PinVerificationResult.Failed)
        }
        val fifthFailure = AdminPinStore.verifyPin(context, "000000")
        assertTrue("5th failed attempt must trigger Cooldown", fifthFailure is AdminPinStore.PinVerificationResult.Cooldown)
        assertEquals("State during cooldown must be COOLDOWN", AdminPinStore.State.COOLDOWN, AdminPinStore.getState(context))
    }

    @Test
    fun testOnDevicePbkdf2BenchmarkOnPhysicalHardware() {
        val pin = "484627"
        val salt = "1234567890123456".toByteArray(Charsets.UTF_8)
        val iterations = 50_000

        val samples = LongArray(20)

        // Warmup run
        val specWarm = javax.crypto.spec.PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
        val factoryWarm = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        factoryWarm.generateSecret(specWarm).encoded

        for (i in 0 until 20) {
            val t0 = System.nanoTime()
            val spec = javax.crypto.spec.PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
            val factory = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            factory.generateSecret(spec).encoded
            val dtMs = (System.nanoTime() - t0) / 1_000_000L
            samples[i] = dtMs
        }

        samples.sort()
        val minMs = samples[0]
        val medianMs = samples[10]
        val p95Ms = samples[18]
        val maxMs = samples[19]

        android.util.Log.i("PBKDF2Benchmark", "=== PHYSICAL TABLET PBKDF2 BENCHMARK ===")
        android.util.Log.i("PBKDF2Benchmark", "Device: ${android.os.Build.MODEL} (${android.os.Build.BOARD})")
        android.util.Log.i("PBKDF2Benchmark", "Iterations: $iterations")
        android.util.Log.i("PBKDF2Benchmark", "Min: ${minMs}ms, Median: ${medianMs}ms, P95: ${p95Ms}ms, Max: ${maxMs}ms")

        assertTrue("Median delay must be interactive (>50ms)", medianMs > 50)
    }
}
