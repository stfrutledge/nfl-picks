// Tests for what syncPicksToGoogleSheets sends. Runs app.js in Node with
// browser stubs and captures the payload instead of posting it.
//
// The bug these guard: the Backup sheet is append-only and its reader treats
// the newest sync batch as the client's full state for that week. A sync that
// only sent the games currently holding a pick left deselected games with no
// row in the newest batch, so the reader fell back to an older one and the
// pick returned on the next load. A sync now sends the whole week, blank where
// there is no pick, so a removal is recorded rather than merely omitted.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEAMS = [
    ['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins'], ['Bears', 'Packers']
];
const WEEK = 5;

function makeEnv() {
    const store = new Map();
    const sent = [];
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
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async (url, opts) => {
            sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
            return {
                ok: true,
                text: async () => JSON.stringify({ success: true }),
                json: async () => ({ success: true })
            };
        },
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {}, confirm: () => false,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    env.globalThis = env;

    const snapshot = `
        const HISTORICAL_DATA_SEASON = ${new Date().getMonth() >= 6
            ? new Date().getFullYear() : new Date().getFullYear() - 1};
        const HISTORICAL_GAMES = {};
        const HISTORICAL_RESULTS = {};
        const HISTORICAL_PICKS = {};
    `;
    const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const exports = `;return ({
        pickKey, syncPicksToGoogleSheets, NFL_GAMES_BY_WEEK,
        __setState: s => {
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
            if ('allPicks' in s) allPicks = s.allPicks;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, sent };
}

function setup({ picks = {}, games = TEAMS, week = WEEK } = {}) {
    const { api, sent } = makeEnv();
    api.NFL_GAMES_BY_WEEK[week] = games.map(([away, home], i) => ({
        id: i + 1, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM'
    }));
    api.__setState({
        currentWeek: week, currentPicker: 'Stephen',
        allPicks: { [week]: { Stephen: { ...picks } } }
    });
    return { api, sent };
}

const syncOf = sent => sent.find(r => String(r.url).includes('/sync') && r.body);

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok  ${name}`))
        .catch(e => { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); });
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('A sync sends the whole week, not just the picked games');

await check('games with no pick get a blank row', async () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home', winner: 'home' } } });
    await t.api.syncPicksToGoogleSheets(false);
    const body = syncOf(t.sent).body;
    assert.strictEqual(body.picks.length, TEAMS.length, 'one row per game in the week');
    const blank = body.picks.find(p => p.gameId === 'bills_chiefs');
    assert.strictEqual(blank.linePick, '', 'unpicked game must be sent blank');
    assert.strictEqual(blank.winnerPick, '');
    assert.strictEqual(blank.blazin, false);
});

await check('a picked game still carries its pick', async () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home', winner: 'away', blazin: true } } });
    await t.api.syncPicksToGoogleSheets(false);
    const row = syncOf(t.sent).body.picks.find(p => p.gameId === 'rams_seahawks');
    assert.strictEqual(row.linePick, 'Seahawks', 'home side resolves to the home team name');
    assert.strictEqual(row.winnerPick, 'Rams', 'away side resolves to the away team name');
    assert.strictEqual(row.blazin, true);
});

section('The deselection cases that used to send nothing at all');

await check('deselecting the last pick in a week still syncs', async () => {
    // The whole week is empty - previously an early return skipped the sync
    // entirely, so the backup kept every pick and restored them on reload.
    const t = setup({ picks: {} });
    await t.api.syncPicksToGoogleSheets(false);
    const sync = syncOf(t.sent);
    assert.ok(sync, 'a sync must still be sent for an emptied week');
    assert.strictEqual(sync.body.picks.length, TEAMS.length);
    assert.ok(sync.body.picks.every(p => p.linePick === '' && p.winnerPick === ''),
        'every row blank');
});

await check('a game deselected down to nothing is sent as blank', async () => {
    const t = setup({ picks: { bills_chiefs: { line: 'away' } } });
    await t.api.syncPicksToGoogleSheets(false);
    const row = syncOf(t.sent).body.picks.find(p => p.gameId === 'rams_seahawks');
    assert.strictEqual(row.linePick, '', 'the removed pick is recorded, not omitted');
});

await check('the payload still reports cleared=false', async () => {
    const t = setup({ picks: {} });
    await t.api.syncPicksToGoogleSheets(false);
    assert.strictEqual(syncOf(t.sent).body.cleared, false);
});

section('Safety: never tombstone a week we cannot see');

await check('no schedule means no sync', async () => {
    // Writing blanks for games we have not loaded would wipe real picks.
    const t = setup({ picks: { rams_seahawks: { line: 'home' } }, games: [] });
    await t.api.syncPicksToGoogleSheets(false);
    assert.strictEqual(syncOf(t.sent), undefined, 'must not sync without a schedule');
});

section('Orphan keys are reported, never written');

await check('a pick key matching no game is left out of the payload', async () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home' }, '1': { blazin: true } } });
    await t.api.syncPicksToGoogleSheets(false);
    const body = syncOf(t.sent).body;
    assert.strictEqual(body.picks.length, TEAMS.length, 'still one row per game, no extra');
    assert.ok(!body.picks.some(p => p.gameId === '1'), 'the orphan key is not written');
});

section('An unchanged slate is not written again');

// The whole-week snapshot means every sync writes a row per game. Without a
// guard, two clicks a few seconds apart write the entire week twice, and the
// sheet grows for no informational gain.

await check('a second sync with the same picks is skipped', async () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home', winner: 'home' } } });
    await t.api.syncPicksToGoogleSheets(false);
    const first = t.sent.filter(r => r.body && r.body.picks).length;
    assert.strictEqual(first, 1);

    await t.api.syncPicksToGoogleSheets(false);
    assert.strictEqual(
        t.sent.filter(r => r.body && r.body.picks).length, first,
        'nothing changed, so nothing was written');
});

await check('a real change still syncs', async () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home', winner: 'home' } } });
    await t.api.syncPicksToGoogleSheets(false);

    t.api.__setState({ allPicks: { 5: { Stephen: {
        rams_seahawks: { line: 'away', winner: 'away' } } } } });
    await t.api.syncPicksToGoogleSheets(false);

    const bodies = t.sent.filter(r => r.body && r.body.picks);
    assert.strictEqual(bodies.length, 2, 'the changed slate was written');
    const row = bodies[1].body.picks.find(p => p.gameId === 'rams_seahawks');
    assert.strictEqual(row.linePick, 'Rams');
});

section('The week key stays season-scoped');

await check('the sheet week is season-prefixed', async () => {
    const t = setup({ picks: {} });
    await t.api.syncPicksToGoogleSheets(false);
    assert.ok(/^\d{4}_5$/.test(String(syncOf(t.sent).body.week)),
        `expected a season-prefixed week, got ${syncOf(t.sent).body.week}`);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);

})();
