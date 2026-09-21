// Tests for the Perfect Weeks card.
//
// A 5-0 Blazin' 5 week is the thing the group brags about, so the Insights
// panel counts them per picker on the Blazin' 5 sub-tab. What is worth
// guarding: a perfect week is strictly five wins and nothing else (a push is
// not a win), the count reads off the same per-week scoring the standings
// use, Cowherd is in once he has a scored pick, and the card is only on the
// Blazin' 5 sub-tab.
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
        value: '', style: {}, className: '', disabled: false, title: '', dataset: {}, options: [],
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
        COWHERD, PERFECT_BLAZIN_WINS,
        perfectBlazinWeeks, renderPerfectWeeksCard, saveCowherdPicks,
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

const TEAMS = [['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins'], ['Lions', 'Bears'], ['Eagles', 'Giants']];

/**
 * One week of five games, home -3 in each, with a result per game given as
 * the home margin: 7 covers, 3 pushes, -7 loses.
 */
function week(api, weekNum, margins) {
    const games = TEAMS.map(([away, home], i) => ({
        id: weekNum * 10 + i, away, home, spread: 3, favorite: 'home',
        day: 'Sun', time: '1:00 PM', kickoff: '2020-01-01T18:00:00Z',
        status: 'STATUS_FINAL', completed: true
    }));
    api.NFL_GAMES_BY_WEEK[weekNum] = games;
    api.NFL_RESULTS_BY_WEEK[weekNum] = {};
    games.forEach((g, i) => {
        const margin = margins[i];
        api.NFL_RESULTS_BY_WEEK[weekNum][g.id] = {
            awayScore: 20, homeScore: 20 + margin, winner: margin > 0 ? 'home' : 'away'
        };
    });
}

/** Five starred picks on a side, keyed the way the app keys them. */
const five = side => Object.fromEntries(TEAMS.map(([away, home]) =>
    [`${away.toLowerCase()}_${home.toLowerCase()}`, { line: side, winner: side, blazin: true }]));

// Weeks 1 and 2 only: the card reads regularSeasonWeekRange(), whose far end
// is CURRENT_NFL_WEEK off the clock, so a later week would not be in range.
function setup() {
    const api = makeAppEnv();
    week(api, 1, [7, 7, 7, 7, 7]);      // home covers all five
    week(api, 2, [7, 7, 7, 7, 3]);      // four covers and a push
    api.__setState({
        currentWeek: 2,
        currentSubcategory: 'blazin',
        allPicks: {
            // Stephen: 5-0, then 4-0-1. Sean: 4-1, then 0-4-1.
            1: { Stephen: five('home'), Sean: { ...five('home'), eagles_giants: { line: 'away', winner: 'away', blazin: true } } },
            2: { Stephen: five('home'), Sean: five('away') }
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

section('A perfect week is five wins and nothing else');

check('5-0 counts, 4-0-1 and 4-1 do not', () => {
    const api = setup();
    const weeks = api.perfectBlazinWeeks();
    assert.deepStrictEqual(weeks.Stephen, [1], 'week 1 only: week 2 has a push');
    assert.deepStrictEqual(weeks.Sean, [], '4-1 is not perfect either');
    assert.strictEqual(api.PERFECT_BLAZIN_WINS, 5);
});

check('a picker with no picks is listed with none, not left out', () => {
    const api = setup();
    const weeks = api.perfectBlazinWeeks();
    assert.deepStrictEqual(weeks.Daniel, []);
    assert.ok(!(api.COWHERD in weeks), 'Cowherd is out until he has a scored pick');
});

check('Cowherd is in once he has picks, scored at his own numbers', () => {
    const api = setup();
    // Week 2, where the fifth home side won by exactly 3 at -3: he calls it
    // -2.5, so his five all land where everyone else's pushed.
    api.saveCowherdPicks(2, [
        { key: 'rams_seahawks', side: 'home', spread: -3 },
        { key: 'bills_chiefs', side: 'home', spread: -3 },
        { key: 'jets_dolphins', side: 'home', spread: -3 },
        { key: 'lions_bears', side: 'home', spread: -3 },
        { key: 'eagles_giants', side: 'home', spread: -2.5 }
    ]);
    const weeks = api.perfectBlazinWeeks();
    assert.deepStrictEqual(weeks[api.COWHERD], [2]);
});

section('The card is on the Blazin’ 5 sub-tab, and only there');

check('it lists everyone, most perfect weeks first, with the weeks named', () => {
    const api = setup();
    api.renderPerfectWeeksCard();
    assert.ok(!api.__node('perfect-weeks-card').classList.contains('hidden'));
    const html = api.__written['perfect-weeks-card'];
    assert.match(html, /Perfect Weeks/);
    const rows = html.match(/perfect-weeks-row[^"]*"[\s\S]*?lone-wolf-name">(\w+)</g).map(r => r.match(/lone-wolf-name">(\w+)</)[1]);
    assert.strictEqual(rows[0], 'Stephen', 'the one with a perfect week leads');
    assert.strictEqual(rows.length, 5, 'every picker has a row');
    assert.match(html, /perfect-weeks-row leader [\s\S]*?Stephen[\s\S]*?perfect-weeks-count">1<[\s\S]*?Wk 1</, 'his count and week');
    assert.match(html, /Sean[\s\S]*?perfect-weeks-count">0</);
    assert.doesNotMatch(html, /Nobody has gone 5-0/);
});

check('nobody yet says so, and nobody leads', () => {
    const api = setup();
    api.__setState({ allPicks: { 1: { Stephen: five('away') } } });
    api.renderPerfectWeeksCard();
    const html = api.__written['perfect-weeks-card'];
    assert.match(html, /Nobody has gone 5-0 yet/);
    assert.doesNotMatch(html, /perfect-weeks-row leader/);
});

check('the Line Picks and Straight Up sub-tabs hide it', () => {
    const api = setup();
    api.__setState({ currentSubcategory: 'line' });
    api.renderPerfectWeeksCard();
    assert.ok(api.__node('perfect-weeks-card').classList.contains('hidden'));
    api.__setState({ currentSubcategory: 'winner' });
    api.renderPerfectWeeksCard();
    assert.ok(api.__node('perfect-weeks-card').classList.contains('hidden'));
});

console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
