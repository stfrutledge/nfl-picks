// Tests for the worker's YouTube highlights: the cron reads the NFL channel's
// RSS feed and keeps each "Game Highlights" video in KV, and /highlights hands
// a week's videos to the app's spoiler-free highlights screen.
//
// The worker runs against a fake feed, a fake KV and a fake edge cache, so
// nothing is fetched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-highlights-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE);

// --- fakes -------------------------------------------------------------------

const store = new Map();
globalThis.caches = {
    default: {
        async match(key) { const hit = store.get(key.url); return hit ? hit.clone() : undefined; },
        async put(key, response) { store.set(key.url, response.clone()); }
    }
};

const kv = new Map();
const kvWrites = [];
const NOTIFY_STATE = {
    get: async k => kv.get(k) ?? null,
    put: async (k, v) => { kvWrites.push(k); kv.set(k, v); },
    delete: async k => { kv.delete(k); }
};

let feed = '';          // what the fake YouTube feed answers
let feedStatus = 200;
let feedCalls = 0;
globalThis.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://www.youtube.com/feeds/videos.xml?channel_id=')) {
        feedCalls++;
        return new Response(feed, { status: feedStatus });
    }
    // Anything else the cron's other chains reach for: refuse, they cope.
    return new Response('nope', { status: 503 });
};

function entry(id, title, published = '2026-11-09T04:00:00+00:00') {
    return `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId>`
        + `<title>${title}</title><published>${published}</published></entry>`;
}
function feedOf(...entries) {
    return `<?xml version="1.0"?><feed><title>NFL</title>${entries.join('')}</feed>`;
}

const ENV = { NOTIFY_STATE };
const ORIGIN = 'https://nfl-picks-proxy.example.workers.dev';

