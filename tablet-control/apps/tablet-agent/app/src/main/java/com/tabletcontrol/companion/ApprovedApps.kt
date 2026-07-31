package com.tabletcontrol.companion

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject

object ApprovedApps {
    private const val PREFS = "approved_apps"
    private const val KEY_APPROVED = "approved_set"
    private const val KEY_TECHNICAL = "technical_set"

    private val DEFAULT_TECHNICAL = setOf(
        "com.tabletcontrol.companion",
        "com.tabletcontrol.camera",
        "com.pas.webcam",
        "com.tailscale.ipn",
        "com.topjohnwu.magisk",
        "com.termux",
        "de.ozerov.fully",
        "uk.nktnet.webviewkiosk",
        "app.lawnchair",
        "com.android.launcher3",
        "me.phh.treble.app",
        "com.android.systemui",
        "com.android.settings",
        "com.android.shell",
        "com.google.android.gms",
        "com.google.android.gsf",
        "com.google.android.packageinstaller",
        "com.android.documentsui",
        "com.android.providers.downloads",
        "com.android.providers.media",
        "com.android.externalstorage"
    )

    private val TECHNICAL_PREFIXES = setOf(
        "com.tabletcontrol.",
        "com.topjohnwu.",
        "com.termux",
        "de.ozerov.fully",
        "me.phh.treble"
    )

    fun technicalPackages(context: Context): Set<String> {
        val configured = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_TECHNICAL, emptySet())
            ?.toSet()
            .orEmpty()
        return DEFAULT_TECHNICAL + configured
    }

    fun setTechnicalPackages(context: Context, pkgs: Set<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putStringSet(KEY_TECHNICAL, DEFAULT_TECHNICAL + pkgs).apply()
        setApprovedPackages(context, approvedPackages(context))
    }

    fun approvedPackages(context: Context): Set<String> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val saved = prefs.getStringSet(KEY_APPROVED, null)
        if (saved != null) {
            return sanitizeApproved(context, saved)
        }

        // Fail closed on first enrollment. Newly installed applications remain
        // "discovered" until the protected phone controller explicitly approves them.
        prefs.edit().putStringSet(KEY_APPROVED, emptySet()).apply()
        return emptySet()
    }

    fun setApprovedPackages(context: Context, pkgs: Set<String>) {
        val approved = sanitizeApproved(context, pkgs)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putStringSet(KEY_APPROVED, approved).apply()
        DevicePolicyController.updateLockTaskAllowlist(context)
    }

    fun isApproved(context: Context, packageName: String): Boolean =
        packageName in approvedPackages(context)

    fun isTechnical(context: Context, packageName: String): Boolean =
        packageName in technicalPackages(context) ||
            TECHNICAL_PREFIXES.any { packageName == it || packageName.startsWith(it) }

    fun isApprovable(context: Context, packageName: String): Boolean =
        packageName in discoverAll(context) && !isTechnical(context, packageName)

    private fun sanitizeApproved(context: Context, packages: Collection<String>): Set<String> {
        val launchable = discoverAll(context).toSet()
        return packages.asSequence()
            .filter { it in launchable }
            .filterNot { isTechnical(context, it) }
            .toSet()
    }

    private fun discoverAll(context: Context): List<String> {
        val pm = context.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        return pm.queryIntentActivities(mainIntent, 0)
            .map { it.activityInfo.packageName }
            .distinct()
    }

    fun installed(context: Context): JSONArray {
        val pm = context.packageManager
        val approvedSet = approvedPackages(context)
        val result = JSONArray()
        val seenIds = mutableSetOf<String>()

        for (info in pm.queryIntentActivities(
            Intent(Intent.ACTION_MAIN, null).apply { addCategory(Intent.CATEGORY_LAUNCHER) }, 0)) {
            val pkg = info.activityInfo.packageName
            val label = info.loadLabel(pm).toString()

            if (pkg in approvedSet) {
                appendApp(result, seenIds, pkg, label, "approved")
            } else if (isTechnical(context, pkg)) {
                appendApp(result, seenIds, pkg, label, "technical")
            } else {
                appendApp(result, seenIds, pkg, label, "discovered")
            }
        }

        return result
    }

    private fun appendApp(result: JSONArray, seenIds: MutableSet<String>, pkg: String, label: String, status: String) {
        var id = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
        if (id.isEmpty()) id = pkg.replace('.', '-')
        if (id in seenIds) {
            id = "$id-${pkg.hashCode().toUInt().toString(16)}"
        }
        seenIds.add(id)
        result.put(JSONObject().apply {
            put("id", id)
            put("label", label)
            put("packageName", pkg)
            put("status", status)
        })
    }

    fun launch(context: Context, appId: String): String? {
        val pm = context.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val resolveInfos = pm.queryIntentActivities(mainIntent, 0)
        val approved = approvedPackages(context)
        val targetAppId = appId.trim().lowercase()
        val target = resolveInfos.firstOrNull { info ->
            val pkg = info.activityInfo.packageName
            if (pkg !in approved || isTechnical(context, pkg)) return@firstOrNull false
            val label = info.loadLabel(pm).toString()
            var id = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
            if (id.isEmpty()) id = pkg.replace('.', '-')
            id == targetAppId || pkg.equals(appId, ignoreCase = true)
        } ?: return null

        val targetPackage = target.activityInfo.packageName
        if (!isApproved(context, targetPackage) || isTechnical(context, targetPackage)) return null

        val launchIntent = pm.getLaunchIntentForPackage(targetPackage)
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            try {
                context.startActivity(launchIntent)
                return target.loadLabel(pm).toString()
            } catch (_: Exception) {
                // Fallback to root command if background activity launch is blocked
            }
        }

        RootCommand.exec("monkey -p $targetPackage -c android.intent.category.LAUNCHER 1")
        return target.loadLabel(pm).toString()
    }
}
