package com.sfrut.nflpicks

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * A message that arrives while the app is open. In the background the system
 * draws the notification itself; in the foreground it hands it here instead
 * and shows nothing, so this draws it the same way.
 */
class PushService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: getString(R.string.app_name)
        val body = message.notification?.body ?: message.data["body"] ?: return

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(this, GROUP_TOPIC)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()

        val manager = NotificationManagerCompat.from(this)
        if (manager.areNotificationsEnabled()) {
            try {
                manager.notify(System.currentTimeMillis().toInt(), notification)
            } catch (e: SecurityException) {
                // Permission withdrawn between the check and the post.
            }
        }
    }

    override fun onNewToken(token: String) {
        // Topic delivery needs no token on our side. Re-join in case the old
        // token's subscription went with it.
        com.google.firebase.messaging.FirebaseMessaging.getInstance().subscribeToTopic(GROUP_TOPIC)
    }
}