let worker;
async function call(pathAndQuery, method = 'GET') {
    const pending = [];
    const response = await worker.fetch(new Request(ORIGIN + pathAndQuery, { method }), ENV, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    return response;
}
async function tick() {
    const pending = [];
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, ENV, { waitUntil: p => pending.push(p) });
    await Promise.allSettled(pending);
}
const saved = season => JSON.parse(kv.get(`highlights:${season}`) || '{}');

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    store.clear(); kv.clear(); kvWrites.length = 0;
    feed = ''; feedStatus = 200; feedCalls = 0;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {
    worker = (await import(pathToFileURL(tmp).href)).default;

    section('The cron keeps game highlights from the feed');

    await check('a Week N game highlights video is kept under its week and both teams', async () => {
        feed = feedOf(entry('abcDEF12345', 'Tampa Bay Buccaneers vs Chicago Bears Game Highlights | 2026 NFL Season Week 9'));
        await tick();
        assert.deepStrictEqual(saved(2026), { '9:bears_buccaneers': 'abcDEF12345' });
    });

    await check('"vs." and HTML entities in the title are read', async () => {
        feed = feedOf(entry('vid_0000001', 'San Francisco 49ers vs. Los Angeles Rams Game Highlights | 2026 NFL Season Week 10'),
            entry('vid_0000002', 'New York Jets vs New England Patriots Game Highlights &amp;#124; nope'),
            entry('vid_0000003', 'Washington Commanders vs Dallas Cowboys Game Highlights | 2026 NFL Season Week 10'));
        await tick();
        assert.deepStrictEqual(saved(2026), { '10:49ers_rams': 'vid_0000001', '10:commanders_cowboys': 'vid_0000003' });
    });

    await check('other videos on the channel are left out, including ones that give the score away', async () => {
        feed = feedOf(
            entry('x0000000001', 'He and the Bears improve to 7-2 👏'),
            entry('x0000000002', 'Buccaneers vs. Bears Week 9 SNF Recap | NFL Daily'),
            entry('x0000000003', "Bucky Irving's best plays from 2-TD game vs. Bears | Week 9"),
            entry('x0000000004', 'Best Plays From Sunday! | 2026 NFL Season Week 9'),
            entry('x0000000005', 'Top Plays at Midseason! | 2026 NFL Season'));
        await tick();
        assert.deepStrictEqual(saved(2026), {});
        assert.ok(!kvWrites.includes('highlights:2026'), 'nothing new, nothing written');
    });

    await check('playoff rounds go to the site\'s playoff weeks, January uploads to the season before', async () => {
        feed = feedOf(
            entry('wc000000001', 'Pittsburgh Steelers vs Baltimore Ravens Game Highlights | 2026 NFL Wild Card Round', '2027-01-10T04:00:00+00:00'),
            entry('dv000000001', 'Buffalo Bills vs Kansas City Chiefs Game Highlights | NFL Divisional Round', '2027-01-18T04:00:00+00:00'),
            entry('cc000000001', 'Detroit Lions vs Philadelphia Eagles Game Highlights | NFL Conference Championship', '2027-01-25T04:00:00+00:00'),
            entry('sb000000001', 'Kansas City Chiefs vs Detroit Lions Game Highlights | Super Bowl LXI', '2027-02-08T04:00:00+00:00'));
        await tick();
        const s = saved(2026);
        assert.strictEqual(s['19:ravens_steelers'], 'wc000000001');
        assert.strictEqual(s['20:bills_chiefs'], 'dv000000001');
        assert.strictEqual(s['21:eagles_lions'], 'cc000000001');
        // "| Super Bowl LXI" has no "NFL" before it: not in the known form, so not guessed at.
        assert.strictEqual(s['22:chiefs_lions'], undefined);
    });

    await check('a video already kept is not replaced by a later upload, and others are added beside it', async () => {
        kv.set('highlights:2026', JSON.stringify({ '9:bears_buccaneers': 'first000001' }));
        feed = feedOf(entry('second00001', 'Tampa Bay Buccaneers vs Chicago Bears Game Highlights | 2026 NFL Season Week 9'),
            entry('third000001', 'Cincinnati Bengals vs Atlanta Falcons Game Highlights | 2026 NFL Season Week 9'));
        await tick();
        assert.deepStrictEqual(saved(2026), { '9:bears_buccaneers': 'first000001', '9:bengals_falcons': 'third000001' });
    });

    await check('the feed failing changes nothing and does not throw out of the cron', async () => {
        kv.set('highlights:2026', JSON.stringify({ '9:bears_buccaneers': 'keep0000001' }));
        feedStatus = 500;
        await tick();
        assert.strictEqual(feedCalls, 1);
        assert.deepStrictEqual(saved(2026), { '9:bears_buccaneers': 'keep0000001' });
    });

    section('/highlights serves a week');

    await check('a week\'s videos, by team pair, and only that week\'s', async () => {
        kv.set('highlights:2026', JSON.stringify({
            '9:bears_buccaneers': 'aaa00000001', '9:bengals_falcons': 'bbb00000001', '19:ravens_steelers': 'ccc00000001', '1:bills_jets': 'ddd00000001'
        }));
        const r = await call('/highlights?season=2026&week=9');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
        const body = await r.json();
        assert.deepStrictEqual(body, { season: 2026, week: 9, videos: { bears_buccaneers: 'aaa00000001', bengals_falcons: 'bbb00000001' } });
    });

    await check('a week with nothing yet is an empty list, not an error', async () => {
        const body = await (await call('/highlights?season=2026&week=12')).json();
        assert.deepStrictEqual(body.videos, {});
    });

    for (const [label, query] of [
        ['no season', '?week=9'], ['a bad season', '?season=26&week=9'],
        ['no week', '?season=2026'], ['a bad week', '?season=2026&week=9;x']
    ]) {
        await check(`refuses ${label}`, async () => {
            assert.strictEqual((await call('/highlights' + query)).status, 400);
        });
    }

    await check('cached by season and week only: an extra parameter cannot force a fresh read', async () => {
        kv.set('highlights:2026', JSON.stringify({ '9:bears_buccaneers': 'old00000001' }));
        await call('/highlights?season=2026&week=9');
        kv.set('highlights:2026', JSON.stringify({ '9:bears_buccaneers': 'new00000001' }));
        const body = await (await call('/highlights?season=2026&week=09&x=1')).json();
        assert.strictEqual(body.videos.bears_buccaneers, 'old00000001');
    });

    await check('only GET', async () => {
        assert.strictEqual((await call('/highlights?season=2026&week=9', 'POST')).status, 405);
    });

    fs.unlinkSync(tmp);
    if (failures > 0) {
        console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
        process.exit(1);
    }
    console.log(`\nALL ${total} CHECKS PASSED\n`);
})();
