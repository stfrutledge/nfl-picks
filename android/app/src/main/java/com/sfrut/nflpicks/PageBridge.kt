package com.sfrut.nflpicks

/** How one of the site's admin actions went, as the page reported it. */
data class AdminResult(val action: String, val ok: Boolean, val message: String, val quota: String)

/**
 * Settings and the site's page live in different activities. This is how
 * Settings reaches the page still open behind it: MainActivity lends it a way
 * to run script on the page, and passes back what the page reports through
 * window.NFLPicksApp.adminResult. All on the main thread.
 */
object PageBridge {
    /** Runs script on the page. Null when no page is open to run it on. */
    var runScript: ((String) -> Unit)? = null

    /** Whoever is waiting on an admin action's result - Admin Settings, while open. */
    var onAdminResult: ((AdminResult) -> Unit)? = null

    /** Ask the page to run an admin action. False when there is no page to ask. */
    fun runAdminAction(action: String): Boolean {
        val run = runScript ?: return false
        if (action !in SettingsActivity.ADMIN_ACTIONS) return false
        run("window.runAppAdminAction && runAppAdminAction('$action')")
        return true
    }
}
