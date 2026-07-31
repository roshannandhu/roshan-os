package com.tabletcontrol.companion

import android.content.Context
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper

object FindDeviceSound {
    private var currentRingtone: Ringtone? = null
    private val handler = Handler(Looper.getMainLooper())
    private var stopRunnable: Runnable? = null
    private var originalVolume: Int = -1

    fun play(ctx: Context, durationSeconds: Int = 15): Boolean {
        stop(ctx)

        val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        originalVolume = audioManager.getStreamVolume(AudioManager.STREAM_ALARM)

        // Set alarm volume to 80% for find sound
        val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        audioManager.setStreamVolume(AudioManager.STREAM_ALARM, (maxVol * 0.8).toInt(), 0)

        val alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

        val ringtone = RingtoneManager.getRingtone(ctx, alarmUri) ?: return false
        ringtone.play()
        currentRingtone = ringtone

        val actualDurationMs = durationSeconds.coerceIn(1, 60) * 1000L
        val runnable = Runnable { stop(ctx) }
        stopRunnable = runnable
        handler.postDelayed(runnable, actualDurationMs)

        return true
    }

    fun stop(ctx: Context) {
        stopRunnable?.let(handler::removeCallbacks)
        stopRunnable = null

        currentRingtone?.let {
            if (it.isPlaying) it.stop()
        }
        currentRingtone = null

        if (originalVolume >= 0) {
            val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, originalVolume, 0)
            originalVolume = -1
        }
    }

    fun isPlaying(): Boolean = currentRingtone?.isPlaying == true
}
