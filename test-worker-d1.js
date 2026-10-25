// Tests for picks in D1 (D1-PICKS-PLAN.md): the worker's save path, the read
// switch, the fallback to the sheet when D1 refuses, the queues both ways,
// the free-limit warning, the copy in from the sheet, and - the one that
// matters most - that the worker's fold of the log gives exactly the picks
// the Apps Script's reader gives from the same rows.
//
// D1 is a real SQLite database in memory (node:sqlite) behind D1's API, the
// Apps Script is the real google-apps-script-simple.js over a stubbed sheet,
// and KV and Firebase are fakes. Nothing is fetched and nothing is sent.
process.removeAllListeners('warning');   // node:sqlite announces itself as experimental
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-d1-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE + '\nexport { readSeasonPicks, runPicksDbMaintenance, comparePicks, importPicksFromSheet };\n');

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
const SECRET = 'admin-secret';
const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const ACCOUNT = { project_id: 'nfl-picks-test', client_email: 'sender@test.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' };

// --- D1 on node:sqlite -------------------------------------------------------

function fakeD1() {
    const db = new DatabaseSync(':memory:');
    const state = { failWith: null, queries: 0 };
    const fix = v => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
    const statement = (sql, args = []) => ({
        sql, args,
        bind: (...a) => statement(sql, a),
        async all() {
            if (state.failWith) throw new Error(state.failWith);
            state.queries++;
            const rows = db.prepare(sql).all(...args.map(fix)).map(r => ({ ...r }));
            return { results: rows, meta: { rows_read: Math.max(rows.length, 1), rows_written: 0 } };
        },
        async run() {
            if (state.failWith) throw new Error(state.failWith);
            state.queries++;
            const r = db.prepare(sql).run(...args.map(fix));
            return { meta: { changes: Number(r.changes), rows_read: 1, rows_written: Number(r.changes) } };
        }
    });
    return {
        state, raw: db,
        prepare: sql => statement(sql),
        async batch(statements) {
            if (state.failWith) throw new Error(state.failWith);
            db.exec('BEGIN');
            try {
                const out = [];
                for (const s of statements) out.push(await (/^\s*(SELECT)/i.test(s.sql) ? s.all() : s.run()));
                db.exec('COMMIT');
                return out;
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        }
    };
}

function fakeKv() {
    const m = new Map();
    return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } };
}

// --- The real Apps Script over a stubbed sheet --------------------------------

const HEADER = ['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team', 'Away Spread', 'Home Spread',
    'Line Pick', 'Winner Pick', 'Blazin', 'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome', 'Frozen At'];

function appsScript(backup, cleared = []) {
    const sheets = { Backup: [HEADER, ...backup], ClearedPicks: [['Week', 'Picker', 'Cleared', 'Timestamp'], ...cleared] };
    const SpreadsheetApp = {
        getActiveSpreadsheet: () => ({
            getSheetByName: name => sheets[name] ? {
                getDataRange: () => ({ getValues: () => sheets[name] }),
                getRange: () => ({ getValues: () => [HEADER], setValue() {}, setValues() {}, setFontWeight() {} }),
                appendRow: row => sheets[name].push(row)
            } : null,
            insertSheet: () => null
        })
    };
    const src = fs.readFileSync(path.join(__dirname, 'google-apps-script-simple.js'), 'utf8');
    const api = new Function('SpreadsheetApp', 'ContentService', 'Logger',
        src + ';return { getAllPicks, getBackupRows, getPicksForWeek, savePicks, saveClearedStatus };')(
        SpreadsheetApp, { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } }, { log() {} });
    api.sheets = sheets;
    return api;
}

/** One Backup row: [ts, week, picker, gameId, away, home, awaySp, homeSp, line, winner, blazin, ou, ouLine, -, -, -, frozenAt]. */
function row(ts, week, picker, away, home, { gameId = `${away.toLowerCase()}_${home.toLowerCase()}`, line = '', winner = '', blazin = false, spreads = ['+3', '-3'], frozenAt = '', ou = '', ouLine = '' } = {}) {
    return [ts, week, picker, gameId, away, home, spreads[0], spreads[1], line, winner, blazin ? 'Yes' : '', ou, ouLine, '', '', '', frozenAt];
}

