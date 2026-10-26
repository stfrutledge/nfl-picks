# NFL Picks Dashboard - Project Context

## Quick Links

- **Google Sheet (Picks Backup)**: https://docs.google.com/spreadsheets/d/1fq_L7OJJOk3EE7gHFq_MJgjDTwxgyQy_Ac_jRoJr21A/edit?gid=1468882431#gid=1468882431

## Tests

`node run-tests.js` runs every `test-*.js` file, each in its own process, and exits non-zero if any failed. `node run-tests.js live dates` runs only the files whose names contain those words.

**A test must not read the real clock.** app.js reads it as it loads - `CURRENT_SEASON`, `CURRENT_NFL_WEEK`, the Live window, `isGameLocked` - so a test that passed in the week it was written failed every week after (three files did, by October 2026). Pass `fixedClock(iso)` from `fixed-clock.js` into the `new Function` as `Date`, pinned to a moment that suits the test, as `test-live-tab.js`, `test-offseason-reset.js` and `test-line-freezing.js` do.

## Cache busting (do this once per clone)

`index.html` references its local assets with a content hash — `app.js?v=78bb7458` — so a deploy changes the URL and browsers fetch the new file instead of running a cached copy. Without it, GitHub Pages serves `app.js` under one unchanging URL and every fix needs a manual hard refresh to reach anyone.

`scripts/stamp-assets.js` rewrites those stamps from the files' own SHA-256, so re-running it changes nothing unless an asset actually changed. A pre-commit hook keeps them in step, and **git hooks are not version controlled, so a fresh clone has to install it**:

