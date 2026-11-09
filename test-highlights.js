// Tests for the app's spoiler-free highlights: which of the phone's picker's
// Blazin' 5 games the panel covers, what counts as seen, and that it stays
// off in a browser and in an app older than 1.19.
//
// The panel itself is drawn in a WebView; these check the decisions under it.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

const NOW = '2026-11-10T12:00:00Z';   // a Tuesday, the morning after Monday night

function load(bridge) {
    const store = new Map();
    const env = {
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k), key: () => null, get length() { return 0; }
        },
        document: {
            visibilityState: 'visible',
            addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {} }),
            head: { appendChild() {} }, body: { appendChild() {}, classList: { add() {}, remove() {} } },
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
        + `;return { spoilerHighlightsOn, highlightsViewer, viewerBlazinGames, unseenFinishedBlazin, markHighlightsSeen,
            markVisibleFinalsSeen, readHighlightsSeen, highlightsPair, highlightsPickText, highlightsResultHtml,
            highlightsWeeks, playHighlightsVideo, NFL_GAMES_BY_WEEK, CURRENT_NFL_WEEK, CURRENT_SEASON,
            __setState: s => {
                if ('allPicks' in s) allPicks = s.allPicks;
                if ('currentPicker' in s) currentPicker = s.currentPicker;
                if ('initialLoadComplete' in s) initialLoadComplete = s.initialLoadComplete;
            } };`;
    const api = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date', src)(
        env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia,
        fixedClock(NOW));
    return { api, env, store };
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

/** A game in `week`: finished when given scores. */
function game(id, away, home, kickoff, scores, line = { spread: 2.5, favorite: 'home' }) {
    const g = { id, away, home, kickoff, spread: line.spread, favorite: line.favorite, status: 'STATUS_SCHEDULED' };
    if (scores) Object.assign(g, { completed: true, status: 'STATUS_FINAL', awayScore: scores[0], homeScore: scores[1] });
    return g;
}

const APP = { spoilerHighlights: () => true, picker: () => 'Stephen' };

/**
 * Last week: Sunday 1pm (a week ago, finished), Sunday night and Monday night
 * (finished overnight). This week: Thursday, still to come.
 */
function slate(api) {
    const week = api.CURRENT_NFL_WEEK;
    api.NFL_GAMES_BY_WEEK[week - 1] = [
        game(1, 'Bengals', 'Falcons', '2026-11-08T18:00:00Z', [27, 20]),
        game(2, 'Buccaneers', 'Bears', '2026-11-09T01:20:00Z', [17, 24]),
        game(3, 'Cowboys', 'Eagles', '2026-11-10T01:15:00Z', [20, 23], { spread: 3, favorite: 'home' }),
        game(4, 'Jets', 'Bills', '2026-11-08T18:00:00Z', [10, 30]),
        game(9, 'Rams', 'Seahawks', '2026-11-01T18:00:00Z', [17, 16])
    ];
    api.NFL_GAMES_BY_WEEK[week] = [game(5, 'Steelers', 'Ravens', '2026-11-13T01:15:00Z', null)];
    const star = line => ({ line, winner: line, blazin: true });
    api.__setState({
        currentPicker: 'Dylan',   // someone else on screen: the panel is about the phone's own picker
        allPicks: {
            [week - 1]: {
                Stephen: {
                    bengals_falcons: star('away'), buccaneers_bears: star('home'),
                    cowboys_eagles: star('away'), rams_seahawks: star('home'),
                    jets_bills: { line: 'home', winner: 'home' }   // not a Blazin' pick
                },
                Dylan: { jets_bills: star('away') }
            },
            [week]: { Stephen: { steelers_ravens: star('home') } }
        }
    });
    return week;
}

section('On only in the 1.19 app');

check('off in a browser', () => {
    assert.strictEqual(load(null).api.spoilerHighlightsOn(), false);
});
check('off in an older app, which has no switch', () => {
    assert.strictEqual(load({ picker: () => 'Stephen' }).api.spoilerHighlightsOn(), false);
});
check('off when the bridge throws', () => {
    assert.strictEqual(load({ spoilerHighlights: () => { throw new Error('x'); } }).api.spoilerHighlightsOn(), false);
});
check('off when the switch is off, on when it is on', () => {
    assert.strictEqual(load({ spoilerHighlights: () => false }).api.spoilerHighlightsOn(), false);
    assert.strictEqual(load(APP).api.spoilerHighlightsOn(), true);
});

section('Whose games, and which');

check('the phone\'s picker, not whoever is on screen', () => {
    const { api } = load(APP);
    slate(api);
    assert.strictEqual(api.highlightsViewer(), 'Stephen');
    const keys = api.viewerBlazinGames().map(g => g.key);
    assert.ok(keys.every(k => !k.endsWith('jets_bills')), 'Dylan\'s star and Stephen\'s non-Blazin\' pick are left out');
    assert.strictEqual(keys.length, 5);
});

check('in kickoff order, a game still to come with no result', () => {
    const { api } = load(APP);
    const week = slate(api);
    const games = api.viewerBlazinGames();
    assert.deepStrictEqual(games.map(g => g.game.id), [9, 1, 2, 3, 5]);
    assert.strictEqual(games[4].week, week);
    assert.strictEqual(games[4].result, null);
});

