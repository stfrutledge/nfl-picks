// Tests for the client-side standings engine. Runs app.js in Node with browser
// stubs.
//
// What this replaces: standings used to come from a hand-maintained Google
// Sheets workbook (games, spreads and scores typed in by a person, formulas on
// top). From the season after LEGACY_SHEETS_SEASON the same numbers are
// computed here from picks + results, so nobody has to keep a spreadsheet alive
// for the dashboard to work.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

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
        PICKERS, FIRST_PLAYOFF_WEEK, LAST_PLAYOFF_WEEK,
        getGameResult, calculateStatsForWeeks, calculatePlayoffStats,
        standingsFromComputed, weeklySeriesFromComputed, recordPercentage,
        regularSeasonWeekRange, buildCurrentSeasonView, CURRENT_SEASON,
        getSeasonData, seasonData,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, weeklyPicksCache,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    return fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
}

// Home team favoured by 3 throughout, so ATS maths is easy to reason about:
// home covers only by more than 3.
function game(id, away, home, extra = {}) {
    return { id, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM', ...extra };
}

function setup({ weeks = {}, picks = {}, results = {}, cache = null } = {}) {
    const api = makeEnv();
    for (const [week, games] of Object.entries(weeks)) api.NFL_GAMES_BY_WEEK[week] = games;
    for (const [week, res] of Object.entries(results)) api.NFL_RESULTS_BY_WEEK[week] = res;
    if (cache) for (const [week, c] of Object.entries(cache)) api.weeklyPicksCache[week] = c;
    api.__setState({ allPicks: picks, currentWeek: 1, currentPicker: 'Stephen' });
    return api;
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('Where a result comes from');

check('a stored result is preferred', () => {
    const api = setup({});
    const g = game(1, 'Rams', 'Seahawks');
    const r = api.getGameResult(g, { 1: { winner: 'home', awayScore: 10, homeScore: 20 } });
    assert.strictEqual(r.homeScore, 20);
});

check("the game's own ESPN scores are used when nothing is stored", () => {
    // This is the fallback that makes season-wide standings possible: the
    // Results sheet is only written for the current week, while every loaded
    // schedule carries its own final scores.
    const api = setup({});
    const g = game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 17, homeScore: 24 });
    const r = api.getGameResult(g, {});
    assert.ok(r, 'a completed game must resolve without a stored result');
    assert.strictEqual(r.winner, 'home');
    assert.strictEqual(r.awayScore, 17);
});

check('an unplayed game has no result', () => {
    const api = setup({});
    assert.strictEqual(api.getGameResult(game(1, 'Rams', 'Seahawks'), {}), null);
});

check('a scoreless completed game is not treated as final', () => {
    // 0-0 means "no scores available yet", not a real result.
    const api = setup({});
    const g = game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 0, homeScore: 0 });
    assert.strictEqual(api.getGameResult(g, {}), null);
});

section('Scoring a week');

const WEEK_1 = [
    game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 }), // home -3 covers
    game(2, 'Bills', 'Chiefs', { completed: true, awayScore: 20, homeScore: 21 }),  // home wins, does NOT cover
    game(3, 'Jets', 'Dolphins', { completed: true, awayScore: 10, homeScore: 13 })  // exactly 3 -> push
];

check('line picks are scored against the spread', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'home' },   // covers -> win
            bills_chiefs: { line: 'home' },    // wins but does not cover -> loss
            jets_dolphins: { line: 'home' }    // exactly the spread -> push
        } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.line, { wins: 1, losses: 1, pushes: 1 });
});

check('straight-up picks ignore the spread', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { winner: 'home' },  // home won -> win
            bills_chiefs: { winner: 'home' },   // home won -> win despite not covering
            jets_dolphins: { winner: 'away' }   // home won -> loss
        } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.winner, { wins: 2, losses: 1, pushes: 0 });
});

check("Blazin' 5 is scored on the starred line pick's ATS result", () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'home', blazin: true },  // win
            bills_chiefs: { line: 'home', blazin: true },   // loss
            jets_dolphins: { line: 'home' }                 // not starred
        } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.blazin, { wins: 1, losses: 1, pushes: 0 });
    assert.deepStrictEqual(s.line, { wins: 1, losses: 1, pushes: 1 }, 'still counted in line too');
});

