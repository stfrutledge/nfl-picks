# NFL Picks Dashboard - Project Context

## Quick Links

- **Google Sheet (Picks Backup)**: https://docs.google.com/spreadsheets/d/1fq_L7OJJOk3EE7gHFq_MJgjDTwxgyQy_Ac_jRoJr21A/edit?gid=1468882431#gid=1468882431

## Cache busting (do this once per clone)

`index.html` references its local assets with a content hash — `app.js?v=78bb7458` — so a deploy changes the URL and browsers fetch the new file instead of running a cached copy. Without it, GitHub Pages serves `app.js` under one unchanging URL and every fix needs a manual hard refresh to reach anyone.

`scripts/stamp-assets.js` rewrites those stamps from the files' own SHA-256, so re-running it changes nothing unless an asset actually changed. A pre-commit hook keeps them in step, and **git hooks are not version controlled, so a fresh clone has to install it**:

```sh
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Without the hook nothing breaks — the site keeps serving the last stamped versions — but a changed asset can ship behind an unchanged URL, which is the exact problem this removes. `node scripts/stamp-assets.js --check` exits non-zero when a stamp is stale, so it also works as a verification step.

Not stamped: the lazily loaded `historical-<year>.js` archives, which app.js injects at runtime where no hash is available. They are effectively immutable once a season is archived. If one is ever regenerated mid-season, expect cached copies to lag.

## Google Apps Script

The deployed Apps Script URL for syncing picks to Google Sheets is configured in `app.js` as `APPS_SCRIPT_URL`. The script source code is in `google-apps-script-simple.js`.

**The repo copy is the source of record, not the running code.** Editing `google-apps-script-simple.js` changes nothing on its own — the script has to be pasted into the Apps Script editor (Extensions > Apps Script) and redeployed as a new version of the existing web app deployment, or the client keeps talking to the old one. `node test-sheet-reader.js` covers the read path locally so a change can be checked before it is deployed.

The Backup sheet is an **append-only log** and should stay that way: `savePicks()` only ever appends, so one game accumulates a row per sync and reading means collapsing rows back down.

**Do not "optimise" this into an upsert.** It was tried, in response to the sheet filling with a row per game per edit, and reverted once the cost was actually measured:

```
no sheet read at all      1.9  1.9  2.0     <- ~2s fixed floor
spreads     (32 rows)     2.5  2.7  5.3  5.6  8.2
diagnose  (2,172 rows)    2.5  3.5  3.8  5.4  32.4
```

The 32-row read is often *slower* than the 2,172-row read: Google-side variance swamps anything row count contributes. Row count is not the bottleneck at any size this sheet will reach for years. What the history buys is worth more — recovery from a bad client write, visibility of two devices fighting over one week, and forensics on pick-storage bugs (it is how three failed Blazin' attempts were traced in September 2026).

Growth is controlled on the **client** instead: `syncPicksToGoogleSheets` skips a payload byte-identical to the last one it sent (`lastSyncedSignature`, recorded only after the write lands so a failure retries), and `SYNC_DEBOUNCE_MS` is 5s so clicking through a slate is one write rather than one per pick. Together those cut writes roughly tenfold. Because a longer debounce leaves more outstanding, `flushPendingSync()` runs on `visibilitychange` — unsynced picks would otherwise be overwritten by the backup on the next load. `visibilitychange`, not `beforeunload`, which cannot be trusted to finish a fetch. Two rows can collapse onto the same game *within one sync* — that is how the pre-2026 client stored a line pick and its Blazin' 5 star (different keys, one batch, one shared timestamp). Rows are therefore grouped into sync batches by timestamp: within a batch they merge as complementary halves, and a later batch supersedes an earlier one wholesale, so a blank in the newest batch is a real deselection rather than a gap.

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

## Frozen lines

A pick stores a **side** (`line: 'home'`), never a number, so by default it is graded against whatever the spread is at scoring time — take Seahawks -3 on Tuesday, and if the line moves to -6.5 by Sunday you are graded at -6.5. That is called **riding the line** and remains the default.

A player may instead **freeze** a game, which snapshots the current line onto the pick (`frozenSpread`, `frozenFavorite`, `frozenAt`) and makes that game final. `lineForPick(game, pick)` resolves which line applies, and `atsWinnerForPick()` is what current-season scoring calls — the standings engine, the game cards and the scoring summary all go through it.

**Naming: the UI says "lock", the code says "frozen".** Players see `Lock Pick`, `Locked at -3` and `Lock All Picks`, because that is the group's own word for it. Internally everything stays `frozen*` — `frozenAt`, `applyFreeze`, `freezeEligibility`, `.pick-frozen`, and the sheet's `Frozen At` column — which also keeps it distinct from `isGameLocked`, the unrelated "game has kicked off" state that owns `.locked-badge` and the "LOCKED" header badge. Don't rename the internals to match the labels; the two concepts are genuinely different and the code names are what keep them apart.

Rules, all enforced in `freezeEligibility()`:

- **Only a complete card can be frozen** — line + winner, matching `checkAllPicksComplete`, plus the over/under in the playoffs (the O/U picker only renders when `isPlayoff`; the Blazin' star occupies that slot otherwise).
- **A freeze may happen any time before kickoff.** This deliberately rewards watching the lines.
- **Freezing covers the whole card**, including the Blazin' star.
- **A freeze must never strand the Blazin' allocation.** Because the star freezes too, `blazinReachableAfterFreezing()` refuses a freeze that would make five stars unreachable, and `freezeAllCompleteGames()` is blocked until all five are placed. Freeze-all otherwise freezes every complete game and reports how many were left riding.
- **Never freeze without a usable spread** — that would store `undefined` and score as a push for ever (the bug fixed in `5a31244`).

Persistence: the Backup sheet's `Away Spread`/`Home Spread` columns record **the line the pick is graded against**, so a frozen row carries its own number, plus a `Frozen At` column. `foldPickRow` in the Apps Script gives a frozen row precedence over any later row that lacks the freeze — the whole-week snapshot sync means a second device or stale tab could otherwise thaw a pick by accident. This stops accidents and casual reversal; it is **not tamper-proof**.

`pickedSpread`/`pickedFavorite` are recorded on a riding pick for display only, so the card can show that the line has moved. They never affect scoring.

Run `node test-line-freezing.js`.

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