// --- The world ------------------------------------------------------------------

let sheet, d1, kv, net;

/** fetch: the Apps Script (GET actions, POST saves), Google's token, FCM. */
function installFetch() {
    net = { sheetPosts: [], fcm: [], sheetDown: false };
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
        if (url.hostname === 'fcm.googleapis.com') { net.fcm.push(JSON.parse(init.body).message.data); return new Response(JSON.stringify({ name: 'm' })); }
        if (url.href.startsWith(APPS_SCRIPT_URL)) {
            if (net.sheetDown) return new Response('down', { status: 503 });
            if ((init.method || 'GET') === 'POST') {
                const data = JSON.parse(init.body);
                net.sheetPosts.push(data);
                const results = {};
                if (typeof data.cleared === 'boolean') results.cleared = sheet.saveClearedStatus(data.week, data.picker, data.cleared);
                if (data.picks?.length) results.picks = sheet.savePicks(data.week, data.picker, data.picks);
                return new Response(JSON.stringify({ success: true, results }));
            }
            const p = url.searchParams;
            const season = p.get('season') ? Number(p.get('season')) : null;
            const body = p.get('action') === 'allpicks' ? sheet.getAllPicks(season)
                : p.get('action') === 'backuprows' ? sheet.getBackupRows(season)
                : p.get('action') === 'picks' ? sheet.getPicksForWeek(p.get('week'), p.get('picker'))
                : { error: 'unknown action' };
            return new Response(JSON.stringify(body));
        }
        throw new Error('unexpected fetch ' + url.href);
    };
}

function env(extra = {}) {
    return { APPS_SCRIPT_URL, NOTIFY_SECRET: SECRET, FCM_SERVICE_ACCOUNT: JSON.stringify(ACCOUNT), NOTIFY_STATE: kv, PICKS_DB: d1, ...extra };
}

