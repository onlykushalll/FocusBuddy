package com.focusbuddy.services

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.focusbuddy.GlobalState
import com.focusbuddy.MainActivity
import com.focusbuddy.managers.WhitelistManager

/**
 * FocusLockService — Maximum-strength AccessibilityService kiosk enforcement.
 * Upgraded to Instant watchdog (millisecond pullback, launcher removed).
 */
class AppBlockAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "FocusLockService"
        
        // PERSISTENCE constants
        private const val PERSISTENCE_TICK_MS   = 50L    // 50ms check
        private const val ESCALATION_THRESHOLD_MS = 200L  // 200ms before aggressive pullback

        private val HARD_BLOCKED_PACKAGES = setOf(
            "com.android.settings", "com.google.android.settings", "com.samsung.android.settings",
            "com.oneplus.settings", "com.miui.settings", "com.huawei.settings", "com.coloros.settings",
            "com.vivo.settings", "com.realme.settings", "com.asus.settings", "com.lenovo.settings",
            "com.motorola.settings", "com.android.packageinstaller", "com.google.android.packageinstaller",
            "com.samsung.android.packageinstaller", "com.miui.packageinstaller", "com.huawei.packagemanager",
            "com.sec.android.app.packageinstaller", "com.coloros.packageinstaller", "com.android.development",
            "com.android.developer", "com.android.permissioncontroller",
            "com.google.android.googlequicksearchbox", "com.google.android.voiceinteraction",
            "com.google.android.apps.assistant", "com.android.bluetooth"
        )

        private val ALWAYS_ALLOWED_SYSTEM = setOf(
            "com.android.systemui", "com.samsung.android.systemui", "android"
            // Launcher removed — FocusMode is the home screen
        )
    }

    private val bgThread = HandlerThread("FocusLock-BG", Thread.NORM_PRIORITY + 1).also { it.start() }
    private val bgHandler   = Handler(bgThread.looper)

    @Volatile private var blockedPackage = ""
    @Volatile private var blockedSinceMs = 0L
    @Volatile private var persistenceActive = false

    private val persistenceRunnable = object : Runnable {
        override fun run() {
            if (!GlobalState.isSessionActive || blockedPackage.isEmpty()) {
                resetPersistenceState()
                return
            }
            val heldMs = System.currentTimeMillis() - blockedSinceMs
            if (heldMs >= ESCALATION_THRESHOLD_MS) {
                Log.w(TAG, "UPGRADED ESCALATION: $blockedPackage held for ${heldMs}ms — Aggressive Pullback")
                firePullback()
            }
            bgHandler.postDelayed(this, PERSISTENCE_TICK_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or 
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or 
                    AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS or
                    AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            notificationTimeout = 0
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!GlobalState.isSessionActive) {
            stopPersistence()
            return
        }
        val pkg = event?.packageName?.toString() ?: return

        // Block notification shade expansion instantly
        if (pkg == "com.android.systemui" || pkg == "com.samsung.android.systemui") {
            if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                val className = event.className?.toString() ?: ""
                if (className.contains("StatusBar") || 
                    className.contains("ExpandedDesktop") ||
                    className.contains("NotificationPanel") ||
                    className.contains("QuickSettings") ||
                    className.contains("com.android.systemui.statusbar.phone.StatusBar")) {
                    performGlobalAction(GLOBAL_ACTION_BACK)
                    Log.i(TAG, "Blocked notification shade expansion")
                    return
                }
            }
        }

        // Block Google Assistant overlay instantly
        if (pkg == "com.google.android.googlequicksearchbox" ||
            pkg == "com.google.android.voiceinteraction" ||
            pkg == "com.google.android.apps.assistant") {
            performGlobalAction(GLOBAL_ACTION_BACK)
            firePullback()
            return
        }

        // Synchronous evaluation — no thread switch or debounce delay
        evaluatePackage(pkg)
    }

    override fun onKeyEvent(event: KeyEvent?): Boolean {
        if (!GlobalState.isSessionActive || event == null) return false
        return when (event.keyCode) {
            KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_BACK -> true
            else -> false
        }
    }

    private fun evaluatePackage(pkg: String) {
        if (!GlobalState.isSessionActive) return
        
        when {
            HARD_BLOCKED_PACKAGES.contains(pkg) -> onBlockedAppDetected(pkg)
            pkg == packageName -> resetPersistenceState()  // FocusBuddy itself
            WhitelistManager.isAllowed(pkg) -> resetPersistenceState()
            ALWAYS_ALLOWED_SYSTEM.contains(pkg) -> resetPersistenceState()
            else -> onBlockedAppDetected(pkg)  // launcher + all non-whitelisted apps
        }
    }

    private fun onBlockedAppDetected(pkg: String) {
        val now = System.currentTimeMillis()
        
        // INSTANT pullback — no debounce
        // Use GLOBAL_ACTION_BACK first (instant), then startActivity (slower but thorough)
        performGlobalAction(GLOBAL_ACTION_BACK)
        firePullback()
        
        if (blockedPackage != pkg) {
            blockedPackage = pkg
            blockedSinceMs = now
        }
        startPersistence()
    }

    private fun firePullback() {
        Log.i(TAG, "PULLBACK → MainActivity")
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or 
                     Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        startActivity(intent)
    }

    private fun startPersistence() {
        if (persistenceActive) return
        persistenceActive = true
        bgHandler.postDelayed(persistenceRunnable, PERSISTENCE_TICK_MS)
    }

    private fun stopPersistence() {
        persistenceActive = false
        bgHandler.removeCallbacks(persistenceRunnable)
    }

    private fun resetPersistenceState() {
        stopPersistence()
        blockedPackage = ""
        blockedSinceMs = 0L
    }

    override fun onInterrupt() {}
    override fun onDestroy() {
        super.onDestroy()
        bgThread.quitSafely()
    }
}
