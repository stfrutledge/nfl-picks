package com.sfrut.nflpicks

/** A time zone the site can draw kickoffs in: its IANA id and the name Settings shows. */
data class TimeZoneOption(val id: String, val name: String)

/**
 * Settings > Time zone, Eastern first as the default. The site has the same
 * ids with their short labels (TIME_ZONES in app.js), and ignores an id it
 * does not know, so keep the two lists in step.
 */
val TIME_ZONES = listOf(
    TimeZoneOption("America/New_York", "Eastern (ET)"),
    TimeZoneOption("Europe/Dublin", "Ireland")
)
