// Tests for Guess the Lines:
//
//   - the worker closes a week's guessing once every game of the week before
//     is final (Monday night), and /lines says so;
//   - solo: a submit is answered with the line at that moment, only while the
//     week is open, and a game once submitted is final;
//   - podcast: four fields a game (you, Sal, Bill, the line read out), any time;
//   - the site's scoring: solo in points off; podcast a point a game to the
//     closest to the line read out, a tie giving each of them one.
//
// The worker runs against a fake KV, with no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-guess-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE + '\nexport { recordLineMoves, handleGuesses };\n');

globalThis.fetch = async () => { throw new Error('no network in this test'); };

const kv = new Map();
const ENV = {
    NOTIFY_STATE: {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async put(k, v) { kv.set(k, v); },
        async delete(k) { kv.delete(k); }
    }
};
const ORIGIN = 'https://nfl-picks-proxy.example.workers.dev';

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    kv.clear();
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

// Week 7 with its Sunday night and Monday night games; week 8 to be guessed.
const SUN_NIGHT = Date.parse('2026-10-26T00:20:00Z');
const MON_NIGHT = Date.parse('2026-10-27T00:15:00Z');
const SUN_DONE = Date.parse('2026-10-26T03:30:00Z');
const MON_DONE = Date.parse('2026-10-27T03:30:00Z');
const week7 = (sunday, monday) => ({ season: 2026, seasonType: 2, week: 7, games: [
    { key: 'chiefs_bills', kickoff: SUN_NIGHT, state: sunday, odds: null },
    { key: 'giants_cowboys', kickoff: MON_NIGHT, state: monday, odds: null }] });
const week8 = home => ({ season: 2026, seasonType: 2, week: 8, games: [
    { key: 'ravens_bills', kickoff: Date.parse('2026-11-01T17:00:00Z'), state: 'pre',
        odds: { away: home.startsWith('-') ? home.replace('-', '+') : home.replace('+', '-'), home, total: 50.5 } }] });
const entry8 = () => JSON.parse(kv.get('lines:2026:8') || 'null');
const run = (board, now, next) => mod.recordLineMoves(ENV, board, now, async () => next);

async function post(body, now) {
    const response = await mod.handleGuesses(new Request(`${ORIGIN}/guesses`, {
        method: 'POST', body: JSON.stringify(body) }), new URL(`${ORIGIN}/guesses`), ENV, now);
    return { status: response.status, body: await response.json() };
}
async function get(query) {
    const url = new URL(`${ORIGIN}/guesses?${query}`);
    const response = await mod.handleGuesses(new Request(url), url, ENV);
    return { status: response.status, body: await response.json() };
}

// The site's half, out of app.js: everything between the block's heading and
// the next section, with the few globals it reads stubbed.
function loadSiteScoring() {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const start = app.indexOf('// Guess the Lines - the game');
    const end = app.indexOf("// Which pickers have their week's picks open");
    assert.ok(start > 0 && end > start, 'Guess the Lines block found in app.js');
    const body = app.slice(start, end);
    return new Function('getTeamAbbreviation', 'WORKER_PROXY_URL', 'CURRENT_SEASON', 'localStorage',
        `${body}\nreturn { soloWeekScore, podcastWeekScore, podcastGameWinners, podcastWeekWinners, formatGuess, guessWindowOpen, parseSpreadText, draftValue, draftFromValue, favoriteSpreadText };`)(
        name => ({ Ravens: 'BAL', Bills: 'BUF', Jets: 'NYJ', Patriots: 'NE' }[name] || name), '', 2026, { getItem: () => null });
}

