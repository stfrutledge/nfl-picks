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
        hasUsableLine, hasUsableSpread, signedSpreadDisplay,
        priorSeasonStats, yearChangeFor, AVAILABLE_SEASONS, normalizeSeasonPicks,
        applySavedSpreads, saveSpread,
        standingsFromComputed, weeklySeriesFromComputed, recordPercentage,
        pctCellClass,
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

section('A win percentage is coloured by what it says');

// The standings table used to colour .pct a flat green, so every percentage
// was green - a picker losing every Blazin' 5 pick read as 0.0% in the same
// colour as one winning them all. The colour now comes only from the
// modifier class, and pctCellClass is the one place that picks it.

check('above even is positive', () => {
    const api = setup({});
    assert.strictEqual(api.pctCellClass(60), 'pct pct-positive');
    assert.strictEqual(api.pctCellClass(50.1), 'pct pct-positive');
});

check('below even is negative, and 0% loudest of all', () => {
    const api = setup({});
    assert.strictEqual(api.pctCellClass(0), 'pct pct-negative');
    assert.strictEqual(api.pctCellClass(49.9), 'pct pct-negative');
});

check('exactly even is neither', () => {
    const api = setup({});
    assert.strictEqual(api.pctCellClass(50), 'pct pct-neutral');
});

check('no percentage at all is neutral, not a total loss', () => {
    // recordPercentage returns null on an empty record, and the tables show a
    // dash. Standing a 0 in for it painted the dash red.
    const api = setup({});
    assert.strictEqual(api.recordPercentage({ wins: 0, losses: 0, pushes: 0 }), null);
    assert.strictEqual(api.pctCellClass(null), 'pct pct-neutral');
    assert.strictEqual(api.pctCellClass(undefined), 'pct pct-neutral');
    assert.strictEqual(api.pctCellClass(NaN), 'pct pct-neutral');
});

check('no .pct rule carries a colour of its own', () => {
    // The flat colour is what made every percentage green; a modifier cannot
    // override a rule that is equally specific and later in the file.
    const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    const block = styles.match(/\.standings-table \.pct \{[^}]*\}/);
    assert.ok(block, 'found the .pct rule');
    assert.ok(!/color\s*:/.test(block[0]),
        'colour belongs on .pct-positive/.pct-negative/.pct-neutral, not .pct');
});

section("A placeholder is not a pick'em");

// The bug this section exists for: games parsed from ESPN carry no line, and
// the placeholder used to be spread: 0. A real pick'em is also 0, so a game
// whose line had not loaded was indistinguishable from one holding a genuine
// pick'em - and was therefore SCORED, straight up, rather than skipped.
//
// Daniel's real 2026 week 1 Blazin' 5 is the card that surfaced it. Four of his
// five land the same way either way; Lions -7 winning by 1 is the one that does
// not. With the lines in he went 3-2. Scored as pick'ems he 'went' 4-1, and the
// dashboard showed whichever of the two had won the race to render.
const DANIEL_W1 = [
    { id: 1, away: 'Buccaneers', home: 'Bengals', spread: 3.5, favorite: 'home',
      completed: true, awayScore: 27, homeScore: 33 },   // CIN by 6, covers -3.5
    { id: 2, away: 'Saints', home: 'Lions', spread: 7, favorite: 'home',
      completed: true, awayScore: 30, homeScore: 31 },   // DET by 1, does NOT cover -7
    { id: 3, away: 'Jets', home: 'Titans', spread: 1.5, favorite: 'home',
      completed: true, awayScore: 23, homeScore: 10 },   // TEN lost outright
    { id: 4, away: 'Bills', home: 'Texans', spread: 1.5, favorite: 'away',
      completed: true, awayScore: 36, homeScore: 31 },   // BUF by 5, covers -1.5
    { id: 5, away: 'Broncos', home: 'Chiefs', spread: 2.5, favorite: 'home',
      completed: true, awayScore: 10, homeScore: 31 }    // KC by 21, covers -2.5
];
const DANIEL_W1_PICKS = { 1: { Daniel: {
    buccaneers_bengals: { line: 'home', winner: 'home', blazin: true },
    saints_lions:       { line: 'home', winner: 'home', blazin: true },
    jets_titans:        { line: 'home', winner: 'home', blazin: true },
    bills_texans:       { line: 'away', winner: 'away', blazin: true },
    broncos_chiefs:     { line: 'home', winner: 'home', blazin: true }
} } };

