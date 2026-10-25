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
    TimeZoneOption("America/Chicago", "Central (CT)"),
    TimeZoneOption("America/Denver", "Mountain (MT)"),
    TimeZoneOption("America/Phoenix", "Arizona (AZ)"),
    TimeZoneOption("America/Los_Angeles", "Pacific (PT)"),
    TimeZoneOption("America/Anchorage", "Alaska (AK)"),
    TimeZoneOption("Pacific/Honolulu", "Hawaii (HI)"),
    TimeZoneOption("Europe/London", "UK"),
    TimeZoneOption("Europe/Paris", "Central Europe (CET)")
)