let mod;
(async () => {
    mod = await import(pathToFileURL(tmp).href);

    section('The worker: a week opens on Sunday night and closes on Monday night');

    await check('Sunday night final: week 8 opens, not closed (Monday night still to play)', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        assert.deepStrictEqual(entry8().open, { at: SUN_DONE, late: false });
        assert.strictEqual(entry8().close, undefined);
    });

    await check('Monday night final: the next run closes it', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        await run(week7('post', 'in'), MON_DONE - 3600000, week8('-3'));
        assert.strictEqual(entry8().close, undefined, 'still open during the game');
        await run(week7('post', 'post'), MON_DONE, week8('-2.5'));
        assert.deepStrictEqual(entry8().close, { at: MON_DONE });
        await run(week7('post', 'post'), MON_DONE + 900000, week8('-2'));
        assert.deepStrictEqual(entry8().close, { at: MON_DONE }, 'closed once, not moved');
    });

    await check('a week first seen on the current board is closed (late) at once', async () => {
        await run(week8('-3'), SUN_DONE + 3 * 86400000, null);
        assert.strictEqual(entry8().close.late, true);
    });

    section('/guesses solo: submit, and the line at that moment is the reveal');

    const solo = (game, guess, week = 8) => ({ mode: 'solo', season: 2026, week, picker: 'Stephen', game, guess });
    const stored = () => JSON.parse(kv.get('guesses:2026:Stephen') || '{}');

    await check('before the week opens: refused', async () => {
        assert.strictEqual((await post(solo('ravens_bills', -3))).status, 409);
    });

    await check('while open: the answer is the current line, stored with the guess', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        await run(week7('post', 'pre'), SUN_DONE + 3600000, week8('-3'));
        const r = await post(solo('ravens_bills', -2.5), SUN_DONE + 7200000);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.entry, { guess: -2.5, line: -3, at: SUN_DONE + 7200000 });
        assert.deepStrictEqual(stored()[8].solo.ravens_bills, r.body.entry);
    });

    await check('a submitted game is final: a second guess gets the first back', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        await post(solo('ravens_bills', -2.5));
        const again = await post(solo('ravens_bills', -3.5));
        assert.strictEqual(again.status, 409);
        assert.strictEqual(again.body.entry.guess, -2.5);
        assert.strictEqual(stored()[8].solo.ravens_bills.guess, -2.5);
    });

    await check('a game with no line yet cannot be submitted', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        assert.strictEqual((await post(solo('jets_patriots', 1))).status, 409);
    });

    await check('after Monday night: refused', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        await run(week7('post', 'post'), MON_DONE, week8('-2.5'));
        assert.strictEqual((await post(solo('ravens_bills', -2.5))).status, 409);
    });

    section('/guesses podcast: four fields a game, any time');

    const podcast = (fields, week = 8, game = 'ravens_bills') => ({ mode: 'podcast', season: 2026, week, picker: 'Stephen', game, ...fields });

    await check('saved with no window at all, and replaced whole', async () => {
        let r = await post(podcast({ you: -3, sal: -2.5, bill: -4, line: -3.5 }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        await post(podcast({ you: -3, sal: null, bill: -4, line: -3.5 }));
        assert.deepStrictEqual(stored()[8].podcast.ravens_bills, { you: -3, bill: -4, line: -3.5 });
    });

    await check('every field cleared removes the game, then the week', async () => {
        await post(podcast({ you: -3 }));
        await post(podcast({ you: null, sal: null, bill: null, line: null }));
        assert.deepStrictEqual(stored(), {});
    });

    await check('solo and podcast sit side by side in a week', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        await post(solo('ravens_bills', -3));
        await post(podcast({ you: -4, line: -3 }));
        assert.deepStrictEqual(Object.keys(stored()[8]).sort(), ['podcast', 'solo']);
        const g = await get('season=2026&picker=Stephen');
        assert.deepStrictEqual(g.body.weeks, stored());
    });

    await check('bad input is refused', async () => {
        await run(week7('post', 'pre'), SUN_DONE, week8('-3.5'));
        assert.strictEqual((await post(solo('ravens_bills', -3.25))).status, 400, 'not a half point');
        assert.strictEqual((await post(solo('ravens_bills', '-3'))).status, 400, 'a string');
        assert.strictEqual((await post(podcast({ line: 41 }))).status, 400, 'out of range');
        assert.strictEqual((await post(solo('Ravens Bills', -3))).status, 400, 'not a game key');
        assert.strictEqual((await post({ ...solo('ravens_bills', -3), mode: 'other' })).status, 400, 'no such mode');
        assert.strictEqual((await post({ ...solo('ravens_bills', -3), picker: 'Nobody' })).status, 400);
        assert.strictEqual((await get('season=2026&picker=Nobody')).status, 400);
    });

    section('The site: scoring');

    const site = loadSiteScoring();

    await check('solo: points off over the submitted games', () => {
        assert.deepStrictEqual(site.soloWeekScore({
            a_b: { guess: -3, line: -2.5 }, c_d: { guess: 2, line: -1 }, e_f: { guess: 0, line: 0 } }), { off: 3.5, games: 3 });
    });

    await check('podcast: the closest to the line read out takes the point', () => {
        assert.deepStrictEqual(site.podcastGameWinners({ you: -2, sal: -2.5, bill: -4, line: -3.5 }), ['bill']);
        assert.deepStrictEqual(site.podcastGameWinners({ you: 1, sal: 3, line: 2 }), ['you', 'sal'], 'a tie: a point each');
        assert.deepStrictEqual(site.podcastGameWinners({ you: -3, sal: -3, bill: -3, line: -3 }), ['you', 'sal', 'bill']);
    });

    await check('podcast: a game scores only with a line and two guesses', () => {
        assert.strictEqual(site.podcastGameWinners({ you: -7, sal: -6 }), null, 'no line read out yet');
        assert.strictEqual(site.podcastGameWinners({ you: -7, line: -6 }), null, 'a lone guess does not win by default');
        assert.strictEqual(site.podcastGameWinners(undefined), null);
    });

    await check('podcast: the week table counts points, games and points off', () => {
        const s = site.podcastWeekScore({
            a_b: { you: -2, sal: -2.5, bill: -4, line: -3.5 },   // Bill
            c_d: { you: 1, sal: 3, line: 2 },                     // You and Sal tie
            e_f: { you: -7, sal: -6 },                            // not scored
        });
        assert.strictEqual(s.scored, 2);
        assert.deepStrictEqual(s.you, { points: 1, games: 2, off: 2.5 });
        assert.deepStrictEqual(s.sal, { points: 1, games: 2, off: 2 });
        assert.deepStrictEqual(s.bill, { points: 1, games: 1, off: 0.5 });
        assert.deepStrictEqual(site.podcastWeekWinners(s), ['you', 'sal', 'bill'], 'level on points: each takes the week');
    });

    await check('podcast: the week goes to the most points; nothing scored, nobody', () => {
        const s = site.podcastWeekScore({ a_b: { you: -3, sal: -6, line: -3 }, c_d: { you: 2, bill: 5, line: 2.5 } });
        assert.deepStrictEqual(site.podcastWeekWinners(s), ['you']);
        assert.deepStrictEqual(site.podcastWeekWinners(site.podcastWeekScore({})), []);
    });

    await check('a spread reads as the favourite giving points', () => {
        const game = { away: 'Ravens', home: 'Bills' };
        assert.strictEqual(site.formatGuess(game, -3.5), 'BUF -3.5');
        assert.strictEqual(site.formatGuess(game, 2), 'BAL -2');
        assert.strictEqual(site.formatGuess(game, 0), 'PK');
    });

    await check('the spread box: the favourite’s points, minus or not, half points only, PK for none', () => {
        assert.strictEqual(site.parseSpreadText(''), null);
        assert.strictEqual(site.parseSpreadText(' 3.5 '), 3.5, 'a number pad with no minus');
        assert.strictEqual(site.parseSpreadText('-7'), 7);
        assert.strictEqual(site.parseSpreadText('−3'), 3, 'a typographic minus');
        assert.strictEqual(site.parseSpreadText('pk'), 0);
        assert.ok(Number.isNaN(site.parseSpreadText('+3')), 'the favourite gives points, never gets them');
        assert.ok(Number.isNaN(site.parseSpreadText('3.25')));
        assert.ok(Number.isNaN(site.parseSpreadText('41')));
        assert.ok(Number.isNaN(site.parseSpreadText('three')));
    });

    await check('the spread box shows the favourite giving points: -3.5, or PK', () => {
        assert.strictEqual(site.favoriteSpreadText(3.5), '-3.5');
        assert.strictEqual(site.favoriteSpreadText(0), 'PK');
        assert.deepStrictEqual(site.draftFromValue(3), { favorite: 'away', text: '-3' });
        assert.deepStrictEqual(site.draftFromValue(-6.5), { favorite: 'home', text: '-6.5' });
    });

    await check('no two top-level functions in app.js share a name', () => {
        // A second declaration silently replaces the first. The spread box's
        // spreadText() was overridden by an older one that signs "+3", so the
        // arrows wrote a plus into a favourite's spread.
        const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
        const names = [...app.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]);
        const twice = names.filter((n, i) => names.indexOf(n) !== i);
        assert.deepStrictEqual(twice, []);
    });

    await check('the spread box: a whole guess needs a favourite, unless it is a pick’em', () => {
        assert.strictEqual(site.draftValue({ favorite: 'home', text: '3.5' }), -3.5);
        assert.strictEqual(site.draftValue({ favorite: 'away', text: '3' }), 3);
        assert.strictEqual(site.draftValue({ favorite: null, text: '3' }), undefined, 'no favourite yet');
        assert.strictEqual(site.draftValue({ favorite: null, text: 'PK' }), 0);
        assert.strictEqual(site.draftValue({ favorite: 'home', text: '' }), null);
        assert.strictEqual(site.draftValue({ favorite: 'home', text: '3.3' }), undefined);
        for (const v of [-3.5, 2, 0]) assert.strictEqual(site.draftValue(site.draftFromValue(v)), v, 'round trip ' + v);
    });

    await check('the solo window: opened on Sunday night and not closed', () => {
        assert.strictEqual(site.guessWindowOpen({ open: { at: 1, late: false }, close: null }), true);
        assert.strictEqual(site.guessWindowOpen({ open: { at: 1, late: false }, close: { at: 2 } }), false);
        assert.strictEqual(site.guessWindowOpen({ open: { at: 1, late: true }, close: null }), false, 'first seen late');
        assert.strictEqual(site.guessWindowOpen({ open: null }), false);
    });

    fs.unlinkSync(tmp);
    console.log(`\n${total - failures}/${total} passed`);
    process.exit(failures ? 1 : 0);
})();
