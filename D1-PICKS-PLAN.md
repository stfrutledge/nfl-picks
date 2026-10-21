# Plan: store picks in Cloudflare D1

Status: **proposed** (October 2026). Nothing here is built yet.

## Why

Every pick today goes phone → worker → Apps Script → the Backup sheet, and
every read comes back the same way. The Apps Script is the slow and fragile
link:

- **Slow.** A write takes 2-8s and sometimes 30s, on a ~2s fixed floor.
  Reading every pick for the season (`allpicks`) is the longest wait on page
  load: the picks arrive about 5s in, and the list redraws when they do.
- **Fragile.** It is behind the lost-pick work: the Thursday close-the-app
  case, keepalive sends, `waitUntil` on `/sync`, and the retry queue. Each of
  those works around a write that takes seconds.
- **Quota-bound.** Apps Script has daily execution quotas and answers its own
  errors with an HTTP 200.

D1 is Cloudflare's SQLite database, bound to the worker that already sits in
the path of every pick. A read or write takes tens of milliseconds, from the
same data centre as the worker.

**Cost: free.** The free tier is 100,000 rows written and 5,000,000 rows read
a day, and 5 GB stored.

- **Writes:** a whole-week snapshot is about 16 rows. Five pickers syncing 30
  times a day is about 2,400 rows.
- **Reads:** a page load reads the season's rows, about 4,000 by the end of a
  season. That is about 1,250 page loads a day before the read limit is
  reached.

## What stays the same

- **The site.** It keeps calling the same worker endpoints and gets the same
  response shape: `POST /sync` with `{week, picker, picks, cleared}`,
  `GET /sync?action=allpicks|picks`. If the plan holds, `app.js` needs no
  change at all for the cut-over.
- **The rules.** The worker runs the Apps Script's reader logic unchanged:
  - `foldPickRow`, where rows in the same sync batch merge, a newer batch
    replaces an older one, a freeze is final, and an `unlocked ` marker beats
    an older lock;
  - season-prefixed week keys (`2026_7`);
  - the cleared flag.
- **The Google Sheet.** It stays, as a mirror. Every write still reaches it,
  in the background, so its history, the manual corrections made there, and
  its use as a fallback all carry on. Phones stop waiting on it.
- **Everything else on the sheet:** results, spreads, splits and cleared
  status. Moving those is a possible later step and not part of this plan.

## Design

### Tables

```sql
-- One row per pick per sync: the same append-only log as the Backup sheet,
-- so history, forensics and the fold rules carry over exactly.
CREATE TABLE IF NOT EXISTS pick_rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,        -- ISO time of the sync batch
  season      INTEGER NOT NULL,     -- 2026
  week        TEXT NOT NULL,        -- '2026_7' (sheet form)
  picker      TEXT NOT NULL,
  game_key    TEXT NOT NULL,        -- 'packers_lions' (lowercased away_home)
  game_id     TEXT,
  away        TEXT, home TEXT,
  away_spread TEXT, home_spread TEXT,
  line_pick   TEXT, winner_pick TEXT,
  blazin      INTEGER NOT NULL DEFAULT 0,
  over_under  TEXT, total_line TEXT,
  frozen_at   TEXT
);
CREATE INDEX IF NOT EXISTS pick_rows_season ON pick_rows (season, week, picker, game_key, ts);

CREATE TABLE IF NOT EXISTS cleared (
  week TEXT NOT NULL, picker TEXT NOT NULL, cleared INTEGER NOT NULL, ts TEXT NOT NULL,
  PRIMARY KEY (week, picker)
);
```

The worker creates the tables itself on first use, so there is no SQL to run
by hand. The sheet's three outcome columns are not stored, because the site
grades every pick itself (`gradedPicks`) and never reads them.

### Write: `POST /sync` with picks

1. Insert the batch into `pick_rows` with one timestamp, as `savePicks` does.
   The cleared flag is upserted the same way.
2. Answer the phone as soon as D1 has the rows.
3. Under `ctx.waitUntil`, forward the same payload to the Apps Script, so the
   sheet still gets the row. This is the existing `forwardSyncPost`.
4. If the forward fails, the payload is kept in KV (`mirror:pending`) and
   retried by the 15-minute cron until it lands, like `splits:pending` today.
   A D1 write the sheet never saw cannot be lost.

