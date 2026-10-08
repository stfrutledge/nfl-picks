// Tests for the worker's automatic notifications (the cron trigger):
// Blazin' 5 results once every starred game is final, and pick reminders
// before the week's first kickoff and before the weekend.
//
// The whole worker runs against a fake ESPN, a fake Apps Script, a fake KV and
// a fake Google, so nothing is fetched and nothing is sent. The most important
// check is the last section: the worker grades Blazin' 5 picks with its own
// small copy of the site's rule, and it must agree with the site's engine
// (calculateStatsForWeeks in app.js) on the same games.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { fixedClock } = require('./fixed-clock');

const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-auto-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE);

const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const ACCOUNT = {
    project_id: 'nfl-picks-test', client_email: 'sender@test.iam.gserviceaccount.com',
    private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token'
};
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';

// --- the week: 2026 week 5 ---------------------------------------------------
// Thu 8 Oct 8:15pm ET, three Sunday 1pm games, Sunday night, Monday night.
const T = {
    thu: Date.parse('2026-10-09T00:15:00Z'),
    sun: Date.parse('2026-10-11T17:00:00Z'),
    snf: Date.parse('2026-10-12T00:20:00Z'),
    mnf: Date.parse('2026-10-13T00:15:00Z')
};
const GAMES = [
    ['Buffalo Bills', 'Kansas City Chiefs', T.thu],
    ['Los Angeles Rams', 'Seattle Seahawks', T.sun],
    ['New York Jets', 'Miami Dolphins', T.sun],
    ['Chicago Bears', 'Green Bay Packers', T.sun],
    ['New York Giants', 'Philadelphia Eagles', T.snf],
    ['Dallas Cowboys', 'Washington Commanders', T.mnf]
];
const KEYS = ['bills_chiefs', 'rams_seahawks', 'jets_dolphins', 'bears_packers', 'giants_eagles', 'cowboys_commanders'];

// Every home side favoured by 3 on the board.
const SPREADS = Object.fromEntries(KEYS.map(k => [k, { spread: 3, favorite: 'home', overUnder: '' }]));

/** state per game: 'pre' | 'in' | 'post', with scores for the played ones. */
function scoreboard(states, scores = {}) {
    return {
        season: { year: 2026, type: 2 }, week: { number: 5 },
        events: GAMES.map(([away, home, kickoff], i) => ({
            date: new Date(kickoff).toISOString(),
            status: { type: { state: states[i], completed: states[i] === 'post' } },
            competitions: [{ competitors: [
                { homeAway: 'away', score: String(scores[i]?.[0] ?? 0), team: { displayName: away } },
                { homeAway: 'home', score: String(scores[i]?.[1] ?? 0), team: { displayName: home } }
            ] }]
        }))
    };
}

// Final scores: home wins every game by 7, except Jets 20 Dolphins 17 (a push
// at -3) and Bears 24 Packers 20 (away wins outright).
const FINALS = { 0: [17, 24], 1: [10, 17], 2: [17, 20], 3: [24, 20], 4: [13, 20], 5: [14, 21] };
const ALL_FINAL = ['post', 'post', 'post', 'post', 'post', 'post'];

const star = (line, extra = {}) => ({ line, winner: line, blazin: true, ...extra });
const plain = line => ({ line, winner: line, blazin: false });

/** Everyone's five stars on the first five games; Cowherd on three. */
function fullPicks() {
    return {
        Stephen: Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('home')])),   // W W P L W -> 3-1-1
        Sean: Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('away')])),      // L L P W L -> 1-3-1
        Dylan: { ...Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('home')])),
            // Locked on the Packers at -1: a 4-point Bears win is still a loss,
            // and the Seahawks at a locked -10 do not cover a 7-point win.
            bears_packers: star('home', { frozenAt: '2026-10-10T12:00:00Z', frozenSpread: 1, frozenFavorite: 'home' }),
            rams_seahawks: star('home', { frozenAt: '2026-10-10T12:00:00Z', frozenSpread: 10, frozenFavorite: 'home' }) },
        Daniel: Object.fromEntries(KEYS.slice(0, 5).map((k, i) => [k, star(i % 2 ? 'home' : 'away')])),
        Jason: { ...Object.fromEntries(KEYS.map(k => [k, plain('home')])),
            ...Object.fromEntries(KEYS.slice(1, 6).map(k => [k, star('home')])) },
        Cowherd: { bills_chiefs: star('home'), jets_dolphins: star('away'), bears_packers: star('away') }
    };
}

