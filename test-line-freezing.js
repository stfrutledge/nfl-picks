// Tests for freezing a pick at its line.
//
// By default a pick stores a SIDE, never a number, so it is graded against
// whatever the spread is when it is scored - take Seahawks -3 on Tuesday and a
// move to -6.5 by Sunday re-prices you silently. A player may instead freeze a
// game, which snapshots the current line onto the pick and makes that game
// final.
//
// Two rules this guards especially:
//   - a card can only be frozen once it is complete
//   - freezing freezes the Blazin' star too, so it must never leave a picker
//     unable to reach five
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
const SHEET = fs.readFileSync(path.join(__dirname, 'google-apps-script-simple.js'), 'utf8');

/* ------------------------------------------------------------------ app.js */

/** A node stub complete enough for renderGames to run against. */
function node() {
    return {
        innerHTML: '', textContent: '', className: '', style: {}, disabled: false, title: '',
        dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, closest: () => null, querySelector: () => null,
        querySelectorAll: () => [], getAttribute: () => null, focus() {}, click() {}
    };
}

function makeAppEnv({ confirms = true, withDom = false } = {}) {
    const store = new Map();
    const toasts = [];
    const posts = [];
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
            getElementById: () => (withDom ? node() : null),
            querySelector: () => (withDom ? node() : null),
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : null;
            if (body) posts.push(body);
            return { ok: true, json: async () => ({ success: true }), text: async () => '{"success":true}' };
        },
        setTimeout,
        clearTimeout,
        // renderGames starts the per-game countdown timers; a live interval
        // would keep the process alive for ever once a card has rendered.
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {},
        confirm: () => confirms,
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
    // showToast is a function declaration in the same scope, so the binding can
    // be reassigned after load - shadowing it with a const collides.
    const exports = `;
    const TEST_TOASTS = [];
    showToast = (m, t) => TEST_TOASTS.push({ message: m, type: t });
    return ({
        MAX_BLAZIN_PICKS, PICKERS,
        lineForPick, atsWinnerForPick, isPickFrozen, isCardComplete,
        blazinReachableAfterFreezing, freezeEligibility, freezableGames,
        applyFreeze, freezeGameByKey, freezeAllCompleteGames, describeLine,
        calculateStatsForWeeks, standingsFromComputed, pickKey, countBlazinPicks,
        renderGames, renderScoringSummary,
        syncPicksToGoogleSheets,
        exportHistoricalData: window.exportHistoricalData,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __toasts: () => TEST_TOASTS,
        __state: () => ({ allPicks }),
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        PARSER + '\n' + snapshot + '\n' + APP + exports
    );
    const api = fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
    return { api, posts, toasts: () => api.__toasts() };
}

// Home favoured by 3 unless overridden.
function game(id, away, home, extra = {}) {
    return { id, away, home, spread: 3, favorite: 'home', day: 'Sun', time: '1:00 PM',
        kickoff: '2099-01-01T18:00:00Z', ...extra };
}

const WEEK = 5;

function setup({ games, picks = {}, week = WEEK, confirms = true, withDom = false } = {}) {
    const h = makeAppEnv({ confirms, withDom });
    h.api.NFL_GAMES_BY_WEEK[week] = games;
    h.api.__setState({
        currentWeek: week, currentPicker: 'Stephen',
        allPicks: { [week]: { Stephen: { ...picks } } }
    });
    return h;
}

/** Six games so the five-star cap can actually be reached. */
function sixGames() {
    return [
        game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs'), game(3, 'Jets', 'Dolphins'),
        game(4, 'Bears', 'Packers'), game(5, 'Giants', 'Eagles'), game(6, 'Saints', 'Falcons')
    ];
}
const complete = extra => ({ line: 'home', winner: 'home', ...extra });

/* ------------------------------------------ google-apps-script-simple.js */

const HEADER = ['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team',
    'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin',
    'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome', 'Frozen At'];

function loadSheet(rows) {
    const SpreadsheetApp = {
        getActiveSpreadsheet: () => ({
            getSheetByName: name => (name === 'Backup' ? {
                getDataRange: () => ({ getValues: () => rows }),
                getRange: () => ({ setValues() {}, setValue() {}, setFontWeight() {}, getValues: () => [[]] }),
                appendRow() {}
            } : null),
            insertSheet: () => ({
                getDataRange: () => ({ getValues: () => [] }),
                getRange: () => ({ setValues() {}, setValue() {}, setFontWeight() {}, getValues: () => [[]] }),
                appendRow() {}
            })
        })
    };
    return new Function('SpreadsheetApp', 'ContentService', 'Logger',
        SHEET + ';return { getAllPicks, foldPickRow, lineFromRow, readPickRow };')(
        SpreadsheetApp,
        { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
        { log() {} });
}

function sheetRow(ts, week, picker, key, away, home, awaySpread, homeSpread, line, winner, frozenAt) {
    return [ts, week, picker, key, away, home, awaySpread, homeSpread, line || '', winner || '',
        '', '', '', '', '', '', frozenAt || ''];
}

/* ----------------------------------------------------------------- runner */

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {

section('Only a complete card can be frozen');

await check('a card with only a line pick cannot be frozen', async () => {
    const h = setup({ games: sixGames(), picks: { rams_seahawks: { line: 'home' } } });
    const e = h.api.freezeEligibility(h.api.NFL_GAMES_BY_WEEK[WEEK][0]);
    assert.strictEqual(e.canFreeze, false);
    assert.match(e.reason, /Make all picks/);
});

await check('line + winner is complete enough in the regular season', async () => {
    const h = setup({ games: sixGames(), picks: { rams_seahawks: complete() } });
    assert.strictEqual(h.api.freezeEligibility(h.api.NFL_GAMES_BY_WEEK[WEEK][0]).canFreeze, true);
});

await check('a Blazin star is not required for completeness', async () => {
    // It is capped at five a week, so most cards will never carry one.
    const h = setup({ games: sixGames(), picks: { rams_seahawks: complete() } });
    assert.strictEqual(h.api.isCardComplete(h.api.NFL_GAMES_BY_WEEK[WEEK][0], complete(), WEEK), true);
});

await check('the playoffs also require an over/under pick', async () => {
    const g = game(1, 'Rams', 'Seahawks', { overUnder: 44.5 });
    const h = setup({ games: [g], picks: { rams_seahawks: complete() }, week: 19 });
    assert.strictEqual(h.api.isCardComplete(g, complete(), 19), false);
    assert.strictEqual(h.api.isCardComplete(g, complete({ overUnder: 'over' }), 19), true);
});

await check('freezing without a line is refused', async () => {
    // Freezing at an absent spread would store undefined and push for ever.
    const g = game(1, 'Rams', 'Seahawks', { spread: undefined });
    const h = setup({ games: [g], picks: { rams_seahawks: complete() } });
    const e = h.api.freezeEligibility(g);
    assert.strictEqual(e.canFreeze, false);
    assert.match(e.reason, /No line available/);
});

section('A frozen pick keeps its own number');

await check('the line moving does not re-price a frozen pick', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() } });
    h.api.applyFreeze(games[0]);                    // frozen at -3

    games[0].spread = 7;                            // line moves after the freeze
    games[0].completed = true;
    games[0].awayScore = 10;
    games[0].homeScore = 15;                        // home by 5

    const line = h.api.standingsFromComputed(h.api.calculateStatsForWeeks(WEEK, WEEK), 'line');
    assert.deepStrictEqual(
        { w: line.Stephen.wins, l: line.Stephen.losses, p: line.Stephen.pushes },
        { w: 1, l: 0, p: 0 }, 'home by 5 covers the frozen -3');
});

await check('a riding pick does re-price when the line moves', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() } });  // not frozen

    games[0].spread = 7;
    games[0].completed = true;
    games[0].awayScore = 10;
    games[0].homeScore = 15;                        // home by 5, short of -7

    const line = h.api.standingsFromComputed(h.api.calculateStatsForWeeks(WEEK, WEEK), 'line');
    assert.strictEqual(line.Stephen.losses, 1, 'graded against the current -7');
});

await check('a favourite flip is honoured by the frozen line', async () => {
    const games = [game(1, 'Rams', 'Seahawks', { spread: 1.5, favorite: 'home' })];
    const h = setup({ games, picks: { rams_seahawks: { line: 'away', winner: 'away' } } });
    h.api.applyFreeze(games[0]);                    // frozen: Seahawks -1.5

    games[0].favorite = 'away';                     // line crosses zero
    games[0].spread = 2.5;
    games[0].completed = true;
    games[0].awayScore = 20;
    games[0].homeScore = 19;                        // away by 1

    const line = h.api.standingsFromComputed(h.api.calculateStatsForWeeks(WEEK, WEEK), 'line');
    assert.strictEqual(line.Stephen.wins, 1, 'away +1.5 covers a 1-point win');
});

await check('freezing records the line and marks the pick frozen', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() } });
    const frozen = h.api.applyFreeze(games[0]);
    assert.strictEqual(frozen.frozenSpread, 3);
    assert.strictEqual(frozen.frozenFavorite, 'home');
    assert.ok(frozen.frozenAt, 'carries a timestamp');
    assert.strictEqual(h.api.isPickFrozen(frozen), true);
});

section("Freezing must not strand the Blazin' 5 allocation");

await check('a freeze that would make five stars unreachable is refused', async () => {
    // Six games, no stars yet: freezing two leaves four candidates, so the
    // second freeze is the one that makes five impossible.
    const games = sixGames();
    const picks = {};
    games.forEach(g => { picks[`${g.away.toLowerCase()}_${g.home.toLowerCase()}`] = complete(); });
    const h = setup({ games, picks });

    h.api.applyFreeze(games[0]);
    const e = h.api.freezeEligibility(games[1]);
    assert.strictEqual(e.canFreeze, false);
    assert.match(e.reason, /Blazin/);
});

await check('with all five stars placed, freezing is unrestricted', async () => {
    const games = sixGames();
    const picks = {};
    games.forEach((g, i) => {
        picks[`${g.away.toLowerCase()}_${g.home.toLowerCase()}`] = complete(i < 5 ? { blazin: true } : {});
    });
    const h = setup({ games, picks });
    games.forEach(g => assert.strictEqual(h.api.freezeEligibility(g).canFreeze, true, g.home));
});

await check('a star is not lost when its game is frozen', async () => {
    const games = sixGames();
    const picks = {};
    games.forEach((g, i) => {
        picks[`${g.away.toLowerCase()}_${g.home.toLowerCase()}`] = complete(i < 5 ? { blazin: true } : {});
    });
    const h = setup({ games, picks });

    assert.strictEqual(h.api.countBlazinPicks(WEEK, 'Stephen'), 5);
    h.api.applyFreeze(games[0]);   // freezing a game that carries a star
    assert.strictEqual(h.api.countBlazinPicks(WEEK, 'Stephen'), 5, 'the star survives the freeze');
    assert.ok(h.api.blazinReachableAfterFreezing([], WEEK, 'Stephen') >= h.api.MAX_BLAZIN_PICKS,
        'and five remain reachable');
});

await check('the playoffs have no Blazin constraint', async () => {
    const games = [game(1, 'Rams', 'Seahawks', { overUnder: 44.5 })];
    const h = setup({ games, picks: { rams_seahawks: complete({ overUnder: 'over' }) }, week: 19 });
    assert.strictEqual(h.api.freezeEligibility(games[0], 19, 'Stephen').canFreeze, true);
});

section('Freeze all');

await check('is blocked until all five stars are placed', async () => {
    const games = sixGames();
    const picks = {};
    games.forEach(g => { picks[`${g.away.toLowerCase()}_${g.home.toLowerCase()}`] = complete(); });
    const h = setup({ games, picks });

    assert.strictEqual(h.api.freezeAllCompleteGames(), false);
    assert.match(h.toasts().pop().message, /Blazin/);
});

await check('freezes the complete games and reports the incomplete ones', async () => {
    const games = sixGames();
    const picks = {};
    games.forEach((g, i) => {
        const key = `${g.away.toLowerCase()}_${g.home.toLowerCase()}`;
        // Five starred and complete; the last two left half-picked.
        picks[key] = i < 4 ? complete({ blazin: true }) : (i === 4 ? complete({ blazin: true }) : { line: 'home' });
    });
    const h = setup({ games, picks });

    assert.strictEqual(h.api.freezeAllCompleteGames(), true);
    const state = h.api.__state().allPicks[WEEK].Stephen;
    assert.strictEqual(h.api.isPickFrozen(state.rams_seahawks), true);
    assert.strictEqual(h.api.isPickFrozen(state.saints_falcons), false, 'incomplete, still riding');
    assert.match(h.toasts().pop().message, /5 games\. 1 incomplete/);
});

await check('does nothing when the user declines the confirm', async () => {
    const games = sixGames();
    const picks = {};
    games.forEach((g, i) => {
        picks[`${g.away.toLowerCase()}_${g.home.toLowerCase()}`] = complete(i < 5 ? { blazin: true } : {});
    });
    const h = setup({ games, picks, confirms: false });
    assert.strictEqual(h.api.freezeAllCompleteGames(), false);
    assert.strictEqual(h.api.isPickFrozen(h.api.__state().allPicks[WEEK].Stephen.rams_seahawks), false);
});

section('A freeze survives the round trip');

await check('the whole-week sync carries the frozen line', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() } });
    h.api.applyFreeze(games[0]);
    games[0].spread = 9;                            // line moves before the sync

    await h.api.syncPicksToGoogleSheets(false);
    const row = h.posts.find(p => p.picks).picks.find(p => p.gameId === 'rams_seahawks');
    assert.ok(row.frozenAt, 'the freeze is sent');
    assert.strictEqual(row.homeSpread, -3, 'the spread columns carry the FROZEN line, not the new one');
});

await check('the archive keeps the frozen fields', async () => {
    // exportHistoricalData is a field whitelist - anything not copied is lost.
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() }, week: 1 });
    h.api.NFL_GAMES_BY_WEEK[1] = games;
    h.api.__setState({ currentWeek: 1, allPicks: { 1: { Stephen: { rams_seahawks: complete() } } } });
    h.api.applyFreeze(games[0], 1, 'Stephen');

    const dump = h.api.exportHistoricalData();
    const text = typeof dump === 'string' ? dump : JSON.stringify(dump);
    assert.match(text, /frozenAt/, 'frozenAt survives archiving');
    assert.match(text, /frozenSpread/);
});

section('The card renders');

// The bug this exists for: the frozen-state consts were declared BELOW the
// card-class list that reads them, so renderGames threw 'Cannot access
// frozen before initialization' on every render and the app showed
// "Failed to Load Data". Every other test exercised the scoring engine
// directly and never rendered a card, so nothing caught it.

await check('renderGames does not throw with a riding pick', async () => {
    const h = setup({
        games: sixGames(),
        picks: { rams_seahawks: complete() },
        withDom: true
    });
    h.api.renderGames();
});

await check('renderGames does not throw with a frozen pick', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() }, withDom: true });
    h.api.applyFreeze(games[0]);
    h.api.renderGames();
});

await check('renderGames does not throw when the line has drifted', async () => {
    const games = sixGames();
    const h = setup({
        games,
        picks: { rams_seahawks: complete({ pickedSpread: 3, pickedFavorite: 'home' }) },
        withDom: true
    });
    games[0].spread = 7;   // moved since the pick
    h.api.renderGames();
});

await check('renderScoringSummary does not throw with a frozen pick', async () => {
    const games = sixGames();
    const h = setup({ games, picks: { rams_seahawks: complete() }, withDom: true });
    h.api.applyFreeze(games[0]);
    h.api.renderScoringSummary();
});

section('The sheet reader treats a freeze as final');

await check('a frozen row outranks a later unfrozen one', async () => {
    // The whole-week snapshot means a stale tab can re-sync an unfrozen copy.
    const api = loadSheet([HEADER,
        sheetRow('2026-09-08T10:00:00Z', '2026_5', 'Stephen', 'rams_seahawks', 'Rams', 'Seahawks',
            3, -3, 'Seahawks', 'Seahawks', '2026-09-08T10:00:00Z'),
        sheetRow('2026-09-09T10:00:00Z', '2026_5', 'Stephen', 'rams_seahawks', 'Rams', 'Seahawks',
            7, -7, 'Seahawks', 'Seahawks', '')
    ]);
    const pick = api.getAllPicks().picks['2026_5'].Stephen.rams_seahawks;
    assert.ok(pick.frozenAt, 'still frozen');
    assert.strictEqual(pick.frozenSpread, 3, 'kept the frozen number, not the later -7');
    assert.strictEqual(pick.frozenFavorite, 'home');
});

await check('an unfrozen game is unaffected by the rule', async () => {
    const api = loadSheet([HEADER,
        sheetRow('2026-09-08T10:00:00Z', '2026_5', 'Stephen', 'bills_chiefs', 'Bills', 'Chiefs',
            3, -3, 'Chiefs', 'Chiefs', ''),
        sheetRow('2026-09-09T10:00:00Z', '2026_5', 'Stephen', 'bills_chiefs', 'Bills', 'Chiefs',
            3, -3, 'Bills', 'Bills', '')
    ]);
    const pick = api.getAllPicks().picks['2026_5'].Stephen.bills_chiefs;
    assert.strictEqual(pick.line, 'away', 'newest row wins as before');
    assert.strictEqual(pick.frozenAt, undefined);
});

await check('the favourite is recovered from the signed spread columns', async () => {
    const api = loadSheet([HEADER]);
    assert.deepStrictEqual(api.lineFromRow({ awaySpread: 3, homeSpread: -3 }), { spread: 3, favorite: 'home' });
    assert.deepStrictEqual(api.lineFromRow({ awaySpread: -2.5, homeSpread: 2.5 }), { spread: 2.5, favorite: 'away' });
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
// Rendering a card schedules timers inside app.js, which would otherwise keep
// the process alive after the suite has finished. Exit explicitly.
process.exit(0);

})();
