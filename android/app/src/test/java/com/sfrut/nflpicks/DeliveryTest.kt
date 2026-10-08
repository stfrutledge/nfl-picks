package com.sfrut.nflpicks

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The rules each phone applies to a notification: whether it is for this
 * person at all, what it says, and when - including holding it through quiet
 * hours in the phone's own time zone, which is the whole point for the group
 * in Ireland, where Sunday night results land at 4am.
 */
class DeliveryTest {

    private val dublin = ZoneId.of("Europe/Dublin")
    private val newYork = ZoneId.of("America/New_York")

    private fun at(zone: ZoneId, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0) =
        ZonedDateTime.of(y, mo, d, h, mi, 0, 0, zone)

    private val defaults = DeliverySettings(
        picker = "Sean",
        enabled = Category.entries.toSet(),
        spoilerFree = true,
        quietOn = true,
        quietStart = 0,        // midnight
        quietEnd = 9 * 60      // 9am
    )

    private val results = Incoming(
        category = Category.BLAZIN_RESULTS,
        title = "Week 5 Blazin’ 5",
        body = "Jason 5-0, Sean 4-1, Dylan 3-2",
        spoilerTitle = "Week 5 Blazin’ 5",
        spoilerBody = "Results are in."
    )

    // --- quiet hours ---------------------------------------------------------

    @Test fun `a window across midnight`() {
        assertTrue(QuietHours.isQuiet(23 * 60 + 30, 23 * 60, 8 * 60))
        assertTrue(QuietHours.isQuiet(7 * 60 + 59, 23 * 60, 8 * 60))
        assertFalse(QuietHours.isQuiet(8 * 60, 23 * 60, 8 * 60))
        assertFalse(QuietHours.isQuiet(22 * 60 + 59, 23 * 60, 8 * 60))
    }

    @Test fun `a window within one day, and an empty one`() {
        assertTrue(QuietHours.isQuiet(0, 0, 9 * 60))
        assertTrue(QuietHours.isQuiet(8 * 60 + 59, 0, 9 * 60))
        assertFalse(QuietHours.isQuiet(9 * 60, 0, 9 * 60))
        assertFalse(QuietHours.isQuiet(3 * 60, 9 * 60, 9 * 60))
    }

    @Test fun `Sunday night results at 4am in Dublin wait until 9am`() {
        val now = at(dublin, 2026, 10, 12, 4, 10)
        val d = Delivery.decide(results, defaults, now) as Decision.Show
        assertTrue(d.held)
        assertEquals(at(dublin, 2026, 10, 12, 9).toInstant().toEpochMilli(), d.atMillis)
    }

    @Test fun `the same message shows at once in New York, where it is 11pm`() {
        val now = at(dublin, 2026, 10, 12, 4, 10).withZoneSameInstant(newYork)
        assertEquals(23, now.hour)
        val d = Delivery.decide(results, defaults, now) as Decision.Show
        assertFalse(d.held)
    }

    @Test fun `just before midnight with a 23-00 start waits until the next morning`() {
        val settings = defaults.copy(quietStart = 23 * 60, quietEnd = 8 * 60)
        val now = at(dublin, 2026, 10, 11, 23, 30)
        val d = Delivery.decide(results, settings, now) as Decision.Show
        assertEquals(at(dublin, 2026, 10, 12, 8).toInstant().toEpochMilli(), d.atMillis)
    }

