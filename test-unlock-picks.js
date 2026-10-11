// Tests for unlocking picks (admin) and the picker's name in the lock dialogs.
//
// A lock is final for players, so a card locked under the wrong picker - a
// shared phone with someone else still selected - needs an admin way back.
// The hard part is the sheet: foldPickRow gives a frozen row precedence over
// any later row without a freeze, so an unlock has to be written in a way the
// reader lets beat the lock, and the lock must not come back on the next load.
//
// Every round trip runs through two readers: the Apps Script in this repo, and
// the one deployed before unlocks existed (isUnlockCell always false), since
// the client ships the moment it is pushed and the script only when redeployed.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

// Inside 2026 week 5, the week these tests pick in.
const TEST_NOW = '2026-10-07T16:00:00Z';

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
const SHEET = fs.readFileSync(path.join(__dirname, 'google-apps-script-simple.js'), 'utf8');

/* ------------------------------------------------------------------ app.js */

function makeAppEnv() {
    const store = new Map();
    const posts = [];
    const prompts = [];
    const env = {
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k),
            key: i => Array.from(store.keys())[i] || null,
            get length() { return store.size; }
        },
        document: {
            addEventListener: () => {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : null;
            if (body) posts.push(body);
            return { ok: true, json: async () => ({ success: true }), text: async () => '{"success":true}' };
        },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {},
        // No modal markup, so requestConfirmation falls back to confirm().
        confirm: msg => { prompts.push(String(msg)); return true; },
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    env.globalThis = env;

    const snapshot = `
        const HISTORICAL_DATA_SEASON = 2026;
        const HISTORICAL_GAMES = {};
        const HISTORICAL_RESULTS = {};
        const HISTORICAL_PICKS = {};
    `;
    const exports = `;backupMergedOnce = true;
    const TEST_TOASTS = [];
    showToast = (m, t) => TEST_TOASTS.push({ message: m, type: t });
    return ({
        UNLOCK_MARKER, CURRENT_SEASON,
        freezeGameByKey, freezeAllCompleteGames, applyFreeze, applyUnfreeze,
        unlockPicks, lockedPicksForWeek, appLockedPicks, appUnlockPicks, fromSheetPick, isPickFrozen, lineForPick,
        atsWinnerForPick, syncPicksToGoogleSheets, pickKey,
        NFL_GAMES_BY_WEEK,
        __toasts: () => TEST_TOASTS,
        __state: () => ({ allPicks }),
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date',
        PARSER + '\n' + snapshot + '\n' + APP + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia, fixedClock(TEST_NOW));
    return { api, posts, prompts };
}

// Home favoured by 3 unless overridden.
function game(id, away, home, extra = {}) {
    return { id, away, home, spread: 3, favorite: 'home', day: 'Sun', time: '1:00 PM',
        kickoff: '2099-01-01T18:00:00Z', ...extra };
}

function sixGames() {
    return [
        game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs'), game(3, 'Jets', 'Dolphins'),
        game(4, 'Bears', 'Packers'), game(5, 'Giants', 'Eagles'), game(6, 'Saints', 'Falcons')
    ];
}

const WEEK = 5;
const complete = extra => ({ line: 'home', winner: 'home', ...extra });

function setup({ picker = 'Stephen', picks = {} } = {}) {
    const h = makeAppEnv();
    h.games = sixGames();
    h.api.NFL_GAMES_BY_WEEK[WEEK] = h.games;
    h.api.__setState({
        currentWeek: WEEK, currentPicker: picker,
        allPicks: { [WEEK]: { [picker]: { ...picks } } }
    });
    return h;
}

/* ------------------------------------------ google-apps-script-simple.js */

const HEADER = ['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team',
    'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin',
    'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome', 'Frozen At'];

function sheetRowFor(payload, pick, timestamp) {
    return [timestamp, payload.week, payload.picker, pick.gameId, pick.away || '',
        pick.home || '', pick.awaySpread || '', pick.homeSpread || '',
        pick.linePick || '', pick.winnerPick || '', pick.blazin ? 'Yes' : '',
        pick.overUnder || '', pick.totalLine || '', '', '', '', pick.frozenAt || ''];
}

/** The Apps Script reader. `deployed` is the pre-unlock version. */
function loadSheet(rows, { deployed = false } = {}) {
    const SpreadsheetApp = {
        getActiveSpreadsheet: () => ({
            getSheetByName: name => (name === 'Backup' ? {
                getDataRange: () => ({ getValues: () => rows }),
                getRange: () => ({ setValues() {}, setValue() {}, setFontWeight() {}, getValues: () => [[]] }),
                appendRow() {}
            } : null)
        })
    };
    const override = deployed ? 'isUnlockCell = function () { return false; };' : '';
    return new Function('SpreadsheetApp', 'ContentService', 'Logger',
        SHEET + ';' + override + 'return { getAllPicks };')(
        SpreadsheetApp,
        { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
        { log() {} });
}

/** Every sync the harness sent, as Backup rows a minute apart. */
function rowsFrom(posts) {
    const rows = [HEADER];
    posts.forEach((payload, i) => payload.picks.forEach(pick => {
        rows.push(sheetRowFor(payload, pick, new Date(Date.UTC(2026, 9, 7, 10, i)).toISOString()));
    }));
    return rows;
}

/** One picker's week as the client would hold it after reading the sheet. */
function readBack(posts, picker, opts) {
    const week = loadSheet(rowsFrom(posts), opts).getAllPicks(2026).picks[`2026_${WEEK}`];
    const h = makeAppEnv();
    const out = {};
    for (const [key, pick] of Object.entries(week[picker] || {})) out[key] = h.api.fromSheetPick(pick);
    return out;
}

const sync = h => h.api.syncPicksToGoogleSheets(false, h.picker || 'Stephen', WEEK);

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('The lock dialog names the picker');

await check('locking one game asks about that picker by name', async () => {
    const h = setup({ picker: 'Daniel', picks: { rams_seahawks: complete() } });
    h.api.freezeGameByKey('rams_seahawks');
    assert.strictEqual(h.prompts.length, 1, 'asked once');
    assert.ok(h.prompts[0].startsWith("Lock Daniel's pick: Rams @ Seahawks at Seahawks -3?"),
        h.prompts[0]);
});

await check('Lock All Picks names the picker too', async () => {
    const picks = {};
    sixGames().slice(0, 5).forEach(g => { picks[`${g.away}_${g.home}`.toLowerCase()] = complete({ blazin: true }); });
    const h = setup({ picker: 'Sean', picks });
    h.api.freezeAllCompleteGames();
    assert.strictEqual(h.prompts.length, 1, 'asked once');
    assert.ok(h.prompts[0].includes("of Sean's"), h.prompts[0]);
});

section('Unlocking puts a pick back to riding the line');

await check('the picks are kept and the frozen line goes', async () => {
    const h = setup({ picks: { rams_seahawks: complete({ blazin: true }) } });
    h.api.applyFreeze(h.games[0]);
    h.games[0].spread = 6.5; // the line moves after the lock
    const result = h.api.appUnlockPicks('Stephen', ['rams_seahawks'], WEEK);
    assert.deepStrictEqual(result, { ok: true, message: "Unlocked Stephen's pick." });

    const pick = h.api.__state().allPicks[WEEK].Stephen.rams_seahawks;
    assert.strictEqual(h.api.isPickFrozen(pick), false);
    assert.strictEqual(pick.line, 'home');
    assert.strictEqual(pick.winner, 'home');
    assert.strictEqual(pick.blazin, true, 'the star survives');
    assert.strictEqual(h.api.lineForPick(h.games[0], pick).spread, 6.5, 'graded at the current line');
    assert.strictEqual(h.prompts.length, 0, 'the app asks natively, the page does not');
});

await check('the panel lists locked picks by picker, and not unlocked ones', async () => {
    const h = setup({ picks: { rams_seahawks: complete(), bills_chiefs: complete() } });
    h.api.__state().allPicks[WEEK].Jason = { jets_dolphins: complete() };
    h.api.applyFreeze(h.games[0], WEEK, 'Stephen');
    h.api.applyFreeze(h.games[1], WEEK, 'Stephen');
    h.api.applyFreeze(h.games[2], WEEK, 'Jason');
    h.api.applyUnfreeze(h.games[1], WEEK, 'Stephen');

    const groups = h.api.lockedPicksForWeek(WEEK);
    assert.deepStrictEqual(groups.map(g => [g.picker, g.locked.map(e => h.api.pickKey(e.game))]),
        [['Jason', ['jets_dolphins']], ['Stephen', ['rams_seahawks']]]);
});

await check('the app gets the locked list as plain data, with the picker’s own line', async () => {
    const h = setup({ picks: { rams_seahawks: complete({ line: 'away' }) } });
    h.api.applyFreeze(h.games[0]);
    assert.deepStrictEqual(h.api.appLockedPicks(), {
        week: WEEK, weekLabel: 'Week 5', historical: false,
        pickers: [{ picker: 'Stephen', picks: [
            { key: 'rams_seahawks', game: 'Rams @ Seahawks', line: 'Rams +3', started: false }
        ] }]
    });
});

await check('unlocking something no longer locked says so rather than claiming success', async () => {
    const h = setup({ picks: { rams_seahawks: complete() } });
    assert.strictEqual(h.api.appUnlockPicks('Stephen', ['rams_seahawks'], WEEK).ok, false);
});

await check('the week the list was drawn for is the one unlocked', async () => {
    const h = setup({ picks: { rams_seahawks: complete() } });
    h.api.applyFreeze(h.games[0]);
    h.api.__setState({ currentWeek: WEEK + 1 }); // the page moved on behind Settings
    assert.strictEqual(h.api.appUnlockPicks('Stephen', ['rams_seahawks'], WEEK).ok, true);
    assert.strictEqual(h.api.isPickFrozen(h.api.__state().allPicks[WEEK].Stephen.rams_seahawks), false);
});

for (const deployed of [false, true]) {
    section(`Round trip through the ${deployed ? 'currently deployed' : 'updated'} Apps Script`);

    await check('an unlocked pick reads back unlocked, not locked again', async () => {
        const h = setup({ picks: { rams_seahawks: complete() } });
        h.api.applyFreeze(h.games[0]);
        await sync(h);
        h.api.applyUnfreeze(h.games[0], WEEK, 'Stephen');
        await sync(h);

        const pick = readBack(h.posts, 'Stephen', { deployed }).rams_seahawks;
        assert.strictEqual(h.api.isPickFrozen(pick), false, 'the lock stayed undone');
        assert.strictEqual(pick.line, 'home', 'the pick survived');
    });

    await check('a change made after unlocking is what reads back', async () => {
        const h = setup({ picks: { rams_seahawks: complete() } });
        h.api.applyFreeze(h.games[0]);
        await sync(h);
        h.api.applyUnfreeze(h.games[0], WEEK, 'Stephen');
        await sync(h);
        h.api.__state().allPicks[WEEK].Stephen.rams_seahawks.line = 'away';
        await sync(h);

        const pick = readBack(h.posts, 'Stephen', { deployed }).rams_seahawks;
        assert.strictEqual(pick.line, 'away');
        assert.strictEqual(h.api.isPickFrozen(pick), false);
    });

    await check('locking again after an unlock sticks', async () => {
        const h = setup({ picks: { rams_seahawks: complete() } });
        h.api.applyFreeze(h.games[0]);
        await sync(h);
        h.api.applyUnfreeze(h.games[0], WEEK, 'Stephen');
        await sync(h);
        h.games[0].spread = 4.5;
        h.api.applyFreeze(h.games[0]);
        await sync(h);

        const pick = readBack(h.posts, 'Stephen', { deployed }).rams_seahawks;
        assert.strictEqual(h.api.isPickFrozen(pick), true);
        assert.strictEqual(pick.frozenSpread, 4.5, 'at the new line');
    });

    await check('the other locked games in the week stay locked', async () => {
        const h = setup({ picks: { rams_seahawks: complete(), bills_chiefs: complete() } });
        h.api.applyFreeze(h.games[0]);
        h.api.applyFreeze(h.games[1]);
        await sync(h);
        h.api.applyUnfreeze(h.games[0], WEEK, 'Stephen');
        await sync(h);

        const week = readBack(h.posts, 'Stephen', { deployed });
        assert.strictEqual(h.api.isPickFrozen(week.rams_seahawks), false);
        assert.strictEqual(h.api.isPickFrozen(week.bills_chiefs), true);
    });
}

section('The deployed script only');

await check('it hands the unlock back as a marker the client keeps', async () => {
    // The deployed reader treats the marker row as a freeze and returns it as
    // one. The client must turn that back into an unlock and keep it, so its
    // later rows for the game carry the marker and keep beating the lock.
    const h = setup({ picks: { rams_seahawks: complete() } });
    h.api.applyFreeze(h.games[0]);
    await sync(h);
    h.api.applyUnfreeze(h.games[0], WEEK, 'Stephen');
    await sync(h);
    const pick = readBack(h.posts, 'Stephen', { deployed: true }).rams_seahawks;
    assert.ok(pick.unlockedAt, 'the client keeps the unlock so later rows carry the marker');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
process.exit(0);

})();
