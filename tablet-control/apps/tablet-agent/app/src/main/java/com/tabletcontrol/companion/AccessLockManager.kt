package com.tabletcontrol.companion

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Temporary, fail-safe input lock.
 *
 * Active state deliberately lives only in this process. A reboot, force-stop, or
 * process crash therefore removes the overlay and starts the next process in the
 * unlocked state. No active-lock flag or wall-clock expiry is persisted.
 */
object AccessLockManager {
    const val DEFAULT_DURATION_MS = 5 * 60_000L
    const val MAX_DURATION_MS = 30 * 60_000L
    internal const val MIN_DURATION_MS = 1_000L

    private const val TAG = "AccessLock"
    private const val MAIN_THREAD_TIMEOUT_MS = 5_000L
    private const val POLICY_CLEAR_RETRY_MS = 5_000L
    private val mainHandler = Handler(Looper.getMainLooper())
    private val state = AccessLockStateMachine(
        defaultDurationMs = DEFAULT_DURATION_MS,
        maximumDurationMs = MAX_DURATION_MS,
        minimumDurationMs = MIN_DURATION_MS
    )

    @Volatile
    private var overlayView: AccessLockOverlayView? = null
    private var expiryRunnable: Runnable? = null
    private var policyClearRetryRunnable: Runnable? = null
    private val expiryCleanupPosted = AtomicBoolean(false)

    /**
     * Enables or releases Access Lock. A failed overlay permission/check/add
     * removes the overlay and attempts to clear owner policy. The return value
     * is false until that policy clear is confirmed.
     */
    fun setLocked(
        context: Context,
        enabled: Boolean,
        requestedDurationMs: Long? = null
    ): Boolean {
        val appContext = context.applicationContext
        return runOnMainThread {
            if (enabled) {
                activateOnMain(appContext, requestedDurationMs)
            } else {
                releaseOnMain(
                    appContext,
                    expectedGeneration = null,
                    cause = ReleaseCause.OWNER_REQUEST
                )
            }
        } ?: false
    }

    fun isLocked(context: Context? = null): Boolean {
        val now = SystemClock.elapsedRealtime()
        val snapshot = state.snapshot(now)
        if (!snapshot.active && overlayView != null && context != null) {
            val appContext = context.applicationContext
            if (expiryCleanupPosted.compareAndSet(false, true)) {
                mainHandler.post {
                    expiryCleanupPosted.set(false)
                    finishExpiredStateOnMain(appContext)
                }
            }
        }
        return snapshot.reportedLocked
    }

    fun remainingDurationMs(): Long =
        state.snapshot(SystemClock.elapsedRealtime()).remainingMs

    /**
     * Used by the activity fallback after the protected seven-tap gesture.
     */
    fun requestLocalRecovery(): Boolean {
        val view = overlayView
        if (view == null) {
            Log.w(
                TAG,
                "Local recovery panel unavailable; no Access Lock overlay is attached"
            )
            return false
        }
        mainHandler.post { view.showRecoveryPanel() }
        return true
    }

