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
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * MainActivity: UPGRADED Core Focus Mode Controller.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val cameraPermissionCode = 100

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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

        webView = WebView(this).also { setContentView(it) }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            @Suppress("SetJavaScriptEnabled")
            allowUniversalAccessFromFileURLs = true
            allowFileAccessFromFileURLs = true
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                Log.d("FocusBuddy/WebView", "Loaded: $url")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // Grant permissions for camera (FaceSecurityEngine)
                request.grant(request.resources)
            }
        }

        webView.addJavascriptInterface(AndroidBridge(), "Android")
        webView.loadUrl("file:///android_asset/index.html")
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
        fun startFocusSession(whitelistJson: String) {
            try {
                val arr = JSONArray(whitelistJson)
                val list = List(arr.length()) { i -> arr.getString(i) }
                GlobalState.whitelistedApps = list
                GlobalState.isSessionActive = true
            } catch (e: Exception) {
                Log.e("FocusBuddy", "Error starting session", e)
            }
        }

        @JavascriptInterface
        fun stopFocusSession() {
            GlobalState.isSessionActive = false
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
}
