package com.tabletcontrol.companion

import android.Manifest
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * Factory-reset-only HOME entry for this exact Android 11 image.
 *
 * The backed Lineage Setup Wizard does not implement Android's six-tap QR
 * launcher. This privileged, preinstalled bridge starts Managed Provisioning's
 * permission-protected trusted-source entry instead. It never assigns Device
 * Owner itself, never carries a secret, and never suppresses Android consent.
 */
class RoshanSetupActivity : Activity() {
    private var provisioningLaunchInFlight = false
    private var statusMessage: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        provisioningLaunchInFlight =
            savedInstanceState?.getBoolean(KEY_PROVISIONING_IN_FLIGHT, false) == true
        render()
    }

    override fun onResume() {
        super.onResume()
        if (DevicePolicyController.isDeviceOwner(this)) {
            finishProvisioningHandoff()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(KEY_PROVISIONING_IN_FLIGHT, provisioningLaunchInFlight)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Managed Provisioning still returns through the Android 11 Activity result flow.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_MANAGED_PROVISIONING) return

        provisioningLaunchInFlight = false
        if (DevicePolicyController.isDeviceOwner(this)) {
            finishProvisioningHandoff()
            return
        }
        statusMessage = if (resultCode == RESULT_CANCELED) {
            "Android enrollment was canceled. Nothing was enrolled; you can retry."
        } else {
            "Android did not confirm Device Owner. Setup remains locked until enrollment succeeds."
        }
        render()
    }

    private fun render() {
        val state = FactoryResetSetupPolicy.state(
            isDeviceOwner = DevicePolicyController.isDeviceOwner(this),
            isDeviceProvisioned = isDeviceProvisioned(),
            isWifiConnected = WifiProvisioningManager.isConnected(this)
        )
        when (state) {
            FactoryResetSetupPolicy.State.COMPLETE -> finishProvisioningHandoff()
            FactoryResetSetupPolicy.State.RESET_REQUIRED -> showResetRequired()
            FactoryResetSetupPolicy.State.WIFI_REQUIRED -> showWifiSetup()
            FactoryResetSetupPolicy.State.READY_TO_ENROLL -> showEnrollmentReady()
        }
    }

    private fun showWifiSetup() {
        maybeRequestLocationPermission()
        setContentView(
            ScrollView(this).apply {
                isFillViewport = true
                addView(
                    WifiSetupView(
                        context = this@RoshanSetupActivity,
                        onConnected = {
                            statusMessage = null
                            render()
                        }
                    ),
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT
                    )
                )
            }
        )
    }

    private fun showEnrollmentReady() {
        val content = baseContent(
            title = "Enroll this RoshanOS device",
            detail =
                "Wi-Fi is ready. Android will now show the required device-management " +
                    "and privacy disclosures before it can make RoshanCore the Device Owner."
        )

        content.addView(
            Button(this).apply {
                text = if (provisioningLaunchInFlight) {
                    "Android enrollment is open"
                } else {
                    "Begin protected enrollment"
                }
                isAllCaps = false
                isEnabled = !provisioningLaunchInFlight
                setOnClickListener { launchManagedProvisioning() }
            },
            matchWidth(topMarginDp = 20)
        )
        content.addView(
            Button(this).apply {
                text = "Choose another Wi-Fi network"
                isAllCaps = false
                setOnClickListener { showWifiSetup() }
            },
            matchWidth(topMarginDp = 8)
        )
        statusMessage?.let { message ->
            content.addView(statusText(message), matchWidth(topMarginDp = 16))
        }
        setContentView(scroll(content))
    }

    private fun showResetRequired() {
        val content = baseContent(
            title = "Owner enrollment required",
            detail =
                "Android reports that setup was already completed without RoshanCore as " +
                    "Device Owner. Android cannot safely promote an app after provisioning. " +
                    "Protected owner maintenance must authorize another factory reset."
        )
        content.addView(
            statusText("RoshanOS Home remains blocked. No self-enrollment or policy bypass was attempted."),
            matchWidth(topMarginDp = 18)
        )
        setContentView(scroll(content))
    }

    private fun launchManagedProvisioning() {
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isProvisioningAllowed(DevicePolicyManager.ACTION_PROVISION_MANAGED_DEVICE)) {
            statusMessage =
                "Android does not currently allow fully managed provisioning. A clean factory reset is required."
            showEnrollmentReady()
            return
        }

        val intent = Intent(ACTION_PROVISION_FROM_TRUSTED_SOURCE)
            .setPackage(MANAGED_PROVISIONING_PACKAGE)
            .putExtra(
                DevicePolicyManager.EXTRA_PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME,
                DevicePolicyController.getAdminComponent(this)
            )
            // Preserve required system/server APKs. RoshanOS controls frontend
            // visibility later through Device Owner policy and its own Home.
            .putExtra(
                DevicePolicyManager.EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED,
                true
            )

        val resolved = packageManager.resolveActivity(intent, PackageManager.MATCH_SYSTEM_ONLY)
        val resolvedComponent = resolved?.activityInfo?.let {
            ComponentName(it.packageName, it.name)
        }
        if (resolvedComponent == null ||
            resolvedComponent.packageName != MANAGED_PROVISIONING_PACKAGE ||
            !resolvedComponent.className.endsWith(TRUSTED_SOURCE_ALIAS_SUFFIX)
        ) {
            statusMessage =
                "This system image does not expose the required Android Managed Provisioning entry."
            showEnrollmentReady()
            return
        }

        provisioningLaunchInFlight = true
        statusMessage = null
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(
                intent.setComponent(resolvedComponent),
                REQUEST_MANAGED_PROVISIONING
            )
            showEnrollmentReady()
        } catch (_: SecurityException) {
            provisioningLaunchInFlight = false
            statusMessage =
                "RoshanCore is missing its privileged provisioning permission in this image."
            showEnrollmentReady()
        } catch (_: Exception) {
            provisioningLaunchInFlight = false
            statusMessage = "Android Managed Provisioning could not be opened."
            showEnrollmentReady()
        }
    }

    private fun finishProvisioningHandoff() {
        RoshanSetupLifecycle.disableEntry(this)

        ContextCompat.startForegroundService(
            this,
            Intent(this, CompanionService::class.java)
                .setAction(CompanionService.ACTION_RECONCILE)
                .putExtra(
                    CompanionService.EXTRA_RECONCILE_REASON,
                    "factory_reset_setup_handoff"
                )
        )

        // The bridge intentionally does not mark USER_SETUP_COMPLETE itself.
        // Return to the preserved, resource-branded Lineage Setup Wizard so
        // Android owns completion of its setup lifecycle.
        val setupIntent = Intent(Intent.ACTION_MAIN)
            .setComponent(ComponentName(LINEAGE_SETUP_PACKAGE, LINEAGE_SETUP_ACTIVITY))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val setupAvailable = packageManager.resolveActivity(
            setupIntent,
            PackageManager.MATCH_SYSTEM_ONLY
        ) != null
        if (setupAvailable && !isDeviceProvisioned()) {
            startActivity(setupIntent)
        } else {
            startActivity(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
        finish()
    }

    private fun maybeRequestLocationPermission() {
        if (ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ),
                REQUEST_LOCATION
            )
        }
    }

    private fun isDeviceProvisioned(): Boolean =
        Settings.Global.getInt(
            contentResolver,
            Settings.Global.DEVICE_PROVISIONED,
            0
        ) != 0

    private fun baseContent(title: String, detail: String): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(36), dp(48), dp(36), dp(40))
            setBackgroundColor(Color.parseColor("#0B0E14"))

            addView(TextView(context).apply {
                text = "ROSHANOS"
                setTextColor(Color.parseColor("#2DD4BF"))
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                letterSpacing = 0.18f
                gravity = Gravity.CENTER
            }, matchWidth())
            addView(TextView(context).apply {
                text = title
                setTextColor(Color.WHITE)
                textSize = 29f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(0, dp(14), 0, dp(10))
            }, matchWidth())
            addView(TextView(context).apply {
                text = detail
                setTextColor(Color.parseColor("#B8C4D8"))
                textSize = 16f
                gravity = Gravity.CENTER
            }, matchWidth())
        }

    private fun statusText(message: String): TextView =
        TextView(this).apply {
            text = message
            setTextColor(Color.parseColor("#FDBA74"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#171C27"))
                setStroke(dp(1), Color.parseColor("#3A465B"))
                cornerRadius = dp(14).toFloat()
            }
        }

    private fun scroll(content: View): ScrollView =
        ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(
                content,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT
                )
            )
        }

    private fun matchWidth(topMarginDp: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = dp(topMarginDp)
        }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val ACTION_PROVISION_FROM_TRUSTED_SOURCE =
            "android.app.action.PROVISION_MANAGED_DEVICE_FROM_TRUSTED_SOURCE"
        const val MANAGED_PROVISIONING_PACKAGE = "com.android.managedprovisioning"
        const val TRUSTED_SOURCE_ALIAS_SUFFIX = "PreProvisioningActivityViaTrustedApp"
        const val LINEAGE_SETUP_PACKAGE = "org.lineageos.setupwizard"
        const val LINEAGE_SETUP_ACTIVITY = "org.lineageos.setupwizard.SetupWizardActivity"
        const val REQUEST_MANAGED_PROVISIONING = 4101
        const val REQUEST_LOCATION = 4102
        const val KEY_PROVISIONING_IN_FLIGHT = "provisioning_launch_in_flight"
    }
}

internal object RoshanSetupLifecycle {
    fun disableEntry(context: Context): Boolean = try {
        context.packageManager.setComponentEnabledSetting(
            ComponentName(context, RoshanSetupActivity::class.java),
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP
        )
        true
    } catch (_: Exception) {
        false
    }
}
