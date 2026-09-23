# Code Review - September 2026

Full review done on 2026-09-22 at commit `2e85bee`. Five parallel read-only passes covered the data layer, scoring, UI and sync, the backend and tests, and product/UX. The most serious findings were checked against the code by hand.

**Line numbers refer to `2e85bee`.** `app.js` has changed since, so look things up by function name first.

**Verdict:** the core scoring engine (`calculateStatsForWeeks` → `standingsFromComputed` / `calculateWinnings`) is sound, well documented and well tested. What was wrong sits around it: a security hole, a data-loss path, a January date bug, and about 12 copy-pasted stat loops that have drifted from the engine.

---

## Done

| Item | Commit |
|---|---|
| Odds API key in public git history | Not an issue: the key is already revoked (401 on the free `/sports` endpoint). Don't rotate it and don't rewrite history. |
| Worker: `?refresh=true` and query-string cache busting spent credits | `1f5f385` (deployed to Cloudflare and checked live) |
| Worker: `/sheets` substring check made it an open proxy | `1f5f385` |
| Lost picks: debounced sync read picker and week when it fired | `137c329` |
| A failed sync from a pick click was silent and never retried | `137c329` |
| Hidden-tab flush had no `keepalive` | `137c329` |
| Backup load clobbered unsynced picks, and a stale `cleared` flag wiped new ones | `137c329` |
| Back-to-back syncs were not serialised | `137c329` |

---

## Fix before January 2027

### Playoff dates are hardcoded to the 2025-26 calendar - HIGH
`getSeasonDates` (app.js:200-204) fixes Wild Card to Jan 10, Divisional to Jan 17, Conference to Jan 25, Super Bowl to Jan 26 and the end to Feb 9, whatever the year. Labor Day 2026 is Sept 7, a week later than 2025, so:
- Jan 10 2027 (week 18 Sunday) computes as week 19.
- Jan 17-18 compute as week 20.
- Jan 31 computes as week 22.

`isGameLocked` locks every game in a week below `CURRENT_NFL_WEEK`, so the week 18 Sunday games, the Wild Card games and both Conference games lock before kickoff. The Super Bowl window also ends before the game (Feb 14).

**Fix:** derive the dates from `seasonStart` (week 18 Tuesday plus 1, 2, 3 and 5 weeks), or read them off the ESPN schedule.

---

## Scoring and grading bugs

1. **A game tied in progress counts as a straight-up loss for everyone. HIGH.** `liveProvisionalResult` returns `winner: null` at a level score, and `calculateStatsForWeeks` (~6383) does `pick.winner === result.winner ? 'wins' : 'losses'`. Every straight-up pick on a 0-0 game that has just kicked off becomes a loss in the Live as-is table, the in-play box and Move. `asIsPickDetail` shows the same picks as pending, so the two disagree.
2. **A final tie is graded three different ways. MEDIUM-HIGH.**
   - `getGameResult` (4899, 4908, and the copies at 10971 and 12146) gives the win to away.
   - `postResultsToSheet` (4832) gives it to home.
   - After a reload the sheet's `'tie'` comes back and scores a straight-up loss for everyone.

   The Apps Script grades it a push (line 893). Treat a tie as a straight-up push everywhere.
3. **The Scoring Summary counts a game with no line as a loss. HIGH.** At 12157-12172, `atsWinnerForPick` returns null and falls through to `lineLosses++` / `blazinLosses++`. `renderGames` correctly skips it (`atsWinner &&`).
4. **Blazin' "By Spread" buckets use the board line, but grading uses the pick's line. HIGH.** `calculateBlazinSpreadRecords` (8016-8022) and `calculateHistoryBlazinSpreadRecords` (8672-8678) bucket by `game.spread`/`game.favorite`. A pick locked at -3 that wins by 4 lands in the -6.5 row as a WIN. A null board line with a frozen pick gives a "PK" or "null" bucket. Use `lineForPick`, as `favoritesVsUnderdogsFromPicks` (6661) already does.
5. **History fav/dog disagrees with the Line tab chart. MEDIUM.** `calculateHistoryBlazinFavDog` (8481) uses the board favourite and files pick'em games under Favourite or Underdog. The chart (6663) uses the locked line and skips pick'em games.
6. **Playoff weeks leak into regular-season panels. MEDIUM.** These loop `week <= CURRENT_NFL_WEEK`, which reaches 22:
   - `calculateTeamPickRecords` (7133)
   - the three lone-wolf functions (8941, 9041, 9131)
   - `calculateWorstBlazinWeeks` (7725)

   Standings, consensus and fav/dog use `regularSeasonWeekRange()`.
