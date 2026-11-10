# NFL Picks Proxy - Cloudflare Worker

`nfl-picks-proxy.js` is the one worker the app talks to, deployed at
`https://nfl-picks-proxy.stfrutledge.workers.dev` (`WORKER_PROXY_URL` in `app.js`).
It exists so that no secret and no cross-origin request lives in the browser:

- `/odds` - The Odds API, with the API key held server-side and one shared cache.
- `/sheets` - Google Sheets CSV exports. Only `https://docs.google.com/spreadsheets/...` is accepted.
- `/sync` - the Google Apps Script web app that backs picks, results and spreads up to the sheet.
- `/splits` - public betting splits on the spread for upcoming NFL games: each side's handle % and bets % from Action Network's consensus (the JSON scoreboard its site reads), DraftKings (DK Network's splits page) and Circa (VSiN's). None has an official API: `parseActionNetworkSplits`, `parseDkSplits`, `parseVsinSplits`; cached 5 minutes. A source failing still returns the others, with `errors` naming it. The cron also writes each game's last splits before kickoff to the sheet's **Splits** tab (`recordFinalSplits`), outside the notifications health check.
- **The cron writes the site's lines**: DraftKings' spread and total for every game still to kick off, to the sheet's Spreads tab (`syncSheetLines`), on any change and at least every 2 hours. Phones only ask the Odds API (`/odds`) if that tab goes stale, which is the fallback when the cron cannot reach ESPN.
- `/lines?season=YYYY&week=N` - that week's line history: `{ open, games }`, a point each time DraftKings' spread or total moved, kept by the cron off ESPN's scoreboard (`recordLineMoves`). A week opens on the first run after the previous week's last Sunday game is final; a week whose Sunday night was missed starts with "first seen" points.
- `/espn-summary?event=<ESPN event id>` - one game's injuries (ESPN's own five as `players`, and each team's whole list off its roster as `all`, for the popup's "Show all"), each team's last five (with ESPN's week) and its passing/rushing/receiving leaders, trimmed from ESPN's game summary (`trimEspnSummary`, ~2 KB of ~110 KB) for the Game Details popup's Matchup and Players tabs. Tries `site.web.api.espn.com` when `site.api.espn.com` refuses; cached 15 minutes.
- `/guesses?season=YYYY&picker=NAME` (GET) and `/guesses` (POST) - Guess the Lines, one KV entry per picker per season (`guesses:<season>:<picker>`). `{ mode: "solo", season, week, picker, game, guess }` is taken only between the week's `open` and `close` on `/lines`, answers with DraftKings' line at that moment, and is final once made. `{ mode: "podcast", season, week, picker, game, you, sal, bill, line }` replaces one game's row, any time. `/lines` also carries `close`: the first run after the week before was played out (Monday night final).
- `/notify` - a message from the admin to every phone with the Android app, through Firebase Cloud Messaging. POST `{ title, body }` with `Authorization: Bearer <NOTIFY_SECRET>`. See `android/README.md`.
- `/admin/picks/import?season=YYYY` (POST), `/admin/picks/compare?season=YYYY`, `/admin/picks/status` - the picks database's admin tools, behind the same secret as `/notify` (`Authorization: Bearer <NOTIFY_SECRET>`). Import copies a season's Backup rows into D1, compare lists every pick D1 and the sheet disagree on, status shows the read switch, the queues and the last week's usage. See "Picks in D1" below.

## Picks in D1

With a D1 database bound as `PICKS_DB` (Settings > Bindings > D1), every picks save also goes into D1, and the cron keeps the two in step. The plan and its reasoning are in `D1-PICKS-PLAN.md`.

- **Before the switch** (no `PICKS_READ` variable): a save goes to the sheet exactly as before and the phone waits on it; D1 is written beside it at the same time. Reads come from the sheet.
- **After the switch** (`PICKS_READ` = `d1`): reads come from D1, and a save is answered once D1 has it; the sheet gets its copy in the background, and a copy that fails is queued (`mirror:pending` in KV) for the cron. Deleting the variable is the rollback.
- **D1 refusing** anything (a used-up free-plan limit included: the free plan refuses, it never bills) sends that request to the sheet, queues the save for D1 (`d1:pending`), and alerts the admin at most once an hour. The first cron run that finds D1 answering copies the queue in and says "Picks database back to normal".
- **Usage** is counted per day in D1 (`pick_usage`); half of a free limit (2.5M rows read or 50k written) alerts the admin once a day.
- **Reads come from `current_picks`**, each game's folded pick, kept up to date on every save, rather than folding the whole log on every page load. It is built for a season by the import, or by the cron for a season imported before the table existed, and checked against the log daily (`currentDrift` in the comparison; rebuilt if it ever differs).
- **The daily comparison** runs once a season has been imported (`imported:<season>` in `pick_meta`) and alerts on any difference.