// --- fakes -------------------------------------------------------------------

let world;   // { board, picks, spreads }
const sent = [];
const appsScriptCalls = [];
const kv = new Map();

globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://site.api.espn.com/')) {
        const week = new URL(u).searchParams.get('week');
        return new Response(JSON.stringify(week ? world.weekBoards[week] : world.board));
    }
    if (u.startsWith(APPS_SCRIPT_URL)) {
        const action = new URL(u).searchParams.get('action');
        appsScriptCalls.push(action);
        if (action === 'allpicks') return new Response(JSON.stringify({ picks: { ...world.earlierPicks, '2026_5': world.picks } }));
        if (action === 'spreads') return new Response(JSON.stringify({ spreads: world.spreads }));
        if (action === 'allresults') {
            if (world.resultsDown) return new Response('down', { status: 500 });
            return new Response(JSON.stringify({ results: world.results }));
        }
    }
    if (u === ACCOUNT.token_uri) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (u.startsWith('https://fcm.googleapis.com/')) {
        sent.push(JSON.parse(init.body).message);
        return new Response(JSON.stringify({ name: 'projects/x/messages/1' }));
    }
    throw new Error('unexpected fetch ' + u);
};

const ENV = {
    APPS_SCRIPT_URL,
    FCM_SERVICE_ACCOUNT: JSON.stringify(ACCOUNT),
    NOTIFY_SECRET: 's',
    NOTIFY_STATE: {
        get: async k => kv.get(k) ?? null,
        put: async (k, v) => { kv.set(k, v); }
    }
};

let worker;
const realNow = Date.now;
async function tick(nowMs, env = ENV) {
    Date.now = () => nowMs;
    try {
        const pending = [];
        await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: nowMs }, env, { waitUntil: p => pending.push(p) });
        await Promise.all(pending);
    } finally {
        Date.now = realNow;
    }
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    sent.length = 0; appsScriptCalls.length = 0; kv.clear();
    world = { board: scoreboard(ALL_FINAL, FINALS), picks: fullPicks(), spreads: SPREADS,
        earlierPicks: {}, results: {}, resultsDown: false, weekBoards: {} };
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

const TUE_MORNING = Date.parse('2026-10-13T08:00:00Z');

