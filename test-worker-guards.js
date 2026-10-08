// Tests for the two ways the public worker could be abused by anyone who read
// its address out of app.js:
//
//   1. Spending Odds API credits. The cache key was the full request URL, so
//      `/odds?x=1`, `?x=2`, ... were each a fresh miss at three credits, and
//      `?refresh=true` skipped the cache outright.
//   2. An open proxy. `/sheets` accepted any URL that merely contained the text
//      `docs.google.com/spreadsheets`, and returned what it fetched with CORS open.
//
// The whole worker is run here against a fake Cache API and a fake network, so
// nothing is fetched and no credits are spent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

// The worker is an ES module and this repo has no package.json, so load it from
// a temporary .mjs copy.
const SOURCE = fs.readFileSync(
    path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-proxy-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE);

// --- fakes -------------------------------------------------------------------

const upstream = [];            // every URL the worker tried to fetch
const store = new Map();        // the fake edge cache, keyed by URL

globalThis.caches = {
    default: {
        async match(key) {
            const hit = store.get(key.url);
            return hit ? hit.clone() : undefined;
        },
        async put(key, response) {
            store.set(key.url, response.clone());
        }
    }
};

globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response('[]', {
        status: 200,
        headers: { 'x-requests-remaining': '400', 'x-requests-used': '100' }
    });
};

const ENV = { ODDS_API_KEY: 'test-key', APPS_SCRIPT_URL: 'https://script.google.com/macros/s/x/exec' };
const ORIGIN = 'https://nfl-picks-proxy.example.workers.dev';

let worker;
async function call(pathAndQuery) {
    const pending = [];
    const ctx = { waitUntil: p => pending.push(p) };
    const response = await worker.fetch(new Request(ORIGIN + pathAndQuery), ENV, ctx);
    await Promise.all(pending);   // let the cache.put land before the next call
    return response;
}
const oddsCalls = () => upstream.filter(u => u.includes('api.the-odds-api.com')).length;

// --- harness -----------------------------------------------------------------

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    store.clear();
    upstream.length = 0;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {
    worker = (await import(pathToFileURL(tmp).href)).default;

    section('Odds: one fetch per cache window, whatever the URL says');

    await check('a bare /odds is fetched once and then served from cache', async () => {
        const first = await call('/odds');
        const second = await call('/odds');
        assert.strictEqual(first.headers.get('X-Cache'), 'MISS');
        assert.strictEqual(second.headers.get('X-Cache'), 'HIT');
        assert.strictEqual(oddsCalls(), 1);
    });

    await check('refresh=true no longer skips the cache', async () => {
        await call('/odds');
        const forced = await call('/odds?refresh=true');
        assert.strictEqual(forced.headers.get('X-Cache'), 'HIT');
        assert.strictEqual(oddsCalls(), 1, 'the forced call spent nothing');
    });

    await check('made-up query strings all share the one cache entry', async () => {
        await call('/odds');
        for (let i = 0; i < 10; i++) await call(`/odds?x=${i}`);
        await call('/odds?markets=spreads&regions=us,uk,eu');
        assert.strictEqual(oddsCalls(), 1, 'eleven cache-busting attempts, one fetch');
    });

    await check('the query string never reaches the Odds API request', async () => {
        await call('/odds?regions=us,uk,eu,au&markets=spreads,h2h,totals,outrights');
        const sent = new URL(upstream.find(u => u.includes('api.the-odds-api.com')));
        assert.strictEqual(sent.searchParams.get('regions'), 'us');
        assert.strictEqual(sent.searchParams.get('markets'), 'spreads,h2h,totals');
    });

    await check('the quota headers are readable cross-origin, on a miss and a hit', async () => {
        for (const response of [await call('/odds'), await call('/odds')]) {
            const exposed = (response.headers.get('Access-Control-Expose-Headers') || '')
                .split(',').map(h => h.trim().toLowerCase());
            for (const name of ['x-requests-remaining', 'x-requests-used', 'x-cache-duration']) {
                assert.ok(exposed.includes(name), `${response.headers.get('X-Cache')} exposes ${name}`);
            }
            assert.strictEqual(response.headers.get('x-requests-remaining'), '400');
        }
    });

    await check('the root path is no longer an odds endpoint', async () => {
        const response = await call('/');
        assert.strictEqual(response.status, 404);
        assert.strictEqual(oddsCalls(), 0);
    });

    section('Sheets: only Google Sheets, by actual host');

    const sheets = raw => call('/sheets?url=' + encodeURIComponent(raw));

    await check('the real export URL the client uses is proxied', async () => {
        const url = 'https://docs.google.com/spreadsheets/d/1JuftzmWWIlquN1oKrFqPNaGjMu9ysdnCHqCDj9lYzfE/export?format=csv&gid=0';
        const response = await sheets(url);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(upstream, [url]);
    });

    const rejected = {
        'the phrase in the query': 'https://evil.example/?docs.google.com/spreadsheets',
        'the phrase in the path': 'https://evil.example/docs.google.com/spreadsheets/d/x',
        'a lookalike subdomain': 'https://docs.google.com.evil.example/spreadsheets/d/x',
        'userinfo in front of the host': 'https://docs.google.com@evil.example/spreadsheets/d/x',
        'plain http': 'http://docs.google.com/spreadsheets/d/x/export',
        'another Google path': 'https://docs.google.com/document/d/x/export',
        'not a URL at all': 'docs.google.com/spreadsheets'
    };
    for (const [label, url] of Object.entries(rejected)) {
        await check(`rejects ${label}`, async () => {
            const response = await sheets(url);
            assert.strictEqual(response.status, 400);
            assert.strictEqual(upstream.length, 0, 'nothing was fetched');
        });
    }

    section('ESPN: the NFL scoreboard only, cached, with CORS');

    // Browsers stopped getting Access-Control-Allow-Origin from ESPN in
    // October 2026, so the site fetches the scoreboard through here.
    const espnCalls = () => upstream.filter(u => u.startsWith('https://site.api.espn.com/'));

    await check('a week’s schedule is fetched from the scoreboard, with CORS added', async () => {
        const r = await call('/espn?seasontype=2&week=4&dates=2026');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
        assert.deepStrictEqual(espnCalls(), [
            'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=4&dates=2026'
        ]);
    });

    await check('the current scoreboard (live scores) needs no parameters', async () => {
        await call('/espn');
        assert.deepStrictEqual(espnCalls(), ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard']);
    });

    await check('a repeat is served from the cache', async () => {
        await call('/espn?seasontype=2&week=4&dates=2026');
        await call('/espn?seasontype=2&week=4&dates=2026');
        assert.strictEqual(espnCalls().length, 1);
    });

    await check('any other parameter is dropped, never forwarded', async () => {
        await call('/espn?week=4&url=https://evil.example/&limit=999');
        assert.deepStrictEqual(espnCalls(), [
            'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=4'
        ]);
    });

    for (const [label, query] of [
        ['a non-numeric week', '?week=4;drop'],
        ['a path in a parameter', '?dates=../../x'],
        ['an over-long number', '?week=12345']
    ]) {
        await check(`rejects ${label}`, async () => {
            const r = await call('/espn' + query);
            assert.strictEqual(r.status, 400);
            assert.strictEqual(espnCalls().length, 0);
        });
    }

    fs.unlinkSync(tmp);
    if (failures > 0) {
        console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
        process.exit(1);
    }
    console.log(`\nALL ${total} CHECKS PASSED\n`);
})();