```sh
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Without the hook nothing breaks — the site keeps serving the last stamped versions — but a changed asset can ship behind an unchanged URL, which is the exact problem this removes. `node scripts/stamp-assets.js --check` exits non-zero when a stamp is stale, so it also works as a verification step.

Not stamped: the lazily loaded `historical-<year>.js` archives, which app.js injects at runtime where no hash is available. They are effectively immutable once a season is archived. If one is ever regenerated mid-season, expect cached copies to lag.

## Where the site's lines come from (read this first)

**Since October 2026 the worker writes the lines.** Its 15-minute cron reads DraftKings' spread and total off ESPN's scoreboard (`espnOdds`, this week and next by `nextWeekBoard`) and `syncSheetLines` writes every game still to kick off to the Spreads tab through the Apps Script's existing `saveSpreads` - when anything changed, and at least every `SHEET_LINES_REFRESH_MS` (2 hours) even when nothing did. Phones read the sheet: on load as before, and every 10 minutes while open (`refreshSheetLines`, on the splits timer). So the pick buttons, the popup's Line table and the movement charts are one number from one read, at most a run behind DraftKings, at no Odds API cost. A kicked-off game is never written.

**The Odds API path below is now the fallback, and it needed no new code.** A phone still asks the Odds API only when the Spreads tab's newest timestamp is stale (`spreadsNeedRefresh`: 3 hours on a game day, a day otherwise). The worker's 2-hour rewrite keeps it fresh, so while the worker is healthy no phone asks; if it stops - ESPN refusing the cron, a bad deploy - the timestamp ages and the phones take over exactly as they used to. Don't "tidy" the client path away. The Spreads tab and its reader are unchanged, and the two writers agree because both are DraftKings (the site's Odds API request prefers DraftKings, falling back to FanDuel per game).

Moneylines, which only an Odds API fetch used to set (in memory, never stored), now come off ESPN's DraftKings odds with the schedule (`espnMoneyline`, SCHEDULE_CACHE_VERSION 12). `applySavedSpreads` also takes a moved **total** for a game still to come; it used to fill only a blank one, which would have left an open page on its first total now that the sheet's total moves.

## Odds API budget (the fallback)

The Odds API free tier is **500 credits a month**, billed **per market per region** — so the worker's `spreads,h2h,totals` request costs **3 credits**, not 1. That is the single most misread thing here: 30 credits used is 10 calls, not 30.

The worker does not use a fixed cache window. `pacedCacheDuration()` in `cloudflare-worker/nfl-picks-proxy.js` spreads the remaining balance over the days left in the month, divides by the per-fetch cost, and sets the cache lifetime to the gap between affordable refreshes:

```
budget/day  = remaining / days left in month
fetches/day = budget/day / (markets x regions)
TTL         = 24h / fetches/day    clamped [2h, 24h], x2 on non-game days
```

It needs no storage: the decision is made at the one moment both the balance and the cost are known — when caching a fresh response — and `creditsPerFetch` is derived from the actual `markets`/`regions` strings so it stays right if those change. Flush early in the month it refreshes often; nearly out it stretches to the reset; on the 1st the balance jumps back and it speeds up on its own. If the `x-requests-remaining` header ever disappears it falls back to the old fixed 4h/12h windows.

On a cache hit, `X-Cache-Duration` is passed through as stored rather than recomputed — it records the window that entry was actually given.

**The worker's window is a ceiling, not the cadence.** What actually decides when lines move is the client gate in `prefetchAndSaveSpreads`, `spreadsNeedRefresh()`: a device asks the worker for odds only when the Spreads tab is stale, and everyone else that day reads the tab. Stale means *more than 3 hours old* (`GAME_DAY_REFRESH_MS`) on a day when a current-week game has still to kick off, and *not from today* otherwise. Game days are read off the week's kickoffs, not a weekday list. It was once-a-day flat until September 2026, which is why a Wednesday injury did not reach a screen until Thursday's first visitor. Expect roughly 15 fetches a week, ~200 credits a month.

**Only fresh lines go to the sheet.** `updateOddsFromAPI()` returns true only when the lines came from the worker on that call; every fallback (this device's cached odds, hardcoded spreads) applies what it can and returns false. `prefetchAndSaveSpreads` and the admin refresh button both sync spreads to the sheet only on true. Before this the sync ran unconditionally, so a device holding a week-old lookahead line and a dead worker would have written that line over everyone's.

Two things worth knowing:

- **`h2h` is fetched but never displayed.** `formatMoneyline()` exists and is called from nowhere. It is a third of the cost, kept deliberately because the moneylines are the input a straight-up winnings feature would need.
- **`totals` is only usable in the playoffs** — the O/U picker renders solely in the `isPlayoff` branch. Making markets conditional on the week would cut the regular season to one credit a fetch.

`node test-odds-pacing.js` covers the pacing. Avoid calling `/odds` by hand to test things: a cache miss spends real credits.

**The worker is public and unauthenticated, so the URL must not be able to buy a fetch.** Every odds request shares one cache key, `oddsCacheKey()`, built from the origin alone: the query string never reaches the key or the upstream request. There is no `?refresh=true` - it used to skip the cache, and together with a full-URL key it let anyone spend three credits per request with a made-up query string. Do not add a bypass back; the admin refresh button goes through the same cache like everything else. `/sheets` likewise checks the parsed host (`isGoogleSheetsUrl()`: https, `docs.google.com`, `/spreadsheets/`) - it was a substring test, which made it an open proxy. `node test-worker-guards.js` runs the whole worker against a fake cache and network and covers both.

## Google Apps Script

The Apps Script URL the client actually talks to lives in the **Cloudflare Worker**
env var `APPS_SCRIPT_URL` - `app.js` never fetches it directly, and its own
`APPS_SCRIPT_URL` is only the flag for "is the Backup sheet configured".
Redeploying to a new URL therefore means updating the worker, not just the repo;
keep the constant in `app.js` in step anyway, or the next person reads a URL that
has not been live for months. The script source code is in `google-apps-script-simple.js`.

**The repo copy is the source of record, not the running code.** Editing `google-apps-script-simple.js` changes nothing on its own — the script has to be pasted into the Apps Script editor (Extensions > Apps Script) and redeployed as a new version of the existing web app deployment, or the client keeps talking to the old one. `node test-sheet-reader.js` covers the read path locally so a change can be checked before it is deployed.

**An Apps Script failure comes back as HTTP 200.** `doGet` catches its own errors and answers `{ error }` with a 200, so the worker's `appsScriptGet` checks the body as well as the status and throws on either. Read as picks, an `{error}` body is nobody having picked anything: the cron would have reminded all five pickers of every game and marked the reminder sent. `node test-worker-automations.js` has the case.

The Backup sheet is an **append-only log** and should stay that way: `savePicks()` only ever appends, so one game accumulates a row per sync and reading means collapsing rows back down.

**Do not "optimise" this into an upsert.** It was tried, in response to the sheet filling with a row per game per edit, and reverted once the cost was actually measured:

```
no sheet read at all      1.9  1.9  2.0     <- ~2s fixed floor
spreads     (32 rows)     2.5  2.7  5.3  5.6  8.2
diagnose  (2,172 rows)    2.5  3.5  3.8  5.4  32.4
```

The 32-row read is often *slower* than the 2,172-row read: Google-side variance swamps anything row count contributes. Row count is not the bottleneck at any size this sheet will reach for years. What the history buys is worth more — recovery from a bad client write, visibility of two devices fighting over one week, and forensics on pick-storage bugs (it is how three failed Blazin' attempts were traced in September 2026).

Growth is controlled on the **client** instead: `syncPicksToGoogleSheets` skips a payload byte-identical to the last one it sent (`lastSyncedSignature`, recorded only after the write lands so a failure retries), and `SYNC_DEBOUNCE_MS` is 5s so clicking through a slate is one write rather than one per pick. Together those cut writes roughly tenfold. Because a longer debounce leaves more outstanding, `flushPendingSync()` runs on `visibilitychange` (with `keepalive`, so the write survives the tab closing) — unsynced picks would otherwise be overwritten by the backup on the next load. `visibilitychange`, not `beforeunload`, which cannot be trusted to finish a fetch.

**A page that closes straight after a pick still gets it to the sheet.** The October 2026 report: someone picks one game on a Thursday, closes the app, and nobody sees the pick until they next open it. Three things stood in the way, and each has its own fix:

- **Hidden before the backup is read.** A whole-week snapshot from a page that has not read the sheet is not safe (see below), so it was held. The Thursday pattern hits exactly that window: the read starts after first paint and takes 5-15s alongside the other background loads. Now `sendQueuedSlates` sends **only the changed games** (`syncPicksToGoogleSheets(..., { onlyGames })`, from `unsyncedGames`) as the page is hidden. That is safe because `getAllPicks` folds rows **per game key**: a row replaces only its own game's rows, so a write with no other game in it cannot blank one. It leaves `cleared` out (doPost writes it only when it is a boolean), returns `'partial'`, and the slate stays queued until the full snapshot lands after the read. A `'*'` change (Clear Picks, an import) has no games to name and is still held.
- **Hidden mid-write.** `flushPendingSync` used to set `syncAgain` and return, and a swiped-away app never ran the "again". With `keepalive` it now sends the queue straight away beside the write in flight, which left first and so lands first.
- **The page goes before the Apps Script answers.** Cloudflare cancels a request's work when its client disconnects, so the worker's `/sync` POST runs under `ctx.waitUntil` (`forwardSyncPost`). Picks are also sent as `text/plain`, a simple request, so there is no CORS preflight for a closing page's keepalive send to stall on.

`node test-lost-picks.js` and `node test-worker-automations.js` cover all three.

**Coming back to the page re-reads the backup.** `loadAllPicksFromBackup` runs once when the page opens, and a phone resumes a page rather than reloading it (switching apps, a home-screen shortcut, the back/forward cache), so until September 2026 a page opened on Thursday showed Thursday's picks all weekend and another picker's new pick only appeared after a forced reload. `refreshPicksIfStale()` runs on `visibilitychange` to visible and on a persisted `pageshow`, and re-runs the same loader when the last read is more than `PICKS_REFRESH_AFTER_MS` (5 min) old - so the unsynced-slate protection below applies unchanged. It does nothing before `initialLoadComplete` or while a read is in flight. It does not poll a page that stays on screen. `node test-lost-picks.js` covers it.

**The debounce sends the slate that changed, not the one on screen.** `savePicksToStorage()` records `week|picker` in `unsyncedPicks` at the moment of the change, and `flushPendingSync()` sends every entry. It used to read `currentPicker`/`currentWeek` when the timer fired, so switching picker or tapping next week inside the 5s sent the wrong (usually unchanged, so deduped) slate and the picks were never written — then the next load restored the sheet over them. Pass `week`/`picker` explicitly from any save that can run after the view has moved on (the Clear Picks undo does).

An entry stays until the sheet confirms the write: a failure retries on a 15s → 5min backoff (`SYNC_RETRY_MS`) and shows one warning per run of failures, and writes are serialised so two can't land out of order. Each entry carries a version, and a success only clears the version it sent, so a pick made while a write is in flight goes out behind it. The list is persisted (`nfl_unsynced_picks_<season>`), and **both backup loaders leave an unconfirmed slate alone** — its picks and its cleared flag — because until the write lands this device holds the newer copy; `loadAllPicksFromBackup` then sends whatever is still queued. `node test-lost-picks.js` covers all of it with a fake clock and network. Two rows can collapse onto the same game *within one sync* — that is how the pre-2026 client stored a line pick and its Blazin' 5 star (different keys, one batch, one shared timestamp). Rows are therefore grouped into sync batches by timestamp: within a batch they merge as complementary halves, and a later batch supersedes an earlier one wholesale, so a blank in the newest batch is a real deselection rather than a gap.

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

**One line per pick, everywhere.** `atsWinnerForPick(game, pick, result)` is the only way to score a pick, and `calculateATSWinner(game, result)` — which read the line off the *game* — has been deleted rather than left sitting there as the shorter, more obvious-looking thing to reach for. Sixteen sites used to call it: the standings and lifetime tables, every Blazin' records and history panel, both lone-wolf calculations, the P&L and bankroll figures, and the pattern engine. All of them graded a locked pick, and would have graded every Cowherd pick, at a number it was not playing — so those panels quietly disagreed with the standings and with the game card's own correct/incorrect colouring. Two of them were computing one result per *game* and sharing it across all five pickers, which cannot be right once two people can hold different numbers on the same game; they now compute per picker. A site with no usable line skips the game instead of scoring it, since the underlying arithmetic returns a silent `'push'` on a `NaN` comparison. `test-line-freezing.js` fails if the helper ever comes back.

**Every label that describes a pick reads the line from the side the picker took**, through `describeLineForSide(game, side)` — take the Buccaneers and the lock dialog, the button tooltip and the locked badge all say "Buccaneers +3.5". `describeLine()` names the favourite, which is the same line seen from the other side of the table: correct for a line in the abstract, and the wrong pick anywhere a person’s own choice is being quoted back to them.

**The styling stops at kickoff.** Every `.pick-frozen` rule is scoped
`:not(.game-locked)`, so once a game starts `.game-locked` and `.game-final`
own the card and a locked pick’s finished card looks like every other
finished card. Unscoped it overrode the grey locked background, dimmed the
picks a second time on top of the locked `0.75`, and its `border-color`
swallowed the blue FINAL stripe.

Run `node test-line-freezing.js`.

## A missing line is `null`, never `0`

`0` is a **pick'em** - a real line, and the only one where ATS and straight up
are the same bet. A game whose line has not loaded carries `null`. These were
the same value until September 2026 and it was the worst kind of bug: not a
crash, just a wrong number that changed between page loads.

Games parsed from the ESPN scoreboard have no odds attached, so
`fetchNFLSchedule` fills in a placeholder. That placeholder used to be
`spread: 0, favorite: 'home'`. `hasUsableLine(0)` is `true` - deliberately, so a
genuine pick'em scores - so a game that was merely *waiting* for its line was
scored anyway, **straight up**, instead of being skipped. Daniel's week 1
Blazin' 5 read 3-2 with the lines in and 4-1 without them, because Lions -7
winning by 1 is the only one of his five where the two disagree.

Two rules keep them apart:

- **`hasUsableLine(raw)` is the only test for "is there a line here?"** Not
  `!game.spread`, not `game.spread === 0`, not `spread > 0`. Fourteen sites used
  those and every one of them read a pick'em as missing data - which is the same
  bug pointing the other way: a real pick'em was never saved, never synced, and
  overwritten by the next number that came along.
- **Nothing writes a `0` it does not mean.** The ESPN placeholder is `null`,
  `syncPicksToGoogleSheets` writes a **blank** spread cell rather than `0` for a
  game with no line, and `exportHistoricalData` archives `null`. A fake `0`
  persisted anywhere is read back as a pick'em for ever.

On display the two are equally distinct: `signedSpreadDisplay(game, side)` gives
`PK` for a pick'em and `''` for no line, and is what both game-card renderers,
the share text and the picks summary read a number through.

`SCHEDULE_CACHE_VERSION` was bumped to 8 with this change - cached schedules
written before it hold `spread: 0` for every game, which the new rules would
read as a slate of pick'ems.

## Past weeks need their lines fetched too

`prefetchAndSaveSpreads()` covers `currentWeek` and `currentWeek + 1`, and
nothing else. Standings are computed over **every played week**, so every past
week needs a line source as well.

`loadWeekSchedule()` therefore calls `loadSpreadsFromGoogleSheets(week)` for any
week it loads, not just playoff weeks as it did originally. Without it the only
source for a past week's lines was `nfl_saved_spreads_<season>` in localStorage,
which is **per device** - so a phone that first opened the site in week 3 had no
week 1 lines at all and scored week 1 straight up, while a laptop that was there
at the time scored it correctly. Same data, two different records.

Callers that load the spreads themselves pass `skipSpreadsLoad`.

The other half of that bug was an ordering one. `preloadSeasonSchedules()` and
`prefetchAndSaveSpreads()` run concurrently in the background `Promise.all` on
start, and the first **replaces** the game objects that the second writes lines
onto - so whether a past week ended up with its lines depended on which promise
settled last, and the same device could disagree with itself between refreshes.
`applySavedSpreads()` runs once more after that `Promise.all`, so the final
render is the same whichever order they finished in.

`node test-standings-engine.js` covers both, including Daniel's real week 1 card.

## A saved line replaces a stale one until kickoff

Week 2, 2026: one screen showed Seahawks -10 all Sunday while everyone else
saw -3.5. Both were real DraftKings numbers - -10 was the lookahead line, and
it collapsed after Darnold was hurt in week 1. The device had captured next
week's line during week 1 (`prefetchAndSaveSpreads` covers `currentWeek + 1`)
into `nfl_saved_spreads_<season>`, which never expires, and three rules then
conspired to keep it:

- the sheet was only authoritative for current/past weeks, so for a *future*
  week the local copy won over the sheet's fresher number;
- a future week never triggers the Odds API on its own, so nothing refreshed it
  unless this device happened to be the first visitor of a day;
- on Sunday the critical path (`loadWeekSchedule(currentWeek, true, true)`)
  painted the local copy onto the fresh ESPN games before the sheet was read,
  and `applySavedSpreads()` only ever filled a *blank* - a game already holding
  a line kept it, however old.

Two rules now:

- **The sheet wins for every week**, future ones included
  (`loadSpreadsFromGoogleSheets`). It is rewritten by whichever device last
  hit the API and is where a manual correction lands, so it is never older
  than one device's copy.
- **`applySavedSpreads()` replaces a differing line on any game of the current
  week or later whose kickoff is known** (`lineFollowsSheet`), kicked off or
  not. A game with no kickoff is left alone rather than guessed at, and a past
  week keeps its lines. Completed games still take a saved line when they have
  none - that part is unchanged.

**Nothing writes a kicked-off game's line to the sheet**, which is what lets
the rule above follow the sheet after kickoff. Week 5, 2026: Bengals -7 moved
to -6.5 before the 1pm kickoff, and at 2:43pm a page that had been open since
before the move refreshed the 4pm lines and synced its whole saved bucket,
stale Bengals -7 included. Dylan and Jason were riding the line, so a 7-point
win became a push for them. `syncSpreadsToGoogleSheets` now sends only
`spreadsStillOpen()` (kickoff known and still ahead). The worker's `/sync`
also drops kicked-off games from any spreads POST, checked against ESPN's
scoreboard for that week (`withoutKickedOffLines`), because a page left open
keeps running the old script. A correction therefore has to go to the Apps
Script directly, not through the worker.

`applyOddsData()` remains the only thing that writes a *new* number into the
system; this only moves numbers the sheet already holds onto the games in
memory. `node test-standings-engine.js` has the -10 case.

## Cowherd's Blazin' 5

The group plays against Colin Cowherd's Blazin' 5, so his five picks are entered by hand each week and scored by the same engine as everyone else's. Entry is the admin-only panel on the Make Picks tab (`#cowherd-panel`, gated by `.admin-only`, so Stephen only).

