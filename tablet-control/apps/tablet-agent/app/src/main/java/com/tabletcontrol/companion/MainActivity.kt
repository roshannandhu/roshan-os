package com.tabletcontrol.companion

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * Local, unexported owner maintenance. The old one-time pairing-code screen
 * is replaced with ADB-only provisioning — no code appears on this screen.
 */
class MainActivity : Activity() {
    private lateinit var statusText: TextView
    private lateinit var provisioningNotice: TextView
    private lateinit var wifiSetupView: WifiSetupView
    private val handler = Handler(Looper.getMainLooper())
    private var statusRunnable: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(30), dp(28), dp(38))
            setBackgroundColor(Color.rgb(11, 14, 20))
        }

        content.addView(TextView(this).apply {
            text = "ROSHANOS"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.18f
            setTextColor(Color.parseColor("#00A2FF"))
            gravity = Gravity.CENTER
        })

        content.addView(TextView(this).apply {
            text = "Protected owner"
            textSize = 28f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, dp(18))
        })

        statusText = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.parseColor("#CBD5E1"))
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = cardBackground()
        }
        content.addView(statusText, LinearLayout.LayoutParams(-1, -2))

        provisioningNotice = TextView(this).apply {
            text = "Provisioning uses ADB — connect via PC and run provision-tablet-via-adb.ps1"
            textSize = 14f
            setTextColor(Color.parseColor("#F59E0B"))
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(14), dp(18), dp(14))
            background = cardBackground()
        }
        content.addView(provisioningNotice, LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(12)
        })

        wifiSetupView = WifiSetupView(
            context = this,
            onConnected = {
                refreshStatus()
                Toast.makeText(this, "Wi-Fi connected.", Toast.LENGTH_SHORT).show()
            },
            compact = true
        )
        content.addView(wifiSetupView, LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(16)
        })

        content.addView(Button(this).apply {
            text = "Return to RoshanOS Home"
            isAllCaps = false
            setOnClickListener {
                KioskController.bringToForeground(this@MainActivity)
                finish()
            }
        }, LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(18)
        })

        content.addView(Button(this).apply {
            text = "End maintenance session"
            isAllCaps = false
            setOnClickListener {
                DevicePolicyController.exitMaintenanceMode(this@MainActivity)
                KioskController.bringToForeground(this@MainActivity)
                finish()
            }
        }, LinearLayout.LayoutParams(-1, -2))

        content.addView(TextView(this).apply {
            text =
                "This protected screen expires automatically. RoshanCore keeps running " +
                    "silently when maintenance closes."
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(Color.GRAY)
            setPadding(dp(8), dp(24), dp(8), 0)
        })

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setBackgroundColor(Color.rgb(11, 14, 20))
            addView(content, android.widget.FrameLayout.LayoutParams(-1, -2))
        }
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        if (!verifyMaintenanceSession()) return
        startStatusUpdates()
        wifiSetupView.refreshConnectionLabel()
    }

    override fun onPause() {
        stopStatusUpdates()
        super.onPause()
    }

    override fun onDestroy() {
        stopStatusUpdates()
        super.onDestroy()
    }

    @Deprecated("Owner maintenance closes back to RoshanOS Home.")
    override fun onBackPressed() {
        KioskController.bringToForeground(this)
        finish()
    }

    private fun startStatusUpdates() {
        stopStatusUpdates()
        val runnable = object : Runnable {
            override fun run() {
                if (!verifyMaintenanceSession()) return
                refreshStatus()
                handler.postDelayed(this, 1_000L)
            }
        }
        statusRunnable = runnable
        handler.post(runnable)
    }

    private fun stopStatusUpdates() {
        statusRunnable?.let(handler::removeCallbacks)
        statusRunnable = null
    }

    private fun refreshStatus() {
        val maintenance = DevicePolicyController.getMaintenanceStatus(this)
        val remaining = (maintenance["remainingSeconds"] as? Number)?.toLong() ?: 0L
        val ownerState =
            if (DevicePolicyController.isDeviceOwner(this)) "Active" else "Provisioning required"
        val enrollmentState =
            if (CredentialStore.isEnrolled(this)) "Enrolled" else "Not provisioned"
        val wifiState = if (WifiProvisioningManager.isConnected(this)) {
            WifiProvisioningManager.currentSsid(this)?.let { "Connected to $it" } ?: "Connected"
        } else {
            "Offline • reconnecting"
        }
        statusText.text =
            "Device Owner: $ownerState\n" +
                "Enrollment: $enrollmentState\n" +
                "Wi-Fi: $wifiState\n" +
                "Maintenance: ${remaining / 60}m ${remaining % 60}s\n" +
                "RoshanCore: ${BuildConfig.VERSION_NAME}"

        provisioningNotice.visibility = if (CredentialStore.isEnrolled(this)) View.GONE else View.VISIBLE
    }

    private fun verifyMaintenanceSession(): Boolean {
        if (!CredentialStore.isEnrolled(this)) return true
        if (DevicePolicyController.isMaintenanceMode(this)) return true
        KioskController.bringToForeground(this)
        finish()
        return false
    }

    private fun cardBackground() = android.graphics.drawable.GradientDrawable().apply {
        setColor(Color.parseColor("#111827"))
        setStroke(dp(1), Color.parseColor("#243247"))
        cornerRadius = dp(14).toFloat()
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
