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

    /**
     * Whether a key is the admin key: its SHA-256 against the one built in
     * from admin.properties. A build without that hash accepts any key, and
     * the worker - which checks the real secret - is then the only gate.
     */
    fun isAdminKey(key: String): Boolean {
        val expected = BuildConfig.ADMIN_KEY_SHA256
        val trimmed = key.trim()
        if (trimmed.isEmpty()) return false
        if (expected.isEmpty()) return true
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(trimmed.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return java.security.MessageDigest.isEqual(digest.toByteArray(), expected.lowercase().toByteArray())
    }

    /** This phone has the admin key, so Admin Settings opens without asking. */
    val adminUnlocked: Boolean
        get() = isAdminKey(adminKey)

    /**
     * The site's saved theme toggle as last read off the page: true dark,
     * false light, null never set (Settings then follows the phone, as the
     * site does).
     */
    var siteDark: Boolean?
        get() = if (prefs.contains("siteDark")) prefs.getBoolean("siteDark", false) else null
        set(value) = prefs.edit().apply {
            if (value == null) remove("siteDark") else putBoolean("siteDark", value)
        }.apply()

    /**
     * The exact address of the last page that loaded in full. Every load has
     * its own address (MainActivity.load), and the WebView's cache keeps pages
     * by address, so this is how an offline start finds the last one.
     */
    var lastPageUrl: String?
        get() = prefs.getString("lastPageUrl", null)
        set(value) = prefs.edit().putString("lastPageUrl", value).apply()

    /** Whether Settings has already shown the system's permission prompt. */
    var askedForNotifications: Boolean
        get() = prefs.getBoolean("askedForNotifications", false)
        set(value) = prefs.edit().putBoolean("askedForNotifications", value).apply()

    // --- Notification settings: every category on, spoiler-free, quiet
    // midnight to 9am. The defaults the group agreed; each phone can change.

    fun categoryOn(category: Category): Boolean = prefs.getBoolean("notify.${category.id}", true)
    fun setCategoryOn(category: Category, on: Boolean) =
        prefs.edit().putBoolean("notify.${category.id}", on).apply()

    var spoilerFree: Boolean
        get() = prefs.getBoolean("notify.spoilerFree", true)
        set(value) = prefs.edit().putBoolean("notify.spoilerFree", value).apply()

    var quietOn: Boolean
        get() = prefs.getBoolean("notify.quietOn", true)
        set(value) = prefs.edit().putBoolean("notify.quietOn", value).apply()

    /** Minutes after midnight. */
    var quietStart: Int
        get() = prefs.getInt("notify.quietStart", 0)
        set(value) = prefs.edit().putInt("notify.quietStart", value).apply()

    var quietEnd: Int
        get() = prefs.getInt("notify.quietEnd", 9 * 60)
        set(value) = prefs.edit().putInt("notify.quietEnd", value).apply()

    /** Everything Delivery.decide needs to know about this phone. */
    fun deliverySettings() = DeliverySettings(
        picker = picker,
        enabled = Category.entries.filter { categoryOn(it) }.toSet(),
        spoilerFree = spoilerFree,
        quietOn = quietOn,
        quietStart = quietStart,
        quietEnd = quietEnd
    )

    var subscribed: Boolean
        get() = prefs.getBoolean("subscribed", false)
        set(value) = prefs.edit().putBoolean("subscribed", value).apply()
}
