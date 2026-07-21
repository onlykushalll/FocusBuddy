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
import android.net.Uri
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.view.MotionEvent
import android.view.InputDevice
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
import com.focusbuddy.R

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
        requestAppPermissions()

        webView = WebView(this).also { setContentView(it) }

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
            // The bundled MediaPipe WASM/model files live at
            // android/app/src/main/assets/mediapipe/, a sibling of the inner
            // assets/ folder — not nested inside it. The JS side requests
            // them from solutionPath: '/mediapipe', which was previously
            // completely unhandled (only /assets/ was registered), so every
            // model fetch silently failed and face detection never ran at
            // all, despite the files genuinely being present on disk.
            .addPathHandler("/mediapipe/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return null
                val response = assetLoader.shouldInterceptRequest(url) ?: return null
                // Only correcting the .wasm MIME type here - Android's default
                // MimeTypeMap doesn't reliably know .wasm on all API levels/OEM
                // builds, and a wrong or missing type can break WASM streaming
                // instantiation. COOP/COEP headers were considered (Tasks
                // Vision's WASM can use SharedArrayBuffer for multithreading)
                // but deliberately left out: require-corp blocks any
                // cross-origin resource that doesn't explicitly opt in with its
                // own Cross-Origin-Resource-Policy header, which includes
                // Google Fonts and potentially Firebase's own network calls -
                // servers this app doesn't control. The speculative threading
                // benefit isn't worth risking core connectivity over. Wrapped
                // in a try/catch that falls back to the unmodified response on
                // any failure regardless.
                return try {
                    val path = url.path ?: ""
                    var mimeType = response.mimeType
                    if (path.endsWith(".wasm") && mimeType != "application/wasm") {
                        mimeType = "application/wasm"
                    }
                    if (mimeType == response.mimeType) {
                        response
                    } else {
                        WebResourceResponse(
                            mimeType,
                            response.encoding,
                            response.statusCode,
                            response.reasonPhrase,
                            response.responseHeaders,
                            response.data
                        )
                    }
                } catch (e: Exception) {
                    Log.w("FocusBuddy/WebView", "Failed to correct WASM MIME type, serving unmodified response", e)
                    response
                }
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

            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: android.webkit.JsResult?
            ): Boolean {
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Focus Buddy")
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setCancelable(false)
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?,
                url: String?,
                message: String?,
                result: android.webkit.JsResult?
            ): Boolean {
                androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Focus Buddy")
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setCancelable(false)
                    .show()
                return true
            }
        }

        webView.addJavascriptInterface(AndroidBridge(), "Android")
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    override fun onResume() {
        super.onResume()
        if (GlobalState.isSessionActive) {
            startAnalyzerService("ACTION_STOP_CAMERA")
        }
    }

    override fun onPause() {
        super.onPause()
        if (GlobalState.isSessionActive) {
            startAnalyzerService("ACTION_START_CAMERA")
        }
    }

    private fun startAnalyzerService(actionStr: String) {
        val intent = Intent(this, FaceAnalyzerService::class.java).apply {
            action = actionStr
            putExtra("sessionId", GlobalState.sessionId)
            putExtra("buddyId", GlobalState.buddyId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
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

    private fun requestAppPermissions() {
        val permissions = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val toRequest = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_DENIED
        }
        if (toRequest.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, toRequest.toTypedArray(), cameraPermissionCode)
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        if (ev != null && GlobalState.isSessionActive) {
            val source = ev.source
            if (source and InputDevice.SOURCE_TOUCHSCREEN == 0) {
                Log.w("FocusBuddy/Security", "Touch event ignored: non-touchscreen input source $source (possible ADB touch injection)")
                return true // Consume and block touch event
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun openAccessibilitySettings() = startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))

        @JavascriptInterface
        fun openAppSettings() {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        }

        @JavascriptInterface
        fun isCameraPermissionGranted(): Boolean {
            return ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }

        @JavascriptInterface
        fun isNotificationPermissionGranted(): Boolean {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            }
            return true
        }

        @JavascriptInterface
        fun isAccessibilityEnabled(): Boolean {
            val enabledServices = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            return enabledServices.contains(packageName)
        }

        @JavascriptInterface
        fun isOverlayPermissionEnabled(): Boolean {
            return Settings.canDrawOverlays(this@MainActivity)
        }

        @JavascriptInterface
        fun openOverlayPermissionSettings() {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
        }

        @JavascriptInterface
        fun isBatteryOptimizationIgnored(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(packageName)
        }

        @JavascriptInterface
        fun openBatteryOptimizationSettings() {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
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
                val fullSize = drawableToBitmap(icon)
                // Downscale before encoding — intrinsic icon bitmaps can be 192x192+
                // on modern devices, producing a 20-50KB base64 string per icon.
                val scaled = Bitmap.createScaledBitmap(fullSize, ICON_TARGET_PX, ICON_TARGET_PX, true)
                if (scaled !== fullSize) fullSize.recycle()
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
                scaled.recycle()
                Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } catch (e: Exception) { "" }
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
        fun getSessionToken(): String {
            return GlobalState.getSessionToken()
        }

        @JavascriptInterface
        fun getNativeDeviceId(): String {
            return com.google.firebase.auth.FirebaseAuth.getInstance().currentUser?.uid ?: ""
        }

        @JavascriptInterface
        fun setPausedByFace(paused: Boolean) {
            GlobalState.isPausedByFace = paused
            if (paused && GlobalState.isSessionActive) {
                Log.w("FocusBuddy/Bridge", "Instant pullback triggered by setPausedByFace")
                val intent = Intent(this@MainActivity, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or 
                             Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                startActivity(intent)
            }
        }

        @JavascriptInterface
        fun updateWhitelist(whitelistJson: String, sessionToken: String) {
            if (!GlobalState.validateSessionToken(sessionToken)) {
                Log.w("FocusBuddy/Bridge", "updateWhitelist rejected: invalid token")
                return
            }
            try {
                val arr = org.json.JSONArray(whitelistJson)
                val list = List(arr.length()) { i -> arr.getString(i) }
                    .filter { it.isNotBlank() }
                    .filterNot { HARD_NEVER_ALLOWED.contains(it) }
                GlobalState.whitelistedApps = list
            } catch (e: Exception) {
                Log.e("FocusBuddy", "Error updating whitelist", e)
            }
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
            var width = drawable.intrinsicWidth
            var height = drawable.intrinsicHeight
            if (width <= 0 || height <= 0) {
                width = 72
                height = 72
            }
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            return bitmap
        }
    }

    companion object {
        private const val ICON_TARGET_PX = 96
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
