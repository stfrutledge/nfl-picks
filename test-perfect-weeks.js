// Tests for the Perfect Weeks card.
//
// A 5-0 Blazin' 5 week is the thing the group brags about, so the Insights
// panel counts them per picker, across every season, and names the last one.
// What is worth guarding: a perfect week is strictly five wins and nothing
// else (a push is not a win), a season is scored off the same per-week
// breakdown the standings use whether it is live or archived, Cowherd's come
// from his archived weekly record, the card draws what it has while the
// archives load, and it is only on the Blazin' 5 sub-tab.
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
    const scripts = [];
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
            // A script element that is never run: an archive asked for stays
            // pending, which is what the card has to cope with.
            createElement: tag => { const el = { tag, style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }; if (tag === 'script') scripts.push(el); return el; },
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
        COWHERD, PERFECT_BLAZIN_WINS, CURRENT_SEASON, AVAILABLE_SEASONS, seasonData,
        perfectBlazinWeeks, perfectBlazinWeeksAllTime, renderPerfectWeeksCard, saveCowherdPicks,
        togglePerfectWeeks, perfectWeeksExpanded, setPerfectWeeksSort, comparePerfectWeeks,
        __sort: () => perfectWeeksSort,
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
    api.__window = env;
    api.__scripts = scripts;
    return api;
}

const TEAMS = [['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins'], ['Lions', 'Bears'], ['Eagles', 'Giants']];

/**
 * One week of five games, home -3 in each, with a result per game given as
 * the home margin: 7 covers, 3 pushes, -7 loses.
 */
function weekData(weekNum, margins) {
    const games = TEAMS.map(([away, home], i) => ({
        id: weekNum * 10 + i, away, home, spread: 3, favorite: 'home',
        day: 'Sun', time: '1:00 PM', kickoff: '2020-01-01T18:00:00Z',
        status: 'STATUS_FINAL', completed: true
    }));
    const results = {};
    games.forEach((g, i) => {
        const margin = margins[i];
        results[g.id] = { awayScore: 20, homeScore: 20 + margin, winner: margin > 0 ? 'home' : 'away' };
    });
    return { games, results };
}

function liveWeek(api, weekNum, margins) {
    const { games, results } = weekData(weekNum, margins);
    api.NFL_GAMES_BY_WEEK[weekNum] = games;
    api.NFL_RESULTS_BY_WEEK[weekNum] = results;
}

/** Five starred picks on a side, keyed the way the app keys them. */
const five = side => Object.fromEntries(TEAMS.map(([away, home]) =>
    [`${away.toLowerCase()}_${home.toLowerCase()}`, { line: side, winner: side, blazin: true }]));