check('over/under uses the line stored with the pick when the game has none', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { overUnder: 'over', totalLine: 28 } } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.ou, { wins: 1, losses: 0, pushes: 0 }, '30 points beats a 28 line');
});

check('games without a result are skipped, not counted as losses', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks')] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.line, { wins: 0, losses: 0, pushes: 0 });
});

check('the sheet-cache picks are merged, with local winning', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'away' } } } },
        cache: { 1: { picks: { Stephen: {
            rams_seahawks: { line: 'home' },  // overridden by the local pick
            bills_chiefs: { line: 'away' }    // only in the cache -> still counted
        } } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.line, { wins: 1, losses: 1, pushes: 0 },
        'away on game 1 loses, away on game 2 covers');
});

section('Totals across weeks');

check('records accumulate and per-week rows are kept', () => {
    const api = setup({
        weeks: { 1: WEEK_1, 2: WEEK_1.map(g => ({ ...g })) },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home' } } },
            2: { Stephen: { rams_seahawks: { line: 'home' }, bills_chiefs: { line: 'home' } } }
        }
    });
    const s = api.calculateStatsForWeeks(1, 2).Stephen;
    assert.deepStrictEqual(s.line, { wins: 2, losses: 1, pushes: 0 });
    assert.deepStrictEqual(s.byWeek.map(w => w.week), [1, 2]);
});

check('a week with no picks is not a 0% week', () => {
    // It has to be absent, or the trend line dips to zero for weeks nobody played.
    const api = setup({
        weeks: { 1: WEEK_1, 2: WEEK_1.map(g => ({ ...g })) },
        picks: { 2: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    const s = api.calculateStatsForWeeks(1, 2).Stephen;
    assert.deepStrictEqual(s.byWeek.map(w => w.week), [2]);
});

section('The shape the standings table consumes');

check('percentages exclude pushes rather than counting them as losses', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'home' }, bills_chiefs: { line: 'home' },
            jets_dolphins: { line: 'home' }
        } } }
    });
    const row = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'line').Stephen;
    assert.strictEqual(row.wins, 1);
    assert.strictEqual(row.losses, 1);
    assert.strictEqual(row.pushes, 1);
    assert.strictEqual(row.percentage, 50, '1 from 2 decided picks');
    assert.strictEqual(row.totalPicks, 3, 'the push still counts as a pick made');
});

check('a picker with no decided picks gets a null percentage, not zero', () => {
    const api = setup({ weeks: { 1: WEEK_1 }, picks: {} });
    const row = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'line').Stephen;
    assert.strictEqual(row.percentage, null, 'null renders as "-", 0 would read as 0%');
    assert.strictEqual(row.bestWeek, '');
});

check('best week and last-3-week form come off the weekly rows', () => {
    const w = n => [game(n, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })];
    const api = setup({
        weeks: { 1: w(1), 2: w(2), 3: w(3), 4: w(4) },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'away' } } },  // loss  -> 0%
            2: { Stephen: { rams_seahawks: { line: 'home' } } },  // win   -> 100%
            3: { Stephen: { rams_seahawks: { line: 'away' } } },  // loss  -> 0%
            4: { Stephen: { rams_seahawks: { line: 'home' } } }   // win   -> 100%
        }
    });
    const row = api.standingsFromComputed(api.calculateStatsForWeeks(1, 4), 'line').Stephen;
    assert.strictEqual(row.bestWeek, '2', 'first week reaching the highest pct');
    assert.strictEqual(Math.round(row.last3WeekPct), 67, 'weeks 2-4: 100, 0, 100');
});

check('the weekly series is the shape the trend chart wants', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    const series = api.weeklySeriesFromComputed(api.calculateStatsForWeeks(1, 1), 'line');
    assert.deepStrictEqual(series.Stephen, [{ week: 1, pct: 100 }]);
    api.PICKERS.forEach(p => assert.ok(Array.isArray(series[p]), `${p} must have a series`));
});

section('The playoff table keeps its existing shape');

