// Tests for picks that were made, shown, and then silently lost.
//
// The debounced sync used to send whatever currentPicker and currentWeek were
// when its 5s timer FIRED, not what was picked. Pick three games, switch to
// another picker or tap next week inside the window, and the sync went out for
// the wrong slate - usually unchanged, so deduped to nothing. A failed write
// was not retried and, from a pick click, not even reported. Either way the
// next load took the sheet as the source of truth and the picks were gone.
//
// Runs app.js in Node with browser stubs, a fake clock and a scripted network.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEAMS = [['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins']];
const WEEK = 5;

// --- a clock the test drives -------------------------------------------------

function makeClock() {
    let now = 0, seq = 0;
    const timers = new Map();
    const flushMicrotasks = async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return {
        setTimeout(fn, ms = 0) {
            const id = ++seq;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        async advance(ms) {
            const end = now + ms;
            await flushMicrotasks();
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, t]) => t.at <= end)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await flushMicrotasks();
            }
            now = end;
        }
    };
}

// --- the app, with its storage, network and clock swapped out -----------------

function makeEnv({ store = new Map(), backup = { picks: {}, cleared: {} } } = {}) {
    const clock = makeClock();
    const posts = [];
    const toasts = [];
    const net = { failing: false, gate: null };
    const el = () => ({
        style: {}, remove() {}, setAttribute() {}, appendChild() {},
        classList: { add() {}, remove() {}, toggle() {} }
    });
    const env = {
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k),
            key: i => Array.from(store.keys())[i] || null,
            get length() { return store.size; }
        },
        document: {
            addEventListener: () => {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: el,
            head: { appendChild: () => {} },
            body: {
                appendChild: node => { if (node.className === 'toast') toasts.push(node); },
                classList: { add() {}, remove() {}, toggle() {} }
            },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async (url, opts = {}) => {
            if (opts.method === 'POST') {
                if (net.gate) await net.gate;
                if (net.failing) throw new TypeError('Failed to fetch');
                posts.push({ body: JSON.parse(opts.body), keepalive: opts.keepalive });
                return { ok: true, text: async () => JSON.stringify({ success: true }) };
            }
            if (String(url).includes('action=allpicks')) {
                return { ok: true, json: async () => backup };
            }
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {}, confirm: () => false,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;

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
        savePicksToStorage, flushPendingSync, loadAllPicksFromBackup, toSheetWeek,
        NFL_GAMES_BY_WEEK, UNSYNCED_PICKS_KEY, SYNC_DEBOUNCE_MS,
        __state: () => ({ allPicks, clearedPicks, currentWeek, currentPicker }),
        __setState: s => {
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('clearedPicks' in s) clearedPicks = s.clearedPicks;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        'setTimeout', 'clearTimeout',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia,
        clock.setTimeout, clock.clearTimeout);

    [WEEK, WEEK + 1].forEach(week => {
        api.NFL_GAMES_BY_WEEK[week] = TEAMS.map(([away, home], i) => ({
            id: i + 1, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM'
        }));
    });
    return { api, clock, posts, toasts, net, store };
}

// What a pick click does: change allPicks for the slate on screen, then save.
function pick(t, key, side) {
    const { allPicks, currentWeek, currentPicker } = t.api.__state();
    if (!allPicks[currentWeek]) allPicks[currentWeek] = {};
    if (!allPicks[currentWeek][currentPicker]) allPicks[currentWeek][currentPicker] = {};
    allPicks[currentWeek][currentPicker][key] = { line: side, winner: side };
    t.api.savePicksToStorage();
}

function start(opts) {
    const t = makeEnv(opts);
    t.api.__setState({ currentWeek: WEEK, currentPicker: 'Stephen', allPicks: {} });
    return t;
}

const sentFor = (t, picker, week = WEEK) =>
    t.posts.filter(p => p.body.picker === picker && p.body.week === t.api.toSheetWeek(week));
const linePick = (post, key) => post.body.picks.find(p => p.gameId === key).linePick;
const unsynced = t => JSON.parse(t.store.get(t.api.UNSYNCED_PICKS_KEY) || '{}');

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('The debounce sends the slate that changed, not the one on screen');

await check('switching picker inside the window still sends the first picker', async () => {
    const t = start();
    pick(t, 'rams_seahawks', 'home');
    pick(t, 'bills_chiefs', 'away');
    t.api.__setState({ currentPicker: 'Sean' });   // a shared phone, 2s later
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);

    const sent = sentFor(t, 'Stephen');
    assert.strictEqual(sent.length, 1, "Stephen's picks were sent");
    assert.strictEqual(linePick(sent[0], 'rams_seahawks'), 'Seahawks');
    assert.strictEqual(linePick(sent[0], 'bills_chiefs'), 'Bills');
    assert.strictEqual(sentFor(t, 'Sean').length, 0, 'and nothing was written as Sean');
});

await check('moving to next week inside the window still sends this week', async () => {
    const t = start();
    pick(t, 'jets_dolphins', 'away');
    t.api.__setState({ currentWeek: WEEK + 1 });
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);

    const sent = sentFor(t, 'Stephen', WEEK);
    assert.strictEqual(sent.length, 1, 'week 5 was sent');
    assert.strictEqual(linePick(sent[0], 'jets_dolphins'), 'Jets');
    assert.strictEqual(sentFor(t, 'Stephen', WEEK + 1).length, 0, 'week 6 was not');
});