function fresh(backup = [], cleared = []) {
    sheet = appsScript(backup, cleared);
    d1 = fakeD1();
    kv = fakeKv();
    installFetch();
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

(async () => {
    const mod = await import(pathToFileURL(tmp).href);
    const worker = mod.default;
    const waits = [];
    const ctx = { waitUntil: p => waits.push(p) };
    const settle = async () => { while (waits.length) await waits.shift(); };
    const post = (e, body) => worker.fetch(new Request('https://w.test/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }), e, ctx);
    const get = (e, qs) => worker.fetch(new Request(`https://w.test/sync?${qs}`), e, ctx);
    const admin = (e, p, method = 'GET') => worker.fetch(new Request(`https://w.test/admin/picks/${p}`, { method, headers: { Authorization: `Bearer ${SECRET}` } }), e, ctx);

    const pick = (away, home, line, extra = {}) => ({ gameId: `${away.toLowerCase()}_${home.toLowerCase()}`, away, home, awaySpread: '+3', homeSpread: '-3', linePick: line, winnerPick: line, blazin: false, overUnder: '', totalLine: '', ...extra });

    console.log('\nSaving');

    await check('during the trial the phone waits on the sheet, as today, and D1 is written beside it', async () => {
        fresh();
        const reply = await (await post(env(), { week: '2026_7', picker: 'Stephen', picks: [pick('Packers', 'Lions', 'Lions')] })).json();
        assert.strictEqual(reply.store, undefined, 'the sheet answered');
        assert.strictEqual(reply.results.picks.rowsAdded, 1);
        assert.strictEqual(sheet.sheets.Backup.length, 2, 'in the sheet before the reply');
        assert.strictEqual(d1.raw.prepare('SELECT COUNT(*) AS n FROM pick_rows').get().n, 1, 'and in D1');
        net.sheetDown = true;
        const res = await post(env(), { week: '2026_7', picker: 'Sean', picks: [pick('Packers', 'Lions', 'Lions')] });
        assert.strictEqual(res.status, 503, 'the sheet down is still a failure the phone retries');
        assert.ok(!kv.m.has('mirror:pending'), 'nothing queued: the retry delivers it');
    });

    await check('after the switch a save lands in D1, is answered at once, and the sheet gets its copy after', async () => {
        fresh();
        const res = await post(env({ PICKS_READ: 'd1' }), { week: '2026_7', picker: 'Stephen', picks: [pick('Packers', 'Lions', 'Lions', { blazin: true })], cleared: false });
        const reply = await res.json();
        assert.strictEqual(reply.success, true);
        assert.strictEqual(reply.store, 'd1');
        assert.strictEqual(reply.results.picks.rowsAdded, 1, 'the reply the site checks for');
        const rows = d1.raw.prepare('SELECT * FROM pick_rows').all();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].game_key, 'packers_lions');
        assert.strictEqual(rows[0].blazin, 1);
        await settle();
        assert.strictEqual(net.sheetPosts.length, 1, 'the sheet copy, in the background');
        assert.strictEqual(sheet.sheets.Backup.length, 2, 'and the row is in the sheet');
    });

    await check('after the switch a sheet copy that fails is queued, and the cron delivers it', async () => {
        fresh();
        net.sheetDown = true;
        await post(env({ PICKS_READ: 'd1' }), { week: '2026_7', picker: 'Sean', picks: [pick('Packers', 'Lions', 'Packers')] });
        await settle();
        assert.strictEqual(JSON.parse(kv.m.get('mirror:pending')).length, 1);
        net.sheetDown = false;
        const out = await mod.runPicksDbMaintenance(env(), Date.parse('2026-10-21T12:00:00Z'));
        assert.strictEqual(out.copiedToSheet, 1);
        assert.ok(!kv.m.has('mirror:pending'));
        assert.strictEqual(sheet.sheets.Backup.length, 2);
    });

    await check('a body with spreads in it still goes to the sheet whole', async () => {
        fresh();
        const res = await post(env(), { week: '2026_7', picker: 'Sean', picks: [pick('Packers', 'Lions', 'Packers')], spreads: {} });
        const reply = await res.json();
        assert.strictEqual(reply.store, undefined, 'the sheet answered');
        assert.strictEqual(net.sheetPosts.length, 1);
        assert.strictEqual(d1.raw.prepare('SELECT COUNT(*) AS n FROM pick_rows').get().n, 1, 'and D1 has the picks too');
    });

    console.log('\nWhen D1 refuses');

    await check('the save goes to the sheet, is queued for D1, and the admin hears once an hour', async () => {
        fresh();
        d1.state.failWith = 'D1_ERROR: daily limit exceeded';
        const now = Date.now();
        const reply = await (await post(env(), { week: '2026_7', picker: 'Jason', picks: [pick('Packers', 'Lions', 'Lions')] })).json();
        assert.strictEqual(reply.success, true, 'the sheet took it');
        assert.strictEqual(reply.store, undefined);
        assert.strictEqual(sheet.sheets.Backup.length, 2);
        assert.strictEqual(JSON.parse(kv.m.get('d1:pending')).length, 1, 'owed to D1');
        assert.strictEqual(net.fcm.length, 1, 'one alert');
        assert.match(net.fcm[0].title, /Picks database refusing/);
        assert.deepStrictEqual(JSON.parse(net.fcm[0].personal), { Stephen: JSON.parse(net.fcm[0].personal).Stephen }, 'to the admin alone');
        await post(env(), { week: '2026_7', picker: 'Dylan', picks: [pick('Packers', 'Lions', 'Lions')] });
        assert.strictEqual(net.fcm.length, 1, 'not again within the hour');

        d1.state.failWith = null;
        const out = await mod.runPicksDbMaintenance(env(), now + 15 * 60000);
        assert.strictEqual(out.replayedToD1, 2);
        assert.strictEqual(out.recovered, true);
        assert.strictEqual(d1.raw.prepare('SELECT COUNT(*) AS n FROM pick_rows').get().n, 2, 'both saves are in D1 now');
        assert.match(net.fcm[net.fcm.length - 1].title, /back to normal/);
    });

    await check('a save neither could take is not queued: the phone retries it', async () => {
        fresh();
        d1.state.failWith = 'D1 down';
        net.sheetDown = true;
        const res = await post(env(), { week: '2026_7', picker: 'Jason', picks: [pick('Packers', 'Lions', 'Lions')] });
        assert.strictEqual(res.status, 503);
        assert.ok(!kv.m.has('d1:pending'));
    });

    console.log('\nReading');

    const backup = [
        row('2026-10-19T10:00:00.000Z', '2026_7', 'Stephen', 'Packers', 'Lions', { line: 'Packers', winner: 'Packers', blazin: true }),
        row('2026-10-19T10:00:00.000Z', '2026_7', 'Sean', 'Packers', 'Lions', { line: 'Lions', winner: 'Lions' })
    ];

    await check('reads stay on the sheet until PICKS_READ is d1', async () => {
        fresh(backup);
        await admin(env(), 'import?season=2026', 'POST');
        const before = await (await get(env(), 'action=allpicks&season=2026')).json();
        assert.strictEqual(before.source, undefined, 'the sheet');
        const after = await (await get(env({ PICKS_READ: 'd1' }), 'action=allpicks&season=2026')).json();
        assert.strictEqual(after.source, 'd1-current', 'from the stored table the copy in built');
        assert.strictEqual(after.picks['2026_7'].Stephen.packers_lions.line, 'away');
        assert.strictEqual(after.picks['2026_7'].Stephen.packers_lions.blazin, true);
        const one = await (await get(env({ PICKS_READ: 'd1' }), 'action=picks&week=2026_7&picker=Sean')).json();
        assert.match(one.source, /^d1/);
        assert.strictEqual(one.picks.packers_lions.line, 'home');
    });

    await check('a read D1 refuses is answered from the sheet', async () => {
        fresh(backup);
        await admin(env(), 'import?season=2026', 'POST');
        d1.state.failWith = 'D1 down';
        const res = await (await get(env({ PICKS_READ: 'd1' }), 'action=allpicks&season=2026')).json();
        assert.strictEqual(res.source, undefined, 'the sheet');
        assert.strictEqual(res.picks['2026_7'].Sean.packers_lions.line, 'home');
    });

    await check('the reminder job reads D1 behind the same switch, and the sheet without it', async () => {
        fresh(backup);
        await admin(env(), 'import?season=2026', 'POST');
        assert.match((await mod.readSeasonPicks(env({ PICKS_READ: 'd1' }), 2026)).source, /^d1/);
        assert.strictEqual((await mod.readSeasonPicks(env(), 2026)).source, undefined);
    });

    console.log('\nThe fold agrees with the sheet reader');

    // Every rule the Apps Script reader has, in one season's log.
    const tricky = [
        // Two halves of one game in one batch: a numeric Game row with the star,
        // a matchup row with the line. They merge.
        row('2026-09-10T12:00:00.000Z', '2026_1', 'Stephen', 'Rams', 'Seahawks', { gameId: '1', blazin: true }),
        row('2026-09-10T12:00:00.000Z', '2026_1', 'Stephen', 'Rams', 'Seahawks', { line: 'Seahawks', winner: 'Seahawks' }),
        // A later batch that un-stars it: replaces, the star is gone.
        row('2026-09-11T12:00:00.000Z', '2026_1', 'Daniel', 'Bills', 'Chiefs', { line: 'Bills', winner: 'Bills', blazin: true }),
        row('2026-09-12T12:00:00.000Z', '2026_1', 'Daniel', 'Bills', 'Chiefs', { line: 'Bills', winner: 'Bills' }),
        // A deselection in the newest batch stays blank.
        row('2026-09-11T12:00:00.000Z', '2026_1', 'Jason', 'Bills', 'Chiefs', { line: 'Chiefs', winner: 'Chiefs' }),
        row('2026-09-12T12:00:00.000Z', '2026_1', 'Jason', 'Bills', 'Chiefs'),
        // A freeze is final: a later unfrozen row cannot thaw it...
        row('2026-09-13T12:00:00.000Z', '2026_2', 'Sean', 'Jets', 'Dolphins', { line: 'Dolphins', winner: 'Dolphins', spreads: ['+2.5', '-2.5'], frozenAt: '2026-09-13T12:00:00.000Z' }),
        row('2026-09-14T12:00:00.000Z', '2026_2', 'Sean', 'Jets', 'Dolphins', { line: 'Jets', winner: 'Jets' }),
        // ...but an unlock marker can, and later rows fold against it as usual.
        row('2026-09-13T12:00:00.000Z', '2026_2', 'Dylan', 'Jets', 'Dolphins', { line: 'Jets', winner: 'Jets', spreads: ['+3', '-3'], frozenAt: '2026-09-13T12:00:00.000Z' }),
        row('2026-09-15T12:00:00.000Z', '2026_2', 'Dylan', 'Jets', 'Dolphins', { line: 'Jets', winner: 'Jets', frozenAt: 'unlocked 2026-09-15' }),
        row('2026-09-16T12:00:00.000Z', '2026_2', 'Dylan', 'Jets', 'Dolphins', { line: 'Dolphins', winner: 'Dolphins' }),
        // Over/under, a pick'em line, Cowherd at his own number.
        row('2026-09-20T12:00:00.000Z', '2026_19', 'Stephen', 'Bears', 'Packers', { line: 'Bears', winner: 'Bears', ou: 'over', ouLine: 44.5, spreads: [0, 0] }),
        row('2026-09-20T12:00:00.000Z', '2026_3', 'Cowherd', 'Rams', 'Seahawks', { line: 'Rams', blazin: true, spreads: ['+6.5', '-6.5'], frozenAt: '2026-09-20T12:00:00.000Z' }),
        // Last season's rows (bare week numbers) are not this season's.
        row('2025-12-01T12:00:00.000Z', '14', 'Stephen', 'Bears', 'Packers', { line: 'Bears', winner: 'Bears' }),
        row('2025-12-01T12:00:00.000Z', '2025_14', 'Sean', 'Bears', 'Packers', { line: 'Packers', winner: 'Packers' })
    ];
    const trickyCleared = [['2026_2', 'Jason', 'Yes', '2026-09-14T00:00:00Z'], ['2026_3', 'Jason', 'No', '2026-09-20T00:00:00Z']];

    await check('every season: D1 folds the copied log to exactly the sheet reader\'s picks', async () => {
        for (const season of [2026, 2025]) {
            fresh(tricky, trickyCleared);
            const imported = await (await admin(env(), `import?season=${season}`, 'POST')).json();
            assert.ok(imported.copied > 0, `${season}: rows copied`);
            const fromSheet = sheet.getAllPicks(season);
            const fromD1 = await (await get(env({ PICKS_READ: 'd1' }), `action=allpicks&season=${season}`)).json();
            assert.deepStrictEqual(fromD1.picks, JSON.parse(JSON.stringify(fromSheet.picks)), `${season}: picks`);
            assert.deepStrictEqual(fromD1.cleared, fromSheet.cleared, `${season}: cleared`);
            const compared = await (await admin(env(), `compare?season=${season}`)).json();
            assert.strictEqual(compared.differences, 0, `${season}: the comparison agrees`);
        }
    });

    await check('the rules, spelled out on the D1 side', async () => {
        fresh(tricky, trickyCleared);
        await admin(env(), 'import?season=2026', 'POST');
        const p = (await (await get(env({ PICKS_READ: 'd1' }), 'action=allpicks&season=2026')).json()).picks;
        assert.deepStrictEqual([p['2026_1'].Stephen.rams_seahawks.line, p['2026_1'].Stephen.rams_seahawks.blazin], ['home', true], 'halves merge');
        assert.strictEqual(p['2026_1'].Daniel.bills_chiefs.blazin, false, 'a newer batch replaces');
        assert.strictEqual(p['2026_1'].Jason.bills_chiefs.line, '', 'a deselection stays');
        assert.deepStrictEqual([p['2026_2'].Sean.jets_dolphins.line, p['2026_2'].Sean.jets_dolphins.frozenSpread], ['home', 2.5], 'a freeze is final, at its own number');
        assert.strictEqual(p['2026_2'].Dylan.jets_dolphins.line, 'home', 'unlocked, then picked again');
        assert.strictEqual(p['2026_2'].Dylan.jets_dolphins.frozenAt, undefined);
        assert.strictEqual(p['2026_3'].Cowherd.rams_seahawks.frozenFavorite, 'home');
        assert.ok(!p['14'] && !p['2025_14'], 'last season left out');
    });

    await check('a save through D1 reads back the same as through the sheet', async () => {
        fresh();
        const e = env({ PICKS_READ: 'd1' });
        await post(e, { week: '2026_7', picker: 'Stephen', picks: [pick('Packers', 'Lions', 'Packers', { blazin: true }), pick('Bears', 'Saints', 'Saints')], cleared: false });
        // A real save takes the sheet seconds: two in one millisecond would
        // read as one batch there (and here).
        await settle(); await new Promise(r => setTimeout(r, 5));
        await post(e, { week: '2026_7', picker: 'Stephen', picks: [pick('Packers', 'Lions', 'Packers', { blazin: true, frozenAt: '2026-10-21T10:00:00.000Z', awaySpread: '+3.5', homeSpread: '-3.5' }), pick('Bears', 'Saints', '')], cleared: false });
        await settle();
        const fromD1 = (await (await get(e, 'action=allpicks&season=2026')).json()).picks;
        assert.deepStrictEqual(fromD1, JSON.parse(JSON.stringify(sheet.getAllPicks(2026).picks)));
        assert.strictEqual(fromD1['2026_7'].Stephen.packers_lions.frozenSpread, 3.5);
        assert.strictEqual(fromD1['2026_7'].Stephen.bears_saints.line, '');
    });

    console.log('\nThe stored table (current_picks)');

    await check('every save keeps it equal to the log, and reads come from it', async () => {
        fresh(tricky, trickyCleared);
        const e = env({ PICKS_READ: 'd1' });
        await admin(e, 'import?season=2026', 'POST');
        await post(e, { week: '2026_2', picker: 'Sean', picks: [pick('Jets', 'Dolphins', 'Jets')] });
        await post(e, { week: '2026_7', picker: 'Stephen', picks: [pick('Packers', 'Lions', 'Packers', { blazin: true })] });
        await settle();
        const read = await (await get(e, 'action=allpicks&season=2026')).json();
        assert.strictEqual(read.source, 'd1-current');
        assert.strictEqual(read.rowsScanned, 0, 'not one log row read');
        const compared = await mod.comparePicks(e, 2026);
        assert.strictEqual(compared.currentDrift, 0, 'equal to the log, rule for rule');
        assert.strictEqual(compared.differences, 0, 'and to the sheet');
        assert.strictEqual(read.picks['2026_2'].Sean.jets_dolphins.line, 'home', 'a freeze is final there too');
        const week = await (await get(e, 'action=picks&week=2026_7&picker=Stephen')).json();
        assert.strictEqual(week.picks.packers_lions.blazin, true);
    });

    await check('a season copied in before the table existed gets it built by the cron', async () => {
        fresh(backup);
        await admin(env(), 'import?season=2026', 'POST');
        d1.raw.prepare("DELETE FROM pick_meta WHERE k = 'current:2026'").run();
        d1.raw.prepare('DELETE FROM current_picks').run();
        assert.strictEqual((await (await get(env({ PICKS_READ: 'd1' }), 'action=allpicks&season=2026')).json()).source, 'd1', 'the log, until it is built');
        const out = await mod.runPicksDbMaintenance(env(), Date.parse('2026-10-22T15:00:00Z'));
        assert.strictEqual(out.builtCurrent, 2);
        assert.strictEqual((await (await get(env({ PICKS_READ: 'd1' }), 'action=allpicks&season=2026')).json()).source, 'd1-current');
    });

    console.log('\nThe copy in');

    await check('importing twice adds nothing, and it stops where the worker\'s own saves begin', async () => {
        fresh(backup);
        const first = await (await admin(env(), 'import?season=2026', 'POST')).json();
        assert.strictEqual(first.inserted, 2);
        const again = await (await admin(env(), 'import?season=2026', 'POST')).json();
        assert.strictEqual(again.inserted, 0, 'harmless to re-run');

        // A live save, then a sheet row with a later timestamp (its copy of it).
        fresh(backup);
        await post(env(), { week: '2026_7', picker: 'Dylan', picks: [pick('Packers', 'Lions', 'Lions')] });
        await settle();
        const after = await (await admin(env(), 'import?season=2026', 'POST')).json();
        assert.strictEqual(after.copied, 2, 'the sheet\'s copy of the live save is not imported a second time');
        assert.strictEqual(d1.raw.prepare('SELECT COUNT(*) AS n FROM pick_rows').get().n, 3);
    });

    await check('the raw log is not served on the public route, only to the import', async () => {
        fresh(backup);
        const res = await get(env(), 'action=backuprows&season=2026');
        assert.strictEqual(res.status, 404);
        const imported = await (await admin(env(), 'import?season=2026', 'POST')).json();
        assert.strictEqual(imported.inserted, 2, 'the import still reads it');
    });

    await check('the admin tools need the secret', async () => {
        fresh();
        const res = await worker.fetch(new Request('https://w.test/admin/picks/status'), env(), ctx);
        assert.strictEqual(res.status, 401);
        const status = await (await admin(env(), 'status')).json();
        assert.strictEqual(status.readsFrom, 'sheet');
        assert.strictEqual((await (await admin(env({ PICKS_READ: 'd1' }), 'status')).json()).readsFrom, 'd1');
    });

    console.log('\nThe cron');

    await check('half of a free limit warns the admin once a day', async () => {
        fresh();
        const day = Date.parse('2026-10-21T12:00:00Z');
        await mod.runPicksDbMaintenance(env(), day);
        d1.raw.prepare("INSERT INTO pick_usage (day, rows_read, rows_written) VALUES ('2026-10-21', 2600000, 10) ON CONFLICT(day) DO UPDATE SET rows_read = 2600000").run();
        const out = await mod.runPicksDbMaintenance(env(), day + 60000);
        assert.strictEqual(out.warned, true);
        assert.match(net.fcm[0].title, /past half its free limit/);
        assert.match(JSON.parse(net.fcm[0].personal).Stephen, /Nothing is billed/);
        await mod.runPicksDbMaintenance(env(), day + 120000);
        assert.strictEqual(net.fcm.length, 1, 'once a day');
    });

    await check('the daily comparison runs once a copied season exists, and a difference alerts', async () => {
        fresh(backup);
        const day = Date.parse('2026-10-21T12:00:00Z');
        const before = await mod.runPicksDbMaintenance(env(), day);
        assert.strictEqual(before.compared, undefined, 'nothing to compare before the copy');
        await admin(env(), 'import?season=2026', 'POST');
        const clean = await mod.runPicksDbMaintenance(env(), day);
        assert.strictEqual(clean.compared, 0);
        assert.strictEqual(net.fcm.length, 0);
        assert.strictEqual((await mod.runPicksDbMaintenance(env(), day + 60000)).compared, undefined, 'once a day');

        // The log changed under the stored table: the check finds the drift
        // and rebuilds the table from the log, the record...
        d1.raw.prepare("UPDATE pick_rows SET line_pick = 'Lions' WHERE picker = 'Stephen'").run();
        const drift = await mod.runPicksDbMaintenance(env(), day + 86400000);
        assert.strictEqual(drift.rebuiltCurrent > 0, true, 'rebuilt');
        assert.strictEqual(net.fcm.length, 0, 'nothing for the admin');
        // ...after which D1 really disagrees with the sheet, and the next check says so.
        const next = await mod.runPicksDbMaintenance(env(), day + 2 * 86400000);
        assert.strictEqual(next.compared, 1);
        assert.match(net.fcm[0].title, /disagree/);
        const list = await (await admin(env(), 'compare?season=2026')).json();
        assert.deepStrictEqual([list.sample[0].picker, list.sample[0].game, list.sample[0].sheet.line, list.sample[0].d1.line], ['Stephen', 'packers_lions', 'away', 'home']);
    });

    await check('the sheet timing out in the comparison is not D1 refusing: no alert, tried again next run', async () => {
        // 22 October 2026: the first daily comparison's Apps Script call
        // timed out (524) and the admin was told "Picks database refusing".
        fresh(backup);
        const day = Date.parse('2026-10-22T14:15:00Z');
        await admin(env(), 'import?season=2026', 'POST');
        net.sheetDown = true;
        const out = await mod.runPicksDbMaintenance(env(), day);
        assert.match(out.compareError, /Apps Script answered 503/);
        assert.strictEqual(net.fcm.length, 0, 'no push');
        assert.ok(!kv.m.has('d1:failing'), 'D1 not marked as failing');
        net.sheetDown = false;
        const next = await mod.runPicksDbMaintenance(env(), day + 15 * 60000);
        assert.strictEqual(next.compared, 0, 'compared on the next run');
    });

    await check('a failing state the sheet left behind is cleared without a back-to-normal push', async () => {
        fresh();
        kv.m.set('d1:failing', JSON.stringify({ since: 1, lastError: 'Apps Script answered 524', alertedAt: 1 }));
        const out = await mod.runPicksDbMaintenance(env(), Date.parse('2026-10-22T15:00:00Z'));
        assert.strictEqual(out.recovered, true);
        assert.ok(!kv.m.has('d1:failing'));
        assert.strictEqual(net.fcm.length, 0, 'nothing sent for a false alarm');
    });

    console.log('\nPicked at');

    await check('/picked-at gives when the side held now was taken, and the line then', async () => {
        fresh();
        await post(env(), { week: '2026_8', picker: 'Stephen', picks: [pick('Bears', 'Rams', '')] });   // creates the tables
        d1.raw.exec('DELETE FROM pick_rows');
        const row = (ts, away, home, line, awaySpread, homeSpread, picker = 'Stephen') => d1.raw.prepare(
            `INSERT INTO pick_rows (ts, season, week, picker, game_key, game_id, away, home, away_spread, home_spread, line_pick, winner_pick, blazin, over_under, total_line, frozen_at)
             VALUES (?, 2026, '2026_8', ?, ?, ?, ?, ?, ?, ?, ?, '', 0, '', '', '')`)
            .run(ts, picker, `${away.toLowerCase()}_${home.toLowerCase()}`, `${away.toLowerCase()}_${home.toLowerCase()}`, away, home, awaySpread, homeSpread, line);
        // Browns: Titans first, switched to the Browns at -1.5, re-synced at -2.5 (riding).
        row('2026-10-20T14:00:00.000Z', 'Browns', 'Titans', 'Titans', -1, 1);
        row('2026-10-21T15:00:00.000Z', 'Browns', 'Titans', 'Browns', -1.5, 1.5);
        row('2026-10-22T16:00:00.000Z', 'Browns', 'Titans', 'Browns', -2.5, 2.5);
        // Colts: taken, deselected, taken again - the run starts at the second.
        row('2026-10-20T14:00:00.000Z', 'Colts', 'Vikings', 'Colts', 5.5, -5.5);
        row('2026-10-21T15:00:00.000Z', 'Colts', 'Vikings', '', 5.5, -5.5);
        row('2026-10-22T16:00:00.000Z', 'Colts', 'Vikings', 'Colts', 6.5, -6.5);
        // Bears: deselected last - nothing to mark. Someone else's row is not read.
        row('2026-10-20T14:00:00.000Z', 'Bears', 'Rams', 'Bears', 3, -3);
        row('2026-10-21T15:00:00.000Z', 'Bears', 'Rams', '', 3, -3);
        row('2026-10-20T14:00:00.000Z', 'Jets', 'Bills', 'Jets', 7, -7, 'Sean');
        const res = await worker.fetch(new Request('https://w.test/picked-at?season=2026&week=8&picker=Stephen'), env(), ctx);
        assert.strictEqual(res.status, 200);
        const { games } = await res.json();
        assert.deepStrictEqual(games.browns_titans, { side: 'away', at: Date.parse('2026-10-21T15:00:00Z'), spread: -1.5 });
        assert.deepStrictEqual(games.colts_vikings, { side: 'away', at: Date.parse('2026-10-22T16:00:00Z'), spread: 6.5 });
        assert.strictEqual(games.bears_rams, undefined);
        assert.strictEqual(games.jets_bills, undefined);
        const bad = await worker.fetch(new Request('https://w.test/picked-at?season=2026&week=8'), env(), ctx);
        assert.strictEqual(bad.status, 400, 'a picker is required');
    });

    await check('no PICKS_DB: the worker behaves exactly as before', async () => {
        fresh();
        const e = env({ PICKS_DB: undefined });
        const reply = await (await post(e, { week: '2026_7', picker: 'Sean', picks: [pick('Packers', 'Lions', 'Packers')] })).json();
        assert.strictEqual(reply.store, undefined);
        assert.strictEqual(net.sheetPosts.length, 1);
        assert.deepStrictEqual(await mod.runPicksDbMaintenance(e), { skipped: 'no PICKS_DB' });
    });

    fs.unlinkSync(tmp);
    console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
    process.exit(failures ? 1 : 0);
})();
