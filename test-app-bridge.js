// Tests for the site's side of the Android app bridge (window.NFLPicksApp):
// the header gear, and the admin actions the app's Settings took over.
//
// The site and the app ship separately - the site on every push, the app as a
// sideloaded APK - so a phone can be running an older app against a newer
// site. The checks that matter most are therefore the ones about what the
// page does when a bridge method is missing: in a browser, or in an older app,
// nothing may disappear.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

function makeNode(id) {
    const classes = new Set(id === 'app-settings-btn' ? ['hidden'] : []);
    const listeners = {};
    return {
        id, textContent: '', clicks: 0,
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c),
            contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
        },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        click() { this.clicks++; listeners.click && listeners.click(); }
    };
}

function load(bridge) {
    const nodes = {};
    const node = id => nodes[id] || (nodes[id] = makeNode(id));
    const body = makeNode('body');
    const store = new Map();
    const env = {
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k), key: () => null, get length() { return 0; }
        },
        document: {
            addEventListener() {}, getElementById: node, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild() {} }, body,
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, fetch: async () => { throw new Error('no fetch'); },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false, addEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    if (bridge) env.NFLPicksApp = bridge;

    const src = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8')
        + '\nconst HISTORICAL_DATA_SEASON=2026,HISTORICAL_GAMES={},HISTORICAL_RESULTS={},HISTORICAL_PICKS={};\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + `;return { setupAppSettingsButton, runAppAdminAction, appAdminInfo, NFL_GAMES_BY_WEEK,
            __setState: s => { if ('allPicks' in s) allPicks = s.allPicks; if ('currentWeek' in s) currentWeek = s.currentWeek; } };`;
    const api = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date', src)(
        env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia,
        fixedClock('2026-10-07T16:00:00Z'));
    return { api, node, body };
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('In a browser');

check('no gear, and the admin buttons stay', () => {
    const { api, node, body } = load(null);
    api.setupAppSettingsButton();
    assert.strictEqual(node('app-settings-btn').classList.contains('hidden'), true);
    assert.strictEqual(body.classList.contains('app-admin-tools'), false);
});

section('In the app');

check('the gear shows and opens the app Settings', () => {
    let opened = 0;
    const { api, node } = load({ openSettings: () => opened++, hasAdminTools: () => true });
    api.setupAppSettingsButton();
    const gear = node('app-settings-btn');
    assert.strictEqual(gear.classList.contains('hidden'), false);
    gear.click();
    assert.strictEqual(opened, 1);
});

check('an app with the admin tools takes the page buttons away', () => {
    const { api, body } = load({ openSettings() {}, hasAdminTools: () => true });
    api.setupAppSettingsButton();
    assert.strictEqual(body.classList.contains('app-admin-tools'), true);
});

check('an older app without them leaves the buttons where they were', () => {
    // App 1.1/1.2: a gear, but no admin tools in Settings.
    const { api, body } = load({ openSettings() {} });
    api.setupAppSettingsButton();
    assert.strictEqual(body.classList.contains('app-admin-tools'), false);
});

check("the stylesheet hides them only under the app's class", () => {
    const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    assert.ok(/\.app-admin-tools \.admin-actions\s*\{[^}]*display:\s*none\s*!important/.test(css));
});

section('Running the actions for an app that closes Settings (1.3, 1.4)');

check('each action clicks the button the page already has', () => {
    const { api, node } = load({ openSettings() {}, hasAdminTools: () => true });
    api.runAppAdminAction('refresh-spreads');
    api.runAppAdminAction('export-picks');
    assert.strictEqual(node('refresh-spreads-btn').clicks, 1);
    assert.strictEqual(node('export-all-picks-btn').clicks, 1);
});

check('an unknown action does nothing', () => {
    const { api, node } = load({ openSettings() {}, hasAdminTools: () => true });
    api.runAppAdminAction('clear-everything');
    assert.strictEqual(node('refresh-spreads-btn').clicks, 0);
    assert.strictEqual(node('export-all-picks-btn').clicks, 0);
});

check('the credits line is read off the page', () => {
    const { api, node } = load({ openSettings() {}, hasAdminTools: () => true });
    assert.strictEqual(api.appAdminInfo(), '');
    node('api-quota').textContent = 'Odds API: 412 left of 500';
    assert.strictEqual(api.appAdminInfo(), 'Odds API: 412 left of 500');
});

section('Running the actions for an app that stays in Settings (1.5+)');

// The app keeps Admin Settings open and waits for adminResult. Every path has
// to answer, or the button sits on "Refreshing..." until the app gives up.
function reportingApp() {
    const reports = [], copies = [];
    return {
        reports, copies,
        bridge: {
            openSettings() {}, hasAdminTools: () => true,
            copy: text => copies.push(text),
            adminResult: (action, ok, message, quota) => reports.push({ action, ok, message, quota })
        }
    };
}

async function acheck(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
    await acheck('export copies the picks and reports it, without clicking anything', async () => {
        const app = reportingApp();
        const { api, node } = load(app.bridge);
        api.NFL_GAMES_BY_WEEK[5] = [{ id: 1, away: 'Rams', home: 'Seahawks', spread: 3, favorite: 'home' }];
        api.__setState({ currentWeek: 5, allPicks: { 5: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } } } });
        node('api-quota').textContent = 'Odds API: 400 left of 500';

        await api.runAppAdminAction('export-picks');
        assert.strictEqual(node('export-all-picks-btn').clicks, 0);
        assert.strictEqual(app.copies.length, 1);
        assert.ok(app.copies[0].includes('Seahawks (-3), Seahawks win'), app.copies[0]);
        assert.deepStrictEqual(app.reports, [{
            action: 'export-picks', ok: true,
            message: 'Week 5 picks copied. Paste them into WhatsApp.',
            quota: 'Odds API: 400 left of 500'
        }]);
    });

    await acheck('export of a week with no games says so', async () => {
        const app = reportingApp();
        const { api } = load(app.bridge);
        api.__setState({ currentWeek: 7 });
        await api.runAppAdminAction('export-picks');
        assert.strictEqual(app.copies.length, 0);
        assert.strictEqual(app.reports[0].ok, false);
        assert.match(app.reports[0].message, /No games/);
    });

    await acheck('a refresh that cannot reach the odds still answers', async () => {
        // fetch throws here, as it would offline.
        const app = reportingApp();
        const { api, node } = load(app.bridge);
        await api.runAppAdminAction('refresh-spreads');
        assert.strictEqual(node('refresh-spreads-btn').clicks, 0);
        assert.strictEqual(app.reports.length, 1);
        assert.strictEqual(app.reports[0].action, 'refresh-spreads');
        assert.strictEqual(app.reports[0].ok, false);
    });

    await acheck('an unknown action is ignored', async () => {
        const app = reportingApp();
        const { api } = load(app.bridge);
        await api.runAppAdminAction('clear-everything');
        assert.strictEqual(app.reports.length, 0);
    });

    console.log(`\n${total - failures}/${total} passed`);
    process.exit(failures ? 1 : 0);
})();