check("Daniel's real week 1 Blazin' 5 is 3-2 against the lines", () => {
    const api = setup({ weeks: { 1: DANIEL_W1 }, picks: DANIEL_W1_PICKS });
    const s = api.calculateStatsForWeeks(1, 1).Daniel;
    assert.deepStrictEqual(s.blazin, { wins: 3, losses: 2, pushes: 0 });
});

check('the same card with no lines is unscored, not 4-1', () => {
    // spread: null is what a game parsed from ESPN now carries. Were it 0, the
    // Lions pick would be graded straight up, DET 31-30 would count as a win
    // and the Blazin' record would read 4-1.
    const noLines = DANIEL_W1.map(g => ({ ...g, spread: null, favorite: null }));
    const api = setup({ weeks: { 1: noLines }, picks: DANIEL_W1_PICKS });
    const s = api.calculateStatsForWeeks(1, 1).Daniel;
    assert.deepStrictEqual(s.blazin, { wins: 0, losses: 0, pushes: 0 },
        'no line means no line record');
    assert.deepStrictEqual(s.winner, { wins: 4, losses: 1, pushes: 0 },
        'straight up needs no line and really is 4-1 - the number that leaked');
});

check('a game ESPN gave no odds for does not come out as a pick em', () => {
    // Guards the placeholder itself. Source-level, because the value is written
    // where the ESPN payload is parsed and nothing else can observe it.
    const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    assert.ok(!/spread: 0,\s*\/\/ Will be updated from Odds API/.test(src),
        'the ESPN game placeholder must not be 0');
    assert.ok(/spread: null,/.test(src), 'it should be null');
});

check('hasUsableLine separates a pick em from an absent line', () => {
    const api = setup({});
    assert.strictEqual(api.hasUsableLine(0), true, '0 is a pick em, which is a line');
    assert.strictEqual(api.hasUsableLine(null), false);
    assert.strictEqual(api.hasUsableLine(undefined), false);
    assert.strictEqual(api.hasUsableLine(''), false, 'a blank sheet cell is not a line');
    assert.strictEqual(api.hasUsableLine('3.5'), true, 'the sheet hands back strings');
});

check('a pick em prints as PK and a missing line prints as nothing', () => {
    const api = setup({});
    const pickem = { away: 'Rams', home: 'Seahawks', spread: 0, favorite: 'home' };
    const noLine = { away: 'Rams', home: 'Seahawks', spread: null, favorite: null };
    const laid   = { away: 'Rams', home: 'Seahawks', spread: 3.5, favorite: 'home' };
    assert.strictEqual(api.signedSpreadDisplay(pickem, 'home'), 'PK');
    assert.strictEqual(api.signedSpreadDisplay(pickem, 'away'), 'PK');
    assert.strictEqual(api.signedSpreadDisplay(noLine, 'home'), '',
        'blank - not "0" and not "+0"');
    assert.strictEqual(api.signedSpreadDisplay(laid, 'home'), '-3.5');
    assert.strictEqual(api.signedSpreadDisplay(laid, 'away'), '+3.5');
});

check('applySavedSpreads fills a line-less game and leaves a real pick em alone', () => {
    const api = setup({ weeks: { 1: [
        { id: 1, away: 'Saints', home: 'Lions', spread: null, favorite: null },
        { id: 2, away: 'Rams', home: 'Seahawks', spread: 0, favorite: 'home' }
    ] } });
    api.saveSpread(1, 'Saints', 'Lions', 7, 'home');
    api.saveSpread(1, 'Rams', 'Seahawks', 6, 'away');
    api.applySavedSpreads();
    const [lions, hawks] = api.NFL_GAMES_BY_WEEK[1];
    assert.strictEqual(lions.spread, 7, 'the game with no line takes the saved one');
    assert.strictEqual(lions.favorite, 'home');
    assert.strictEqual(hawks.spread, 0, 'a real pick em is a line and is not overwritten');
    assert.strictEqual(hawks.favorite, 'home');
});

