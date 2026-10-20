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
fs.writeFileSync(tmp, SOURCE + '\nexport { parseDkSplits, parseVsinSplits, parseActionNetworkSplits, recordFinalSplits, splitLine };\n');

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
/** Action Network's scoreboard: games with team ids, and spread outcomes by side. */
function anGame(id, [awayId, away], [homeId, home], { homeLine, homeBets, homeMoney }) {
    const outcome = (side, teamId, value, bets, money) => ({
        type: 'spread', side, team_id: teamId, value, odds: -110,
        bet_info: { tickets: { value: 0, percent: bets }, money: { value: 0, percent: money } }
    });
    return {
        id, status: 'scheduled', away_team_id: awayId, home_team_id: homeId,
        teams: [{ id: awayId, display_name: away }, { id: homeId, display_name: home }],
        markets: { 15: { event: { spread: [
            outcome('home', homeId, homeLine, homeBets, homeMoney),
            outcome('away', awayId, -homeLine, 100 - homeBets, 100 - homeMoney)
        ] } } }
    };
}
const anFeed = () => ({ games: [
    anGame(1, [10, 'Patriots'], [11, 'Bears'], { homeLine: -3, homeBets: 23, homeMoney: 26 }),
    anGame(2, [12, 'Eagles'], [13, 'Cowboys'], { homeLine: -4.5, homeBets: 66, homeMoney: 80 })
] });

const vsinPage = pairs => `<table class="sp-table"><tbody>${pairs.map(([a, h]) =>
    `<!-- Road team -->${vsinRow(...a)}<!-- Home team -->${vsinRow(...h)}`).join('')}</tbody></table>`;

// --- fakes ---------------------------------------------------------------------

const net = { dkPages: [], vsin: '', vsinDown: false, an: null, anDown: false, sheetError: null, upstream: [], posted: [] };
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
    if (u.startsWith('https://api.actionnetwork.com/')) {
        return net.anDown ? new Response('Forbidden', { status: 403 }) : new Response(JSON.stringify(net.an));
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
    net.vsinDown = false; net.sheetError = null; net.an = anFeed(); net.anDown = false;
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

    await check('Action Network: sides by home/away, line, money and tickets', () => {
        const games = mod.parseActionNetworkSplits(anFeed());
        assert.deepStrictEqual(games.map(g => g.key), ['patriots_bears', 'eagles_cowboys']);
        assert.deepStrictEqual(games[0].sides.home, { line: -3, handle: 26, bets: 23 });
        assert.deepStrictEqual(games[0].sides.away, { line: 3, handle: 74, bets: 77 });
    });

    await check('Action Network: a game without both sides\u2019 percentages is left out', () => {
        const feed = anFeed();
        delete feed.games[1].markets[15].event.spread[0].bet_info;
        assert.deepStrictEqual(mod.parseActionNetworkSplits(feed).map(g => g.key), ['patriots_bears']);
        assert.deepStrictEqual(mod.parseActionNetworkSplits(null), []);
    });

    section('/splits');

    await check('both books, merged per game, across DK’s pages', async () => {
        const out = await splitsCall();
        assert.deepStrictEqual(Object.keys(out.games).sort(), ['eagles_cowboys', 'giants_texans', 'packers_lions', 'patriots_bears', ...FILLER_KEYS].sort());
        assert.deepStrictEqual(out.games.patriots_bears.dk.away, { line: 3, handle: 84, bets: 78 });
        assert.deepStrictEqual(out.games.patriots_bears.circa.away, { line: 3, handle: 55, bets: 37 });
        assert.deepStrictEqual(out.games.patriots_bears.an.home, { line: -3, handle: 26, bets: 23 });
        assert.ok(out.games.eagles_cowboys.an && !out.games.eagles_cowboys.dk, 'a game only Action Network has yet');
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
        assert.strictEqual(Object.values(out.games).filter(g => g.dk).length, 10);
    });

    await check('one book down still answers with the other, and says which', async () => {
        net.vsinDown = true;
        const out = await splitsCall();
        assert.ok(out.games.patriots_bears.dk);
        assert.ok(!out.games.patriots_bears.circa);
        assert.match(out.errors.circa, /403/);
    });

    await check('Action Network down: the other two still answer', async () => {
        net.anDown = true;
        const out = await splitsCall();
        assert.ok(out.games.patriots_bears.dk && out.games.patriots_bears.circa);
        assert.ok(!out.games.patriots_bears.an);
        assert.match(out.errors.an, /403/);
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
        assert.deepStrictEqual(row.an, [3, 74, 77, -3, 26, 23]);
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
    const BOTH = {
        an: { away: { line: 3, handle: 74, bets: 77 }, home: { line: -3, handle: 26, bets: 23 } },
        dk: { away: { line: 3, handle: 84, bets: 78 }, home: { line: -3, handle: 16, bets: 22 } },
        circa: { away: { line: 3, handle: 55, bets: 37 }, home: { line: -3, handle: 45, bets: 63 } }
    };
    site.__setSplits({ patriots_bears: BOTH });

    await check('a strip of its own: the source named, a labelled row per measure, away then home', () => {
        const html = site.gameSplitsHtml(game, false);
        assert.match(html, /Betting splits · Action Network/);
        assert.match(html, /game-splits-team">Patriots \+3<[\s\S]*game-splits-team">Bears -3</, 'away column first, as the buttons');
        assert.match(html, /% of money<\/span><span class="game-splits-cell lead">74%<\/span><span class="game-splits-cell">26%</);
        assert.match(html, /% of bets<\/span><span class="game-splits-cell lead">77%<\/span><span class="game-splits-cell">23%</);
        assert.ok(html.indexOf('% of money') < html.indexOf('% of bets'), 'money first');
    });

    await check('the bigger share is the one in bold, whichever side it is on', () => {
        site.__setSplits({ patriots_bears: { an: { away: { line: 3, handle: 40, bets: 50 }, home: { line: -3, handle: 60, bets: 50 } } } });
        const html = site.gameSplitsHtml(game, false);
        assert.match(html, /% of money<\/span><span class="game-splits-cell">40%<\/span><span class="game-splits-cell lead">60%</);
        assert.match(html, /% of bets<\/span><span class="game-splits-cell">50%<\/span><span class="game-splits-cell">50%</, 'a tie leads neither');
        site.__setSplits({ patriots_bears: BOTH });
    });

    await check('the consensus only: DraftKings and Circa are stored, not shown', () => {
        const html = site.gameSplitsHtml(game, false);
        assert.doesNotMatch(html, /84%|55%|DK|Circa/);
    });

    await check('nothing once the game is locked, or for a game with no splits', () => {
        assert.strictEqual(site.gameSplitsHtml(game, true), '');
        assert.strictEqual(site.gameSplitsHtml({ ...game, away: 'Jets', home: 'Dolphins' }, false), '');
    });

    await check('a game only DraftKings or Circa carries shows no strip', () => {
        site.__setSplits({ patriots_bears: { dk: BOTH.dk, circa: BOTH.circa } });
        assert.strictEqual(site.gameSplitsHtml(game, false), '');
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
        + ';return ({ gameSplitsHtml, __setSplits: s => { bettingSplits = s; } });');
    return fn(env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia);
}
