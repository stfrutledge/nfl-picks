# NFL Picks Proxy - Cloudflare Worker

`nfl-picks-proxy.js` is the one worker the app talks to, deployed at
`https://nfl-picks-proxy.stfrutledge.workers.dev` (`WORKER_PROXY_URL` in `app.js`).
It exists so that no secret and no cross-origin request lives in the browser:

- `/odds` - The Odds API, with the API key held server-side and one shared cache.
- `/sheets` - Google Sheets CSV exports. Only `https://docs.google.com/spreadsheets/...` is accepted.
- `/sync` - the Google Apps Script web app that backs picks, results and spreads up to the sheet.
- `/notify` - a message from the admin to every phone with the Android app, through Firebase Cloud Messaging. POST `{ title, body }` with `Authorization: Bearer <NOTIFY_SECRET>`. See `android/README.md`.

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
  `calculateStatsForWeeks`.
- **Pick reminders** (`pick_reminders`): at noon Irish time on the day of a
  midweek opener (Thursday Night Football; that night's games only), and one
  reminder 3 hours before the first weekend kickoff (everything left, plus
  Blazin' 5 picks to make), worded per picker, for those with picks to make.

Everything is sent data-only; each phone decides what to show and when (the
app's categories, quiet hours and spoiler-free setting). It needs, besides the
variables above:

| Setting | Where | Value |
|---|---|---|
| KV namespace binding `NOTIFY_STATE` | **Settings** > **Bindings** | a KV namespace (e.g. `nfl-picks-notify`): records what has been sent, so nothing goes twice |
| Cron trigger | **Settings** > **Trigger events** | `*/15 * * * *` |

Without the binding the schedule does nothing. A quiet day costs one ESPN call
and a couple of KV reads; the sheet is only read when something could be due.

Redeploying the Apps Script to a new URL means updating `APPS_SCRIPT_URL` here.

## Testing

Run `node test-worker-guards.js` from the repo root. It runs the whole worker
against a fake cache and network.

**Don't call `/odds` by hand to test things.** A cache miss spends real
credits: three a fetch, from a free tier of 500 a month. How the cache paces
those credits across the month is covered in the repo's `CLAUDE.md`, under
"Odds API budget".