7. **The hand-rolled panels read stored results only. MEDIUM.** Team records, worst week, the Blazin' team/spread tables and lone wolf use `results[game.id]`. The standings use `getGameResult` with its live fallback, so a game that has just finished counts in one and not the other until the backfill lands.
8. **No decided picks renders a red "0%". MEDIUM.**
   - `renderPickerCard` (9932, 9988, 10010) uses `percentage >= 50` and `?.toFixed(2) || 0`.
   - `calculatePlayoffStats` (6818) stores 0 instead of null.
   - The same happens on the lone-wolf card (9434, 9473) and the team/spread tables (7318, 7878, 8078).

   The rule in `CLAUDE.md` is that no percentage is neutral.
9. **Detail rows print the board line, not the graded one. LOW-MEDIUM.** `${fav} -${g.spread}` at 7340, 7897, 8103 and 9453 shows "-0" for a pick'em and "-null" for no line. Use `describeLineForSide(game, side, pick)`.
10. **Super Bowl summary.** It prints "+null" or "-0" and ignores the locked line (12293). The playoff breakdown's `game.spread ?` treats a pick'em as missing (10749).
11. **Deselecting a line pick keeps `blazin: true`** (11359-11371). The star still counts toward the cap and syncs with a blank line.

**Root cause of 4-9:** about 12 copy-pasted per-picker loops that drifted from the engine on week range, result source and which line they read. The durable fix is one engine iterator yielding (game, picker, pick, graded line, result) rows that all these panels consume.

---

## Data layer

1. **During an ESPN outage, the expired schedule cache is deleted before the fetch that could fall back to it. MEDIUM.** `getCachedSchedule` deletes entries older than 2h (~700) before `fetchNFLSchedule` runs, so the stale fallback (~928) finds nothing and the week becomes `[]`. Past weeks drop out of the standings. **Fix:** keep the expired entry until a fetch succeeds.
2. **Old cached odds can replace fresher sheet lines on one device. MEDIUM.** `fetchNFLOdds` falls back to a cache of any age (1487-1490), and that key isn't season-scoped. `applyOddsData` then `saveSpread`s over what `loadSpreadsFromGoogleSheets` just stored (1666-1669). A pick locked there freezes the old number and syncs it. **Fix:** a non-fresh line must never replace a saved one, and cap the age of the error fallback.
3. **`CURRENT_NFL_WEEK` is a `const` read at page load. LOW.** A tab left open from Monday into Thursday keeps the old live window, and the Live tab stays hidden until a reload.
4. **The week boundary drifts an hour after DST ends. LOW.** `Math.floor((now - seasonStart) / msPerWeek)` (~240) counts from local midnight in September, so after Nov 1 the week turns at 11pm Monday, during Monday Night Football. It also depends on each device's timezone.
5. **`setupWeekButtons` adds a change listener on every rebuild. LOW.** It's called from init, auto-advance (1852) and preload (2040), so one week change runs `setCurrentWeek` two or three times at once.
6. **`setCurrentWeek` has no stale-call guard. LOW.** Rapid week switching can briefly render a week before its data has loaded.
7. **Results are keyed by `game.id`, which is reassigned whenever a week is re-sorted.** It holds because results are re-filed by matchup. A mid-session reorder of games with the same kickoff time could mis-attach them.

---

## UI, sync and security

