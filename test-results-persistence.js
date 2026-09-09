// Tests for persisting game results to the Google Sheet backup.
//
// The principle: the backup sheet is the record we keep. ESPN is an upstream we
// do not control - it can go down, rate-limit, or stop serving a past season -
// so a score is only really ours once it is written to the sheet. Syncing only
// the current week (the old behaviour) meant a week nobody had open while its
// games finished was never written down, and was then gone for good.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeEnv() {
    const store = new Map();
    const posts = [];
    let failNext = false;
    const env = {
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k),
            key: i => Array.from(store.keys())[i] || null,
            get length() { return store.size; }
        },
        document: {
            addEventListener: () => {}, getElementById: () => null,
            querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : null;
            if (body && body.results) posts.push(body);
            return {
                ok: true,
                json: async () => (failNext ? { success: false, error: 'boom' } : { success: true }),
                text: async () => JSON.stringify({ success: true })
            };
        },
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
        unstoredResultsForWeek, postResultsToSheet, backfillResults,
        syncResultsToGoogleSheets, getGameResult, pickKey,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __setState: s => {
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, posts, failWrites: () => { failNext = true; } };
}

function finalGame(id, away, home, awayScore, homeScore) {
    return { id, away, home, spread: 3, favorite: 'home', completed: true, awayScore, homeScore };
}
function scheduledGame(id, away, home) {
    return { id, away, home, spread: 3, favorite: 'home' };
}

function setup(weeks = {}, stored = {}) {
    const h = makeEnv();
    for (const [w, g] of Object.entries(weeks)) h.api.NFL_GAMES_BY_WEEK[w] = g;
    for (const [w, r] of Object.entries(stored)) h.api.NFL_RESULTS_BY_WEEK[w] = r;
    h.api.__setState({ currentWeek: 3, currentPicker: 'Stephen' });
    return h;
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('What still needs writing down');

await check('a final game missing from the sheet is pending', async () => {
    const h = setup({ 1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)] });
    assert.deepStrictEqual(h.api.unstoredResultsForWeek(1), {
        rams_seahawks: { awayScore: 10, homeScore: 20 }
    });
});

await check('a result already in the sheet is not rewritten', async () => {
    const h = setup(
        { 1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)] },
        { 1: { 1: { winner: 'home', awayScore: 10, homeScore: 20 } } }
    );
    assert.deepStrictEqual(h.api.unstoredResultsForWeek(1), {});
});

await check('an unplayed game is not written', async () => {
    const h = setup({ 1: [scheduledGame(1, 'Rams', 'Seahawks')] });
    assert.deepStrictEqual(h.api.unstoredResultsForWeek(1), {});
});

await check('a week with no schedule loaded yields nothing', async () => {
    const h = setup({});
    assert.deepStrictEqual(h.api.unstoredResultsForWeek(1), {});
});

section('The whole season is persisted, not just the current week');

await check('past weeks nobody had open are still written down', async () => {
    // The bug this closes: weeks 1 and 2 finished while nobody was looking, so
    // under the old current-week-only sync they never reached the sheet.
    const h = setup({
        1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)],
        2: [finalGame(1, 'Bills', 'Chiefs', 24, 17)],
        3: [finalGame(1, 'Jets', 'Dolphins', 13, 10)]
    });
    const persisted = await h.api.backfillResults();
    assert.strictEqual(persisted, 3, 'every played week is written');
    const weeks = h.posts.map(p => String(p.week));
    assert.strictEqual(weeks.length, 3);
    assert.ok(weeks.every(w => /_/.test(w)), `weeks must be season-prefixed: ${weeks}`);
});

await check('a second pass writes nothing (the mirror stops re-posting)', async () => {
    const h = setup({ 1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)] });
    assert.strictEqual(await h.api.backfillResults(), 1);
    const after = h.posts.length;
    assert.strictEqual(await h.api.backfillResults(), 0, 'nothing left to persist');
    assert.strictEqual(h.posts.length, after, 'and no further writes');
});

await check('weeks with nothing pending are not posted at all', async () => {
    const h = setup({
        1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)],
        2: [scheduledGame(1, 'Bills', 'Chiefs')]
    });
    await h.api.backfillResults();
    assert.strictEqual(h.posts.length, 1, 'only the week with a real result');
});

section('A failed write must not be forgotten');

await check('results are not mirrored locally when the save fails', async () => {
    const h = setup({ 1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)] });
    h.failWrites();
    assert.strictEqual(await h.api.backfillResults(), 0, 'nothing reported as persisted');
    assert.deepStrictEqual(h.api.unstoredResultsForWeek(1), {
        rams_seahawks: { awayScore: 10, homeScore: 20 }
    }, 'still pending, so the next pass retries');
});

section('Once stored, the sheet is what gets read');

await check('a stored result wins over what ESPN currently says', async () => {
    // If ESPN later disagrees or disappears, the sheet still rules.
    const h = setup(
        { 1: [finalGame(1, 'Rams', 'Seahawks', 10, 20)] },
        { 1: { 1: { winner: 'away', awayScore: 31, homeScore: 3 } } }
    );
    const game = h.api.NFL_GAMES_BY_WEEK[1][0];
    const stored = h.api.NFL_RESULTS_BY_WEEK[1];
    const r = h.api.getGameResult(game, stored);
    assert.strictEqual(r.awayScore, 31, 'the sheet is the source of truth');
});

await check('results survive ESPN dropping the game entirely', async () => {
    const h = setup(
        { 1: [scheduledGame(1, 'Rams', 'Seahawks')] }, // ESPN no longer reports scores
        { 1: { 1: { winner: 'home', awayScore: 10, homeScore: 20 } } }
    );
    const game = h.api.NFL_GAMES_BY_WEEK[1][0];
    const r = h.api.getGameResult(game, h.api.NFL_RESULTS_BY_WEEK[1]);
    assert.ok(r, 'the stored result is still there');
    assert.strictEqual(r.homeScore, 20);
});

section('The live-refresh path uses the same persistence');

await check('syncResultsToGoogleSheets writes a newly final game', async () => {
    const h = setup({ 3: [finalGame(1, 'Jets', 'Dolphins', 13, 10)] });
    assert.strictEqual(await h.api.syncResultsToGoogleSheets(3, 'ESPN'), 1);
    assert.strictEqual(h.posts[0].source, 'ESPN');
});

await check('it does not rewrite what is already stored', async () => {
    const h = setup(
        { 3: [finalGame(1, 'Jets', 'Dolphins', 13, 10)] },
        { 3: { 1: { winner: 'away', awayScore: 13, homeScore: 10 } } }
    );
    assert.strictEqual(await h.api.syncResultsToGoogleSheets(3, 'ESPN'), 0);
    assert.strictEqual(h.posts.length, 0);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);

})();
