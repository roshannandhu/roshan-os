package com.tabletcontrol.companion

import android.animation.ValueAnimator
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat

class KioskActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var statusPanel: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var messageText: TextView
    private lateinit var touchLockView: FrameLayout
    private lateinit var accessLockTopBarrier: View
    private lateinit var clockPanel: LinearLayout
    private lateinit var clockTimeText: TextView
    private lateinit var clockDateText: TextView
    private lateinit var scrollContainer: ScrollView
    private lateinit var calendarWidgetContainer: LinearLayout
    private lateinit var appGridContainer: GridLayout
    private lateinit var connectionBanner: TextView
    private lateinit var wifiSetupOverlay: FrameLayout
    private lateinit var wifiSetupView: WifiSetupView
    private lateinit var ownerPinSetupOverlay: FrameLayout
    private lateinit var enrollmentSetupOverlay: FrameLayout
    private lateinit var operationalGateOverlay: FrameLayout
    private lateinit var operationalGateText: TextView
    private var clockRunnable: Runnable? = null
    private var homeStateRunnable: Runnable? = null
    private val handler = Handler(Looper.getMainLooper())
    private val messageHandler = Handler(Looper.getMainLooper())
    private var retryCount = 0
    private var pendingRetry: Runnable? = null
    private var pendingReadinessGate: Runnable? = null
    private val cornerTaps = ArrayDeque<Long>()
    private var lastHomeState: RoshanHomeUiState? = null
    private var lastReconnectRequestAt = 0L
    private var wifiDisconnectedSinceElapsedMs = 0L
    private var hadConnectedWifiThisProcess = false
    private var allowedTopLevelOrigin: String? = null

    private val renderReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                KioskController.ACTION_SET_TOUCH_LOCK -> applyTouchLockIntent(intent)
                KioskController.ACTION_SET_ORIENTATION -> applyOrientationIntent(intent)
                KioskController.ACTION_SET_CLOCK_COLOR -> applyClockColorIntent(intent)
                KioskController.ACTION_APPS_CHANGED -> populateAppGrid()
                RoshanRuntimeReadiness.ACTION_READINESS_CHANGED ->
                    handleRuntimeReadinessChanged()
                else -> applyRenderIntent(intent)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)
        val filter = IntentFilter().apply {
            addAction(KioskController.ACTION_RENDER)
            addAction(KioskController.ACTION_SET_TOUCH_LOCK)
            addAction(KioskController.ACTION_SET_ORIENTATION)
            addAction(KioskController.ACTION_SET_CLOCK_COLOR)
            addAction(KioskController.ACTION_APPS_CHANGED)
            addAction(RoshanRuntimeReadiness.ACTION_READINESS_CHANGED)
        }
        ContextCompat.registerReceiver(
            this,
            renderReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        handler.post {
            buildUi()
            val commandIntent = intent.takeIf(KioskController::isTrustedActivityCommand)
            when (commandIntent?.action) {
                KioskController.ACTION_SET_TOUCH_LOCK -> applyTouchLockIntent(commandIntent)
                KioskController.ACTION_SET_ORIENTATION -> applyOrientationIntent(commandIntent)
                KioskController.ACTION_SET_CLOCK_COLOR -> applyClockColorIntent(commandIntent)
                else -> applyRenderIntent(null)
            }
            applyOrientationIntent(commandIntent)
            enterImmersiveMode()
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val commandIntent = intent.takeIf(KioskController::isTrustedActivityCommand)
        if (commandIntent != null) setIntent(commandIntent)
        when (commandIntent?.action) {
            KioskController.ACTION_SET_TOUCH_LOCK -> applyTouchLockIntent(commandIntent)
            KioskController.ACTION_SET_ORIENTATION -> applyOrientationIntent(commandIntent)
            else -> applyRenderIntent(null)
        }
        applyOrientationIntent(commandIntent)
    }

    override fun onResume() {
        super.onResume()
        isVisible = true
        if (::webView.isInitialized) {
            applyOrientationIntent(null)
            applyRenderIntent(null)
            applyTouchLockIntent(null)
            enterImmersiveMode()
        }
        startHomeStateUpdates()
    }

    override fun onPause() {
        isVisible = false
        stopHomeStateUpdates()
        super.onPause()
    }

    override fun onDestroy() {
        pendingRetry?.let(handler::removeCallbacks)
        pendingReadinessGate?.let(handler::removeCallbacks)
        stopHomeStateUpdates()
        messageHandler.removeCallbacksAndMessages(null)
        unregisterReceiver(renderReceiver)
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            enterImmersiveMode()
        }
    }

    @Deprecated("The kiosk consumes Back to avoid accidental navigation.")
    override fun onBackPressed() {
        if (AccessLockManager.isLocked(this)) return
        if (KioskController.displayMode(this) != KioskController.MODE_DASHBOARD) {
            KioskController.restoreDashboard(this)
        }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_UP && event.x < 180f && event.y < 180f) {
            val now = System.currentTimeMillis()
            cornerTaps.addLast(now)
            while (cornerTaps.isNotEmpty() && now - cornerTaps.first() > 8_000) {
                cornerTaps.removeFirst()
            }
            if (cornerTaps.size >= 7) {
                cornerTaps.clear()
                if (!AccessLockManager.isLocked(this) ||
                    !AccessLockManager.requestLocalRecovery()
                ) {
                    showAdminExit()
                }
            }
        }
        return super.dispatchTouchEvent(event)
    }

    private fun buildUi() {
        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Signage is owner-selected content rendered inside this managed
            // WebView. Automatic playback is required after reboot/recovery;
            // Android's camera/microphone privacy disclosures remain unchanged.
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            CookieManager.getInstance().setAcceptCookie(true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest
                ): Boolean {
                    val target = request.url
                    return !KioskController.isSafeDisplayUri(target) ||
                        webOrigin(target) != allowedTopLevelOrigin
                }

                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val scheme = request.url.scheme?.lowercase()
                    if ((scheme == "http" || scheme == "https") &&
                        !KioskController.isSafeDisplayUri(request.url)
                    ) {
                        return WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            403,
                            "Blocked by RoshanOS",
                            mapOf("Cache-Control" to "no-store"),
                            java.io.ByteArrayInputStream(ByteArray(0))
                        )
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                override fun onPageStarted(
                    view: WebView?,
                    url: String?,
                    favicon: android.graphics.Bitmap?
                ) {
                    statusPanel.visibility = View.GONE
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    retryCount = 0
                    statusPanel.visibility = View.GONE
                    lastPageLoadedAtMs = System.currentTimeMillis()
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest,
                    error: WebResourceError?
                ) {
                    if (request.isForMainFrame) {
                        lastPageErrorAtMs = System.currentTimeMillis()
                        if (shouldPreserveRenderedContent(request.url)) {
                            // Keep the last rendered/cached signage visible. The
                            // player owns its offline cache and reconnect state.
                            return
                        }
                        restoreHomeLauncher()
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse
                ) {
                    if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                        lastPageErrorAtMs = System.currentTimeMillis()
                        if (shouldPreserveRenderedContent(request.url)) {
                            return
                        }
                        restoreHomeLauncher()
                    }
                }

                override fun onReceivedSslError(
                    view: WebView?,
                    sslHandler: SslErrorHandler,
                    error: SslError?
                ) {
                    sslHandler.cancel()
                    lastPageErrorAtMs = System.currentTimeMillis()
                    if (shouldPreserveRenderedContent()) {
                        return
                    }
                    restoreHomeLauncher()
                }
            }
        }

        statusText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 19f
            gravity = Gravity.CENTER
        }
        val retryButton = Button(this).apply {
            text = "Retry"
            setOnClickListener { loadConfiguredPage() }
        }
        statusPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            setBackgroundColor(Color.rgb(7, 17, 31))
            addView(statusText, LinearLayout.LayoutParams(-1, -2))
            addView(retryButton, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 28 })
            visibility = View.GONE
        }

        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(statusPanel, FrameLayout.LayoutParams(-1, -1))

        val clockTypeface = try {
            android.graphics.Typeface.createFromAsset(assets, "fonts/BigShouldersDisplay-Bold.ttf")
        } catch (_: Exception) {
            try {
                android.graphics.Typeface.createFromAsset(assets, "fonts/BebasNeue-Regular.ttf")
            } catch (_: Exception) {
                android.graphics.Typeface.create("sans-serif-condensed", android.graphics.Typeface.BOLD)
            }
        }

        clockTimeText = TextView(this).apply {
            setTextColor(Color.parseColor("#00A2FF"))
            typeface = clockTypeface
            gravity = Gravity.CENTER
            includeFontPadding = false
        }
        clockDateText = TextView(this).apply {
            setTextColor(Color.parseColor("#00A2FF"))
            typeface = clockTypeface
            gravity = Gravity.CENTER
            includeFontPadding = false
            letterSpacing = 0.08f
        }

        appGridContainer = GridLayout(this).apply {
            alignmentMode = GridLayout.ALIGN_MARGINS
            useDefaultMargins = false
        }

        calendarWidgetContainer = buildCalendarWidget()

        val homeContentLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val calParams = LinearLayout.LayoutParams(-1, -2).apply { setMargins(16, 16, 16, 24) }
            addView(calendarWidgetContainer, calParams)
            addView(appGridContainer, LinearLayout.LayoutParams(-1, -2))
        }

        scrollContainer = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(homeContentLayout, FrameLayout.LayoutParams(-1, -2))
        }

        clockPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#0B0E14"))
            setPadding(24, 28, 24, 24)
            addView(clockTimeText, LinearLayout.LayoutParams(-1, -2))
            addView(clockDateText, LinearLayout.LayoutParams(-1, -2))
            val scrollParams = LinearLayout.LayoutParams(-1, 0, 1.0f).apply { topMargin = 20 }
            addView(scrollContainer, scrollParams)
            visibility = View.GONE
        }
        updateClockTextSizes()
        root.addView(clockPanel, FrameLayout.LayoutParams(-1, -1))

        connectionBanner = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(22, 12, 22, 12)
            isClickable = true
            isFocusable = true
            contentDescription = "RoshanOS connection status. Open protected owner access."
            setOnClickListener { showAdminExit() }
            visibility = View.GONE
        }
        root.addView(
            connectionBanner,
            FrameLayout.LayoutParams(-2, -2).apply {
                gravity = Gravity.TOP or Gravity.END
                setMargins(16, 18, 18, 0)
            }
        )

        wifiSetupView = WifiSetupView(
            context = this,
            onConnected = {
                wifiSetupOverlay.visibility = View.GONE
                lastHomeState = null
                restoreHomeLauncher()
                refreshHomeState()
            },
            onOwnerRequested = { showAdminExit() }
        )
        val setupScroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(
                wifiSetupView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT
                )
            )
        }
        wifiSetupOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(setupScroll, FrameLayout.LayoutParams(-1, -1))
            visibility = View.GONE
        }
        root.addView(wifiSetupOverlay, FrameLayout.LayoutParams(-1, -1))

        val ownerPinSetupView = OwnerPinSetupView(this) {
            ownerPinSetupOverlay.visibility = View.GONE
            lastHomeState = null
            refreshHomeState()
            DevicePolicyController.enterMaintenanceMode(this, 15)
            window.insetsController?.show(WindowInsets.Type.systemBars())
            startActivity(Intent(this, MainActivity::class.java))
        }
        val ownerPinScroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(
                ownerPinSetupView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT
                )
            )
        }
        ownerPinSetupOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(ownerPinScroll, FrameLayout.LayoutParams(-1, -1))
            visibility = View.GONE
        }
        root.addView(ownerPinSetupOverlay, FrameLayout.LayoutParams(-1, -1))

        enrollmentSetupOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(LinearLayout(this@KioskActivity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(48, 56, 48, 48)
                addView(TextView(this@KioskActivity).apply {
                    text = "ROSHANOS"
                    setTextColor(Color.parseColor("#00A2FF"))
                    textSize = 18f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    letterSpacing = 0.18f
                    gravity = Gravity.CENTER
                }, LinearLayout.LayoutParams(-1, -2))
                addView(TextView(this@KioskActivity).apply {
                    text = "Owner provisioning required"
                    setTextColor(Color.WHITE)
                    textSize = 31f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    gravity = Gravity.CENTER
                    setPadding(0, 18, 0, 4)
                }, LinearLayout.LayoutParams(-1, -2))
                addView(TextView(this@KioskActivity).apply {
                    text = "Connect this tablet to the authorized setup computer and run provision-tablet-via-adb.ps1"
                    setTextColor(Color.parseColor("#A8B3C7"))
                    textSize = 17f
                    gravity = Gravity.CENTER
                    setPadding(32, 20, 32, 24)
                }, LinearLayout.LayoutParams(-1, -2))
                addView(Button(this@KioskActivity).apply {
                    text = "Protected owner recovery"
                    isAllCaps = false
                    setOnClickListener { showAdminExit() }
                }, LinearLayout.LayoutParams(-1, -2))
            }, FrameLayout.LayoutParams(-1, -1))
            visibility = View.GONE
        }
        root.addView(enrollmentSetupOverlay, FrameLayout.LayoutParams(-1, -1))

        operationalGateText = TextView(this).apply {
            setTextColor(Color.parseColor("#A8B3C7"))
            textSize = 17f
            gravity = Gravity.CENTER
            setPadding(36, 20, 36, 26)
        }
        val operationalContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 56, 48, 48)
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(TextView(this@KioskActivity).apply {
                text = "ROSHANOS"
                setTextColor(Color.parseColor("#00A2FF"))
                textSize = 18f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                letterSpacing = 0.18f
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(-1, -2))
            addView(TextView(this@KioskActivity).apply {
                text = "Connecting securely"
                setTextColor(Color.WHITE)
                textSize = 31f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(0, 18, 0, 4)
            }, LinearLayout.LayoutParams(-1, -2))
            addView(operationalGateText, LinearLayout.LayoutParams(-1, -2))
            addView(Button(this@KioskActivity).apply {
                text = "Retry now"
                isAllCaps = false
                setOnClickListener {
                    WifiProvisioningManager.requestReconnect(this@KioskActivity)
                }
            }, LinearLayout.LayoutParams(-1, -2))
            addView(Button(this@KioskActivity).apply {
                text = "Protected owner recovery"
                isAllCaps = false
                setOnClickListener { showAdminExit() }
            }, LinearLayout.LayoutParams(-1, -2).apply {
                topMargin = 12
            })
        }
        operationalGateOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(operationalContent, FrameLayout.LayoutParams(-1, -1))
            visibility = View.GONE
        }
        root.addView(operationalGateOverlay, FrameLayout.LayoutParams(-1, -1))

        messageText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 34f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.TRANSPARENT)
            setShadowLayer(10f, 0f, 3f, Color.BLACK)
            visibility = View.GONE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        root.addView(messageText, FrameLayout.LayoutParams(-1, -1))

        val lockContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#660B0E14"))

            val lockIcon = TextView(this@KioskActivity).apply {
                text = "🔒"
                textSize = 54f
                gravity = Gravity.CENTER
            }
            val lockTitle = TextView(this@KioskActivity).apply {
                text = "Access Lock"
                setTextColor(Color.WHITE)
                textSize = 24f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(0, 16, 0, 8)
            }
            val lockSub = TextView(this@KioskActivity).apply {
                text = "This lock releases automatically.\nTap top-left 7 times for protected owner recovery."
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 14f
                gravity = Gravity.CENTER
                setLineSpacing(6f, 1f)
            }

            addView(lockIcon)
            addView(lockTitle)
            addView(lockSub)
        }

        touchLockView = FrameLayout(this).apply {
            isClickable = true
            isFocusable = true
            setOnTouchListener { _, _ -> true }
            addView(lockContent, FrameLayout.LayoutParams(-1, -1))
            visibility = View.GONE
        }
        root.addView(touchLockView, FrameLayout.LayoutParams(-1, -1))

        // Only the temporary Access Lock fallback blocks shade-edge touches.
        accessLockTopBarrier = View(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            isClickable = true
            isFocusable = false
            setOnTouchListener { _, event -> event.y < 80f }
            visibility = View.GONE
        }
        root.addView(accessLockTopBarrier, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, 80
        ).apply { gravity = Gravity.TOP })
    }

    private fun buildCalendarWidget(): LinearLayout {
        val calendarLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(20, 16, 20, 16)
            val cornerRadius = (16 * resources.displayMetrics.density).toInt()
            val shape = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#111827"))
                setCornerRadius(cornerRadius.toFloat())
                setStroke(2, Color.parseColor("#1E293B"))
            }
            background = shape
        }

        val cal = java.util.Calendar.getInstance()
        val monthYearFormat = java.text.SimpleDateFormat("MMMM yyyy", java.util.Locale.US)
        val monthTitle = TextView(this).apply {
            text = monthYearFormat.format(cal.time).uppercase(java.util.Locale.US)
            setTextColor(Color.parseColor("#00A2FF"))
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 10)
        }
        calendarLayout.addView(monthTitle)

        val daysOfWeek = arrayOf("S", "M", "T", "W", "T", "F", "S")
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 7f
        }
        for (day in daysOfWeek) {
            val dayText = TextView(this).apply {
                text = day
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 12f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
            }
            headerRow.addView(dayText, LinearLayout.LayoutParams(0, -2, 1f))
        }
        calendarLayout.addView(headerRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 6 })

        val calGrid = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.DAY_OF_MONTH, 1)
        }
        val firstDayOfWeek = calGrid.get(java.util.Calendar.DAY_OF_WEEK) - 1
        val maxDays = calGrid.getActualMaximum(java.util.Calendar.DAY_OF_MONTH)
        val today = java.util.Calendar.getInstance().get(java.util.Calendar.DAY_OF_MONTH)

        var dayCounter = 1 - firstDayOfWeek

        for (week in 0 until 5) {
            val weekRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                weightSum = 7f
            }
            for (dayCol in 0 until 7) {
                val dayView = TextView(this).apply {
                    gravity = Gravity.CENTER
                    textSize = 13f
                    if (dayCounter in 1..maxDays) {
                        text = dayCounter.toString()
                        if (dayCounter == today) {
                            setTextColor(Color.parseColor("#090D16"))
                            typeface = android.graphics.Typeface.DEFAULT_BOLD
                            val circle = android.graphics.drawable.GradientDrawable().apply {
                                setColor(Color.parseColor("#00A2FF"))
                                shape = android.graphics.drawable.GradientDrawable.OVAL
                            }
                            background = circle
                        } else {
                            setTextColor(Color.parseColor("#E2E8F0"))
                        }
                    } else {
                        text = ""
                    }
                }
                dayCounter++
                weekRow.addView(dayView, LinearLayout.LayoutParams(0, (26 * resources.displayMetrics.density).toInt(), 1f))
            }
            calendarLayout.addView(weekRow, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 2 })
        }
        return calendarLayout
    }

    private fun updateClockTextSizes(isClockOnly: Boolean = false) {
        val isLandscape = resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        if (isClockOnly) {
            val cyanColor = Color.parseColor("#00A2FF")
            clockTimeText.setTextColor(cyanColor)
            clockDateText.setTextColor(cyanColor)
            clockTimeText.textScaleX = 0.60f
            clockDateText.textScaleX = 0.60f
            if (isLandscape) {
                clockTimeText.textSize = 340f
                clockDateText.textSize = 44f
                (clockDateText.layoutParams as? LinearLayout.LayoutParams)?.topMargin = 20
            } else {
                clockTimeText.textSize = 320f
                clockDateText.textSize = 44f
                (clockDateText.layoutParams as? LinearLayout.LayoutParams)?.topMargin = 24
            }
            clockDateText.letterSpacing = 0.10f
        } else {
            clockTimeText.textScaleX = 1.0f
            clockDateText.textScaleX = 1.0f
            if (isLandscape) {
                clockTimeText.textSize = 84f
                clockDateText.textSize = 20f
                (clockDateText.layoutParams as? LinearLayout.LayoutParams)?.topMargin = 8
            } else {
                clockTimeText.textSize = 76f
                clockDateText.textSize = 18f
                (clockDateText.layoutParams as? LinearLayout.LayoutParams)?.topMargin = 10
            }
            clockDateText.letterSpacing = 0.08f
            populateAppGrid()
        }
    }

    private fun populateAppGrid() {
        if (!::appGridContainer.isInitialized) return
        appGridContainer.removeAllViews()
        val pm = packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
        val resolveInfos = pm.queryIntentActivities(mainIntent, 0)
        val approvedSet = ApprovedApps.approvedPackages(this)
        val isLandscape = resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        val cols = if (isLandscape) 5 else 3
        appGridContainer.columnCount = cols

        val displayMetrics = resources.displayMetrics
        val totalPadding = (32 + 32 + (cols * 16)).toFloat() * displayMetrics.density
        val tileWidth = ((displayMetrics.widthPixels - totalPadding) / cols).toInt().coerceAtLeast(140)

        for (info in resolveInfos) {
            val pkg = info.activityInfo.packageName
            if (pkg !in approvedSet || !ApprovedApps.isApprovable(this, pkg)) continue

            val label = info.loadLabel(pm).toString()
            val icon = try { info.loadIcon(pm) } catch (_: Exception) { null }

            val tile = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(16, 20, 16, 20)
                isClickable = true
                isFocusable = true
                setBackgroundResource(android.R.drawable.list_selector_background)

                val iconView = ImageView(this@KioskActivity).apply {
                    if (icon != null) setImageDrawable(icon)
                    else setImageResource(android.R.drawable.sym_def_app_icon)
                }
                val iconSize = (64 * displayMetrics.density).toInt()
                addView(iconView, LinearLayout.LayoutParams(iconSize, iconSize).apply { gravity = Gravity.CENTER })

                val labelView = TextView(this@KioskActivity).apply {
                    text = label
                    setTextColor(Color.WHITE)
                    textSize = 14f
                    gravity = Gravity.CENTER
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                }
                addView(labelView, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12 })

                setOnClickListener {
                    try {
                        val launchIntent = pm.getLaunchIntentForPackage(pkg)
                        if (launchIntent != null) {
                            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(launchIntent)
                        }
                    } catch (_: Exception) {
                        Toast.makeText(this@KioskActivity, "Unable to launch $label", Toast.LENGTH_SHORT).show()
                    }
                }
            }

            val gridParams = GridLayout.LayoutParams().apply {
                width = tileWidth
                height = GridLayout.LayoutParams.WRAP_CONTENT
                setMargins(8, 8, 8, 8)
            }
            appGridContainer.addView(tile, gridParams)
        }
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        val mode = KioskController.displayMode(this)
        updateClockTextSizes(isClockOnly = (mode == "clock"))
    }

    private fun startClockUpdates() {
        stopClockUpdates()
        populateAppGrid()
        val runnable = object : Runnable {
            override fun run() {
                val now = java.util.Date()
                val timeFmt = java.text.SimpleDateFormat("hh:mm", java.util.Locale.US)
                val dateFmt = java.text.SimpleDateFormat("EEEE, MMMM d", java.util.Locale.US)
                clockTimeText.text = timeFmt.format(now)
                clockDateText.text = dateFmt.format(now).uppercase(java.util.Locale.US)
                handler.postDelayed(this, 1000L)
            }
        }
        clockRunnable = runnable
        handler.post(runnable)
    }

    private fun restoreHomeLauncher() {
        pendingRetry?.let(handler::removeCallbacks)
        webView.stopLoading()
        webView.visibility = View.GONE
        statusPanel.visibility = View.GONE
        clockPanel.visibility = View.VISIBLE
        clockPanel.gravity = Gravity.CENTER_HORIZONTAL
        clockPanel.setBackgroundColor(Color.parseColor("#0B0E14"))
        if (::scrollContainer.isInitialized && scrollContainer.parent == null) {
            val scrollParams = LinearLayout.LayoutParams(-1, 0, 1.0f).apply { topMargin = 20 }
            clockPanel.addView(scrollContainer, scrollParams)
        }
        if (::scrollContainer.isInitialized) scrollContainer.visibility = View.VISIBLE
        if (::calendarWidgetContainer.isInitialized) calendarWidgetContainer.visibility = View.VISIBLE
        if (::appGridContainer.isInitialized) appGridContainer.visibility = View.VISIBLE
        updateClockTextSizes(isClockOnly = false)
        startClockUpdates()
    }

    /**
     * Signage remains the foreground experience if its controller origin
     * disappears while ordinary Wi-Fi is still connected. The player can then
     * continue its previously verified Cache API playlist. For other managed
     * pages, preserve the already rendered frame while the whole device is
     * offline, matching the existing fail-soft behavior.
     */
    private fun shouldPreserveRenderedContent(failedUri: Uri? = null): Boolean {
        if (!CredentialStore.isEnrolled(this)) return false
        if (!WifiProvisioningManager.isConnected(this)) return true
        val candidates = listOfNotNull(
            failedUri,
            webView.url?.let(Uri::parse),
            KioskController.currentUrl(this)?.let(Uri::parse),
            KioskController.dashboardUrl(this).let(Uri::parse)
        )
        return candidates.any { uri ->
            uri.path?.trimEnd('/') == "/signage-player.html"
        }
    }

    private fun stopClockUpdates() {
        clockRunnable?.let(handler::removeCallbacks)
        clockRunnable = null
    }

    private fun startHomeStateUpdates() {
        stopHomeStateUpdates()
        val runnable = object : Runnable {
            override fun run() {
                refreshHomeState()
                handler.postDelayed(this, 1_000L)
            }
        }
        homeStateRunnable = runnable
        handler.post(runnable)
    }

    private fun stopHomeStateUpdates() {
        homeStateRunnable?.let(handler::removeCallbacks)
        homeStateRunnable = null
    }

    private fun refreshHomeState() {
        if (!::connectionBanner.isInitialized ||
            !::wifiSetupOverlay.isInitialized ||
            !::ownerPinSetupOverlay.isInitialized ||
            !::enrollmentSetupOverlay.isInitialized ||
            !::operationalGateOverlay.isInitialized
        ) {
            return
        }

        val connected = WifiProvisioningManager.isConnected(this)
        val nowElapsed = SystemClock.elapsedRealtime()
        if (connected) {
            hadConnectedWifiThisProcess = true
            wifiDisconnectedSinceElapsedMs = 0L
        } else if (wifiDisconnectedSinceElapsedMs == 0L) {
            wifiDisconnectedSinceElapsedMs = nowElapsed
        }
        val enrolled = CredentialStore.isEnrolled(this)
        val readiness = RoshanRuntimeReadiness.snapshot()
        val readinessGraceMs =
            RoshanReadinessPolicy.graceRemainingMs(readiness, nowElapsed)
        val localWifiGrace =
            hadConnectedWifiThisProcess &&
                wifiDisconnectedSinceElapsedMs > 0L &&
                nowElapsed - wifiDisconnectedSinceElapsedMs <
                RoshanReadinessPolicy.TRANSIENT_FAILURE_GRACE_MS
        val pinConfigured =
            AdminPinStore.getState(this) != AdminPinStore.State.PIN_NOT_CONFIGURED
        val state = RoshanHomeState.resolve(
            RoshanHomeInputs(
                wifiConnected = connected,
                hasSavedNetwork = WifiProvisioningManager.hasSavedNetwork(this),
                enrolled = enrolled,
                ownerPinConfigured = pinConfigured,
                wifiGraceActive = enrolled && (localWifiGrace || readinessGraceMs > 0L),
                readinessKnown = readiness.known,
                privateNetworkConnected = readiness.privateNetworkConnected,
                requiredServicesReady = readiness.requiredServicesReady,
                operationalGraceActive =
                    enrolled && connected && readinessGraceMs > 0L
            )
        )
        val previous = lastHomeState
        val setupChanged = previous?.setupStep != state.setupStep
        lastHomeState = state

        wifiSetupOverlay.visibility =
            if (state.setupStep == RoshanHomeUiState.SetupStep.WIFI) View.VISIBLE else View.GONE
        ownerPinSetupOverlay.visibility =
            if (state.setupStep == RoshanHomeUiState.SetupStep.OWNER_PIN) View.VISIBLE else View.GONE
        enrollmentSetupOverlay.visibility =
            if (state.setupStep == RoshanHomeUiState.SetupStep.ENROLLMENT) View.VISIBLE else View.GONE
        operationalGateOverlay.visibility =
            if (state.setupStep == RoshanHomeUiState.SetupStep.CONNECTING ||
                state.setupStep == RoshanHomeUiState.SetupStep.RECOVERY
            ) {
                View.VISIBLE
            } else {
                View.GONE
            }

        operationalGateText.text = when (state.setupStep) {
            RoshanHomeUiState.SetupStep.CONNECTING -> when {
                !readiness.known ->
                    "RoshanCore is starting and checking the private network."
                !readiness.privateNetworkConnected ->
                    "Wi-Fi is connected. Waiting for the private network to reconnect."
                else ->
                    "Verifying RoshanOS services."
            }
            RoshanHomeUiState.SetupStep.RECOVERY -> {
                val unready = readiness.requiredComponentsUnready
                if (unready.isEmpty()) {
                    "A required RoshanOS service is recovering with bounded retries. " +
                        "Normal applications remain blocked until the service gate passes."
                } else {
                    "Waiting for required service" +
                        (if (unready.size > 1) "s: " else ": ") +
                        unready.joinToString(", ") +
                        ". Recovery continues automatically with bounded retries; " +
                        "applications stay blocked until the service gate passes."
                }
            }
            else -> ""
        }

        if (setupChanged && state.setupStep == RoshanHomeUiState.SetupStep.WIFI) {
            wifiSetupView.refreshConnectionLabel()
            wifiSetupView.refreshNetworks()
        }

        connectionBanner.text = RoshanHomeState.bannerText(state)
        connectionBanner.background = android.graphics.drawable.GradientDrawable().apply {
            val (fill, stroke) = when (state.bannerTone) {
                RoshanHomeUiState.BannerTone.CONNECTED -> "#C9163A2D" to "#3FB982"
                RoshanHomeUiState.BannerTone.ATTENTION -> "#D14B3514" to "#F59E0B"
                RoshanHomeUiState.BannerTone.OFFLINE -> "#D13D2027" to "#FB7185"
            }
            setColor(Color.parseColor(fill))
            setStroke(
                (resources.displayMetrics.density).toInt().coerceAtLeast(1),
                Color.parseColor(stroke)
            )
            cornerRadius = 18f * resources.displayMetrics.density
        }

        val shouldShowBanner = !state.showSetupGate &&
            (!connected || !enrolled || clockPanel.visibility == View.VISIBLE)
        connectionBanner.visibility = if (shouldShowBanner) View.VISIBLE else View.GONE

        if (!connected && enrolled) {
            val now = System.currentTimeMillis()
            if (now - lastReconnectRequestAt >= 15_000L) {
                lastReconnectRequestAt = now
                WifiProvisioningManager.requestReconnect(this)
            }
        }

        // Once Wi-Fi is available, first-run setup advances to the owner PIN
        // gate. It never falls through to ordinary Home while unprotected.
        if (previous?.showSetupGate == true && !state.showSetupGate) {
            applyRenderIntent(null)
        }
    }

    private fun handleRuntimeReadinessChanged() {
        if (isVisible) refreshHomeState()
        scheduleReadinessGateEnforcement()
    }

    private fun scheduleReadinessGateEnforcement() {
        pendingReadinessGate?.let(handler::removeCallbacks)
        pendingReadinessGate = null
        val readiness = RoshanRuntimeReadiness.snapshot()
        if (readiness.homeReady) return
        val delayMs = RoshanReadinessPolicy.graceRemainingMs(
            readiness,
            SystemClock.elapsedRealtime()
        )
        val runnable = object : Runnable {
            override fun run() {
                val current = RoshanRuntimeReadiness.snapshot()
                if (current.homeReady ||
                    DevicePolicyController.isMaintenanceMode(this@KioskActivity)
                ) {
                    pendingReadinessGate = null
                    return
                }
                if (AccessLockManager.isLocked(this@KioskActivity)) {
                    handler.postDelayed(this, 5_000L)
                    return
                }
                pendingReadinessGate = null
                if (!isVisible) {
                    KioskController.bringToForeground(this@KioskActivity)
                } else {
                    refreshHomeState()
                }
            }
        }
        pendingReadinessGate = runnable
        handler.postDelayed(runnable, delayMs)
    }

    private fun applyTouchLockIntent(@Suppress("UNUSED_PARAMETER") intent: Intent?) {
        // Never trust a stale Intent extra. The process-only monotonic state is
        // authoritative and is always unlocked after a fresh process start.
        val enabled = AccessLockManager.isLocked(this)
        touchLockView.visibility = if (enabled) View.VISIBLE else View.GONE
        accessLockTopBarrier.visibility = if (enabled) View.VISIBLE else View.GONE
        applyActivityLockTaskState(enabled)
    }

    private fun applyActivityLockTaskState(enabled: Boolean) {
        val activityManager =
            getSystemService(ACTIVITY_SERVICE) as ActivityManager
        val dpm =
            getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val deviceOwner = DevicePolicyController.isDeviceOwner(this)
        val shouldRunManagedLockTask =
            enabled || (deviceOwner && !DevicePolicyController.isMaintenanceMode(this))

        if (shouldRunManagedLockTask) {
            if (!deviceOwner ||
                !dpm.isLockTaskPermitted(packageName) ||
                activityManager.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
            ) {
                return
            }
            try {
                startLockTask()
            } catch (_: Exception) {
                // The overlay remains authoritative; lock-task is best effort.
            }
            return
        }

        // Protected maintenance is the only normal state that leaves managed
        // lock-task. This prevents enabled technical Activities or Settings
        // from surfacing while still allowing Home/Overview and every
        // approved allowlisted application in ordinary RoshanOS use.
        if (activityManager.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            try {
                stopLockTask()
            } catch (_: Exception) {
                // ADB/device-owner maintenance remains available for recovery.
            }
        }
    }

    private fun applyOrientationIntent(intent: Intent?) {
        val orientation = intent?.getStringExtra(KioskController.EXTRA_ORIENTATION)
            ?: getSharedPreferences("kiosk", MODE_PRIVATE).getString("saved_orientation", "auto")
        requestedOrientation = when (orientation) {
            "portrait" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            "landscape" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            "reverse-portrait" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
            "reverse-landscape" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            else -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private fun applyClockColorIntent(intent: Intent?) {
        val colorHex = intent?.getStringExtra(KioskController.EXTRA_CLOCK_COLOR)
            ?: KioskController.clockColor(this)
        try {
            val parsedColor = Color.parseColor(colorHex)
            clockTimeText.setTextColor(parsedColor)
            clockDateText.setTextColor(parsedColor)
        } catch (_: Exception) {}
    }

    private fun applyRenderIntent(renderIntent: Intent?) {
        val mode = renderIntent?.getStringExtra(KioskController.EXTRA_MODE)
            ?: KioskController.displayMode(this)
        when (mode) {
            "clock" -> {
                pendingRetry?.let(handler::removeCallbacks)
                webView.stopLoading()
                webView.visibility = View.GONE
                statusPanel.visibility = View.GONE
                if (::scrollContainer.isInitialized && scrollContainer.parent == clockPanel) {
                    clockPanel.removeView(scrollContainer)
                }
                clockPanel.visibility = View.VISIBLE
                clockPanel.gravity = Gravity.CENTER
                clockPanel.setBackgroundColor(Color.BLACK)
                enterImmersiveMode()
                // Persist cyan so applyClockColorIntent always reads it back correctly
                KioskController.setClockColor(this, "#00A2FF")
                val cyanColor = Color.parseColor("#00A2FF")
                clockTimeText.setTextColor(cyanColor)
                clockDateText.setTextColor(cyanColor)
                updateClockTextSizes(isClockOnly = true)
                startClockUpdates()
                // Re-enforce cyan after startClockUpdates in case anything overrides
                clockTimeText.setTextColor(cyanColor)
                clockDateText.setTextColor(cyanColor)
            }

            KioskController.MODE_BLACK -> {
                stopClockUpdates()
                pendingRetry?.let(handler::removeCallbacks)
                webView.stopLoading()
                webView.visibility = View.GONE
                clockPanel.visibility = View.GONE
                statusPanel.visibility = View.GONE
                root.setBackgroundColor(Color.BLACK)
            }

            KioskController.MODE_WEBPAGE -> {
                stopClockUpdates()
                clockPanel.visibility = View.GONE
                statusPanel.visibility = View.GONE
                webView.visibility = View.VISIBLE
                val url = renderIntent?.getStringExtra(KioskController.EXTRA_URL)
                    ?: KioskController.currentUrl(this)
                if (url != null) loadUrl(url)
            }

            else -> {
                if (KioskController.isDashboardConfigured(this)) {
                    stopClockUpdates()
                    clockPanel.visibility = View.GONE
                    statusPanel.visibility = View.GONE
                    webView.visibility = View.VISIBLE
                    val url = renderIntent?.getStringExtra(KioskController.EXTRA_URL)
                        ?: KioskController.currentUrl(this)
                            ?: KioskController.dashboardUrl(this)
                    loadUrl(url)
                } else {
                    restoreHomeLauncher()
                }
            }
        }
        renderIntent?.getStringExtra(KioskController.EXTRA_MESSAGE)?.let { text ->
            val durationMs = renderIntent.getLongExtra(
                KioskController.EXTRA_MESSAGE_DURATION_MS,
                5_000L
            )
            showTypedMessage(text, durationMs)
            return
        }
        renderIntent?.getStringExtra(KioskController.EXTRA_LIVE_TEXT)?.let { text ->
            showLiveText(text)
            return
        }
        if (renderIntent?.getBooleanExtra(KioskController.EXTRA_CLEAR_MESSAGE, false) == true) {
            clearMessage()
        }
    }

    private fun showLiveText(text: String) {
        messageHandler.removeCallbacksAndMessages(null)
        messageText.text = text
        messageText.visibility = View.VISIBLE
        messageText.announceForAccessibility(text)
    }

    private fun clearMessage() {
        messageHandler.removeCallbacksAndMessages(null)
        messageText.visibility = View.GONE
        messageText.text = ""
    }

    private fun showTypedMessage(text: String, durationMs: Long) {
        messageHandler.removeCallbacksAndMessages(null)
        messageText.text = ""
        messageText.visibility = View.VISIBLE
        messageText.announceForAccessibility(text)

        val hide = Runnable {
            messageText.visibility = View.GONE
            messageText.text = ""
        }
        if (!ValueAnimator.areAnimatorsEnabled()) {
            messageText.text = text
            messageHandler.postDelayed(hide, durationMs.coerceIn(1_000L, 300_000L))
            return
        }

        var characterIndex = 0
        val typeNextCharacter = object : Runnable {
            override fun run() {
                characterIndex += 1
                messageText.text = text.substring(0, characterIndex)
                if (characterIndex < text.length) {
                    messageHandler.postDelayed(this, 45L)
                } else {
                    messageHandler.postDelayed(
                        hide,
                        durationMs.coerceIn(1_000L, 300_000L)
                    )
                }
            }
        }
        messageHandler.post(typeNextCharacter)
    }

    private fun loadConfiguredPage() {
        val url = KioskController.currentUrl(this) ?: KioskController.dashboardUrl(this)
        loadUrl(url)
    }

    private fun loadUrl(url: String) {
        pendingRetry?.let(handler::removeCallbacks)
        statusPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.settings.cacheMode =
            if (CredentialStore.isEnrolled(this) &&
                !WifiProvisioningManager.isConnected(this)
            ) {
                android.webkit.WebSettings.LOAD_CACHE_ELSE_NETWORK
            } else {
                android.webkit.WebSettings.LOAD_DEFAULT
            }
        val safeUrl = if (url.contains(":3001") || url.contains("Home Remote") || url.contains("login")) {
            "http://127.0.0.1:8765/clock"
        } else {
            url
        }
        val safeUri = Uri.parse(safeUrl)
        if (!KioskController.isSafeDisplayUri(safeUri)) {
            restoreHomeLauncher()
            return
        }
        allowedTopLevelOrigin = webOrigin(safeUri)
        webView.loadUrl(safeUrl)
    }

    private fun webOrigin(uri: Uri): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1) defaultPort else uri.port
        return "$scheme://$host:$port"
    }

    private fun showOffline(message: String) {
        statusText.text = "$message\n\nThe kiosk will retry automatically."
        statusPanel.visibility = View.VISIBLE
        val delay = minOf(30_000L, 2_000L * (1L shl minOf(retryCount, 10)))
        retryCount += 1
        pendingRetry?.let(handler::removeCallbacks)
        pendingRetry = Runnable { loadConfiguredPage() }.also {
            handler.postDelayed(it, delay)
        }
    }

    private fun enterImmersiveMode() {
        window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    private fun showAdminExit() {
        val accessLockActive = AccessLockManager.isLocked(this)
        val input = EditText(this).apply {
            hint = "Owner PIN"
            inputType =
                android.text.InputType.TYPE_CLASS_NUMBER or
                    android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
        val builder = AlertDialog.Builder(this)
            .setTitle(
                if (accessLockActive) "Protected Access Lock recovery"
                else "RoshanOS administration"
            )
            .setMessage(
                if (accessLockActive) {
                    "Enter the configured PBKDF2-protected owner PIN to release Access Lock."
                } else {
                    "Enter the owner PIN to open the local admin screen."
                }
            )
            .setView(input)
            .setPositiveButton(if (accessLockActive) "Unlock" else "Open") { _, _ ->
                val result = AdminPinStore.verifyPin(this, input.text.toString())
                when (result) {
                    is AdminPinStore.PinVerificationResult.Success -> {
                        if (accessLockActive) {
                            val released = KioskController.setTouchLock(this, false)
                            if (released) {
                                Log.i(TAG, "Local owner recovery confirmed Access Lock release")
                            } else {
                                Log.e(
                                    TAG,
                                    "Local owner PIN accepted, but Access Lock policy release " +
                                        "was not confirmed"
                                )
                            }
                            Toast.makeText(
                                this,
                                if (released) {
                                    "Access Lock released."
                                } else {
                                    "PIN accepted, but policy release was not confirmed. " +
                                        "RoshanOS is retrying."
                                },
                                if (released) Toast.LENGTH_SHORT else Toast.LENGTH_LONG
                            ).show()
                        } else {
                            DevicePolicyController.enterMaintenanceMode(this, 15)
                            window.insetsController?.show(WindowInsets.Type.systemBars())
                            startActivity(Intent(this, MainActivity::class.java))
                        }
                    }
                    is AdminPinStore.PinVerificationResult.Unconfigured -> {
                        Toast.makeText(
                            this,
                            if (accessLockActive) {
                                "No recovery PIN is configured. Use protected remote release or ADB."
                            } else {
                                "Owner PIN setup is available only in the non-skippable RoshanOS setup flow."
                            },
                            Toast.LENGTH_LONG
                        ).show()
                    }
                    is AdminPinStore.PinVerificationResult.Failed -> {
                        Toast.makeText(
                            this,
                            "Incorrect PIN. ${result.attemptsRemaining} attempts remaining.",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    is AdminPinStore.PinVerificationResult.Cooldown -> {
                        Toast.makeText(
                            this,
                            "Too many failed attempts. Try again in ${result.secondsRemaining} seconds.",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                    is AdminPinStore.PinVerificationResult.RecoveryLocked -> {
                        Toast.makeText(
                            this,
                            "Local PIN verification is locked. Use the authenticated owner controller or ADB recovery.",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }

        builder.show()
    }

    companion object {
        private const val TAG = "RoshanHome"

        @Volatile
        var isVisible: Boolean = false
            private set

        @Volatile
        var lastPageLoadedAtMs: Long = 0L
            private set

        @Volatile
        var lastPageErrorAtMs: Long = 0L
            private set
    }
}
