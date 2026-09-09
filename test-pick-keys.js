// Tests for matchup-based pick keys. Runs app.js in Node with browser stubs.
//
// The thing these guard: a pick key ("away_home") does NOT encode the season, so
// they only stay separate because every store that holds picks is season-scoped
// one level up. If that ever stops being true, these fail.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeEnv(prependSrc) {
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
            querySelectorAll: () => [],
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

    const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    // __state() closes over the live top-level bindings, so it reflects
    // reassignment (allPicks/clearedPicks are `let`).
    const exports = `;return ({
        CURRENT_SEASON, PICKS_STORAGE_KEY, CLEARED_PICKS_KEY,
        toSheetWeek, fromSheetWeek,
        pickKey, normalizeTeamName, normalizePickKey, getPicksForGame,
        rekeyPicksByMatchup, migrateWeekPicksToMatchupKeys, normalizeSeasonPicks,
        loadAllPicksFromBackup,
        __state: () => ({ allPicks, clearedPicks, NFL_GAMES_BY_WEEK, seasonData })
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + prependSrc + '\n' + appSrc + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, env, store };
}

const EMPTY_SNAPSHOT = `
    const HISTORICAL_DATA_SEASON = ${new Date().getMonth() >= 6
        ? new Date().getFullYear() : new Date().getFullYear() - 1};
    const HISTORICAL_GAMES = {};
    const HISTORICAL_RESULTS = {};
    const HISTORICAL_PICKS = {};