check('combined record and per-category breakdowns still come out', () => {
    const api = setup({
        weeks: { 19: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20, overUnder: 28 })] },
        picks: { 19: { Stephen: { rams_seahawks: { line: 'home', winner: 'home', overUnder: 'over' } } } }
    });
    const s = api.calculatePlayoffStats().Stephen;
    assert.strictEqual(s.wins, 3, 'line + straight up + over/under all won');
    assert.strictEqual(s.losses, 0);
    assert.strictEqual(s.percentage, 100);
    assert.strictEqual(s.lineRecord, '1-0');
    assert.strictEqual(s.suRecord, '1-0');
    assert.strictEqual(s.ouRecord, '1-0');
});

check('pushes show in the record strings and are excluded from the percentage', () => {
    const api = setup({
        weeks: { 19: [game(1, 'Jets', 'Dolphins', { completed: true, awayScore: 10, homeScore: 13 })] },
        picks: { 19: { Stephen: { jets_dolphins: { line: 'home', winner: 'home' } } } }
    });
    const s = api.calculatePlayoffStats().Stephen;
    assert.strictEqual(s.lineRecord, '0-0-1', 'the ATS push is shown');
    assert.strictEqual(s.suRecord, '1-0');
    assert.strictEqual(s.percentage, 100, 'one win from one decided pick');
});

section('A missing spread is unscored, never a push');

// calculateATSWinner returns 'push' when game.spread is missing, because both
// NaN comparisons fail. Spreads load asynchronously, so scoring without one
// turned every line pick into a push and read as broken maths.
check('line picks are not scored while the spread is missing', () => {
    const noSpread = { id: 1, away: 'Rams', home: 'Seahawks', favorite: 'home',
        completed: true, awayScore: 10, homeScore: 20 }; // no spread field
    const api = setup({
        weeks: { 1: [noSpread] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } } }
    });
    const s = api.calculateStatsForWeeks(1, 1).Stephen;
    assert.deepStrictEqual(s.line, { wins: 0, losses: 0, pushes: 0 },
        'unscored, not a push');
    assert.deepStrictEqual(s.winner, { wins: 1, losses: 0, pushes: 0 },
        'straight up needs no spread and must still score');
});

check('a non-numeric spread is also treated as missing', () => {
    const bad = { id: 1, away: 'Rams', home: 'Seahawks', favorite: 'home', spread: '',
        completed: true, awayScore: 10, homeScore: 20 };
    const api = setup({
        weeks: { 1: [bad] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    assert.deepStrictEqual(api.calculateStatsForWeeks(1, 1).Stephen.line,
        { wins: 0, losses: 0, pushes: 0 });
});

check('a zero spread is real and still scores', () => {
    // A pick em is spread 0, which is falsy - it must not be mistaken for missing.
    const pickem = { id: 1, away: 'Rams', home: 'Seahawks', favorite: 'home', spread: 0,
        completed: true, awayScore: 10, homeScore: 20 };
    const api = setup({
        weeks: { 1: [pickem] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    assert.deepStrictEqual(api.calculateStatsForWeeks(1, 1).Stephen.line,
        { wins: 1, losses: 0, pushes: 0 });
});

section('Live regression: 2026 week 1, Patriots 10 @ Seahawks 13, Seahawks -3');

// The real first game of 2026. Seahawks favoured by exactly 3 and won by
// exactly 3, so every line pick pushes whichever side it took - which is why
// the Line Picks tab legitimately shows no wins or losses for it.
const WEEK1_REAL = [game(1, 'Patriots', 'Seahawks',
    { completed: true, awayScore: 10, homeScore: 13, overUnder: 44.5 })];
const WEEK1_PICKS = { 1: {
    Stephen: { patriots_seahawks: { line: 'home', winner: 'home' } },
    Dylan: { patriots_seahawks: { line: 'home', winner: 'home' } },
    Sean: { patriots_seahawks: { line: 'away', winner: 'away' } },
    Jason: { patriots_seahawks: { line: 'away', winner: 'away' } }
} };

check('winning by exactly the spread pushes both sides', () => {
    const api = setup({ weeks: { 1: WEEK1_REAL }, picks: WEEK1_PICKS });
    const computed = api.calculateStatsForWeeks(1, 1);
    ['Stephen', 'Dylan', 'Sean', 'Jason'].forEach(p => {
        assert.deepStrictEqual(computed[p].line, { wins: 0, losses: 0, pushes: 1 },
            p + ' should push');
    });
});

check('straight up still separates the pickers', () => {
    const api = setup({ weeks: { 1: WEEK1_REAL }, picks: WEEK1_PICKS });
    const rows = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'winner');
    assert.strictEqual(rows.Stephen.wins, 1, 'took the Seahawks, who won');
    assert.strictEqual(rows.Dylan.wins, 1);
    assert.strictEqual(rows.Sean.losses, 1, 'took the Patriots');
    assert.strictEqual(rows.Jason.losses, 1);
    assert.strictEqual(rows.Stephen.percentage, 100);
});

check('a game nobody starred leaves the Blazin tab genuinely empty', () => {
    // Not a bug: no B5 star on this game, so there is nothing to score.
    const api = setup({ weeks: { 1: WEEK1_REAL }, picks: WEEK1_PICKS });
    const rows = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'blazin');
    assert.strictEqual(rows.Stephen.totalPicks, 0);
    assert.strictEqual(rows.Stephen.percentage, null);
});

section('History can show the season in progress');

// There is no historical-<year>.js for the live season - it lives in
// NFL_GAMES_BY_WEEK / NFL_RESULTS_BY_WEEK / allPicks until it is archived at the
// end of the year. History offered the current season in its dropdown and then
// failed to load it, because loadSeasonData went looking for an archive file.

check('the live season is assembled from in-memory data', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } } }
    });
    const view = api.buildCurrentSeasonView();

    assert.deepStrictEqual(Object.keys(view.games), ['1'], "week 1 is present");
    assert.strictEqual(view.games[1].length, WEEK_1.length);
    assert.ok(view.picks[1].Stephen.rams_seahawks, "picks come along too");
    assert.strictEqual(view.season, api.CURRENT_SEASON);
    assert.strictEqual(view.isLive, true);
});

