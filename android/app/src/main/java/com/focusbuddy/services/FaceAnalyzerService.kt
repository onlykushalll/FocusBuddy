package com.focusbuddy.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.focusbuddy.GlobalState
import com.focusbuddy.security.SecurityChecker
import com.google.firebase.firestore.FirebaseFirestore
import java.util.concurrent.atomic.AtomicReference

/**
 * FaceAnalyzerService — Foreground service that runs continuous security checks.
 */
class FaceAnalyzerService : Service() {

    companion object {
        private const val TAG = "FaceAnalyzer"
        private const val CHECK_INTERVAL_MS = 30_000L  // 30 seconds
        private const val CHANNEL_ID = "FocusBuddy_Face"
        private const val NOTIFICATION_ID = 101
    }

    private val handler = Handler(Looper.getMainLooper())
    private val db = FirebaseFirestore.getInstance()
    private val sessionIdRef = AtomicReference<String?>(null)
    private val buddyIdRef = AtomicReference<String?>(null)

    private val securityCheckRunnable = object : Runnable {
        override fun run() {
            performSecurityCheck()
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val intentSessionId = intent?.getStringExtra("sessionId")
        val intentBuddyId = intent?.getStringExtra("buddyId")

        val sId = if (!intentSessionId.isNullOrEmpty()) intentSessionId else GlobalState.sessionId
        val bId = if (!intentBuddyId.isNullOrEmpty()) intentBuddyId else GlobalState.buddyId

        sessionIdRef.set(sId)
        buddyIdRef.set(bId)

        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Focus Buddy")
            .setContentText("Security monitoring active")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)

        // Start periodic security checks
        handler.removeCallbacks(securityCheckRunnable)
        handler.post(securityCheckRunnable)

        Log.d(TAG, "Service started — security monitoring active")
        return START_STICKY
    }

    private fun performSecurityCheck() {
        val sessionId = sessionIdRef.get()
        val buddyId = buddyIdRef.get()
        if (sessionId.isNullOrEmpty() || buddyId.isNullOrEmpty()) {
            Log.w(TAG, "Cannot perform security check: sessionId or buddyId is empty")
            return
        }

        val report = SecurityChecker.checkAll(this)

        if (report.hasAnyThreat) {
            Log.w(TAG, "SECURITY THREAT DETECTED: $report")
        }

        // Report to Firestore so admin is alerted
        val updates = hashMapOf<String, Any>(
            "securityThreats" to mapOf(
                "rooted" to report.isRooted,
                "frida" to report.isFridaPresent,
                "xposed" to report.isXposedPresent,
                "emulator" to report.isEmulator,
                "debugger" to report.isDebuggerAttached,
                "safeMode" to report.isSafeMode,
                "adbEnabled" to report.isAdbEnabled,
                "devOptions" to report.isDevOptionsEnabled,
                "accessibilityDisabled" to report.isAccessibilityDisabled,
                "appDebuggable" to report.isAppDebuggable,
                "timestamp" to System.currentTimeMillis()
            )
        )

        db.collection("sessions").document(sessionId)
            .collection("buddies").document(buddyId)
            .update(updates)
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to report security threats", e)
            }

        // If critical threats detected, force-pause the session by writing securityAlert
        if (report.isRooted || report.isFridaPresent || report.isXposedPresent || 
            report.isAccessibilityDisabled || report.isSafeMode) {
            db.collection("sessions").document(sessionId)
                .collection("buddies").document(buddyId)
                .update("securityAlert", "CRITICAL_THREAT_DETECTED")
                .addOnFailureListener { e ->
                    Log.e(TAG, "Failed to send critical alert", e)
                }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(securityCheckRunnable)
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Security Monitoring",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Continuous security monitoring during focus sessions"
            setShowBadge(false)
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(channel)
    }
}
