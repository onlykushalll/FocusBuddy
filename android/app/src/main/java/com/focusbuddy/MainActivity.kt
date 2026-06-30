package com.focusbuddy

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.PowerManager
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import com.focusbuddy.managers.WhitelistManager
import com.focusbuddy.services.FaceAnalyzerService

/**
 * MainActivity: UPGRADED Core Focus Mode Controller.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val cameraPermissionCode = 100

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Block screenshots and screen recording
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        // Lock-screen pullback support
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )

        GlobalState.init(this)
        checkPermission(Manifest.permission.CAMERA, cameraPermissionCode)

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)

        // Disable WebView debugging in release builds
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Hardening WebView settings: disable local file access
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("SetJavaScriptEnabled")
            allowUniversalAccessFromFileURLs = false
            allowFileAccessFromFileURLs = false
            setGeolocationEnabled(false)
            saveFormData = false
            builtInZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        // Use WebViewAssetLoader to load local assets over https://appassets.androidplatform.net origin
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return null
                return assetLoader.shouldInterceptRequest(url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.d("FocusBuddy/WebView", "Loaded: $url")
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return true
                val allowedHost = "appassets.androidplatform.net"
                if (url.host == allowedHost) return false
                Log.w("FocusBuddy/WebView", "Blocked navigation to external URL: $url")
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // Grant camera permission ONLY - deny geo, mic, etc.
                val allowed = request.resources.filter {
                    it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }
                if (allowed.isNotEmpty()) {
                    request.grant(allowed.toTypedArray())
                } else {
                    request.deny()
                }
            }
        }

        webView.addJavascriptInterface(AndroidBridge(), "Android")
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (GlobalState.isSessionActive) {
            when (keyCode) {
                KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_HOME -> {
                    showFocusToast()
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated for API < 33", ReplaceWith("onBackPressedDispatcher.onBackPressed()"))
    override fun onBackPressed() {
        if (GlobalState.isSessionActive) {
            showFocusToast()
            return
        }
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private fun showFocusToast() =
        Toast.makeText(this, "Focus Lock Active — Navigation Disabled", Toast.LENGTH_SHORT).show()

    private fun checkPermission(permission: String, requestCode: Int) {
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_DENIED) {
            ActivityCompat.requestPermissions(this, arrayOf(permission), requestCode)
        }
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun openAccessibilitySettings() = startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))

        @JavascriptInterface
        fun isAccessibilityEnabled(): Boolean {
            val enabledServices = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            return enabledServices.contains(packageName)
        }

        @JavascriptInterface
        fun setSessionToken(token: String) {
            GlobalState.setSessionToken(token)
        }

        @JavascriptInterface
        fun generateSessionToken(): String {
            return GlobalState.generateSessionToken()
        }

        @JavascriptInterface
        fun startFocusSession(whitelistJson: String) {
            Log.w("FocusBuddy/Bridge", "startFocusSession rejected: token required")
        }

        @JavascriptInterface
        fun startFocusSession(whitelistJson: String, sessionToken: String) {
            startFocusSession(whitelistJson, "", "", sessionToken)
        }

        @JavascriptInterface
        fun startFocusSession(whitelistJson: String, sessionId: String, buddyId: String, sessionToken: String) {
            if (!GlobalState.validateSessionToken(sessionToken)) {
                Log.w("FocusBuddy/Bridge", "startFocusSession rejected: invalid token")
                return
            }
            try {
                val arr = JSONArray(whitelistJson)
                val list = List(arr.length()) { i -> arr.getString(i) }
                    .filter { it.isNotBlank() }
                    .filterNot { HARD_NEVER_ALLOWED.contains(it) }
                GlobalState.whitelistedApps = list
                GlobalState.sessionId = sessionId
                GlobalState.buddyId = buddyId
                GlobalState.isSessionActive = true

                // Start foreground watchdog service if IDs are provided
                if (sessionId.isNotEmpty() && buddyId.isNotEmpty()) {
                    val serviceIntent = Intent(this@MainActivity, FaceAnalyzerService::class.java).apply {
                        putExtra("sessionId", sessionId)
                        putExtra("buddyId", buddyId)
                    }
                    ContextCompat.startForegroundService(this@MainActivity, serviceIntent)
                }
            } catch (e: Exception) {
                Log.e("FocusBuddy", "Error starting session", e)
            }
        }

        @JavascriptInterface
        fun stopFocusSession() {
            if (GlobalState.isSessionActive) {
                Log.w("FocusBuddy/Bridge", "stopFocusSession rejected: token required")
                return
            }
            GlobalState.isSessionActive = false
            stopService(Intent(this@MainActivity, FaceAnalyzerService::class.java))
        }

        @JavascriptInterface
        fun stopFocusSession(sessionToken: String) {
            if (!GlobalState.validateSessionToken(sessionToken)) {
                Log.w("FocusBuddy/Bridge", "stopFocusSession rejected: invalid token")
                return
            }
            GlobalState.isSessionActive = false
            stopService(Intent(this@MainActivity, FaceAnalyzerService::class.java))
        }
        @JavascriptInterface
        fun getInstalledApps(): String {
            val pm = packageManager
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            val jsonArray = JSONArray()
            for (app in apps) {
                if (pm.getLaunchIntentForPackage(app.packageName) != null) {
                    val appInfo = JSONObject()
                    appInfo.put("label", pm.getApplicationLabel(app))
                    appInfo.put("packageName", app.packageName)
                    jsonArray.put(appInfo)
                }
            }
            return jsonArray.toString()
        }

        @JavascriptInterface
        fun getAppIcon(packageName: String): String {
            return try {
                val icon = packageManager.getApplicationIcon(packageName)
                val bitmap = drawableToBitmap(icon)
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun launchApp(packageName: String) {
            Log.w("FocusBuddy/Bridge", "launchApp rejected: token required")
        }

        @JavascriptInterface
        fun launchApp(packageName: String, sessionToken: String) {
            if (!GlobalState.validateSessionToken(sessionToken)) {
                Log.w("FocusBuddy/Bridge", "launchApp rejected: invalid token")
                return
            }
            if (!WhitelistManager.isAllowed(packageName)) {
                Log.w("FocusBuddy/Bridge", "launchApp rejected: $packageName not whitelisted")
                return
            }
            val intent = packageManager.getLaunchIntentForPackage(packageName)
            intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { startActivity(it) }
        }

        @JavascriptInterface
        fun isScreenOn(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isInteractive
        }

        @JavascriptInterface
        fun copyToClipboard(text: String) {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Session Code", text))
            runOnUiThread { Toast.makeText(this@MainActivity, "Copied", Toast.LENGTH_SHORT).show() }
        }

        @JavascriptInterface
        fun shareSessionCode(code: String) {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, code)
            }
            startActivity(Intent.createChooser(intent, "Share"))
        }

        private fun drawableToBitmap(drawable: Drawable): Bitmap {
            val width = drawable.intrinsicWidth.coerceAtLeast(1)
            val height = drawable.intrinsicHeight.coerceAtLeast(1)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            return bitmap
        }
    }

    companion object {
        private val HARD_NEVER_ALLOWED = setOf(
            "com.android.settings", "com.google.android.settings",
            "com.samsung.android.settings", "com.oneplus.settings",
            "com.miui.settings", "com.huawei.settings", "com.coloros.settings",
            "com.vivo.settings", "com.realme.settings", "com.asus.settings",
            "com.lenovo.settings", "com.motorola.settings",
            "com.android.packageinstaller", "com.google.android.packageinstaller",
            "com.samsung.android.packageinstaller", "com.miui.packageinstaller",
            "com.huawei.packagemanager", "com.sec.android.app.packageinstaller",
            "com.coloros.packageinstaller", "com.android.development",
            "com.android.developer", "com.android.permissioncontroller"
        )
    }
}
