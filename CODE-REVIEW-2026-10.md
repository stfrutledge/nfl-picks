# Project Review - October 2026

Review of commit `00d4f75` (branch `stat-engine`, same as `master`), done on 13 October 2026, during Week 6. This was a review only: nothing was changed.

Three separate passes covered the front-end code, the backend and infrastructure (worker, Apps Script, Android app, tooling), and the live site at phone and desktop sizes in light and dark mode. During the live-site pass every save request was blocked, so no picks were written.

Left out on purpose:

- Anything already declined. That covers the still-to-pick strip, Hall of Shame, a click-time kickoff check, real odds or moneyline pricing, the picked-at line, line-move alerts, a web unlock panel, an in-app update prompt and the old Odds API key.
- Anything `CODE-REVIEW-2026-09.md` marks as fixed.

Where this review overlaps that doc's open items, it says so.

**Checks:** all 25 test files pass, `scripts/stamp-assets.js --check` reports the stamps are current, and the pre-commit hook is installed.

## What's working

- **One grading path.** Every panel scores picks through `gradedPicks` → `lineForPick` / `atsWinnerForPick`, so the standings, cards, records and winnings can't disagree. The drift bugs from the last review are fixed and covered in `test-records-panels.js`.
- **Pick syncing holds up.** It has:
  - per-slate versioned entries that retry with backoff
  - a `keepalive` save when the page is hidden
  - stamped Cowherd tombstones
  - the `spreadsStillOpen` guard

  Each is backed by a test that pins the clock.
- **Worker guards.**
  - Odds requests share one cache key, and nothing in the request can force a fresh fetch that spends credits.
  - `/sheets` checks the parsed host. `/espn` forwards only numeric parameters and never caches errors.
  - `/notify` checks its secret (hash, then compare) before reading the body.
  - Credit pacing works from the remaining balance, and the per-fetch cost is derived, not hardcoded.
  - The cron reads the sheet only when something could be due, and KV "sent" flags stop double sends.
- **Speed and stability.** Cards render in about 0.5s on desktop and 0.9s on a phone. Background data settles in 5–7s without blocking the page, and the console is clean.
- **Good pool content.**
  - The graded week view: coloured chips, final scores, "Locked at…" chips, the Blazin' bar.
  - Insights: Lone Wolf, 5-0 weeks, Winnings with a stake you can change.
  - History back to 2016.
  - A polished dark mode.
- **Secrets stay out of git.** Signing keys and the Firebase and admin config are ignored. The Android app holds only a SHA-256 of the admin key, and its WebView is pinned to the site.

## What could work better (most important first)

1. **On narrow phones (400px CSS width or less) the card header cuts off the spread**, e.g. "SEAHAWKS (-2" and "BRONCOS (+2." at 390px. The cause is the `@media (max-width: 400px)` rule at styles.css:3242-3261, which sets the team names to `nowrap` + `ellipsis` + `max-width: 45%`. Wider phones aren't affected: a Pixel 9 (412px) skips the rule and the header wraps onto a second line. Many Samsungs (360–384px), older or smaller Pixels and iPhones are hit. How much this matters depends on which phones the group uses.
2. **Fixed (2026-10-14): each poll carries a run number and stops once it is out of date. See CLAUDE.md, "One poll at a time".** **Live polling can run twice and can't be stopped.** `scheduleLiveScoresRefresh` (app.js:2131) replaces `liveScoresRefreshTimer` without clearing the old timer. Its `finally` also starts polling again even when `stopLiveScoresRefresh` ran while a fetch was in flight. Switching tabs mid-fetch can leave a second 30-second loop of ESPN fetches and full `renderActiveTab` redraws. Checked in the code.
3. **Fixed (2026-10-14): a failed fetch keeps polling, at the 2-minute rate.** **If the first ESPN fetch fails when the page opens, the page never starts polling.** `fetchLiveScores` returns an empty cache on error, and `shouldPollLiveScores` (app.js:1845) returns false on an empty cache. Scores stay frozen until someone switches tabs.
4. **An Apps Script error looks like "nobody has picked".** `doGet` answers errors with HTTP 200 and an `{error}` body (google-apps-script-simple.js:91-93). The worker's `appsScriptGet` only checks `response.ok` (nfl-picks-proxy.js:731). The result:
   - The cron would tell all five pickers they have every game left, and mark that reminder as sent.
   - `/reminder-check` would answer `remind:true`.

   This was read from the code, not seen happening.
