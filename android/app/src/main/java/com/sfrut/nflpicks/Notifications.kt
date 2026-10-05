package com.sfrut.nflpicks

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

/**
 * Showing a notification on this phone: one channel per [Category], the rules
 * in [Delivery], and a WorkManager job for anything held through quiet hours.
 */
object Notifications {

    private const val TAG = "NflPicksNotify"

    /** One channel per category, so each can also be managed in system settings. */
    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        Category.entries.forEach { category ->
            val importance = if (category == Category.BLAZIN_RESULTS)
                NotificationManager.IMPORTANCE_DEFAULT else NotificationManager.IMPORTANCE_HIGH
            manager.createNotificationChannel(
                NotificationChannel(category.id, category.label, importance)
                    .apply { description = category.description }
            )
        }
        // The single channel versions before 1.7 used; messages go to "messages" now.
        manager.deleteNotificationChannel("group")
    }

    /**
     * A message from the worker, as FCM delivers its data. Decides here and
     * either shows it, holds it until quiet hours end, or drops it.
     */
    fun receive(context: Context, data: Map<String, String>) {
        val msg = parse(data) ?: return
        val decision = Delivery.decide(msg, Prefs(context).deliverySettings(), ZonedDateTime.now())
        when (decision) {
            is Decision.Drop -> Log.i(TAG, "Dropped ${msg.category.id}: ${decision.reason}")
            is Decision.Show -> if (decision.held) hold(context, data, decision.atMillis)
                else show(context, msg.category, decision.title, decision.body, data["id"])
        }
    }

    /** The worker's data fields, as an [Incoming]. Null when there is nothing to show. */
    fun parse(data: Map<String, String>): Incoming? {
        val title = data["title"]?.takeIf { it.isNotBlank() } ?: "NFL Picks"
        val personal = data["personal"]?.let { json ->
            runCatching {
                val obj = JSONObject(json)
                obj.keys().asSequence().associateWith { obj.getString(it) }
            }.getOrNull()
        }
        val body = data["body"].orEmpty()
        if (body.isBlank() && personal == null) return null
        return Incoming(
            category = Category.of(data["category"]),
            title = title,
            body = body,
            spoilerTitle = data["spoilerTitle"],
            spoilerBody = data["spoilerBody"],
            personal = personal,
            expiresAt = data["expiresAt"]?.toLongOrNull()
        )
    }

    /** Hold a notification until [atMillis], then run it through [Delivery] again. */
    private fun hold(context: Context, data: Map<String, String>, atMillis: Long) {
        val delay = (atMillis - System.currentTimeMillis()).coerceAtLeast(0)
        val request = OneTimeWorkRequestBuilder<HeldNotificationWorker>()
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setInputData(workDataOf(*data.map { (k, v) -> k to v }.toTypedArray()))
            .build()
        // One job per message: the same message delivered twice replaces itself.
        val name = "held-" + (data["id"] ?: data.hashCode().toString())
        WorkManager.getInstance(context).enqueueUniqueWork(name, ExistingWorkPolicy.REPLACE, request)
        Log.i(TAG, "Holding ${data["category"]} until $atMillis")
    }

    fun show(context: Context, category: Category, title: String, body: String, id: String?) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return

        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(context, category.id)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try {
            // Same id, same notification: a message delivered twice replaces itself.
            manager.notify((id ?: "$title|$body").hashCode(), notification)
        } catch (e: SecurityException) {
            // Notification permission withdrawn between the check and the post.
        }
    }
}

/**
 * A notification held through quiet hours. When it runs, the rules are applied
 * again - the person may have switched the category off in the meantime, and a
 * reminder may have gone stale - with quiet hours now behind it.
 */
class HeldNotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val data = inputData.keyValueMap.mapValues { it.value.toString() }
        val msg = Notifications.parse(data) ?: return Result.success()
        val settings = Prefs(applicationContext).deliverySettings().copy(quietOn = false)
        val decision = Delivery.decide(msg, settings, ZonedDateTime.now())
        if (decision is Decision.Show) {
            Notifications.show(applicationContext, msg.category, decision.title, decision.body, data["id"])
        }
        return Result.success()
    }
}
