// Tests for the Live tab.
//
// It answers one question during a slate: where would the Blazin' 5 table
// stand if the afternoon ended right now? That is the ordinary season table
// with games in progress counted at the score they are standing at - the same
// engine, the same picks, one extra source of results. The things worth
// guarding are that the provisional scores really are provisional (a scheduled
// or finished game must never take one), that the move column compares against
// the settled table, and that the game list only ever holds starred games.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');

/** An element stub that remembers what it was given. */
function node(id, written) {
    return {
        set innerHTML(v) { written[id] = v; },
        get innerHTML() { return written[id] || ''; },
        set textContent(v) { written[id + ':text'] = v; },
        get textContent() { return written[id + ':text'] || ''; },
        style: {}, className: '', disabled: false, title: '', dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, closest: () => null,
        querySelector: () => node(id + ' thead', written),
        querySelectorAll: () => [], getAttribute: () => null, focus() {}, click() {}
    };
}

function makeAppEnv({ withDom = false } = {}) {
    const store = new Map();
    const written = {};
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
            getElementById: id => (withDom ? node(id, written) : null),
            querySelector: sel => (withDom ? node(sel, written) : null),
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
    const TEST_TOASTS = [];
    showToast = (m, t) => TEST_TOASTS.push({ message: m, type: t });
    return ({
        PICKERS, PICKERS_WITH_COWHERD, COWHERD, COWHERD_CATEGORY,
        isGameInProgress, liveProvisionalResult, blazinGamesForWeek,
        liveGameRank, calculateStatsForWeeks, regularSeasonWeekRange,
        standingsFromComputed, saveCowherdPicks, pickKey, describeLineForSide,
        renderLiveTab, renderActiveTab, refreshLiveViews,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
            if ('currentCategory' in s) currentCategory = s.currentCategory;
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
    return api;
}

const WEEK = 1;

/**
 * A game carrying its own ESPN status, which is the branch getLiveGameStatus
 * takes before it reaches the live cache.
 */
function game(id, away, home, extra = {}) {
    return {
        id, away, home, spread: 3, favorite: 'home', day: 'Sun', time: '1:00 PM',
        kickoff: '2099-01-01T18:00:00Z', ...extra
    };
}

const inProgress = (id, away, home, awayScore, homeScore, extra = {}) =>
    game(id, away, home, { status: 'STATUS_IN_PROGRESS', awayScore, homeScore, period: 3, clock: '5:00', ...extra });

const finalGame = (id, away, home, awayScore, homeScore, extra = {}) =>
    game(id, away, home, { status: 'STATUS_FINAL', completed: true, awayScore, homeScore, ...extra });

function setup({ games, picks = {}, results = null, withDom = false } = {}) {
    const api = makeAppEnv({ withDom });
    api.NFL_GAMES_BY_WEEK[WEEK] = games;
    if (results) api.NFL_RESULTS_BY_WEEK[WEEK] = results;
    api.__setState({ currentWeek: WEEK, currentPicker: 'Stephen', allPicks: { [WEEK]: picks } });
    return api;
}

const b5 = side => ({ line: side, winner: side, blazin: true });

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('A score only counts as a result while the game is being played');

check('a game in progress offers its current score', () => {
    const g = inProgress(1, 'Rams', 'Seahawks', 20, 24);
    const api = setup({ games: [g] });
    assert.strictEqual(api.isGameInProgress(g), true);
    assert.deepStrictEqual(api.liveProvisionalResult(g),
        { winner: 'home', awayScore: 20, homeScore: 24, provisional: true });
});

check('a scheduled game offers nothing', () => {
    const g = game(1, 'Rams', 'Seahawks');
    const api = setup({ games: [g] });
    assert.strictEqual(api.isGameInProgress(g), false);
    assert.strictEqual(api.liveProvisionalResult(g), null);
});

check('a finished game offers nothing - it has a real result', () => {
    const g = finalGame(1, 'Rams', 'Seahawks', 20, 24);
    const api = setup({ games: [g] });
    assert.strictEqual(api.liveProvisionalResult(g), null);
});

check('a tied game in progress names no winner', () => {
    const g = inProgress(1, 'Rams', 'Seahawks', 21, 21);
    const api = setup({ games: [g] });
    assert.strictEqual(api.liveProvisionalResult(g).winner, null);
});

section('The as-is table is the settled one with today counted in');

check('a game in progress is scored only when live is asked for', () => {
    // Seahawks -3 and up by 4: Stephen's home pick is covering as it stands.
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, picks: { Stephen: { rams_seahawks: b5('home') } } });

    const settled = api.standingsFromComputed(
        api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS), 'blazin');
    assert.strictEqual(settled.Stephen.wins, 0, 'settled table has nothing to score yet');

    const asIs = api.standingsFromComputed(
        api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS, { includeLive: true }), 'blazin');
    assert.strictEqual(asIs.Stephen.wins, 1, 'as-is counts it as it stands');
});

