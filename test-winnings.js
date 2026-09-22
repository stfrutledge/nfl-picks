// Tests for the winnings engine: what a flat stake on every pick would have
// returned. Runs app.js in Node with browser stubs, the way
// test-standings-engine.js does.
//
// The engine is calculateStatsForWeeks with money on it, so most of what is
// worth checking is that the money follows the record exactly - frozen lines,
// pushes, Cowherd's one column, the chosen stake - and that the vs Market
// bankroll, which used to keep its own copy of the arithmetic, agrees.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeEnv() {
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
        PICKERS, COWHERD, PICKERS_WITH_COWHERD, CURRENT_NFL_WEEK,
        calculateStatsForWeeks,
        STANDARD_PRICE, DEFAULT_WINNINGS_STAKE, WINNINGS_CATEGORIES,
        profitPerDollar, profitForOutcome, profitForRecord,
        getWinningsStake, setWinningsStake, calculateWinnings,
        formatCurrency, formatStake, formatSignedPercent, profitTone,
        calculatePickerWeeklyBankroll,
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, weeklyPicksCache,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    return fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia);
}

// Home team favoured by 3 throughout: home covers only by more than 3.
function game(id, away, home, extra = {}) {
    return { id, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM', ...extra };
}

function setup({ weeks = {}, picks = {}, results = {} } = {}) {
    const api = makeEnv();
    for (const [week, games] of Object.entries(weeks)) api.NFL_GAMES_BY_WEEK[week] = games;
    for (const [week, res] of Object.entries(results)) api.NFL_RESULTS_BY_WEEK[week] = res;
    api.__setState({ allPicks: picks, currentWeek: 1, currentPicker: 'Stephen' });
    return api;
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }
function near(actual, expected, msg) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} expected ${expected}, got ${actual}`);
}

const WIN = 20 * 100 / 110; // what a $20 winner pays at -110

const WEEK_1 = [
    game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 20 }), // home covers
    game(2, 'Bills', 'Chiefs', { completed: true, awayScore: 20, homeScore: 21 }),  // home wins, does not cover
    game(3, 'Jets', 'Dolphins', { completed: true, awayScore: 10, homeScore: 13 })  // exactly 3 -> push
];
const WEEK_2 = [
    game(4, 'Lions', 'Bears', { completed: true, awayScore: 30, homeScore: 10 }),   // away covers
    game(5, 'Eagles', 'Giants', { completed: true, awayScore: 7, homeScore: 21 })    // home covers
];

section('The arithmetic');

check('a -110 winner pays 10/11 of the stake, a loser costs the stake, a push returns it', () => {
    const api = setup();
    near(api.profitForOutcome(20, 'win'), WIN);
    assert.strictEqual(api.profitForOutcome(20, 'loss'), -20);
    assert.strictEqual(api.profitForOutcome(20, 'push'), 0);
});

check('other prices are read as American odds', () => {
    const api = setup();
    near(api.profitPerDollar(-110), 100 / 110);
    near(api.profitPerDollar(-200), 0.5);
    near(api.profitPerDollar(150), 1.5);
    near(api.profitForOutcome(10, 'win', 150), 15);
});

check('a record is priced win by win', () => {
    const api = setup();
    near(api.profitForRecord({ wins: 3, losses: 2, pushes: 1 }, 20), 3 * WIN - 2 * 20);
    assert.strictEqual(api.profitForRecord({ wins: 0, losses: 0, pushes: 0 }, 20), 0);
});

check('money formats with a sign and two decimals', () => {
    const api = setup();
    assert.strictEqual(api.formatCurrency(WIN), '+$18.18');
    assert.strictEqual(api.formatCurrency(-20), '-$20.00');
    assert.strictEqual(api.formatCurrency(0), '$0.00');
    assert.strictEqual(api.formatCurrency(1234.5), '+$1,234.50');
    assert.strictEqual(api.formatStake(20), '$20');
    assert.strictEqual(api.formatStake(12.5), '$12.50');
    assert.strictEqual(api.formatSignedPercent(8.25), '+8.3%');
    assert.strictEqual(api.formatSignedPercent(-3), '-3.0%');
    assert.strictEqual(api.formatSignedPercent(null), '');
    assert.strictEqual(api.profitTone(5), 'positive');
    assert.strictEqual(api.profitTone(-5), 'negative');
    assert.strictEqual(api.profitTone(0), 'neutral');
});

section('The engine');

check('line picks are priced exactly as the standings score them', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'home' },   // win
            bills_chiefs: { line: 'home' },    // loss
            jets_dolphins: { line: 'home' }    // push
        } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    assert.deepStrictEqual([w.wins, w.losses, w.pushes], [1, 1, 1]);
    assert.strictEqual(w.picks, 3);
    assert.strictEqual(w.staked, 60);
    near(w.profit, WIN - 20);
    near(w.roi, ((WIN - 20) / 60) * 100);
    // The record it was priced from is the standings' own.
    const s = api.calculateStatsForWeeks(1, 1).Stephen.line;
    assert.deepStrictEqual({ wins: w.wins, losses: w.losses, pushes: w.pushes }, s);
});

check('a starred pick is priced again in the Blazin\' 5 column', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: {
            rams_seahawks: { line: 'home', blazin: true },  // win, starred
            bills_chiefs: { line: 'home' }                  // loss, not starred
        } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen;
    near(w.line.profit, WIN - 20);
    near(w.blazin.profit, WIN);
    assert.strictEqual(w.blazin.picks, 1);
    assert.strictEqual(w.blazin.staked, 20);
});

check('a push stakes money and returns it: in picks and staked, not in profit', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { jets_dolphins: { line: 'away' } } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    assert.deepStrictEqual([w.wins, w.losses, w.pushes], [0, 0, 1]);
    assert.strictEqual(w.picks, 1);
    assert.strictEqual(w.staked, 20);
    assert.strictEqual(w.profit, 0);
    assert.strictEqual(w.roi, 0);
});

check('straight-up picks are not priced', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { winner: 'home' }, bills_chiefs: { winner: 'home' } } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen;
    assert.strictEqual(w.line.picks, 0);
    assert.strictEqual(w.line.profit, 0);
    assert.strictEqual(w.line.roi, null, 'nothing staked is no ROI, not 0%');
    assert.deepStrictEqual(Object.keys(w).sort(), ['blazin', 'line'], 'winner is not a priced category');
});

check('the stake scales everything but the record', () => {
    const picks = { 1: { Stephen: { rams_seahawks: { line: 'home' }, bills_chiefs: { line: 'home' } } } };
    const api = setup({ weeks: { 1: WEEK_1 }, picks });
    const at20 = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    const at50 = api.calculateWinnings(50, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    near(at50.profit, at20.profit * 2.5);
    assert.strictEqual(at50.staked, at20.staked * 2.5);
    near(at50.roi, at20.roi, 'ROI does not depend on the stake');
    assert.deepStrictEqual([at50.wins, at50.losses], [at20.wins, at20.losses]);
});

check('byWeek carries each week\'s profit and a running total, played weeks only', () => {
    const api = setup({
        weeks: { 1: WEEK_1, 2: WEEK_2 },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home' }, bills_chiefs: { line: 'home' } } }, // W L
            2: { Stephen: { lions_bears: { line: 'away' }, eagles_giants: { line: 'home' } } }   // W W
        }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 3 }).Stephen.line;
    assert.deepStrictEqual(w.byWeek.map(x => x.week), [1, 2], 'week 3 has no games and is not a row');
    near(w.byWeek[0].profit, WIN - 20);
    near(w.byWeek[0].running, WIN - 20);
    near(w.byWeek[1].profit, 2 * WIN);
    near(w.byWeek[1].running, 3 * WIN - 20);
    near(w.profit, w.byWeek[1].running, 'the season total is the last running total');
});

check('a week with line picks but no Blazin\' 5 is not a Blazin\' 5 row', () => {
    const api = setup({
        weeks: { 1: WEEK_1, 2: WEEK_2 },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home' } } },
            2: { Stephen: { lions_bears: { line: 'away', blazin: true } } }
        }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 2 }).Stephen;
    assert.deepStrictEqual(w.line.byWeek.map(x => x.week), [1, 2]);
    assert.deepStrictEqual(w.blazin.byWeek.map(x => x.week), [2]);
});

check('a frozen pick is priced at the line it was frozen at', () => {
    // Home won by 5. On the game's current -3 that covers; the pick was frozen
    // at -7, and at -7 it does not.
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { completed: true, awayScore: 10, homeScore: 15 })] },
        picks: { 1: { Stephen: { rams_seahawks: {
            line: 'home', frozenAt: '2026-09-10T00:00:00Z', frozenSpread: 7, frozenFavorite: 'home'
        } } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    assert.deepStrictEqual([w.wins, w.losses], [0, 1]);
    assert.strictEqual(w.profit, -20);
});

check('a pick with no usable line is not scored, so it stakes nothing', () => {
    // No line at all - a 0 would be a pick em, which IS scorable.
    const api = setup({
        weeks: { 1: [game(1, 'Rams', 'Seahawks', { spread: null, favorite: null, completed: true, awayScore: 10, homeScore: 20 })] },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    const w = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    assert.strictEqual(w.picks, 0);
    assert.strictEqual(w.staked, 0);
    assert.strictEqual(w.roi, null);
});

check('a computed stats object can be handed in instead of re-scoring', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    const computed = api.calculateStatsForWeeks(1, 1);
    const fromComputed = api.calculateWinnings(20, { computed }).Stephen.line;
    const scored = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    assert.deepStrictEqual(fromComputed, scored);
});

check('every regular picker gets both columns, scored or not', () => {
    const api = setup({ weeks: { 1: WEEK_1 } });
    const all = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 });
    api.PICKERS.forEach(p => {
        assert.deepStrictEqual(Object.keys(all[p]).sort(), ['blazin', 'line'], p);
        assert.strictEqual(all[p].line.picks, 0);
    });
});

section('Cowherd');

check('Cowherd has a Blazin\' 5 column only, and only once he has picks', () => {
    const api = setup({ weeks: { 1: WEEK_1 } });
    const before = api.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 })[api.COWHERD];
    assert.deepStrictEqual(before, {}, 'no picks: no column at all');

    // His picks are stored under his own name, which the app defines.
    const api2 = setup({ weeks: { 1: WEEK_1 } });
    api2.__setState({ allPicks: { 1: { [api2.COWHERD]: {
        rams_seahawks: { line: 'home', blazin: true },  // win
        bills_chiefs: { line: 'home', blazin: true }    // loss
    } } } });
    const c = api2.calculateWinnings(20, { firstWeek: 1, lastWeek: 1 })[api2.COWHERD];
    assert.deepStrictEqual(Object.keys(c), ['blazin'], 'his line picks ARE the Blazin\' 5');
    near(c.blazin.profit, WIN - 20);
});

section('The stake');

check('the default stake is $20 until one is chosen', () => {
    const api = setup();
    assert.strictEqual(api.DEFAULT_WINNINGS_STAKE, 20);
    assert.strictEqual(api.getWinningsStake(), 20);
});

check('a chosen stake is remembered, as a number', () => {
    const api = setup();
    assert.strictEqual(api.setWinningsStake('50'), 50);
    assert.strictEqual(api.getWinningsStake(), 50);
    assert.strictEqual(api.setWinningsStake(12.5), 12.5);
    assert.strictEqual(api.getWinningsStake(), 12.5);
});

check('a stake that is not a positive number is refused and the old one kept', () => {
    const api = setup();
    api.setWinningsStake(50);
    assert.strictEqual(api.setWinningsStake(''), 50);
    assert.strictEqual(api.setWinningsStake('abc'), 50);
    assert.strictEqual(api.setWinningsStake(0), 50);
    assert.strictEqual(api.setWinningsStake(-5), 50);
    assert.strictEqual(api.getWinningsStake(), 50);
});

check('calculateWinnings defaults to the remembered stake', () => {
    const api = setup({
        weeks: { 1: WEEK_1 },
        picks: { 1: { Stephen: { rams_seahawks: { line: 'home' } } } }
    });
    api.setWinningsStake(110);
    const w = api.calculateWinnings(undefined, { firstWeek: 1, lastWeek: 1 }).Stephen.line;
    near(w.profit, 100);
    assert.strictEqual(w.staked, 110);
});

section('The vs Market bankroll');

check('the bankroll is $100 a week plus the Blazin\' 5 winnings at $20, from the same engine', () => {
    const api = setup({
        weeks: { 1: WEEK_1, 2: WEEK_2 },
        picks: {
            1: { Stephen: { rams_seahawks: { line: 'home', blazin: true }, bills_chiefs: { line: 'home', blazin: true } } }, // W L
            2: { Stephen: { lions_bears: { line: 'away', blazin: true } } }                                                 // W
        }
    });
    const weeks = api.CURRENT_NFL_WEEK;
    if (weeks < 2) return; // offseason: nothing to compare over
    const series = api.calculatePickerWeeklyBankroll('Stephen');
    assert.strictEqual(series.length, weeks, 'one row a week to the current one');
    near(series[0].bankroll, 100 + WIN - 20);
    assert.strictEqual(series[0].invested, 100);
    near(series[1].bankroll, 200 + 2 * WIN - 20);
    assert.strictEqual(series[1].invested, 200);
    const engine = api.calculateWinnings(20, { firstWeek: 1, lastWeek: weeks }).Stephen.blazin;
    near(series[series.length - 1].bankroll - series[series.length - 1].invested, engine.profit,
        'the bankroll\'s edge over what was deposited is the engine\'s profit');
});

check('a week with nothing scored still deposits its $100', () => {
    const api = setup({ weeks: { 1: WEEK_1 } });
    const weeks = api.CURRENT_NFL_WEEK;
    if (weeks < 1) return;
    const series = api.calculatePickerWeeklyBankroll('Stephen');
    series.forEach((row, i) => {
        assert.strictEqual(row.bankroll, (i + 1) * 100);
        assert.strictEqual(row.returnPct, 0);
    });
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