await check('two pickers inside one window are both sent', async () => {
    const t = start();
    pick(t, 'rams_seahawks', 'home');
    t.api.__setState({ currentPicker: 'Sean' });
    pick(t, 'rams_seahawks', 'away');
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);

    assert.strictEqual(linePick(sentFor(t, 'Stephen')[0], 'rams_seahawks'), 'Seahawks');
    assert.strictEqual(linePick(sentFor(t, 'Sean')[0], 'rams_seahawks'), 'Rams');
});

await check('a run of clicks is still one write', async () => {
    const t = start();
    for (const [away, home] of TEAMS) {
        pick(t, `${away.toLowerCase()}_${home.toLowerCase()}`, 'home');
        await t.clock.advance(1000);
    }
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);
    assert.strictEqual(t.posts.length, 1);
});

section('A failed write is retried, and says so');

await check('a failure is reported once, kept, and retried until it lands', async () => {
    const t = start();
    t.net.failing = true;
    pick(t, 'rams_seahawks', 'home');
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);

    assert.strictEqual(t.posts.length, 0);
    assert.ok(`${WEEK}|Stephen` in unsynced(t), 'still queued, and persisted');
    assert.strictEqual(t.toasts.length, 1, 'the pick click that failed says so');
    assert.match(t.toasts[0].textContent, /kept on this device/);

    await t.clock.advance(60000);   // several retries, still down
    assert.strictEqual(t.toasts.length, 1, 'one warning, not one per retry');

    t.net.failing = false;
    await t.clock.advance(300000);
    assert.strictEqual(sentFor(t, 'Stephen').length, 1, 'the retry landed');
    assert.deepStrictEqual(unsynced(t), {}, 'and the queue is empty');
    assert.match(t.toasts[t.toasts.length - 1].textContent, /saved to Google Sheets/);
});

await check('a pick made while a write is in flight goes out behind it', async () => {
    const t = start();
    let release;
    t.net.gate = new Promise(r => { release = r; });
    pick(t, 'rams_seahawks', 'home');
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);   // the write is out, and held
    pick(t, 'bills_chiefs', 'away');                 // a pick lands mid-flight
    t.net.gate = null;
    release();
    await t.clock.advance(t.api.SYNC_DEBOUNCE_MS);

    const sent = sentFor(t, 'Stephen');
    assert.strictEqual(sent.length, 2, 'the in-flight write, then one behind it');
    assert.strictEqual(linePick(sent[0], 'bills_chiefs'), '', 'the first went out before the pick');
    assert.strictEqual(linePick(sent[1], 'bills_chiefs'), 'Bills', 'the later pick was sent');
    assert.deepStrictEqual(unsynced(t), {});
});