(async () => {
    worker = (await import(pathToFileURL(tmp).href)).default;
    const silence = console.log;   // the scheduled handler logs its result

    section('Blazin’ 5 results');

    await check('sent once every starred game is final, spoiler-free text included', async () => {
        await tick(TUE_MORNING);
        assert.strictEqual(sent.length, 1);
        const { data, topic, notification } = sent[0];
        assert.strictEqual(topic, 'group');
        assert.strictEqual(notification, undefined, 'data-only: the phone decides');
        assert.strictEqual(data.category, 'blazin_results');
        assert.strictEqual(data.id, 'blazin-2026-5');
        assert.strictEqual(data.title, 'Blazin’ 5 Results - Week 5');
        assert.strictEqual(data.spoilerTitle, 'Blazin’ 5 Results - Week 5');
        assert.match(data.spoilerBody, /Results are in/);
        assert.ok(!/\d-\d/.test(data.spoilerBody), 'no records in the spoiler-free text');
    });

    await check('the records, best first, Cowherd last', async () => {
        // Home covers every game but two: Jets-Dolphins is a push at -3, and
        // the Bears win outright. Jason's stars sit on games 2-6 (W P L W W);
        // Dylan's locked -10 and -1 both lose; Cowherd goes W, P, W.
        await tick(TUE_MORNING);
        assert.strictEqual(sent[0].data.body,
            'Jason 3-1-1, Stephen 3-1-1, Dylan 2-2-1, Daniel 1-3-1, Sean 1-3-1. Cowherd 2-0-1.');
    });

    // Week 4, already in the Results tab: the same six games, every home side
    // winning by 7 at -3, so a home star wins and an away star loses.
    const WEEK4_RESULTS = Object.fromEntries(KEYS.map(k => [k, { awayScore: 10, homeScore: 17 }]));

    await check('each phone gets only its own picker’s week, season and a pointer to the site', async () => {
        world.earlierPicks = {
            '2026_4': {
                Stephen: Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('home')])),   // 5-0
                Sean: Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('away')]))       // 0-5
            },
            '2025_4': { Stephen: { bills_chiefs: star('away') } }   // another season: ignored
        };
        world.results = { '2026_4': WEEK4_RESULTS, '2025_4': WEEK4_RESULTS };
        await tick(TUE_MORNING);
        const personal = JSON.parse(sent[0].data.personal);
        assert.deepStrictEqual(Object.keys(personal).sort(), ['Daniel', 'Dylan', 'Jason', 'Sean', 'Stephen']);
        // Stephen: 3-1-1 this week + 5-0 in week 4 = 8-1-1, 8/9 decided.
        assert.strictEqual(personal.Stephen,
            'You went 3-1-1 this week. Season: 8-1-1 (88.9%). See the site for everyone’s results.');
        // Sean: 1-3-1 + 0-5 = 1-8-1.
        assert.strictEqual(personal.Sean,
            'You went 1-3-1 this week. Season: 1-8-1 (11.1%). See the site for everyone’s results.');
        // Daniel starred nothing in week 4: his season is this week alone.
        assert.strictEqual(personal.Daniel,
            'You went 1-3-1 this week. Season: 1-3-1 (25.0%). See the site for everyone’s results.');
        assert.ok(!Object.values(personal).some(t => /Stephen|Sean|Jason|Dylan|Daniel/.test(t)),
            'nobody else’s name in anyone’s line');
    });

    await check('a picker with no stars this week still gets their season', async () => {
        delete world.picks.Daniel;
        world.picks.Daniel = { cowboys_commanders: plain('home') };
        world.earlierPicks = { '2026_4': { Daniel: { rams_seahawks: star('home'), jets_dolphins: star('home') } } };
        world.results = { '2026_4': WEEK4_RESULTS };
        await tick(TUE_MORNING);
        assert.strictEqual(JSON.parse(sent[0].data.personal).Daniel,
            'You had no Blazin’ 5 picks this week. Season: 2-0 (100.0%). See the site for everyone’s results.');
    });

    await check('the sheet down: the week’s record still goes out, without a season line', async () => {
        world.earlierPicks = { '2026_4': { Stephen: { bills_chiefs: star('home') } } };
        world.resultsDown = true;
        await tick(TUE_MORNING);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(JSON.parse(sent[0].data.personal).Stephen,
            'You went 3-1-1 this week. See the site for everyone’s results.');
    });

    await check('never sent twice', async () => {
        await tick(TUE_MORNING);
        await tick(TUE_MORNING + 15 * 60 * 1000);
        assert.strictEqual(sent.length, 1);
    });

    await check('not while a starred game is still being played', async () => {
        world.board = scoreboard(['post', 'post', 'post', 'post', 'in', 'pre'], FINALS);
        await tick(T.snf + 60 * 60 * 1000);
        assert.strictEqual(sent.length, 0);
    });

    await check('not while someone can still add a star to a game not yet started', async () => {
        // Sunday night: Monday night is still to come, and Cowherd aside,
        // Daniel has only four stars.
        world.picks.Daniel = Object.fromEntries(KEYS.slice(0, 4).map(k => [k, star('away')]));
        world.board = scoreboard(['post', 'post', 'post', 'post', 'post', 'pre'], FINALS);
        await tick(T.mnf - 60 * 60 * 1000);
        assert.strictEqual(sent.filter(m => m.data.category === 'blazin_results').length, 0);
    });

    await check('but sent on Sunday night when everyone has placed all five', async () => {
        // Jason’s fifth star is on Monday night’s game, so move it.
        world.picks.Jason = Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('home')]));
        world.board = scoreboard(['post', 'post', 'post', 'post', 'post', 'pre'], FINALS);
        await tick(T.mnf - 60 * 60 * 1000);
        assert.strictEqual(sent.filter(m => m.data.category === 'blazin_results').length, 1);
    });

    await check('a quiet day costs no call to the sheet', async () => {
        world.board = scoreboard(['pre', 'pre', 'pre', 'pre', 'pre', 'pre']);
        await tick(T.thu - 2 * 24 * 60 * 60 * 1000);
        assert.deepStrictEqual(appsScriptCalls, []);
        assert.strictEqual(sent.length, 0);
    });

    await check('an unconfigured worker does nothing', async () => {
        await tick(TUE_MORNING, { ...ENV, NOTIFY_STATE: undefined });
        assert.strictEqual(sent.length, 0);
    });

    section('Pick reminders');

    const PRE = ['pre', 'pre', 'pre', 'pre', 'pre', 'pre'];

    // Thursday 8 October, noon in Dublin (Irish summer time, UTC+1).
    const THU_NOON_IRELAND = Date.parse('2026-10-08T11:00:00Z');

    await check('noon Thursday, Irish time: only those without a pick on that night’s game', async () => {
        world.board = scoreboard(PRE);
        world.picks = { Stephen: { bills_chiefs: plain('home') }, Sean: {}, Jason: { rams_seahawks: plain('away') } };
        await tick(THU_NOON_IRELAND + 5 * 60 * 1000);
        assert.strictEqual(sent.length, 1);
        const { data } = sent[0];
        assert.strictEqual(data.category, 'pick_reminders');
        assert.strictEqual(data.title, 'Thursday night’s game: picks due');
        assert.strictEqual(data.expiresAt, String(T.thu), 'stale at kickoff');
        const personal = JSON.parse(data.personal);
        assert.deepStrictEqual(Object.keys(personal).sort(), ['Daniel', 'Dylan', 'Jason', 'Sean']);
        assert.strictEqual(personal.Sean, 'You still have 1 game to pick.', 'Thursday only, no stars yet');
    });

    await check('three hours before the weekend: every game left, and the stars', async () => {
        world.board = scoreboard(['post', 'pre', 'pre', 'pre', 'pre', 'pre'], FINALS);
        world.picks = {
            Stephen: { ...Object.fromEntries(KEYS.map(k => [k, plain('home')])),
                ...Object.fromEntries(KEYS.slice(1, 6).map(k => [k, star('home')])) },     // all done
            Sean: { rams_seahawks: star('home'), jets_dolphins: plain('home') }              // 3 games, 4 stars
        };
        await tick(T.sun - 60 * 60 * 1000);
        const reminder = sent.find(m => m.data.id === 'reminder-2026-5-weekend');
        assert.ok(reminder, 'sent');
        assert.strictEqual(reminder.data.title, 'Sunday kickoff in 3 hours');
        const personal = JSON.parse(reminder.data.personal);
        assert.ok(!('Stephen' in personal), 'nothing to remind Stephen of');
        assert.strictEqual(personal.Sean, 'You still have 3 games to pick and 4 Blazin’ 5 picks to make.');
    });

    await check('not before noon in Ireland, and once only after it', async () => {
        world.board = scoreboard(PRE);
        world.picks = {};
        await tick(THU_NOON_IRELAND - 15 * 60 * 1000);
        assert.strictEqual(sent.length, 0, '11:45 is too early');
        await tick(THU_NOON_IRELAND);
        await tick(THU_NOON_IRELAND + 15 * 60 * 1000);
        await tick(T.thu - 60 * 60 * 1000);
        assert.strictEqual(sent.length, 1);
    });

    await check('after the clocks go back, noon is still noon in Ireland', async () => {
        // Thursday 5 November: Ireland went back to GMT on 25 October and the
        // US to EST on 1 November, so the week runs four weeks later and an
        // hour later in UTC (8:15pm EST is 01:15 UTC). Noon in Ireland is now
        // 12:00 UTC, not 11:00.
        const games = GAMES.map(([a, h, k]) => [a, h, k + 28 * 24 * 60 * 60 * 1000]);
        const board = scoreboard(PRE);
        board.events.forEach((e, i) => { e.date = new Date(games[i][2] + 60 * 60 * 1000).toISOString(); });
        world.board = board;
        world.picks = {};
        await tick(Date.parse('2026-11-05T11:50:00Z'));
        assert.strictEqual(sent.length, 0, '11:50 GMT is before noon');
        await tick(Date.parse('2026-11-05T12:05:00Z'));
        assert.strictEqual(sent.length, 1);
    });

    await check('the weekend still has exactly one reminder, three hours before', async () => {
        world.board = scoreboard(['post', 'pre', 'pre', 'pre', 'pre', 'pre'], FINALS);
        world.picks = {};
        await tick(T.sun - 3 * 60 * 60 * 1000 - 60 * 1000);
        assert.strictEqual(sent.length, 0, 'not before 3 hours out');
        for (const minutes of [0, 15, 30, 60, 120, 170]) await tick(T.sun - 3 * 60 * 60 * 1000 + minutes * 60 * 1000);
        assert.strictEqual(sent.filter(m => m.data.id.endsWith('-weekend')).length, 1);
        assert.strictEqual(sent.length, 1, 'and nothing else');
    });

    await check('everyone done: nothing sent, and not asked again', async () => {
        world.board = scoreboard(PRE);
        world.picks = Object.fromEntries(['Daniel', 'Dylan', 'Jason', 'Sean', 'Stephen'].map(p =>
            [p, { bills_chiefs: plain('home') }]));
        await tick(T.thu - 2 * 60 * 60 * 1000);
        assert.strictEqual(sent.length, 0);
        appsScriptCalls.length = 0;
        await tick(T.thu - 60 * 60 * 1000);
        assert.deepStrictEqual(appsScriptCalls, [], 'the slate is settled');
    });

    section('Admin Settings’ real-data tests');

    async function preview(kind, auth = 'Bearer s') {
        const r = await worker.fetch(new Request('https://w.example/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ token: 'my-phone', preview: kind })
        }), ENV, { waitUntil() {} });
        return { status: r.status, json: await r.json() };
    }

    await check('the results test grades the real week and sends it to one phone', async () => {
        const r = await preview('blazin_results');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.sent, true);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].token, 'my-phone');
        assert.strictEqual(sent[0].topic, undefined, 'never the group');
        assert.strictEqual(sent[0].data.title, 'Blazin’ 5 Results - Week 5');
        assert.strictEqual(sent[0].data.body,
            'Jason 3-1-1, Stephen 3-1-1, Dylan 2-2-1, Daniel 1-3-1, Sean 1-3-1. Cowherd 2-0-1.',
            'the same grading as the real notification');
        assert.ok(!kv.size, 'a test does not count as the week’s real send');
    });

    await check('mid-week it says how many starred games are still to finish', async () => {
        world.board = scoreboard(['post', 'post', 'post', 'in', 'pre', 'pre'], FINALS);
        await preview('blazin_results');
        // Games 4 (in play), 5 and 6 are still to finish, and all carry a star
        // - Jason's fifth is on Monday night.
        assert.match(sent[0].data.body, /As it stands: 3 starred games still to finish\.$/);
    });

    await check('with no stars yet this week, the results test shows last week', async () => {
        // Week 5 has just started and nobody has starred anything; week 4 was
        // the same six games, all played.
        world.board = scoreboard(['pre', 'pre', 'pre', 'pre', 'pre', 'pre']);
        world.weekBoards['4'] = { ...scoreboard(ALL_FINAL, FINALS), week: { number: 4 } };
        world.earlierPicks = { '2026_4': fullPicks() };
        world.picks = {};
        const r = await preview('blazin_results');
        assert.strictEqual(r.json.sent, true);
        assert.strictEqual(r.json.week, 4);
        assert.strictEqual(sent[0].data.title, 'Blazin’ 5 Results - Week 4');
        assert.ok(JSON.parse(sent[0].data.personal).Stephen.startsWith('You went 3-1-1 this week.'));
    });

    await check('the reminder test lists everyone with picks to make', async () => {
        world.board = scoreboard(['post', 'pre', 'pre', 'pre', 'pre', 'pre'], FINALS);
        world.picks = {
            Stephen: { ...Object.fromEntries(KEYS.map(k => [k, plain('home')])),
                ...Object.fromEntries(KEYS.slice(1, 6).map(k => [k, star('home')])) },
            Sean: { rams_seahawks: star('home'), jets_dolphins: plain('home') }
        };
        await preview('pick_reminders');
        const { data, token } = sent[0];
        assert.strictEqual(token, 'my-phone');
        assert.strictEqual(data.category, 'pick_reminders');
        assert.strictEqual(data.title, 'Still to pick - Week 5');
        assert.strictEqual(data.personal, undefined, 'one list, not per-picker lines');
        assert.ok(data.body.includes('Sean: 3 games to pick and 4 Blazin’ 5 picks to make'), data.body);
        assert.ok(data.body.includes('Jason: 5 games to pick and 5 Blazin’ 5 picks to make'), data.body);
        assert.ok(!data.body.includes('Stephen'), 'Stephen is done');
    });

    await check('nothing to show: nothing sent, and the answer says why', async () => {
        world.picks = Object.fromEntries(['Daniel', 'Dylan', 'Jason', 'Sean', 'Stephen'].map(p =>
            [p, { ...Object.fromEntries(KEYS.map(k => [k, plain('home')])),
                ...Object.fromEntries(KEYS.slice(0, 5).map(k => [k, star('home')])) }]));
        world.board = scoreboard(['pre', 'pre', 'pre', 'pre', 'pre', 'pre']);
        const r = await preview('pick_reminders');
        assert.strictEqual(r.json.sent, false);
        assert.match(r.json.note, /picks are in/);
        assert.strictEqual(sent.length, 0);
    });

    await check('a preview still needs the admin key', async () => {
        const r = await preview('blazin_results', 'Bearer wrong');
        assert.strictEqual(r.status, 401);
        assert.strictEqual(sent.length, 0);
    });

    section('The worker grades exactly as the site does');

    await check('every picker’s Blazin’ record matches calculateStatsForWeeks', async () => {
        await tick(TUE_MORNING);
        const fromWorker = Object.fromEntries(sent[0].data.body.replace(/\.$/, '').split(/, |\. /)
            .map(s => s.trim().split(' ')).map(([name, rec]) => [name, rec]));

        const site = siteRecords(world.picks);
        for (const [picker, rec] of Object.entries(site)) {
            if (rec.wins + rec.losses + rec.pushes === 0) continue;
            const expected = `${rec.wins}-${rec.losses}${rec.pushes ? '-' + rec.pushes : ''}`;
            assert.strictEqual(fromWorker[picker], expected, `${picker}: worker ${fromWorker[picker]}, site ${expected}`);
        }
    });

    console.log = silence;
    fs.unlinkSync(tmp);
    if (failures > 0) {
        console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
        process.exit(1);
    }
    console.log(`\nALL ${total} CHECKS PASSED\n`);
    process.exit(0);
})();

