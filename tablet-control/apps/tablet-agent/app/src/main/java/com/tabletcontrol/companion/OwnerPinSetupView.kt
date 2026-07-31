package com.tabletcontrol.companion

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Non-skippable first-run owner setup. ADB provisioning remains unavailable
 * until this confirmation succeeds and a protected maintenance session is entered.
 */
class OwnerPinSetupView(
    context: Context,
    private val onPinConfigured: () -> Unit
) : LinearLayout(context) {
    private val pinInput: EditText
    private val confirmInput: EditText
    private val statusText: TextView

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(38), dp(48), dp(38), dp(38))
        setBackgroundColor(Color.parseColor("#0B0E14"))

        addView(TextView(context).apply {
            text = "ROSHANOS"
            setTextColor(Color.parseColor("#00A2FF"))
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        addView(TextView(context).apply {
            text = "Protect owner access"
            setTextColor(Color.WHITE)
            textSize = 29f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(8))
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        addView(TextView(context).apply {
            text =
                "The device owner must create and confirm a private PIN before RoshanOS Home " +
                    "or ADB provisioning becomes available. This PIN never leaves the tablet."
            setTextColor(Color.parseColor("#A8B3C7"))
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), dp(22))
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        pinInput = securePinField("New owner PIN (6–12 digits)")
        confirmInput = securePinField("Confirm owner PIN")
        addView(pinInput, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        addView(confirmInput, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        addView(Button(context).apply {
            text = "Protect this device"
            isAllCaps = false
            setOnClickListener { configurePin() }
        }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(12)
        })

        statusText = TextView(context).apply {
            setTextColor(Color.parseColor("#FDBA74"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(14), dp(8), 0)
        }
        addView(statusText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }

    private fun configurePin() {
        val pin = pinInput.text?.toString().orEmpty()
        val confirmation = confirmInput.text?.toString().orEmpty()
        when {
            !pin.matches(Regex("\\d{6,12}")) -> {
                statusText.text = "Use 6 to 12 digits."
            }
            pin != confirmation -> {
                statusText.text = "The confirmation does not match."
            }
            !AdminPinStore.setPin(context, pin) -> {
                statusText.text = "Owner protection could not be saved. Try again."
            }
            else -> {
                // Clear both plaintext copies before changing screens.
                pinInput.text?.clear()
                confirmInput.text?.clear()
                statusText.setTextColor(Color.parseColor("#86EFAC"))
                statusText.text = "Owner access protected."
                onPinConfigured()
            }
        }
    }

    private fun securePinField(fieldHint: String) = EditText(context).apply {
        hint = fieldHint
        setTextColor(Color.WHITE)
        setHintTextColor(Color.parseColor("#70809A"))
        setSingleLine(true)
        inputType =
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        filters = arrayOf(InputFilter.LengthFilter(12))
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
