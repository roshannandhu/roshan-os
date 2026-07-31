package com.tabletcontrol.companion

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

object LocationCollector {
    private const val TAG = "LocationCollector"
    private const val PREFS = "location_prefs"
    private const val KEY_MODE = "location_mode"
    private const val KEY_OFFLINE_QUEUE = "offline_queue"
    private const val MAX_QUEUE_SIZE = 500

    const val MODE_OFF = "OFF"
    const val MODE_ON_DEMAND = "ON_DEMAND"
    const val MODE_PERIODIC = "PERIODIC"
    const val MODE_LOST_DEVICE = "LOST_DEVICE"

    private var lastLocation: Location? = null
    private var isListening = false

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            Log.d(TAG, "Location fix received: ${location.latitude}, ${location.longitude} (acc=${location.accuracy}m)")
            lastLocation = location
        }

        @Deprecated("Deprecated in API 29")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    fun getMode(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_MODE, MODE_OFF) ?: MODE_OFF

    fun setMode(ctx: Context, mode: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE, mode)
            .apply()
        updateListeningState(ctx)
    }

    @SuppressLint("MissingPermission")
    fun updateListeningState(ctx: Context) {
        val mode = getMode(ctx)
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        if (mode == MODE_OFF) {
            if (isListening) {
                try { lm.removeUpdates(locationListener) } catch (_: Exception) {}
                isListening = false
                Log.i(TAG, "Location updates stopped (mode=OFF)")
            }
            return
        }

        val minTimeMs: Long = when (mode) {
            MODE_LOST_DEVICE -> 10_000L   // 10 sec
            MODE_PERIODIC -> 60_000L      // 1 min
            MODE_ON_DEMAND -> 300_000L    // 5 min
            else -> 60_000L
        }

        try {
            lm.removeUpdates(locationListener)
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTimeMs, 10f, locationListener)
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTimeMs, 10f, locationListener)
            }
            isListening = true
            Log.i(TAG, "Location updates started (mode=$mode, minTime=${minTimeMs}ms)")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to request location updates: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    fun getLatestLocation(ctx: Context): JSONObject {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var bestLoc = lastLocation

        if (bestLoc == null) {
            try {
                val gpsLoc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                val netLoc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                bestLoc = when {
                    gpsLoc != null && netLoc != null -> if (gpsLoc.time > netLoc.time) gpsLoc else netLoc
                    gpsLoc != null -> gpsLoc
                    else -> netLoc
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to get last known location: ${e.message}")
            }
        }

        val offlineQueue = getOfflineQueue(ctx)

        return JSONObject().apply {
            put("mode", getMode(ctx))
            put("hasFix", bestLoc != null)
            if (bestLoc != null) {
                put("latitude", bestLoc.latitude)
                put("longitude", bestLoc.longitude)
                put("accuracy", bestLoc.accuracy.toDouble())
                put("altitude", bestLoc.altitude)
                put("speed", bestLoc.speed.toDouble())
                put("bearing", bestLoc.bearing.toDouble())
                put("provider", bestLoc.provider)
                put("timestamp", bestLoc.time)
            }
            put("offlineQueueSize", offlineQueue.length())
            put("gpsEnabled", lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
            put("networkEnabled", lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
        }
    }

    fun getOfflineQueue(ctx: Context): JSONArray {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_OFFLINE_QUEUE, "[]") ?: "[]"
        return try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
    }

    fun clearOfflineQueue(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_OFFLINE_QUEUE)
            .apply()
    }
}