// Weeks 1 and 2 only: the live season reads regularSeasonWeekRange(), whose
// far end is CURRENT_NFL_WEEK off the clock, so a later week would not be in
// range.
function setup() {
    const api = makeAppEnv();
    liveWeek(api, 1, [7, 7, 7, 7, 7]);      // home covers all five
    liveWeek(api, 2, [7, 7, 7, 7, 3]);      // four covers and a push
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

/**
 * Last season, archived: week 3 Stephen and Sean both 5-0, week 9 Sean
 * 5-0 again. Cowherd's archived record has a 5-0 in week 5.
 */
function archivePriorSeason(api) {
    const prior = api.CURRENT_SEASON - 1;
    const w3 = weekData(3, [7, 7, 7, 7, 7]);
    const w9 = weekData(9, [-7, -7, -7, -7, -7]);
    api.seasonData[prior] = {
        games: { 3: w3.games, 9: w9.games },
        results: { 3: w3.results, 9: w9.results },
        picks: { 3: { Stephen: five('home'), Sean: five('home') }, 9: { Sean: five('away'), Stephen: five('home') } },
        __pickKeysNormalized: true
    };
    api.__window[`COWHERD_${prior}_RESULTS`] = {
        4: { wins: 3, losses: 2, pushes: 0 },
        5: { wins: 5, losses: 0, pushes: 0 }
    };
    return prior;
}

/** Every other archive present but empty, so nothing is missing. */
function fillRemainingSeasons(api) {
    api.AVAILABLE_SEASONS.forEach(s => {
        if (s !== api.CURRENT_SEASON && !api.seasonData[s]) {
            api.seasonData[s] = { games: {}, results: {}, picks: {}, __pickKeysNormalized: true };
        }
    });
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

section('It is all-time, season by season');

check('an archived season is scored the same way, and Cowherd’s comes from his record', () => {
    const api = setup();
    const prior = archivePriorSeason(api);
    const weeks = api.perfectBlazinWeeks(prior);
    assert.deepStrictEqual(weeks.Stephen, [3], 'week 9 he was 0-5');
    assert.deepStrictEqual(weeks.Sean, [3, 9]);
    assert.deepStrictEqual(weeks[api.COWHERD], [5]);
});

check('the seasons fold together, oldest first, with the last one to hand', () => {
    const api = setup();
    const prior = archivePriorSeason(api);
    const { byPicker, missing } = api.perfectBlazinWeeksAllTime();
    assert.strictEqual(byPicker.Stephen.count, 2);
    assert.deepStrictEqual(byPicker.Stephen.last, { season: api.CURRENT_SEASON, week: 1 });
    assert.deepStrictEqual(byPicker.Stephen.weeks, [{ season: prior, week: 3 }, { season: api.CURRENT_SEASON, week: 1 }]);
    assert.strictEqual(byPicker.Sean.count, 2);
    assert.deepStrictEqual(byPicker.Sean.last, { season: prior, week: 9 }, 'nothing this season, so last season’s');
    assert.deepStrictEqual(byPicker[api.COWHERD].last, { season: prior, week: 5 });
    assert.strictEqual(byPicker.Daniel.count, 0);
    assert.strictEqual(byPicker.Daniel.last, null);
    assert.ok(missing.length > 0, 'the other archives are not in');
    assert.ok(!missing.includes(prior) && !missing.includes(api.CURRENT_SEASON));
});

check('a season archived as an aggregate says nothing about Cowherd', () => {
    const api = setup();
    const old = api.CURRENT_SEASON - 4;
    api.seasonData[old] = { games: {}, results: {}, picks: {}, __pickKeysNormalized: true };
    api.__window[`COWHERD_${old}_RESULTS`] = { aggregate: { wins: 44, losses: 37, pushes: 4 } };
    assert.ok(!(api.COWHERD in api.perfectBlazinWeeks(old)));
});

section('The card is on the Blazin’ 5 sub-tab, and only there');

check('it lists everyone, most perfect weeks first, naming the last one', () => {
    const api = setup();
    archivePriorSeason(api);
    fillRemainingSeasons(api);
    api.renderPerfectWeeksCard();
    assert.ok(!api.__node('perfect-weeks-card').classList.contains('hidden'));
    const html = api.__written['perfect-weeks-card'];
    assert.match(html, /5-0 Blazin' 5 Weeks/);
    assert.match(html, /insight-subtitle">All seasons</);
    assert.match(html, /insight-header insight-image-header[\s\S]*?<img src="blazin-5.png"[^>]*class="insight-image"/, 'a picture in the header, as the lone wolf card has');
    const header = html.split('perfect-weeks-list')[0];
    assert.match(header, /perfect-weeks-sorts[\s\S]*?Last[\s\S]*?Total/, 'the sort controls are in the header, above the line');
    assert.doesNotMatch(html.split('perfect-weeks-list')[1], /perfect-weeks-sort/, 'and not in the list');
    assert.ok(fs.existsSync(path.join(__dirname, 'blazin-5.png')), 'and the picture is in the repo');
    const names = [...html.matchAll(/lone-wolf-name">(\w+)</g)].map(m => m[1]);
    assert.strictEqual(names.length, 6, 'five pickers and Cowherd');
    assert.deepStrictEqual(names.slice(0, 2), ['Stephen', 'Sean'], 'two each; Stephen’s is the more recent');
    assert.match(html, /perfect-weeks-row leader [\s\S]*?Stephen[\s\S]*?perfect-weeks-last">\d{4} Wk 1<[\s\S]*?perfect-weeks-count">2</, 'one line: name, last, total');
    assert.match(html, /Daniel[\s\S]*?perfect-weeks-last">&ndash;<[\s\S]*?perfect-weeks-count">0</, 'never: a dash');
    assert.doesNotMatch(html, /lone-wolf-rank/, 'no rank column');
    assert.doesNotMatch(html, /Loading/);
});

check('it draws what it has while the archives load, and asks for them once', () => {
    const api = setup();
    api.renderPerfectWeeksCard();
    const html = api.__written['perfect-weeks-card'];
    assert.match(html, /Loading \d+ earlier seasons/);
    assert.match(html, /Stephen[\s\S]*?perfect-weeks-count">1</, 'this season is already counted');
    const asked = api.__scripts.length;
    assert.ok(asked > 0, 'the archives were requested');
    api.renderPerfectWeeksCard();
    assert.strictEqual(api.__scripts.length, asked, 'and not requested again on the next draw');
});

check('a name opens onto the weeks, newest first, and stays open through a redraw', () => {
    const api = setup();
    archivePriorSeason(api);
    fillRemainingSeasons(api);
    api.renderPerfectWeeksCard();
    let html = api.__written['perfect-weeks-card'];
    assert.doesNotMatch(html, /perfect-weeks-detail/, 'closed to begin with');
    assert.match(html, /openable[^>]*onclick="togglePerfectWeeks\('Stephen'\)"/, 'a row with weeks is clickable');
    assert.doesNotMatch(html, /onclick="togglePerfectWeeks\('Daniel'\)"/, 'one without is not');

    api.togglePerfectWeeks('Stephen');
    html = api.__written['perfect-weeks-card'];
    const chips = [...html.matchAll(/perfect-week-chip">(\d{4} Wk \d+)</g)].map(m => m[1]);
    assert.deepStrictEqual(chips, [`${api.CURRENT_SEASON} Wk 1`, `${api.CURRENT_SEASON - 1} Wk 3`], 'his two, newest first');
    assert.match(html, /Stephen[\s\S]*?perfect-weeks-detail/, 'under his row');
    assert.doesNotMatch(html, /Sean[\s\S]*?perfect-weeks-detail[\s\S]*?Daniel/, 'nobody else\u2019s is open');

    api.renderPerfectWeeksCard();
    assert.match(api.__written['perfect-weeks-card'], /perfect-weeks-detail/, 'still open after a redraw');

    api.togglePerfectWeeks('Stephen');
    assert.doesNotMatch(api.__written['perfect-weeks-card'], /perfect-weeks-detail/, 'and closes again');
});

check('it sorts by total by default, and by last on request', () => {
    const api = setup();
    archivePriorSeason(api);
    fillRemainingSeasons(api);
    api.renderPerfectWeeksCard();
    const names = html => [...html.matchAll(/lone-wolf-name">(\w+)</g)].map(m => m[1]);
    assert.strictEqual(api.__sort(), 'total');
    let html = api.__written['perfect-weeks-card'];
    assert.match(html, /perfect-weeks-sort perfect-weeks-count"[^>]*onclick="setPerfectWeeksSort\('total'\)"/, 'Total is a control');
    assert.doesNotMatch(html, /active/, 'and nothing is marked as the one in use');
    // Stephen 2 (last this season), Sean 2 (last season), Cowherd 1, then the rest.
    assert.deepStrictEqual(names(html).slice(0, 3), ['Stephen', 'Sean', 'Cowherd']);

    api.setPerfectWeeksSort('last');
    html = api.__written['perfect-weeks-card'];
    assert.match(html, /perfect-weeks-sort perfect-weeks-last"[^>]*onclick="setPerfectWeeksSort\('last'\)"/, 'Last is a control');
    // Stephen this season wk 1; then last season: Sean wk 9, Cowherd wk 5.
    assert.deepStrictEqual(names(html).slice(0, 3), ['Stephen', 'Sean', 'Cowherd']);
    assert.ok(names(html).indexOf('Daniel') > 2, 'never is at the bottom');

    api.setPerfectWeeksSort('bogus');
    assert.strictEqual(api.__sort(), 'last', 'an unknown sort is ignored');
    api.setPerfectWeeksSort('total');
    assert.strictEqual(api.__sort(), 'total');
});

check('by last, a more recent week beats a bigger total', () => {
    const api = setup();
    const cmp = (a, b, sort) => api.comparePerfectWeeks(a, b, sort);
    const many = { count: 5, last: { season: 2020, week: 3 } };
    const recent = { count: 1, last: { season: 2025, week: 9 } };
    const never = { count: 0, last: null };
    assert.ok(cmp(many, recent, 'total') < 0, 'by total the five come first');
    assert.ok(cmp(recent, many, 'last') < 0, 'by last the 2025 week comes first');
    assert.ok(cmp(never, recent, 'last') > 0, 'never goes last');
    assert.ok(cmp(never, recent, 'total') > 0, 'either way');
});

check('nobody yet says so, and nobody leads', () => {
    const api = setup();
    fillRemainingSeasons(api);
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