    @Test fun `the clocks going back overnight still releases at 9am local`() {
        // Ireland's clocks go back at 2am on Sunday 25 October 2026.
        val now = at(dublin, 2026, 10, 25, 1, 30)
        val d = Delivery.decide(results, defaults, now) as Decision.Show
        val release = ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(d.atMillis), dublin)
        assertEquals(9, release.hour)
        assertEquals(25, release.dayOfMonth)
    }

    @Test fun `quiet hours switched off shows straight away`() {
        val d = Delivery.decide(results, defaults.copy(quietOn = false), at(dublin, 2026, 10, 12, 4)) as Decision.Show
        assertFalse(d.held)
    }

    // --- categories, spoilers, who it is for ------------------------------

    @Test fun `a category switched off is dropped`() {
        val settings = defaults.copy(enabled = setOf(Category.MESSAGES))
        assertTrue(Delivery.decide(results, settings, at(dublin, 2026, 10, 12, 12)) is Decision.Drop)
    }

    @Test fun `results are spoiler-free unless the person has turned that off`() {
        val noon = at(dublin, 2026, 10, 12, 12)
        assertEquals("Results are in.", (Delivery.decide(results, defaults, noon) as Decision.Show).body)
        assertEquals("Jason 5-0, Sean 4-1, Dylan 3-2",
            (Delivery.decide(results, defaults.copy(spoilerFree = false), noon) as Decision.Show).body)
    }

    @Test fun `a message with nothing to spoil is shown whole even in spoiler-free mode`() {
        val msg = Incoming(Category.MESSAGES, "NFL Picks", "Get your picks in")
        assertEquals("Get your picks in", (Delivery.decide(msg, defaults, at(dublin, 2026, 10, 12, 12)) as Decision.Show).body)
    }

    @Test fun `a reminder goes only to the pickers it names, in their own words`() {
        val reminder = Incoming(
            Category.PICK_REMINDERS, "Kickoff in 3 hours", "",
            personal = mapOf("Sean" to "You still have 4 games to pick and 2 Blazin’ 5 picks to make.")
        )
        val noon = at(dublin, 2026, 10, 11, 15)
        assertEquals("You still have 4 games to pick and 2 Blazin’ 5 picks to make.",
            (Delivery.decide(reminder, defaults, noon) as Decision.Show).body)
        assertTrue(Delivery.decide(reminder, defaults.copy(picker = "Jason"), noon) is Decision.Drop)
        // No group text to fall back on, for a phone with no picker.
        assertTrue(Delivery.decide(reminder, defaults.copy(picker = null), noon) is Decision.Drop)
    }

    @Test fun `a phone with no picker chosen gets the group's text`() {
        val reminder = Incoming(
            Category.PICK_REMINDERS, "Kickoff in 3 hours", "Still to pick: Jason, Sean.",
            personal = mapOf("Sean" to "You still have 4 games to pick.")
        )
        val noon = at(dublin, 2026, 10, 11, 15)
        assertEquals("Still to pick: Jason, Sean.",
            (Delivery.decide(reminder, defaults.copy(picker = null), noon) as Decision.Show).body)
        assertTrue("a picker with nothing to do still gets nothing",
            Delivery.decide(reminder, defaults.copy(picker = "Stephen"), noon) is Decision.Drop)
    }

    @Test fun `a reminder that would only show after kickoff is dropped`() {
        // Thursday's reminder arrives at 00:30 in Dublin; kickoff is 01:15.
        val now = at(dublin, 2026, 10, 9, 0, 30)
        val kickoff = at(dublin, 2026, 10, 9, 1, 15).toInstant().toEpochMilli()
        val reminder = Incoming(Category.PICK_REMINDERS, "Kickoff soon", "Pick",
            personal = mapOf("Sean" to "You have 1 game to pick."), expiresAt = kickoff)
        assertTrue(Delivery.decide(reminder, defaults, now) is Decision.Drop)
        // Outside quiet hours it would have been shown.
        assertTrue(Delivery.decide(reminder, defaults.copy(quietOn = false), now) is Decision.Show)
    }

    @Test fun `an expired message is dropped`() {
        val now = at(dublin, 2026, 10, 12, 12)
        val msg = Incoming(Category.MESSAGES, "t", "b", expiresAt = now.minusMinutes(1).toInstant().toEpochMilli())
        assertTrue(Delivery.decide(msg, defaults, now) is Decision.Drop)
    }

    @Test fun `an unknown category from a newer worker counts as a message`() {
        assertEquals(Category.MESSAGES, Category.of("something_new"))
        assertEquals(Category.PICK_REMINDERS, Category.of("pick_reminders"))
    }

    @Test fun `times print as HH-MM`() {
        assertEquals("00:00", QuietHours.format(0))
        assertEquals("09:30", QuietHours.format(570))
    }
}