await check('hiding the tab flushes with keepalive', async () => {
    const t = start();
    pick(t, 'rams_seahawks', 'home');
    await t.api.flushPendingSync({ keepalive: true });
    assert.strictEqual(t.posts.length, 1, 'sent without waiting out the debounce');
    assert.strictEqual(t.posts[0].keepalive, true);
});

section('The backup does not overwrite what this device has not sent yet');

await check('a reload keeps unsent picks over an older backup, then sends them', async () => {
    // First visit: the pick is made and the write fails. The tab is closed.
    const first = start();
    first.net.failing = true;
    pick(first, 'rams_seahawks', 'home');
    await first.clock.advance(first.api.SYNC_DEBOUNCE_MS);
    assert.strictEqual(first.posts.length, 0);

    // Next visit: same browser storage, and a backup holding the OLD pick.
    const sheetWeek = first.api.toSheetWeek(WEEK);
    const backup = {
        picks: { [sheetWeek]: {
            Stephen: { rams_seahawks: { line: 'away', winner: 'away' } },
            Sean: { rams_seahawks: { line: 'home', winner: 'home' } }
        } },
        cleared: {}
    };
    const t = makeEnv({ store: first.store, backup });
    t.api.__setState({ currentWeek: WEEK, currentPicker: 'Stephen',
        allPicks: JSON.parse(first.store.get(`nflPicks_${new Date().getMonth() >= 6
            ? new Date().getFullYear() : new Date().getFullYear() - 1}`)) });
    await t.api.loadAllPicksFromBackup();

    const { allPicks } = t.api.__state();
    assert.strictEqual(allPicks[WEEK].Stephen.rams_seahawks.line, 'home', 'the unsent pick survived');
    assert.strictEqual(allPicks[WEEK].Sean.rams_seahawks.line, 'home', 'other slates still load');

    await t.clock.advance(1);
    const sent = sentFor(t, 'Stephen');
    assert.strictEqual(sent.length, 1, 'and it was sent straight away');
    assert.strictEqual(linePick(sent[0], 'rams_seahawks'), 'Seahawks');
});

await check("a stale 'cleared' flag does not wipe picks made since", async () => {
    const t = start({
        backup: { picks: {}, cleared: { [`${new Date().getMonth() >= 6
            ? new Date().getFullYear() : new Date().getFullYear() - 1}_${WEEK}`]: { Stephen: true } } }
    });
    t.net.failing = true;
    pick(t, 'rams_seahawks', 'home');
    await t.api.loadAllPicksFromBackup();

    const { allPicks, clearedPicks } = t.api.__state();
    assert.strictEqual(allPicks[WEEK].Stephen.rams_seahawks.line, 'home', 'the new pick is kept');
    assert.ok(!clearedPicks[WEEK]?.Stephen, 'and the week is not marked cleared');
});

await check('a confirmed slate still takes the backup, as before', async () => {
    const sheetWeek = `${new Date().getMonth() >= 6
        ? new Date().getFullYear() : new Date().getFullYear() - 1}_${WEEK}`;
    const t = start({ backup: { picks: { [sheetWeek]: {
        Stephen: { rams_seahawks: { line: 'away', winner: 'away' } }
    } }, cleared: {} } });
    t.api.__setState({ allPicks: { [WEEK]: { Stephen: { rams_seahawks: { line: 'home' } } } } });
    await t.api.loadAllPicksFromBackup();
    assert.strictEqual(t.api.__state().allPicks[WEEK].Stephen.rams_seahawks.line, 'away',
        'the sheet is still the source of truth once nothing is pending');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
})();
