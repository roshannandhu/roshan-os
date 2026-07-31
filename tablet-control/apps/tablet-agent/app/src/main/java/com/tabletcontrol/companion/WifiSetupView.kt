package com.tabletcontrol.companion

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Branded in-app Wi-Fi chooser used by first-run setup and protected owner
 * maintenance. It never launches Android Settings and never persists or logs
 * the entered password.
 */
class WifiSetupView(
    context: Context,
    private val onConnected: () -> Unit,
    private val onOwnerRequested: (() -> Unit)? = null,
    private val compact: Boolean = false
) : LinearLayout(context) {
    private val handler = Handler(Looper.getMainLooper())
    private val ssidInput: EditText
    private val passwordInput: EditText
    private val connectionText: TextView
    private val statusText: TextView
    private val networkList: LinearLayout
    private var selectedSecured: Boolean? = null
    private var connectAttempt = 0
    private var connectionPoll: Runnable? = null

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(if (compact) 24 else 36), dp(24), dp(if (compact) 24 else 36), dp(28))
        setBackgroundColor(Color.parseColor("#0B0E14"))

        addView(TextView(context).apply {
            text = "ROSHANOS"
            setTextColor(Color.parseColor("#00A2FF"))
            textSize = if (compact) 16f else 18f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        addView(TextView(context).apply {
            text = if (compact) "Choose Wi-Fi" else "Connect this device"
            setTextColor(Color.WHITE)
            textSize = if (compact) 23f else 29f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, dp(6))
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        addView(TextView(context).apply {
            text = if (compact) {
                "Select another network. RoshanCore stays active during the change."
            } else {
                "Wi-Fi is the first step. Setup continues automatically after a usable connection is ready."
            }
            setTextColor(Color.parseColor("#A8B3C7"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), dp(18))
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        connectionText = TextView(context).apply {
            setTextColor(Color.parseColor("#CBD5E1"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = roundedBackground("#111827", "#243247")
        }
        addView(connectionText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        val refreshButton = Button(context).apply {
            text = "Scan for networks"
            isAllCaps = false
            setOnClickListener { refreshNetworks() }
        }
        addView(refreshButton, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(12)
        })

        networkList = LinearLayout(context).apply {
            orientation = VERTICAL
        }
        addView(networkList, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        passwordInput = EditText(context).apply {
            hint = "Wi-Fi password"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#70809A"))
            setSingleLine(true)
            inputType =
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        ssidInput = EditText(context).apply {
            hint = "Network name (SSID)"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#70809A"))
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    if (!hasFocus()) return
                    selectedSecured = null
                    passwordInput.visibility = View.VISIBLE
                }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        addView(ssidInput, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
        })

        addView(passwordInput, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        val connectButton = Button(context).apply {
            text = "Connect and continue"
            isAllCaps = false
            setOnClickListener { connect() }
        }
        addView(connectButton, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
        })

        statusText = TextView(context).apply {
            setTextColor(Color.parseColor("#A8B3C7"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(12), dp(8), dp(4))
        }
        addView(statusText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        if (onOwnerRequested != null) {
            addView(Button(context).apply {
                text = "Protected owner"
                isAllCaps = false
                setOnClickListener { onOwnerRequested.invoke() }
            }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(8)
            })
        }

        refreshConnectionLabel()
        refreshNetworks()
    }

    fun refreshConnectionLabel() {
        val connected = WifiProvisioningManager.isConnected(context)
        val ssid = WifiProvisioningManager.currentSsid(context)
        connectionText.text = when {
            connected && ssid != null -> "Connected to $ssid"
            connected -> "Wi-Fi connected"
            WifiProvisioningManager.hasSavedNetwork(context) -> "Offline • reconnecting"
            else -> "No usable Wi-Fi connection"
        }
    }

    fun refreshNetworks() {
        refreshConnectionLabel()
        statusText.text = "Scanning…"
        val networks = WifiProvisioningManager.scan(context)
        networkList.removeAllViews()

        if (networks.isEmpty()) {
            statusText.text = "No scan results yet. Refresh, or enter a visible network name below."
            return
        }

        for (network in networks.take(if (compact) 6 else 10)) {
            networkList.addView(Button(context).apply {
                val security = if (network.secured) "Secured" else "Open"
                text = "${network.ssid}  •  $security  •  ${signalLabel(network.signalLevel)}"
                isAllCaps = false
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setOnClickListener {
                    ssidInput.clearFocus()
                    ssidInput.setText(network.ssid)
                    selectedSecured = network.secured
                    passwordInput.visibility = if (network.secured) View.VISIBLE else View.GONE
                    if (!network.secured) passwordInput.text.clear()
                    statusText.text = if (network.secured) {
                        "Enter the password for ${network.ssid}."
                    } else {
                        "${network.ssid} is an open network."
                    }
                }
            }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(4)
            })
        }
        statusText.text = "Select a network, or enter its name manually."
    }

    private fun connect() {
        val ssid = ssidInput.text.toString()
        val password = passwordInput.text?.toString()
        val secured = selectedSecured ?: !password.isNullOrEmpty()
        val result = WifiProvisioningManager.connect(context, ssid, password, secured)
        // Remove the plaintext from the view immediately after Android accepts
        // or rejects it. WifiProvisioningManager never stores its own copy.
        passwordInput.text?.clear()

        when (result) {
            WifiProvisioningManager.ConnectResult.Started -> {
                statusText.setTextColor(Color.parseColor("#67E8F9"))
                statusText.text = "Connecting… Setup will continue automatically."
                connectAttempt = 0
                startConnectionPolling()
            }
            is WifiProvisioningManager.ConnectResult.Rejected -> {
                statusText.setTextColor(Color.parseColor("#FDBA74"))
                statusText.text = result.reason
            }
        }
    }

    private fun startConnectionPolling() {
        connectionPoll?.let(handler::removeCallbacks)
        val poll = object : Runnable {
            override fun run() {
                refreshConnectionLabel()
                if (WifiProvisioningManager.isConnected(context)) {
                    statusText.setTextColor(Color.parseColor("#86EFAC"))
                    statusText.text = "Connected. Continuing RoshanOS setup…"
                    onConnected()
                    return
                }
                connectAttempt += 1
                if (connectAttempt >= 30) {
                    statusText.setTextColor(Color.parseColor("#FDBA74"))
                    statusText.text =
                        "That network is not usable yet. Check the password or choose another network."
                    refreshNetworks()
                    return
                }
                handler.postDelayed(this, 1_000L)
            }
        }
        connectionPoll = poll
        handler.post(poll)
    }

    override fun onDetachedFromWindow() {
        connectionPoll?.let(handler::removeCallbacks)
        connectionPoll = null
        super.onDetachedFromWindow()
    }

    private fun signalLabel(level: Int): String = when (level.coerceIn(0, 4)) {
        4 -> "Excellent"
        3 -> "Good"
        2 -> "Fair"
        else -> "Weak"
    }

    private fun roundedBackground(fill: String, stroke: String) =
        android.graphics.drawable.GradientDrawable().apply {
            setColor(Color.parseColor(fill))
            setStroke(dp(1), Color.parseColor(stroke))
            cornerRadius = dp(14).toFloat()
        }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
