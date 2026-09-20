// Tests for the Standings tab's table scope.
//
// The standings table can show the season so far or one week of it, chosen
// by the toggle sitting over it - the same idea as the History tab's, over
// the season in progress. A week's table is the same engine over the one
// week, so the season is the sum of the weeks; the columns that describe a
// season's shape are left off it; and the controls hold their place across
// the redraw that every live-score refresh triggers.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
// charts.js draws with Chart.js, which there is none of here; every function
// it defines is stubbed so renderDashboard can run through to the table.
const CHART_STUBS = [...fs.readFileSync(path.join(__dirname, 'charts.js'), 'utf8')
    .matchAll(/^(?:async )?function (\w+)\s*\(/gm)].map(m => `function ${m[1]}() {}`).join('\n');

/** An element stub that remembers what it was given, class list included. */
function node(id, written) {
    const classes = new Set();
    let html = '';
    return {
        set innerHTML(v) { html = v; written[id] = v; },
        get innerHTML() { return html; },
        set textContent(v) { written[id + ':text'] = v; },
        get textContent() { return written[id + ':text'] || ''; },
        value: '', style: {}, className: '', disabled: false, title: '', dataset: {}, options: [],
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, force) => { (force === undefined ? !classes.has(c) : force) ? classes.add(c) : classes.delete(c); },
            contains: c => classes.has(c)
        },
        appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, closest: () => null,
        querySelector: () => node(id + ' thead', written),
        querySelectorAll: () => [], getAttribute: () => null, focus() {}, click() {},
        getContext: () => null
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
        ${CHART_STUBS}
    `;
    const exports = `;
    showToast = () => {};
    return ({
        CURRENT_SEASON, COWHERD, FIRST_PLAYOFF_WEEK,
        standingsWeeks, populateStandingsWeeks, standingsWeekStats,
        updateStandingsScopeControls, setStandingsScope, renderStandingsTable,
        renderDashboard, calculateStatsForWeeks, standingsFromComputed, PICKERS_WITH_COWHERD,
        __scope: () => standingsScope,
        __week: () => standingsWeek,
        __setWeek: w => { standingsWeek = w; },
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentSubcategory' in s) currentSubcategory = s.currentSubcategory;
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
 * Three weeks of the season in progress. Home -3 in each.
 *   Week 1: Rams @ Seahawks, 20-24 - home covers by a point.
 *   Week 2: Bills @ Chiefs, 30-20 - the away dog wins outright.
 *   Week 3: Jets @ Dolphins, not played.
 * Stephen: week 1 Seahawks starred (win), week 2 Chiefs on the line (loss),
 * week 3 Dolphins (nothing yet). Sean: week 1 Rams (loss).
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
        currentSubcategory: 'line',
        allPicks: {
            1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home', blazin: true } },
                 Sean: { rams_seahawks: { line: 'away', winner: 'away' } } },
            2: { Stephen: { bills_chiefs: { line: 'home' } } },
            3: { Stephen: { jets_dolphins: { line: 'home' } } }
        }
    });
    return api;
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

const rec = s => `${s.wins}-${s.losses}-${s.pushes}`;

section('A week’s table is that week alone');

check('a week’s record is that week’s, in the table’s shape', () => {
    const api = setup();
    const week1 = api.standingsWeekStats(1, 'line');
    assert.strictEqual(rec(week1.Stephen), '1-0-0');
    assert.strictEqual(rec(week1.Sean), '0-1-0');
    assert.strictEqual(week1.Stephen.totalPicks, 1);
    const week2 = api.standingsWeekStats(2, 'line');
    assert.strictEqual(rec(week2.Stephen), '0-1-0');
    assert.strictEqual(week2.Sean.totalPicks, 0, 'he did not play week 2');
    const b5 = api.standingsWeekStats(2, 'blazin');
    assert.strictEqual(b5.Stephen.totalPicks, 0, 'nothing starred that week');
});

check('the weeks add up to the season', () => {
    const api = setup();
    const season = api.standingsFromComputed(
        api.calculateStatsForWeeks(1, 3, api.PICKERS_WITH_COWHERD), 'line');
    const sum = [1, 2, 3].map(w => api.standingsWeekStats(w, 'line'))
        .reduce((t, s) => t + s.Stephen.totalPicks, 0);
    assert.strictEqual(sum, season.Stephen.totalPicks);
    assert.strictEqual(season.Stephen.totalPicks, 2);
});

section('The week list holds only weeks with something in them');

