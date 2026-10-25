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
fs.writeFileSync(tmp, SOURCE + '\nexport { parseDkSplits, parseVsinSplits, parseActionNetworkSplits, recordFinalSplits, splitLine, recordLineMoves, espnOdds, sheetLine, syncSheetLines };\n');

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
        assert.strictEqual(games[0].sides.count, undefined, 'no num_bets in the feed, no count');
        const feed = anFeed();
        feed.games[0].num_bets = 2923;
        assert.strictEqual(mod.parseActionNetworkSplits(feed)[0].sides.count, 2923, 'the number of bets, when given');
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

    section('Line movement: the week opens on Sunday night, then a point each time it moves');

    // Week 6 as ESPN shows it: Sunday games (13:00 ET and the 20:20 ET night
    // game), then Monday night. Week 7's first game is the next Thursday.
    const SUN_1PM = Date.parse('2026-10-18T17:00:00Z');
    const SUN_NIGHT = Date.parse('2026-10-19T00:20:00Z');   // 8:20 PM ET Sunday
    const MON_NIGHT = Date.parse('2026-10-20T00:15:00Z');   // 8:15 PM ET Monday
    // A season with no agreed late open (OPENS_TAKEN_LATE): the rule as it stands.
    const SEASON = 2025;
    const week6 = (sundayState, mondayState = 'pre', season = SEASON) => ({
        season, seasonType: 2, week: 6, games: [
            { key: 'giants_eagles', kickoff: SUN_1PM, state: 'post', odds: null },
            { key: 'chiefs_bills', kickoff: SUN_NIGHT, state: sundayState, odds: null },
            { key: 'commanders_49ers', kickoff: MON_NIGHT, state: mondayState,
                odds: { away: '+7.5', home: '-7.5', total: 51.5 } }
        ] });
    const espnLine = (away, home, total) => mod.espnOdds({ odds: [{
        pointSpread: { away: { close: { line: away } }, home: { close: { line: home } } },
        total: { over: { close: { line: `o${total}` } } } }] });
    const week7 = (odds, season = SEASON) => ({ season, seasonType: 2, week: 7,
        games: [{ key: '49ers_falcons', away: '49ers', home: 'Falcons', kickoff: KICKOFF, state: 'pre', odds }] });
    const entry7 = (season = SEASON) => JSON.parse(kv.get(`lines:${season}:7`) || 'null');
    const SUN_MIDNIGHT = Date.parse('2026-10-19T04:00:00Z');   // the first run after the night game ends

    await check('ESPN’s odds read: the spread as printed, the total as a number', () => {
        assert.deepStrictEqual(espnLine('-3.5', '+3.5', 49.5), { away: '-3.5', home: '+3.5', total: 49.5 });
        assert.strictEqual(mod.espnOdds({}), null, 'no odds, no line');
    });

    await check('before the last Sunday game is final, next week is not tracked at all', async () => {
        await mod.recordLineMoves(ENV, week6('in'), SUN_NIGHT + 3600000, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        assert.strictEqual(entry7(), null, 'a lookahead line is not kept');
    });

    await check('the first run after it: the week opens, each game’s first point is the open', async () => {
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        const e = entry7();
        assert.deepStrictEqual(e.open, { at: SUN_MIDNIGHT, late: false });
        assert.deepStrictEqual(e.games['49ers_falcons'], [{ at: SUN_MIDNIGHT, away: '-4.5', home: '+4.5', total: 47.5, kind: 'open' }]);
    });

    await check('then a point only when the spread or total moves; Monday night does not hold it up', async () => {
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        const same = await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT + 15 * MIN, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        assert.deepStrictEqual(same.moved, [], 'unchanged');
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT + 86400000, async () => week7(espnLine('-3.5', '+3.5', 47.5)));
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT + 2 * 86400000, async () => week7(espnLine('-3.5', '+3.5', 49.5)));
        const points = entry7().games['49ers_falcons'];
        assert.deepStrictEqual(points.map(p => [p.away, p.total, p.kind]), [['-4.5', 47.5, 'open'], ['-3.5', 47.5, undefined], ['-3.5', 49.5, undefined]]);
    });

    await check('a Sunday night the tracker missed: "first seen", never "open"', async () => {
        // Tracking began on the Tuesday afternoon after week 6.
        const tuesday = Date.parse('2026-10-20T21:15:00Z');
        await mod.recordLineMoves(ENV, week6('post', 'post'), tuesday, async () => week7(espnLine('-3', '+3', 50.5)));
        const e = entry7();
        assert.strictEqual(e.open.late, true);
        assert.strictEqual(e.games['49ers_falcons'][0].kind, 'first');
    });

    await check('2026 week 7, the week tracking began: its Tuesday line is the open, by agreement', async () => {
        const tuesday = Date.parse('2026-10-20T21:15:00Z');
        await mod.recordLineMoves(ENV, week6('post', 'post', 2026), tuesday, async () => week7(espnLine('-3', '+3', 50.5), 2026));
        const e = entry7(2026);
        assert.deepStrictEqual(e.open, { at: tuesday, late: false, agreed: true });
        assert.strictEqual(e.games['49ers_falcons'][0].kind, 'open');
        // Week 8 is back to the rule: the same late start reads "first seen".
        const wk8 = { season: 2026, seasonType: 2, week: 8, games: [{ ...week7(null).games[0], key: 'jets_patriots', odds: espnLine('+2', '-2', 41) }] };
        await mod.recordLineMoves(ENV, { ...week7(null, 2026), games: [{ ...week7(null).games[0], state: 'post' }] }, tuesday + 7 * 86400000, async () => wk8);
        assert.strictEqual(JSON.parse(kv.get('lines:2026:8')).games.jets_patriots[0].kind, 'first');
    });

    await check('a week first seen on the current scoreboard is "first seen" too', async () => {
        await mod.recordLineMoves(ENV, week7(espnLine('-3', '+3', 50.5)), KICKOFF - 86400000, async () => null);
        assert.strictEqual(entry7().games['49ers_falcons'][0].kind, 'first');
    });

    await check('a game whose line appears after the open is "first seen" when it does', async () => {
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT, async () => week7(null));
        assert.deepStrictEqual(entry7().games, {}, 'opened, but no line for it yet');
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT + 3600000, async () => week7(espnLine('-4', '+4', 47.5)));
        assert.strictEqual(entry7().games['49ers_falcons'][0].kind, 'first');
    });

    await check('not after kickoff, and not on a run ESPN refused', async () => {
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        const kicked = { ...week7(espnLine('-3', '+3', 50)), games: [{ ...week7(null).games[0], state: 'in', odds: espnLine('-3', '+3', 50) }] };
        await mod.recordLineMoves(ENV, week6('post'), KICKOFF + MIN, async () => kicked);
        assert.strictEqual(entry7().games['49ers_falcons'].length, 1, 'live betting is not the line');
        const r = await mod.recordLineMoves(ENV, { ...week6('post'), espnError: 'ESPN answered 403' }, KICKOFF - MIN);
        assert.match(r.skipped, /ESPN/);
    });

    await check('/lines: the week’s open and history, readable cross-origin; a bad week is refused', async () => {
        await mod.recordLineMoves(ENV, week6('post'), SUN_MIDNIGHT, async () => week7(espnLine('-4.5', '+4.5', 47.5)));
        const r = await worker.fetch(new Request(`https://w.test/lines?season=${SEASON}&week=7`), ENV, {});
        assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
        const body = await r.json();
        assert.deepStrictEqual(body.open, { at: SUN_MIDNIGHT, late: false });
        assert.strictEqual(body.games['49ers_falcons'][0].kind, 'open');
        assert.strictEqual((await worker.fetch(new Request('https://w.test/lines?season=x&week=7'), ENV, {})).status, 400);
        const empty = await (await worker.fetch(new Request(`https://w.test/lines?season=${SEASON}&week=8`), ENV, {})).json();
        assert.deepStrictEqual([empty.open, empty.games], [null, {}], 'a week not open yet');
    });

    section('The site’s lines: the worker writes DraftKings’ to the Spreads tab');

    const linesWeek = (games, extra = {}) => ({ season: 2026, seasonType: 2, week: 7, games, ...extra });
    const pre = (key, away, home, total, kickoff = KICKOFF) =>
        ({ key, kickoff, state: 'pre', odds: { away, home, total } });
    const spreadPosts = () => net.posted.filter(p => p.spreads);

    await check('a line in the sheet’s shape: the size, and which side gives it', () => {
        assert.deepStrictEqual(mod.sheetLine({ away: '-3.5', home: '+3.5', total: 49.5 }), { spread: 3.5, favorite: 'away', overUnder: 49.5 });
        assert.deepStrictEqual(mod.sheetLine({ away: '+3', home: '-3', total: 44 }), { spread: 3, favorite: 'home', overUnder: 44 });
        assert.deepStrictEqual(mod.sheetLine({ away: 'PK', home: 'PK', total: 41 }), { spread: 0, favorite: 'home', overUnder: 41 }, 'a pick’em is 0, a real line');
        assert.strictEqual(mod.sheetLine({ away: 'x', home: 'y', total: 1 }), null);
    });

    await check('written for games still to kick off, never one that has', async () => {
        const r = await mod.syncSheetLines(ENV, [linesWeek([
            pre('49ers_falcons', '-3', '+3', 50.5),
            { ...pre('patriots_bears', '+3', '-3', 50.5, KICKOFF - 86400000), state: 'post' },
            { ...pre('cowboys_eagles', '-4.5', '+4.5', 44.5), state: 'in' }
        ])], KICKOFF - 3600000);
        assert.deepStrictEqual(r.written, ['2026_7']);
        assert.deepStrictEqual(spreadPosts(), [{ week: '2026_7', spreads: { '49ers_falcons': { spread: 3, favorite: 'away', overUnder: 50.5 } } }]);
    });

    await check('nothing new within two hours: not written; a move, or two hours on: written', async () => {
        const at = KICKOFF - 2 * 86400000;
        const week = spread => [linesWeek([pre('49ers_falcons', spread, spread.startsWith('-') ? spread.replace('-', '+') : spread.replace('+', '-'), 50.5)])];
        await mod.syncSheetLines(ENV, week('-3'), at);
        await mod.syncSheetLines(ENV, week('-3'), at + 15 * MIN);
        assert.strictEqual(spreadPosts().length, 1, 'unchanged: the sheet is left alone');
        await mod.syncSheetLines(ENV, week('-3.5'), at + 30 * MIN);
        assert.strictEqual(spreadPosts().length, 2, 'moved: written');
        assert.strictEqual(spreadPosts()[1].spreads['49ers_falcons'].spread, 3.5);
        await mod.syncSheetLines(ENV, week('-3.5'), at + 30 * MIN + 2 * 3600000);
        assert.strictEqual(spreadPosts().length, 3, 'two hours on: written again, so the phones see it is fresh');
    });

    await check('each run writes both weeks it reads, by the site’s week numbers', async () => {
        await mod.recordLineMoves(ENV, linesWeek([pre('49ers_falcons', '-3', '+3', 50.5)]), KICKOFF - 86400000,
            async () => ({ season: 2026, seasonType: 2, week: 8, games: [pre('jets_patriots', '+2', '-2', 41, KICKOFF + 7 * 86400000)] }));
        assert.deepStrictEqual(spreadPosts().map(p => p.week), ['2026_7', '2026_8']);
        await mod.syncSheetLines(ENV, [{ season: 2026, seasonType: 3, week: 1, games: [pre('bills_chiefs', '+1', '-1', 47)] }], KICKOFF - MIN);
        assert.strictEqual(spreadPosts()[2].week, '2026_19', 'the wild card round is the site’s week 19');
    });

    await check('ESPN refusing the run: nothing written, so the timestamp ages and the phones take over', async () => {
        const r = await mod.recordLineMoves(ENV, linesWeek([pre('49ers_falcons', '-3', '+3', 50.5)], { espnError: 'ESPN answered 403' }), KICKOFF - 86400000);
        assert.match(r.skipped, /ESPN/);
        assert.strictEqual(spreadPosts().length, 0);
    });

    await check('the sheet refusing: the history is still kept, and the next run tries again', async () => {
        net.sheetError = 'Service Spreadsheets timed out';
        const r = await mod.recordLineMoves(ENV, linesWeek([pre('49ers_falcons', '-3', '+3', 50.5)]), KICKOFF - 86400000, async () => null);
        assert.match(r.sheet.error, /timed out/);
        assert.ok(JSON.parse(kv.get('lines:2026:7')).games['49ers_falcons'], 'the line history was kept');
        net.sheetError = null;
        const again = await mod.recordLineMoves(ENV, linesWeek([pre('49ers_falcons', '-3', '+3', 50.5)]), KICKOFF - 86400000 + 15 * MIN, async () => null);
        assert.deepStrictEqual(again.sheet.written, ['2026_7'], 'nothing was marked written, so it goes now');
    });

    section('Game Details');

    const site = loadSite();
    site.__viewCurrentWeek();   // as the site opens: splits are for this week's games
    const game = {
        id: 1, away: 'Patriots', home: 'Bears', spread: 3, favorite: 'home', overUnder: 44.5,
        day: 'Thursday', time: '8:15 PM ET', kickoff: '2099-10-23T00:15:00Z',
        broadcast: 'Prime Video', stadium: 'Soldier Field', location: 'Chicago, IL',
        records: { away: { total: '4-2', home: '3-0', road: '1-2' }, home: { total: '4-2', home: '2-1', road: '2-1' } },
        indoor: false, weather: { text: 'Mostly clear', temp: 60 },
        awayMoneyline: 135, homeMoneyline: -160
    };
    const BOTH = {
        an: { away: { line: 3, handle: 74, bets: 77 }, home: { line: -3, handle: 26, bets: 23 }, count: 2923 },
        dk: { away: { line: 3, handle: 84, bets: 78 }, home: { line: -3, handle: 16, bets: 22 } },
        circa: { away: { line: 3, handle: 55, bets: 37 }, home: { line: -3, handle: 45, bets: 63 } }
    };
    site.__setSplits({ patriots_bears: BOTH });
    // The text of one block of the popup, tags stripped, for reading.
    const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
    const block = (html, cls) => {
        const at = html.indexOf(`class="${cls}`);
        return at < 0 ? '' : html.slice(html.indexOf('>', at) + 1, html.indexOf('</div>', at));
    };

    await check('the card header: "8:15 PM ET, Thur." on the left, a Game Details button on the right', () => {
        assert.strictEqual(site.cardKickoffLabel(game), '8:15 PM ET, Thur.');
        assert.strictEqual(site.cardKickoffLabel({ ...game, day: 'Tuesday', time: '7:00 PM ET' }), '7:00 PM ET, Tues.');
        assert.strictEqual(site.cardKickoffLabel({ ...game, day: 'Sunday', time: '1:00 PM ET' }), '1:00 PM ET, Sun.');
        const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
        assert.match(src, /<span class="game-time">\$\{cardKickoffLabel\(game\)\}<\/span>\s*\$\{statusBadge\}\s*<button type="button" class="game-details-btn" data-pick-key="\$\{key\}">Game Details<\/button>/);
    });

    await check('the hero: kickoff, both teams with logo, line and record (no moneyline), the stadium, a close button', () => {
        const html = site.gameDetailsHtml(game);
        assert.match(html, /class="gd-hero"/);
        assert.match(html, /class="gd-close" aria-label="Close"/);
        assert.match(text(block(html, 'gd-kicker')), /^Thursday, Oct 22 · 8:15 PM ET$/);
        const [away, home] = html.split(/class="gd-team(?: gd-won)?"/).slice(1, 3).map(part => text(part.split('gd-vs')[0]));
        assert.match(away, /Patriots \+3 4-2 · 1-2 road/, 'away first, as the buttons: the road record for the away team');
        assert.match(home, /Bears -3 4-2 · 2-1 home/, 'the home record for the home team');
        assert.match(site.gameDetailsHtml({ ...game, records: undefined }), /gd-team-name">Patriots/, 'no records: the team still shows');
        assert.doesNotMatch(site.gameDetailsHtml({ ...game, records: undefined }), /gd-record/, 'and no empty record line');
        assert.match(html, /<img class="gd-logo"[^>]*alt="Patriots logo"/);
        assert.match(text(block(html, 'gd-venue')), /Soldier Field · Chicago, IL/);
        assert.doesNotMatch(html, /ML /, 'moneylines are not shown (the owner took them out)');
    });

    await check('splits: one bar per measure in the teams’ colours, each side as wide as its share', () => {
        const html = site.gameDetailsHtml(game);
        assert.match(text(html), /Betting Splits Action Network · 2,923 bets/);
        const bars = html.split('class="gd-split"').slice(1);
        assert.strictEqual(bars.length, 2);
        assert.match(text(bars[0]), /% of money on the spread NE 74% CHI 26%/);
        assert.match(text(bars[1]), /% of bets on the spread NE 77% CHI 23%/);
        assert.match(bars[0], /gd-seg lead" style="flex-grow: 74; background: #/, 'the bigger share leads');
        assert.match(bars[0], /gd-seg" style="flex-grow: 26;/);
        assert.doesNotMatch(html, /84%|55%|>DK<|Circa/, 'the consensus only: DraftKings and Circa are stored, not shown');
    });

    await check('teams in the same colour: the home side gives way to a neutral slate', () => {
        // Patriots and Bears are both navy: a bar in one colour is not a split.
        const html = site.gameDetailsHtml(game);
        assert.match(html, /CHI 26%/);
        assert.match(html.split('class="gd-split"')[1], /flex-grow: 26; background: #6b7280"/);
        site.__setSplits({ dolphins_bears: { an: BOTH.an } });
        const distinct = site.gameDetailsHtml({ ...game, away: 'Dolphins' });
        assert.doesNotMatch(distinct, /#6b7280/, 'teal against navy keeps both teams’ colours');
        site.__setSplits({ patriots_bears: BOTH });
    });

    await check('the line: Opened is the Sunday-night open with its time, Now the card’s, a moved number bold', () => {
        site.__setLineHistory({ patriots_bears: [
            { at: Date.parse('2026-10-19T04:00:00Z'), away: '+1.5', home: '-1.5', total: 42.5, kind: 'open' },
            { at: Date.parse('2026-10-20T13:15:00Z'), away: '+3', home: '-3', total: 44.5 }
        ] });
        const html = site.gameDetailsHtml(game);
        assert.match(html, /<th>Opened <span class="gd-th-when">Mon 12:00 AM<\/span><\/th><th>Now<\/th>/, '04:00 UTC is midnight ET');
        // Moved, so each label is its chart's button.
        assert.match(html, /<tr><td><button[^>]*>Spread<\/button><\/td><td><span class="gd-l5-opp"><img[^>]*>CHI <span class="gd-h2h-num">-1.5<\/span><\/span><\/td><td class="moved"><span class="gd-l5-opp"><img[^>]*>CHI <span class="gd-h2h-num">-3<\/span><\/span><\/td><\/tr>/);
        assert.match(html, /<tr><td><button[^>]*>Total<\/button><\/td><td>42.5<\/td><td class="moved">44.5<\/td><\/tr>/);
        site.__setLineHistory({});
    });

    await check('no Sunday-night open (tracking began later): Opened is a dash, never ESPN’s number', () => {
        site.__setLineHistory({ patriots_bears: [{ at: Date.parse('2026-10-20T21:15:00Z'), away: '+3', home: '-3', total: 44.5, kind: 'first' }] });
        const html = site.gameDetailsHtml({ ...game, openLine: { away: '+1.5', home: '-1.5', total: 42.5 } });
        assert.match(html, /<th>Opened<\/th>/);
        assert.match(html, /<tr><td>Spread<\/td><td>&ndash;<\/td><td class=""><span class="gd-l5-opp"><img[^>]*>CHI <span class="gd-h2h-num">-3<\/span><\/span><\/td><\/tr>/);
        assert.doesNotMatch(html, /-1.5|42.5/, 'ESPN’s undated opener is not used');
        site.__setLineHistory({});
        assert.match(site.gameDetailsHtml(game), /<td>Spread<\/td><td>&ndash;<\/td>/, 'nothing loaded: a dash');
    });

    await check('TV as the networks’ logos, every network carrying it, from the repo', () => {
        const html = site.gameDetailsHtml(game);
        assert.match(html, /gd-chip-label">TV<\/span><span class="gd-tv"><img class="gd-tv-logo" src="tv-logos\/prime-video.svg" alt="Prime Video"/);
        assert.ok(html.indexOf('gd-chips') > html.indexOf('gd-body'), 'at the foot of the Betting tab, not in the header');
        const mnf = site.gameDetailsHtml({ ...game, networks: ['ESPN', 'ABC'] });
        assert.match(mnf, /src="tv-logos\/espn.svg"[\s\S]*src="tv-logos\/abc.svg"/, 'both, in order');
        assert.match(site.gameDetailsHtml({ ...game, networks: ['ESPN2'] }), /gd-tv-name">ESPN2</, 'no logo: the name');
        for (const file of ['cbs', 'fox', 'nbc', 'abc', 'espn', 'prime-video', 'nfl-network', 'disney-plus', 'netflix', 'peacock', 'youtube', 'nfl-plus']) {
            assert.ok(fs.existsSync(path.join(__dirname, 'tv-logos', `${file}.svg`)), `${file}.svg is in the repo`);
        }
    });

    await check('weather: the town’s forecast, under a roof too, never marked indoors', () => {
        const forecast = /gd-chip-label">Weather<\/span><span class="gd-wx" role="img" aria-label="Mostly clear"[^>]*><svg[^]*?<\/svg><\/span>60&deg;F/;
        assert.match(site.gameDetailsHtml(game), forecast);
        assert.match(site.gameDetailsHtml({ ...game, indoor: true }), forecast, 'a dome: the same');
        assert.doesNotMatch(site.gameDetailsHtml({ ...game, indoor: true }), /Indoors/);
        assert.match(site.gameDetailsHtml({ ...game, weather: { text: '', temp: 60 } }), /gd-chip-label">Weather<\/span>60&deg;F/, 'a temperature alone');
        assert.doesNotMatch(site.gameDetailsHtml({ ...game, indoor: true, weather: null }), /gd-chip-label">Weather/, 'no forecast: no pill');
    });

    await check('°F by default; °C when the app’s Settings says so, asked each time', () => {
        // A browser, or the 1.14 app with no temperatureUnit: °F.
        site.__window.NFLPicksApp = { picker: () => 'Stephen' };
        assert.match(site.gameDetailsHtml(game), /gd-wx" role="img" aria-label="Mostly clear"[^>]*><svg[^]*?<\/svg><\/span>60&deg;F/, 'an older app: °F');
        let unit = 'C';
        site.__window.NFLPicksApp = { temperatureUnit: () => unit };
        assert.match(site.gameDetailsHtml(game), /gd-wx" role="img" aria-label="Mostly clear"[^>]*><svg[^]*?<\/svg><\/span>16&deg;C/, '60°F is 16°C');
        assert.match(site.gameDetailsHtml({ ...game, indoor: true }), /<\/svg><\/span>16&deg;C/);
        unit = 'F';
        assert.match(site.gameDetailsHtml(game), /gd-wx" role="img" aria-label="Mostly clear"[^>]*><svg[^]*?<\/svg><\/span>60&deg;F/, 'changed in Settings: the next draw follows');
        site.__window.NFLPicksApp = { temperatureUnit: () => { throw new Error('bridge gone'); } };
        assert.match(site.gameDetailsHtml(game), /60&deg;F/, 'a broken bridge falls back to °F');
        delete site.__window.NFLPicksApp;
    });

    await check('a game abroad: the Open-Meteo forecast for its town and country, at the kickoff hour', async () => {
        // Kickoff three days out, on the hour: Steelers v Saints at the Stade de France.
        const kick = new Date(Math.ceil(Date.now() / 3600000) * 3600000 + 3 * 86400000);
        const paris = { id: 4, away: 'Steelers', home: 'Saints', spread: 3.5, favorite: 'away',
            kickoff: kick.toISOString(), stadium: 'Stade de France', location: 'Saint-Denis', country: 'France', indoor: false, weather: null };
        const asked = [];
        const hour = `${kick.toISOString().slice(0, 10)}T${String(kick.getUTCHours()).padStart(2, '0')}:00`;
        site.__net.fetch = async url => {
            asked.push(String(url));
            if (String(url).includes('geocoding-api')) return { ok: true, json: async () => ({ results: [
                { name: 'Saint-Denis', country: undefined, admin1: 'Reunion', latitude: -20.88, longitude: 55.45 },
                { name: 'Saint-Denis', country: 'France', admin1: 'Ile-de-France', latitude: 48.94, longitude: 2.35 }
            ] }) };
            return { ok: true, json: async () => ({ hourly: { time: ['x', hour], temperature_2m: [40, 61.4], weather_code: [3, 1] } }) };
        };
        await site.loadVenueForecast(paris);
        assert.match(asked[1], /latitude=48.94&longitude=2.35/, 'the French Saint-Denis, not Réunion’s');
        assert.match(asked[1], /temperature_unit=fahrenheit/);
        assert.match(site.gameDetailsHtml(paris), /gd-chip-label">Weather<\/span><span class="gd-wx" role="img" aria-label="Mostly clear"[^>]*><svg[^]*?<\/svg><\/span>61&deg;F/);
        assert.match(site.gameDetailsHtml(paris), /gd-venue">Stade de France · Saint-Denis, France</, 'abroad: the country named');
        assert.doesNotMatch(site.gameDetailsHtml({ ...game, country: 'USA' }), /USA/, 'at home: no country');

        // Steelers yellow and Saints gold are light: dark text on their bars.
        site.__setSplits({ steelers_saints: { an: { away: { line: -3.5, handle: 49, bets: 44 }, home: { line: 3.5, handle: 51, bets: 56 } } } });
        assert.match(site.gameDetailsHtml(paris), /gd-seg on-light" style="flex-grow: 49;[\s\S]*gd-seg lead on-light" style="flex-grow: 51;/);
        assert.doesNotMatch(site.gameDetailsHtml(game), /on-light/, 'navy takes white');
        site.__setSplits({ patriots_bears: BOTH });

        await site.loadVenueForecast(paris);
        assert.strictEqual(asked.length, 2, 'asked once a visit');

        asked.length = 0;
        await site.loadVenueForecast({ ...paris, id: 5, away: 'Jets', home: 'Bills', country: 'USA' });
        await site.loadVenueForecast({ ...paris, id: 6, away: 'Rams', home: 'Raiders', weather: { text: 'Sunny', temp: 70 } });
        assert.strictEqual(asked.length, 0, 'not for a game at home, nor one ESPN has weather for');
        site.__net.fetch = async () => ({ ok: false, json: async () => ({}) });
    });

    await check('a source with home and away the other way round is still matched, sides swapped back', () => {
        // Action Network had Eagles @ Cowboys; the schedule has Cowboys @ Eagles.
        site.__setSplits({ eagles_cowboys: { an: { away: { line: 4.5, handle: 20, bets: 34 }, home: { line: -4.5, handle: 80, bets: 66 }, count: 900 } } });
        const html = site.gameDetailsHtml({ id: 2, away: 'Cowboys', home: 'Eagles', spread: 4.5, favorite: 'away', kickoff: '2099-10-27T00:15:00Z' });
        assert.match(text(html.split('class="gd-split"')[1]), /% of money on the spread DAL 80% PHI 20%/);
        assert.match(text(html), /900 bets/);
        site.__setSplits({ patriots_bears: BOTH });
    });

    await check('a section with no data is left out', () => {
        const html = site.gameDetailsHtml({ id: 3, away: 'Jets', home: 'Dolphins', broadcast: 'CBS', kickoff: '2099-10-25T17:00:00Z' });
        assert.match(html, /gd-chip-label">TV<\/span><span class="gd-tv"><img class="gd-tv-logo" src="tv-logos\/cbs.svg"/);
        assert.doesNotMatch(html, /Betting Splits|gd-table|Weather|gd-record|gd-venue/);
        const bare = site.gameDetailsHtml({ id: 3, away: 'Jets', home: 'Dolphins', kickoff: '2099-10-25T17:00:00Z' });
        assert.match(bare, /No betting numbers for this game yet/, 'nothing at all: the Betting tab says so');
    });

    await check('after kickoff: no splits (live betting by then), and the rest still shows', () => {
        const html = site.gameDetailsHtml({ ...game, kickoff: '2000-01-01T00:00:00Z' });
        assert.doesNotMatch(html, /Betting Splits/);
        assert.match(html, /gd-record/, 'the records still show once it has started');
    });

    await check('no Movement table: the charts show the history', () => {
        site.__setLineHistory({ patriots_bears: [
            { at: Date.parse('2026-10-19T03:45:00Z'), away: '+1.5', home: '-1.5', total: 47.5, kind: 'open' },
            { at: Date.parse('2026-10-20T13:15:00Z'), away: '+3', home: '-3', total: 50.5 }
        ] });
        const html = site.gameDetailsHtml(game);
        assert.doesNotMatch(html, /Movement|gd-moves/);
        assert.match(html, /gd-line-toggle/, 'the charts are there instead');
        site.__setLineHistory({});
    });

    await check('a missed Sunday night: the chart says "since first seen" and when', () => {
        site.__setLineHistory({ patriots_bears: [
            { at: Date.parse('2026-10-20T21:15:00Z'), away: '+2.5', home: '-2.5', total: 48.5, kind: 'first' },
            { at: Date.parse('2026-10-21T15:00:00Z'), away: '+3', home: '-3', total: 50.5 }
        ] });
        site.__setGames([game]);
        site.openGameDetails('patriots_bears');
        site.toggleLineChart('spread');
        assert.match(site.__el('game-details-body').innerHTML, /Spread · Bears <span>since first seen Tue 5:15 PM<\/span>/);
        site.toggleLineChart('spread');
        site.closeGameDetails();
        site.__setLineHistory({});
    });

    await check('a favourite that flipped charts as + then -, from the side favoured now', () => {
        site.__setLineHistory({ patriots_bears: [
            { at: Date.parse('2026-10-19T04:00:00Z'), away: '-1', home: '+1', total: 47.5, kind: 'open' },
            { at: Date.parse('2026-10-21T15:00:00Z'), away: '+3', home: '-3', total: 47.5 }
        ] });
        assert.deepStrictEqual(site.lineChartPoints(game, 'spread', 'home').map(p => p.v), [1, -3]);
        site.__setLineHistory({});
    });

    const MOVED = { patriots_bears: [
        { at: Date.parse('2026-10-19T04:00:00Z'), away: '+1.5', home: '-1.5', total: 47.5, kind: 'open' },
        { at: Date.parse('2026-10-20T13:00:00Z'), away: '+2.5', home: '-2.5', total: 47.5 },
        { at: Date.parse('2026-10-21T13:00:00Z'), away: '+3', home: '-3', total: 50.5 }
    ] };

    await check('charts: Spread and Total open from their labels once the line has moved', () => {
        site.__setLineHistory({ patriots_bears: [MOVED.patriots_bears[0]] });
        assert.doesNotMatch(site.gameDetailsHtml(game), /gd-line-toggle/, 'nothing has moved: plain labels');
        site.__setLineHistory(MOVED);
        const html = site.gameDetailsHtml(game);
        assert.match(html, /<button type="button" class="gd-line-toggle" data-which="spread" aria-expanded="false">Spread<\/button>/);
        assert.match(html, /<button type="button" class="gd-line-toggle" data-which="total" aria-expanded="false">Total<\/button>/);
        assert.doesNotMatch(html, /class="gd-chart"/, 'closed until asked');
    });

    await check('a chart: the spread from the side favoured now, a step line, a dot at each point, the latest at the end', () => {
        site.__setLineHistory(MOVED);
        assert.deepStrictEqual(site.lineChartPoints(game, 'spread', 'home').map(p => p.v), [-1.5, -2.5, -3]);
        assert.deepStrictEqual(site.lineChartPoints(game, 'total', 'home').map(p => p.v), [47.5, 47.5, 50.5]);
        site.__setGames([game]);
        site.openGameDetails('patriots_bears');
        site.toggleLineChart('spread');
        const html = site.__el('game-details-body').innerHTML;
        assert.match(html, /gd-line-toggle open" data-which="spread" aria-expanded="true"/);
        assert.match(html, /class="gd-chart" data-which="spread"/);
        assert.match(html, /Spread · Bears <span>since the open<\/span>/);
        const path = html.match(/class="gd-chart-line" d="([^"]+)"/)[1];
        assert.match(path, /^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+$/, 'horizontal then vertical: a step, never a slope');
        assert.strictEqual((html.match(/class="gd-chart-dot"/g) || []).length, 3);
        assert.match(html, /class="gd-chart-end"[^>]*>-3</);
        assert.match(html, /aria-label="Spread · Bears: -1.5 at the open, -3 now, 2 moves"/);

        site.toggleLineChart('total');
        assert.match(site.__el('game-details-body').innerHTML, /Total <span>since the open[\s\S]*class="gd-chart-end"[^>]*>50.5</, 'one chart at a time: Total replaces Spread');
        site.toggleLineChart('total');
        assert.doesNotMatch(site.__el('game-details-body').innerHTML, /class="gd-chart"/, 'and the same label closes it');
        site.closeGameDetails();
        site.__setLineHistory({});
    });

    await check('the spread chart marks when the viewer took their side, and names it under the chart', () => {
        site.__setLineHistory(MOVED);
        site.__setGames([game]);
        site.__setViewerPick('Stephen', 'patriots_bears', { line: 'away' });
        site.__setPickMoments({ patriots_bears: { side: 'away', at: Date.parse('2026-10-19T16:00:00Z'), spread: 1.5 } });
        site.openGameDetails('patriots_bears');
        site.toggleLineChart('spread');
        let html = site.__el('game-details-body').innerHTML;
        assert.strictEqual((html.match(/class="gd-chart-picked"/g) || []).length, 1, 'one marker');        assert.match(html, /Picked at Patriots \+1\.5 · Mon 12:00 PM/, 'the number from the side taken, in ET');
        const y = Number(html.match(/class="gd-chart-picked" cx="[\d.]+" cy="([\d.]+)"/)[1]);
        const openY = Number(html.match(/class="gd-chart-line" d="M[\d.]+,([\d.]+)/)[1]);
        assert.strictEqual(y, openY, 'on the chart at -1.5 from the Bears side, where the line stood');

        site.__setPickMoments({ patriots_bears: { side: 'home', at: Date.parse('2026-10-19T16:00:00Z'), spread: -1.5 } });
        site.refreshGameDetails();
        html = site.__el('game-details-body').innerHTML;
        assert.doesNotMatch(html, /gd-chart-picked/, 'the log has another side than the one held: no marker');

        site.toggleLineChart('total');
        assert.doesNotMatch(site.__el('game-details-body').innerHTML, /gd-chart-picked/, 'the total chart carries no marker');
        site.closeGameDetails();
        site.__setViewerPick('Stephen', 'patriots_bears', null);
        site.__setPickMoments({});
        site.__setLineHistory({});
    });

    await check('moneylines come off ESPN’s DraftKings odds, so the popup keeps them', () => {
        const comp = { odds: [{ moneyline: { away: { close: { odds: '-170' } }, home: { close: { odds: '+142' } } } }] };
        assert.strictEqual(site.espnMoneyline(comp, 'away'), -170);
        assert.strictEqual(site.espnMoneyline(comp, 'home'), 142);
        assert.strictEqual(site.espnMoneyline({ odds: [{ moneyline: { home: { close: { odds: 'EVEN' } } } }] }, 'home'), 100);
        assert.strictEqual(site.espnMoneyline({}, 'away'), null);
    });

    await check('an open page picks up the line the worker wrote, on its next read of the sheet', async () => {
        const card = { ...game, spread: 3, favorite: 'home', overUnder: 44.5 };
        site.__setGames([card]);
        site.__net.fetch = async url => (String(url).includes('action=spreads')
            ? { ok: true, json: async () => ({ spreads: { patriots_bears: { spread: 3.5, favorite: 'home', overUnder: 45.5 } }, lastUpdated: new Date().toISOString(), count: 1 }) }
            : { ok: false, json: async () => ({}) });
        await site.refreshSheetLines();
        const now = site.__games()[0];
        assert.strictEqual(Number(now.spread), 3.5, 'the card moved with DraftKings');
        assert.strictEqual(Number(now.overUnder), 45.5);
        site.__net.fetch = async () => ({ ok: false, json: async () => ({}) });
    });

    await check('the button opens the popup on its game, it closes, and new data redraws it', () => {
        site.__setGames([game]);
        site.openGameDetails('patriots_bears');
        assert.ok(site.__el('game-details-modal').classList.contains('show'));
        assert.match(site.__el('game-details-body').innerHTML, /PATRIOTS|Patriots/);

        site.__setSplits({ patriots_bears: { an: { ...BOTH.an, count: 5000 } } });
        site.refreshGameDetails();
        assert.match(site.__el('game-details-body').innerHTML, /5,000 bets/, 'redrawn with the new numbers');

        site.closeGameDetails();
        assert.ok(!site.__el('game-details-modal').classList.contains('show'));
        site.__el('game-details-body').innerHTML = 'untouched';
        site.refreshGameDetails();
        assert.strictEqual(site.__el('game-details-body').innerHTML, 'untouched', 'a closed popup is not redrawn');
        site.__setSplits({ patriots_bears: BOTH });
    });

    await check('Back closes the popup, not the page; closing it otherwise takes its history entry off', () => {
        site.setupGameDetailsModal();
        const h = site.__window.history;
        const start = h.entries;
        site.openGameDetails('patriots_bears');
        assert.strictEqual(h.entries, start + 1, 'opening adds one entry');
        site.openGameDetails('patriots_bears');
        assert.strictEqual(h.entries, start + 1, 'opening again while open adds nothing');
        site.__back();
        assert.ok(!site.__el('game-details-modal').classList.contains('show'), 'Back closed it');
        assert.strictEqual(h.entries, start, 'and the page is where it was');

        site.openGameDetails('patriots_bears');
        site.closeGameDetails();
        assert.ok(!site.__el('game-details-modal').classList.contains('show'));
        assert.strictEqual(h.entries, start, 'closed by the x, a tap outside or Escape: its entry is taken off');
    });

    fs.unlinkSync(tmp);
    console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
    process.exit(failures ? 1 : 0);
})();

/** app.js in Node with browser stubs, for the card caption. */
function loadSite() {
    // The network, swappable per test: nothing answers unless a test says so.
    const net = { fetch: async () => ({ ok: false, json: async () => ({}) }) };
    const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, appendChild() {} });
    // The popup's elements, with a class list that remembers.
    const elements = {};
    const listeners = {};
    for (const id of ['game-details-modal', 'game-details-body', 'game-details-close']) {
        const classes = new Set();
        elements[id] = {
            id, innerHTML: '', dataset: {},
            classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
                toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)) },
            addEventListener() {}
        };
    }
    const env = {
        // A working store: the sheet re-read keeps lines here before applying them.
        localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; })(),
        document: {
            addEventListener() {}, getElementById: id => elements[id] || null, querySelector: () => null, querySelectorAll: () => [],
            createElement: el, head: { appendChild() {} },
            body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, fetch: (...args) => net.fetch(...args),
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false,
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        // A history that counts entries and fires popstate on back(), as a browser does.
        history: { entries: 1, pushState() { this.entries++; }, back() { if (this.entries > 1) { this.entries--; (listeners.popstate || []).forEach(fn => fn({})); } } }
    };
    env.window = env;
    const snapshot = `const HISTORICAL_DATA_SEASON = 0; const HISTORICAL_GAMES = {}; const HISTORICAL_RESULTS = {}; const HISTORICAL_PICKS = {};`;
    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8') + '\n' + snapshot + '\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + `;return ({ gameDetailsHtml, cardKickoffLabel, openGameDetails, closeGameDetails, refreshGameDetails, setupGameDetailsModal, loadVenueForecast, toggleLineChart, lineChartPoints, espnMoneyline, refreshSheetLines, __games: () => NFL_GAMES_BY_WEEK[currentWeek],
            __setSplits: s => { bettingSplits = s; },
            __setGames: games => { NFL_GAMES_BY_WEEK[currentWeek] = games; },
            __viewCurrentWeek: () => { currentWeek = CURRENT_NFL_WEEK; },
            __setLineHistory: games => { lineHistory.set(currentWeek, { at: Date.now(), games }); },
            __setViewerPick: (picker, key, pick) => { currentPicker = picker; if (!allPicks[currentWeek]) allPicks[currentWeek] = {}; allPicks[currentWeek][picker] = pick ? { [key]: pick } : {}; },
            __setPickMoments: games => { pickMoments.set(currentWeek + '|' + currentPicker, { at: Date.now(), games }); } });`);
    const api = fn(env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia);
    api.__el = id => elements[id];
    api.__net = net;
    api.__window = env;
    // The phone's Back: the browser leaves the entry, then fires popstate.
    api.__back = () => { env.history.entries--; (listeners.popstate || []).forEach(fn => fn({})); };
    return api;
}