His picks live in `allPicks` under the picker name `Cowherd`, exactly like a player's. That is deliberate and is what buys localStorage, the Backup sheet round trip and the History view for nothing — none of them know he is special, and the Apps Script has no picker whitelist, so **no redeploy was needed for any of this**. It does mean his picks inherit the reader's rules, including the one about frozen rows below.

Two things stop him being just a sixth picker:

- **He has a Blazin' 5 record and nothing else.** He makes no straight-up picks, and his five line picks *are* the Blazin' 5 — counting them in the Line standings would put five picks a week against everyone else's sixteen. `cowherdBelongsIn()` is the single gate: `COWHERD_CATEGORY` is `'blazin'`, and he is also left out until he has a scored pick, because an empty Cowherd row reads as a bug rather than as a scoreline. `calculateStatsForWeeks` takes a picker list so he can be scored in the same pass and filtered after.
- **He calls his own numbers, and they are not always the book's.** Each pick carries the line he gave, stored in the same `frozen*` fields a locked pick uses — so `lineForPick()` and `atsWinnerForPick()` grade him at his number with no new scoring code, and the sheet's spread columns already record the line a pick is graded against. `cowherdLineFields()` turns a side plus a number signed from that side ("Rams +7") into the (magnitude, favourite) pair everything else stores; `cowherdSignedSpread()` is the inverse, for putting his number back in the input.

`cowherdWeeklyResults(season)` is the one source for his history: a finished season reads its archived `COWHERD_<year>_RESULTS`, the season in progress is scored from the picks entered so far. It replaced two copies of an eight-way ternary over hardcoded season globals, so a newly archived year now works without editing them.

**His tombstones are stamped, and have to be.** `foldPickRow` gives a frozen row precedence over any later row that lacks the freeze, so a blank tombstone would lose to the very row it is meant to retire. For a player that never matters — a frozen pick is read-only, so a later blank really is a stale tab — but every Cowherd pick is stored frozen while staying editable, so without a stamp his picks could be added and never removed, and a corrected week would resurrect the pick it replaced on the next load. `syncPicksToGoogleSheets` therefore stamps `frozenAt` on every row of his snapshot, taken from his own picks rather than the clock so an unchanged payload stays byte-identical and `lastSyncedSignature` still dedupes it. This is a **client-side** fix on purpose: the deployed Apps Script needs no redeploy. `node test-cowherd-blazin.js` drives the real reader over the rows `savePicks()` would have appended.

**Entry never locks.** There is no `isGameLocked` check anywhere in his path, deliberately: his five are transcribed off the show, often after the games are played, so a back week has to be fillable and correctable. Do not add one.

Every panel scores him at his own line, like everyone else — see "One line per pick" below.

Run `node test-cowherd-blazin.js`.

## The Live tab

What the group watches on a Sunday: every game somebody starred this week, who is on which side of each, and where the Blazin' 5 season table would stand if the afternoon ended now. Games are ordered in progress first, then finished, then still to come.

**"As is" is not a second scoring path, and not a second table either.** It is `calculateStatsForWeeks` with `includeLive`, which adds one source of results: `liveProvisionalResult(game)` hands back the current score of a game *in progress*, shaped like a real result. A scheduled game and a finished one both return null — a finished game already has a real result through `getGameResult()`, and taking a provisional one for either is how an "as is" table starts disagreeing with the real one.

It is then drawn by `renderStandingsTable`, which takes `tableId`/`tbodyId`/`category`/`setTitle`/`columns`/`positionChange`, so the Live tab keeps the Standings tab's styling and sort while carrying its own narrower column set. `category` matters because the as-is table is always the Blazin' 5 one whatever the Standings tab happens to be showing.

**A row opens onto that picker’s week.** Clicking a name shows their Blazin’ 5 picks for the current week only - the table above is a season record, and the reason to open a row is to see what is behind today’s movement in it. Each pick shows the line it is graded against, so a locked or Cowherd pick shows its own number. A game in progress is scored as it stands and marked provisional, the same claim the table makes about the record.

The detail **reuses the Team Records expansion wholesale** - `team-details-row`, `game-detail-row` and its slots, the `outcome-*` colours - so the two read as one thing rather than two takes on it. Only `outcome-provisional` and `outcome-pending` are new, for the two states a settled season record cannot have.

Which rows are open lives in `asIsExpanded`, **outside the render**: the table is rebuilt on every score poll, so an open row would otherwise snap shut every thirty seconds while it was being read.

**Season to Date / This Week.** A toggle above the table (`liveScope`, `setLiveScope`, the same `.scope-toggle` as the Standings tab) switches it between the season to date and the current week alone, both with games in progress counted as they stand. This Week is the same engine over `currentWeek` only, and drops the Move column (`showMove: false`): Move is a place in the season table against last week's, which one week does not have. The scope is module state, so the 30s score refresh keeps it.

**The as-is column set is the record plus a Move.** Last 3-Wk, Best Week and Year Chg describe the shape of a season, which says nothing about where an afternoon is heading. Move is the position now — live games counted as they stand — against the table as it finished **last week**, from `asIsPositionChange()`. Equal records share a place (`rankStandings`), or five pickers level on 0-0 get five arbitrary places and the season's first result reads as a four-place climb. A dash covers both "level" and "nothing to compare against", which is every row in week 1.

`asIsPositionChange()` takes its week range as a parameter, defaulting to `regularSeasonWeekRange()`. That is the only reason a later week can be tested at all: `CURRENT_NFL_WEEK` comes off the clock, and week 1 is the one week where this column does nothing.

Live scores drive both this tab and the pick cards, so `stopLiveScoresRefresh()` runs only when neither is on screen, and the refresh loop goes through `refreshLiveViews()` rather than calling `renderGames()` directly. A stale score is the whole problem on this tab.

**The box carries the clock, the score and the situation.** `liveEntryFromEvent()` is the only place the ESPN scoreboard's layout is known, which is what makes it testable without a fetch. Two things it settles:

- **Possession arrives as a team id** and is resolved to `'home'`/`'away'` there, once — the ids mean nothing anywhere else in the app. It is drawn as a football under that team's name on the score row, never spelled out: the row already names both teams. The empty slot is still rendered for the other side so the two do not jump as the ball changes hands.
- **`isRedZone` is captured and deliberately not drawn.** It had a tinted row and a label, which was the loudest thing on the tab for the least reason. The field stays because it costs nothing and the feed gives it.
- **The status text is ESPN's own `shortDetail`** (`11:37 - 3rd`, `Halftime`, `Final`), which already reads correctly in every state and is better than anything built from clock and period. The exception is a game still to come, which keeps the app's own kickoff time: ESPN's short form for one is a US time string.

Down and distance are absent between drives and at the half, so the row showing them is dropped rather than left stale, and no football is drawn.

**The tab is only up while the week’s games are on**: from an hour before the first kickoff to an hour after the last game should have finished. Nothing records when a game actually ended, so the far edge is the last kickoff plus `LIVE_WINDOW_GAME_MS`; a game still being played keeps the tab up whatever the clock says, which is the case that allowance would get wrong. An unreadable schedule counts as open - hiding the tab during a slate is a worse way to be wrong than showing it on a Wednesday, and the schedule usually lands a moment later and settles it. Anyone standing on the tab when it goes is moved to Make Picks.

In practice that is Thursday evening to Tuesday morning: the tab is down for about two days a week.

**The scores are fetched every 30s while a game is being played**, and every 2 minutes otherwise. Two rates because `shouldPollLiveScores()` stays true on nothing but scheduled games, which is most of the week — `anyGameInProgress()` is the narrower test that picks the faster one. It is a timeout that reschedules itself rather than a fixed interval, so the rate can change between fetches and a slow fetch cannot overlap the one behind it.

**One poll at a time.** `startLiveScoresRefresh` and `stopLiveScoresRefresh` both move `liveScoresPollRun` on, and `pollLiveScores(run)` queues its next fetch only while its run is still the current one. A tab change lands mid-fetch more often than not, and before October 2026 it stopped nothing (no timer was set yet) and started a second chain beside the first, so two loops polled ESPN and redrew every tab, and leaving the tab stopped only one of them. **A failed fetch keeps polling:** an empty cache reads as "nothing to watch" only when the last fetch worked (`liveScoresLastFetchOk`); a page whose first fetch failed used to stop there with its scores frozen. `node test-live-tab.js` drives both with fake timers.

**`getLiveGameStatus()` reads the cache before the game's own fields.** A game carries ESPN's status and score from whenever its schedule was fetched, and that snapshot used to win — so every score froze the moment its game kicked off and only moved again on a reload, while the 2-minute poll updated a cache nothing read. The snapshot is the fallback now, which is what covers a week the scoreboard is not carrying.

`liveCacheEntry()` matches on the **ESPN event id** where the game has one, and a game whose id the scoreboard is not carrying gets nothing rather than falling through to team names. Names alone cannot tell two meetings of the same pair apart, and the scoreboard only ever carries the current week, so a division rematch would otherwise put a live score on the earlier fixture. They come through `liveCacheEntry()` rather than `getLiveGameStatus()`, which prefers the status embedded in the schedule — a snapshot from whenever it was fetched, carrying no situation at all.

**A line is printed beside a name only where it differs from the one on the row** (`pickLineDiffers`). "Locked" is the wrong test and was the first one used: a locked pick usually locked at the number that is still up, and most of Cowherd's match the book, so nearly every chip repeated the number already printed above it. On the real week 1 that was 29 chips carrying a line where 2 of them said anything.

**Anything that finishes loading data calls `renderActiveTab()`** rather than naming tabs itself. The backup load lands long after the first paint, and each of those points used to list the tabs it knew about — so the Live tab was simply missed, drew once on the way in, and kept what it had. A pick that came back from the sheet a moment later never appeared on it, which looked exactly like the pick having failed to save.

Run `node test-live-tab.js`.

## History

The standings table on the History tab has two scopes, switched by the toggle beside the season dropdown: the season (labelled **Season to Date** while it is being played and **Full Season** once it is archived) or **Individual Weeks**, which adds a week dropdown and shows one week's records alone. Both come from `historyStandingsStats(season, week)` - the season table is the sum of the week tables, so they cannot disagree. The week list is `historyStandingsWeeks()`: only weeks with at least one result, since a week still to be played is a row of dashes.

The scope and week are module state (`historyStandingsScope`, `historyStandingsWeek`), not read back off the controls. `refreshLiveHistoryView` rebuilds the History tab through `loadHistorySeason` while a live season is being watched, and reading the controls would have dropped the reader back to the season table on every refresh. Lifetime hides the toggle: there are no weeks to choose between. Cowherd's row comes from `cowherdWeeklyResults`; the 2022 and earlier archives hold his as a season aggregate with no weeks in it, so there he is on the season table and absent from every week's.

`node test-history-weeks.js` covers it.

The Standings tab has the same toggle over its own table (`standingsScope`, `standingsWeek`, `setStandingsScope`), rendered through `renderDashboard` with the `week` column set of `renderStandingsTable` - the record alone, since Last 3-Wk, Best Week and Year Chg describe a season. Only the table is scoped: the leaderboard cards, charts and records around it stay on the season. The toggle is hidden on the Playoffs sub-tab, whose table is the combined playoff record. `node test-standings-weeks.js` covers it.

## Standings

Standings, the trend chart, last-3-week form and best week are **computed from picks + results** by `calculateStatsForWeeks(firstWeek, lastWeek)`, not read from a spreadsheet. `renderDashboard` switches to the computed path whenever `LEGACY_SHEETS_SEASON !== CURRENT_SEASON`, which is every season after 2025.

Before this, they came out of a hand-maintained workbook: a person typed games, spreads and scores into `Week N` tabs (columns AM/AN/AP/AQ for teams and spreads, AO/AR for scores, first game on row 3) and formulas did the rest. The dropdowns in that sheet came from an Apps Script living on the workbook itself. That whole arrangement is retired — do not recreate it for a new season.

Two things the engine depends on:

- **Results.** The **Results sheet is the source of truth**, not ESPN. ESPN is an upstream we don't control — it can go down, rate-limit, or stop serving a past season — so a score is only really ours once it is written to the sheet. `backfillResults()` sweeps every week on start and persists any final result the sheet is missing; `syncResultsToGoogleSheets()` does the same for one week as live scores refresh. `getGameResult()` reads stored first, and falls back to the live cache and the game's own ESPN fields **only** to cover the gap between a game going final and the backfill persisting it. `saveResults()` upserts on week + matchup, so re-running the backfill is harmless and the sheet stays at one row per game. Never gate the sweep on `CURRENT_NFL_WEEK`: if that is wrong or lagging, a finished week is skipped and its scores are lost the moment ESPN drops them.
- **Schedules.** A week can only be scored if its games are loaded, and schedules are otherwise fetched lazily per week. `preloadSeasonSchedules()` loads the whole played season in the background on start, so standings are not limited to the weeks you happened to visit.


### 5-0 Blazin' 5 Weeks

The Insights panel's third card (`#perfect-weeks-card`), on the Blazin' 5 sub-tab only: each picker's 5-0 Blazin' 5 weeks across every season, counted, with the most recent one named. `perfectBlazinWeeks(season)` reads a season's off `calculateStatsForWeeks`' per-week breakdown (with the `season` option, so an archive is scored exactly as the live season is); `perfectBlazinWeeksAllTime()` folds the seasons together. Strictly 5-0-0 - a push is not a win, so 4-0-1 does not count.

**It is the one thing that loads every archive.** The archives are otherwise loaded on demand for the History tab, and the prior season for Year Chg. `ensureArchivesLoaded()` loads the rest quietly, once, the first time the card is drawn; the card draws from whatever is in straight away and again when they land, so the current season is not held behind a megabyte of history. Cowherd's picks are not archived, only his weekly record, so his come from `cowherdWeeklyResults()` for every season alike; the 2022 and earlier aggregates can say nothing about his weeks. `node test-perfect-weeks.js` covers it.

**0-5 Blazin' 5 Weeks** (`#winless-weeks-card`) is the same card the other way round, beside it: strictly 0-5-0, so 0-4-1 does not count. Both cards are `renderBlazinWeeksCard(config)` over `blazinWeeksMatching(test, season)`, with their own expanded rows and sort; the only styling difference is a red leader (`.winless-weeks`).

### Year Chg

**This season's win percentage minus last season's over the same weeks.**
Shown as `▲9.2%` / `▼16.7%`, or `even`.

It is the same engine run twice: `calculateStatsForWeeks` takes a `season`
option, so last season is scored exactly the way this one is - same
`atsWinnerForPick`, same frozen-line handling, same everything. It is not a
second scoring path and must not become one. `priorSeasonStats(first, last)`
is the wrapper; `standingsFromComputed(computed, category, prior)` fills the
cell, comparing each category against its own counterpart.

