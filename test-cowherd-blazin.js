// Tests for Cowherd's Blazin' 5.
//
// The group plays against Colin Cowherd's Blazin' 5, so his five picks are
// entered by hand each week. Two things make him not just a sixth picker, and
// both are what this guards:
//
//   - he has a Blazin' 5 record and NOTHING else, so he must never reach the
//     Line, Straight Up or Over/Under standings
//   - he calls his own numbers, so each pick carries the line he gave and is
//     graded at it, not at the book's
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');

/* ------------------------------------------------------------------ harness */

function makeAppEnv({ confirms = true } = {}) {
    const store = new Map();
    const posts = [];
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
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {},
        confirm: () => confirms,
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
    const exports = `;
    const TEST_TOASTS = [];
    showToast = (m, t) => TEST_TOASTS.push({ message: m, type: t });
    return ({
        COWHERD, COWHERD_CATEGORY, PICKERS, PICKERS_WITH_COWHERD, MAX_BLAZIN_PICKS,
        CURRENT_SEASON, pickKey, otherSide,
        cowherdLineFields, cowherdSignedSpread, saveCowherdPicks,
        getCowherdPicksForWeek, cowherdWeeklyResults, totalCowherdRecord,
        cowherdBelongsIn, calculateStatsForWeeks, standingsFromComputed,
        weeklySeriesFromComputed, atsWinnerForPick, syncPicksToGoogleSheets,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __toasts: () => TEST_TOASTS,
        __setWindow: (k, v) => { window[k] = v; },
        __state: () => ({ allPicks }),
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        PARSER + '\n' + snapshot + '\n' + APP + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, posts };
}

const WEEK = 5;

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

function setup({ games = sixGames(), results = null, picks = {}, week = WEEK } = {}) {
    const h = makeAppEnv();
    h.api.NFL_GAMES_BY_WEEK[week] = games;
    if (results) h.api.NFL_RESULTS_BY_WEEK[week] = results;
    h.api.__setState({
        currentWeek: week, currentPicker: 'Stephen',
        allPicks: { [week]: { Stephen: {}, ...picks } }
    });
    h.games = games;
    return h;
}

/** Rams @ Seahawks finishing 20-24: home by 4. */
function seahawksBy4() {
    return { 1: { awayScore: 20, homeScore: 24, winner: 'home' } };
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('His line, not the book\'s');

await check('a number laid by his side makes that side the favourite', async () => {
    const h = setup();
    // "Seahawks -6.5" - he has them laying more than the book's 3.
    const fields = h.api.cowherdLineFields(h.games[0], 'home', -6.5);
    assert.deepStrictEqual(fields, { frozenSpread: 6.5, frozenFavorite: 'home' });
});

await check('a number taken by his side makes the OTHER side the favourite', async () => {
    const h = setup();
    // "Rams +7" - the Seahawks are laying seven.
    const fields = h.api.cowherdLineFields(h.games[0], 'away', 7);
    assert.deepStrictEqual(fields, { frozenSpread: 7, frozenFavorite: 'home' });
});

await check('a pick’em stores a zero rather than being rejected', async () => {
    const h = setup();
    assert.deepStrictEqual(h.api.cowherdLineFields(h.games[0], 'away', 0),
        { frozenSpread: 0, frozenFavorite: 'away' });
});

await check('a blank or unparseable line is refused', async () => {
    const h = setup();
    assert.strictEqual(h.api.cowherdLineFields(h.games[0], 'away', ''), null);
    assert.strictEqual(h.api.cowherdLineFields(h.games[0], 'away', 'x'), null);
});

await check('a stored pick reads its number back out with his sign', async () => {
    const h = setup();
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const pick = h.api.getCowherdPicksForWeek(WEEK).rams_seahawks;
    assert.strictEqual(h.api.cowherdSignedSpread(pick), 7, 'Rams +7 comes back as +7');

    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -6.5 }]);
    const laid = h.api.getCowherdPicksForWeek(WEEK).rams_seahawks;
    assert.strictEqual(h.api.cowherdSignedSpread(laid), -6.5, 'Seahawks -6.5 comes back as -6.5');
});

section('Graded at the line he called');

await check('he loses at his number where the book’s would have won it', async () => {
    // Seahawks win by 4. At the book's -3 that covers; at his -6.5 it does not.
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -6.5 }]);
    const pick = h.api.getCowherdPicksForWeek(WEEK).rams_seahawks;
    const ats = h.api.atsWinnerForPick(h.games[0], pick, seahawksBy4()[1]);
    assert.strictEqual(ats, 'away', 'the Rams cover his -6.5');
});

await check('he wins at his number where the book’s would have lost it', async () => {
    // Rams +7 with a 4-point loss is a cover; the book had them +3.
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const pick = h.api.getCowherdPicksForWeek(WEEK).rams_seahawks;
    const ats = h.api.atsWinnerForPick(h.games[0], pick, seahawksBy4()[1]);
    assert.strictEqual(ats, 'away');
    assert.strictEqual(pick.line, 'away', 'and that is the side he took');
});

await check('his exact number is a push', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -4 }]);
    const pick = h.api.getCowherdPicksForWeek(WEEK).rams_seahawks;
    assert.strictEqual(h.api.atsWinnerForPick(h.games[0], pick, seahawksBy4()[1]), 'push');
});

section('The week is stored whole');

await check('every entered pick is stored, starred', async () => {
    const h = setup();
    const saved = h.api.saveCowherdPicks(WEEK, [
        { key: 'rams_seahawks', side: 'home', spread: -3 },
        { key: 'bills_chiefs', side: 'away', spread: 3 },
        { key: 'jets_dolphins', side: 'home', spread: -3 },
        { key: 'bears_packers', side: 'away', spread: 3 },
        { key: 'giants_eagles', side: 'home', spread: -3 }
    ]);
    assert.strictEqual(saved, 5);
    const picks = h.api.getCowherdPicksForWeek(WEEK);
    assert.strictEqual(Object.keys(picks).length, 5);
    assert.ok(Object.values(picks).every(p => p.blazin === true), 'all five are Blazin’');
});

await check('re-saving replaces the week rather than merging into it', async () => {
    const h = setup();
    h.api.saveCowherdPicks(WEEK, [
        { key: 'rams_seahawks', side: 'home', spread: -3 },
        { key: 'bills_chiefs', side: 'away', spread: 3 }
    ]);
    h.api.saveCowherdPicks(WEEK, [{ key: 'jets_dolphins', side: 'home', spread: -3 }]);
    const picks = h.api.getCowherdPicksForWeek(WEEK);
    assert.deepStrictEqual(Object.keys(picks), ['jets_dolphins'],
        'a dropped pick is gone, not left behind');
});

await check('an entry for a game that is not in the week is skipped', async () => {
    const h = setup();
    const saved = h.api.saveCowherdPicks(WEEK, [
        { key: 'rams_seahawks', side: 'home', spread: -3 },
        { key: 'ghosts_phantoms', side: 'home', spread: -3 }
    ]);
    assert.strictEqual(saved, 1);
});

await check('his picks sync to the sheet under his own name', async () => {
    const h = setup();
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    await new Promise(r => setTimeout(r, 0));
    const payload = h.posts.find(p => p.picker === 'Cowherd');
    assert.ok(payload, 'a Cowherd payload was posted');
    assert.match(String(payload.week), /_5$/, 'season-prefixed week key');
    const row = payload.picks.find(p => p.gameId === 'rams_seahawks');
    assert.strictEqual(row.linePick, 'Rams');
    assert.strictEqual(row.blazin, true);
    // The spread columns carry the line he is graded against, so his number
    // survives the round trip rather than the book's being written.
    assert.strictEqual(row.awaySpread, 7);
    assert.strictEqual(row.homeSpread, -7);
    assert.ok(row.frozenAt, 'and it is recorded as a fixed line');
});

section('He is in the Blazin’ 5 column and nowhere else');

await check('the Blazin’ 5 standings include him once he has a scored pick', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const computed = h.api.calculateStatsForWeeks(WEEK, WEEK, h.api.PICKERS_WITH_COWHERD);
    const blazin = h.api.standingsFromComputed(computed, 'blazin');
    assert.ok(blazin.Cowherd, 'Cowherd has a Blazin’ 5 row');
    assert.strictEqual(blazin.Cowherd.wins, 1);
    assert.strictEqual(blazin.Cowherd.losses, 0);
});

await check('the Line, Straight Up and O/U standings never do', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const computed = h.api.calculateStatsForWeeks(WEEK, WEEK, h.api.PICKERS_WITH_COWHERD);
    ['line', 'winner', 'ou'].forEach(category => {
        assert.ok(!h.api.standingsFromComputed(computed, category).Cowherd,
            `no Cowherd row in ${category}`);
        assert.ok(!h.api.weeklySeriesFromComputed(computed, category).Cowherd,
            `no Cowherd trend line in ${category}`);
    });
});

await check('an empty Cowherd row is left out rather than shown as 0-0', async () => {
    const h = setup({ results: seahawksBy4() });   // nothing entered
    const computed = h.api.calculateStatsForWeeks(WEEK, WEEK, h.api.PICKERS_WITH_COWHERD);
    assert.ok(!h.api.standingsFromComputed(computed, 'blazin').Cowherd);
});

await check('the real pickers are untouched by his presence', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const computed = h.api.calculateStatsForWeeks(WEEK, WEEK, h.api.PICKERS_WITH_COWHERD);
    h.api.PICKERS.forEach(picker => {
        assert.ok(h.api.cowherdBelongsIn(picker, 'line', computed[picker].line),
            `${picker} still belongs in the Line column`);
    });
});

section('History');

await check('the season in progress is scored from the entered picks', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [
        { key: 'rams_seahawks', side: 'away', spread: 7 }
    ]);
    const weekly = h.api.cowherdWeeklyResults(h.api.CURRENT_SEASON);
    assert.deepStrictEqual(weekly, { 5: { wins: 1, losses: 0, pushes: 0 } });
});

await check('a season with nothing entered reports nothing', async () => {
    const h = setup({ results: seahawksBy4() });
    assert.strictEqual(h.api.cowherdWeeklyResults(h.api.CURRENT_SEASON), null);
});

await check('a finished season reads its archive, not the live picks', async () => {
    const h = setup({ results: seahawksBy4() });
    h.api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    // An archive attaches itself to window when historical-<year>.js loads.
    assert.strictEqual(h.api.cowherdWeeklyResults(2024), null, 'nothing before it loads');
    h.api.__setWindow('COWHERD_2024_RESULTS', { 1: { wins: 3, losses: 2, pushes: 0 } });
    assert.deepStrictEqual(h.api.cowherdWeeklyResults(2024),
        { 1: { wins: 3, losses: 2, pushes: 0 } },
        'the archive, not this season’s entered picks');
});

await check('a week-by-week archive totals up', async () => {
    const h = setup();
    const total = h.api.totalCowherdRecord({
        1: { wins: 3, losses: 2, pushes: 0 },
        2: { wins: 4, losses: 0, pushes: 1 }
    });
    assert.deepStrictEqual(total, { wins: 7, losses: 2, pushes: 1 });
});

await check('a 2022-style aggregate archive totals up too', async () => {
    const h = setup();
    const total = h.api.totalCowherdRecord({ aggregate: { wins: 40, losses: 45, pushes: 2 } });
    assert.deepStrictEqual(total, { wins: 40, losses: 45, pushes: 2 });
});

await check('nothing at all totals to an empty record', async () => {
    const h = setup();
    assert.deepStrictEqual(h.api.totalCowherdRecord(null), { wins: 0, losses: 0, pushes: 0 });
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
process.exit(0);

})();