The kicked-off-game guard on spreads (`withoutKickedOffLines`) is unchanged.
Spreads are not part of this plan.

### Read: `GET /sync?action=allpicks|picks`

Reads are served from D1 only when the worker variable `PICKS_READ=d1` is set.
Otherwise they come from the Apps Script as today. That variable is the
cut-over switch and the rollback.

From D1, the worker selects the season's rows ordered by `ts` and folds them
with the ported `foldPickRow` / `pickPayload`. The response has the same JSON
shape as the Apps Script's `getAllPicks`: `{picks, cleared, weekCount, …}`.

### Reminder job

`scoreboardForAutomations` and the reminder check call `appsScriptGet(...
'allpicks' / 'picks')`. Behind the same switch, they read D1 instead. That
removes the cron's dependence on the Apps Script for reminders and for
Blazin' 5 results. It also avoids the 200-with-error case, which once would
have reminded everyone of every game.

### Moving the existing picks in

The sheet holds every pick back to 2025, about 2,000+ rows. Two options:

- **A (preferred): the raw rows, so the history and the fold come out
  identical.** It needs one new read-only Apps Script action,
  `action=backuprows&season=YYYY`, which returns the Backup tab's rows as they
  are. That means **one Google paste and redeploy**. A worker admin endpoint,
  `POST /admin/import-picks` behind the existing admin token, copies them into
  D1 in batches. It can safely be re-run, because it skips rows already
  imported, matched by timestamp + week + picker + game.
- **B: no Google paste.** Import the folded `allpicks` result as one batch per
  week. This loses the row history from D1, though the sheet still has it.

### Proving it before the switch

For about a week, phones write to both and still read from the sheet.

- `GET /admin/compare-picks?season=2026` folds D1 and asks the Apps Script for
  `allpicks`. It returns any difference, game by game: picker, week, game and
  both values.
- The cron runs the same comparison daily. A mismatch is logged and sent as an
  admin-only push, like the existing failing-automations alert.
- The switch to `PICKS_READ=d1` happens only after several clean days that
  include a Thursday-to-Monday slate, the period with the most writes and
  locks.

## Steps

| # | Who | What |
|---|---|---|
| 1 | You | Cloudflare dashboard → Storage & Databases → D1 → **Create** `nfl-picks`. Then Worker → Settings → Bindings → **Add D1**, variable name `PICKS_DB`. About 5 minutes. |
| 2 | Me | Worker: D1 module (tables, insert, fold, cleared), the dual write with KV-queued mirroring, the `PICKS_READ` switch, the admin import and compare endpoints, and the cron comparison and alert. Tests against an in-memory D1 stand-in, including the existing fold cases from `test-sheet-reader.js` run against the worker's copy. |
| 3 | Me | Apps Script: the read-only `backuprows` action (option A). |
| 4 | You | Paste the worker into **Cloudflare**, and the Apps Script into **Google** (redeploy as a new version). |
| 5 | Me | Run the import, then the comparison. Report the diffs (expected: none). |
| 6 | Both | A week of side-by-side running. I check the daily comparison. |
| 7 | You | Set the worker variable `PICKS_READ` = `d1` (Settings → Variables). Picks now load from D1. |
| 8 | Me | Confirm load times and that saves land, then update CLAUDE.md. Rollback is deleting that variable. |

## Risks and answers

- **Picks lost in the move.** The sheet is never written less than today. D1
  is added beside it, and reads switch only after a clean comparison. Rollback
  is one variable.
- **D1 and the sheet disagree.** The daily comparison catches it, and the
  admin push says so. The sheet stays the source of record until the switch.
- **The fold logic forks.** The worker's copy is tested against the same cases
  as the Apps Script's copy (`test-sheet-reader.js`). After the switch the
  Apps Script copy is only used as a fallback.
- **Manual corrections in the sheet.** These are edits made directly in the
  sheet, which D1 would not see. Until the switch they don't matter. After it,
  a correction should go through the site or the admin tools. Alternatively,
  an admin "re-import week N from sheet" action can be added; I'd add it.
- **Free-tier limits.** These are far above what the group uses. The read cost
  grows with the season's row count, and if it ever matters, a folded
  `current_picks` table can be kept alongside the log.

## Open question for you

Option A (one Google paste, exact history in D1) or option B (no Google paste,
D1 history starts at the move)? I recommend A.
