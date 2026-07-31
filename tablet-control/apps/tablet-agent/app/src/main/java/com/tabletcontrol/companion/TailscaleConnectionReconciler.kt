package com.tabletcontrol.companion

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reconciles the Tailscale VPN connection state on every boot / process start.
 *
 * This is NOT an enrollment manager. It does not generate codes, request auth
 * keys, or create new Tailscale identities. It only monitors the existing
 * Tailscale connection and reports its state.
 *
 * Expected states:
 * - Tailscale Running (VPN connected): PASS — continue boot.
 * - Tailscale Starting: retry with bounded backoff (up to ~60s).
 * - Tailscale stopped: attempt to reconcile the service via Device Owner.
 * - Tailscale signed out / identity missing: report TAILSCALE_IDENTITY_MISSING.
 */
internal object TailscaleConnectionReconciler {
    private const val TAG = "TsReconciler"
    private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    private const val MAX_BACKOFF_ATTEMPTS = 12
    private const val INITIAL_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 10_000L
    private val reconciling = AtomicBoolean(false)
    @Volatile private var currentThread: Thread? = null
    @Volatile private var lastState: TailscaleState = TailscaleState.UNKNOWN

    enum class TailscaleState {
        UNKNOWN,
        CONNECTED,
        STARTING,
        STOPPED,
        NOT_INSTALLED,
        IDENTITY_MISSING
    }

    /**
     * Called from CompanionService.ensureCoreInitialized() after
     * TailscaleEnrollmentManager.reconcileAfterProcessStart().
     *
     * Checks current Tailscale state. If connected, returns immediately.
     * If starting, waits with bounded backoff. If stopped, attempts restart.
     * If identity is missing, reports and returns — does NOT attempt enrollment.
     */
    fun reconcile(context: Context) {
        val appContext = context.applicationContext
        if (!isTailscaleInstalled(appContext)) {
            Log.w(TAG, "Tailscale not installed — skipping reconciliation.")
            lastState = TailscaleState.NOT_INSTALLED
            return
        }
        if (!DevicePolicyController.isDeviceOwner(appContext)) {
            Log.d(TAG, "Not Device Owner — skipping Tailscale reconciliation.")
            return
        }
        if (isTailscaleConnected(appContext)) {
            Log.i(TAG, "Tailscale VPN connected — no reconciliation needed.")
            lastState = TailscaleState.CONNECTED
            return
        }

        // Not connected yet — start bounded backoff wait
        if (reconciling.compareAndSet(false, true)) {
            Log.i(TAG, "Tailscale not yet connected — starting connection reconciliation.")
            startReconciliation(appContext)
        } else {
            Log.d(TAG, "Reconciliation already in progress — skipping.")
        }
    }

    fun cancel() {
        currentThread?.interrupt()
        currentThread = null
        reconciling.set(false)
    }

    fun getLastState(): TailscaleState = lastState

    private fun startReconciliation(context: Context) {
        val thread = Thread {
            try {
                var attempt = 0
                var backoffMs = INITIAL_BACKOFF_MS
                while (attempt < MAX_BACKOFF_ATTEMPTS) {
                    if (Thread.currentThread().isInterrupted) {
                        Log.d(TAG, "Reconciliation interrupted.")
                        return@Thread
                    }
                    if (isTailscaleConnected(context)) {
                        Log.i(TAG, "Tailscale connected after ${attempt + 1} checks.")
                        lastState = TailscaleState.CONNECTED
                        DiagnosticEventStore.info(
                            context,
                            component = "tailscale",
                            event = "reconciliation_connected",
                            fields = mapOf("attempts" to (attempt + 1))
                        )
                        return@Thread
                    }
                    attempt++
                    Log.d(TAG, "Tailscale not connected (attempt $attempt/$MAX_BACKOFF_ATTEMPTS), waiting ${backoffMs}ms")
                    // On first few failures, try to ensure the VPN service is enabled
                    if (attempt == 3) {
                        tryEnsureTailscaleEnabled(context)
                    }
                    try {
                        Thread.sleep(backoffMs)
                    } catch (_: InterruptedException) {
                        Log.d(TAG, "Reconciliation sleep interrupted.")
                        return@Thread
                    }
                    backoffMs = (backoffMs * 15 / 10).coerceAtMost(MAX_BACKOFF_MS)
                }

                // Exhausted retries — check if it's an identity problem
                if (isTailscaleConnected(context)) {
                    lastState = TailscaleState.CONNECTED
                    Log.i(TAG, "Tailscale connected after final check.")
                } else {
                    lastState = TailscaleState.IDENTITY_MISSING
                    Log.w(TAG, "Tailscale did not connect after $MAX_BACKOFF_ATTEMPTS attempts. " +
                        "Possible identity issue — reporting TAILSCALE_IDENTITY_MISSING.")
                    DiagnosticEventStore.warn(
                        context,
                        component = "tailscale",
                        event = "reconciliation_exhausted",
                        fields = mapOf(
                            "attempts" to MAX_BACKOFF_ATTEMPTS,
                            "state" to "TAILSCALE_IDENTITY_MISSING"
                        )
                    )
                }
            } finally {
                reconciling.set(false)
                currentThread = null
            }
        }
        thread.name = "roshan-ts-reconciler"
        thread.isDaemon = true
        currentThread = thread
        thread.start()
    }

    /**
     * Use Device Owner authority to ensure Tailscale is not disabled.
     * Does NOT create a new identity or auth key.
     */
    private fun tryEnsureTailscaleEnabled(context: Context) {
        try {
            if (DevicePolicyController.isDeviceOwner(context)) {
                DevicePolicyController.ensurePackageEnabled(context, TAILSCALE_PACKAGE)
                Log.i(TAG, "Ensured Tailscale package is enabled via Device Owner.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not ensure Tailscale enabled: ${e.message}")
        }
    }

    private fun isTailscaleInstalled(context: Context): Boolean {
        return try {
            context.packageManager.getPackageInfo(TAILSCALE_PACKAGE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun isTailscaleConnected(context: Context): Boolean =
        TailscaleStateProbe.probe(context).connected
}