check('a blank saved spread is never copied onto a game', () => {
    const api = setup({ weeks: { 1: [
        { id: 1, away: 'Saints', home: 'Lions', spread: null, favorite: null }
    ] } });
    api.saveSpread(1, 'Saints', 'Lions', '', '');
    api.applySavedSpreads();
    assert.strictEqual(api.hasUsableSpread(api.NFL_GAMES_BY_WEEK[1][0]), false,
        'a blank cell is not a line and must leave the game unscoreable');
});

section('Year Chg: this season against the same point last year');

// The column existed since the workbook days and had been blank all of 2026:
// standingsFromComputed hardcoded yearChange to ''. The workbook fed it from
// CSV column 10 (parser.js) and the computed engine never replaced it.
//
// It is now the same engine run twice - calculateStatsForWeeks takes a season -
// so last season is scored exactly the way this one is, over the same weeks.

// A tiny archived season to compare against. Two weeks, one game each.
function archive(year, api, { wins }) {
    const games = {
        1: [{ id: 1, away: 'Rams', home: 'Seahawks', spread: 3, favorite: 'home' }],
        2: [{ id: 1, away: 'Jets', home: 'Bills', spread: 3, favorite: 'home' }]
    };
    // home covers in week 1, home fails to cover in week 2.
    const results = {
        1: { 1: { winner: 'home', awayScore: 10, homeScore: 20 } },
        2: { 1: { winner: 'home', awayScore: 20, homeScore: 21 } }
    };
    // `wins` picks the covering side in week 1; the other picker takes the dog.
    const picks = {
        1: { Stephen: { rams_seahawks: { line: wins ? 'home' : 'away' } } },
        2: { Stephen: { jets_bills: { line: 'away' } } }   // away covers -> win
    };
    api.seasonData[year] = { games, results, picks, __pickKeysNormalized: true };
}

check('calculateStatsForWeeks can score a season other than the live one', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'away' } } } }   // a LOSS this season
    });
    archive(api.CURRENT_SEASON - 1, api, { wins: true });                // a WIN last season

    const live = api.calculateStatsForWeeks(1, 1).Stephen.line;
    const past = api.calculateStatsForWeeks(1, 1, undefined,
        { season: api.CURRENT_SEASON - 1 }).Stephen.line;
    assert.deepStrictEqual(live, { wins: 0, losses: 1, pushes: 0 }, 'live season');
    assert.deepStrictEqual(past, { wins: 1, losses: 0, pushes: 0 }, 'archived season');
});

check('the week range applies to the archived season too', () => {
    const api = setup({});
    archive(api.CURRENT_SEASON - 1, api, { wins: true });
    const one = api.calculateStatsForWeeks(1, 1, undefined, { season: api.CURRENT_SEASON - 1 });
    const both = api.calculateStatsForWeeks(1, 2, undefined, { season: api.CURRENT_SEASON - 1 });
    assert.deepStrictEqual(one.Stephen.line, { wins: 1, losses: 0, pushes: 0 });
    assert.deepStrictEqual(both.Stephen.line, { wins: 2, losses: 0, pushes: 0 },
        'week 2 is a second win, so the range really is being honoured');
});

check('priorSeasonStats is null until the archive is loaded', () => {
    const api = setup({});
    assert.strictEqual(api.priorSeasonStats(1, 1), null,
        'nothing loaded - no comparison, rather than a comparison against zero');
    archive(api.CURRENT_SEASON - 1, api, { wins: true });
    assert.ok(api.priorSeasonStats(1, 1), 'loaded - a comparison is available');
});

check('Year Chg is the win-percentage delta over the same weeks', () => {
    // This season: 1 from 2 = 50%. Last season: 2 from 2 = 100%. Down 50.
    const api = setup({
        weeks: {
            1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })],
            2: [game(1, 'Jets', 'Bills', { completed: true, awayScore: 20, homeScore: 21 })]
        },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home' } } },  // covers -> win
            2: { Stephen: { jets_bills: { line: 'home' } } }      // does not cover -> loss
        }
    });
    archive(api.CURRENT_SEASON - 1, api, { wins: true });
    const rows = api.standingsFromComputed(
        api.calculateStatsForWeeks(1, 2), 'line', api.priorSeasonStats(1, 2));
    assert.strictEqual(rows.Stephen.yearChange, '▼50.0%');
});

