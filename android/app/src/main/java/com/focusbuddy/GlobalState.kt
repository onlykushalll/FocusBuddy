package com.focusbuddy

import android.content.Context
import android.content.SharedPreferences
import com.focusbuddy.managers.WhitelistManager
import org.json.JSONArray
import org.json.JSONException
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

/**
 * GlobalState — Thread-safe singleton for session and whitelist persistence.
 */
object GlobalState {

    private const val PREFS_NAME = "FocusBuddyState"
    private const val KEY_SESSION_ACTIVE = "session_active"
    private const val KEY_WHITELIST = "whitelisted_apps"
    private const val KEY_SESSION_TOKEN = "session_token"
    private const val KEY_SESSION_ID = "session_id"
    private const val KEY_BUDDY_ID = "buddy_id"

    private val _sessionActive = AtomicBoolean(false)

    var isSessionActive: Boolean
        get() = _sessionActive.get()
        set(value) {
            val changed = _sessionActive.getAndSet(value) != value
            if (changed) {
                if (!value) {
                    // Clear token and IDs on session end
                    _sessionToken = ""
                    sessionId = ""
                    buddyId = ""
                }
                persistAsync()
            }
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

    // Persisted IDs for foreground service recovery on reboot
    @Volatile
    var sessionId: String = ""
        set(value) {
            field = value
            persistAsync()
        }

    @Volatile
    var buddyId: String = ""
        set(value) {
            field = value
            persistAsync()
        }

    // Session token for JS bridge authentication
    @Volatile
    private var _sessionToken: String = ""

    fun getSessionToken(): String = _sessionToken

    fun setSessionToken(token: String) {
        _sessionToken = token
        persistAsync()
    }

    fun validateSessionToken(token: String): Boolean {
        return _sessionToken.isNotEmpty() && token == _sessionToken
    }

    @Volatile private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        if (prefs != null) return
        val p = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs = p

        _sessionActive.set(p.getBoolean(KEY_SESSION_ACTIVE, false))
        whitelistedApps = loadWhitelist(p)
        _sessionToken = p.getString(KEY_SESSION_TOKEN, "") ?: ""
        sessionId = p.getString(KEY_SESSION_ID, "") ?: ""
        buddyId = p.getString(KEY_BUDDY_ID, "") ?: ""
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
            .putString(KEY_SESSION_TOKEN, _sessionToken)
            .putString(KEY_SESSION_ID, sessionId)
            .putString(KEY_BUDDY_ID, buddyId)
            .apply()
    }

    // Generate a cryptographically secure session token
    fun generateSessionToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return android.util.Base64.encodeToString(
            bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP
        )
    }
}