1. **Picks can be changed after kickoff. MEDIUM.** `handlePickSelect`, `handleBlazinToggle` and `handleOUSelect` rely on the `disabled` state set at render time. There is no `isGameLocked` check when the click happens, and the Apps Script has no kickoff check either. (Cowherd entry is deliberately unlocked; leave that alone.)
2. **No auth on the write path. Accepted risk.** Anyone reading `app.js` can POST picks, results, spreads or `cleared: true` for any picker, via the worker or the Apps Script URL directly (app.js:15). A real fix needs a check inside Apps Script plus a new deployment URL kept out of the repo.
3. **Formula injection into the sheet. MEDIUM.** `appendRow` and `setValues` in `google-apps-script-simple.js` (350-368, 412, 421, 691, 703) write client strings as-is, so a value starting with `=`, `+`, `-` or `@` becomes a live formula. **Fix:** prefix these with `'` and add length checks. Needs an Apps Script redeploy.
4. **No LockService in the Apps Script. MEDIUM.** `saveSpreads`, `saveResults` and `saveClearedStatus` read and then write, so two concurrent backfills can append duplicate Results rows.
5. **`calculateAndSaveOutcomes` scans the whole Backup sheet per result. MEDIUM.** It runs on every backfill and will head toward the 6-minute Apps Script limit. The client never reads the Outcome columns, so consider dropping them.
6. **`index.html:32-33`.** Chart.js is loaded unpinned (`npm/chart.js` always serves the latest), and neither CDN script has SRI. Pin the version and add `integrity`.
7. **Pull-to-refresh fires by accident. MEDIUM.** A touchstart below the top leaves `startY` at 0, so a scroll that reaches the top mid-gesture reads as a huge pull (13920-13966). The document-wide non-passive `touchmove` also costs scroll performance.
8. **Accessibility.**
   - Pick and O/U buttons have no `aria-pressed`, and the star reads "B5☆".
   - The confirm modal has no `role="dialog"`, `aria-modal` or focus trap.
   - Toasts have no `role="status"`, so "Sync failed" is never announced.
   - As-is standings rows are clickable `<tr>`s that can't be reached by keyboard.
9. **XSS: low risk.** ESPN strings go into innerHTML unescaped (3303-3349, including an inline `onerror` with `${game.away}`). A shared `escapeHtml` helper would be cheap insurance.
10. **Worker's remaining exposure.** The Cloudflare cache is per data centre, so an attacker going through many regions can force one fetch per region per window. That is small next to what was possible before.

---

## Tests

- **`test-live-tab.js` (3 checks) and `test-offseason-reset.js` fail. The tests are wrong, not the product.** They read the real clock and assume week 1, but today is week 3.
  - `test-offseason-reset.js` stops at its first failed check (line 85), so the rollover smoke test is currently checking **nothing**. Line 84 also hardcodes 2026 and will break next July.
  - **Fix:** inject a clock, either a `Date` shim into the `new Function` or a `now` parameter on `calculateCurrentNFLWeek`. For the as-is test, pass `{first: 1, last: 1}`.
- **There's no single command to run the suite:** no `package.json`, no runner, no CI. Add a `run-tests.js` or an npm script.
- Untested paths: team records, worst week, the Blazin' spread and team tables, the history fav/dog and spread tables, lone wolf, consensus, `favoritesVsUnderdogsFromPicks` and `renderPickerCard`.

---

## Dead code and clutter

- **vs Market is permanently hidden** (`index.html:71`, `display:none`, never revealed). It's about 1,400 lines (~14015-15420) plus 37 CSS rules.
  - It fetches prices through public CORS proxies, one of them dead (`cors-anywhere.herokuapp`).
  - It has a stored-XSS path: `meta.shortName` from a proxy response goes into innerHTML (14154, 14709+).
  - `getNFLWeekStartDate` hardcodes `2025-09-04`, so it's broken for 2026 anyway.

  **Delete it**, but keep `profitForRecord` / `calculateWinnings` and drop the bankroll part of `test-winnings.js`.
- `cloudflare-worker/odds-proxy.js`: an older copy of `handleOdds`, never deployed. `cloudflare-worker/README.md` documents that file and a non-existent `ODDS_PROXY_URL`.
- `google-apps-script.js`: the retired workbook writer.
- `data.csv` (referenced nowhere), `start.bat` (needs Python), `generate-historical-2016…2019.js` (one-offs whose output is committed), `check-dylan-*.js`.
- In `app.js`:
  - `copyPicksToClipboard`, wired to a `#copy-picks-btn` that doesn't exist.
  - `resetAllPicks`: no button, and it writes the wrong shape.
  - The JSON import/export handlers.
  - `startCountdownTimer`, a 1s interval with nothing to update.
  - `historical2024Loaded/Loading`, the legacy CSV/CORS path in `setCurrentWeek`, `isNFLGameDay`'s weekday list, `updateSpreadsFromAPI`, `setCurrentSeason`, `loadAllWeeklyDataForBlazin` (legacy-gated), and a stacked outdated doc comment on `getLiveGameStatus`.
- **Duplication:**
  - `setupWeekButtons` vs `setupWeekButtonsForSeason`.
  - Three copies of the spread-application code in `loadWeekSchedule`.
  - The history and lifetime tables repeat the scoring loop and row renderer.
  - The `away_home` key is built with raw `toLowerCase` in about 8 places instead of `pickKey`.
