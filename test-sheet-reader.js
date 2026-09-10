// Tests for the Backup-sheet read path in google-apps-script-simple.js.
// Runs the Apps Script source in Node against a stubbed SpreadsheetApp.
//
// The bug these guard: the Backup sheet is append-only, and before the client
// stored every field under one matchup key a game's line pick and its Blazin' 5
// star were synced as TWO rows in the same batch. Collapsing by overwrite
// dropped whichever half lost - always the star. savePicks() stamps one
// timestamp per sync, so a newest-wins rule cannot separate same-batch rows
// either; they have to merge.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HEADER = ['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team',
    'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin',
    'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome'];

/**
 * A sheet stub that records writes, so savePicks can be observed.
 * Rows are shared with the caller, so an upsert is visible in place.
 */
function writableSheet(rows) {
    return {
        getDataRange: () => ({ getValues: () => rows }),
        getRange: (row, col, numRows, numCols) => ({
            setValues: vals => {
                // 1-indexed row, and only whole-row writes are used here.
                if (col === 1 && numCols >= 17) rows[row - 1] = vals[0].slice();
            },
            setValue() {},
            setFontWeight() {},
            getValues: () => [rows[row - 1] ? rows[row - 1].slice(col - 1, col - 1 + numCols) : []]
        }),
        appendRow: vals => rows.push(vals.slice())
    };
}

function loadWritable(rows) {
    const sheet = writableSheet(rows);
    const SpreadsheetApp = {
        getActiveSpreadsheet: () => ({
            getSheetByName: name => (name === 'Backup' ? sheet : null),
            insertSheet: () => sheet
        })
    };
    const src = fs.readFileSync(path.join(__dirname, 'google-apps-script-simple.js'), 'utf8');
    return new Function('SpreadsheetApp', 'ContentService', 'Logger',
        src + ';return { savePicks, getAllPicks };')(SpreadsheetApp,
        { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
        { log() {} });
}

function load(sheets) {
    const SpreadsheetApp = {
        getActiveSpreadsheet: () => ({
            getSheetByName: name => {
                const rows = sheets[name];
                if (!rows) return null;
                return {
                    getDataRange: () => ({ getValues: () => rows }),
                    getRange: () => ({ setValues() {}, setValue() {}, setFontWeight() {}, getValues: () => [[]] }),
                    appendRow() {}
                };
            },
            insertSheet: () => ({
                getDataRange: () => ({ getValues: () => [] }),
                getRange: () => ({ setValues() {}, setValue() {}, setFontWeight() {}, getValues: () => [[]] }),
                appendRow() {}
            })
        })
    };
    const src = fs.readFileSync(path.join(__dirname, 'google-apps-script-simple.js'), 'utf8');
    const exports = `;return { getAllPicks, getPicksForWeek, diagnoseBackup, seasonOfSheetWeek };`;
    return new Function('SpreadsheetApp', 'ContentService', 'Logger',
        src + exports)(SpreadsheetApp,
        { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
        { log() {} });
}

// One sync batch shares a single timestamp - that is what savePicks() writes.
const BATCH_1 = '2026-09-07T17:00:00.000Z';
const BATCH_2 = '2026-09-07T18:30:00.000Z';

function row(ts, week, picker, game, away, home, line, winner, blazin) {
    return [ts, week, picker, game, away, home, 1.5, -1.5, line || '', winner || '',
        blazin ? 'Yes' : '', '', '', '', '', ''];
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('Split rows from one sync batch must merge, not overwrite');

check("a star on a numeric Game row survives alongside its partner's line pick", () => {
    const api = load({
        Backup: [HEADER,
            // The legacy shape: star under the positional id, line under the matchup key.
            row(BATCH_1, '2026_1', 'Dylan', '1', 'Rams', 'Seahawks', '', '', true),
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false)
        ]
    });
    const pick = api.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.strictEqual(pick.line, 'home', 'line pick must survive');
    assert.strictEqual(pick.winner, 'home', 'winner pick must survive');
    assert.strictEqual(pick.blazin, true, 'the star must survive the collapse');
});

check('row order within the batch does not change the result', () => {
    const flipped = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false),
            row(BATCH_1, '2026_1', 'Dylan', '1', 'Rams', 'Seahawks', '', '', true)
        ]
    });
    const pick = flipped.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.strictEqual(pick.line, 'home');
    assert.strictEqual(pick.blazin, true);
});

