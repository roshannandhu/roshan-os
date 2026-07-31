package com.tabletcontrol.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import java.net.InetAddress
import java.security.MessageDigest
import java.security.SecureRandom

object KioskController {
    const val ACTION_RENDER = "com.tabletcontrol.companion.action.RENDER"
    const val EXTRA_MODE = "mode"
    const val EXTRA_URL = "url"
    const val EXTRA_MESSAGE = "message"
    const val EXTRA_MESSAGE_DURATION_MS = "message_duration_ms"
    const val EXTRA_LIVE_TEXT = "live_text"
    const val EXTRA_CLEAR_MESSAGE = "clear_message"
    const val ACTION_SET_TOUCH_LOCK = "com.tabletcontrol.companion.action.SET_TOUCH_LOCK"
    const val EXTRA_TOUCH_LOCK = "touch_lock"
    const val ACTION_SET_ORIENTATION = "com.tabletcontrol.companion.action.SET_ORIENTATION"
    const val EXTRA_ORIENTATION = "screen_orientation"
    const val ACTION_SET_CLOCK_COLOR = "com.tabletcontrol.companion.action.SET_CLOCK_COLOR"
    const val ACTION_APPS_CHANGED = "com.tabletcontrol.companion.action.APPS_CHANGED"
    const val EXTRA_CLOCK_COLOR = "clock_color"
    private const val EXTRA_INTERNAL_COMMAND_TOKEN =
        "com.tabletcontrol.companion.extra.INTERNAL_COMMAND_TOKEN"
    private val internalCommandToken: String = ByteArray(32).also {
        SecureRandom().nextBytes(it)
    }.let {
        Base64.encodeToString(it, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
    }

    private const val PREFS = "kiosk"
    private const val KEY_DASHBOARD_URL = "dashboard_url"
    private const val KEY_MODE = "display_mode"
    private const val KEY_CURRENT_URL = "current_url"
    private const val KEY_CLOCK_COLOR = "clock_color"

    const val MODE_DASHBOARD = "dashboard"
    const val MODE_WEBPAGE = "webpage"
    const val MODE_BLACK = "black"

    fun isDashboardConfigured(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_DASHBOARD_URL, null)?.isNotBlank() == true

    fun dashboardUrl(context: Context): String {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_DASHBOARD_URL, null)
        if (saved != null && (saved.contains(":3001") || saved.contains("Home Remote") || saved.contains("login"))) {
            // Clear legacy invalid controller URL
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(KEY_DASHBOARD_URL).apply()
            return "http://127.0.0.1:8765/clock"
        }
        return saved?.takeIf { it.isNotBlank() } ?: "http://127.0.0.1:8765/clock"
    }

    fun displayMode(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_MODE, MODE_DASHBOARD) ?: MODE_DASHBOARD

