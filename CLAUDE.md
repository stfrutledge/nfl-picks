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

## Odds API budget

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
- **`applySavedSpreads()` replaces a differing line on any game whose kickoff
  is known and still ahead** (`lineStillOpen`). A game that has kicked off
  keeps the line it has, same as `applyOddsData()`; a game with no kickoff is
  left alone rather than guessed at. Completed games still take a saved line
  when they have none - that part is unchanged.

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

**The mean of the last three weekly percentages, and a dash until there are
three.** `LAST_3_WEEK_WINDOW` is both the window and the minimum.

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

Still fed by the workbook, so still blank for a new season: the group-overall panel, lone wolf, universal agreement and favourites-vs-underdogs. Those need the same treatment (`parseNFLPicksCSV` is what they come from). `node test-standings-engine.js` covers the parts that are done.
- **ESPN schedule fetches** pin `dates=<CURRENT_SEASON>` — without it, ESPN serves the previous season during the offseason.

Offseason checklist (the only manual step): archive the finished season to `historical-<year>.js` **including playoff weeks 19-22** (historical-2025.js has them; 2016-2024 are regular-season only), and paste in the Cowherd block that `exportCowherdResults()` prints from the browser console. His week-by-week record is the one piece that cannot be re-derived once the season's picks are cleared.

Run `node test-offseason-reset.js` to smoke-test the rollover behavior.

## Winnings

The Winnings card (Insights panel, Blazin' 5 and Line Picks sub-tabs) and the profit line on every leaderboard card answer one question: what would a flat stake on each pick have returned? `calculateWinnings(stake)` is the whole engine, and it is `calculateStatsForWeeks` with money on it - the same picks, results, frozen lines and season scoping as the standings, with `profitForRecord` applied to each week's record. The vs Market bankroll (`calculatePickerWeeklyBankroll`) is the same call at $20, so the three places money appears cannot disagree.

**Every line pick is priced at -110.** The odds feed's spread `price` is thrown away in `applyOddsData` (only the point is kept, in memory, in the saved-spreads store and on the sheet), so the real juice on a given side is unknowable after the fact. A win returns 10/11 of the stake, a loss costs the stake, a push returns it. Straight-up picks are not scored: they have no price either, and pricing them properly means keeping the `h2h` moneylines the worker already fetches (`homeMoneyline`/`awayMoneyline` are set on the game object but never persisted). That is the natural next step if the feature grows.

The stake is per device (`nfl_winnings_stake` in localStorage, $20 by default) and edited in the card's header; changing it redraws the dashboard so the cards follow. ROI is profit over money staked, pushes included in the stake.

`node test-winnings.js` covers the arithmetic, the engine's agreement with the standings, Cowherd's column, the stake setting and the vs Market bankroll.