The tables are created by the worker on first use; there is no SQL to run. `node test-worker-d1.js` runs the whole path against an in-memory SQLite.

## Deploying

The repo copy is the source of record, not the running code: editing
`nfl-picks-proxy.js` changes nothing until it is pasted into the worker.

1. https://dash.cloudflare.com > **Workers & Pages** > `nfl-picks-proxy` > **Edit Code**.
2. Replace the code with the contents of `nfl-picks-proxy.js` and **Deploy**.

The worker's environment variables (**Settings** > **Variables**, all encrypted):

| Variable | Value |
|---|---|
| `ODDS_API_KEY` | key from https://the-odds-api.com |
| `APPS_SCRIPT_URL` | the Apps Script web app's deployment URL |
| `FCM_SERVICE_ACCOUNT` | for `/notify`: the Firebase service account's whole JSON key |
| `NOTIFY_SECRET` | for `/notify`: the admin key, typed into the app's Settings on the admin's phone |

Without the last two, `/notify` answers 500 and sends nothing; everything else works.

## Automatic notifications (cron)

Every 15 minutes the worker's `scheduled` handler (`runAutomations`) checks
the current week on ESPN and, when something is due, reads the picks and lines
from the Apps Script and sends through FCM:

- **Blazin' 5 results** (`blazin_results`): once every starred game is final
  and nobody can still add a star. Graded by the worker's small copy of the
  site's rule; `test-worker-automations.js` fails if it disagrees with
  `calculateStatsForWeeks`. Each phone shows only its own picker's line: that
  week's record, the season's record and Blazin' 5 % (earlier weeks graded from
  the Results and Spreads tabs), and a pointer to the site for everyone else's.
  If the sheet cannot be read the week's record goes out without the season.
  A phone with no picker chosen shows the group line (everyone's record).
  While the current week has no stars yet, the Admin Settings test grades last week.
- **Pick reminders** (`pick_reminders`): at noon Irish time on the day of a
  midweek opener (Thursday Night Football; that night's games only), and one
  reminder 3 hours before the first weekend kickoff (everything left, plus
  Blazin' 5 picks to make), worded per picker, for those with picks to make.
  The group line, for a phone with no picker, names who still has picks to make.
  Both carry the `week`, so a tap opens the app on the right screen.

Everything is sent data-only; each phone decides what to show and when (the
app's categories, quiet hours and spoiler-free setting). It needs, besides the
variables above:

| Setting | Where | Value |
|---|---|---|
| KV namespace binding `NOTIFY_STATE` | **Settings** > **Bindings** | a KV namespace (e.g. `nfl-picks-notify`): records what has been sent, so nothing goes twice |
| Cron trigger | **Settings** > **Trigger events** | `*/15 * * * *` |

Without the binding the schedule does nothing. A quiet day costs one ESPN call
and a couple of KV reads; the sheet is only read when something could be due.

If ESPN refuses a run, it carries on with the week's schedule saved by the
last run that reached it (`board:current`): reminders still go, Blazin' 5
results wait. After an hour of failing runs the admin's phone alone gets a
"Notifications failing" message with the reason (`automations:failing`), and
the first clean run sends "Notifications working again". The reason is also
in **Observability** as `[automations] failed: ...`.

Redeploying the Apps Script to a new URL means updating `APPS_SCRIPT_URL` here.

## Testing

Run `node test-worker-guards.js` from the repo root. It runs the whole worker
against a fake cache and network.

**Don't call `/odds` by hand to test things.** A cache miss spends real
credits: three a fetch, from a free tier of 500 a month. How the cache paces
those credits across the month is covered in the repo's `CLAUDE.md`, under
"Odds API budget".
