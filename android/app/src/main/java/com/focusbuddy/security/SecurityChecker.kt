package com.focusbuddy.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Debug
import android.provider.Settings
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.Socket

/**
 * SecurityChecker — Runtime anti-tamper detection.
 * 
 * Detects: root, Frida, Xposed, emulators, debuggers, safe mode, ADB,
 * developer options, and accessibility service tampering.
 */
object SecurityChecker {

    data class SecurityReport(
        val isRooted: Boolean,
        val isFridaPresent: Boolean,
        val isXposedPresent: Boolean,
        val isEmulator: Boolean,
        val isDebuggerAttached: Boolean,
        val isSafeMode: Boolean,
        val isAdbEnabled: Boolean,
        val isDevOptionsEnabled: Boolean,
        val isAccessibilityDisabled: Boolean,
        val isAppDebuggable: Boolean,
        val timestamp: Long = System.currentTimeMillis()
    ) {
        val hasAnyThreat: Boolean
            get() = isRooted || isFridaPresent || isXposedPresent || isEmulator ||
                    isDebuggerAttached || isSafeMode || isAdbEnabled ||
                    isDevOptionsEnabled || isAccessibilityDisabled
    }

    fun checkAll(context: Context): SecurityReport {
        return SecurityReport(
            isRooted = isRooted(),
            isFridaPresent = isFridaPresent(),
            isXposedPresent = isXposedPresent(),
            isEmulator = isEmulator(),
            isDebuggerAttached = isDebuggerAttached(),
            isSafeMode = isSafeMode(context),
            isAdbEnabled = isAdbEnabled(context),
            isDevOptionsEnabled = isDevOptionsEnabled(context),
            isAccessibilityDisabled = isAccessibilityDisabled(context),
            isAppDebuggable = isAppDebuggable(context)
        )
    }

    // ── Root Detection ──────────────────────────────────────────────

    fun isRooted(): Boolean {
        val suPaths = arrayOf(
            "/system/app/Superuser.apk", "/sbin/su", "/system/bin/su",
            "/system/xbin/su", "/data/local/xbin/su", "/data/local/bin/su",
            "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/su",
            "/su/bin/su", "/magisk/.core/bin/su", "/system/app/SuperSU",
            "/system/etc/init.d/99SuperSUDaemon", "/dev/com.koushikdutta.superuser.daemon/"
        )
        if (suPaths.any { File(it).exists() }) return true

        if (File("/sbin/.magisk").exists() || File("/data/adb/magisk").exists()) return true

        val tags = Build.TAGS ?: ""
        if (tags.contains("test-keys")) return true

        return false
    }

    // ── Frida Detection ─────────────────────────────────────────────

    fun isFridaPresent(): Boolean {
        // 1. Check for frida-server process
        try {
            val process = Runtime.getRuntime().exec(arrayOf("ps", "-A"))
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val lines = reader.readLines()
            if (lines.any { 
                it.contains("frida") || it.contains("gum-js-loop") || it.contains("gmain") 
            }) return true
        } catch (e: Exception) { /* ignore */ }

        // 2. Check for frida's default ports (27042, 27043)
        for (port in intArrayOf(27042, 27043)) {
            try {
                val socket = Socket("127.0.0.1", port)
                socket.close()
                return true
            } catch (e: Exception) { /* port not open */ }
        }

        // 3. Check /proc/self/maps for frida-agent
        try {
            val maps = File("/proc/self/maps").readText()
            if (maps.contains("frida") || maps.contains("gum-js-loop")) return true
        } catch (e: Exception) { /* ignore */ }

        // 4. Check for frida-specific files
        val fridaFiles = arrayOf(
            "/data/local/tmp/frida-server", "/data/local/tmp/re.frida.server",
            "/system/bin/frida-server"
        )
        if (fridaFiles.any { File(it).exists() }) return true

        return false
    }

    // ── Xposed Detection ────────────────────────────────────────────

    fun isXposedPresent(): Boolean {
        return try {
            Class.forName("de.robv.android.xposed.XposedBridge")
            true
        } catch (e: ClassNotFoundException) {
            val xposedPaths = arrayOf(
                "/system/framework/XposedBridge.jar",
                "/system/lib/libxposed_art.so",
                "/data/data/de.robv.android.xposed.installer"
            )
            xposedPaths.any { File(it).exists() }
        }
    }

    // ── Emulator Detection ──────────────────────────────────────────

    fun isEmulator(): Boolean {
        if (Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.FINGERPRINT.contains("generic") ||
            Build.MODEL.contains("google_sdk") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for x86") ||
            Build.MANUFACTURER.contains("Genymotion") ||
            Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic") ||
            Build.PRODUCT == "google_sdk" ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.HARDWARE.contains("vbox") ||
            Build.HARDWARE.contains("vulkan")) {
            return true
        }

        val emulatorFiles = arrayOf(
            "/system/bin/qemu-props", "/dev/qemu_pipe", "/dev/socket/qemud",
            "/dev/socket/baseband_genyd", "/dev/socket/genyd"
        )
        if (emulatorFiles.any { File(it).exists() }) return true

        return false
    }

    // ── Debugger Detection ──────────────────────────────────────────

    fun isDebuggerAttached(): Boolean {
        if (Debug.isDebuggerConnected()) return true

        try {
            val status = File("/proc/self/status").readText()
            val tracerPidLine = status.lines().find { it.startsWith("TracerPid:") }
            tracerPidLine?.let {
                val pid = it.substringAfter(":").trim().toIntOrNull() ?: 0
                if (pid > 0) return true
            }
        } catch (e: Exception) { /* ignore */ }

        return false
    }

    // ── Safe Mode Detection ─────────────────────────────────────────

    fun isSafeMode(context: Context): Boolean {
        return try {
            context.packageManager.isSafeMode
        } catch (e: Exception) {
            false
        }
    }

    // ── ADB Detection ───────────────────────────────────────────────

    fun isAdbEnabled(context: Context): Boolean {
        return try {
            Settings.Global.getInt(
                context.contentResolver,
                Settings.Global.ADB_ENABLED, 0
            ) == 1
        } catch (e: Exception) {
            false
        }
    }

    // ── Developer Options Detection ─────────────────────────────────

    fun isDevOptionsEnabled(context: Context): Boolean {
        return try {
            Settings.Global.getInt(
                context.contentResolver,
                Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0
            ) == 1
        } catch (e: Exception) {
            false
        }
    }

    // ── Accessibility Service Tampering Detection ───────────────────

    fun isAccessibilityDisabled(context: Context): Boolean {
        return try {
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            val expected = "com.focusbuddy/com.focusbuddy.services.AppBlockAccessibilityService"
            !enabled.contains(expected)
        } catch (e: Exception) {
            false
        }
    }

    // ── App Debuggable Check ────────────────────────────────────────

    fun isAppDebuggable(context: Context): Boolean {
        return try {
            (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        } catch (e: Exception) {
            false
        }
    }
}
