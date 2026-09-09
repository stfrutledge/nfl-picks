# NFL Picks Dashboard - Project Context

## Quick Links

- **Google Sheet (Picks Backup)**: https://docs.google.com/spreadsheets/d/1fq_L7OJJOk3EE7gHFq_MJgjDTwxgyQy_Ac_jRoJr21A/edit?gid=1468882431#gid=1468882431

## Google Apps Script

The deployed Apps Script URL for syncing picks to Google Sheets is configured in `app.js` as `APPS_SCRIPT_URL`. The script source code is in `google-apps-script-simple.js`.

**The repo copy is the source of record, not the running code.** Editing `google-apps-script-simple.js` changes nothing on its own — the script has to be pasted into the Apps Script editor (Extensions > Apps Script) and redeployed as a new version of the existing web app deployment, or the client keeps talking to the old one. `node test-sheet-reader.js` covers the read path locally so a change can be checked before it is deployed.

The Backup sheet is an **append-only log**: `savePicks()` only ever appends, so one game accumulates a row per sync and reading means collapsing rows back down. Two rows can collapse onto the same game *within one sync* — that is how the pre-2026 client stored a line pick and its Blazin' 5 star (different keys, one batch, one shared timestamp). Rows are therefore grouped into sync batches by timestamp: within a batch they merge as complementary halves, and a later batch supersedes an earlier one wholesale, so a blank in the newest batch is a real deselection rather than a gap.

That last rule only holds if a batch is **complete**, so `syncPicksToGoogleSheets` sends a snapshot of the whole week — one row per game in the schedule, blank where there is no pick — rather than only the games currently holding one. A game omitted from the newest batch has no newest row, so the reader falls back to an older one and a deselected pick returns from the dead. The week's schedule drives the payload, and a sync is skipped entirely when the schedule has not loaded: writing blanks for games the client cannot see would tombstone real picks. The cost is a row per game per sync instead of a row per pick; at 0.26% of the sheet's cell cap that is not worth optimising.

Endpoints beyond the originals:

- `GET ?action=allpicks&season=YYYY` — only that season's rows. The client passes `CURRENT_SEASON`. Without it the response grows by a whole season every year and the client discards the surplus.
- `GET ?action=diagnose` — read-only Backup sheet stats: total rows, cells used, rows per season, and any legacy split-key rows whose Blazin' flag was being dropped. `getDataRange()` pulls the whole tab on every read, so `totalRows` is the number that decides when to split the tab by season.

## Season rollover (automatic, every July 1st)

`CURRENT_SEASON` flips on July 1st (`calculateCurrentSeason()` in app.js) and everything current-season is scoped to it, so a new season starts from a clean slate without manual work:

- **localStorage** keys are season-scoped: `nflPicks_<season>`, `clearedPicks_<season>`, `nfl_saved_spreads_<season>`, schedule cache.
- **historical-data.js** is an in-season snapshot tagged with `HISTORICAL_DATA_SEASON`; app.js empties it in place if the tag doesn't match `CURRENT_SEASON`. Regenerate it during the season with `exportHistoricalData()` from the browser console (the export includes the tag).
- **Hardcoded data**: if you hardcode games into `NFL_GAMES_BY_WEEK` / `FALLBACK_SPREADS` mid-season, update `HARDCODED_DATA_SEASON` next to them — stale-tagged entries are cleared automatically.
- **Google Sheet backup** rows are never deleted and have no season column, so from 2026 on the client writes/reads season-prefixed week keys (`2026_5`). Plain numeric week rows are 2025-season data and are ignored.
- **Legacy stats workbook** (`GOOGLE_SHEETS_BASE_URL` + `WEEK_SHEET_GIDS`) is tagged with `LEGACY_SHEETS_SEASON` and isn't loaded when stale. It is not replaced each season — see "Standings" below. It stays only so past seasons up to `LEGACY_SHEETS_SEASON` can still be read.

## Standings

Standings, the trend chart, last-3-week form and best week are **computed from picks + results** by `calculateStatsForWeeks(firstWeek, lastWeek)`, not read from a spreadsheet. `renderDashboard` switches to the computed path whenever `LEGACY_SHEETS_SEASON !== CURRENT_SEASON`, which is every season after 2025.

Before this, they came out of a hand-maintained workbook: a person typed games, spreads and scores into `Week N` tabs (columns AM/AN/AP/AQ for teams and spreads, AO/AR for scores, first game on row 3) and formulas did the rest. The dropdowns in that sheet came from an Apps Script living on the workbook itself. That whole arrangement is retired — do not recreate it for a new season.

Two things the engine depends on:

- **Results.** The **Results sheet is the source of truth**, not ESPN. ESPN is an upstream we don't control — it can go down, rate-limit, or stop serving a past season — so a score is only really ours once it is written to the sheet. `backfillResults()` sweeps every week on start and persists any final result the sheet is missing; `syncResultsToGoogleSheets()` does the same for one week as live scores refresh. `getGameResult()` reads stored first, and falls back to the live cache and the game's own ESPN fields **only** to cover the gap between a game going final and the backfill persisting it. `saveResults()` upserts on week + matchup, so re-running the backfill is harmless and the sheet stays at one row per game. Never gate the sweep on `CURRENT_NFL_WEEK`: if that is wrong or lagging, a finished week is skipped and its scores are lost the moment ESPN drops them.
- **Schedules.** A week can only be scored if its games are loaded, and schedules are otherwise fetched lazily per week. `preloadSeasonSchedules()` loads the whole played season in the background on start, so standings are not limited to the weeks you happened to visit.

`calculatePlayoffStats()` is the same engine over weeks 19-22, flattened into the combined Line + Straight Up + Over/Under record the playoff table shows.

Still fed by the workbook, so still blank for a new season: the group-overall panel, lone wolf, universal agreement and favourites-vs-underdogs. Those need the same treatment (`parseNFLPicksCSV` is what they come from). `node test-standings-engine.js` covers the parts that are done.
- **ESPN schedule fetches** pin `dates=<CURRENT_SEASON>` — without it, ESPN serves the previous season during the offseason.

Offseason checklist (the only manual step): archive the finished season to `historical-<year>.js` **including playoff weeks 19-22** (historical-2025.js has them; 2016-2024 are regular-season only).

Run `node test-offseason-reset.js` to smoke-test the rollover behavior.
