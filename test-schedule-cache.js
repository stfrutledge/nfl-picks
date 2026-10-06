// Tests for the per-week schedule cache when ESPN cannot be reached.
//
// An expired cached schedule used to be deleted the moment it was read, before
// the fetch that might replace it - so when ESPN failed, the stale fallback
// found nothing and the week came back empty. That is how the October 2026
// ESPN outage blanked weeks on a phone that had them. Now the expired copy is
// kept until a fresh one replaces it, and served when ESPN fails.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

const NOW = '2026-10-07T16:00:00Z';

function makeEnv(fetchImpl) {
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
            addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild() {} }, body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false, addEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    const src = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8')
        + '\nconst HISTORICAL_DATA_SEASON=2026,HISTORICAL_GAMES={},HISTORICAL_RESULTS={},HISTORICAL_PICKS={};\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + `;return { fetchNFLSchedule, getCachedSchedule, cacheSchedule, SCHEDULE_CACHE_KEY,
            SCHEDULE_CACHE_VERSION, SCHEDULE_CACHE_DURATION, CURRENT_SEASON };`;
    const api = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date', src)(
        env.window, env.document, env.localStorage, env.navigator, (...a) => fetchImpl(...a), env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia, fixedClock(NOW));
    return { api, store };
}

// Two games, stored in the wrong order to show the cache is re-sorted.
const GAMES = [
    { id: 7, away: 'Bills', home: 'Chiefs', day: 'x', kickoff: '2026-10-11T20:25:00Z', spread: 3, favorite: 'home' },
    { id: 9, away: 'Rams', home: 'Seahawks', day: 'x', kickoff: '2026-10-11T17:00:00Z', spread: null, favorite: null }
];

function seed(api, store, { ageMs, version = api.SCHEDULE_CACHE_VERSION, data = GAMES }) {
    store.set(`${api.SCHEDULE_CACHE_KEY}_${api.CURRENT_SEASON}_week5`, JSON.stringify({
        timestamp: Date.parse(NOW) - ageMs, version, data: JSON.parse(JSON.stringify(data))
    }));
}

const espnDown = async () => { throw new TypeError('Failed to fetch'); };
const HOURS = 60 * 60 * 1000;

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
    await check('an expired schedule is kept when read, not deleted', async () => {
        const { api, store } = makeEnv(espnDown);
        seed(api, store, { ageMs: api.SCHEDULE_CACHE_DURATION + HOURS });
        assert.strictEqual(api.getCachedSchedule(5), null, 'a miss, so a fresh fetch is tried');
        assert.strictEqual(store.size, 1, 'but the copy is still there');
    });

    await check('ESPN down: the week comes from the expired copy, not empty', async () => {
        const { api, store } = makeEnv(espnDown);
        seed(api, store, { ageMs: 3 * 24 * HOURS });
        const games = await api.fetchNFLSchedule(5);
        assert.ok(Array.isArray(games) && games.length === 2, `got ${JSON.stringify(games)}`);
        assert.deepStrictEqual(games.map(g => g.away), ['Rams', 'Bills'], 'in kickoff order');
        assert.deepStrictEqual(games.map(g => g.id), [1, 2], 'ids reassigned as a fresh load would');
    });

    await check('a stale copy from an old cache version is not used', async () => {
        // Old versions hold spread: 0 placeholders that would read as pick'ems.
        const { api, store } = makeEnv(espnDown);
        seed(api, store, { ageMs: 3 * HOURS, version: api.SCHEDULE_CACHE_VERSION - 1 });
        assert.strictEqual(await api.fetchNFLSchedule(5), null);
    });

    await check('nothing cached and ESPN down: no games, not a crash', async () => {
        const { api } = makeEnv(espnDown);
        assert.strictEqual(await api.fetchNFLSchedule(5), null);
    });

    await check('a fresh copy is served without asking ESPN', async () => {
        let asked = 0;
        const { api, store } = makeEnv(async () => { asked++; throw new Error('should not be called'); });
        seed(api, store, { ageMs: 10 * 60 * 1000 });
        const games = await api.fetchNFLSchedule(5);
        assert.strictEqual(games.length, 2);
        assert.strictEqual(asked, 0);
    });

    if (failures > 0) {
        console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
        process.exit(1);
    }
    console.log(`\nALL ${total} CHECKS PASSED\n`);
})();
