package com.focusbuddy.managers

/**
 * WhitelistManager — Single source of truth for allowed apps.
 */
object WhitelistManager {

    private val ESSENTIAL_PACKAGES: Set<String> = setOf(
        "com.focusbuddy",
        "com.android.systemui",
        "com.samsung.android.systemui",
        "com.android.dialer",
        "com.google.android.dialer",
        "com.samsung.android.dialer",
        "com.android.emergency",
        "com.google.android.apps.messaging",
        "com.android.messaging",
        "com.samsung.android.messaging",
        "com.google.android.deskclock",
        "com.android.deskclock",
        "com.sec.android.app.clockpackage",
        "com.android.calculator2",
        "com.google.android.calculator",
        "com.sec.android.app.popupcalculator",
        "com.android.calendar",
        "com.google.android.calendar",
        "com.android.camera",
        "com.android.camera2",
        "com.google.android.GoogleCamera",
        "com.sec.android.app.camera",
    )

    private val userPackages = mutableSetOf<String>()

    fun setUserWhitelist(packages: List<String>) {
        userPackages.clear()
        userPackages.addAll(packages)
    }

    fun isAllowed(packageName: String): Boolean =
        ESSENTIAL_PACKAGES.contains(packageName) || userPackages.contains(packageName)
}
