package com.sfrut.nflpicks

import java.time.LocalTime
import java.time.ZonedDateTime

/**
 * The kinds of notification, each one a switch in Settings and a channel in
 * the phone's own notification settings. The ids are what the worker sends.
 */
enum class Category(val id: String, val label: String, val description: String) {
    BLAZIN_RESULTS("blazin_results", "Blazin’ 5 results", "When the last starred game of the week is final."),
    PICK_REMINDERS("pick_reminders", "Pick reminders", "Before kickoff, if you still have picks or Blazin’ 5 picks to make."),
    MESSAGES("messages", "General messages", "Messages sent to the whole group.");

    companion object {
        /** Anything unrecognised is treated as a message - an older or newer worker's kind. */
        fun of(id: String?): Category = entries.firstOrNull { it.id == id } ?: MESSAGES
    }
}

/** One notification as the worker sent it. */
data class Incoming(
    val category: Category,
    val title: String,
    val body: String,
    /** The same news without names or scores, for results; null when there is nothing to spoil. */
    val spoilerTitle: String? = null,
    val spoilerBody: String? = null,
    /**
     * Per-picker wording, for a notification meant only for some people (pick
     * reminders: only those with picks still to make). Null means everyone,
     * with [body]. A picker missing from it gets nothing.
     */
    val personal: Map<String, String>? = null,
    /** After this (epoch ms) it is stale and is dropped, e.g. a reminder held past kickoff. */
    val expiresAt: Long? = null,
)

/** This phone's notification settings. Times are minutes after midnight, local. */
data class DeliverySettings(
    val picker: String?,
    val enabled: Set<Category>,
    val spoilerFree: Boolean,
    val quietOn: Boolean,
    val quietStart: Int,
    val quietEnd: Int,
)

sealed interface Decision {
    data class Drop(val reason: String) : Decision
    /** Show [title]/[body] at [atMillis] - now, or when quiet hours end. */
    data class Show(val title: String, val body: String, val atMillis: Long, val held: Boolean) : Decision
}

object Delivery {

    /**
     * Whether, what and when to show a notification on this phone. Pure, so the
     * rules - categories, the picker it is meant for, spoilers, quiet hours,
     * staleness - are tested without a phone.
     */
    fun decide(msg: Incoming, settings: DeliverySettings, now: ZonedDateTime): Decision {
        if (msg.category !in settings.enabled) return Decision.Drop("${msg.category.id} is switched off")

        // A phone with no picker chosen cannot be given anyone's own line, so it
        // gets the group's (an older worker sent a reminder with none: dropped).
        val body = when {
            msg.personal == null -> msg.body
            settings.picker == null -> msg.body.ifBlank { return Decision.Drop("no picker, no group text") }
            else -> msg.personal[settings.picker] ?: return Decision.Drop("not meant for ${settings.picker}")
        }

        val spoilerFree = settings.spoilerFree && msg.spoilerBody != null
        val title = if (spoilerFree) msg.spoilerTitle ?: msg.title else msg.title
        val text = if (spoilerFree) msg.spoilerBody!! else body

        val nowMillis = now.toInstant().toEpochMilli()
        if (msg.expiresAt != null && msg.expiresAt <= nowMillis) return Decision.Drop("expired")

        val release = if (settings.quietOn) QuietHours.releaseTime(now, settings.quietStart, settings.quietEnd) else now
        val atMillis = release.toInstant().toEpochMilli()
        if (msg.expiresAt != null && msg.expiresAt <= atMillis) {
            return Decision.Drop("would be stale by the end of quiet hours")
        }
        return Decision.Show(title, text, atMillis, held = atMillis > nowMillis)
    }
}

/**
 * Quiet hours: a window, possibly across midnight, in which nothing is shown.
 * Times are minutes after midnight in the phone's own time zone.
 */
object QuietHours {

    fun isQuiet(minuteOfDay: Int, start: Int, end: Int): Boolean = when {
        start == end -> false                                  // an empty window
        start < end -> minuteOfDay in start until end          // 01:00-06:00
        else -> minuteOfDay >= start || minuteOfDay < end      // 23:00-08:00, across midnight
    }

    /** When something arriving at [now] may be shown: [now] itself, or the end of quiet hours. */
    fun releaseTime(now: ZonedDateTime, start: Int, end: Int): ZonedDateTime {
        val minute = now.hour * 60 + now.minute
        if (!isQuiet(minute, start, end)) return now
        var release = now.with(LocalTime.of(end / 60, end % 60))
        if (!release.isAfter(now)) release = release.plusDays(1)
        return release
    }

    /** "00:00", "09:30". */
    fun format(minuteOfDay: Int): String = "%02d:%02d".format(minuteOfDay / 60, minuteOfDay % 60)
}
