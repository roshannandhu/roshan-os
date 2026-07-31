package com.tabletcontrol.companion

import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.view.Surface
import android.view.WindowManager

object TelemetryProvider {
    data class StorageSnapshot(
        val freeBytes: Long,
        val totalBytes: Long
    )

    data class MemorySnapshot(
        val availableBytes: Long,
        val totalBytes: Long,
        val lowMemory: Boolean,
        val lowMemoryThresholdBytes: Long
    )

    data class ConnectivitySnapshot(
        val wifiEnabled: Boolean?,
        val wifiConnected: Boolean?,
        val ssid: String?,
        val rssiDbm: Int?,
        val signalLevel: Int?,
        val signalState: String?,
        val internetCapable: Boolean?,
        val internetValidated: Boolean?
    )

    data class ForegroundAppSnapshot(
        val state: String,
        val packageName: String?,
        val label: String?
    )

    data class UpdateSnapshot(
        val state: String,
        val versionName: String?,
        val versionCode: Long?,
        val firstInstalledAtMs: Long?,
        val lastAppliedAtMs: Long?
    )

    fun batteryPercent(ctx: Context): Int? {
        return try {
            val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                ?: return null
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (scale > 0 && level >= 0) {
                (level * 100 / scale).takeIf { it in 0..100 }
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun isCharging(ctx: Context): Boolean? {
        return try {
            val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                ?: return null
            val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            when (status) {
                BatteryManager.BATTERY_STATUS_CHARGING,
                BatteryManager.BATTERY_STATUS_FULL -> true
                BatteryManager.BATTERY_STATUS_DISCHARGING,
                BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun batteryTemperatureC(ctx: Context): Double? {
        return try {
            val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                ?: return null
            val raw = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            if (raw == Int.MIN_VALUE) null else raw / 10.0
        } catch (_: Exception) {
            null
        }
    }

    fun storage(): StorageSnapshot? {
        return try {
            val stat = StatFs("/data")
            StorageSnapshot(
                freeBytes = stat.availableBlocksLong * stat.blockSizeLong,
                totalBytes = stat.blockCountLong * stat.blockSizeLong
            )
        } catch (_: Exception) {
            null
        }
    }

    fun storageFreeBytes(): Long? = storage()?.freeBytes

    fun memory(ctx: Context): MemorySnapshot? {
        return try {
            val manager =
                ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            MemorySnapshot(
                availableBytes = info.availMem,
                totalBytes = info.totalMem,
                lowMemory = info.lowMemory,
                lowMemoryThresholdBytes = info.threshold
            )
        } catch (_: Exception) {
            null
        }
    }

    fun uptimeSeconds(): Long = SystemClock.elapsedRealtime() / 1000

    fun lastBootAtMs(): Long? {
        val now = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        return (now - elapsed).takeIf { now > 0L && elapsed >= 0L && it >= 0L }
    }

    fun brightness(ctx: Context): Int? {
        return try {
            Settings.System.getInt(
                ctx.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS
            ).takeIf { it in 0..255 }
        } catch (_: Exception) {
            null
        }
    }

    fun brightnessMode(ctx: Context): String? {
        return try {
            when (
                Settings.System.getInt(
                    ctx.contentResolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE
                )
            ) {
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL -> "manual"
                Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC -> "automatic"
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun screenTimeoutMs(ctx: Context): Long? {
        return try {
            Settings.System.getLong(
                ctx.contentResolver,
                Settings.System.SCREEN_OFF_TIMEOUT
            ).takeIf { it > 0L }
        } catch (_: Exception) {
            null
        }
    }

    fun musicVolume(ctx: Context): Int? {
        return try {
            val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        } catch (_: Exception) {
            null
        }
    }

    fun musicVolumeMax(ctx: Context): Int? {
        return try {
            val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        } catch (_: Exception) {
            null
        }
    }

    fun setMusicVolume(ctx: Context, value: Int, showUi: Boolean): Boolean {
        val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        require(value in 0..audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
        return try {
            val flags = if (showUi) AudioManager.FLAG_SHOW_UI else 0
            audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, value, flags)
            audioManager.getStreamVolume(AudioManager.STREAM_MUSIC) == value
        } catch (_: SecurityException) {
            false
        }
    }

    fun screenOrientation(ctx: Context): String? {
        return try {
            val automatic = Settings.System.getInt(
                ctx.contentResolver,
                Settings.System.ACCELEROMETER_ROTATION
            ) == 1
            if (automatic) return "auto"

            val display = ctx.display
                ?: (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay
            when (display.rotation) {
                Surface.ROTATION_0 -> "portrait"
                Surface.ROTATION_90 -> "landscape"
                Surface.ROTATION_180 -> "reverse-portrait"
                Surface.ROTATION_270 -> "reverse-landscape"
                else -> "portrait"
            }
        } catch (_: Exception) {
            null
        }
    }

    fun isScreenOn(ctx: Context): Boolean? {
        return try {
            val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            powerManager.isInteractive
        } catch (_: Exception) {
            null
        }
    }

    fun isKeyguardLocked(ctx: Context): Boolean? {
        return try {
            val keyguard = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguard.isKeyguardLocked
        } catch (_: Exception) {
            null
        }
    }

    fun isDeviceLocked(ctx: Context): Boolean? {
        return try {
            val keyguard = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguard.isDeviceLocked
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    fun connectivity(ctx: Context): ConnectivitySnapshot {
        val wifiManager = try {
            ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        } catch (_: Exception) {
            null
        }
        val wifiEnabled = try {
            wifiManager?.isWifiEnabled
        } catch (_: Exception) {
            null
        }

        val wifiCapabilities = try {
            val connectivity =
                ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            connectivity.allNetworks.mapNotNull { network ->
                connectivity.getNetworkCapabilities(network)
                    ?.takeIf { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
            }
        } catch (_: Exception) {
            null
        }
        val wifiConnected = wifiCapabilities?.isNotEmpty()
        val internetCapable = wifiCapabilities?.any {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
        val internetValidated = wifiCapabilities?.any {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }

        val wifiInfo = if (wifiConnected == true) {
            try {
                wifiManager?.connectionInfo
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        val ssid = wifiInfo?.ssid
            ?.removeSurrounding("\"")
            ?.takeUnless { it.isBlank() || it.equals("<unknown ssid>", ignoreCase = true) }
        val rssi = wifiInfo?.rssi?.takeIf { it in -126..0 }
        val signalLevel = rssi?.let { WifiManager.calculateSignalLevel(it, 5) }
        val signalState = when (signalLevel) {
            4 -> "excellent"
            3 -> "good"
            2 -> "fair"
            0, 1 -> "weak"
            else -> null
        }

        return ConnectivitySnapshot(
            wifiEnabled = wifiEnabled,
            wifiConnected = wifiConnected,
            ssid = ssid,
            rssiDbm = rssi,
            signalLevel = signalLevel,
            signalState = signalState,
            internetCapable = internetCapable,
            internetValidated = internetValidated
        )
    }

    @Suppress("DEPRECATION")
    fun foregroundApprovedApp(ctx: Context): ForegroundAppSnapshot {
        val publicApiPackage = try {
            val activityManager =
                ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            activityManager.getRunningTasks(1).firstOrNull()?.topActivity?.packageName
        } catch (_: Exception) {
            null
        }
        val packageName = RootCommand.currentForegroundPackage() ?: publicApiPackage
        val approved = ApprovedApps.approvedPackages(ctx)
        val technical = if (
            packageName != null && ApprovedApps.isTechnical(ctx, packageName)
        ) {
            setOf(packageName)
        } else {
            emptySet()
        }
        val state = DeviceControlPolicy.foregroundState(
            packageName = packageName,
            roshanPackage = ctx.packageName,
            approvedPackages = approved,
            technicalPackages = technical
        )
        if (state != "approved") {
            return ForegroundAppSnapshot(
                state = state,
                packageName = if (state == "roshanos") ctx.packageName else null,
                label = if (state == "roshanos") "RoshanOS" else null
            )
        }

        val label = try {
            val application = ctx.packageManager.getApplicationInfo(packageName!!, 0)
            ctx.packageManager.getApplicationLabel(application).toString()
        } catch (_: Exception) {
            null
        }
        return ForegroundAppSnapshot(
            state = state,
            packageName = packageName,
            label = label
        )
    }

    @Suppress("DEPRECATION")
    fun update(ctx: Context): UpdateSnapshot {
        return try {
            val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            UpdateSnapshot(
                state = "installed",
                versionName = info.versionName,
                versionCode = info.longVersionCode,
                firstInstalledAtMs = info.firstInstallTime.takeIf { it > 0L },
                lastAppliedAtMs = info.lastUpdateTime.takeIf { it > 0L }
            )
        } catch (_: Exception) {
            UpdateSnapshot(
                state = "unknown",
                versionName = null,
                versionCode = null,
                firstInstalledAtMs = null,
                lastAppliedAtMs = null
            )
        }
    }
}
