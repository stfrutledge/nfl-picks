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
        AVAILABLE_SEASONS, historyLifetimeRange, setHistoryLifetimeRange,
        historyLifetimeSeasons, historyLifetimeTitle, renderLifetimeStandingsTable,
        toggleHistoryLifetimeFilter,
        EXPANSION_SEASON, historyStatsAcrossSeasons, historyRecordCell, historyNetSeries,
        historyNetChartData, historyNetReadoutHtml, renderHistoryNetChart, refreshLiveHistoryView, historyLifetimeSpan, setHistoryLifetimeSpan,
        historyNetPickerButtonsHtml, historyNetVisibleData,
        __hideNetPicker: p => { historyNetHidden.add(p); },
        __setSeasonData: (season, data) => { seasonData[season] = data; },
        __setNetCategory: c => { historyNetCategory = c; },
        __scope: () => historyStandingsScope,
        __week: () => historyStandingsWeek,
        __setWeek: w => { historyStandingsWeek = w; },
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __getPicks: () => allPicks,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
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

section('Lifetime spans the seasons chosen');

check('by default it is every season, titled "Lifetime"', () => {
    const api = setup();
    assert.deepStrictEqual(api.historyLifetimeSeasons(), api.AVAILABLE_SEASONS);
    assert.strictEqual(api.historyLifetimeTitle(), 'Lifetime');
});

check('a range keeps only its seasons, both ends included', () => {
    const api = setup();
    api.setHistoryLifetimeRange(2019, 2022);
    assert.deepStrictEqual(api.historyLifetimeSeasons(), [2022, 2021, 2020, 2019]);
    assert.strictEqual(api.historyLifetimeTitle(), '2019–2022');
    api.setHistoryLifetimeRange(2021, 2021);
    assert.deepStrictEqual(api.historyLifetimeSeasons(), [2021]);
    assert.strictEqual(api.historyLifetimeTitle(), '2021');
});

check('crossed ends: the one that was moved wins', () => {
    const api = setup();
    const ends = () => [api.historyLifetimeRange().from, api.historyLifetimeRange().to];
    api.setHistoryLifetimeRange(2018, 2020);
    api.setHistoryLifetimeRange(2023, 2020, 'from');
    assert.deepStrictEqual(ends(), [2023, 2023]);
    api.setHistoryLifetimeRange(2023, 2017, 'to');
    assert.deepStrictEqual(ends(), [2017, 2017]);
});

check('ends are held to the seasons there are, and the full span reads "Lifetime" again', () => {
    const api = setup();
    api.setHistoryLifetimeRange(1999, 3000);
    const { from, to, min, max } = api.historyLifetimeRange();
    assert.deepStrictEqual([from, to], [min, max]);
    assert.strictEqual(api.historyLifetimeTitle(), 'Lifetime');
});

check('the dropdowns are filled oldest first, with the range selected', () => {
    const api = setup();
    api.setHistoryLifetimeRange(2019, 2022);
    assert.match(api.__written['history-lifetime-from'], /^<option value="2016"/);
    assert.match(api.__written['history-lifetime-from'], /value="2019" selected/);
    assert.match(api.__written['history-lifetime-to'], /value="2022" selected/);
});

check('the filter button shows on Lifetime only', () => {
    const api = setup();
    const btn = api.__node('history-lifetime-filter');
    api.updateHistoryScopeControls(null);
    assert.ok(!btn.classList.contains('hidden'));
    api.updateHistoryScopeControls(api.CURRENT_SEASON);
    assert.ok(btn.classList.contains('hidden'));
});

check('the range shows only once the filter button is on, and only on Lifetime', () => {
    const api = setup();
    const range = api.__node('history-lifetime-range');
    const btn = api.__node('history-lifetime-filter');
    api.__node('history-season-dropdown').value = 'lifetime';
    api.updateHistoryScopeControls(null);
    assert.ok(range.classList.contains('hidden'), 'closed by default');

    api.toggleHistoryLifetimeFilter();
    assert.ok(!range.classList.contains('hidden'), 'opened by the button');
    assert.ok(btn.classList.contains('active'));

    api.updateHistoryScopeControls(api.CURRENT_SEASON);
    assert.ok(range.classList.contains('hidden'), 'a single season never shows it');

    api.updateHistoryScopeControls(null);
    api.toggleHistoryLifetimeFilter();
    assert.ok(range.classList.contains('hidden'), 'closed again by the button');
    assert.ok(!btn.classList.contains('active'));
});

check('a closed filter still marks the button while a range is applied', () => {
    const api = setup();
    const btn = api.__node('history-lifetime-filter');
    api.setHistoryLifetimeRange(2020, 2023);
    api.updateHistoryScopeControls(null);
    assert.ok(btn.classList.contains('filtered'));
    api.setHistoryLifetimeRange(2000, 3000);
    api.updateHistoryScopeControls(null);
    assert.ok(!btn.classList.contains('filtered'), 'every season is no filter');
});

