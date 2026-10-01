# NFL Picks Proxy - Cloudflare Worker

`nfl-picks-proxy.js` is the one worker the app talks to, deployed at
`https://nfl-picks-proxy.stfrutledge.workers.dev` (`WORKER_PROXY_URL` in `app.js`).
It exists so that no secret and no cross-origin request lives in the browser:

- `/odds` - The Odds API, with the API key held server-side and one shared cache.
- `/sheets` - Google Sheets CSV exports. Only `https://docs.google.com/spreadsheets/...` is accepted.
- `/sync` - the Google Apps Script web app that backs picks, results and spreads up to the sheet.

## Deploying

The repo copy is the source of record, not the running code: editing
`nfl-picks-proxy.js` changes nothing until it is pasted into the worker.

1. https://dash.cloudflare.com > **Workers & Pages** > `nfl-picks-proxy` > **Edit Code**.
2. Replace the code with the contents of `nfl-picks-proxy.js` and **Deploy**.

The worker needs two environment variables (**Settings** > **Variables**, both encrypted):

| Variable | Value |
|---|---|
| `ODDS_API_KEY` | key from https://the-odds-api.com |
| `APPS_SCRIPT_URL` | the Apps Script web app's deployment URL |

Redeploying the Apps Script to a new URL means updating `APPS_SCRIPT_URL` here.

## Testing

Run `node test-worker-guards.js` from the repo root. It runs the whole worker
against a fake cache and network.

**Don't call `/odds` by hand to test things.** A cache miss spends real
credits: three a fetch, from a free tier of 500 a month. How the cache paces
those credits across the month is covered in the repo's `CLAUDE.md`, under
"Odds API budget".
