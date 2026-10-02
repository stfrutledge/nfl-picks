package com.sfrut.nflpicks

import android.content.Context

/** The five pickers, in the order the site lists them. Cowherd is not a person with a phone. */
val PICKERS = listOf("Daniel", "Dylan", "Jason", "Sean", "Stephen")

/** Who can send messages to the group: the same rule as the site's admin-only buttons. */
const val ADMIN_PICKER = "Stephen"

const val SITE_URL = "https://stfrutledge.github.io/nfl-picks/"
const val WORKER_URL = "https://nfl-picks-proxy.stfrutledge.workers.dev"

/** Everyone's phone subscribes to this one FCM topic, so a message to it reaches the group. */
const val GROUP_TOPIC = "group"

/**
 * What this phone remembers. No login: a picker is just a name chosen in
 * Settings, the same trust the site already runs on.
 */
class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("nflpicks", Context.MODE_PRIVATE)

    var picker: String?
        get() = prefs.getString("picker", null)
        set(value) = prefs.edit().putString("picker", value).apply()

    /**
     * The worker's NOTIFY_SECRET, typed in once on the admin's phone. It is
     * never built into the APK, which goes to everyone.
     */
    var adminKey: String
        get() = prefs.getString("adminKey", "") ?: ""
        set(value) = prefs.edit().putString("adminKey", value.trim()).apply()

    /** Whether Settings has already shown the system's permission prompt. */
    var askedForNotifications: Boolean
        get() = prefs.getBoolean("askedForNotifications", false)
        set(value) = prefs.edit().putBoolean("askedForNotifications", value).apply()

    var subscribed: Boolean
        get() = prefs.getBoolean("subscribed", false)
        set(value) = prefs.edit().putBoolean("subscribed", value).apply()
}
