package com.focusbuddy

import android.app.Application
import android.content.Intent
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth

/**
 * FocusBuddyApp: UPGRADED Core Application Entry.
 */
class FocusBuddyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)

        // Root cause of nativeAlert/securityThreats writes never landing:
        // FaceAnalyzerService's guards check FirebaseAuth.getInstance().currentUser,
        // but nothing was ever calling signInAnonymously() to make it non-null.
        // Separate identity from the WebView's own JS Firebase Auth session —
        // see MainActivity.getNativeDeviceId() and the linking write in App.tsx.
        if (FirebaseAuth.getInstance().currentUser == null) {
            FirebaseAuth.getInstance().signInAnonymously()
                .addOnSuccessListener {
                    Log.i("FocusBuddy/Auth", "Native anonymous auth established: ${it.user?.uid}")
                }
                .addOnFailureListener { e ->
                    Log.e("FocusBuddy/Auth", "Native anonymous auth failed — FaceAnalyzerService writes will be rejected until this succeeds", e)
                }
        }

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
