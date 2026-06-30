package com.focusbuddy

import android.app.Application
import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory

/**
 * FocusBuddyApp: UPGRADED Core Application Entry.
 */
class FocusBuddyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)

        // Configure Firebase App Check with Play Integrity
        val firebaseAppCheck = FirebaseAppCheck.getInstance()
        firebaseAppCheck.installAppCheckProviderFactory(
            PlayIntegrityAppCheckProviderFactory.getInstance()
        )

        GlobalState.init(this)

        // ANTI-CHEAT CRASH HANDLER: Force restart app if crashed during active session
        Thread.setDefaultUncaughtExceptionHandler { _, _ ->
            if (GlobalState.isSessionActive) {
                val intent = Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                }
                startActivity(intent)
            }
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }
}
