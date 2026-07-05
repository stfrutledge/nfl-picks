// Smoke test for the automatic offseason reset. Runs app.js in Node with browser stubs.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeEnv(prependSrc) {
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

    const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const exports = `;return ({
        CURRENT_SEASON, AVAILABLE_SEASONS, PICKS_STORAGE_KEY, CLEARED_PICKS_KEY,
        toSheetWeek, fromSheetWeek, NFL_GAMES_BY_WEEK, FALLBACK_SPREADS,
        HISTORICAL_GAMES, HISTORICAL_RESULTS, HISTORICAL_PICKS,
        allPicks, clearedPicks, NFL_RESULTS_BY_WEEK, CURRENT_NFL_WEEK,
        loadAllPicksFromBackup, loadAllResultsFromBackup, getGamesForWeek
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + prependSrc + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, env, store };
}

function countPicks(allPicks) {
    let n = 0;
    for (const week of Object.keys(allPicks)) {
        for (const picker of Object.keys(allPicks[week])) {
            n += Object.keys(allPicks[week][picker]).length;
        }
    }
    return n;
}

(async () => {
    // --- Scenario 1: current files as shipped (empty tagged snapshot) ---
    const hdSrc = fs.readFileSync(path.join(__dirname, 'historical-data.js'), 'utf8');
    const { api: a1, env: e1 } = makeEnv(hdSrc);

    assert.strictEqual(a1.CURRENT_SEASON, 2026, 'CURRENT_SEASON should be 2026 in July 2026');
    assert.strictEqual(a1.CURRENT_NFL_WEEK, 1, 'pre-season should sit on week 1');
    assert.deepStrictEqual(a1.AVAILABLE_SEASONS[0], 2026);
    assert.strictEqual(a1.AVAILABLE_SEASONS[a1.AVAILABLE_SEASONS.length - 1], 2016);
    assert.strictEqual(a1.PICKS_STORAGE_KEY, 'nflPicks_2026');
    assert.strictEqual(a1.CLEARED_PICKS_KEY, 'clearedPicks_2026');
    assert.strictEqual(a1.toSheetWeek(5), '2026_5');
    assert.strictEqual(a1.fromSheetWeek('2026_5'), 5);
    assert.strictEqual(a1.fromSheetWeek('18'), null, 'legacy 2025 rows must be ignored');
    assert.strictEqual(a1.fromSheetWeek('2025_18'), null, 'other-season rows must be ignored');
    assert.deepStrictEqual(Object.keys(a1.NFL_GAMES_BY_WEEK), [], 'no hardcoded games');
    assert.deepStrictEqual(Object.keys(a1.FALLBACK_SPREADS), [], 'no hardcoded spreads');
    assert.strictEqual(countPicks(a1.allPicks), 0, 'no picks at season start');
    assert.deepStrictEqual(a1.getGamesForWeek(17), [], 'no 2025 week 17 games in 2026 view');

    // Replay the real 2025 sheet backup (downloaded earlier) - none of it may leak in
    const allpicks = fs.readFileSync(path.join(process.env.TEMP, 'nfl-allpicks.json'), 'utf8');
    const allresults = fs.readFileSync(path.join(process.env.TEMP, 'nfl-allresults.json'), 'utf8');
    e1.fetch = async url => ({
        json: async () => JSON.parse(url.includes('allpicks') ? allpicks : allresults),
        text: async () => (url.includes('allpicks') ? allpicks : allresults)
    });
    await a1.loadAllPicksFromBackup();
    await a1.loadAllResultsFromBackup();
    assert.strictEqual(countPicks(a1.allPicks), 0, '2025 sheet picks must not leak into 2026');
    assert.deepStrictEqual(a1.clearedPicks, {}, '2025 cleared flags must not leak into 2026');
    for (const wk of Object.keys(a1.NFL_RESULTS_BY_WEEK)) {
        assert.deepStrictEqual(a1.NFL_RESULTS_BY_WEEK[wk], {}, '2025 sheet results must not leak into 2026');
    }
    console.log('Scenario 1 OK: clean 2026 slate, real 2025 sheet data ignored');

    // --- Scenario 2: stale snapshot from a previous season gets emptied in place ---
    const stale = `
        const HISTORICAL_DATA_SEASON = 2025;
        const HISTORICAL_GAMES = { 1: [{ id: 1, away: 'Cowboys', home: 'Eagles', spread: 8.5, favorite: 'home' }] };
        const HISTORICAL_RESULTS = { 1: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } } };
        const HISTORICAL_PICKS = { 1: { Stephen: { 1: { line: 'home', winner: 'home' } } } };
    `;
    const { api: a2 } = makeEnv(stale);
    assert.deepStrictEqual(Object.keys(a2.HISTORICAL_GAMES), [], 'stale games emptied');
    assert.deepStrictEqual(Object.keys(a2.HISTORICAL_RESULTS), [], 'stale results emptied');
    assert.deepStrictEqual(Object.keys(a2.HISTORICAL_PICKS), [], 'stale picks emptied');
    assert.deepStrictEqual(a2.getGamesForWeek(1), [], 'stale games must not reach the games view');
    assert.strictEqual(countPicks(a2.allPicks), 0, 'stale picks must not be merged');

    // --- Scenario 3: a snapshot tagged with the CURRENT season is used normally ---
    const fresh = stale.replace('HISTORICAL_DATA_SEASON = 2025', 'HISTORICAL_DATA_SEASON = 2026');
    const { api: a3 } = makeEnv(fresh);
    assert.strictEqual(a3.getGamesForWeek(1).length, 1, 'current-season snapshot games must merge');
    assert.ok(a3.allPicks[1] && a3.allPicks[1].Stephen && Object.keys(a3.allPicks[1].Stephen).length === 1,
        'current-season snapshot picks must merge');
    console.log('Scenarios 2+3 OK: stale snapshot cleared, current-season snapshot still merges');

    console.log('ALL TESTS PASSED');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