check('weeks with no schedule loaded are left out of the week list', () => {
    // Otherwise History would offer weeks it cannot show anything for.
    const api = setup({ weeks: { 1: WEEK_1 }, picks: {} });
    const view = api.buildCurrentSeasonView();
    assert.ok(!('7' in view.games), "unloaded weeks are absent");
});

check('getSeasonData serves the live season, not an empty archive slot', () => {
    // seasonData only ever holds ARCHIVED seasons. Everything that read it
    // directly found nothing for the season in progress and rendered an empty
    // state - History said "No data available" even after loading fine.
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } } }
    });

    assert.strictEqual(api.seasonData[api.CURRENT_SEASON], undefined,
        "the live season is deliberately not in the archive map");

    const data = api.getSeasonData(api.CURRENT_SEASON);
    assert.ok(data, "but reading through the accessor finds it");
    assert.ok(data.games[1], "with its games");
    assert.ok(data.picks[1].Stephen.rams_seahawks, "and its picks");
});

check('getSeasonData accepts a season as a string', () => {
    const api = setup({ weeks: { 1: WEEK_1 }, picks: {} });
    assert.ok(api.getSeasonData(String(api.CURRENT_SEASON)),
        "<select> values arrive as strings");
});

check('getSeasonData still returns archived seasons from the map', () => {
    const api = setup({ weeks: { 1: WEEK_1 }, picks: {} });
    const archived = { games: { 3: [] }, results: {}, picks: {} };
    api.seasonData[2024] = archived;

    assert.strictEqual(api.getSeasonData(2024), archived, "past seasons are unchanged");
    assert.strictEqual(api.getSeasonData(2019), undefined, "and a missing one is still missing");
});

check('it reflects later changes rather than caching the first read', () => {
    // Picks keep arriving all season; a cached view would go stale.
    const api = setup({ weeks: { 1: WEEK_1 }, picks: {} });
    assert.ok(!api.buildCurrentSeasonView().picks[1], "nothing yet");

    api.__setState({ allPicks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } } });
    assert.ok(api.buildCurrentSeasonView().picks[1].Stephen.rams_seahawks,
        "the new pick shows up");
});

section('The week range the season standings cover');

check('the range stops at the end of the regular season', () => {
    const api = setup({});
    const r = api.regularSeasonWeekRange();
    assert.strictEqual(r.first, 1);
    assert.ok(r.last < api.FIRST_PLAYOFF_WEEK, 'playoffs have their own tab');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
