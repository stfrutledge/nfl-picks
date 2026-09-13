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

function makeAppEnv() {
    const store = new Map();
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
        liveGameRank, asIsBlazinStandings, calculateStatsForWeeks,
        standingsFromComputed, saveCowherdPicks, pickKey, describeLineForSide,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
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
    return fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
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

function setup({ games, picks = {}, results = null } = {}) {
    const api = makeAppEnv();
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

check('the move column reports the climb against the settled table', () => {
    // Sean has a win in the books. Stephen has none, but is covering live, so
    // as-is he goes ahead of Sean and Sean drops a place.
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

    const rows = api.asIsBlazinStandings();
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.strictEqual(byName.Stephen.wins, 1, 'the live cover counts');
    assert.strictEqual(byName.Sean.wins, 1, 'the settled win counts');
    // Settled, Sean is alone on 1-0 and everyone else ties on 0-0. As is,
    // Stephen joins him at the top, so he is up one place and no further.
    assert.strictEqual(byName.Stephen.move, 1, 'Stephen climbs exactly one');
    assert.strictEqual(byName.Sean.move, 0, 'Sean has not moved');
});

check('nobody moves before anything has been scored', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, picks: { Stephen: { rams_seahawks: b5('home') } } });
    const rows = api.asIsBlazinStandings();
    // Settled, all five are level on 0-0 and share a rank, so Stephen going
    // ahead on a live cover is a one-place climb, not a four-place one.
    assert.strictEqual(rows.find(r => r.name === 'Stephen').move, 0,
        'already joint-first, so no climb');
    assert.strictEqual(rows.find(r => r.name === 'Sean').move, -1,
        'and the rest are now behind him');
});

check('Cowherd shows no move until he has a settled record', () => {
    // He is filtered off the settled table with nothing scored, so there is no
    // earlier rank to compare his live one against.
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games });
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    const cowherd = api.asIsBlazinStandings().find(r => r.name === 'Cowherd');
    assert.ok(cowherd, 'he is on the as-is table');
    assert.strictEqual(cowherd.move, null, 'a first result is not a climb');
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
