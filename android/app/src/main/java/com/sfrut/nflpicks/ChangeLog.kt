package com.sfrut.nflpicks

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One day's changes to the site, as Settings' Change log shows them. */
data class ChangeLogEntry(val date: String, val items: List<String>)

/**
 * The change log is changelog.json on the site, not part of the APK, so a new
 * entry reaches every phone with a commit and no rebuild.
 */
object ChangeLog {

    /** The entries, newest first, or null when the site can't be reached. */
    fun fetch(): List<ChangeLogEntry>? {
        // A query string so a phone's HTTP cache never serves an old copy.
        val connection = URL("${SITE_URL}changelog.json?t=${System.currentTimeMillis()}")
            .openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            if (connection.responseCode !in 200..299) return null
            val entries = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                .getJSONArray("entries")
            (0 until entries.length()).map { i ->
                val entry = entries.getJSONObject(i)
                val items = entry.getJSONArray("items")
                ChangeLogEntry(
                    formatDate(entry.optString("date")),
                    (0 until items.length()).map { items.getString(it) }
                )
            }
        } catch (e: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    /** "2026-10-13" as "13 Oct 2026"; anything unreadable as it came. */
    private fun formatDate(iso: String): String =
        runCatching {
            LocalDate.parse(iso).format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.UK))
        }.getOrDefault(iso)
}
