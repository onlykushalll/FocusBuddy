package com.focusbuddy

import android.content.Context
import android.content.SharedPreferences
import com.focusbuddy.managers.WhitelistManager
import org.json.JSONArray
import org.json.JSONException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * GlobalState — Thread-safe singleton for session and whitelist persistence.
 */
object GlobalState {

    private const val PREFS_NAME              = "FocusBuddyState"
    private const val KEY_SESSION_ACTIVE       = "session_active"
    private const val KEY_WHITELIST            = "whitelisted_apps"

    private val _sessionActive = AtomicBoolean(false)

    var isSessionActive: Boolean
        get() = _sessionActive.get()
        set(value) {
            val changed = _sessionActive.getAndSet(value) != value
            if (changed) persistAsync()
        }

    @Volatile
    var whitelistedApps: List<String> = emptyList()
        set(value) {
            field = value
            WhitelistManager.setUserWhitelist(value)
            persistAsync()
        }

    @Volatile
    var lastPullbackTime: Long = 0L

    @Volatile private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        if (prefs != null) return
        val p = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs = p

        _sessionActive.set(p.getBoolean(KEY_SESSION_ACTIVE, false))
        whitelistedApps = loadWhitelist(p)
    }

    private fun loadWhitelist(p: SharedPreferences): List<String> {
        val json = p.getString(KEY_WHITELIST, "[]") ?: "[]"
        return try {
            val arr = JSONArray(json)
            List(arr.length()) { i -> arr.getString(i) }.filter { it.isNotBlank() }
        } catch (e: JSONException) {
            emptyList()
        }
    }

    private fun persistAsync() {
        val p = prefs ?: return
        val arr = JSONArray()
        whitelistedApps.forEach { arr.put(it) }
        p.edit()
            .putBoolean(KEY_SESSION_ACTIVE, _sessionActive.get())
            .putString(KEY_WHITELIST, arr.toString())
            .apply()
    }
}