    fun currentUrl(context: Context): String? {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CURRENT_URL, null)
        if (saved != null && (saved.contains(":3001") || saved.contains("Home Remote") || saved.contains("login"))) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(KEY_CURRENT_URL).apply()
            return "http://127.0.0.1:8765/clock"
        }
        return saved?.takeIf { it.isNotBlank() }
    }

    fun configureDashboard(context: Context, url: String) {
        val safeUrl = validateWebUrl(url)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DASHBOARD_URL, safeUrl)
            .putString(KEY_CURRENT_URL, safeUrl)
            .putString(KEY_MODE, MODE_DASHBOARD)
            .apply()
        render(context, MODE_DASHBOARD, safeUrl)
    }

    fun showWebpage(context: Context, url: String) {
        val safeUrl = validateWebUrl(url)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CURRENT_URL, safeUrl)
            .putString(KEY_MODE, MODE_WEBPAGE)
            .apply()
        render(context, MODE_WEBPAGE, safeUrl)
    }

    fun showBlack(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE, MODE_BLACK)
            .remove(KEY_CURRENT_URL)
            .apply()
        render(context, MODE_BLACK, null)
    }

    fun showClockOnly(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE, "clock")
            .remove(KEY_CURRENT_URL)
            .apply()
        render(context, "clock", null)
    }

    fun clockColor(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CLOCK_COLOR, "#00A2FF") ?: "#00A2FF"

    fun setClockColor(context: Context, color: String) {
        val safeColor = if (color.startsWith("#") && (color.length == 7 || color.length == 9)) color else "#00A2FF"
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CLOCK_COLOR, safeColor)
            .apply()
        val intent = Intent(ACTION_SET_CLOCK_COLOR).apply {
            putExtra(EXTRA_CLOCK_COLOR, safeColor)
            setPackage(context.packageName)
        }
        context.sendBroadcast(intent)
    }

    fun notifyApprovedAppsChanged(context: Context) {
        context.sendBroadcast(
            Intent(ACTION_APPS_CHANGED).setPackage(context.packageName)
        )
    }

    fun notifyLockPolicyChanged(context: Context) {
        context.sendBroadcast(
            Intent(ACTION_SET_TOUCH_LOCK).setPackage(context.packageName)
        )
    }

    fun showMessage(context: Context, text: String, durationSeconds: Int) {
        require(text.isNotBlank() && text.length <= 500)
        require(durationSeconds in 1..300)
        val mode = displayMode(context)
        val url = if (mode == MODE_BLACK) null else currentUrl(context) ?: dashboardUrl(context)
        val intent = renderIntent(context, mode, url)
            .putExtra(EXTRA_MESSAGE, text)
            .putExtra(EXTRA_MESSAGE_DURATION_MS, durationSeconds * 1_000L)
        context.startActivity(intent)
    }

    fun showLiveText(context: Context, text: String) {
        require(text.isNotBlank() && text.length <= 500)
        val mode = displayMode(context)
        val url = if (mode == MODE_BLACK) null else currentUrl(context) ?: dashboardUrl(context)
        context.startActivity(
            renderIntent(context, mode, url).putExtra(EXTRA_LIVE_TEXT, text)
        )
    }

    fun clearLiveText(context: Context) {
        val mode = displayMode(context)
        val url = if (mode == MODE_BLACK) null else currentUrl(context) ?: dashboardUrl(context)
        context.startActivity(
            renderIntent(context, mode, url).putExtra(EXTRA_CLEAR_MESSAGE, true)
        )
    }

    fun isTouchLocked(context: Context): Boolean =
        AccessLockManager.isLocked(context)

    /**
     * Access Lock is intentionally process-only and time-bounded. Enabling it
     * never launches Home over the app the user is currently using.
     */
    fun setTouchLock(
        context: Context,
        enabled: Boolean,
        durationMs: Long? = null
    ): Boolean =
        AccessLockManager.setLocked(context, enabled, durationMs) &&
            AccessLockManager.isLocked(context) == enabled

    fun setScreenOrientation(context: Context, orientation: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("saved_orientation", orientation)
            .apply()
        context.startActivity(
            Intent(context, KioskActivity::class.java)
                .setAction(ACTION_SET_ORIENTATION)
                .putExtra(EXTRA_INTERNAL_COMMAND_TOKEN, internalCommandToken)
                .putExtra(EXTRA_ORIENTATION, orientation)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
        )
    }

    fun restoreDashboard(context: Context): Boolean {
        val url = dashboardUrl(context)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CURRENT_URL, url)
            .putString(KEY_MODE, MODE_DASHBOARD)
            .apply()
        render(context, MODE_DASHBOARD, url)
        RootCommand.bringKioskToForeground()
        return true
    }

    fun bringToForeground(context: Context) {
        val mode = displayMode(context)
        val url = if (mode == MODE_BLACK) null else currentUrl(context) ?: dashboardUrl(context)
        render(context, mode, url)
    }

    private fun render(context: Context, mode: String, url: String?) {
        context.startActivity(
            renderIntent(context, mode, url).putExtra(EXTRA_CLEAR_MESSAGE, true)
        )
    }

    private fun renderIntent(context: Context, mode: String, url: String?): Intent {
        val intent = Intent(context, KioskActivity::class.java)
            .setAction(ACTION_RENDER)
            .putExtra(EXTRA_INTERNAL_COMMAND_TOKEN, internalCommandToken)
            .putExtra(EXTRA_MODE, mode)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
        )
        if (url != null) intent.putExtra(EXTRA_URL, url)
        return intent
    }

    /**
     * KioskActivity must be exported because it is the persistent HOME
     * activity. Only explicit commands created inside this process may carry
     * render/orientation extras; external HOME launches always fall back to the
     * already-validated private preferences.
     */
    fun isTrustedActivityCommand(intent: Intent?): Boolean {
        val provided = intent?.getStringExtra(EXTRA_INTERNAL_COMMAND_TOKEN) ?: return false
        return MessageDigest.isEqual(
            provided.toByteArray(Charsets.UTF_8),
            internalCommandToken.toByteArray(Charsets.UTF_8)
        )
    }

    private fun validateWebUrl(value: String): String {
        require(value.length in 1..2048) { "URL length is invalid." }
        val uri = Uri.parse(value)
        require(isSafeDisplayUri(uri)) {
            "Only credential-free HTTPS public origins or the RoshanCore loopback clock are allowed."
        }
        return uri.toString()
    }

    fun isSafeDisplayUri(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase()?.trimEnd('.') ?: return false
        if (uri.userInfo?.isNotEmpty() == true || host.isBlank()) return false

        if (scheme == "http") {
            return (host == "127.0.0.1" || host == "localhost") &&
                uri.port == 8765 &&
                (uri.path == "/" || uri.path == "/clock" || uri.path.isNullOrBlank())
        }
        if (scheme != "https") return false
        if (host == "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            host == "metadata.google.internal" ||
            host.endsWith(".home.arpa")
        ) {
            return false
        }
        return !isBlockedIpLiteral(host)
    }

    private fun isBlockedIpLiteral(host: String): Boolean {
        val ipv4Parts = host.split('.')
        if (ipv4Parts.size == 4 && ipv4Parts.all {
                it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit)
            }
        ) {
            val octets = ipv4Parts.map { it.toIntOrNull() ?: return true }
            if (octets.any { it !in 0..255 }) return true
            val a = octets[0]
            val b = octets[1]
            return a == 0 ||
                a == 10 ||
                a == 127 ||
                (a == 100 && b in 64..127) ||
                (a == 169 && b == 254) ||
                (a == 172 && b in 16..31) ||
                (a == 192 && b == 0) ||
                (a == 192 && b == 168) ||
                (a == 198 && b in 18..19) ||
                a >= 224
        }
        if (!host.contains(':')) return false
        return try {
            val address = InetAddress.getByName(host)
            val bytes = address.address
            address.isAnyLocalAddress ||
                address.isLoopbackAddress ||
                address.isLinkLocalAddress ||
                address.isSiteLocalAddress ||
                address.isMulticastAddress ||
                (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc)
        } catch (_: Exception) {
            true
        }
    }
}