5. **The week is worked out only once, when the page loads.** `CURRENT_NFL_WEEK` is a `const` (app.js:236). The Android WebView resumes the page rather than reloading it, so a phone left open for days gets the Live window, `isGameLocked` and the default week wrong. This overlaps the prior review's Data-layer #3.
6. **Stale cached odds can overwrite good lines on one device.** When a forced fetch fails, `fetchNFLOdds` falls back to cached odds however old they are (app.js:1549-1553), and `applyOddsData` saves them over the lines loaded from the sheet. That device can then show an old line, and lock a pick at it. The sheet itself is protected. This overlaps the prior review's Data-layer #2.
7. **Apps Script concurrency.**
   - `saveClearedStatus` updates the first matching row, and `getAllPicks` treats any "Yes" as cleared. A duplicate row created by two saves at once can leave a week stuck as cleared.
   - `savePicks` calls `appendRow` once per game (about 16 calls per sync), with no `LockService`.
   - Formula injection is still open (prior review's UI #3).

   Fixing any of these needs an Apps Script redeploy.
8. **Labels that confuse people:**
   - "Year Chg" is a percentage-point change but is labelled "%".
   - "Best Week 5" is a week number but reads like a count.
   - "B5 ☆" means nothing to a newcomer.
   - The header line and the locked line differ, and it isn't clear which one was graded.
   - The chart's default button says "Zoom Out".
   - The Lock All tooltip is ambiguous.
9. **Fixed (2026-10-13): records and Patterns now rank by `rankingScore`, the record padded with two wins and two losses. See CLAUDE.md, "Ranking records".** **Records sorting doesn't break ties by sample size.** Team Records ranks Seahawks 3-0-2 above Commanders 5-0, and Patterns names the 3-0-2 as "best". Blazin' "Record" sorting puts Saints 3-1 above Jets 2-0. Pushes act like losses that don't count.
10. **"By Spread Size" is mostly noise.** It has a row for every half-point line, so this season it's mostly 1-0 rows, and on Lifetime it runs to about 75 rows. Buckets would read better: ≤3, 3.5–7, 7.5+, favourite/underdog.
11. **Phone layout:**
    - The standings table scrolls sideways with no hint that it does.
    - The "Patterns" tab is cut off.
    - The header and selectors take about 330px, so only half of the first card shows on screen.
12. **Accessibility:**
    - White text on the green active pill in dark mode is about 2.5:1 contrast, which fails AA.
    - Win, loss and push are shown by colour only.
    - The B5 and Lock buttons are under the 44px tap-target size.
    - Dialogs and toasts have no `role="dialog"`, `role="status"` or `aria-pressed`.
13. **There's no way to tell whether the live worker or Apps Script matches the repo.** Both are deployed by pasting, and neither reports a version. The cron, the KV binding and the secrets exist only in the Cloudflare dashboard.
14. **Smaller items:**
    - `setupWeekButtons` adds another change listener every time it runs (app.js:2902).
    - Pull-to-refresh can fire during a normal scroll, because `startY` stays 0 (app.js:14019-14030).
    - Chart.js loads unpinned, with no SRI, and blocks rendering in `<head>`.
    - `startCountdownTimer` runs a 1-second interval for ever, aimed at `.game-lock-countdown`, which is never rendered.
    - `renderActiveTab` rebuilds the hidden Make Picks slate on every poll.
    - The spread-bucket key is built by hand in 8 places.
    - The Spreads tab's `data.spread || 0` could store a fake pick'em. The client currently prevents this.
    - The `/sync` kicked-off-line guard skips playoff weeks.
    - Android's `allowBackup="true"` copies the plaintext admin key into Google backup.
    - Public `/reminder-check` calls each make an uncached ESPN fetch plus an Apps Script read.

## What should be removed

- **The old spreadsheet path, which can no longer run.** `LEGACY_SHEETS_SEASON` is 2025 and `CURRENT_SEASON` can't return to it. That makes these dead:
  - `loadCSVData`
  - the CSV block in `setCurrentWeek`
  - `loadAllWeeklyDataForBlazin`
  - the `dashboardData` branches in `renderDashboard`
  - `WEEK_SHEET_GIDS`
  - `export2024SeasonData`
  - the worker's `/sheets` route

  That leaves `getSortedPickers` as the only thing in `parser.js` still used. Moving it into `app.js` would let you delete `parser.js` (1,070 lines) and the PapaParse CDN script. This replaces the prior review's advice to keep `parser.js`.
- **Functions that are never called:**
  - `setCurrentSeason` and `setupWeekButtonsForSeason`
  - `stopCountdownTimer` and `exportAllPicks`
  - `loadPicksFromGoogleSheets`
  - `renderPlayoffSimilarityRanking` and `setupOnboarding`
  - `setupExportImport` with `exportPicks` and `importPicks`
  - `resetAllPicks` and `copyPicksToClipboard`, which are wired to buttons that don't exist
  - `historical2024Loaded` and `historical2024Loading`
  - the `updateSpreadsFromAPI` wrapper
  - `isNFLGameDay`, which only a branch that never runs uses
- **The onboarding overlay** (index.html:886-931 and its CSS). It is never shown, and it advertises a "?" shortcut that doesn't exist.
- **About 65 CSS classes with no matching markup**, such as `pnl-*`, `podium-*`, `streak-*`, `history-game-card`, `randomize-picks-btn`, `season-stat*`, `skeleton-*` and `share-picks-container`. These came from a static text search, so check any class names the code builds dynamically before deleting.
- **`formatMoneyline` and the `h2h` odds market.** They were only kept for moneyline pricing, which was declined. Dropping `h2h` saves a third of the Odds API credits, but CLAUDE.md would need updating to match.
- **`calculateAndSaveOutcomes` and its three Outcome columns.** Nothing reads them (prior review's UI #5).
- **Stale docs:**
  - ROADMAP.md still lists the Live overlay, Hall of Shame, back-to-top, onboarding and "weeks 1-15".
  - FEATURES.md (dated December 2024) claims onboarding and keyboard shortcuts are done.
  - The worker's header comment (lines 12-25) describes the old fixed cache and leaves out NOTIFY_SECRET, FCM_SERVICE_ACCOUNT and the NOTIFY_STATE binding.
  - `cloudflare-worker/README.md` leaves out `/espn` and `/reminder-check`.
  - `android/README.md` still mentions the Weekly Recap.
  - The comment at index.html:953 says `historical-2024.js` is lazy-loaded.
  - The worker has orphaned and duplicate docblocks at 412-414 and 691-692.
- **Repo clutter:**
  - The local `master` branch is stale at `ddc021d`, so a stray `git push origin master` would be risky.
  - `brag-output/` (56 MB) is untracked and not in `.gitignore`.
  - The `check-dylan-*.js` files are local only and safe to delete. `blazin-5.png` is in use, so keep it.

One finding was dropped: the live-site pass reported the Cowherd entry form and the admin buttons as visible to everyone. It only saw them because it chose Stephen as the picker. Those tools appear for whoever picks Stephen, which is the known trade-off of having no logins.

## What could be added

- **Winnings in the main standings.** Right now the dollar figure only appears inside Insights.
- **A picks reveal after kickoff:** a grid of everyone's Blazin' 5 for the week. The Live tab may already cover this; it couldn't be checked because the tab is hidden on a Tuesday.
- **A head-to-head comparison or agreement matrix across the season**, built from the existing `calculatePlayoffAgreement`. This is ROADMAP #16.
- **"Games back", a weekly-winner badge carried into History, and a seasons or games column on Lifetime standings.** Lifetime ranks a picker with 483 picks against one with 1,298 by percentage alone.
- **One-line "?" explanations** for B5, Lock, ATS vs Straight Up and Year Chg (ROADMAP #6).
- **"Updated at hh:mm"** next to lines and scores (ROADMAP #27).
- **Recompute the week, or reload, when the page is resumed** (fixes item 5 above).
- **Load Chart.js after the page renders**, and pin its version.
- **An `escapeHtml` helper** for ESPN strings and the inline `onerror` handlers.
- **A `version` answer from the worker (`GET /`) and the Apps Script**, so checking a deploy is a single curl that writes nothing and spends no credits.
- **A `wrangler.toml` with no secrets in it**, recording the cron, the KV binding and the variable names.
- **A Cloudflare rate-limit rule on `/sync` and `/reminder-check`**, and have `/reminder-check` read through the `/espn` edge cache.
- **Tests for the Apps Script `{error}` reply, duplicate ClearedPicks rows, and a playoff-week `/sync`.**
- **A weekly cron check on the Backup tab's size**, with past seasons moved to a "Backup YYYY" tab. That keeps the sheet append-only.

## Not checked

- The Live tab during games, since it's hidden on a Tuesday.
- The Android app on a device.
- Polling during a game.
- Whether the deployed worker and Apps Script match the repo.
- Whether Apps Script failures in production come back as JSON or as an HTML page. Only JSON triggers item 4.
