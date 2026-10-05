package com.sfrut.nflpicks

import android.app.Application
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

class NflPicksApp : Application() {

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        startPush()
    }

    /**
     * Start Firebase from the config built in from firebase.properties, and
     * join the group topic. Without that config there is no push: the rest of
     * the app works the same.
     */
    private fun startPush() {
        if (!pushConfigured) return
        if (FirebaseApp.getApps(this).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(this, options)
        }
        // Subscribing again is harmless, and it repairs a subscription lost to
        // a reinstall or a cleared token.
        FirebaseMessaging.getInstance().subscribeToTopic(GROUP_TOPIC)
            .addOnCompleteListener { task ->
                Prefs(this).subscribed = task.isSuccessful
                if (!task.isSuccessful) Log.w(TAG, "Topic subscribe failed", task.exception)
            }
    }

    companion object {
        const val TAG = "NflPicks"
        val pushConfigured: Boolean
            get() = BuildConfig.FIREBASE_APP_ID.isNotEmpty() && BuildConfig.FIREBASE_PROJECT_ID.isNotEmpty()
    }
}
