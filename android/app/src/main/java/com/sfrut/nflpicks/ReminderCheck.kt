package com.sfrut.nflpicks

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Whether a pick reminder held through quiet hours is still true, from the
 * worker's /reminder-check, which rebuilds it for one picker from the sheet as
 * it stands now. Asked as the held reminder is released (HeldNotificationWorker).
 */
object ReminderCheck {

    sealed interface Answer {
        /** Nothing left to pick: drop the reminder. */
        data object NothingLeft : Answer
        /** Still something to do, worded for now. */
        data class StillDue(val body: String) : Answer
        /** No answer: show the reminder as it was. */
        data object Unknown : Answer
    }

    suspend fun ask(id: String, picker: String): Answer = withContext(Dispatchers.IO) {
        val query = "id=${URLEncoder.encode(id, "UTF-8")}&picker=${URLEncoder.encode(picker, "UTF-8")}"
        val connection = URL("$WORKER_URL/reminder-check?$query").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            // It reads the Google Sheet, which can be slow.
            connection.readTimeout = 45_000
            if (connection.responseCode != 200) return@withContext Answer.Unknown
            val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            when {
                // An older worker has no /reminder-check and answers 404 above.
                !json.has("remind") -> Answer.Unknown
                !json.getBoolean("remind") -> Answer.NothingLeft
                else -> json.optString("body").takeIf { it.isNotBlank() }?.let { Answer.StillDue(it) } ?: Answer.Unknown
            }
        } catch (e: Exception) {
            Answer.Unknown
        } finally {
            connection.disconnect()
        }
    }
}