check('the table is titled by its span, without "Season"', () => {
    const api = setup();
    api.__written['history-standings-scope-label:text'] = 'Week 2';
    api.setHistoryLifetimeRange(2019, 2022);
    api.renderLifetimeStandingsTable();
    assert.strictEqual(api.__written['history-standings-title:text'], '2019–2022');
    assert.strictEqual(api.__written['history-standings-scope-label:text'], '');
});

section('Each category is one cell: win %, record, net wins');

check('a cell stacks the percentage, the record and the net', () => {
    const api = setup();
    const cell = api.historyRecordCell(12, 9, 2);
    assert.match(cell, /57\.1%/);
    assert.match(cell, />12-9-2</);
    assert.match(cell, /history-net positive">\+3<span class="history-net-word"> net<\/span></);
    assert.match(api.historyRecordCell(4, 6, 0), /history-net negative">−2<span class="history-net-word"> net<\/span></);
    assert.match(api.historyRecordCell(5, 5, 0), /history-net ">0<span class="history-net-word"> net<\/span></, 'level is neither colour');
});

check('a category with no picks is a lone dash, not 0 net', () => {
    const api = setup();
    const cell = api.historyRecordCell(0, 0, 0);
    assert.match(cell, />-</);
    assert.ok(!/class="history-net/.test(cell), 'no net line');
    assert.match(cell, /data-sort-net=""/, 'and sorts as nothing');
});

check('the table is four columns: picker and three categories', () => {
    const api = setup();
    api.renderHistoryStandingsTable(api.CURRENT_SEASON);
    const row = api.__written['history-standings-table-body'].split('data-picker="Stephen"')[1].split('</tr>')[0];
    assert.strictEqual((row.match(/<td/g) || []).length, 4);
});

// An archived 2022 with one game, which Daniel and Jason did not play.
// Bears @ Packers, Packers -3, 10-27: home covers.
function withArchive(api) {
    api.__setSeasonData(2022, {
        games: { 1: [finalGame(1, 'Bears', 'Packers', 10, 27)] },
        results: { 1: { 1: { awayScore: 10, homeScore: 27, winner: 'home' } } },
        picks: { 1: {
            Stephen: { bears_packers: { line: 'home', winner: 'home' } },
            Sean: { bears_packers: { line: 'away', winner: 'away' } },
            Dylan: { bears_packers: { line: 'home', winner: 'home', blazin: true } }
        } }
    });
    return api;
}

section('Lifetime is the season tables added up');

check('every record is the sum of its seasons', () => {
    const api = withArchive(setup());
    const life = api.historyStatsAcrossSeasons(api.AVAILABLE_SEASONS);
    assert.strictEqual(rec(life.Stephen), '2-1-0', '1-0 in 2022, 1-1 now');
    assert.strictEqual(rec(life.Sean), '0-2-0');
    assert.strictEqual(rec(life.Dylan), '1-0-0');
    assert.strictEqual(life.Dylan.blazinWins, 1);
    assert.strictEqual(life.Stephen.blazinWins, 1);
});

check('the Lifetime table shows the summed record and its net', () => {
    const api = withArchive(setup());
    api.renderLifetimeStandingsTable();
    const row = api.__written['history-standings-table-body'].split('data-picker="Stephen"')[1].split('</tr>')[0];
    assert.match(row, />2-1</);
    assert.match(row, /\+1<span class="history-net-word"> net<\/span>/);
});

check('Lifetime catches up when this season’s picks land after it was drawn', () => {
    const api = withArchive(setup());
    const picks = api.__getPicks();
    api.__setState({ allPicks: {}, currentCategory: 'history' });
    api.__node('history-season-dropdown').value = 'lifetime';
    api.renderLifetimeStandingsTable();
    let row = api.__written['history-standings-table-body'].split('data-picker="Stephen"')[1].split('</tr>')[0];
    assert.match(row, />1-0</, 'drawn with 2022 alone');
    api.__setState({ allPicks: picks });
    api.refreshLiveHistoryView();   // the Lifetime branch redraws without awaiting
    row = api.__written['history-standings-table-body'].split('data-picker="Stephen"')[1].split('</tr>')[0];
    assert.match(row, />2-1</, 'and redrawn with this season in it');
});

section('All Seasons or Since Expansion (2023)');

check('Since Expansion starts the range at the expansion season', () => {
    const api = withArchive(setup());
    assert.strictEqual(api.historyLifetimeSpan(), 'all');
    api.setHistoryLifetimeSpan('expansion');
    assert.strictEqual(api.historyLifetimeSpan(), 'expansion');
    assert.strictEqual(Math.min(...api.historyLifetimeSeasons()), api.EXPANSION_SEASON);
    api.setHistoryLifetimeSpan('all');
    assert.strictEqual(api.historyLifetimeTitle(), 'Lifetime');
});

check('any other range lights neither button', () => {
    const api = setup();
    api.setHistoryLifetimeRange(2019, 2022);
    assert.strictEqual(api.historyLifetimeSpan(), null);
});

section('Net wins over time');

check('each season adds its net to the running total', () => {
    const api = withArchive(setup());
    const series = api.historyNetSeries(api.AVAILABLE_SEASONS, 'line');
    assert.deepStrictEqual(series.Stephen.map(p => [p.season, p.net, p.total]),
        [[2022, 1, 1], [api.CURRENT_SEASON, 0, 1]]);
    assert.deepStrictEqual(series.Sean.map(p => [p.season, p.net, p.total]),
        [[2022, -1, -1], [api.CURRENT_SEASON, -1, -2]]);
});

check('a season with no decided picks is left out of a picker’s line', () => {
    const api = withArchive(setup());
    const series = api.historyNetSeries(api.AVAILABLE_SEASONS, 'line');
    assert.deepStrictEqual(series.Dylan.map(p => p.season), [2022], 'Dylan has no picks this season');
    assert.ok(!series.Daniel, 'nobody without a pick gets a line');
});

check('the chart has a label per played season and a running total per picker', () => {
    const api = withArchive(setup());
    const { labels, lines } = api.historyNetChartData(api.AVAILABLE_SEASONS, 'line');
    assert.deepStrictEqual(labels, ['2022', String(api.CURRENT_SEASON)], 'only seasons with a result');
    assert.deepStrictEqual(lines.Stephen, [{ total: 1, net: 1 }, { total: 1, net: 0 }]);
    assert.deepStrictEqual(lines.Sean, [{ total: -1, net: -1 }, { total: -2, net: -1 }]);
    assert.deepStrictEqual(lines.Dylan, [{ total: 1, net: 1 }, { total: 1, net: 0 }], 'carried through a season off');
});

check('the season in progress is left off until it has a result', () => {
    const api = withArchive(setup());
    api.__setState({ allPicks: {} });
    const { labels } = api.historyNetChartData(api.AVAILABLE_SEASONS, 'line');
    assert.deepStrictEqual(labels, ['2022'], 'not drawn as a level copy of last season');
});

check('the season table gives that season’s net and the total, best first', () => {
    const api = withArchive(setup());
    const data = api.historyNetChartData(api.AVAILABLE_SEASONS, 'line');
    const html = api.historyNetReadoutHtml(data, 0);
    assert.match(html, /net-readout-head">2022</);
    const order = [...html.matchAll(/<\/span>(\w+)<\/td>/g)].map(m => m[1]);
    assert.deepStrictEqual(order, ['Dylan', 'Stephen', 'Sean'], 'level totals keep their order, -1 last');
    assert.match(html, /Sean<\/td>\s*<td class="history-net negative">−1<\/td>\s*<td class="net-total">−1</);
    assert.match(api.historyNetReadoutHtml(data, 1), /\(so far\)/, 'the season in progress says so');
});

check('every picker has a button, pressed in while they are on the chart', () => {
    const api = withArchive(setup());
    api.__hideNetPicker('Sean');
    const html = api.historyNetPickerButtonsHtml(['Dylan', 'Sean', 'Stephen']);
    assert.match(html, /active" data-net-picker="Dylan" aria-pressed="true"/);
    assert.match(html, /chip" data-net-picker="Sean" aria-pressed="false"/);
    assert.match(html, /active" data-net-picker="Stephen" aria-pressed="true"/);
});

check('a picker switched off leaves the chart and the season table', () => {
    const api = withArchive(setup());
    api.__hideNetPicker('Sean');
    const data = api.historyNetVisibleData(api.historyNetChartData(api.AVAILABLE_SEASONS, 'line'));
    assert.deepStrictEqual(Object.keys(data.lines).sort(), ['Dylan', 'Stephen']);
    assert.ok(!/Sean/.test(api.historyNetReadoutHtml(data, 0)));
});

check('the chart shows on Lifetime and hides on a single season', () => {
    const api = withArchive(setup());
    const section = api.__node('history-net-section');
    api.__node('history-season-dropdown').value = 'lifetime';
    api.renderHistoryNetChart();
    assert.ok(!section.classList.contains('hidden'));
    api.__node('history-season-dropdown').value = String(api.CURRENT_SEASON);
    api.renderHistoryNetChart();
    assert.ok(section.classList.contains('hidden'));
});

check('a one-season range has no line to draw, so the chart hides', () => {
    const api = withArchive(setup());
    api.__node('history-season-dropdown').value = 'lifetime';
    api.setHistoryLifetimeRange(api.CURRENT_SEASON, api.CURRENT_SEASON);
    api.renderHistoryNetChart();
    assert.ok(api.__node('history-net-section').classList.contains('hidden'));
});

console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
