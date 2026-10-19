// Tests for the betting splits: the worker reading DraftKings' and VSiN's
// pages, /splits merging and caching them, the cron writing each game's last
// numbers before kickoff to the Splits tab, and the pick cards showing them.
//
// The pages have no API, so the parsers are what is worth guarding: a side is
// matched to its team rather than taken by position (DK lists the favourite
// first), DK's real minus sign and the markup it leaves in comments are
// handled, and a page past the end of DK's list repeats the last one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

// The worker is an ES module and this repo has no package.json: load it from
// a temporary .mjs copy, with its internals exported for the test.
const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-splits-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE + '\nexport { parseDkSplits, parseVsinSplits, recordFinalSplits, splitLine };\n');

// --- page fixtures, in the shape the real pages use -----------------------------

const MINUS = '−';

/** One DK game: moneyline, spread and total blocks. `fav` is listed first, as DK does. */
function dkGame({ away, home, when = '10/25, 01:00PM', fav = 'home', line = 3, favHandle = 60, favBets = 70 }) {
    const [awayAbbr, awayName] = away.split(' ');
    const [homeAbbr, homeName] = home.split(' ');
    const sides = fav === 'home'
        ? [[home, `-${line}`, favHandle, favBets], [away, `+${line}`, 100 - favHandle, 100 - favBets]]
        : [[away, `-${line}`, favHandle, favBets], [home, `+${line}`, 100 - favHandle, 100 - favBets]];
    const row = ([team, num, h, b], extra = '') => `
        <div><div>${team}${extra}</div><div><a href="https://sportsbook.draftkings.com/event/1">${MINUS}110</a></div>
        <div>${h}% <div><div style="width: ${h}%"></div></div></div>
        <div>${b}% <div><div style="width: ${b}%"></div></div></div></div>`;
    return `
    <div class="game"><a href="#">${awayAbbr} ${awayName} @ ${homeAbbr} ${homeName} ${when}</a>
      <div><div>Moneyline</div><div>Odds</div><div>% Handle</div><div>% Bets</div></div>
      ${row([sides[0][0], '', 80, 90])}${row([sides[1][0], '', 20, 10])}
      <!-- <div>Spread</div><div>Odds</div><div>% Handle</div><div>% Bets</div> -->
      <div><div>Spread</div><div>Odds</div><div>% Handle</div><div>% Bets</div></div>
      ${row(sides[0], ` ${sides[0][1]}`)}${row(sides[1], ` ${sides[1][1]}`)}
      <div><div>Total</div><div>Odds</div><div>% Handle</div><div>% Bets</div></div>
      ${row(['Over 44.5', '', 55, 51])}${row(['Under 44.5', '', 45, 49])}
    </div>`;
}

const dkPage = games => `<html><body><h1>Betting Splits</h1>
    <div>Matchup Odds % Handle % Bets</div>${games.map(dkGame).join('')}</body></html>`;

function vsinRow(team, line, handle, bets) {
    return `<tr class="sp-row"> <td class="sp-cell-action"><button class="sp-act-history">&#8634;</button></td>
      <td class="sp-cell-team"><img class="sp-team-logo"><a class="sp-team-link" href="/nfl/teams/x">${team}</a></td>
      <td class="sp-col-first"><span class="sp-badge sp-badge-line">${line}</span></td>
      <td><span class="sp-badge">${handle}%</span></td> <td><span class="sp-badge sp-badge-green">${bets}%</span></td>
      <td class="sp-col-first"><span class="sp-badge sp-badge-line">44.5</span></td>
      <td><span class="sp-badge">50%</span></td><td><span class="sp-badge">50%</span></td>
      <td class="sp-col-first"><span class="sp-badge sp-badge-line">+150</span></td>
      <td><span class="sp-badge">40%</span></td><td><span class="sp-badge">30%</span></td></tr>`;
}
const vsinPage = pairs => `<table class="sp-table"><tbody>${pairs.map(([a, h]) =>
    `<!-- Road team -->${vsinRow(...a)}<!-- Home team -->${vsinRow(...h)}`).join('')}</tbody></table>`;

// --- fakes ---------------------------------------------------------------------