check('getPicksForWeek collapses the same way as getAllPicks', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', '1', 'Rams', 'Seahawks', '', '', true),
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false)
        ]
    });
    const single = api.getPicksForWeek('2026_1', 'Dylan').picks.rams_seahawks;
    const all = api.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.deepStrictEqual(single, all, 'the two readers must not drift');
});

section('A later sync batch still supersedes an earlier one');

check('un-starring in a later batch is not undone by the merge', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', true),
            row(BATCH_2, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false)
        ]
    });
    const pick = api.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.strictEqual(pick.blazin, false, 'the newest batch wins - the star was removed');
});

check('a blanked pick in a later batch stays blank', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false),
            row(BATCH_2, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', '', '', false)
        ]
    });
    const pick = api.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.strictEqual(pick.line, '', 'a deselection must not be re-filled from an older row');
});

check('an older split batch does not resurrect a star removed later', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', '1', 'Rams', 'Seahawks', '', '', true),
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false),
            row(BATCH_2, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false)
        ]
    });
    const pick = api.getAllPicks().picks['2026_1'].Dylan.rams_seahawks;
    assert.strictEqual(pick.blazin, false);
});

section('Season filtering happens server-side');

check('season=2026 returns only prefixed weeks', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '18', 'Stephen', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', '', false),
            row(BATCH_1, '2026_1', 'Stephen', 'bills_chiefs', 'Bills', 'Chiefs', 'Chiefs', '', false)
        ]
    });
    const res = api.getAllPicks(2026);
    assert.deepStrictEqual(Object.keys(res.picks), ['2026_1']);
    assert.strictEqual(res.rowsScanned, 2);
    assert.strictEqual(res.rowsUsed, 1, 'the 2025 row must not be built into the payload');
});

check('bare week numbers are treated as the legacy season', () => {
    const api = load({ Backup: [HEADER] });
    assert.strictEqual(api.seasonOfSheetWeek('18'), 2025);
    assert.strictEqual(api.seasonOfSheetWeek('2026_1'), 2026);
    assert.strictEqual(api.seasonOfSheetWeek('2027_12'), 2027);
});

check('no season argument still returns everything (back-compatible)', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '18', 'Stephen', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', '', false),
            row(BATCH_1, '2026_1', 'Stephen', 'bills_chiefs', 'Bills', 'Chiefs', 'Chiefs', '', false)
        ]
    });
    assert.deepStrictEqual(Object.keys(api.getAllPicks().picks).sort(), ['18', '2026_1']);
});

check('cleared flags are filtered by season too', () => {
    const api = load({
        Backup: [HEADER],
        ClearedPicks: [['Week', 'Picker', 'Cleared', 'Timestamp'],
            ['18', 'Stephen', 'Yes', BATCH_1],
            ['2026_1', 'Dylan', 'Yes', BATCH_1]]
    });
    assert.deepStrictEqual(api.getAllPicks(2026).cleared, { '2026_1': { Dylan: true } });
});

section('savePicks keeps one row per pick');

// It used to append, so the whole-week snapshot added 16 rows per edit and
// every read pulled the lot through getDataRange(). Upserting bounds the
// sheet at one row per week/picker/game.