/** The site's engine over the same week: games, lines, results and picks. */
function siteRecords(picks) {
    const env = {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
        document: {
            addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild() {} }, body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, fetch: async () => { throw new Error('no fetch'); },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false, addEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    const src = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8')
        + '\nconst HISTORICAL_DATA_SEASON=2026,HISTORICAL_GAMES={},HISTORICAL_RESULTS={},HISTORICAL_PICKS={};\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + `;return { NFL_GAMES_BY_WEEK, calculateStatsForWeeks, PICKERS_WITH_COWHERD,
            setPicks: p => { allPicks = p; } };`;
    const api = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date', src)(
        env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia,
        fixedClock('2026-10-14T12:00:00Z'));

    const nickname = n => n.split(' ').pop();
    api.NFL_GAMES_BY_WEEK[5] = GAMES.map(([away, home, kickoff], i) => ({
        id: i + 1, away: nickname(away), home: nickname(home), spread: 3, favorite: 'home',
        kickoff: new Date(kickoff).toISOString(), completed: true, status: 'STATUS_FINAL',
        awayScore: FINALS[i][0], homeScore: FINALS[i][1]
    }));
    api.setPicks({ 5: picks });
    const computed = api.calculateStatsForWeeks(5, 5, api.PICKERS_WITH_COWHERD);
    return Object.fromEntries(Object.entries(computed).map(([p, s]) => [p, s.blazin]));
}
