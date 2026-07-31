package com.tabletcontrol.companion

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.RestrictionEntry
import android.content.RestrictionsManager
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Applies one-off Tailscale enrollment through Android managed app
 * restrictions. The auth key exists only in the authenticated request and the
 * transient Tailscale application-restrictions Bundle. It is never written to
 * RoshanCore preferences, diagnostics, logs, or status responses.
 */
internal object TailscaleEnrollmentManager {
    data class ActionResult(
        val accepted: Boolean,
        val code: String
    )

    private data class PackageSnapshot(
        val installed: Boolean,
        val enabled: Boolean,
        val versionName: String?
    )

    private data class SupportedPolicies(
        val authKey: Boolean,
        val forceEnabled: Boolean,
        val onboardingFlow: Boolean
    )

    private const val POLL_INTERVAL_SECONDS = 2L
    private val operationGeneration = AtomicLong(0L)
    private val processReconciled = AtomicBoolean(false)
    private val worker: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "roshan-tailscale-enrollment").apply {
                isDaemon = true
            }
        }
    private val lock = Any()

    @Volatile
    private var activeGeneration = 0L

    @Volatile
    private var activeDeadlineElapsedMs = 0L

    fun requestEnrollment(
        context: Context,
        request: TailscaleEnrollmentPolicy.Request
    ): ActionResult = synchronized(lock) {
        val appContext = context.applicationContext
        if (activeGeneration != 0L) {
            return@synchronized ActionResult(false, "ENROLLMENT_IN_PROGRESS")
        }

        val dpm =
            appContext.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(appContext.packageName)) {
            saveRejected(appContext, request.timeoutSeconds, "DEVICE_OWNER_REQUIRED")
            return@synchronized ActionResult(false, "DEVICE_OWNER_REQUIRED")
        }

        val packageSnapshot = packageSnapshot(appContext)
        if (!packageSnapshot.installed) {
            saveRejected(appContext, request.timeoutSeconds, "TAILSCALE_NOT_INSTALLED")
            return@synchronized ActionResult(false, "TAILSCALE_NOT_INSTALLED")
        }
        if (!packageSnapshot.enabled) {
            saveRejected(appContext, request.timeoutSeconds, "TAILSCALE_DISABLED")
            return@synchronized ActionResult(false, "TAILSCALE_DISABLED")
        }
        when (transientAuthKeyPresence(appContext)) {
            true -> {
                if (!clearTransientAuthKey(appContext)) {
                    saveRejected(
                        appContext,
                        request.timeoutSeconds,
                        "ORPHANED_AUTH_KEY_CLEAR_FAILED"
                    )
                    return@synchronized ActionResult(
                        false,
                        "ORPHANED_AUTH_KEY_CLEAR_FAILED"
                    )
                }
            }
            null -> {
                saveRejected(
                    appContext,
                    request.timeoutSeconds,
                    "APPLICATION_RESTRICTIONS_STATE_UNKNOWN"
                )
                return@synchronized ActionResult(
                    false,
                    "APPLICATION_RESTRICTIONS_STATE_UNKNOWN"
                )
            }
            false -> Unit
        }

        val supported = supportedPolicies(appContext)
        if (!supported.authKey) {
            saveRejected(appContext, request.timeoutSeconds, "AUTH_KEY_POLICY_UNSUPPORTED")
            return@synchronized ActionResult(false, "AUTH_KEY_POLICY_UNSUPPORTED")
        }

        // An already-connected Tailnet session cannot prove that this request's
        // one-off key was consumed. Reject before placing the key in managed
        // restrictions; fresh/reset enrollment must begin disconnected.
        val initialProof = connectivityProof(appContext)
        if (initialProof.enrollmentConnectivitySatisfied) {
            saveRejected(
                appContext,
                request.timeoutSeconds,
                "TAILSCALE_ALREADY_CONNECTED"
            )
            return@synchronized ActionResult(false, "TAILSCALE_ALREADY_CONNECTED")
        }

        val alwaysOnConfigured =
            DevicePolicyController.reconcileAlwaysOnVpn(appContext) &&
                isAlwaysOnTailscale(appContext)
        if (!alwaysOnConfigured) {
            clearTransientAuthKey(appContext)
            saveRejected(appContext, request.timeoutSeconds, "ALWAYS_ON_VPN_REJECTED")
            return@synchronized ActionResult(false, "ALWAYS_ON_VPN_REJECTED")
        }

        val restrictions = try {
            Bundle(
                dpm.getApplicationRestrictions(
                    DevicePolicyController.getAdminComponent(appContext),
                    TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
                )
            ).apply {
                putString(
                    TailscaleEnrollmentPolicy.AUTH_KEY_POLICY,
                    request.authKey
                )
                if (supported.forceEnabled) {
                    putBoolean(
                        TailscaleEnrollmentPolicy.FORCE_ENABLED_POLICY,
                        true
                    )
                }
                if (supported.onboardingFlow) {
                    putString(
                        TailscaleEnrollmentPolicy.ONBOARDING_FLOW_POLICY,
                        TailscaleEnrollmentPolicy.ONBOARDING_FLOW_HIDE
                    )
                }
            }
        } catch (_: Exception) {
            clearTransientAuthKey(appContext)
            saveRejected(
                appContext,
                request.timeoutSeconds,
                "APPLICATION_RESTRICTIONS_READ_FAILED"
            )
            return@synchronized ActionResult(
                false,
                "APPLICATION_RESTRICTIONS_READ_FAILED"
            )
        }

        try {
            dpm.setApplicationRestrictions(
                DevicePolicyController.getAdminComponent(appContext),
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE,
                restrictions
            )
        } catch (_: Exception) {
            val cleared = clearTransientAuthKey(appContext)
            saveRejected(
                appContext,
                request.timeoutSeconds,
                if (cleared) {
                    "APPLICATION_RESTRICTIONS_WRITE_FAILED"
                } else {
                    "AUTH_KEY_CLEAR_FAILED"
                }
            )
            return@synchronized ActionResult(
                false,
                if (cleared) {
                    "APPLICATION_RESTRICTIONS_WRITE_FAILED"
                } else {
                    "AUTH_KEY_CLEAR_FAILED"
                }
            )
        }

        val nowWallMs = System.currentTimeMillis()
        val timeoutMs = request.timeoutSeconds * 1_000L
        val generation = operationGeneration.incrementAndGet()
        activeGeneration = generation
        activeDeadlineElapsedMs = SystemClock.elapsedRealtime() + timeoutMs
        TailscaleEnrollmentStateStore.save(
            appContext,
            TailscaleEnrollmentStateStore.Snapshot(
                state = "enrolling",
                code = "WAITING_FOR_TAILNET",
                startedAtMs = nowWallMs,
                finishedAtMs = 0L,
                deadlineAtMs = nowWallMs + timeoutMs,
                timeoutSeconds = request.timeoutSeconds,
                alwaysOnVpnConfigured = true,
                vpnTransportDetected = false,
                vpnValidated = false,
                tailnetAddressDetected = false
            )
        )
        schedulePoll(appContext, generation, 0L)
        ActionResult(true, "ENROLLMENT_STARTED")
    }

    /**
     * A process restart invalidates any in-memory enrollment operation. Scrub
     * a possibly orphaned AuthKey before accepting another request and report
     * the interrupted attempt honestly.
     */
    fun reconcileAfterProcessStart(context: Context) {
        if (!processReconciled.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        synchronized(lock) {
            activeGeneration = 0L
            activeDeadlineElapsedMs = 0L
            val previous = TailscaleEnrollmentStateStore.load(appContext)
            val keyWasPresent = transientAuthKeyPresence(appContext) == true
            val cleared = clearTransientAuthKey(appContext)
            if (previous.state == "enrolling" || keyWasPresent) {
                val proof = connectivityProof(appContext)
                TailscaleEnrollmentStateStore.save(
                    appContext,
                    previous.copy(
                        state = "failed",
                        code = if (cleared) {
                            "PROCESS_RESTARTED_AUTH_KEY_CLEARED"
                        } else {
                            "PROCESS_RESTARTED_CLEAR_FAILED"
                        },
                        finishedAtMs = System.currentTimeMillis(),
                        alwaysOnVpnConfigured =
                            proof.alwaysOnVpnConfigured,
                        vpnTransportDetected =
                            proof.vpnTransportDetected,
                        vpnValidated = proof.vpnValidated,
                        tailnetAddressDetected =
                            proof.tailnetAddressDetected
                    )
                )
            }
        }
    }

    fun statusJson(context: Context): JSONObject {
        val appContext = context.applicationContext
        val stored = TailscaleEnrollmentStateStore.load(appContext)
        val packageSnapshot = packageSnapshot(appContext)
        val supported = supportedPolicies(appContext)
        val proof = connectivityProof(appContext)
        return JSONObject().apply {
            put("state", stored.state)
            put("code", stored.code)
            put("startedAtMs", stored.startedAtMs)
            put("finishedAtMs", stored.finishedAtMs)
            put("deadlineAtMs", stored.deadlineAtMs)
            put("timeoutSeconds", stored.timeoutSeconds)
            put("deviceOwner", DevicePolicyController.isDeviceOwner(appContext))
            put("tailscaleInstalled", packageSnapshot.installed)
            put("tailscaleEnabled", packageSnapshot.enabled)
            put("tailscaleVersion", packageSnapshot.versionName ?: JSONObject.NULL)
            put("alwaysOnVpnConfigured", proof.alwaysOnVpnConfigured)
            put("vpnTransportDetected", proof.vpnTransportDetected)
            put("vpnValidated", proof.vpnValidated)
            put("tailnetAddressDetected", proof.tailnetAddressDetected)
            put(
                "credentialConsumptionProven",
                stored.state == "succeeded" &&
                    stored.code == "TAILNET_CONNECTED" &&
                    proof.enrollmentConnectivitySatisfied
            )
            put(
                "transientAuthKeyPresent",
                transientAuthKeyPresence(appContext) ?: JSONObject.NULL
            )
            put(
                "supportedPolicies",
                JSONObject()
                    .put("authKey", supported.authKey)
                    .put("forceEnabled", supported.forceEnabled)
                    .put("onboardingFlow", supported.onboardingFlow)
            )
            put(
                "appliedNonSecretPolicy",
                JSONObject()
                    .put("alwaysOnVpnPackage", proof.alwaysOnVpnConfigured)
                    .put(
                        "forceEnabled",
                        nonSecretBooleanPolicyApplied(
                            appContext,
                            TailscaleEnrollmentPolicy.FORCE_ENABLED_POLICY
                        )
                    )
                    .put(
                        "onboardingHidden",
                        nonSecretStringPolicyEquals(
                            appContext,
                            TailscaleEnrollmentPolicy.ONBOARDING_FLOW_POLICY,
                            TailscaleEnrollmentPolicy.ONBOARDING_FLOW_HIDE
                        )
                    )
            )
        }
    }

    private fun schedulePoll(
        context: Context,
        generation: Long,
        delaySeconds: Long
    ) {
        worker.schedule(
            { poll(context, generation) },
            delaySeconds,
            TimeUnit.SECONDS
        )
    }

    private fun poll(context: Context, generation: Long) {
        synchronized(lock) {
            if (activeGeneration != generation || generation == 0L) return
            val proof = connectivityProof(context)
            val stored = TailscaleEnrollmentStateStore.load(context)
            TailscaleEnrollmentStateStore.save(
                context,
                stored.copy(
                    alwaysOnVpnConfigured = proof.alwaysOnVpnConfigured,
                    vpnTransportDetected = proof.vpnTransportDetected,
                    vpnValidated = proof.vpnValidated,
                    tailnetAddressDetected = proof.tailnetAddressDetected
                )
            )

            when (
                TailscaleEnrollmentPolicy.completionDecision(
                    SystemClock.elapsedRealtime(),
                    activeDeadlineElapsedMs,
                    proof
                )
            ) {
                TailscaleEnrollmentPolicy.CompletionDecision.WAIT -> {
                    DevicePolicyController.reconcileAlwaysOnVpn(context)
                    schedulePoll(context, generation, POLL_INTERVAL_SECONDS)
                }
                TailscaleEnrollmentPolicy.CompletionDecision.SUCCEED -> {
                    finish(
                        context,
                        generation,
                        proof,
                        successCode = "TAILNET_CONNECTED",
                        failureCode = "AUTH_KEY_CLEAR_FAILED"
                    )
                }
                TailscaleEnrollmentPolicy.CompletionDecision.TIME_OUT -> {
                    finish(
                        context,
                        generation,
                        proof,
                        successCode = null,
                        failureCode = "TAILNET_CONNECTION_TIMEOUT"
                    )
                }
            }
        }
    }

    private fun finish(
        context: Context,
        generation: Long,
        proof: TailscaleEnrollmentPolicy.ConnectivityProof,
        successCode: String?,
        failureCode: String
    ) {
        if (activeGeneration != generation) return
        val cleared = clearTransientAuthKey(context)
        val previous = TailscaleEnrollmentStateStore.load(context)
        TailscaleEnrollmentStateStore.save(
            context,
            previous.copy(
                state = if (successCode != null && cleared) "succeeded" else "failed",
                code = when {
                    !cleared -> "AUTH_KEY_CLEAR_FAILED"
                    successCode != null -> successCode
                    else -> failureCode
                },
                finishedAtMs = System.currentTimeMillis(),
                alwaysOnVpnConfigured = proof.alwaysOnVpnConfigured,
                vpnTransportDetected = proof.vpnTransportDetected,
                vpnValidated = proof.vpnValidated,
                tailnetAddressDetected = proof.tailnetAddressDetected
            )
        )
        activeGeneration = 0L
        activeDeadlineElapsedMs = 0L
    }

    private fun clearTransientAuthKey(context: Context): Boolean {
        val dpm =
            context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(context.packageName)) return false
        return try {
            val admin = DevicePolicyController.getAdminComponent(context)
            val restrictions = Bundle(
                dpm.getApplicationRestrictions(
                    admin,
                    TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
                )
            )
            if (restrictions.containsKey(TailscaleEnrollmentPolicy.AUTH_KEY_POLICY)) {
                restrictions.remove(TailscaleEnrollmentPolicy.AUTH_KEY_POLICY)
                dpm.setApplicationRestrictions(
                    admin,
                    TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE,
                    restrictions
                )
            }
            !Bundle(
                dpm.getApplicationRestrictions(
                    admin,
                    TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
                )
            ).containsKey(TailscaleEnrollmentPolicy.AUTH_KEY_POLICY)
        } catch (_: Exception) {
            false
        }
    }

    private fun transientAuthKeyPresence(context: Context): Boolean? {
        val dpm =
            context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(context.packageName)) return null
        return try {
            dpm.getApplicationRestrictions(
                DevicePolicyController.getAdminComponent(context),
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
            ).containsKey(TailscaleEnrollmentPolicy.AUTH_KEY_POLICY)
        } catch (_: Exception) {
            null
        }
    }

    private fun packageSnapshot(context: Context): PackageSnapshot {
        return try {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE,
                0
            )
            val setting = context.packageManager.getApplicationEnabledSetting(
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
            )
            val enabledBySetting =
                setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED &&
                    setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER &&
                    setting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED
            PackageSnapshot(
                installed = true,
                enabled = info.applicationInfo?.enabled == true && enabledBySetting,
                versionName = info.versionName
            )
        } catch (_: Exception) {
            PackageSnapshot(false, false, null)
        }
    }

    private fun supportedPolicies(context: Context): SupportedPolicies {
        if (!packageSnapshot(context).installed) {
            return SupportedPolicies(false, false, false)
        }
        return try {
            val manager =
                context.getSystemService(Context.RESTRICTIONS_SERVICE) as RestrictionsManager
            val entries = manager.getManifestRestrictions(
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
            ).orEmpty()
            val byKey = entries.associateBy { it.key }
            SupportedPolicies(
                authKey =
                    byKey[TailscaleEnrollmentPolicy.AUTH_KEY_POLICY]?.type ==
                        RestrictionEntry.TYPE_STRING,
                forceEnabled =
                    byKey[TailscaleEnrollmentPolicy.FORCE_ENABLED_POLICY]?.type ==
                        RestrictionEntry.TYPE_BOOLEAN,
                onboardingFlow =
                    byKey[TailscaleEnrollmentPolicy.ONBOARDING_FLOW_POLICY]?.let {
                        it.type == RestrictionEntry.TYPE_CHOICE &&
                            it.choiceValues?.contains(
                                TailscaleEnrollmentPolicy.ONBOARDING_FLOW_HIDE
                            ) == true
                    } == true
            )
        } catch (_: Exception) {
            SupportedPolicies(false, false, false)
        }
    }

    private fun isAlwaysOnTailscale(context: Context): Boolean {
        val dpm =
            context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return try {
            dpm.getAlwaysOnVpnPackage(
                DevicePolicyController.getAdminComponent(context)
            ) == TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
        } catch (_: Exception) {
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun connectivityProof(
        context: Context
    ): TailscaleEnrollmentPolicy.ConnectivityProof {
        val connectivity =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        var vpnDetected = false
        var validated = false
        var tailnetAddress = false
        try {
            connectivity.allNetworks.forEach { network ->
                val capabilities =
                    connectivity.getNetworkCapabilities(network) ?: return@forEach
                if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return@forEach
                }
                vpnDetected = true
                validated = validated ||
                    capabilities.hasCapability(
                        NetworkCapabilities.NET_CAPABILITY_VALIDATED
                    )
                val links = connectivity.getLinkProperties(network)
                tailnetAddress = tailnetAddress ||
                    links?.linkAddresses.orEmpty().any { link ->
                        TailscaleEnrollmentPolicy.isTailnetAddress(
                            link.address.address
                        )
                    }
            }
        } catch (_: Exception) {
            vpnDetected = false
            validated = false
            tailnetAddress = false
        }
        return TailscaleEnrollmentPolicy.ConnectivityProof(
            alwaysOnVpnConfigured = isAlwaysOnTailscale(context),
            vpnTransportDetected = vpnDetected,
            vpnValidated = validated,
            tailnetAddressDetected = tailnetAddress
        )
    }

    private fun currentRestrictions(context: Context): Bundle? {
        val dpm =
            context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(context.packageName)) return null
        return try {
            dpm.getApplicationRestrictions(
                DevicePolicyController.getAdminComponent(context),
                TailscaleEnrollmentPolicy.TAILSCALE_PACKAGE
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun nonSecretBooleanPolicyApplied(
        context: Context,
        key: String
    ): Boolean = currentRestrictions(context)?.getBoolean(key, false) == true

    private fun nonSecretStringPolicyEquals(
        context: Context,
        key: String,
        expected: String
    ): Boolean = currentRestrictions(context)?.getString(key) == expected

    private fun saveRejected(
        context: Context,
        timeoutSeconds: Int,
        code: String
    ) {
        val now = System.currentTimeMillis()
        TailscaleEnrollmentStateStore.save(
            context,
            TailscaleEnrollmentStateStore.Snapshot(
                state = "failed",
                code = code,
                startedAtMs = now,
                finishedAtMs = now,
                deadlineAtMs = 0L,
                timeoutSeconds = timeoutSeconds,
                alwaysOnVpnConfigured = isAlwaysOnTailscale(context),
                vpnTransportDetected = false,
                vpnValidated = false,
                tailnetAddressDetected = false
            )
        )
    }
}
