package com.sfrut.nflpicks

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** How one of the site's admin actions went, as the page reported it. */
data class AdminResult(val action: String, val ok: Boolean, val message: String, val quota: String)

/** One locked pick, as the page describes it: "Rams @ Seahawks", "Rams +3". */
data class LockedPick(val key: String, val game: String, val line: String, val started: Boolean)

/** A picker's locked picks for the week on the page. */
data class LockedGroup(val picker: String, val picks: List<LockedPick>)

/** The week's locked picks, or why there are none to show. */
data class LockedWeek(val week: Int, val label: String, val historical: Boolean, val groups: List<LockedGroup>)

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

    /** What a page call came back with: no page, a page too old to know it, or the answer. */
    sealed interface Reply<out T> {
        data object NoPage : Reply<Nothing>
        data object OldPage : Reply<Nothing>
        data class Ok<T>(val value: T) : Reply<T>
    }

    /** The locked picks for the week the page is on (site's appLockedPicks). */
    fun lockedPicks(onResult: (Reply<LockedWeek>) -> Unit) {
        val run = runScript ?: return onResult(Reply.NoPage)
        run("window.appLockedPicks ? appLockedPicks() : null") { json ->
            val page = runCatching { JSONTokener(json).nextValue() as? JSONObject }.getOrNull()
            onResult(if (page == null) Reply.OldPage else Reply.Ok(parseLockedWeek(page)))
        }
    }

    /**
     * Unlock some of one picker's games in `week` (site's appUnlockPicks). The
     * arguments go in as JSON literals, so no name or key can break the script.
     */
    fun unlockPicks(week: Int, picker: String, keys: List<String>, onResult: (Reply<Pair<Boolean, String>>) -> Unit) {
        val run = runScript ?: return onResult(Reply.NoPage)
        val script = "window.appUnlockPicks ? appUnlockPicks(${JSONObject.quote(picker)}, " +
            "${JSONArray(keys)}, $week) : null"
        run(script) { json ->
            val page = runCatching { JSONTokener(json).nextValue() as? JSONObject }.getOrNull()
            onResult(
                if (page == null) Reply.OldPage
                else Reply.Ok(page.optBoolean("ok") to page.optString("message"))
            )
        }
    }

    private fun parseLockedWeek(page: JSONObject): LockedWeek {
        val pickers = page.optJSONArray("pickers") ?: JSONArray()
        val groups = (0 until pickers.length()).map { i ->
            val group = pickers.getJSONObject(i)
            val picks = group.optJSONArray("picks") ?: JSONArray()
            LockedGroup(
                group.optString("picker"),
                (0 until picks.length()).map { j ->
                    val pick = picks.getJSONObject(j)
                    LockedPick(pick.optString("key"), pick.optString("game"),
                        pick.optString("line"), pick.optBoolean("started"))
                }
            )
        }
        return LockedWeek(page.optInt("week"), page.optString("weekLabel"), page.optBoolean("historical"), groups)
    }
}
