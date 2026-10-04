package com.sfrut.nflpicks

import org.json.JSONTokener

/** How one of the site's admin actions went, as the page reported it. */
data class AdminResult(val action: String, val ok: Boolean, val message: String, val quota: String)

/**
 * Settings and the site's page live in different activities. This is how
 * Settings reaches the page still open behind it: MainActivity lends it a way
 * to run script on the page, and passes back what the page reports through
 * window.NFLPicksApp.adminResult. All on the main thread.
 */
object PageBridge {
    /** Runs script on the page and hands back its JSON result. Null when no page is open. */
    var runScript: ((script: String, onResult: (String) -> Unit) -> Unit)? = null

    /** Whoever is waiting on an admin action's result - Admin Settings, while open. */
    var onAdminResult: ((AdminResult) -> Unit)? = null

    /**
     * Ask the page to run an admin action and report back. `onStarted` hears
     * whether it did: false means a page too old to report - an older copy of
     * the site, still cached - which only knows to click its own buttons, and
     * would leave Settings waiting for an answer that never comes. The caller
     * falls back to closing Settings and letting the page show its result.
     *
     * Returns false when there is no page to ask at all.
     */
    fun runAdminAction(action: String, onStarted: (Boolean) -> Unit): Boolean {
        val run = runScript ?: return false
        if (action !in SettingsActivity.ADMIN_ACTIONS) return false
        // refreshSpreadsNow arrived with the reporting version of
        // runAppAdminAction, so it marks a page that will answer.
        val script = """
            (function () {
                if (typeof refreshSpreadsNow !== 'function' || typeof runAppAdminAction !== 'function') return 'old';
                runAppAdminAction('$action');
                return 'started';
            })()
        """.trimIndent()
        run(script) { json ->
            val answer = runCatching { JSONTokener(json).nextValue() as? String }.getOrNull()
            onStarted(answer == "started")
        }
        return true
    }
}