Until September 2026 the column was **blank all season**, for every picker.
It came from the retired stats workbook (`parser.js` reads it from CSV column
10), and when standings moved to the computed engine `last3WeekPct` and
`bestWeek` were reimplemented while this one was left hardcoded to `''`. The
header, the CSS and the arrow formatting were all still in place, so it looked
implemented and rendered a dash.

Three things worth keeping:

- **Blank is not zero.** No prior season loaded, or either side holding no
  decided picks, gives `''` - and the card view drops the row entirely on a
  falsy value. A `0.0%` would claim the picker held level when the truth is
  that nobody knows. `even` is only for a genuine measured tie.
- **`getSeasonData()` is synchronous**, so the archive has to be in before the
  standings render or the column silently stays blank.
  `loadPriorSeasonForComparison()` runs in the background `Promise.all` on
  start for exactly that reason.
- **A missing archive is the expected state for part of the year.**
  `CURRENT_SEASON` rolls over on July 1st and the season just finished is not
  archived until somebody does it by hand, so `loadSeasonData(season, { quiet:
  true })` skips the toast and the loading overlay for this probe. Without that
  every page load between July and the archive landing would show an error
  nobody can act on.

**Both sides are the same WEEK RANGE, not the same amount of football.** The
range is `regularSeasonWeekRange()` - weeks 1 to `CURRENT_NFL_WEEK` - applied to
each season. It is a strict season-to-date reading and is deliberately left that
way; the alternative, intersecting the weeks each picker actually played,
answers a subtly different question. Two consequences to expect rather than
treat as bugs:

- **Mid-week it sets a half-played week against a finished one**, and settles
  when the week does.
- **A picker whose week is not in yet is compared short.** Their side covers the
  weeks they have, the prior season covers the whole range. Cowherd hits this
  routinely: his five are transcribed off the show by hand, often days late, so
  he sits a week behind for part of most weeks. In week 2 of 2026 that showed
  him as `▼30.0%` - his 2026 week 1 (1-4, 20%) against his 2025 weeks 1-2 (5-5,
  50%) - when week 1 against week 1 alone would have been `▼40.0%`. Neither is
  wrong; they answer different questions. It corrects itself when his picks go
  in.

The **Live tab's as-is table does not carry this column**, and calls
`standingsFromComputed` without a prior season. See "The as-is column set".



**Cowherd is filled in separately.** Every other picker's prior season is
re-scored from the archive's stored picks; his are not in there. The offseason
archive keeps his week-by-week record in `COWHERD_<year>_RESULTS` instead,
because his picks are cleared with everyone else's and the record is the part
that cannot be re-derived - see the offseason checklist.

`applyCowherdPriorRecord()` sums the weeks in range out of
`cowherdWeeklyResults(season)`, which stays the single source for his history.
Without it he scored 0-0 for last season and `yearChangeFor()` read that as "no
comparison", so his was the one row with a permanently blank Year Chg while the
data sat in the same archive file. An archive with no Cowherd block still leaves
him blank, which is the honest answer rather than a fabricated 0%.

### Last 3-Wk

**The picker's record over their last three weeks, pooled, and a dash until
there are three.** `LAST_3_WEEK_WINDOW` is both the window and the minimum.

Pooled, not averaged: the three weeks' wins and losses are summed and put
through `recordPercentage()`, the same arithmetic as the % column. Until
September 2026 it was the mean of the three weekly percentages, which gave a
half-played week the weight of a full slate - on a Friday in week 3 the Thursday
game alone set each picker's week to 100% or 0%, and the column sat well off
the season % when the two covered exactly the same picks. In week 3 they now
agree, as they should; from week 4 they diverge because the window has.

It used to average whatever it had. With one week played, the mean of one
week's percentage *is* the season percentage - so in week 1 the column sat
directly beside `%` showing the identical number, reading as a second
independent measurement of form when it was the same measurement twice. Weeks 1
to 3 now show `-`, and week 4 is the first real reading.

Three of the **picker's own scored weeks**, not three weeks of calendar:
`byWeek` only holds weeks they played, so somebody who has turned up twice by
week 3 has no three-week form either. (It follows that a picker with gaps
averages their last three *played* weeks rather than the last three weeks of
the season - the label is approximate for them, and it has always worked that
way.)

**A dash is a dash.** Both card renderers and the table cell go through
`formatPercent()` and `statValueClass()`. Inline, the card view appended a
literal `%` outside the expression - so a null rendered `-%` - and coloured it
with `parseFloat(picker.last3WeekPct) >= 50`, which is `false` for a null and
painted every absent percentage red. That is the same mistake `pctCellClass()`
was written to avoid; see "no percentage at all is neutral".

`calculatePlayoffStats()` is the same engine over weeks 19-22, flattened into the combined Line + Straight Up + Over/Under record the playoff table shows.

The group-overall panel, lone wolf, universal agreement and favourites-vs-underdogs used to be read from the workbook. All four are computed now (commits `0827347`, `84eb5f4`, `414747e`). `node test-standings-engine.js` covers the engine.

### One loop for every panel

**`gradedPicks(first, last, { pickers, season, includeLive, liveOnly })` is the only loop that grades picks.** It yields one row per (game, picker) for every game with a result: the pick, the result, `line` (from `lineForPick`, the line the pick is graded at) and `lineOutcome` / `straightUp` / `ou` as `'wins'`/`'losses'`/`'pushes'` or null. `calculateStatsForWeeks` is a fold over those rows, and so is every records panel: team records, worst week, the Blazin' 5 team and By Spread tables on Standings and History, the history fav/dog, home/away and picked/faded splits, and all three lone wolf cards.

Until October 2026 each of those panels was its own copy of the loop, about a dozen of them, and each had drifted from the engine:

- **Weeks.** They ran to `CURRENT_NFL_WEEK`, which goes past the regular season in January, so playoff picks leaked into regular-season tables. Panels now use `regularSeasonWeekRangeFor(season)`.
- **Results.** They read the Results sheet only, so a game that had just finished counted in the standings (through `getGameResult`'s fallback) and nowhere else until the backfill landed.
- **Picks.** They merged `weeklyPicksCache` into whatever season was on screen, including an archived one, where its keys land on the wrong games. Two of the lone wolf cards read the live season's globals whatever season was showing.
- **The line.** By Spread bucketed a pick by the *board* line, so a pick locked at -3 that won by 4 landed in the -6.5 row as a win. History fav/dog took the board favourite and filed pick'ems under one side. Detail rows printed `${fav} -${game.spread}`, which reads "-0" for a pick'em and "-null" with no line.

So: **a new panel that scores picks reads `gradedPicks` rows; it does not loop over weeks itself.** `gradedLinePicks(pickers, season, { blazinOnly })` is the regular-season, graded-line-picks cut most panels want, `bucketRecords(rows, keysFor)` totals rows into `{wins, losses, pushes, games}` by any key, and `pickDetail(row)` is the expanded-row shape, with `line` from `describeLineForSide(game, side, pick)`. The tables render through `recordsTableData` → `recordsRowsHtml`, where a row with no decided picks gets a null percentage and a neutral dash rather than a red 0%.

`node test-records-panels.js` covers each of the drifts above.

### Ranking records: sample size counts

**Anything that puts records in order by how good they are uses `rankingScore(record)`, not the win percentage.** It is the record padded with `RANKING_PADDING` (2) imaginary wins and as many losses, so a short record is pulled towards 50% and a long one barely moves: 5-0 ranks above 3-0-2, 10-3 above 2-0, 2-0 above 1-0. It only decides the order. Every cell still prints the real record and `recordPercentage()`.

It drives the records tables' Win % sort (`sortTeamRecordsData`), Patterns' best and worst (`patternExtremes`), and the Patterns "most notable" ordering. Plain win % let a single 1-0 top a list, and the old tie-break on `total` counted pushes, so 3-0-2 and 5-0 tied as "100% over 5" (reported October 2026). An all-push record scores exactly 50, so Patterns never calls it a best or a worst.

The standings, Lone Wolf and the leaderboard still rank by win %. Those compare pickers over similar numbers of picks, where the plain percentage is the number people expect to see in first place. `RANKING_PADDING` is the dial: larger favours big samples more strongly. `node test-records-panels.js` and `node test-pattern-cache.js` cover it.
- **ESPN schedule fetches** pin `dates=<CURRENT_SEASON>` — without it, ESPN serves the previous season during the offseason.

Offseason checklist (the only manual step): archive the finished season to `historical-<year>.js` **including playoff weeks 19-22** (historical-2025.js has them; 2016-2024 are regular-season only), and paste in the Cowherd block that `exportCowherdResults()` prints from the browser console. His week-by-week record is the one piece that cannot be re-derived once the season's picks are cleared.

Run `node test-offseason-reset.js` to smoke-test the rollover behavior.

## Android app

`android/` is a native shell around the live site: the site runs in a WebView loaded from GitHub Pages, so a site change reaches the app with no new APK. The app adds a picker owned by the phone (written into `selectedPicker` before the site's script runs), push notifications (one FCM topic, `group`; the admin sends from the app's Settings through the worker's `/notify`), and a working clipboard. The page sees it as `window.NFLPicksApp`; the header gear (`setupAppSettingsButton`) is the only site code that knows the app exists, and it does nothing in a browser. Setup, the build and the secrets are in `android/README.md`. `node test-worker-notify.js` covers `/notify`.

**The worker's ESPN requests look like a browser's, and fall back to a second host.** On 15 October 2026 ESPN answered every cron run `403`, so the Thursday reminder never went out, while `/espn` and `/reminder-check` (the same fetch, from a visitor's request) kept working: Cloudflare runs a cron in whichever data centre has room, not the one nearest a visitor. `fetchEspn()` is the one place the worker fetches the scoreboard: it sends browser `User-Agent`/`Accept` headers and tries `site.web.api.espn.com` when `site.api.espn.com` refuses. Two more layers behind that, both in KV (`nfl-picks-notify`):

- **A saved schedule** (`board:current`). A run that reaches ESPN saves the week's games and kickoffs (when they change, or daily); a run ESPN refuses carries on with them (`scoreboardForAutomations`). Reminders only need kickoffs, so they still go on time. A saved game counts as under way once its kickoff has passed and is never final, so Blazin' 5 results wait for ESPN rather than being graded without scores.
- **An alert after an hour of failing runs** (`trackHealth`, state in `automations:failing`). It goes to the admin alone: the message has a line for `ADMIN_PICKER` (Stephen) and an empty group text, so every other phone drops it (`Delivery.decide`), and no FCM token has to be stored. Running on the saved schedule counts as failing too. The first clean run after an alert sends "Notifications working again".

When notifications stop, look at the worker's **Observability** tab in Cloudflare first: a failing run logs `[automations] failed: <reason>`, and a reminder that went out leaves a `sent:<id>` key in the `nfl-picks-notify` KV namespace.

## Game Details popup

Each pick card's header reads "8:15 PM ET, Thur." on the left (`cardKickoffLabel`; Sun., Mon., Tues., Wed., Thur., Fri., Sat.), its live/FINAL badge in the middle, and a **Game Details** button on the right where the day used to be. The button opens a popup (`#game-details-modal`, the confirm dialog's overlay and card; `openGameDetails` from one delegated listener on `#games-list`) with everything the site knows about the game, drawn by `gameDetailsHtml`: kickoff date and time, stadium and city; for each team (away left, home right, as the buttons) its line and its **record** (overall, plus road for the away team and home for the home team: "6-0 · 2-0 road", `detailsRecord`; taken out once and put back by the owner), the **betting splits** (before kickoff only: after it they are live betting); a **Line** table of the spread and total under "Opened" and "Now" (opening is ESPN's DraftKings number, now is the card's own line; the spread read from the side it favours now); then the score once it has started, the **TV channel** and the **weather** (the town's forecast, under a roof too). A row with no data is left out. The popup closes on its ×, a tap outside, Escape, or **Back** (a phone's back button or swipe, and the Android app's Back, which calls the WebView's `goBack()`): it holds one history entry while open (`gameDetailsHistory`), a `popstate` closes it, and closing it any other way takes the entry back off so the next Back acts as before. Without it, Back left the page or closed the app. and `refreshGameDetails()` at the end of every `renderGames()` redraws it while open, so it never shows numbers the cards do not.

**It is dressed like the rest of the site, and should stay that way.** A plain black hero like the page header (ESPN's stadium photos behind it were tried in October 2026 and dropped as underwhelming) (navy underline, the green kicker for the kickoff, both teams with large logos and heavy uppercase names, their lines - the score once started - and records (no moneylines: the owner took them out), then the stadium; a round × like the dark-mode toggle), then sections under heavy uppercase titles: the betting splits as one bar per measure in the two teams' colours, each side as wide as its share; the line in the standings tables' style with a moved number in bold; TV and weather as green-edged pills. Two teams whose colours are too close to tell apart (Patriots and Bears both navy, 49ers and Falcons both red) put the home side in a neutral slate, `SPLIT_BAR_NEUTRAL`; lightening it instead turned the Falcons pink. The first version was a plain grid in a generic dialog, which the owner called "quite sad visually" next to the rest of the site.

**TV is shown as the networks' logos**, every network ESPN lists (`networks`; Monday nights are often ESPN and ABC), from SVGs kept in `tv-logos/` (the official marks, from Wikipedia) on a white badge so dark marks read in dark mode. `TV_LOGOS` maps ESPN's names to files ("NFL Net" is ESPN's name for NFL Network); a network not in it is written out.

**Weather:** ESPN's forecast, drawn as an icon and the temperature, not ESPN's words (the owner's choice; `weatherKind` maps AccuWeather's and WMO's phrases to sun, partly, cloud, rain, storm, snow, fog or wind, the worst weather named winning; the words stay as the icon's tooltip, and a phrase no icon fits is written out). A dome gets the town's forecast like any stadium, not marked indoors (the owner's call: there is no icon for indoors). ESPN gives no weather for a stadium abroad (London, Paris, ...), so for those `loadVenueForecast` asks **Open-Meteo** when the popup opens: free, no key, answers a browser directly, 16 days ahead. The town is matched by name **and country** (`country` from ESPN's venue): a search for "Saint-Denis" returns Réunion's first. Results live in `venueForecasts`, outside the game objects, which a schedule refresh replaces. A game abroad also names its country in the stadium line.

Team colours too light for white text (Steelers yellow, Saints gold) put dark text on their splits bar.

**Line movement.** The worker's 15-minute cron reads DraftKings' current spread and total off ESPN's scoreboard (`espnOdds`, on every game `fetchScoreboard` returns) and `recordLineMoves` keeps a point whenever either changed, for games still to kick off, in one KV entry a week (`lines:<season>:<week>` = `{ open, games }`, 60 days). Not on a run ESPN refused: the saved schedule carries no odds.

**A week opens on Sunday night, by the owner's rule**: its first point is the line on the first run after the previous week's last Sunday game (ET) has gone final (`weekOpening`), marked `kind: 'open'`. Nothing is kept before then: lookahead lines are not the open. **ESPN's "open" is not used anywhere** - it has no time and is often a lookahead posted the week before ("a vague open from god knows when"); don't bring it back. A week whose Sunday night the tracker missed (it began on a Tuesday, the worker was down, or an open taken more than 6 hours after the last Sunday kickoff) starts each game with `kind: 'first'`, shown as "First seen · Tue 5:15 PM", and the popup's Opened column is a dash. A game whose line appears after the open is "first seen" too. **One agreed exception, 2026 week 7** (`OPENS_TAKEN_LATE`): tracking began on its Tuesday, and the owner chose to count that Tuesday's line as the open ("accurate enough"), so its open is `{ late: false, agreed: true }`. Don't add weeks to it without being asked.

**It reads next week's scoreboard as well** (`nextWeekBoard`, by week number), which is also how a week opens: ESPN's current scoreboard stays on a finished week until midweek - the first deploy, on the Tuesday after week 6, recorded nothing because ESPN still said week 6, every game over and its odds gone. `GET /lines?season=&week=` serves `{ open, games }`; the popup loads it (`loadLineHistory`): Opened in the Line table is the open with its time,; the charts below it show the points (there is no Movement table: the owner removed it as the charts show the same). The latest point can be half a point ahead of the Line table's "Now", which is the card's own line, refreshed from the Odds API only every few hours.

**Line charts.** Once a line has moved, the Line table's "Spread" and "Total" labels are buttons (a chevron, no underline: the owner's call; the spread's Opened and Now cells read "(logo) PIT -4", `pickTeamBadge`) (`.gd-line-toggle`, delegated on the popup) that open that line's chart under the table, one at a time; the open one lives in `lineChartOpen`, outside the render. `lineChartHtml` draws inline SVG, no library: a **step line** (a line holds until it jumps, so never a slope between points) from the open to now, or kickoff, with an 8px dot ringed in the panel colour at each point, half-point grid ticks, ET day ticks, the latest value at the right end, and a crosshair (`showLineChartPoint`, pointer events on the popup, so a finger dragged works) whose time and value show in the title row. One series a chart, so no legend. **There is no Movement table**: one listed the points under the Line table until the owner judged the charts enough ("the line graphs show it"). The chart subtitle is what says "since first seen Tue 5:15 PM" for a week whose Sunday night was missed. Colour `--chart-line` (light #2563eb, dark #3b82f6), run through the dataviz skill's validator against both panel surfaces; the NFL navy failed it (too dark to read as a line on white).

**The spread chart marks the viewer's own pick** (October 2026, replacing a "Picked at X → now Y" note on the card, which pushed the B5 star off a phone screen): an amber dot on a dashed rule at the moment they took the side they hold, at the line then, and "Picked at Browns -1.5 · Tue 3:12 PM" under the chart. Only the viewer's, by the owner's choice. It comes from the worker's `GET /picked-at?season=&week=&picker=` (`pickMoments`), read off the pick log in D1: the first save of the latest unbroken run on one side, a save with no side ending the run. Nothing new is stored. The site loads it with the line history (`loadPickMoments`, `viewerPickMoment`) and shows nothing when the log's side is not the one held, e.g. a pick still to reach the log. `pickedSpread` on a pick is device-local and lost on the next backup read, so don't build on it.

**There is no demo mode any more.** `?demo=lines` (made-up line moves for the charts) and `?demo=picks` (made-up picks on the Picks tab) were added in October 2026 for the owner to click through the popup before real data existed, then removed at their request once they had seen it. Build one again only if asked; if so, keep sample data out of `allPicks` and out of anything synced.

**°F or °C is a setting in the Android app** (Settings > Weather, 1.16+), by the owner's choice: the site asks `window.NFLPicksApp.temperatureUnit()` each time it draws a temperature (`temperatureUnit`, `formatTemperature`), so a change shows without a reload. A browser, or an app older than 1.16, shows °F; there is no browser setting. Temperatures are fetched in °F from both ESPN and Open-Meteo and converted.

**The time zone is a setting in the Android app too** (Settings > Time zone, 1.17+, the owner's choice; Eastern by default). There are two zones, by the owner's choice: Eastern (ET) and Ireland (`Europe/Dublin`, "IRL" on the cards). They change their clocks on different weekends, which the zone ids handle; never add a fixed offset. The site asks `window.NFLPicksApp.timeZone()` (`displayTimeZone`) and draws every kickoff through `displayGameTime` / `displayGameDay`: the cards, the Live tab, the popup's kicker, the line charts' times and day ticks. A browser, an app older than 1.17, or an id not in `TIME_ZONES` (kept in step with the app's `TimeZones.kt`) shows ET from the stored `game.time`/`game.day`, exactly as before. **Those stored fields stay ET**: `isPrimetimeGame` and the week's days read them. Coming back from Settings with a new zone, the app calls `appTimeZoneChanged()`, which redraws. `node test-app-bridge.js` covers it.

**Tabs.** Under the header are four tabs (`GAME_DETAILS_TABS`; the open one is `gameDetailsTab`, remembered between games), so the popup stays one fixed height (`min(760px, 90vh)`) and only the tab's body scrolls. The owner asked for "not a massive, long, or packed pop-up", grouped by relevance. On the Betting tab, TV (left) and weather (right) are pills in a footer pinned to the bottom of the popup, under the scrolling body, kept to one row on a phone. They were in the header briefly, then just below the data; the owner asked for the bottom.

- **Betting:** the splits, the Line table and its charts, as above.
- **Matchup:** each team against the spread this season at the **board** line (`teamAtsRecord`, never a picker's own number); each team's last five from ESPN, a table a team (its logo and name, then Week, Opp with the opponent's logo, and a green W or red L with the score), newest first. "Week 6", never a date (the owner: no US date format): ESPN's week from the worker, else the week this season's schedule has the two teams meeting, else the year for a game from an earlier season (`lastFiveWeek`); head to head across every loaded season (`headToHeadMeetings`, archived results from the archive alone, newest six shown), in the Last five's table style: Week ("Week 15, 2021"), Winner (logo, abbreviation, score) and Covered (logo, abbreviation, the line it covered at).
- **Players:** each player with a small round ESPN headshot (`headshotHtml`, through ESPN's resizer at 96x70, about 9 KB against 245 KB; an empty grey circle when there is none); injuries worst first, with short chips (OUT/DOUBT/Q/IR/PUP/SUSP; six a team, then a "Show all N" button, `injuriesOpen`). The list shown is **ESPN's own** (its summary's five, the most recently updated, by the owner's choice: "the five shown should be the same as ESPN"). "Show all N" (`injuriesOpen`) opens the team's whole list, which the worker reads off both teams' rosters (`rosterInjuries`, sent as `all` beside ESPN's `players`); the summary's five can leave out players who are Out (Aiyuk, Guerendo for the 49ers in week 7) and the passing, rushing and receiving leaders, from ESPN.
- **Picks:** the line pick (with its Blazin' star on the same row, `.gd-pick-line`; no "locked" tag and no "(you)" label, by the owner's choice: the viewer's row is shaded) and the straight-up pick of each picker (and Cowherd) who has picked the game, each team drawn as the Last five draws it (logo and abbreviation, `pickTeamBadge`; the line pick with the number it is graded at); nobody else is listed, and with no picks at all only "Nobody has picked this game yet" shows. Then with a tally bar in the team colours. It shows **before kickoff too**, deliberately, for anyone who wants to fade the group (the owner's choice, October 2026). Under it is the viewer's own record in each team's games, this season and all seasons, over **every** line pick, not only Blazin' 5: a "Took the Packers" row and an "Against the Packers" row (`pickerTeamRecord`, `against`; through `gradedPicks`). Both rows, because "took" alone read as a two-game record to someone who had picked all six Packers games.

Matchup and Picks load the archives on demand (`ensureArchivesLoaded`, as the 5-0 card does). Players and the last five come from the worker's `GET /espn-summary?event=<espnId>`, which trims ESPN's ~110 KB game summary to ~2 KB (`trimEspnSummary`: injuries, last five, three leaders, teams by nickname, headshots only from a.espncdn.com) and caches it 15 minutes. The site keeps it per event in `gameSummaries` for 15 minutes, and a failed fetch is retried after a minute. `node test-game-details-tabs.js` covers it.

Before the popup there was an inline panel under the picks that a tap on the card opened (October 2026), and before that the splits sat inside the Line Pick buttons.

Records, opening line, roof and forecast come off the ESPN scoreboard the schedule is already read from (`espnRecords`, `espnOpeningLine` in `fetchNFLSchedule`; `SCHEDULE_CACHE_VERSION` 9 added them and 10 the opening total). The merge of ESPN games onto the in-season snapshot copies fields one by one, so a new ESPN field has to be added there too.

**Sources disagree on which team is at home.** Action Network had week 7's Monday game as Eagles @ Cowboys; ESPN, and so the schedule, had Cowboys @ Eagles. `splitsForGame` looks a game up the other way round when its own key misses, and swaps each book's sides back.

## Betting splits

The popup's splits section is titled "Betting splits · Action Network · 2,923 bets" (the bet count from Action Network's `num_bets`, so a reader can tell when the percentages are thin): a column per side (away left, home right, under the buttons) and a labelled row each for "% of money on the spread" and "% of bets on the spread" (the owner asked for the spread to be named: it used to be assumed), the bigger share in bold. It shows Action Network's consensus only, by the owner's choice: it already combines the books. The worker still gathers DraftKings and Circa too, and the Splits tab stores all three; `SPLITS_BOOKS` in app.js is the list shown, so a source can be put back on the cards there. The site reads them from the worker's `/splits` on load and every 10 minutes while visible (`loadBettingSplits`, `gameDetailsHtml`); the live ones leave the popup once a game is locked, because the numbers then turn into live betting, and the saved final ones take their place (below).

Three layouts were tried and dropped, so don't go back to them: inside the Line Pick buttons (it made them taller than the Straight Up buttons beside them); a column per source (three across cut the team names off on a phone); and a row per source reading "53% · 69%" under a "$ · bets" key, labelled "Public", which was hard to follow. One number a cell, its meaning written beside it.

**DraftKings alone is thin early in the week.** On a Tuesday a few large bets can be most of its handle: 49ers -3.5 showed 4% of DK's money on 45% of its bets, while Action Network's consensus had 53% on 69%. That is why the consensus is there and comes first. Action Network's terms forbid automated access and its API's robots.txt disallows everything; this is a private group's site and using it anyway was the owner's deliberate choice (October 2026). Don't add it anywhere public.

**None has an official API.** Action Network's is the JSON scoreboard its own site reads (`parseActionNetworkSplits`: spread outcomes by `side`, with `bet_info.tickets` / `bet_info.money` percents). The worker parses DK Network's splits page (paged, 10 games a page; a page past the end repeats the last, which is how paging stops) and VSiN's Circa table. A side is matched to its **team**, never its position: DK lists the favourite first. VSiN only lists the current slate, so Circa appears for next week's games once VSiN posts them. If a page is redesigned the parser returns nothing for that book and the other carries on; `errors` in the `/splits` reply names the failing one. `node test-betting-splits.js` covers the parsing against fixtures in the real pages' shape.

**Only the final numbers are stored**: the Splits tab, one row per game, written by the cron on its last run before kickoff (or the first after, if that run was missed). Between runs the latest snapshot for each game within 30 minutes of kickoff sits in KV (`splits:pending`), and stays there up to 7 days if the sheet refuses it, so a write that failed, or an Apps Script not yet redeployed, catches up later. Rows carry DK, Circa and (in the columns after Recorded At, added later so earlier rows stay aligned) AN line/handle/bets for both sides, plus kickoff and when the numbers were taken; `?action=splits&season=YYYY` reads them back, last row per game. They are not graded yet; the Results tab has everything that needs, joined on week + game key.

**A started game shows its saved final splits** (October 2026, the owner's ask: the numbers used to just vanish at kickoff). Once a game is locked, under way, final, or in a past week, the popup draws the Splits tab's row instead of the live `/splits` numbers, titled "Final splits before kickoff" rather than "Betting Splits", in the same bars (`splitsAreFinal`, `savedSplitsForGame`). The site reads the tab by season through `/sync?action=splits&season=` (`loadSavedSplits`, kept 5 minutes) when a popup opens on such a game, and on the 10-minute splits beat while one is open, so a game that kicks off with its popup open switches over. The row has no bet count, so none is shown. Rows exist from 2026 week 6's Sunday night game on; an earlier game, or one the cron missed, shows no splits, as before.

## Winnings

The Winnings card (Insights panel, Blazin' 5 and Line Picks sub-tabs) and the profit line on every leaderboard card answer one question: what would a flat stake on each pick have returned? `calculateWinnings(stake)` is the whole engine, and it is `calculateStatsForWeeks` with money on it - the same picks, results, frozen lines and season scoping as the standings, with `profitForRecord` applied to each week's record. The card and the leaderboard lines are the same call, so the two places money appears cannot disagree.

**Every line pick is priced at -110.** The odds feed's spread `price` is thrown away in `applyOddsData` (only the point is kept, in memory, in the saved-spreads store and on the sheet), so the real juice on a given side is unknowable after the fact. A win returns 10/11 of the stake, a loss costs the stake, a push returns it. Straight-up picks are not scored: they have no price either, and pricing them properly means keeping the `h2h` moneylines the worker already fetches (`homeMoneyline`/`awayMoneyline` are set on the game object but never persisted). That is the natural next step if the feature grows.

The stake is per device (`nfl_winnings_stake` in localStorage, $20 by default) and edited in the card's header; changing it redraws the dashboard so the cards follow. ROI is profit over money staked, pushes included in the stake.

`node test-winnings.js` covers the arithmetic, the engine's agreement with the standings, Cowherd's column and the stake setting.

## The game list redraws without blinking

**Every piece of data that lands redraws the game list** (`renderActiveTab` → `renderGames`): the sheet's lines, the betting splits, the results backup, the picks backup, then a final pass. That is six full rebuilds in the first five seconds, and every rebuilt `.game-card` replayed its `slideIn` animation, so the list visibly blinked about three times on opening (reported October 2026). Two rules now:

- **An identical list is left alone.** `renderGames` keeps the last markup it drew (`gamesListHtml`) and skips the rebuild when the new one is the same. Anything that changes cards in place invalidates it: a pick click updates its buttons directly and then saves, so `savePicksToStorage` clears `gamesListHtml`, and the next redraw rebuilds.
- **Only a new view slides in.** `gamesListView` is season, week, picker and filter; a rebuild of the same view puts `.settled` on `#games-list`, which turns the card animation off. A new week or picker animates as before.

On a normal load the list now rebuilds three times, and only the first animates.

## Picks in D1 (being rolled out, October 2026)

Picks are moving from the Backup sheet to Cloudflare D1, bound to the worker as `PICKS_DB`; the plan, the reasons and the steps are in `D1-PICKS-PLAN.md`. The site's code does not change: it calls the same `/sync` endpoints and gets the same shapes back. In the worker:

- **D1 keeps the sheet's append-only log** (`pick_rows`, one row per pick per sync) and folds it on read with a line-for-line copy of the Apps Script's reader (`foldPickRowD1` / `pickPayloadD1`). Change one and you must change the other: `node test-worker-d1.js` runs both over the same rows and requires identical picks.
- **Until the switch** (`PICKS_READ` = `d1` in the worker's variables) the sheet is still what the phone waits on and what every phone reads; D1 is a shadow written beside it. That is deliberate: answering from D1 while phones read the sheet would let a failed sheet copy hide a pick from other phones, and from the saving phone's own next load. After the switch a save is answered from D1 and copied to the sheet in the background (`mirror:pending` if that fails).
- **D1 refusing** sends the request to the sheet and queues the save (`d1:pending`); the cron (`runPicksDbMaintenance`, on its own chain beside `runAutomations`) replays both queues, warns at half a free limit, and compares D1 with the sheet daily once a season is imported. All admin alerts are the one-line-for-`ADMIN_PICKER` kind.
- **The copy in** (`POST /admin/picks/import?season=`) reads the sheet's raw rows (`action=backuprows`, added to the Apps Script for this) and stops at `liveSince`, the first save D1 saw, so no save is in D1 twice.
- **Reads come from `current_picks`**, a row per picker per game holding the log's fold, not from the log itself (about 600 rows a page load in week 7 against 9,600, and 1,800 against 20,000 by the season's end). Every save re-folds that picker's week from the log and stores the result (`refreshCurrentPicks`), so the table is always exactly the log's fold, whatever order rows arrive in. A season reads from it once `current:<season>` is in `pick_meta` (set by `rebuildCurrentPicks`: the copy in, or the cron for a season copied in before the table existed); before that, reads fold the log. The daily comparison also checks the table against a full fold of the log (`currentDrift`) and rebuilds it if they ever differ; the log is the record.
- **D1 counts index updates as writes**: a row inserted costs about four rows written. The one-off copy of 10,739 rows used 42,960 of the day's 100,000; a normal save is about 64.
- **Manual corrections** made straight in the sheet are not seen by D1. Before the switch the daily comparison flags them; after it, correct picks through the site.

## Guess the Lines

The game from the Bill Simmons podcast with Cousin Sal (October 2026, the owner's ask): guess a game's spread, then see how close you were. The **Guess Lines** tab has two modes, by the owner's design (`guessState.mode`, remembered per device):

- **Solo vs the line.** Between the end of Sunday night's game and the end of Monday night's, next week's lines are out but not on the site. Pick a spread for a game and press Submit: the worker answers with DraftKings' line **at that moment** (the latest point in `/lines`) and stores it with the guess, and that is the reveal. The line is read by the worker, never sent by the phone, and **a submitted game is final**: a second submit gets the first one back (409 with `entry`), so nobody guesses again after seeing the answer.
- **With the podcast.** Four fields a game: your guess, Sal's, Bill's, and **the line they read out on the show**. Everyone is scored against that announced line, stale or not - the owner's point is that it keeps it level. **The closest gets 1 point, and a tie gives each of them 1** (the owner's rule; `podcastGameWinners`). A game scores once its line is in and at least two have guessed, so a lone guess cannot win by default. A live table of the week (points, games, points off) sits above the games, sticky under the tabs, and redraws on every entry. The season table is points and weeks won (most points; a tie counts for each). Any week, any time (the episode comes out when it comes out), and every field stays editable.

**Each game is a card dressed like the Game Details popup**, by the owner's ask: its `.gd-hero` (kickoff, both teams with their records, the venue: `detailsKickoff`, `detailsRecord`, `detailsVenue`) and ESPN's injuries (`injuryColumnHtml`, shared with the Players tab; the summaries load per game and redraw only their own card, `refreshGuessInjuries`), and **no line or spread anywhere on it** - that would spoil the guess. Under it, a guess is **the favourite** (a tap on a team) and **the points**, typed in a box (`parseSpreadText`: half points, "PK" for 0) or moved half a point at a time by ▼▲ (`.spread-control`). Podcast cards have a compact row each for You, Sal, Bill and the line. **Typing must keep the cursor**, so an edit changes the page in place (`spreadControlChanged`: Submit, the card's marks, the live table, the season) and never redraws the tab; the 5-minute reload skips its redraw while a field in the tab has focus (`guessTabHasFocus`).

Solo is scored in points off, `|guess - line|`, lower is better. Every spread is stored as a **home spread** (-3 is the home team giving three).

- **The solo window is the line history's.** The worker's `/lines` entry for a week opens on Sunday night (`weekOpening`, as before) and gets `close` on the first cron run once every game of the week before is final (`weekPlayed`), or `{ late: true }` straight away for a week first seen on ESPN's current board. Open = `open`, not `late`, and no `close` (`guessWindowOpen`). The site checks this week and next: in Ireland the site's week turns at midnight, during Monday night's game.
- **Stored in KV, not D1 or the sheet**: `guesses:<season>:<picker>` = `{ week: { solo: { game: { guess, line, at } }, podcast: { game: { you, sal, bill, line } } } }`, through `GET/POST /guesses` (`mode: 'solo' | 'podcast'`). Each POST rewrites the picker's whole season, so the site sends them one at a time (`postGuess`).
- **The tab is up** while solo is open, from then until the current week's first kickoff (so the podcast can be entered when the episode lands), and all season for anyone with guesses (`updateGuessTabVisibility`).
- **Not a vault.** Next week's lines are readable from `/lines` and the sheet; it is an honour-system game.

`node test-guess-lines.js` covers the close, both modes of the endpoint and the scoring.