const net = { dkPages: [], vsin: '', vsinDown: false, sheetError: null, upstream: [], posted: [] };
const cacheStore = new Map();
globalThis.caches = {
    default: {
        async match(key) { const hit = cacheStore.get(key.url); return hit ? hit.clone() : undefined; },
        async put(key, response) { cacheStore.set(key.url, response.clone()); }
    }
};
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    net.upstream.push(u);
    if (u.startsWith('https://dknetwork.draftkings.com/')) {
        const page = Number(new URL(u).searchParams.get('tb_page') || 1);
        const pages = net.dkPages;
        return new Response(pages[Math.min(page, pages.length) - 1] || dkPage([]));
    }
    if (u.startsWith('https://data.vsin.com/')) {
        return net.vsinDown ? new Response('Forbidden', { status: 403 }) : new Response(net.vsin);
    }
    if (u.startsWith(APPS_SCRIPT_URL) && init.method === 'POST') {
        if (net.sheetError) return new Response(JSON.stringify({ error: net.sheetError }));
        net.posted.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true, results: { splits: { rowsAdded: 1 } } }));
    }
    return new Response('not found', { status: 404 });
};

const kv = new Map();
const ENV = {
    APPS_SCRIPT_URL,
    NOTIFY_STATE: {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async put(k, v) { kv.set(k, v); },
        async delete(k) { kv.delete(k); }
    }
};

// Week 7: Patriots at Bears (Bears -3), Giants at Texans (Texans -9.5).
const BEARS = { away: 'NE Patriots', home: 'CHI Bears', line: 3, favHandle: 16, favBets: 22 };
const TEXANS = { away: 'NY Giants', home: 'HOU Texans', line: 9.5, favHandle: 1, favBets: 13 };
const LIONS = { away: 'GB Packers', home: 'DET Lions', when: '10/25, 04:25PM', line: 3, favHandle: 94, favBets: 73 };
// DK pages hold ten games: eight more to fill the first.
const FILLER = [['MIA Dolphins', 'NY Jets'], ['IND Colts', 'MIN Vikings'], ['TB Buccaneers', 'CAR Panthers'],
    ['SF 49ers', 'ATL Falcons'], ['CIN Bengals', 'BAL Ravens'], ['CLE Browns', 'TEN Titans'],
    ['DEN Broncos', 'ARI Cardinals'], ['LA Rams', 'LV Raiders']].map(([away, home]) => ({ away, home }));
const FILLER_KEYS = ['dolphins_jets', 'colts_vikings', 'buccaneers_panthers', '49ers_falcons',
    'bengals_ravens', 'browns_titans', 'broncos_cardinals', 'rams_raiders'];