check('a finished game counts in both', () => {
    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    ['settled', 'live'].forEach(mode => {
        const rows = api.standingsFromComputed(
            api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS,
                { includeLive: mode === 'live' }), 'blazin');
        assert.strictEqual(rows.Stephen.wins, 1, mode);
    });
});

/** The stats renderAsIsStandings hands to the shared standings renderer. */
function asIsRows(api) {
    const { first, last } = api.regularSeasonWeekRange();
    return api.standingsFromComputed(
        api.calculateStatsForWeeks(first, last, api.PICKERS_WITH_COWHERD,
            { includeLive: true }), api.COWHERD_CATEGORY);
}

check('settled results and live ones land in the same table', () => {
    // Sean has a win in the books; Stephen is covering live. Both show.
    const games = [
        finalGame(1, 'Bills', 'Chiefs', 30, 20),
        inProgress(2, 'Rams', 'Seahawks', 20, 24)
    ];
    const api = setup({
        games,
        picks: {
            Sean: { bills_chiefs: b5('away') },
            Stephen: { rams_seahawks: b5('home'), bills_chiefs: { line: 'home', winner: 'home' } }
        },
        results: { 1: { awayScore: 30, homeScore: 20, winner: 'away' } }
    });

    const rows = asIsRows(api);
    assert.strictEqual(rows.Stephen.wins, 1, 'the live cover counts');
    assert.strictEqual(rows.Sean.wins, 1, 'the settled win counts');
    // Stephen's unstarred Bills pick is not a Blazin' 5 pick and must not
    // reach this table, which is the Blazin' 5 one.
    assert.strictEqual(rows.Stephen.totalPicks, 1, 'only the starred pick counts');
});

check('Cowherd reaches the table on a live cover, like anyone else', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games });
    // Seahawks -3 by his own number, and up by 4 as it stands.
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    assert.strictEqual(asIsRows(api).Cowherd.wins, 1);
});

check('and stays off it with nothing of his scored', () => {
    const games = [game(1, 'Rams', 'Seahawks')];   // not started
    const api = setup({ games });
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    assert.ok(!asIsRows(api).Cowherd, 'an empty row reads as a bug, not a scoreline');
});

section('The game list holds starred games only');

check('an unstarred game is left out entirely', () => {
    const games = [game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs')];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home'), bills_chiefs: { line: 'away', winner: 'away' } } }
    });
    const entries = api.blazinGamesForWeek(WEEK);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].game.id, 1);
});

check('both sides of a game are collected, Cowherd among them', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home') }, Sean: { rams_seahawks: b5('away') } }
    });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);

    const entry = api.blazinGamesForWeek(WEEK)[0];
    assert.deepStrictEqual(entry.sides.home.map(p => p.picker), ['Stephen']);
    assert.deepStrictEqual(entry.sides.away.map(p => p.picker).sort(), ['Cowherd', 'Sean']);
    assert.strictEqual(entry.count, 3);
});

check('a locked pick is described at its own number, not the board’s', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.away[0];
    assert.strictEqual(api.describeLineForSide(games[0], 'away', pick), 'Rams +7');
    assert.strictEqual(api.describeLineForSide(games[0], 'away'), 'Rams +3', 'the board still says +3');
});

section('The tab is redrawn when its data arrives');

// The backup load finishes long after the first paint. Every view that
// renders from picks has to be redrawn then, and the Live tab was the one
// left out: it drew once on the way in and kept what it had, so picks that
// came back from the sheet a moment later never appeared on it.

check('renderActiveTab draws the Live tab when it is the one showing', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, withDom: true });
    api.__setState({ currentCategory: 'live' });
    // Picks arrive from the backup after the tab has already been drawn.
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);

    api.renderActiveTab();
    const boxes = api.__written['live-games-list'] || '';
    assert.ok(boxes.includes('live-game-box'), 'the games were drawn');
    assert.ok(boxes.includes('Cowherd'), 'with the picks that had just landed');
});

check('and leaves it alone when another tab is showing', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, withDom: true });
    api.__setState({ currentCategory: 'make-picks' });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);

    api.renderActiveTab();
    assert.ok(!api.__written['live-games-list'], 'no work done for a hidden tab');
});

section('In progress first, then finished, then still to come');

check('the three states rank in that order', () => {
    const api = setup({ games: [] });
    const results = { 3: { awayScore: 20, homeScore: 24, winner: 'home' } };
    assert.strictEqual(api.liveGameRank(inProgress(1, 'Rams', 'Seahawks', 7, 3), {}), 0);
    assert.strictEqual(api.liveGameRank(finalGame(3, 'Jets', 'Dolphins', 20, 24), results), 1);
    assert.strictEqual(api.liveGameRank(game(2, 'Bills', 'Chiefs'), {}), 2);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
process.exit(0);
