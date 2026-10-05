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

    /** This phone's FCM address. */
    private suspend fun thisPhoneToken(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            cont.resume(if (task.isSuccessful) task.result else null)
        }
    }

    private fun post(adminKey: String, payload: JSONObject): String? {
        val connection = URL("$WORKER_URL/notify").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $adminKey")
            connection.outputStream.use { it.write(payload.toString().toByteArray()) }

            val status = connection.responseCode
            if (status in 200..299) return null
            val error = (connection.errorStream ?: connection.inputStream)
                ?.bufferedReader()?.use { it.readText() }
                ?.let { runCatching { JSONObject(it).optString("error") }.getOrNull() }
            when (status) {
                401 -> "The admin key was not accepted."
                else -> error?.takeIf { it.isNotBlank() } ?: "The server answered $status."
            }
        } catch (e: Exception) {
            "Could not reach the server: ${e.message ?: e.javaClass.simpleName}"
        } finally {
            connection.disconnect()
        }
    }
}