check('an unplayed week is not offered, and playoff weeks never are', () => {
    const api = setup();
    assert.deepStrictEqual(api.standingsWeeks(), [1, 2]);
    api.NFL_GAMES_BY_WEEK[api.FIRST_PLAYOFF_WEEK] = [finalGame(9, 'Rams', 'Seahawks', 20, 24)];
    api.NFL_RESULTS_BY_WEEK[api.FIRST_PLAYOFF_WEEK] = { 9: { awayScore: 20, homeScore: 24, winner: 'home' } };
    assert.deepStrictEqual(api.standingsWeeks(), [1, 2], 'the playoffs have their own table');
});

check('the latest played week is the default, and a kept choice survives', () => {
    const api = setup();
    api.populateStandingsWeeks();
    assert.strictEqual(api.__week(), 2);
    assert.match(api.__written['standings-week'], /value="2" selected/);
    assert.ok(!/value="3"/.test(api.__written['standings-week']));

    api.__setWeek(1);
    api.populateStandingsWeeks();
    assert.strictEqual(api.__week(), 1, 'a week still on offer is kept');
    api.__setWeek(7);
    api.populateStandingsWeeks();
    assert.strictEqual(api.__week(), 2, 'one that is not falls back to the latest');
});

check('an unchanged list is not rewritten under an open dropdown', () => {
    const api = setup();
    api.populateStandingsWeeks();
    const dropdown = api.__node('standings-week');
    let writes = 0;
    Object.defineProperty(dropdown, 'innerHTML', {
        get: () => api.__written['standings-week'],
        set: v => { writes++; api.__written['standings-week'] = v; }
    });
    api.populateStandingsWeeks();
    api.populateStandingsWeeks();
    assert.strictEqual(writes, 0);
});

section('The controls hold their place');

check('the week dropdown shows only on Individual Weeks', () => {
    const api = setup();
    api.updateStandingsScopeControls();
    assert.ok(api.__node('standings-week-selector').classList.contains('hidden'));
    assert.ok(!api.__node('standings-scope').classList.contains('hidden'), 'the toggle is shown');
    api.setStandingsScope('week');
    assert.strictEqual(api.__scope(), 'week');
    assert.ok(!api.__node('standings-week-selector').classList.contains('hidden'));
    api.setStandingsScope('bogus');
    assert.strictEqual(api.__scope(), 'week', 'an unknown scope is ignored');
    api.setStandingsScope('season');
    assert.ok(api.__node('standings-week-selector').classList.contains('hidden'));
});

check('the Playoffs sub-tab has no toggle', () => {
    const api = setup();
    api.__setState({ currentSubcategory: 'playoffs' });
    api.updateStandingsScopeControls();
    assert.ok(api.__node('standings-scope').classList.contains('hidden'));
});

section('The table renders the scope it is on');

check('the season table keeps its season columns', () => {
    const api = setup();
    api.renderDashboard();
    assert.match(api.__written['#standings-table thead'], /Last 3-Wk/);
    assert.match(api.__written['#standings-table thead'], /Year Chg/);
    assert.match(api.__written['standings-table-body'], /Stephen/);
});

check('a week’s table is the record alone', () => {
    const api = setup();
    api.setStandingsScope('week');
    const head = api.__written['#standings-table thead'];
    assert.doesNotMatch(head, /Last 3-Wk|Best Week|Year Chg/, 'no season-shape columns');
    assert.match(head, /Total/);
    const body = api.__written['standings-table-body'];
    // Week 2, the latest played: Stephen 0-1 on the line, Sean nothing.
    assert.match(body, /data-picker="Stephen"[\s\S]*?<td>0<\/td>\s*<td>1<\/td>/, 'Stephen’s week 2');
    assert.match(body, /data-picker="Sean"[\s\S]*?<td>0<\/td>\s*<td>0<\/td>/, 'Sean has nothing that week');
});

check('switching the week redraws that week', () => {
    const api = setup();
    api.setStandingsScope('week');
    api.__setWeek(1);
    api.renderDashboard();
    const body = api.__written['standings-table-body'];
    assert.match(body, /data-picker="Stephen"[\s\S]*?<td>1<\/td>\s*<td>0<\/td>/, 'Stephen’s week 1');
    assert.match(body, /data-picker="Sean"[\s\S]*?<td>0<\/td>\s*<td>1<\/td>/, 'Sean’s week 1');
});

check('the scope survives the redraw a live refresh triggers', () => {
    const api = setup();
    api.setStandingsScope('week');
    api.__setWeek(1);
    api.renderDashboard();
    api.renderDashboard();
    assert.strictEqual(api.__scope(), 'week');
    assert.strictEqual(api.__week(), 1);
    assert.doesNotMatch(api.__written['#standings-table thead'], /Year Chg/);
});

check('nothing played yet says so', () => {
    const api = makeAppEnv();
    api.__setState({ currentSubcategory: 'line', currentWeek: 1 });
    api.setStandingsScope('week');
    assert.match(api.__written['standings-table-body'], /No weeks played yet/);
});

console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
