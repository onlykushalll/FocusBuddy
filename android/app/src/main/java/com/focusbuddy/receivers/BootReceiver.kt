package com.focusbuddy.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.focusbuddy.GlobalState
import com.focusbuddy.MainActivity
import com.focusbuddy.services.FaceAnalyzerService

/**
 * BootReceiver: UPGRADED Persistence Guardian.
 * One True Build - Ensures Focus Mode survives device reboots.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val validAction = intent.action == Intent.ACTION_BOOT_COMPLETED ||
                          intent.action == Intent.ACTION_MY_PACKAGE_REPLACED

        if (!validAction) return

        Log.i("FocusBuddy/Boot", "Boot/update received. Restoring state.")

        // Restore persisted GlobalState before checking session
        GlobalState.init(context)

        // Always bring MainActivity to front on boot so the app "owns" the screen
        context.startActivity(
            Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )

        // Restart face analyser only if a session was active at shutdown
        if (GlobalState.isSessionActive) {
            Log.i("FocusBuddy/Boot", "Session was active — restarting FaceAnalyzerService.")
            context.startForegroundService(
                Intent(context, FaceAnalyzerService::class.java).apply {
                    putExtra("sessionId", GlobalState.sessionId)
                    putExtra("buddyId", GlobalState.buddyId)
                }
            )
        }
    }
}
