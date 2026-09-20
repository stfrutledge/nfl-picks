// Tests for the History tab's standings scope.
//
// The standings table on the History tab covers the chosen season - so far,
// or the whole of it once it is over - or, with the toggle on Individual
// Weeks, one week of it. Both come out of historyStandingsStats(), the season
// table being the sum of the week tables, so what is worth guarding is that a
// week's numbers are that week's alone, that the week list holds only weeks
// with something in them, and that the controls read right for a live season,
// a finished one and Lifetime.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');

/** An element stub that remembers what it was given, class list included. */
function node(id, written) {
    const classes = new Set();
    return {
        set innerHTML(v) { written[id] = v; },
        get innerHTML() { return written[id] || ''; },
        set textContent(v) { written[id + ':text'] = v; },
        get textContent() { return written[id + ':text'] || ''; },
        value: '', style: {}, className: '', disabled: false, title: '', dataset: {},
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, force) => { (force === undefined ? !classes.has(c) : force) ? classes.add(c) : classes.delete(c); },
            contains: c => classes.has(c)
        },
        appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, closest: () => null,
        querySelector: () => node(id + ' thead', written),
        querySelectorAll: () => [], getAttribute: () => null, focus() {}, click() {}
    };
}

function makeAppEnv() {
    const store = new Map();
    const written = {};
    const nodes = new Map();
    const nodeFor = id => {
        if (!nodes.has(id)) nodes.set(id, node(id, written));
        return nodes.get(id);
    };
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
            getElementById: id => nodeFor(id),
            querySelector: sel => nodeFor(sel),
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async () => ({ ok: true, json: async () => ({ success: true }), text: async () => '{}' }),
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {},
        confirm: () => true,
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
    showToast = () => {};
    return ({
        CURRENT_SEASON, COWHERD, PLAYOFF_WEEKS,
        historyStandingsStats, historyStandingsWeeks, historyWeekName,
        populateHistoryStandingsWeeks, updateHistoryScopeControls,
        setHistoryStandingsScope, renderHistoryStandingsTable, historySelectedSeason,
        saveCowherdPicks,
        __scope: () => historyStandingsScope,
        __week: () => historyStandingsWeek,
        __setWeek: w => { historyStandingsWeek = w; },
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
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
    api.__written = written;
    api.__node = nodeFor;
    return api;
}

function game(id, away, home, extra = {}) {
    return {
        id, away, home, spread: 3, favorite: 'home', day: 'Sun', time: '1:00 PM',
        kickoff: '2099-01-01T18:00:00Z', ...extra
    };
}
const finalGame = (id, away, home, awayScore, homeScore) =>
    game(id, away, home, { status: 'STATUS_FINAL', completed: true, awayScore, homeScore });

/**
 * Three weeks of the season in progress. Seahawks -3 both weeks they play.
 *   Week 1: Rams @ Seahawks, 20-24 - home covers by a point.
 *   Week 2: Bills @ Chiefs, 30-20 - the away dog wins outright.
 *   Week 3: Jets @ Dolphins, not played.
 * Stephen: week 1 Seahawks starred (win), week 2 Chiefs on the line (loss),
 * week 3 Dolphins (nothing yet). Sean: week 1 Rams (loss), Rams to win (loss).
 */
function setup() {
    const api = makeAppEnv();
    api.NFL_GAMES_BY_WEEK[1] = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    api.NFL_GAMES_BY_WEEK[2] = [finalGame(2, 'Bills', 'Chiefs', 30, 20)];
    api.NFL_GAMES_BY_WEEK[3] = [game(3, 'Jets', 'Dolphins')];
    api.NFL_RESULTS_BY_WEEK[1] = { 1: { awayScore: 20, homeScore: 24, winner: 'home' } };
    api.NFL_RESULTS_BY_WEEK[2] = { 2: { awayScore: 30, homeScore: 20, winner: 'away' } };
    api.__setState({
        currentWeek: 3,
        allPicks: {
            1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home', blazin: true } },
                 Sean: { rams_seahawks: { line: 'away', winner: 'away' } } },
            2: { Stephen: { bills_chiefs: { line: 'home' } } },
            3: { Stephen: { jets_dolphins: { line: 'home' } } }
        }
    });
    api.__node('history-season-dropdown').value = String(api.CURRENT_SEASON);
    return api;
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

const rec = s => `${s.lineWins}-${s.lineLosses}-${s.linePushes}`;

section('A week’s table is that week alone');

check('the season table is every week so far', () => {
    const api = setup();
    const stats = api.historyStandingsStats(api.CURRENT_SEASON);
    assert.strictEqual(rec(stats.Stephen), '1-1-0');
    assert.strictEqual(`${stats.Stephen.suWins}-${stats.Stephen.suLosses}`, '1-0');
    assert.strictEqual(`${stats.Stephen.blazinWins}-${stats.Stephen.blazinLosses}`, '1-0');
    assert.strictEqual(rec(stats.Sean), '0-1-0');
});

check('a week’s table has only that week in it', () => {
    const api = setup();
    const week1 = api.historyStandingsStats(api.CURRENT_SEASON, 1);
    assert.strictEqual(rec(week1.Stephen), '1-0-0');
    assert.strictEqual(rec(week1.Sean), '0-1-0');
    const week2 = api.historyStandingsStats(api.CURRENT_SEASON, 2);
    assert.strictEqual(rec(week2.Stephen), '0-1-0');
    assert.strictEqual(rec(week2.Sean), '0-0-0', 'he did not play week 2');
    assert.strictEqual(`${week2.Stephen.blazinWins}-${week2.Stephen.blazinLosses}`, '0-0', 'nothing starred that week');
});

check('the weeks add up to the season', () => {
    const api = setup();
    const season = api.historyStandingsStats(api.CURRENT_SEASON);
    const sum = [1, 2, 3].map(w => api.historyStandingsStats(api.CURRENT_SEASON, w))
        .reduce((t, s) => t + s.Stephen.lineWins + s.Stephen.lineLosses, 0);
    assert.strictEqual(sum, season.Stephen.lineWins + season.Stephen.lineLosses);
});

check('Cowherd is on the week he picked and off the ones he did not', () => {
    const api = setup();
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    const week1 = api.historyStandingsStats(api.CURRENT_SEASON, 1);
    assert.ok(week1[api.COWHERD], 'his week 1 row');
    assert.strictEqual(`${week1[api.COWHERD].blazinWins}-${week1[api.COWHERD].blazinLosses}`, '1-0');
    const week2 = api.historyStandingsStats(api.CURRENT_SEASON, 2);
    assert.ok(!week2[api.COWHERD], 'no row where he has nothing');
    const season = api.historyStandingsStats(api.CURRENT_SEASON);
    assert.ok(season[api.COWHERD], 'and on the season table');
});

section('The week list holds only weeks with something in them');

check('an unplayed week is not offered', () => {
    const api = setup();
    assert.deepStrictEqual(api.historyStandingsWeeks(api.CURRENT_SEASON), [1, 2]);
});

check('the latest played week is the default, and a kept choice survives', () => {
    const api = setup();
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    assert.strictEqual(api.__week(), 2, 'the week just played');
    assert.match(api.__written['history-standings-week'], /value="2" selected/);
    assert.ok(!/value="3"/.test(api.__written['history-standings-week']), 'week 3 is not in the list');

    api.__setWeek(1);
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    assert.strictEqual(api.__week(), 1, 'a week the season still has is kept');
    api.__setWeek(7);
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    assert.strictEqual(api.__week(), 2, 'one it does not have falls back to the latest');
});

check('the playoffs go by the round’s name', () => {
    const api = setup();
    assert.strictEqual(api.historyWeekName(3), 'Week 3');
    assert.strictEqual(api.historyWeekName(19), api.PLAYOFF_WEEKS[19].name);
});

section('The controls read right for the season they are on');

check('a season in progress is "Season to Date", a finished one "Full Season"', () => {
    const api = setup();
    api.updateHistoryScopeControls(api.CURRENT_SEASON);
    assert.strictEqual(api.__written['history-scope-season:text'], 'Season to Date');
    assert.ok(!api.__node('history-scope').classList.contains('hidden'), 'the toggle is shown');
    api.updateHistoryScopeControls(api.CURRENT_SEASON - 1);
    assert.strictEqual(api.__written['history-scope-season:text'], 'Full Season');
});

check('Lifetime has no weeks, so no toggle', () => {
    const api = setup();
    api.updateHistoryScopeControls(null);
    assert.ok(api.__node('history-scope').classList.contains('hidden'));
});

check('the week dropdown shows only on Individual Weeks', () => {
    const api = setup();
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    api.setHistoryStandingsScope('week');
    assert.strictEqual(api.__scope(), 'week');
    assert.ok(!api.__node('history-standings-week-selector').classList.contains('hidden'));
    api.setHistoryStandingsScope('season');
    assert.ok(api.__node('history-standings-week-selector').classList.contains('hidden'));
    api.setHistoryStandingsScope('bogus');
    assert.strictEqual(api.__scope(), 'season', 'an unknown scope is ignored');
});

section('The table renders the scope it is on');

check('the title names the season, or the week', () => {
    const api = setup();
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    api.renderHistoryStandingsTable(api.CURRENT_SEASON);
    assert.strictEqual(api.__written['history-standings-scope-label:text'], 'Season');
    assert.match(api.__written['history-standings-table-body'], />1-1</, 'Stephen’s season ATS');

    api.setHistoryStandingsScope('week');
    assert.strictEqual(api.__written['history-standings-scope-label:text'], 'Week 2');
    const body = api.__written['history-standings-table-body'];
    assert.match(body, /data-picker="Stephen"[\s\S]*?>0-1</, 'Stephen’s week 2 ATS');
    assert.match(body, /data-picker="Sean"[\s\S]*?>-</, 'Sean has nothing that week');
});

check('a season with nothing played yet says so on the week table', () => {
    const api = makeAppEnv();
    api.__node('history-season-dropdown').value = String(api.CURRENT_SEASON);
    api.populateHistoryStandingsWeeks(api.CURRENT_SEASON);
    api.setHistoryStandingsScope('week');
    assert.match(api.__written['history-standings-table-body'], /No weeks played yet/);
});

console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
