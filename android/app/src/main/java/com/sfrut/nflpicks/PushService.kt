package com.sfrut.nflpicks

import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Every message from the worker arrives here.
 *
 * The worker sends data-only messages, so the system never draws them on its
 * own: this phone decides (Notifications.receive) whether the category is on,
 * whether it is meant for this picker, whether to hide the scores, and whether
 * to hold it through quiet hours in this phone's own time zone.
 *
 * A message with a notification payload - the worker before 1.7's changes -
 * is drawn by the system when the app is in the background, and handed here
 * only in the foreground. It is shown as a message from Stephen.
 */
class PushService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data.toMutableMap()
        message.notification?.let { n ->
            data.putIfAbsent("title", n.title ?: "")
            data.putIfAbsent("body", n.body ?: "")
            data.putIfAbsent("category", Category.MESSAGES.id)
        }
        Notifications.receive(this, data)
    }

    override fun onNewToken(token: String) {
        // Topic delivery needs no token on our side. Re-join in case the old
        // token's subscription went with it.
        FirebaseMessaging.getInstance().subscribeToTopic(GROUP_TOPIC)
    }
}