`;

const game = (id, away, home) => ({ id, away, home, spread: 3, favorite: 'home' });

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
}

(async () => {
    const { api, store } = makeEnv(EMPTY_SNAPSHOT);
    const S = api.CURRENT_SEASON;

    console.log('\nKey construction');

    check('key is away_home, lowercased', () => {
        assert.strictEqual(api.pickKey(game(1, 'Rams', 'Seahawks')), 'rams_seahawks');
    });

    check('aliases normalize to one canonical key', () => {
        // Same game written by the sheet ("Buccs") and by ESPN ("Buccaneers")
        assert.strictEqual(api.pickKey(game(1, 'Buccs', 'Eagles')), 'buccaneers_eagles');
        assert.strictEqual(api.pickKey(game(1, 'Bucs', 'Eagles')), 'buccaneers_eagles');
        assert.strictEqual(api.pickKey(game(1, 'TB', 'Eagles')), 'buccaneers_eagles');
        assert.strictEqual(api.pickKey(game(1, 'Buccaneers', 'Eagles')), 'buccaneers_eagles');
    });

    check('already-lowercased names still normalize (sheet round-trip)', () => {
        assert.strictEqual(api.normalizeTeamName('buccs'), 'buccaneers');
        assert.strictEqual(api.normalizePickKey('buccs_eagles'), 'buccaneers_eagles');
        assert.strictEqual(api.normalizePickKey('wsh_nyg'), 'commanders_giants');
    });

    check('a non-matchup key passes through normalizePickKey untouched', () => {
        assert.strictEqual(api.normalizePickKey('1'), '1');
        assert.strictEqual(api.normalizePickKey('12'), '12');
    });

    console.log('\nCross-season separation (the requirement)');

    check('localStorage pick store is season-scoped', () => {
        assert.strictEqual(api.PICKS_STORAGE_KEY, `nflPicks_${S}`);
        assert.strictEqual(api.CLEARED_PICKS_KEY, `clearedPicks_${S}`);
        // A prior season's picks live under a different localStorage key entirely
        assert.notStrictEqual(api.PICKS_STORAGE_KEY, `nflPicks_${S - 1}`);
    });

    check('sheet rows are season-prefixed, so an identical matchup cannot collide', () => {
        assert.strictEqual(api.toSheetWeek(5), `${S}_5`);
        assert.strictEqual(api.fromSheetWeek(`${S}_5`), 5);
        assert.strictEqual(api.fromSheetWeek(`${S - 1}_5`), null, 'prior season rejected');
        assert.strictEqual(api.fromSheetWeek('5'), null, 'legacy un-prefixed row rejected');
    });

    {
        // Week 5 "rams_seahawks" exists in BOTH seasons on the shared sheet.
        // Only the current season's row may reach allPicks.
        const { api: a, env: e } = makeEnv(EMPTY_SNAPSHOT);
        const payload = {
            picks: {
                [`${S}_5`]: { Stephen: { rams_seahawks: { line: 'home', winner: 'home' } } },
                [`${S - 1}_5`]: { Stephen: { rams_seahawks: { line: 'away', winner: 'away' } } },
                '5': { Stephen: { rams_seahawks: { line: 'away', winner: 'away' } } }
            },
            cleared: {},
            weekCount: 3
        };
        e.fetch = async () => ({ json: async () => payload, text: async () => JSON.stringify(payload) });
        await a.loadAllPicksFromBackup();
        const picks = a.__state().allPicks[5].Stephen;
        assert.deepStrictEqual(Object.keys(picks), ['rams_seahawks']);
        assert.strictEqual(picks.rams_seahawks.line, 'home', 'current-season row must win');
        passed++;
        console.log('  ok  same matchup in a prior season is dropped on backup ingest');
    }

    {
        const { api: a, env: e } = makeEnv(EMPTY_SNAPSHOT);
        // The Apps Script builds the key from raw team-name columns, so it can
        // emit "buccs_eagles" where the client would produce "buccaneers_eagles".
        const payload = {
            picks: { [`${S}_3`]: { Sean: { buccs_eagles: { line: 'away', winner: 'away' } } } },
            cleared: {}, weekCount: 1
        };
        e.fetch = async () => ({ json: async () => payload, text: async () => JSON.stringify(payload) });
        await a.loadAllPicksFromBackup();
        const picks = a.__state().allPicks[3].Sean;
        assert.deepStrictEqual(Object.keys(picks), ['buccaneers_eagles']);
        assert.strictEqual(
            a.getPicksForGame(picks, game(1, 'Buccaneers', 'Eagles')).line, 'away',
            'ESPN-named game must find the sheet-named pick');
        passed++;
        console.log('  ok  backup ingest normalizes an aliased key from the sheet');
    }

    console.log('\nWithin-season separation');

    check('a division rematch gets a distinct key (home/away flips)', () => {
        assert.notStrictEqual(
            api.pickKey(game(1, 'Rams', 'Seahawks')),
            api.pickKey(game(9, 'Seahawks', 'Rams')));
    });

    check('a repeated matchup with the same host is separated by week', () => {
        // Regular-season meeting and a playoff rematch at the same venue share a
        // key, but live under different week numbers in the picks path.
        const key = api.pickKey(game(1, 'Bills', 'Chiefs'));
        const allPicks = { 11: { Sean: { [key]: { line: 'home' } } },
                           21: { Sean: { [key]: { line: 'away' } } } };
        assert.strictEqual(allPicks[11].Sean[key].line, 'home');
        assert.strictEqual(allPicks[21].Sean[key].line, 'away');
    });

    console.log('\nLegacy game-id migration');

    check('numeric ids convert to matchup keys', () => {
        const games = [game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs')];
        const r = api.rekeyPicksByMatchup(
            { '1': { line: 'home', winner: 'home' }, '2': { line: 'away' } }, games);
        assert.strictEqual(r.converted, 2);
        assert.deepStrictEqual(Object.keys(r.picks).sort(), ['bills_chiefs', 'rams_seahawks']);
        assert.strictEqual(r.picks.rams_seahawks.line, 'home');
    });

    check('a split pick is reunited, not overwritten (the Blazin\' 5 bug)', () => {
        // What the old code produced: line/winner under the matchup key from
        // handlePickSelect, the star under the numeric id from handleBlazinToggle.
        const games = [game(1, 'Rams', 'Seahawks')];
        const r = api.rekeyPicksByMatchup(
            { '1': { blazin: true }, 'rams_seahawks': { line: 'home', winner: 'home' } }, games);
        assert.deepStrictEqual(r.picks, {
            rams_seahawks: { blazin: true, line: 'home', winner: 'home' }
        }, 'the star must survive the merge');
    });

    check('migration is idempotent', () => {
        const games = [game(1, 'Rams', 'Seahawks')];
        const once = api.rekeyPicksByMatchup({ '1': { line: 'home' } }, games);
        const twice = api.rekeyPicksByMatchup(once.picks, games);
        assert.strictEqual(twice.converted, 0, 'second pass must be a no-op');
        assert.deepStrictEqual(twice.picks, once.picks);
    });

    check('unknown keys are kept and reported, never silently dropped', () => {
        const games = [game(1, 'Rams', 'Seahawks')];
        const r = api.rekeyPicksByMatchup(
            { 'rams_seahawks': { line: 'home' }, 'jets_dolphins': { line: 'away' } }, games);
        assert.deepStrictEqual(r.orphans, ['jets_dolphins']);
        assert.strictEqual(r.picks.jets_dolphins.line, 'away', 'orphan must be preserved');
    });

    check('picks are left alone when the schedule is not loaded yet', () => {
        const before = { '1': { line: 'home' } };
        const r = api.rekeyPicksByMatchup(before, []);
        assert.strictEqual(r.converted, 0);
        assert.deepStrictEqual(r.picks, before, 'must not destroy picks before games arrive');
    });

    console.log('\nHistorical season files');

    check('season picks are re-keyed on load and read back by matchup', () => {
        const data = {
            games: { 1: [game(1, 'Buccs', 'Eagles'), game(2, 'Rams', 'Seahawks')] },
            results: { 1: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } } },
            picks: { 1: { Dylan: { '1': { line: 'home', blazin: true }, '2': { line: 'away' } } } }
        };
        api.normalizeSeasonPicks(data, 2019);
        assert.deepStrictEqual(
            Object.keys(data.picks[1].Dylan).sort(), ['buccaneers_eagles', 'rams_seahawks']);
        // An ESPN-named game must resolve against a sheet-named historical game
        assert.strictEqual(
            api.getPicksForGame(data.picks[1].Dylan, game(1, 'Buccaneers', 'Eagles')).blazin, true);
        // Results stay id-keyed on purpose
        assert.strictEqual(data.results[1][1].winner, 'home');
    });

    check('normalizing a season twice is safe', () => {
        const data = {
            games: { 1: [game(1, 'Rams', 'Seahawks')] },
            results: {},
            picks: { 1: { Sean: { '1': { line: 'home' } } } }
        };
        api.normalizeSeasonPicks(data, 2018);
        const snapshot = JSON.stringify(data.picks);
        api.normalizeSeasonPicks(data, 2018);
        assert.strictEqual(JSON.stringify(data.picks), snapshot);
    });

    console.log('\nLookup');

    check('getPicksForGame never falls back to a positional game id', () => {
        // game.id is reassigned by kickoff order, so an id-keyed entry must not
        // be attributed to whichever game happens to sit in that slot.
        const stale = { '1': { line: 'away' } };
        assert.deepStrictEqual(api.getPicksForGame(stale, game(1, 'Rams', 'Seahawks')), {});
    });

    check('getPicksForGame tolerates a missing picker', () => {
        assert.deepStrictEqual(api.getPicksForGame(undefined, game(1, 'Rams', 'Seahawks')), {});
    });

    console.log(`\nALL ${passed} CHECKS PASSED\n`);
})().catch(e => {
    console.error('\nTEST FAILED:', e.message);
    if (e.expected !== undefined) {
        console.error('  expected:', JSON.stringify(e.expected));
        console.error('  actual:  ', JSON.stringify(e.actual));
    }
    process.exit(1);
});