// --- harness -------------------------------------------------------------------

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    cacheStore.clear(); kv.clear();
    net.upstream.length = 0; net.posted.length = 0;
    net.dkPages = [dkPage([BEARS, TEXANS, ...FILLER]), dkPage([LIONS])];
    net.vsin = vsinPage([[['New England Patriots', '+3', 55, 37], ['Chicago Bears', '-3', 45, 63]]]);
    net.vsinDown = false; net.sheetError = null;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {
    const mod = await import(pathToFileURL(tmp).href);
    const worker = mod.default;
    const splitsCall = async () => (await worker.fetch(new Request('https://w.test/splits'), ENV, { waitUntil: p => p })).json();

    section('Reading the pages');

    await check('DK: each side is matched to its team, favourite listed first or not', () => {
        const games = mod.parseDkSplits(dkPage([BEARS, { ...TEXANS, fav: 'away', line: 2.5, favHandle: 76, favBets: 64 }]));
        assert.strictEqual(games.length, 2);
        assert.strictEqual(games[0].key, 'patriots_bears');
        assert.deepStrictEqual(games[0].sides.home, { line: -3, handle: 16, bets: 22 }, 'the Bears, listed first');
        assert.deepStrictEqual(games[0].sides.away, { line: 3, handle: 84, bets: 78 });
        assert.deepStrictEqual(games[1].sides.away, { line: -2.5, handle: 76, bets: 64 }, 'an away favourite');
    });

    await check('DK: the spread block is the one read, not the moneyline or total', () => {
        const [g] = mod.parseDkSplits(dkPage([BEARS]));
        assert.notStrictEqual(g.sides.home.handle, 80, 'not the moneyline’s 80%');
        assert.strictEqual(g.sides.home.handle, 16);
    });

    await check('a pick’em line reads as 0, not as missing', () => {
        assert.strictEqual(mod.splitLine('PK'), 0);
        assert.strictEqual(mod.splitLine('+7.5'), 7.5);
        assert.strictEqual(mod.splitLine('-3'), -3);
        assert.strictEqual(mod.splitLine('abc'), null);
    });

    await check('VSiN: rows pair up road then home, keyed like the site', () => {
        const games = mod.parseVsinSplits(vsinPage([
            [['Wash Commanders', '+7.5', 55, 39], ['San Francisco 49ers', '-7.5', 45, 61]],
            [['Los Angeles Rams', 'PK', 50, 48], ['Las Vegas Raiders', 'PK', 50, 52]]
        ]));
        assert.deepStrictEqual(games.map(g => g.key), ['commanders_49ers', 'rams_raiders']);
        assert.deepStrictEqual(games[0].sides.away, { line: 7.5, handle: 55, bets: 39 });
        assert.deepStrictEqual(games[0].sides.home, { line: -7.5, handle: 45, bets: 61 });
        assert.strictEqual(games[1].sides.home.line, 0);
    });

    section('/splits');

    await check('both books, merged per game, across DK’s pages', async () => {
        const out = await splitsCall();
        assert.deepStrictEqual(Object.keys(out.games).sort(), ['giants_texans', 'packers_lions', 'patriots_bears', ...FILLER_KEYS].sort());
        assert.deepStrictEqual(out.games.patriots_bears.dk.away, { line: 3, handle: 84, bets: 78 });
        assert.deepStrictEqual(out.games.patriots_bears.circa.away, { line: 3, handle: 55, bets: 37 });
        assert.ok(!out.games.giants_texans.circa, 'a game Circa does not carry has DK alone');
        assert.deepStrictEqual(out.errors, {});
    });

    await check('DK’s paging stops at a short page', async () => {
        await splitsCall();
        const dkCalls = net.upstream.filter(u => u.includes('dknetwork'));
        assert.strictEqual(dkCalls.length, 2, 'page 1 (ten games), then page 2 (one): done');
    });

    await check('...or at a page that repeats the last one', async () => {
        net.dkPages = [dkPage([BEARS, TEXANS, ...FILLER])];   // page 2 repeats page 1
        const out = await splitsCall();
        assert.strictEqual(net.upstream.filter(u => u.includes('dknetwork')).length, 2);
        assert.strictEqual(Object.keys(out.games).length, 10);
    });

    await check('one book down still answers with the other, and says which', async () => {
        net.vsinDown = true;
        const out = await splitsCall();
        assert.ok(out.games.patriots_bears.dk);
        assert.ok(!out.games.patriots_bears.circa);
        assert.match(out.errors.circa, /403/);
    });

    await check('cached: a second request fetches nothing', async () => {
        await splitsCall();
        const before = net.upstream.length;
        const again = await splitsCall();
        assert.strictEqual(net.upstream.length, before);
        assert.ok(again.games.patriots_bears);
    });

    await check('readable cross-origin', async () => {
        const r = await worker.fetch(new Request('https://w.test/splits'), ENV, { waitUntil: p => p });
        assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
    });

    section('The cron keeps the last numbers before kickoff, then writes them');

    const KICKOFF = Date.parse('2026-10-25T17:00:00Z');
    const MIN = 60 * 1000;
    const board = {
        season: 2026, seasonType: 2, week: 7,
        games: [{ key: 'patriots_bears', away: 'Patriots', home: 'Bears', kickoff: KICKOFF, state: 'pre' }]
    };

    await check('30 minutes out: kept, not written yet', async () => {
        const r = await mod.recordFinalSplits(ENV, board, KICKOFF - 25 * MIN);
        assert.strictEqual(net.posted.length, 0);
        assert.strictEqual(r.watching, 1);
        assert.ok(JSON.parse(kv.get('splits:pending')).patriots_bears);
    });

    await check('the last run before kickoff writes one row, both books, both sides', async () => {
        await mod.recordFinalSplits(ENV, board, KICKOFF - 25 * MIN);
        // The numbers move before the last run: the row has the later ones.
        cacheStore.clear();
        net.dkPages = [dkPage([{ ...BEARS, favHandle: 30, favBets: 25 }, TEXANS, ...FILLER]), dkPage([LIONS])];
        const r = await mod.recordFinalSplits(ENV, board, KICKOFF - 10 * MIN);
        assert.deepStrictEqual(r.written, ['patriots_bears']);
        assert.strictEqual(net.posted.length, 1);
        const [row] = net.posted[0].splits;
        assert.strictEqual(row.week, '2026_7');
        assert.strictEqual(row.gameKey, 'patriots_bears');
        assert.deepStrictEqual(row.dk, [3, 70, 75, -3, 30, 25], 'away line/handle/bets, then home');
        assert.deepStrictEqual(row.circa, [3, 55, 37, -3, 45, 63]);
        assert.strictEqual(row.kickoff, new Date(KICKOFF).toISOString());
        assert.deepStrictEqual(JSON.parse(kv.get('splits:pending')), {}, 'and it is no longer pending');

        await mod.recordFinalSplits(ENV, board, KICKOFF + 5 * MIN);
        assert.strictEqual(net.posted.length, 1, 'written once');
    });

    await check('a missed last run: the first run after kickoff writes what it kept', async () => {
        await mod.recordFinalSplits(ENV, board, KICKOFF - 25 * MIN);
        const r = await mod.recordFinalSplits(ENV, board, KICKOFF + 20 * MIN);
        assert.deepStrictEqual(r.written, ['patriots_bears']);
        assert.strictEqual(net.upstream.filter(u => u.includes('dknetwork')).length, 2,
            'no new fetch after kickoff: DK’s numbers are live betting by then');
    });

    await check('the sheet refusing (Apps Script not redeployed yet) keeps it for the next run', async () => {
        net.sheetError = 'No picks, spreads, results, or cleared status provided';
        await mod.recordFinalSplits(ENV, board, KICKOFF - 25 * MIN);
        const r = await mod.recordFinalSplits(ENV, board, KICKOFF - 10 * MIN);
        assert.match(r.error, /No picks/);
        assert.ok(JSON.parse(kv.get('splits:pending')).patriots_bears, 'still pending');

        net.sheetError = null;
        const later = await mod.recordFinalSplits(ENV, board, KICKOFF + 2 * 24 * 60 * MIN);
        assert.deepStrictEqual(later.written, ['patriots_bears'], 'written once the sheet takes it');
    });

    await check('a game nobody has splits for is not written', async () => {
        const quiet = { ...board, games: [{ key: 'jets_dolphins', away: 'Jets', home: 'Dolphins', kickoff: KICKOFF, state: 'pre' }] };
        const r = await mod.recordFinalSplits(ENV, quiet, KICKOFF - 10 * MIN);
        assert.deepStrictEqual(r.written, []);
        assert.strictEqual(net.posted.length, 0);
    });

    await check('nothing near kickoff: no fetch at all', async () => {
        await mod.recordFinalSplits(ENV, board, KICKOFF - 3 * 60 * MIN);
        assert.strictEqual(net.upstream.length, 0);
    });

    await check('playoff weeks are numbered as the site numbers them', async () => {
        const wildCard = { ...board, seasonType: 3, week: 1 };
        await mod.recordFinalSplits(ENV, wildCard, KICKOFF - 10 * MIN);
        assert.strictEqual(net.posted[0].splits[0].week, '2026_19');
    });

    section('The pick cards');

    const site = loadSite();
    const game = { id: 1, away: 'Patriots', home: 'Bears', spread: 3, favorite: 'home' };
    site.__setSplits({ patriots_bears: {
        dk: { away: { line: 3, handle: 84, bets: 78 }, home: { line: -3, handle: 16, bets: 22 } },
        circa: { away: { line: 3, handle: 55, bets: 37 }, home: { line: -3, handle: 45, bets: 63 } }
    } });

    await check('each side shows money and bets, a line per book', () => {
        const html = site.pickSplitsHtml(game, 'away', false);
        assert.match(html, /DK<\/span> 84% \$ · 78% bets/);
        assert.match(html, /Circa<\/span> 55% \$ · 37% bets/);
        assert.match(site.pickSplitsHtml(game, 'home', false), /DK<\/span> 16% \$ · 22% bets/);
    });

    await check('nothing once the game is locked, or for a game with no splits', () => {
        assert.strictEqual(site.pickSplitsHtml(game, 'away', true), '');
        assert.strictEqual(site.pickSplitsHtml({ ...game, away: 'Jets', home: 'Dolphins' }, 'away', false), '');
    });

    await check('one book only shows that book alone', () => {
        site.__setSplits({ patriots_bears: { dk: { away: { line: 3, handle: 84, bets: 78 }, home: { line: -3, handle: 16, bets: 22 } } } });
        const html = site.pickSplitsHtml(game, 'away', false);
        assert.match(html, /DK<\/span>/);
        assert.doesNotMatch(html, /Circa/);
    });

    fs.unlinkSync(tmp);
    console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
    process.exit(failures ? 1 : 0);
})();

/** app.js in Node with browser stubs, for the card caption. */
function loadSite() {
    const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, appendChild() {} });
    const env = {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
        document: {
            addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: el, head: { appendChild() {} },
            body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, fetch: async () => ({ ok: false }),
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false,
        addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    const snapshot = `const HISTORICAL_DATA_SEASON = 0; const HISTORICAL_GAMES = {}; const HISTORICAL_RESULTS = {}; const HISTORICAL_PICKS = {};`;
    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8') + '\n' + snapshot + '\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + ';return ({ pickSplitsHtml, __setSplits: s => { bettingSplits = s; } });');
    return fn(env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia);
}
