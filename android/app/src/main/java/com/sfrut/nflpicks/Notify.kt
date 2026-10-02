package com.sfrut.nflpicks

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sending a message to the group: a POST to the worker's /notify, which holds
 * the Firebase credentials and sends to the group topic. The admin key is the
 * worker's NOTIFY_SECRET; without it the worker refuses.
 */
object Notify {

    /** Null on success, or what went wrong, in words fit for the screen. */
    fun send(adminKey: String, title: String, body: String): String? {
        val connection = URL("$WORKER_URL/notify").openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $adminKey")
            val payload = JSONObject().put("title", title).put("body", body).toString()
            connection.outputStream.use { it.write(payload.toByteArray()) }

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
