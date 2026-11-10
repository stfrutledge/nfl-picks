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
fs.writeFileSync(tmp, SOURCE + '\nexport { recordLineMoves, handleGuesses, followingWeek };\n');

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
    return new Function('getTeamAbbreviation', 'WORKER_PROXY_URL', 'CURRENT_SEASON', 'localStorage', 'pickKey',
        `${body}\nreturn { soloWeekScore, podcastWeekScore, podcastGameWinners, podcastWeekWinners, formatGuess, guessWindowOpen, parseSpreadText, draftValue, draftFromValue, favoriteSpreadText, needsFavorite, soloDraft, podcastRow, podcastRows, guessState, orderGuessGames, parseGuessEpisode, parseGuessEpisodes, podcastEpisodeWeek, podcastPlayerName, PODCAST_PLAYERS, guessOffBand };`)(
        name => ({ Ravens: 'BAL', Bills: 'BUF', Jets: 'NYJ', Patriots: 'NE' }[name] || name), '', 2026, { getItem: () => null },
        game => `${game.away.toLowerCase()}_${game.home.toLowerCase()}`);
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

    section('The worker: a week with no Monday night game, and the playoffs');

    // Week 18 of the 2026 season: Saturday and Sunday only. The wild card
    // round (the site's week 19, ESPN's playoff week 1) is guessed after it.
    const W18_SAT = Date.parse('2027-01-09T21:30:00Z');    // Sat 4:30 PM ET
    const W18_SUN = Date.parse('2027-01-11T01:20:00Z');    // Sun 8:20 PM ET
    const W18_DONE = Date.parse('2027-01-11T04:30:00Z');   // Sun 11:30 PM ET
    const TUE_MIDNIGHT_ET = Date.parse('2027-01-12T05:00:00Z');
    const week18 = state => ({ season: 2026, seasonType: 2, week: 18, games: [
        { key: 'jets_bills', kickoff: W18_SAT, state: 'post', odds: null },
        { key: 'lions_packers', kickoff: W18_SUN, state, odds: null }] });
    const wildCard = home => ({ season: 2026, seasonType: 3, week: 1, games: [
        { key: 'steelers_ravens', kickoff: Date.parse('2027-01-16T21:30:00Z'), state: 'pre',
            odds: { away: home.replace('-', '+'), home, total: 44.5 } }] });
    const entry19 = () => JSON.parse(kv.get('lines:2026:19') || 'null');

    await check('week 18 to the wild card, the conference round to the Super Bowl, then nothing', async () => {
        assert.deepStrictEqual(mod.followingWeek({ seasonType: 2, week: 17 }), { seasonType: 2, week: 18 });
        assert.deepStrictEqual(mod.followingWeek({ seasonType: 2, week: 18 }), { seasonType: 3, week: 1 });
        assert.deepStrictEqual(mod.followingWeek({ seasonType: 3, week: 2 }), { seasonType: 3, week: 3 });
        assert.deepStrictEqual(mod.followingWeek({ seasonType: 3, week: 3 }), { seasonType: 3, week: 5 }, 'past the Pro Bowl');
        assert.strictEqual(mod.followingWeek({ seasonType: 3, week: 5 }), null);
    });

    await check('no Monday game: the wild card opens on Sunday night and stays open all Monday', async () => {
        await run(week18('post'), W18_DONE, wildCard('-3.5'));
        assert.deepStrictEqual(entry19().open, { at: W18_DONE, late: false });
        assert.strictEqual(entry19().close, undefined, 'not closed with the Sunday night game');
        await run(week18('post'), TUE_MIDNIGHT_ET - 60000, wildCard('-3'));
        assert.strictEqual(entry19().close, undefined, 'still open at 11:59 PM ET Monday');
        await run(week18('post'), TUE_MIDNIGHT_ET, wildCard('-3'));
        assert.deepStrictEqual(entry19().close, { at: TUE_MIDNIGHT_ET }, 'closed once Monday is over');
    });

    await check('a playoff week can be guessed', async () => {
        await run(week18('post'), W18_DONE, wildCard('-3.5'));
        const r = await post({ mode: 'solo', season: 2026, week: 19, picker: 'Stephen', game: 'steelers_ravens', guess: -2.5 }, W18_DONE + 3600000);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.entry.line, -3.5);
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

    await check('points with no favourite tapped are flagged, not taken as a guess', () => {
        assert.strictEqual(site.needsFavorite({ favorite: null, text: '-5' }), true);
        assert.strictEqual(site.draftValue({ favorite: null, text: '-5' }), undefined, 'so nothing is saved');
        assert.strictEqual(site.needsFavorite({ favorite: 'home', text: '-5' }), false);
        assert.strictEqual(site.needsFavorite({ favorite: null, text: 'PK' }), false, 'a pick’em needs no favourite');
        assert.strictEqual(site.needsFavorite({ favorite: null, text: '' }), false);
    });

    await check('solo starts from your podcast guess, so a slate is not typed twice', () => {
        site.guessState.weeks = { 8: { podcast: { ravens_bills: { you: -4.5, sal: -3 } } } };
        site.guessState.drafts.clear();
        assert.deepStrictEqual(site.soloDraft(8, 'ravens_bills'), { draft: { favorite: 'home', text: '-4.5' }, fromPodcast: true });
        assert.strictEqual(site.soloDraft(8, 'jets_patriots').fromPodcast, false, 'nothing guessed there');
        site.guessState.drafts.set('8|ravens_bills|solo', { favorite: 'away', text: '1' });
        assert.deepStrictEqual(site.soloDraft(8, 'ravens_bills'), { draft: { favorite: 'away', text: '1' }, fromPodcast: false }, 'what was typed wins');
    });

    await check('podcast starts from your solo guess, and it counts until you type your own', () => {
        site.guessState.weeks = { 8: {
            solo: { ravens_bills: { guess: -4.5, line: -3, at: 1 }, jets_patriots: { guess: 2, line: 3, at: 1 } },
            podcast: { ravens_bills: { sal: -3, line: -3.5 }, jets_patriots: { you: 1, bill: 6, line: 2.5 } } } };
        assert.strictEqual(site.podcastRow(8, 'ravens_bills').you, -4.5, 'your solo guess stands in');
        assert.strictEqual(site.podcastRow(8, 'jets_patriots').you, 1, 'what was typed in podcast wins');
        assert.strictEqual(site.podcastRow(8, 'chiefs_raiders').you, undefined, 'nothing guessed either way');
        // Ravens-Bills, line -3.5: you 1 off, Sal 0.5 (Sal). Jets-Patriots, line 2.5: you 1.5, Bill 3.5 (you).
        const score = site.podcastWeekScore(site.podcastRows(8));
        assert.strictEqual(score.you.games, 2, 'the solo guess is scored');
        assert.strictEqual(score.you.points, 1);
        assert.strictEqual(score.sal.points, 1);
    });

    await check('the cards: finished games first, then the rest, each by kickoff', () => {
        const games = ['A', 'B', 'C', 'D'].map(t => ({ away: t, home: 'Z' }));
        site.guessState.weeks = { 8: {
            podcast: { c_z: { you: -3, sal: -4, line: -3 }, a_z: { you: -3, line: -3 }, d_z: { you: 1, bill: 2, line: 1.5 } },
            solo: { b_z: { guess: -3, line: -3, at: 1 } } } };
        const keys = list => list.map(g => g.away);
        // a_z has a line but one guess: not scored, so not finished.
        assert.deepStrictEqual(keys(site.orderGuessGames('podcast', 8, games)), ['C', 'D', 'A', 'B']);
        assert.deepStrictEqual(keys(site.orderGuessGames('solo', 8, games)), ['B', 'A', 'C', 'D'], 'solo: submitted first');
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

    await check('the episode: the newest Guess the Lines show, and where the segment starts', () => {
        // The feed's shape, cut down from the real one (2 November 2026).
        const item = (title, description, date, url) => `<item><title><![CDATA[${title}]]></title>
            <description><![CDATA[<p>${description}</p>]]></description><pubDate>${date}</pubDate>
            <enclosure url="${url}" length="0" type="audio/mpeg"/></item>`;
        const feed = `<rss><channel><title>The Bill Simmons Podcast</title>
            ${item('NBA Power Poll 1.0', '(0:00) Intro', 'Tue, 03 Nov 2026 23:24:00 -0000', 'https://example.com/nba.mp3')}
            ${item('The Chiefs Choke, Lamar’s Out, and Guess the Lines With Cousin Sal',
                '(0:00) Intro (1:52) Eagles-Commanders (01:17:43) Colts-Jaguars (01:23:42) Guess the Lines Week 9 (01:39:42) Parent Corner',
                'Mon, 02 Nov 2026 08:07:00 -0000', 'https://pdst.fm/e/traffic.megaphone.fm/GLT4997860343.mp3')}
            ${item('A Giants Revival, and Guess the Lines With Cousin Sal', '(58:10) Guess the Lines Week 8',
                'Mon, 26 Oct 2026 06:24:00 -0000', 'https://example.com/old.mp3')}
        </channel></rss>`;
        const episode = site.parseGuessEpisode(feed);
        assert.strictEqual(episode.title, 'The Chiefs Choke, Lamar’s Out, and Guess the Lines With Cousin Sal');
        assert.strictEqual(episode.audio, 'https://pdst.fm/e/traffic.megaphone.fm/GLT4997860343.mp3');
        assert.strictEqual(episode.start, 1 * 3600 + 23 * 60 + 42);
        assert.strictEqual(episode.startLabel, '1:23:42');
        assert.strictEqual(episode.week, 9);
        assert.strictEqual(episode.artwork, null, 'no channel artwork in this feed');
        const art = site.parseGuessEpisode(feed.replace('<title>The Bill Simmons Podcast</title>', '<title>The Bill Simmons Podcast</title><itunes:image href="https://megaphone.imgix.net/podcasts/x/image/y.jpg?ixlib=rails-4.3.1&amp;max-w=3000&amp;max-h=3000&amp;fit=crop&amp;auto=format,compress"/>')).artwork;
        assert.strictEqual(art, 'https://megaphone.imgix.net/podcasts/x/image/y.jpg?ixlib=rails-4.3.1&fit=crop&auto=format%2Ccompress&w=192&h=192', 'the show artwork, asked for small');
        assert.strictEqual(episode.published, Date.UTC(2026, 10, 2, 8, 7));
        assert.strictEqual(site.parseGuessEpisode(feed.replace('(01:23:42) Guess the Lines Week 9', '')).start, null, 'no timestamp listed');
        assert.strictEqual(site.parseGuessEpisode('<rss><channel></channel></rss>'), null);
        assert.strictEqual(site.parseGuessEpisode(item('Guess the Lines', '', '', 'http://insecure.example/x.mp3')).audio, null, 'https only');
    });

    await check('the episodes: one a week this season, each matched to its week', () => {
        const item = (title, description, date) => `<item><title>${title}</title><description>${description}</description>
            <pubDate>${date}</pubDate><enclosure url="https://example.com/${encodeURIComponent(date)}.mp3"/></item>`;
        const feed = `<rss><channel>
            ${item('Week 9 recap and Guess the Lines With Cousin Sal', '(01:23:42) Guess the Lines Week 9', 'Mon, 02 Nov 2026 08:07:00 -0000')}
            ${item('Week 8 picks', '(0:00) Intro', 'Fri, 30 Oct 2026 02:50:00 -0000')}
            ${item('Week 2 and Guess the Lines With Cousin Sal', '(0:00) Intro (1:02:00) Bills-Ravens', 'Mon, 14 Sep 2026 07:00:00 -0000')}
            ${item('Last season and Guess the Lines With Cousin Sal', '(50:00) Guess the Lines Week 18', 'Mon, 29 Dec 2025 07:00:00 -0000')}
        </channel></rss>`;
        const episodes = site.parseGuessEpisodes(feed, Date.UTC(2026, 6, 1));
        assert.deepStrictEqual(episodes.map(e => e.week), [9, null], 'this season only, the recap-only show left out');
        // 2026: week 1 kicks off 10 Sep, week 2 on 17 Sep, week 3 on 24 Sep.
        const firstKickoffs = [, Date.UTC(2026, 8, 11, 0, 20), Date.UTC(2026, 8, 18, 0, 15), Date.UTC(2026, 8, 25, 0, 15)];
        assert.strictEqual(site.podcastEpisodeWeek(episodes[0], firstKickoffs), 9, 'the week its description names');
        assert.strictEqual(site.podcastEpisodeWeek(episodes[1], firstKickoffs), 2, 'no segment listed: the first week after it came out');
        assert.strictEqual(site.podcastEpisodeWeek({ week: null, published: null }, firstKickoffs), null);
    });

    await check('off by: a colour band, harsher the further', () => {
        const bands = [0, 0.5, 1, 1.5, 2.5, 3, 4.5, 5, 6.5, 7, 13.5].map(site.guessOffBand);
        assert.deepStrictEqual(bands, ['exact', 'off-near', 'off-near', 'off-close', 'off-close', 'off-fg', 'off-fg', 'off-far', 'off-far', 'off-td', 'off-td']);
        assert.strictEqual(site.guessOffBand(null), '');
    });

    await check('podcast rows name the guesser, not "You"', () => {
        const you = site.PODCAST_PLAYERS.find(p => p.field === 'you');
        site.guessState.picker = null;
        assert.strictEqual(site.podcastPlayerName(you), 'You');
        site.guessState.picker = 'Sean';
        assert.strictEqual(site.podcastPlayerName(you), 'Sean');
        assert.strictEqual(site.podcastPlayerName(you, true), 'Sean');
        assert.strictEqual(site.podcastPlayerName(site.PODCAST_PLAYERS[1], true), 'Sal');
        site.guessState.picker = null;
    });

    fs.unlinkSync(tmp);
    console.log(`\n${total - failures}/${total} passed`);
    process.exit(failures ? 1 : 0);
})();
