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
    if (u.startsWith('https://site.api.espn.com/')) return new Response(JSON.stringify(world.board));
    if (u.startsWith(APPS_SCRIPT_URL)) {
        const action = new URL(u).searchParams.get('action');
        appsScriptCalls.push(action);
        if (action === 'allpicks') return new Response(JSON.stringify({ picks: { '2026_5': world.picks } }));
        if (action === 'spreads') return new Response(JSON.stringify({ spreads: world.spreads }));
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
    world = { board: scoreboard(ALL_FINAL, FINALS), picks: fullPicks(), spreads: SPREADS };
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
        assert.strictEqual(data.title, 'Week 5 Blazin’ 5');
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

    await check('three hours before Thursday: only those without a pick on that game', async () => {
        world.board = scoreboard(PRE);
        world.picks = { Stephen: { bills_chiefs: plain('home') }, Sean: {}, Jason: { rams_seahawks: plain('away') } };
        await tick(T.thu - 2 * 60 * 60 * 1000);
        assert.strictEqual(sent.length, 1);
        const { data } = sent[0];
        assert.strictEqual(data.category, 'pick_reminders');
        assert.strictEqual(data.title, 'Thursday kickoff in 3 hours');
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
        assert.strictEqual(personal.Sean, 'You still have 3 games and 4 Blazin’ stars to pick.');
    });

    await check('not before the window, and once only within it', async () => {
        world.board = scoreboard(PRE);
        world.picks = {};
        await tick(T.thu - 4 * 60 * 60 * 1000);
        assert.strictEqual(sent.length, 0, 'four hours out is too early');
        await tick(T.thu - 2 * 60 * 60 * 1000);
        await tick(T.thu - 1 * 60 * 60 * 1000);
        assert.strictEqual(sent.length, 1);
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