check('no playoff weeks: the Blazin\' 5 is regular season only', () => {
    const { api } = load(APP);
    assert.deepStrictEqual(api.highlightsWeeks(18), [17, 18]);
    assert.deepStrictEqual(api.highlightsWeeks(19), [18]);
});

check('Cowherd, or no picker, has no panel', () => {
    for (const picker of ['Cowherd', '']) {
        const { api } = load({ spoilerHighlights: () => true, picker: () => picker });
        slate(api);
        api.__setState({ currentPicker: null });
        assert.deepStrictEqual(api.viewerBlazinGames(), []);
    }
});

section('Seen');

check('the first run counts games finished more than a day ago as seen', () => {
    const { api } = load(APP);
    const week = slate(api);
    const unseen = api.unseenFinishedBlazin();
    // Monday night kicked off within the day; Sunday night (35 hours ago) and earlier did not.
    assert.deepStrictEqual(unseen.map(g => g.key), [`${week - 1}:cowboys_eagles`]);
    assert.ok(api.readHighlightsSeen().has(`${week - 1}:buccaneers_bears`));
    assert.ok(api.readHighlightsSeen().has(`${week - 1}:bengals_falcons`));
});

check('a game marked seen is not shown again', () => {
    const { api } = load(APP);
    const week = slate(api);
    api.unseenFinishedBlazin();
    api.markHighlightsSeen([`${week - 1}:cowboys_eagles`]);
    assert.deepStrictEqual(api.unseenFinishedBlazin(), []);
});

check('the app on screen with no panel: everything finished counts as seen', () => {
    const { api } = load(APP);
    slate(api);
    api.__setState({ initialLoadComplete: true });
    api.markVisibleFinalsSeen();
    assert.deepStrictEqual(api.unseenFinishedBlazin(), []);
});

check('not marked while the page is hidden, before the first load, or with the switch off', () => {
    const hidden = load(APP);
    slate(hidden.api);
    hidden.api.__setState({ initialLoadComplete: true });
    hidden.env.document.visibilityState = 'hidden';
    hidden.api.markVisibleFinalsSeen();
    assert.strictEqual(hidden.api.readHighlightsSeen(), null);

    const loading = load(APP);
    slate(loading.api);
    loading.api.markVisibleFinalsSeen();
    assert.strictEqual(loading.api.readHighlightsSeen(), null);

    const off = load({ spoilerHighlights: () => false, picker: () => 'Stephen' });
    slate(off.api);
    off.api.__setState({ initialLoadComplete: true });
    off.api.markVisibleFinalsSeen();
    assert.strictEqual(off.api.readHighlightsSeen(), null);
});

check('seen is kept per season', () => {
    const { api, store } = load(APP);
    slate(api);
    api.markHighlightsSeen(['9:buccaneers_bears']);
    assert.ok(store.has(`highlightsSeen_${api.CURRENT_SEASON}`));
});

section('What the panel says');

check('the worker\'s key for a game\'s video, either way round', () => {
    const { api } = load(APP);
    assert.strictEqual(api.highlightsPair({ away: 'Buccaneers', home: 'Bears' }), 'bears_buccaneers');
    assert.strictEqual(api.highlightsPair({ away: 'Bears', home: 'Bucs' }), 'bears_buccaneers');
    assert.strictEqual(api.highlightsPair({ away: '49ers', home: 'Rams' }), '49ers_rams');
});

check('the pick is quoted from the side taken, at its own line', () => {
    const { api } = load(APP);
    slate(api);
    const games = api.viewerBlazinGames();
    const text = id => api.highlightsPickText(games.find(g => g.game.id === id));
    assert.strictEqual(text(2), 'Bears -2.5');
    assert.strictEqual(text(1), 'Bengals +2.5');
    // A locked pick is quoted at the number it was locked at.
    const locked = { ...games.find(g => g.game.id === 2) };
    locked.pick = { ...locked.pick, frozenSpread: 3.5, frozenFavorite: 'home', frozenAt: '2026-11-06T10:00:00Z' };
    assert.strictEqual(api.highlightsPickText(locked), 'Bears -3.5');
});

check('the reveal grades the pick at its line: covered, lost, push', () => {
    const { api } = load(APP);
    slate(api);
    const games = api.viewerBlazinGames();
    const html = id => api.highlightsResultHtml(games.find(g => g.game.id === id));
    assert.match(html(2), /Your pick covered/);   // Bears -2.5, won by 7
    assert.match(html(1), /Your pick covered/);   // Bengals +2.5, won outright
    assert.match(html(3), />Push</);             // Cowboys +3, lost by 3
    assert.match(html(9), /Your pick lost/);      // Seahawks -2.5, lost outright
    assert.ok(html(2).indexOf('>17<') < html(2).indexOf('>24<'), 'away score first');
});

section('The video');

check('Play hands the video to the app, which plays it on a screen of its own', () => {
    const asked = [];
    const { api } = load({ ...APP, playHighlights: id => asked.push(id) });
    api.playHighlightsVideo('O1fZ6Zkabgc');
    assert.deepStrictEqual(asked, ['O1fZ6Zkabgc']);
});

check('an app without the method does nothing rather than throw', () => {
    const { api } = load(APP);
    api.playHighlightsVideo('O1fZ6Zkabgc');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