- **Performance:** a Blazin' `renderDashboard` runs about 15 full scoring passes, and it repeats on every 30s live poll while Standings is open. That's only milliseconds today, but it grows with each archived season.

**Keep:** `parser.js` and `charts.js` (both still loaded and used), plus `stamp-assets.js` and `pre-commit`.

---

## Stale docs

- **`ROADMAP.md`:** "Live Pick Tracking as an overlay" was built, then deliberately replaced by the Live tab (commits `29684d2`, `54bc344`, then `fbb33c9` onward). "Current State" (weeks 1-15, workbook parity) is also out of date.
- **`FEATURES.md`:** dated "December 2024", but the first commit is 2025-12-13, so it's really from Dec 2025.
  - #8 (floating buttons) and #28 (copy confirmation) are moot.
  - #10, #16, #20 and #25 are partly done or done differently.
- **`CLAUDE.md` "Standings":** still says group-overall, lone wolf, consensus and fav-vs-dog are fed by the workbook. Commits `0827347`, `84eb5f4` and `414747e` moved all four to computed data.

---

## Features to redo or cut

- **Cut vs Market** (see above). The Winnings card already answers "what would $20 a pick have made".
- **Four "this week's record" views:** the Standings Individual Weeks toggle, History's week toggle, the Scoring Summary and Live. Drop the Standings toggle, since History already covers the current season.
- **The Standings Blazin' Records panel is a weaker copy of History's.** Reuse History's component or link to it.
- **Records & Analysis has five sub-panels.** Fold Patterns (thin: team and primetime splits, current season only) into Insights.
- **Live's Line and SU sub-tabs** are low value on a Sunday. Default to Blazin' and consider dropping the other two.
- **Onboarding's "Keyboard Shortcuts" step** is aimed at desktop users. Replace it with a Blazin' 5 / Lock Pick explainer, which also covers FEATURES #6.

## Features worth adding (best value for effort first)

1. **Weekly recap card with "Copy for WhatsApp" (low effort).** After Monday night: the week's winner and loser, 5-0s, lone-wolf hits, Cowherd vs the group, the Winnings swing and position moves. Built from `calculateStatsForWeeks`, `perfectBlazinWeeks`, `calculateBlazinLoneWolfPicks`, `calculateWinnings` and `asIsPositionChange`. The WhatsApp formatter already exists in Export All Picks.
2. **"Still to pick" strip plus a nudge (low).** For example "Sean 9/16, 3/5 stars", a countdown to the next kickoff and a one-tap copy of a nudge message. No backend needed.
3. **Hall of Shame and bad beats (low-medium).** ROADMAP #3, not started. Cover margin is `lineForPick` arithmetic on final scores. "Worst Blazin' pick of the week" is the biggest miss, and "Bad beat" is a loss by 1 point or less against the number. Keep a persistent all-time list and feed it into the recap.
4. **Season-long head-to-head (medium).** Generalise `calculatePlayoffAgreement` and the agreement matrix to the regular season, adding each pair's record on games where they disagreed. Covers FEATURES #16.
5. **Moneylines: use them or drop them (medium).**
   - The `h2h` data is a third of every odds fetch and is thrown away.
   - To use it, persist `homeMoneyline` / `awayMoneyline` to the Spreads sheet (needs an Apps Script redeploy) and price straight-up picks in `calculateWinnings`.
   - If not, drop `h2h` from the worker's markets and save a third of the budget.
6. **Group pick splits on cards after kickoff (low).** Reuse Live's `live-picker` chips on the Make Picks and History cards, for example "3 on Bills, 2 on Jets".
7. **Mobile pick flow (medium).** Treat the remembered picker as an "I am X" identity, collapse the week/picker/filter/actions controls into one sticky bar, and add week swipe (FEATURES #9).

**Skip:** PWA, TypeScript, confetti, seasonal themes and pick notes. They're low value for five friends.

---

## Suggested order

1. Playoff dates (before Jan 10, 2027).
2. Tie handling and the no-line Scoring Summary loss. Both are small and contained.
3. Fix the two clock-dependent tests and add a single test command.
4. Delete vs Market and the dead files.
5. Consolidate the drifted stat loops onto one engine iterator (fixes scoring items 4-9).
6. Weekly recap, then the "still to pick" strip, then Hall of Shame.
