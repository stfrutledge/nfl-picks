# NFL Picks Dashboard - Project Context

## Quick Links

- **Google Sheet (Picks Backup)**: https://docs.google.com/spreadsheets/d/1fq_L7OJJOk3EE7gHFq_MJgjDTwxgyQy_Ac_jRoJr21A/edit?gid=1468882431#gid=1468882431

## Google Apps Script

The deployed Apps Script URL for syncing picks to Google Sheets is configured in `app.js` as `APPS_SCRIPT_URL`. The script source code is in `google-apps-script-simple.js`.

## Season rollover (automatic, every July 1st)

`CURRENT_SEASON` flips on July 1st (`calculateCurrentSeason()` in app.js) and everything current-season is scoped to it, so a new season starts from a clean slate without manual work:

- **localStorage** keys are season-scoped: `nflPicks_<season>`, `clearedPicks_<season>`, `nfl_saved_spreads_<season>`, schedule cache.
- **historical-data.js** is an in-season snapshot tagged with `HISTORICAL_DATA_SEASON`; app.js empties it in place if the tag doesn't match `CURRENT_SEASON`. Regenerate it during the season with `exportHistoricalData()` from the browser console (the export includes the tag).
- **Hardcoded data**: if you hardcode games into `NFL_GAMES_BY_WEEK` / `FALLBACK_SPREADS` mid-season, update `HARDCODED_DATA_SEASON` next to them — stale-tagged entries are cleared automatically.
- **Google Sheet backup** rows are never deleted and have no season column, so from 2026 on the client writes/reads season-prefixed week keys (`2026_5`). Plain numeric week rows are 2025-season data and are ignored.
- **Legacy stats workbook** (`GOOGLE_SHEETS_BASE_URL` + `WEEK_SHEET_GIDS`, feeds the dashboard/standings charts) is tagged with `LEGACY_SHEETS_SEASON`; it isn't loaded when stale. When a new season's workbook exists, update the URL, the week GIDs, and the tag together.
- **ESPN schedule fetches** pin `dates=<CURRENT_SEASON>` — without it, ESPN serves the previous season during the offseason.

Offseason checklist (the only manual step): archive the finished season to `historical-<year>.js` **including playoff weeks 19-22** (historical-2025.js has them; 2016-2024 are regular-season only).

Run `node test-offseason-reset.js` to smoke-test the rollover behavior.