check('a repeated sync updates in place instead of appending', () => {
    const rows = [HEADER.slice()];
    const api = loadWritable(rows);
    const pick = {
        gameId: 'rams_seahawks', away: 'Rams', home: 'Seahawks',
        awaySpread: 3, homeSpread: -3, linePick: 'Seahawks', winnerPick: 'Seahawks'
    };

    api.savePicks('2026_5', 'Stephen', [pick]);
    assert.strictEqual(rows.length, 2, 'header plus one pick');

    api.savePicks('2026_5', 'Stephen', [pick]);
    assert.strictEqual(rows.length, 2, 'still one row, updated in place');
});

check('a changed pick overwrites its own row', () => {
    const rows = [HEADER.slice()];
    const api = loadWritable(rows);

    api.savePicks('2026_5', 'Stephen', [{
        gameId: 'rams_seahawks', away: 'Rams', home: 'Seahawks',
        awaySpread: 3, homeSpread: -3, linePick: 'Seahawks', winnerPick: 'Seahawks'
    }]);
    api.savePicks('2026_5', 'Stephen', [{
        gameId: 'rams_seahawks', away: 'Rams', home: 'Seahawks',
        awaySpread: 3, homeSpread: -3, linePick: 'Rams', winnerPick: 'Rams'
    }]);

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1][8], 'Rams', 'the row now holds the new pick');
});

check('different pickers and games get their own rows', () => {
    const rows = [HEADER.slice()];
    const api = loadWritable(rows);
    const mk = id => ({ gameId: id, away: 'A', home: 'B', awaySpread: 1, homeSpread: -1 });

    api.savePicks('2026_5', 'Stephen', [mk('a_b'), mk('c_d')]);
    api.savePicks('2026_5', 'Dylan', [mk('a_b')]);
    api.savePicks('2026_6', 'Stephen', [mk('a_b')]);

    assert.strictEqual(rows.length, 5, 'header + 4 distinct picks');
});

check('outcomes already written are not wiped by a re-sync', () => {
    // calculateAndSaveOutcomes fills columns 14-16 separately.
    const rows = [HEADER.slice()];
    const api = loadWritable(rows);
    const pick = { gameId: 'rams_seahawks', away: 'Rams', home: 'Seahawks',
        awaySpread: 3, homeSpread: -3, linePick: 'Seahawks' };

    api.savePicks('2026_5', 'Stephen', [pick]);
    rows[1][13] = 'push';   // Line Outcome, set by the results pass
    api.savePicks('2026_5', 'Stephen', [pick]);

    assert.strictEqual(rows[1][13], 'push', 'the outcome survived');
});

section('Diagnostics report the raw rows');

check('orphaned blazin rows are counted and listed', () => {
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Dylan', '1', 'Rams', 'Seahawks', '', '', true),
            row(BATCH_1, '2026_1', 'Dylan', 'rams_seahawks', 'Rams', 'Seahawks', 'Seahawks', 'Seahawks', false),
            row(BATCH_1, '18', 'Stephen', 'bills_chiefs', 'Bills', 'Chiefs', 'Chiefs', '', false)
        ]
    });
    const d = api.diagnoseBackup();
    assert.strictEqual(d.totalRows, 3);
    assert.deepStrictEqual(d.rowsBySeason, { 2025: 1, 2026: 2 });
    assert.strictEqual(d.numericGameRows, 1);
    assert.strictEqual(d.orphanedBlazinCount, 1);
    assert.strictEqual(d.orphanedBlazinRows[0].picker, 'Dylan');
    assert.strictEqual(d.orphanedBlazinRows[0].matchup, 'rams_seahawks');
});

check('a numeric row that carries its own line pick is not an orphan', () => {
    // Quick Picks used to write line+winner+star together under the id key.
    // That row is self-contained, so nothing was ever dropped for it.
    const api = load({
        Backup: [HEADER,
            row(BATCH_1, '2026_1', 'Jason', '2', 'Bills', 'Chiefs', 'Chiefs', 'Chiefs', true)
        ]
    });
    const d = api.diagnoseBackup();
    assert.strictEqual(d.numericGameRows, 1);
    assert.strictEqual(d.orphanedBlazinCount, 0, 'it had its own line pick');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
