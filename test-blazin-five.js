// Tests for the Blazin' 5 star enable/disable rules. Runs app.js in Node with
// browser stubs.
//
// The bug these guard: renderGames and updateBlazinStarStates used to read
// picks through different views and count the cap differently, so a star would
// render enabled and then disable itself on the next click - B5 looked broken
// but "worked for a moment" right after a re-render.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeStar(key, { active = false, locked = false } = {}) {
    const card = { classList: { contains: c => locked && c === 'game-locked' } };
    return {
        dataset: { pickKey: key },
        classList: { contains: c => active && c === 'active' },
        closest: () => card,
        disabled: false,
        title: ''
    };
}

function makeEnv(stars) {
    const store = new Map();
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
            // Only the star lookup matters here; everything else sees nothing.
            querySelectorAll: sel => (sel === '.blazin-star' ? stars.current : []),
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async url => { throw new Error('fetch not stubbed: ' + url); },
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {}, confirm: () => false,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    env.globalThis = env;

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
        CURRENT_SEASON, FIRST_PLAYOFF_WEEK,
        pickKey, getPicksForGame, getPickerPicksForWeek, countBlazinPicks,
        updateBlazinStarStates,
        weeklyPicksCache, NFL_GAMES_BY_WEEK,
        __state: () => ({ allPicks, currentWeek, currentPicker }),
        __setState: s => {
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentGameFilter' in s) currentGameFilter = s.currentGameFilter;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, env };
}

// Six games, so the 5-pick cap can actually be reached.
const TEAMS = [
    ['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins'],
    ['Bears', 'Packers'], ['Giants', 'Eagles'], ['Saints', 'Falcons']
];
const WEEK = 5;

function keyOf([away, home]) {
    return `${away.toLowerCase()}_${home.toLowerCase()}`;
}

function setup({ picks = {}, cached = null, filter = 'all', week = WEEK, starOpts = {} } = {}) {
    const stars = { current: [] };
    const { api } = makeEnv(stars);

    api.NFL_GAMES_BY_WEEK[week] = TEAMS.map(([away, home], i) => ({
        id: i + 1, away, home, spread: 3, favorite: 'home',
        day: 'Sunday', time: '1:00 PM'
    }));
    api.__setState({
        currentWeek: week,
        currentPicker: 'Stephen',
        currentGameFilter: filter,
        allPicks: { [week]: { Stephen: { ...picks } } }
    });

    if (cached) api.weeklyPicksCache[week] = { picks: { Stephen: cached } };

    stars.current = api.NFL_GAMES_BY_WEEK[week].map(g => {
        const k = api.pickKey(g);
        return makeStar(k, starOpts[k] || {});
    });

    return { api, stars: stars.current };
}

function fiveStarredPicks() {
    const picks = {};
    TEAMS.slice(0, 5).forEach(t => {
        picks[keyOf(t)] = { line: 'home', blazin: true };
    });
    return picks;
}

let failures = 0;
let total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section("The reported bug: a line pick must enable that game's star");

check('a line pick enables its own star', () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home', winner: 'home' } } });
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, false, 'star for the picked game should be enabled');
    assert.strictEqual(t.stars[0].title, 'Add to Blazin 5');
});

check('games without a line pick stay disabled', () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home' } } });
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[1].disabled, true);
    assert.strictEqual(t.stars[1].title, 'Make a line pick first');
});

check('the star does not oscillate across repeated updates', () => {
    const t = setup({ picks: { rams_seahawks: { line: 'home' } } });
    t.api.updateBlazinStarStates();
    const first = t.stars[0].disabled;
    t.api.updateBlazinStarStates();
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, first, 'state must be stable');
    assert.strictEqual(first, false);
});

section("The count must not be inflated by keys that are not this week's games");

check('a stale orphan key with blazin does not count toward the cap', () => {
    // "1".."5" are legacy game-id keys; they match no game, so must be ignored.
    const t = setup({
        picks: {
            rams_seahawks: { line: 'home' },
            1: { blazin: true }, 2: { blazin: true }, 3: { blazin: true },
            4: { blazin: true }, 5: { blazin: true }
        }
    });
    assert.strictEqual(t.api.countBlazinPicks(WEEK, 'Stephen'), 0, 'orphans must not count');
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, false, 'cap must not be spuriously reached');
});

check('the card filter does not change the cap', () => {
    const picks = fiveStarredPicks();
    const all = setup({ picks, filter: 'all' });
    const upcoming = setup({ picks, filter: 'upcoming' });
    assert.strictEqual(all.api.countBlazinPicks(WEEK, 'Stephen'), 5);
    assert.strictEqual(upcoming.api.countBlazinPicks(WEEK, 'Stephen'), 5,
        'filtering the cards must not change the count');
});

section('Blank fields restored from the sheet backup are not picks');

check("line: '' does not enable the star", () => {
    // getAllPicks in the Apps Script emits every field, blank when unset.
    const t = setup({ picks: { rams_seahawks: { line: '', winner: '', blazin: false } } });
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, true, 'a blank line pick is not a line pick');
    assert.strictEqual(t.stars[0].title, 'Make a line pick first');
});

section('The 5-pick cap');

check('a sixth star is disabled once five are set', () => {
    const picks = fiveStarredPicks();
    picks.saints_falcons = { line: 'home' }; // picked, but not starred
    const t = setup({ picks });
    assert.strictEqual(t.api.countBlazinPicks(WEEK, 'Stephen'), 5);
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[5].disabled, true);
    assert.strictEqual(t.stars[5].title, 'Maximum 5 Blazin picks reached');
});

check('an already-starred game stays clickable at the cap (so it can be undone)', () => {
    const picks = fiveStarredPicks();
    const starOpts = {};
    TEAMS.slice(0, 5).forEach(tm => { starOpts[keyOf(tm)] = { active: true }; });
    const t = setup({ picks, starOpts });
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, false);
    assert.strictEqual(t.stars[0].title, 'Remove from Blazin 5');
});

check('a locked game is disabled even with a line pick', () => {
    const t = setup({
        picks: { rams_seahawks: { line: 'home' } },
        starOpts: { rams_seahawks: { locked: true } }
    });
    t.api.updateBlazinStarStates();
    assert.strictEqual(t.stars[0].disabled, true);
    assert.strictEqual(t.stars[0].title, 'Game is locked');
});

section('The sheet cache and local picks are one view');

check('a blazin pick present only in the sheet cache is counted', () => {
    const t = setup({
        picks: {},
        cached: { rams_seahawks: { line: 'home', blazin: true } }
    });
    assert.strictEqual(t.api.countBlazinPicks(WEEK, 'Stephen'), 1);
});

check('a local pick overrides the cached one', () => {
    const t = setup({
        picks: { rams_seahawks: { line: 'home', blazin: false } },
        cached: { rams_seahawks: { line: 'home', blazin: true } }
    });
    assert.strictEqual(t.api.countBlazinPicks(WEEK, 'Stephen'), 0, 'local wins');
});

section("Playoffs have no Blazin' 5");

check('the count is zero in a playoff week', () => {
    const t = setup({
        week: 19,
        picks: { rams_seahawks: { line: 'home', blazin: true } }
    });
    assert.strictEqual(t.api.countBlazinPicks(19, 'Stephen'), 0);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
