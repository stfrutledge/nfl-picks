// Tests for the records panels that score picks outside the standings table:
// team records, worst week, the Blazin' 5 team and spread tables (Standings
// and History), the history fav/dog split, lone wolf, and how all of them show
// a record with no decided picks.
//
// Each of these used to be its own hand-rolled per-picker loop, and each had
// drifted from the standings engine on something - the weeks it counted, where
// a result came from, and which line a pick was bucketed and printed at. They
// now read gradedPicks(), the loop the engine itself runs on; these checks pin
// down the cases where the copies used to disagree with it.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

// Divisional round weekend of the 2026 season: CURRENT_NFL_WEEK is past the
// regular season, which is when playoff weeks used to leak into these panels.
const TEST_NOW = '2027-01-20T17:00:00Z';

function makeEnv() {
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
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async url => { throw new Error('fetch not stubbed: ' + url); },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {}, confirm: () => false,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;

    const snapshot = `
        const HISTORICAL_DATA_SEASON = 2026;
        const HISTORICAL_GAMES = {};
        const HISTORICAL_RESULTS = {};
        const HISTORICAL_PICKS = {};
    `;
    const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const exports = `;return ({
        PICKERS, CURRENT_SEASON, CURRENT_NFL_WEEK,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, weeklyPicksCache,
        gradedPicks, calculateStatsForWeeks, calculatePlayoffStats,
        calculateTeamPickRecords, calculateBlazinTeamPickRecords, calculateBlazinSpreadRecords,
        calculateHistoryBlazinSpreadRecords, calculateHistoryBlazinFavDog,
        calculateHistoryBlazinTeamPicked, calculateHistoryBlazinTeamFaded,
        calculateWorstBlazinWeeks,
        calculateLoneWolfPicksWithDetails, calculateStraightUpLoneWolfPicks, calculateBlazinLoneWolfPicks,
        recordsTableData, winPctCell, renderPickerCard, renderSuperBowlPicksSummary,
        gameDetailRowsHtml,
        __setState: s => { if ('allPicks' in s) allPicks = s.allPicks; }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    return fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia, fixedClock(TEST_NOW));
}

// Home team favoured by 3 unless a test says otherwise.
function game(id, away, home, extra = {}) {
    return { id, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM', ...extra };
}

function final(away, home) {
    return { completed: true, status: 'STATUS_FINAL', awayScore: away, homeScore: home };
}

// Every final is also written to the Results sheet, as the backfill would,
// unless a test asks for `stored: false` - so a check about bucketing does not
// also depend on where a result is read from.
function setup({ weeks = {}, picks = {}, stored = true } = {}) {
    const api = makeEnv();
    for (const [week, games] of Object.entries(weeks)) {
        api.NFL_GAMES_BY_WEEK[week] = games;
        if (!stored) continue;
        api.NFL_RESULTS_BY_WEEK[week] = Object.fromEntries(games.filter(g => g.completed).map(g => [g.id, {
            winner: g.homeScore > g.awayScore ? 'home' : (g.awayScore > g.homeScore ? 'away' : 'tie'),
            awayScore: g.awayScore, homeScore: g.homeScore
        }]));
    }
    api.__setState({ allPicks: picks });
    return api;
}

/** Everybody on one side of a game, except `wolf`, who takes the other. */
function loneWolfSlate(key, wolf, wolfPick, packPick, api) {
    const slate = {};
    api.PICKERS.forEach(p => { slate[p] = { [key]: p === wolf ? wolfPick : packPick }; });
    return slate;
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

check('the clock puts the season in the playoffs', () => {
    const api = setup();
    assert.strictEqual(api.CURRENT_SEASON, 2026);
    assert.ok(api.CURRENT_NFL_WEEK >= 19, `week ${api.CURRENT_NFL_WEEK}`);
});

section("Blazin' 5 By Spread is bucketed at the line the pick was graded at");

// Locked at Seahawks -3, board moved to -6.5, Seahawks win by 4: a -3 win.
// Bucketed by the board it used to land in the -6.5 row, as a WIN, where the
// same pick graded at -6.5 would have been a loss.
const LOCKED_AT_3 = { line: 'home', blazin: true, frozenAt: '2026-09-10T12:00:00Z', frozenSpread: 3, frozenFavorite: 'home' };

check('a locked pick lands in its own number, not the board line', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: 6.5, ...final(20, 24) })] },
        picks: { 1: { Stephen: { rams_seahawks: LOCKED_AT_3 } } }
    });
    const records = api.calculateBlazinSpreadRecords('Stephen');
    assert.deepStrictEqual(Object.keys(records), ['-3']);
    assert.strictEqual(records['-3'].wins, 1);
    assert.strictEqual(records['-3'].spreadValue, -3);
});

check('a locked pick with no board line is still bucketed at its own number', () => {
    // Read off the board, this was a "PK" or "null" row.
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: null, ...final(20, 24) })] },
        picks: { 1: { Stephen: { rams_seahawks: LOCKED_AT_3 } } }
    });
    assert.deepStrictEqual(Object.keys(api.calculateBlazinSpreadRecords('Stephen')), ['-3']);
});

check('the History spread table follows the same rule', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: 6.5, ...final(20, 24) })] },
        picks: { 1: { Stephen: { rams_seahawks: LOCKED_AT_3 } } }
    });
    const records = api.calculateHistoryBlazinSpreadRecords('Stephen', 2026);
    assert.deepStrictEqual(Object.keys(records), ['-3']);
});

check('an underdog is bucketed with a plus, and a pick em as PK', () => {
    const api = setup({
        weeks: { 1: [
            game(1, 'Rams', 'Seahawks', final(20, 21)),                     // Rams +3 cover
            game(2, 'Bills', 'Chiefs', { spread: 0, ...final(20, 17) })     // pick'em
        ] },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'away', blazin: true },
            bills_chiefs: { line: 'away', blazin: true }
        } } }
    });
    const records = api.calculateBlazinSpreadRecords('Stephen');
    assert.deepStrictEqual(Object.keys(records).sort(), ['+3', 'PK']);
});

section('Detail rows print the graded line, from the picked side');

check('a locked pick shows its own number', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: 6.5, ...final(20, 24) })] },
        picks: { 1: { Stephen: { rams_seahawks: LOCKED_AT_3 } } }
    });
    const [g] = api.calculateBlazinTeamPickRecords('Stephen').Seahawks.games;
    assert.strictEqual(g.line, 'Seahawks -3');
    assert.strictEqual(g.picked, 'Seahawks');
    assert.strictEqual(g.outcome, 'win');
});

check("a pick'em reads Pick'em, not -0", () => {
    const api = setup({
        weeks: { 1: [game(1, 'Bills', 'Chiefs', { spread: 0, ...final(20, 17) })] },
        picks: { 1: { Stephen: { bills_chiefs: { line: 'away' } } } }
    });
    const [g] = api.calculateTeamPickRecords('Stephen').Bills.games;
    assert.strictEqual(g.line, "Bills Pick'em");
});

check('an underdog pick is quoted from the underdog side', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', final(20, 21))] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'away' } } } }
    });
    const [g] = api.calculateTeamPickRecords('Stephen').Rams.games;
    assert.strictEqual(g.line, 'Rams +3');
});

section('Playoff weeks stay out of the regular-season panels');

const PLAYOFFS = {
    1: [game(1, 'Rams', 'Seahawks', final(10, 20))],
    19: [game(1, 'Bills', 'Chiefs', final(10, 20))]
};

check('team records count the regular season only', () => {
    const api = setup({
        weeks: PLAYOFFS,
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home' } } },
            19: { Stephen: { bills_chiefs: { line: 'home' } } }
        }
    });
    const teams = Object.keys(api.calculateTeamPickRecords('Stephen')).sort();
    assert.deepStrictEqual(teams, ['Rams', 'Seahawks']);
});

check('lone wolf counts the regular season only', () => {
    const api = setup({ weeks: PLAYOFFS });
    api.__setState({ allPicks: {
        1: loneWolfSlate('rams_seahawks', 'Sean', { line: 'home' }, { line: 'away' }, api),
        19: loneWolfSlate('bills_chiefs', 'Sean', { line: 'home' }, { line: 'away' }, api)
    } });
    const sean = api.calculateLoneWolfPicksWithDetails().Sean;
    assert.deepStrictEqual([sean.wins, sean.losses, sean.pushes], [1, 0, 0]);
    assert.deepStrictEqual(sean.games.map(g => g.week), [1]);
});

check('straight-up lone wolf counts the regular season only', () => {
    const api = setup({ weeks: PLAYOFFS });
    api.__setState({ allPicks: {
        1: loneWolfSlate('rams_seahawks', 'Sean', { winner: 'home' }, { winner: 'away' }, api),
        19: loneWolfSlate('bills_chiefs', 'Sean', { winner: 'home' }, { winner: 'away' }, api)
    } });
    const sean = api.calculateStraightUpLoneWolfPicks().Sean;
    assert.deepStrictEqual(sean.games.map(g => g.week), [1]);
    assert.strictEqual(sean.games[0].line, '', 'a straight-up pick has no line to quote');
});

section('A game that has just finished counts everywhere at once');

// No row in the Results sheet yet, only the final score ESPN put on the game.
// The standings counted it through getGameResult's fallback; these panels read
// the stored results only, so until the backfill landed the two disagreed.
check('team records, Blazin tables and lone wolf all see an unbackfilled final', () => {
    const api = setup({ weeks: { 1: [game(1, 'Rams', 'Seahawks', final(10, 20))] }, stored: false });
    api.__setState({ allPicks: {
        1: loneWolfSlate('rams_seahawks', 'Sean', { line: 'home', blazin: true }, { line: 'away' }, api)
    } });
    assert.strictEqual(api.calculateStatsForWeeks(1, 1).Sean.line.wins, 1, 'the standings see it');
    assert.strictEqual(api.calculateTeamPickRecords('Sean').Seahawks.wins, 1);
    assert.strictEqual(api.calculateBlazinTeamPickRecords('Sean').Seahawks.wins, 1);
    assert.strictEqual(api.calculateBlazinSpreadRecords('Sean')['-3'].wins, 1);
    assert.strictEqual(api.calculateLoneWolfPicksWithDetails().Sean.wins, 1);
    assert.strictEqual(api.calculateBlazinLoneWolfPicks().Sean.wins, 1);
});

section('History fav/dog agrees with the Line tab chart');

check('the favourite is the one at the locked line', () => {
    // Locked on the Seahawks at -3; the board has since flipped to Rams -1.
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: 1, favorite: 'away', ...final(20, 24) })] },
        picks: { 1: { Stephen: { rams_seahawks: LOCKED_AT_3 } } }
    });
    const records = api.calculateHistoryBlazinFavDog('Stephen', 2026);
    assert.deepStrictEqual(Object.keys(records), ['Favorite']);
    assert.strictEqual(records.Favorite.wins, 1);
});

check("a pick'em is neither", () => {
    const api = setup({
        weeks: { 1: [game(1, 'Bills', 'Chiefs', { spread: 0, ...final(20, 17) })] },
        picks: { 1: { Stephen: { bills_chiefs: { line: 'away', blazin: true } } } }
    });
    assert.deepStrictEqual(api.calculateHistoryBlazinFavDog('Stephen', 2026), {});
});

section('Team picked and faded');

check('picked files the pick under the team taken, faded under the other', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', final(10, 20))] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', blazin: true } } } }
    });
    assert.deepStrictEqual(Object.keys(api.calculateHistoryBlazinTeamPicked('Stephen', 2026)), ['Seahawks']);
    assert.deepStrictEqual(Object.keys(api.calculateHistoryBlazinTeamFaded('Stephen', 2026)), ['Rams']);
});

check("'All' adds up the five pickers", () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', final(10, 20))] },
        picks: { 1: {
            Stephen: { rams_seahawks: { line: 'home', blazin: true } },
            Sean: { rams_seahawks: { line: 'away', blazin: true } }
        } }
    });
    const picked = api.calculateHistoryBlazinTeamPicked('All', 2026);
    assert.strictEqual(picked.Seahawks.wins, 1);
    assert.strictEqual(picked.Rams.losses, 1);
});

section('Worst week');

check("worst Blazin' week is the lowest percentage, then the most losses", () => {
    const games = n => Array.from({ length: n }, (_, i) =>
        game(i + 1, `Away${i}`, `Home${i}`, final(10, 20)));   // home covers every one
    const slate = sides => Object.fromEntries(sides.map((side, i) =>
        [`away${i}_home${i}`, { line: side, blazin: true }]));
    const api = setup({
        weeks: { 1: games(5), 2: games(5) },
        picks: {
            1: { Stephen: slate(['home', 'home', 'home', 'away', 'away']) },  // 3-2
            2: { Stephen: slate(['home', 'away', 'away', 'away', 'away']) }   // 1-4
        }
    });
    assert.strictEqual(api.calculateWorstBlazinWeeks().Stephen, 'Wk 2: 1-4');
});

section('No decided picks is no percentage, not a red 0%');

check('a records row of nothing but pushes has no percentage', () => {
    const api = setup();
    const [row] = api.recordsTableData({ Jets: { wins: 0, losses: 0, pushes: 2, games: [] } }, 'team');
    assert.strictEqual(row.pct, null);
    assert.strictEqual(row.total, 2);
    const cell = api.winPctCell(row.pct);
    assert.ok(cell.includes('neutral') && cell.includes('>-<'), cell);
});

check('a playoff record with nothing decided has a null percentage', () => {
    const api = setup();
    assert.strictEqual(api.calculatePlayoffStats().Stephen.percentage, null);
});

check('a leaderboard card with no percentage shows a neutral dash', () => {
    const api = setup();
    const html = api.renderPickerCard({ name: 'Stephen', percentage: null, wins: 0, losses: 0, pushes: 0 }, 0);
    assert.ok(!html.includes('0%'), 'no 0%');
    assert.ok(!html.includes('negative'), 'not painted red');
    assert.ok(html.includes('win-pct ">-</div>'), html.match(/win-pct[^<]*<\/div>/)?.[0]);
});

section('The Super Bowl picks summary prints the graded line');

// It built the number by hand from game.spread, so a missing line printed
// "Chiefs (+null)", a pick'em "Chiefs (-0)", and a locked pick the board's line.
function superBowlRow(gameExtra, pick) {
    const api = setup();
    const table = { innerHTML: '' };
    const sb = game(1, 'Eagles', 'Chiefs', gameExtra);
    api.renderSuperBowlPicksSummary(table, [sb], { Stephen: { eagles_chiefs: pick } }, null);
    const row = table.innerHTML.split('<tr>').find(r => r.includes('>Stephen<'));
    return [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);
}

check('a missing line leaves the number off', () => {
    const [, ats] = superBowlRow({ spread: null }, { line: 'home' });
    assert.strictEqual(ats, 'Chiefs');
});

check("a pick'em reads PK", () => {
    const [, ats] = superBowlRow({ spread: 0 }, { line: 'away' });
    assert.strictEqual(ats, 'Eagles (PK)');
});

check('the underdog is quoted with a plus', () => {
    const [, ats] = superBowlRow({ spread: 1.5 }, { line: 'away', winner: 'away' });
    assert.strictEqual(ats, 'Eagles (+1.5)');
});

check('a locked pick shows its own number and total', () => {
    const [, ats, winner, ou] = superBowlRow({ spread: 1.5, overUnder: 48.5 }, {
        line: 'home', winner: 'home', overUnder: 'over',
        frozenAt: '2027-02-10T12:00:00Z', frozenSpread: 3, frozenFavorite: 'home', frozenOverUnder: 47
    });
    assert.strictEqual(ats, 'Chiefs (-3)');
    assert.strictEqual(winner, 'Chiefs');
    assert.strictEqual(ou, 'Over 47');
});

section('With "All", a detail row names who made the pick');

// Two pickers on one game: without names it reads as one game listed twice.
const TWO_ON_ONE = [
    { week: 14, season: 2016, picker: 'Stephen', away: 'Cowboys', home: 'Giants', awayScore: 7, homeScore: 10, picked: 'Cowboys', line: 'Cowboys -3', outcome: 'loss' },
    { week: 14, season: 2016, picker: 'Dylan', away: 'Cowboys', home: 'Giants', awayScore: 7, homeScore: 10, picked: 'Cowboys', line: 'Cowboys -3', outcome: 'loss' }
];

check('one picker reads "Picked:", as before', () => {
    const api = setup();
    const html = api.gameDetailRowsHtml(TWO_ON_ONE);
    assert.strictEqual((html.match(/Picked: Cowboys/g) || []).length, 2);
    assert.ok(!/Stephen|Dylan/.test(html));
});

check('a pooled table names each picker, in name order within a game', () => {
    const api = setup();
    const html = api.gameDetailRowsHtml(TWO_ON_ONE, { withPicker: true });
    assert.ok(!/Picked:/.test(html));
    assert.ok(html.indexOf('Dylan picked Cowboys') > -1);
    assert.ok(html.indexOf('Dylan picked Cowboys') < html.indexOf('Stephen picked Cowboys'));
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
