package com.sfrut.nflpicks

import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume

/**
 * Sending through the worker's /notify, which holds the Firebase credentials.
 * The admin key is the worker's NOTIFY_SECRET; without it the worker refuses.
 */
object Notify {

    /** A message to the whole group. Null on success, or what went wrong. */
    fun send(adminKey: String, title: String, body: String): String? =
        post(adminKey, JSONObject().put("title", title).put("body", body))

    /**
     * A test to this phone only: any category, with the fields a real one
     * carries, so it goes through the same rules - the category switches,
     * spoiler-free and quiet hours - as the real thing would.
     */
    suspend fun sendTest(
        adminKey: String, category: Category, title: String, body: String,
        spoilerTitle: String? = null, spoilerBody: String? = null, personal: Map<String, String>? = null
    ): String? {
        val token = thisPhoneToken() ?: return "Could not get this phone's notification address."
        val payload = JSONObject()
            .put("title", title).put("body", body)
            .put("token", token).put("category", category.id)
        spoilerTitle?.let { payload.put("spoilerTitle", it) }
        spoilerBody?.let { payload.put("spoilerBody", it) }
        personal?.let { payload.put("personal", JSONObject(it)) }
        return post(adminKey, payload)
    }

    /**
     * A real-data test: the worker builds this week's actual Blazin' 5 result
     * (as it stands) or the list of who still has picks to make, from the real
     * picks, lines and scores, and sends it to this phone only.
     *
     * Returns (ok, what to show): the error, the worker's reason for sending
     * nothing ("Everyone's picks are in"), or null when it was sent.
     */
    suspend fun sendPreview(adminKey: String, category: Category): Pair<Boolean, String?> {
        val token = thisPhoneToken() ?: return false to "Could not get this phone's notification address."
        val payload = JSONObject().put("token", token).put("preview", category.id)
        val (error, answer) = postForAnswer(adminKey, payload)
        if (error != null) return false to error
        if (answer?.optBoolean("sent", true) == false) return true to answer.optString("note").ifBlank { "Nothing to send." }
        return true to null
    }

    /** This phone's FCM address. */
    private suspend fun thisPhoneToken(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            cont.resume(if (task.isSuccessful) task.result else null)
        }
    }

    private fun post(adminKey: String, payload: JSONObject): String? = postForAnswer(adminKey, payload).first

    /** (error or null, the worker's JSON answer on success). */
    private fun postForAnswer(adminKey: String, payload: JSONObject): Pair<String?, JSONObject?> {
        val connection = URL("$WORKER_URL/notify").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            // A real-data test reads the Google Sheet, which can take 30s.
            connection.readTimeout = 60_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $adminKey")
            connection.outputStream.use { it.write(payload.toString().toByteArray()) }

            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream ?: connection.inputStream)
                ?.bufferedReader()?.use { it.readText() }
            val json = text?.let { runCatching { JSONObject(it) }.getOrNull() }
            if (status in 200..299) return null to json
            val error = when (status) {
                401 -> "The admin key was not accepted."
                else -> json?.optString("error")?.takeIf { it.isNotBlank() } ?: "The server answered $status."
            }
            error to null
        } catch (e: Exception) {
            "Could not reach the server: ${e.message ?: e.javaClass.simpleName}" to null
        } finally {
            connection.disconnect()
        }
    }
}