    private fun activateOnMain(context: Context, requestedDurationMs: Long?): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())

        val snapshot = state.lock(SystemClock.elapsedRealtime(), requestedDurationMs)
        cancelExpiryOnMain()
        cancelPolicyClearRetryOnMain()

        if (!Settings.canDrawOverlays(context)) {
            Log.e(TAG, "Access Lock activation rejected; overlay permission is unavailable")
            releaseOnMain(
                context,
                expectedGeneration = null,
                cause = ReleaseCause.ACTIVATION_ROLLBACK
            )
            return false
        }

        val attached = try {
            attachOverlayOnMain(context)
            true
        } catch (_: Exception) {
            false
        }

        if (!attached) {
            Log.e(TAG, "Access Lock activation rejected; protected overlay could not attach")
            releaseOnMain(
                context,
                expectedGeneration = null,
                cause = ReleaseCause.ACTIVATION_ROLLBACK
            )
            return false
        }

        if (!DevicePolicyController.setAccessLockPolicy(context, true)) {
            Log.e(TAG, "Access Lock activation rejected; owner policy was not fully applied")
            releaseOnMain(
                context,
                expectedGeneration = null,
                cause = ReleaseCause.ACTIVATION_ROLLBACK
            )
            return false
        }
        scheduleExpiryOnMain(context, snapshot)
        notifyActivityState(context, true)
        Log.i(TAG, "Access Lock activation confirmed")
        return true
    }

    private fun releaseOnMain(
        context: Context,
        expectedGeneration: Long?,
        cause: ReleaseCause
    ): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (expectedGeneration != null &&
            !state.isCurrentGeneration(expectedGeneration)
        ) {
            return false
        }

        val policyCleared = DevicePolicyController.setAccessLockPolicy(context, false)
        val snapshot = state.release(policyClearConfirmed = policyCleared)
        cancelExpiryOnMain()
        removeOverlayOnMain()
        notifyActivityState(context, snapshot.reportedLocked)

        if (policyCleared) {
            cancelPolicyClearRetryOnMain()
            Log.i(TAG, "Access Lock release confirmed (${cause.logLabel})")
        } else {
            Log.e(
                TAG,
                "Access Lock overlay released, but owner-policy clearing was not confirmed " +
                    "(${cause.logLabel}); retry scheduled"
            )
            schedulePolicyClearRetryOnMain(context)
        }
        return policyCleared
    }

    private fun finishExpiredStateOnMain(context: Context) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val snapshot = state.snapshot(SystemClock.elapsedRealtime())
        if (snapshot.active || (!snapshot.policyClearUnconfirmed && overlayView == null)) return
        releaseOnMain(
            context,
            expectedGeneration = null,
            cause = ReleaseCause.AUTOMATIC_EXPIRY
        )
    }

    private fun attachOverlayOnMain(context: Context) {
        check(Looper.myLooper() == Looper.getMainLooper())
        removeOverlayOnMain()

        val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val view = AccessLockOverlayView(context)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        windowManager.addView(view, params)
        overlayView = view
        view.startCountdown()
    }

    private fun removeOverlayOnMain() {
        check(Looper.myLooper() == Looper.getMainLooper())
        val view = overlayView ?: return
        overlayView = null
        view.stopCountdown()
        try {
            val windowManager =
                view.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            windowManager.removeViewImmediate(view)
        } catch (_: Exception) {
            // Already detached is equivalent to unlocked.
        }
    }

    private fun scheduleExpiryOnMain(
        context: Context,
        snapshot: AccessLockStateMachine.Snapshot
    ) {
        cancelExpiryOnMain()
        val generation = snapshot.generation
        val runnable = object : Runnable {
            override fun run() {
                if (!state.isCurrentGeneration(generation)) return
                val current = state.snapshot(SystemClock.elapsedRealtime())
                if (!current.active) {
                    finishExpiredStateOnMain(context)
                    return
                }
                mainHandler.postDelayed(this, current.remainingMs.coerceAtLeast(1L))
            }
        }
        expiryRunnable = runnable
        mainHandler.postDelayed(runnable, snapshot.remainingMs.coerceAtLeast(1L))
    }

    private fun cancelExpiryOnMain() {
        expiryRunnable?.let(mainHandler::removeCallbacks)
        expiryRunnable = null
    }

    private fun schedulePolicyClearRetryOnMain(context: Context) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (policyClearRetryRunnable != null) return
        val appContext = context.applicationContext
        val runnable = Runnable {
            policyClearRetryRunnable = null
            val snapshot = state.snapshot(SystemClock.elapsedRealtime())
            if (!snapshot.active && snapshot.policyClearUnconfirmed) {
                releaseOnMain(
                    appContext,
                    expectedGeneration = null,
                    cause = ReleaseCause.POLICY_CLEAR_RETRY
                )
            }
        }
        policyClearRetryRunnable = runnable
        mainHandler.postDelayed(runnable, POLICY_CLEAR_RETRY_MS)
    }

    private fun cancelPolicyClearRetryOnMain() {
        policyClearRetryRunnable?.let(mainHandler::removeCallbacks)
        policyClearRetryRunnable = null
    }

    private fun notifyActivityState(context: Context, enabled: Boolean) {
        context.sendBroadcast(
            Intent(KioskController.ACTION_SET_TOUCH_LOCK)
                .setPackage(context.packageName)
                .putExtra(KioskController.EXTRA_TOUCH_LOCK, enabled)
        )
    }

    private fun <T> runOnMainThread(block: () -> T): T? {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()

        val latch = CountDownLatch(1)
        val mayRun = AtomicBoolean(true)
        var result: T? = null
        mainHandler.post {
            if (mayRun.compareAndSet(true, false)) {
                try {
                    result = block()
                } finally {
                    latch.countDown()
                }
            } else {
                latch.countDown()
            }
        }

        if (!latch.await(MAIN_THREAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            mayRun.set(false)
            return null
        }
        return result
    }

    private enum class ReleaseCause(val logLabel: String) {
        OWNER_REQUEST("owner request"),
        AUTOMATIC_EXPIRY("automatic expiry"),
        ACTIVATION_ROLLBACK("failed activation rollback"),
        POLICY_CLEAR_RETRY("policy-clear retry")
    }

    private class AccessLockOverlayView(context: Context) : FrameLayout(context) {
        private val taps = ArrayDeque<Long>()
        private lateinit var countdownText: TextView
        private val recoveryPanel: LinearLayout
        private val recoveryInput: EditText
        private val recoveryStatus: TextView
        private val countdownHandler = Handler(Looper.getMainLooper())

        private val countdownRunnable = object : Runnable {
            override fun run() {
                val remainingSeconds =
                    (remainingDurationMs() + 999L).coerceAtLeast(0L) / 1_000L
                countdownText.text =
                    "Access temporarily locked · automatic release in ${formatDuration(remainingSeconds)}"
                if (isLocked(context)) {
                    countdownHandler.postDelayed(this, 1_000L)
                }
            }
        }

        init {
            isClickable = true
            isFocusable = true
            isFocusableInTouchMode = true
            setBackgroundColor(Color.argb(48, 0, 0, 0))

            val notice = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(24), dp(16), dp(24), dp(16))
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.argb(224, 11, 14, 20))
                    cornerRadius = dp(16).toFloat()
                    setStroke(dp(1), Color.rgb(51, 65, 85))
                }
            }
            val title = TextView(context).apply {
                text = "Access Lock"
                setTextColor(Color.WHITE)
                textSize = 22f
                gravity = Gravity.CENTER
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }
            countdownText = TextView(context).apply {
                setTextColor(Color.rgb(203, 213, 225))
                textSize = 14f
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, 0)
            }
            val recoveryHint = TextView(context).apply {
                text = "Owner recovery: tap the top-left corner 7 times"
                setTextColor(Color.rgb(148, 163, 184))
                textSize = 12f
                gravity = Gravity.CENTER
                setPadding(0, dp(6), 0, 0)
            }
            notice.addView(title)
            notice.addView(countdownText)
            notice.addView(recoveryHint)
            addView(
                notice,
                LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    gravity = Gravity.CENTER
                    leftMargin = dp(24)
                    rightMargin = dp(24)
                }
            )

            recoveryInput = EditText(context).apply {
                hint = "Owner PIN"
                inputType =
                    InputType.TYPE_CLASS_NUMBER or
                        InputType.TYPE_NUMBER_VARIATION_PASSWORD
                setTextColor(Color.WHITE)
                setHintTextColor(Color.rgb(148, 163, 184))
                gravity = Gravity.CENTER
            }
            recoveryStatus = TextView(context).apply {
                setTextColor(Color.rgb(248, 113, 113))
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, dp(8))
            }
            val unlockButton = Button(context).apply {
                text = "Unlock"
                setOnClickListener { verifyRecoveryPin() }
            }
            val cancelButton = Button(context).apply {
                text = "Cancel"
                setOnClickListener { hideRecoveryPanel() }
            }
            val buttonRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(
                    cancelButton,
                    LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                )
                addView(
                    unlockButton,
                    LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                )
            }
            recoveryPanel = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(28), dp(24), dp(28), dp(24))
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.rgb(11, 14, 20))
                    cornerRadius = dp(18).toFloat()
                    setStroke(dp(1), Color.rgb(71, 85, 105))
                }
                addView(
                    TextView(context).apply {
                        text = "Protected owner recovery"
                        setTextColor(Color.WHITE)
                        textSize = 20f
                        typeface = android.graphics.Typeface.DEFAULT_BOLD
                        gravity = Gravity.CENTER
                    }
                )
                addView(
                    TextView(context).apply {
                        text = "Enter the configured PBKDF2-protected owner PIN."
                        setTextColor(Color.rgb(203, 213, 225))
                        textSize = 13f
                        gravity = Gravity.CENTER
                        setPadding(0, dp(8), 0, dp(8))
                    }
                )
                addView(recoveryInput, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, dp(56)))
                addView(recoveryStatus, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
                addView(buttonRow, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
                visibility = View.GONE
            }
            addView(
                recoveryPanel,
                LayoutParams(dp(420), LayoutParams.WRAP_CONTENT).apply {
                    gravity = Gravity.CENTER
                    leftMargin = dp(24)
                    rightMargin = dp(24)
                }
            )
        }

        fun startCountdown() {
            countdownHandler.removeCallbacks(countdownRunnable)
            countdownHandler.post(countdownRunnable)
            requestFocus()
        }

        fun stopCountdown() {
            countdownHandler.removeCallbacks(countdownRunnable)
        }

        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_UP &&
                event.x <= dp(180).toFloat() &&
                event.y <= dp(180).toFloat()
            ) {
                val now = SystemClock.elapsedRealtime()
                taps.addLast(now)
                while (taps.isNotEmpty() && now - taps.first() > 8_000L) {
                    taps.removeFirst()
                }
                if (taps.size >= 7) {
                    taps.clear()
                    showRecoveryPanel()
                }
            }
            super.dispatchTouchEvent(event)
            return true
        }

        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode == KeyEvent.KEYCODE_BACK &&
                event.action == KeyEvent.ACTION_UP &&
                recoveryPanel.visibility == View.VISIBLE
            ) {
                hideRecoveryPanel()
            }
            return true
        }

        fun showRecoveryPanel() {
            recoveryInput.text?.clear()
            recoveryStatus.text = when (AdminPinStore.getState(context)) {
                AdminPinStore.State.PIN_NOT_CONFIGURED ->
                    "No local recovery PIN is configured. Use protected remote release or ADB."
                AdminPinStore.State.COOLDOWN ->
                    "PIN verification is temporarily in cooldown."
                AdminPinStore.State.LOCKED_RECOVERY_REQUIRED ->
                    "Local PIN verification is locked. Use protected remote release or ADB recovery."
                else -> ""
            }
            recoveryPanel.visibility = View.VISIBLE
            recoveryInput.requestFocus()
            val inputMethodManager =
                context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            inputMethodManager.showSoftInput(recoveryInput, InputMethodManager.SHOW_IMPLICIT)
        }

        private fun hideRecoveryPanel() {
            recoveryInput.text?.clear()
            recoveryStatus.text = ""
            recoveryPanel.visibility = View.GONE
            requestFocus()
            val inputMethodManager =
                context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            inputMethodManager.hideSoftInputFromWindow(windowToken, 0)
        }

        private fun verifyRecoveryPin() {
            when (val result = AdminPinStore.verifyPin(context, recoveryInput.text.toString())) {
                is AdminPinStore.PinVerificationResult.Success -> {
                    val released = setLocked(context, false)
                    if (released) {
                        Log.i(TAG, "Local owner recovery confirmed Access Lock release")
                        Toast.makeText(
                            context,
                            "Access Lock released.",
                            Toast.LENGTH_SHORT
                        ).show()
                    } else {
                        Log.e(
                            TAG,
                            "Local owner PIN accepted, but Access Lock policy release " +
                                "was not confirmed"
                        )
                        Toast.makeText(
                            context,
                            "PIN accepted, but policy release was not confirmed. " +
                                "RoshanOS is retrying.",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
                is AdminPinStore.PinVerificationResult.Unconfigured -> {
                    recoveryStatus.text =
                        "No local recovery PIN is configured. Use protected remote release or ADB."
                }
                is AdminPinStore.PinVerificationResult.Failed -> {
                    recoveryStatus.text =
                        "Incorrect PIN. ${result.attemptsRemaining} attempts remaining."
                    recoveryInput.text?.clear()
                }
                is AdminPinStore.PinVerificationResult.Cooldown -> {
                    recoveryStatus.text =
                        "Try again in ${result.secondsRemaining} seconds."
                    recoveryInput.text?.clear()
                }
                is AdminPinStore.PinVerificationResult.RecoveryLocked -> {
                    recoveryStatus.text =
                        "Local PIN verification is locked. Use protected remote release or ADB recovery."
                    recoveryInput.text?.clear()
                }
            }
        }

        private fun dp(value: Int): Int =
            (value * resources.displayMetrics.density).toInt()

        private fun formatDuration(totalSeconds: Long): String {
            val minutes = totalSeconds / 60L
            val seconds = totalSeconds % 60L
            return "%d:%02d".format(minutes, seconds)
        }
    }
}

/**
 * Android-free state core so expiry, bounds, stale callbacks, and restart
 * behavior are covered by ordinary JVM unit tests.
 */
internal class AccessLockStateMachine(
    private val defaultDurationMs: Long,
    private val maximumDurationMs: Long,
    private val minimumDurationMs: Long
) {
    init {
        require(minimumDurationMs > 0L)
        require(defaultDurationMs in minimumDurationMs..maximumDurationMs)
    }

    data class Snapshot(
        val active: Boolean,
        val policyClearUnconfirmed: Boolean,
        val generation: Long,
        val expiresAtElapsedRealtime: Long,
        val remainingMs: Long
    ) {
        val reportedLocked: Boolean
            get() = active || policyClearUnconfirmed
    }

    private var active = false
    private var policyClearUnconfirmed = false
    private var generation = 0L
    private var expiresAtElapsedRealtime = 0L

    @Synchronized
    fun lock(nowElapsedRealtime: Long, requestedDurationMs: Long?): Snapshot {
        val duration = (requestedDurationMs ?: defaultDurationMs)
            .coerceIn(minimumDurationMs, maximumDurationMs)
        generation += 1L
        active = true
        policyClearUnconfirmed = false
        expiresAtElapsedRealtime = saturatingAdd(nowElapsedRealtime, duration)
        return snapshotLocked(nowElapsedRealtime)
    }

    @Synchronized
    fun release(policyClearConfirmed: Boolean): Snapshot {
        generation += 1L
        active = false
        policyClearUnconfirmed = !policyClearConfirmed
        expiresAtElapsedRealtime = 0L
        return Snapshot(
            active = false,
            policyClearUnconfirmed = policyClearUnconfirmed,
            generation = generation,
            expiresAtElapsedRealtime = 0L,
            remainingMs = 0L
        )
    }

    @Synchronized
    fun snapshot(nowElapsedRealtime: Long): Snapshot =
        snapshotLocked(nowElapsedRealtime)

    @Synchronized
    fun isCurrentGeneration(expectedGeneration: Long): Boolean =
        active && generation == expectedGeneration

    private fun snapshotLocked(nowElapsedRealtime: Long): Snapshot {
        if (active && nowElapsedRealtime >= expiresAtElapsedRealtime) {
            generation += 1L
            active = false
            policyClearUnconfirmed = true
            expiresAtElapsedRealtime = 0L
        }
        val remaining =
            if (active) (expiresAtElapsedRealtime - nowElapsedRealtime).coerceAtLeast(0L)
            else 0L
        return Snapshot(
            active = active,
            policyClearUnconfirmed = policyClearUnconfirmed,
            generation = generation,
            expiresAtElapsedRealtime = expiresAtElapsedRealtime,
            remainingMs = remaining
        )
    }

    private fun saturatingAdd(left: Long, right: Long): Long =
        if (left > Long.MAX_VALUE - right) Long.MAX_VALUE else left + right
}