check('a climb reads as an up arrow', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }   // 100% this season
    });
    archive(api.CURRENT_SEASON - 1, api, { wins: false });               // 0% in week 1 last season
    const rows = api.standingsFromComputed(
        api.calculateStatsForWeeks(1, 1), 'line', api.priorSeasonStats(1, 1));
    assert.strictEqual(rows.Stephen.yearChange, '▲100.0%');
});

check('level reads as even, not as a fall', () => {
    // The old class logic had no branch for level and the card view defaulted
    // everything that was not an up arrow to 'down'.
    const api = setup({});
    assert.strictEqual(api.yearChangeFor({ wins: 1, losses: 1, pushes: 0 },
                                         { wins: 2, losses: 2, pushes: 0 }), 'even');
});

check('no comparison is blank, never a zero', () => {
    const api = setup({});
    const rec = { wins: 1, losses: 1, pushes: 0 };
    const empty = { wins: 0, losses: 0, pushes: 0 };
    assert.strictEqual(api.yearChangeFor(rec, null), '', 'no prior season');
    assert.strictEqual(api.yearChangeFor(rec, empty), '',
        'prior season has nothing decided - a picker who was not playing');
    assert.strictEqual(api.yearChangeFor(empty, rec), '',
        'nothing decided yet this season');
    // Blank matters: the card view drops the whole row on a falsy yearChange,
    // and a '0.0%' would claim they held level when nobody knows.
});

check('standings still render with no prior season at all', () => {
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    const rows = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'line');
    assert.strictEqual(rows.Stephen.yearChange, '', 'blank, and nothing thrown');
    assert.strictEqual(rows.Stephen.wins, 1, 'the rest of the row is unaffected');
});

check('each category is compared against its own counterpart', () => {
    // Blazin' against Blazin', not against the line record.
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home', blazin: true } } } }
    });
    archive(api.CURRENT_SEASON - 1, api, { wins: false });
    const prior = api.priorSeasonStats(1, 1);
    const line = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'line', prior);
    const blazin = api.standingsFromComputed(api.calculateStatsForWeeks(1, 1), 'blazin', prior);
    assert.strictEqual(line.Stephen.yearChange, '▲100.0%', 'line: 100% vs 0%');
    assert.strictEqual(blazin.Stephen.yearChange, '',
        'no starred picks in the archive, so no Blazin comparison to draw');
});

check('the sheet cache is not merged into an archived season', () => {
    // weeklyPicksCache holds the LIVE season's rows. Merged into an archive its
    // keys would land on that year's games and invent picks nobody made.
    const api = setup({
        cache: { 1: { picks: { Stephen: { rams_seahawks: { line: 'away' } } } } }
    });
    archive(api.CURRENT_SEASON - 1, api, { wins: true });
    const past = api.calculateStatsForWeeks(1, 1, undefined,
        { season: api.CURRENT_SEASON - 1 }).Stephen.line;
    assert.deepStrictEqual(past, { wins: 1, losses: 0, pushes: 0 },
        "the archive's own pick wins; the cached 'away' must not override it");
});

check('the card rules for a year comparison stay off the standings table', () => {
    // .year-change is on two unrelated things: the picker card's label+value
    // row, and the standings table's <td>. Unscoped, the card's
    // `display: flex; justify-content: space-between` reached the cell, where
    // it overrode display: table-cell and pinned the lone text child left -
    // 47px off centre at desktop width, under a centred header, with
    // text-align: center powerless to do anything about it.
    const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    const unscoped = styles.match(/^\.(year-change|betting-winnings)[^{]*\{/gm) || [];
    assert.deepStrictEqual(unscoped, [],
        'scope these to .year-comparison - they must not reach .standings-table td');
});

check('the standings Year Chg cell is a plain centred table cell', () => {
    const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    const block = styles.match(/\.standings-table \.year-change \{[^}]*\}/);
    assert.ok(block, 'found the rule');
    assert.ok(/text-align:\s*center/.test(block[0]), 'centred, like its header');
    assert.ok(!/display:\s*flex/.test(block[0]), 'a table cell, not a flex row');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
