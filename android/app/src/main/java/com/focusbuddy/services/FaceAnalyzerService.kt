package com.focusbuddy.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log

/**
 * FaceAnalyzerService — Stub for background face analysis.
 */
class FaceAnalyzerService : Service() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = Notification.Builder(this, "FocusBuddy_Face")
            .setContentTitle("Face Security Engine")
            .setContentText("Monitoring for Focus Lock persistence...")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .build()
        startForeground(101, notification)
        
        Log.d("FaceAnalyzer", "Service started")
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            "FocusBuddy_Face",
            "Face Analysis",
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(channel)
    }
}
