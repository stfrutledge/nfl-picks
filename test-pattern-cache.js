// The Patterns panel's cache must not outlive the data under it.
//
// InsightsManager cached PatternEngine's answer for five minutes on time
// alone. A page that drew Patterns while its weeks were still loading (from
// ESPN, the results sheet and the picks backup) cached "no patterns" and kept
// showing that after everything had arrived - reported 2026-10-06 as "the
// patterns were there, and now they're gone".
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

function makeEnv(dom = {}) {
    const env = {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
        document: {
            addEventListener() {}, getElementById: id => dom.byId?.[id] || null,
            querySelector: sel => dom.query?.(sel) || null, querySelectorAll: sel => dom.queryAll?.(sel) || [],
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
        + `;return { InsightsManager, NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, renderPatternsPanel, patternExtremes,
            setPicks: p => { allPicks = p; } };`;
    return new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date', src)(
        env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia,
        fixedClock('2026-10-07T16:00:00Z'));
}

/** Stephen on the Chiefs -3 four weeks running, and the Chiefs never cover. */
function loadSeason(api) {
    const picks = {};
    for (let week = 1; week <= 4; week++) {
        api.NFL_GAMES_BY_WEEK[week] = [{ id: 1, away: 'Rams', home: 'Chiefs', spread: 3, favorite: 'home',
            day: 'Sunday', time: '1:00 PM' }];
        api.NFL_RESULTS_BY_WEEK[week] = { 1: { winner: 'home', awayScore: 20, homeScore: 21 } };
        picks[week] = { Stephen: { rams_chiefs: { line: 'home' } } };
    }
    api.setPicks(picks);
}

const stephensPatterns = api =>
    api.InsightsManager.getAllInterestingInsights().filter(i => i.picker === 'Stephen');

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

check('drawn before the data arrives, then again after: the patterns appear', () => {
    const api = makeEnv();
    assert.strictEqual(stephensPatterns(api).length, 0, 'nothing loaded yet');
    loadSeason(api);
    const found = stephensPatterns(api);
    assert.ok(found.length > 0, 'the empty answer must not be reused once the weeks load');
    assert.ok(found.some(p => /Chiefs/.test(p.headline)), JSON.stringify(found.map(p => p.headline)));
});

check('a new pick is reflected without waiting five minutes', () => {
    const api = makeEnv();
    loadSeason(api);
    const before = stephensPatterns(api).find(p => /Chiefs/.test(p.headline));
    // A fifth Chiefs pick, also a loss.
    api.NFL_GAMES_BY_WEEK[5] = [{ id: 1, away: 'Bills', home: 'Chiefs', spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM' }];
    api.NFL_RESULTS_BY_WEEK[5] = { 1: { winner: 'home', awayScore: 20, homeScore: 22 } };
    api.setPicks(Object.assign({}, ...[1, 2, 3, 4].map(w => ({ [w]: { Stephen: { rams_chiefs: { line: 'home' } } } })),
        { 5: { Stephen: { bills_chiefs: { line: 'home' } } } }));
    const after = stephensPatterns(api).find(p => /Chiefs/.test(p.headline));
    assert.ok(after.total > before.total, `${before.total} -> ${after.total}`);
});

check('unchanged data is served from the cache', () => {
    const api = makeEnv();
    loadSeason(api);
    const first = api.InsightsManager.getInsights();
    assert.strictEqual(api.InsightsManager.getInsights(), first, 'same object, not recomputed');
});

// --- The Primetime filter button -------------------------------------------

function el(classes = []) {
    const set = new Set(classes);
    return {
        innerHTML: '', value: 'all', options: [1, 2], dataset: {},
        classList: {
            add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
            toggle: (c, on) => (on ? set.add(c) : set.delete(c))
        },
        appendChild() {}
    };
}

function patternsDom({ primetimeActive = false, picker = 'all' } = {}) {
    const buttons = {
        all: Object.assign(el(primetimeActive ? [] : ['active']), { dataset: { type: 'all' } }),
        team: Object.assign(el(), { dataset: { type: 'team' } }),
        primetime: Object.assign(el(primetimeActive ? ['active'] : []), { dataset: { type: 'primetime' } })
    };
    const grid = el();
    const filter = Object.assign(el(), { value: picker });
    return {
        buttons, grid,
        dom: {
            byId: { 'patterns-grid': grid, 'patterns-picker-filter': filter },
            query: sel => {
                const m = sel.match(/data-type="(\w+)"/);
                if (m) return buttons[m[1]];
                if (sel === '.pattern-type-btn.active') return Object.values(buttons).find(b => b.classList.contains('active'));
                return null;
            },
            queryAll: () => Object.values(buttons)
        }
    };
}

/** Five primetime (Thursday) picks for Stephen, all losses against -3. */
function loadPrimetime(api) {
    const picks = {};
    for (let week = 1; week <= 5; week++) {
        api.NFL_GAMES_BY_WEEK[week] = [{ id: 1, away: 'Rams', home: 'Chiefs', spread: 3, favorite: 'home',
            day: 'Thursday', time: '8:15 PM ET' }];
        api.NFL_RESULTS_BY_WEEK[week] = { 1: { winner: 'home', awayScore: 20, homeScore: 21 } };
        picks[week] = { Stephen: { rams_chiefs: { line: 'home' } } };
    }
    api.setPicks(picks);
}

check('no primetime pattern yet: the Primetime button is hidden', () => {
    const { dom, buttons } = patternsDom();
    const api = makeEnv(dom);
    loadSeason(api);                        // Sunday games only
    api.renderPatternsPanel();
    assert.strictEqual(buttons.primetime.classList.contains('hidden'), true);
    assert.strictEqual(buttons.team.classList.contains('hidden'), false, 'Teams is left alone');
});

check('once there is one, it appears', () => {
    const { dom, buttons } = patternsDom();
    const api = makeEnv(dom);
    loadPrimetime(api);
    api.renderPatternsPanel();
    assert.strictEqual(buttons.primetime.classList.contains('hidden'), false);
});

check('it follows the picker filter', () => {
    const { dom, buttons } = patternsDom({ picker: 'Sean' });
    const api = makeEnv(dom);
    loadPrimetime(api);                     // the pattern is Stephen's
    api.renderPatternsPanel();
    assert.strictEqual(buttons.primetime.classList.contains('hidden'), true);
});

check('hidden while selected, the filter goes back to All', () => {
    const { dom, buttons, grid } = patternsDom({ primetimeActive: true });
    const api = makeEnv(dom);
    loadSeason(api);
    api.renderPatternsPanel();
    assert.strictEqual(buttons.primetime.classList.contains('active'), false);
    assert.strictEqual(buttons.all.classList.contains('active'), true);
    assert.ok(/Chiefs/.test(grid.innerHTML), 'showing every pattern, not an empty panel');
});

// --- Only the extremes -----------------------------------------------------

const pat = (picker, team, percentage, total) =>
    ({ picker, team, percentage, total, type: 'team', headline: `${picker} ${team}` });

check('each picker shows just their best and worst record', () => {
    const api = makeEnv();
    const out = api.patternExtremes([
        pat('Stephen', 'Chiefs', 0, 4), pat('Stephen', 'Bills', 80, 5),
        pat('Stephen', 'Rams', 100, 3), pat('Stephen', 'Jets', 25, 4),
        pat('Sean', 'Lions', 75, 4)
    ]);
    assert.deepStrictEqual(out.map(p => `${p.picker} ${p.team} ${p.extreme}`),
        ['Stephen Rams best', 'Stephen Chiefs worst', 'Sean Lions best']);
});

check('a tie on percentage goes to the bigger sample', () => {
    const api = makeEnv();
    const out = api.patternExtremes([pat('Stephen', 'Rams', 100, 3), pat('Stephen', 'Bills', 100, 6)]);
    assert.deepStrictEqual(out.map(p => p.team), ['Bills']);
});

// Stephen's real 2026 Seahawks games: he took them three times (W, P, P) and
// went against them twice (both wins).
check('a team gets a "taking" record and an "in games" record', () => {
    const api = makeEnv();
    const slate = [
        ['Patriots', 'Seahawks', 'home', 21, 24],   // Seahawks -3: push
        ['Seahawks', 'Cardinals', 'away', 30, 20],  // Seahawks -3 win
        ['Seahawks', 'Commanders', 'home', 17, 20], // took Commanders +3: win
        ['Chargers', 'Seahawks', 'home', 21, 24],   // Seahawks -3: push
        ['49ers', 'Seahawks', 'away', 24, 21]       // took 49ers: win
    ];
    const picks = {};
    slate.forEach(([away, home, line, as, hs], i) => {
        const week = i + 1;
        const seaHome = home === 'Seahawks';
        api.NFL_GAMES_BY_WEEK[week] = [{ id: 1, away, home, spread: 3, favorite: seaHome ? 'home' : 'away',
            day: 'Sunday', time: '1:00 PM' }];
        api.NFL_RESULTS_BY_WEEK[week] = { 1: { winner: as > hs ? 'away' : 'home', awayScore: as, homeScore: hs } };
        picks[week] = { Stephen: { [`${away.toLowerCase()}_${home.toLowerCase()}`]: { line } } };
    });
    api.setPicks(picks);
    const all = api.InsightsManager.getInsights(true).Stephen.teamPatterns;
    const taking = all.find(p => p.kind === 'taking' && p.team === 'Seahawks');
    const games = all.find(p => p.kind === 'games' && p.team === 'Seahawks');
    assert.strictEqual(taking.headline, 'Stephen is 1-0-2 taking the Seahawks');
    assert.strictEqual(games.headline, 'Stephen is 3-0-2 in Seahawks games');
});

check('the panel draws one card per extreme', () => {
    const { dom, grid } = patternsDom();
    const api = makeEnv(dom);
    loadSeason(api);
    api.renderPatternsPanel();
    assert.strictEqual((grid.innerHTML.match(/class="pattern-card/g) || []).length, 1);
    assert.ok(/Worst · Team/.test(grid.innerHTML), grid.innerHTML);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
