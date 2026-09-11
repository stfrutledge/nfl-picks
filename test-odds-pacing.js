// Tests for the Odds API quota pacer in cloudflare-worker/nfl-picks-proxy.js.
//
// The Odds API free tier is 500 credits a month, billed per market per region -
// so a three-market call costs 3. Rather than pick a fixed cache window and hope,
// the worker spreads whatever is left over the days left in the month and sets
// the cache lifetime to match. Flush early in the month it refreshes often;
// nearly out it stretches to the reset.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// The worker is an ES module; everything above `export default` is plain
// top-level functions, so that part can be evaluated directly.
const WORKER = fs.readFileSync(
    path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const helpers = WORKER.slice(0, WORKER.indexOf('export default'));
const api = new Function(
    helpers + ';return { pacedCacheDuration, daysLeftInMonth, isGameDay, ' +
    'MIN_CACHE_HOURS, MAX_CACHE_HOURS, GAME_DAY_CACHE_HOURS, NON_GAME_DAY_CACHE_HOURS };')();

const hours = result => result.ms / 3600000;

// Wed 2 Sept 2026 is a quiet day; Sun 13 Sept is a game day.
const QUIET = new Date(Date.UTC(2026, 8, 2, 12));   // Wed 2 Sep
const GAME = new Date(Date.UTC(2026, 8, 13, 12));   // Sun 13 Sep

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('Sanity on the calendar helpers');

check('days left includes today', () => {
    assert.strictEqual(api.daysLeftInMonth(new Date(Date.UTC(2026, 8, 30, 12))), 1, 'last day');
    assert.strictEqual(api.daysLeftInMonth(new Date(Date.UTC(2026, 8, 1, 0))), 30, 'first of Sept');
    assert.strictEqual(api.daysLeftInMonth(new Date(Date.UTC(2026, 0, 31, 23))), 1, 'last of Jan');
});

check('the NFL week is Thu-Mon', () => {
    assert.strictEqual(api.isGameDay(GAME), true, 'Sunday');
    assert.strictEqual(api.isGameDay(QUIET), false, 'Wednesday');
});

section('Spending is paced against what is left');

check('a full balance early in the month refreshes often', () => {
    // Thu 3 Sep: 28 days left, 500 credits = 17.9 a day; at 3 a fetch that is
    // 6 fetches, so about every 4 hours. A game day, so no quiet multiplier.
    const r = api.pacedCacheDuration('500', 3, new Date(Date.UTC(2026, 8, 3, 12)));
    assert.ok(hours(r) > 3.5 && hours(r) < 5, `expected ~4h, got ${hours(r)}`);
});

check('a nearly empty balance stretches to the reset', () => {
    const r = api.pacedCacheDuration('20', 3, GAME);
    assert.strictEqual(hours(r), api.MAX_CACHE_HOURS, 'clamped to the ceiling');
});

check('cheaper calls buy more refreshes', () => {
    const three = api.pacedCacheDuration('300', 3, GAME);
    const one = api.pacedCacheDuration('300', 1, GAME);
    assert.ok(hours(one) < hours(three),
        'one market should refresh more often than three');
});

check('more days left means slower spending', () => {
    const early = api.pacedCacheDuration('300', 3, new Date(Date.UTC(2026, 8, 2, 12)));
    const late = api.pacedCacheDuration('300', 3, new Date(Date.UTC(2026, 8, 27, 12)));
    assert.ok(hours(late) < hours(early),
        'the same balance over fewer days can be spent faster');
});

check('the window never drops below the floor', () => {
    // Absurd balance: without a floor this would hammer the API.
    const r = api.pacedCacheDuration('999999', 1, GAME);
    assert.strictEqual(hours(r), api.MIN_CACHE_HOURS);
});

check('the window never exceeds the ceiling', () => {
    const r = api.pacedCacheDuration('1', 3, QUIET);
    assert.strictEqual(hours(r), api.MAX_CACHE_HOURS);
});

section('Quiet days give way to game days');

check('a quiet day caches longer than a game day', () => {
    const quiet = api.pacedCacheDuration('300', 3, QUIET);
    const game = api.pacedCacheDuration('300', 3, GAME);
    assert.ok(hours(quiet) > hours(game),
        'spare budget should be spent when games are on');
});

section('Degrading without the quota header');

check('a missing header falls back to the fixed windows', () => {
    assert.strictEqual(hours(api.pacedCacheDuration(null, 3, GAME)), api.GAME_DAY_CACHE_HOURS);
    assert.strictEqual(hours(api.pacedCacheDuration(null, 3, QUIET)), api.NON_GAME_DAY_CACHE_HOURS);
});

check('a junk header falls back rather than dividing by nonsense', () => {
    const r = api.pacedCacheDuration('not-a-number', 3, GAME);
    assert.strictEqual(hours(r), api.GAME_DAY_CACHE_HOURS);
    assert.match(r.reason, /no quota header/);
});

check('a zero balance does not divide by zero', () => {
    const r = api.pacedCacheDuration('0', 3, GAME);
    assert.strictEqual(hours(r), api.MAX_CACHE_HOURS);
    assert.match(r.reason, /exhausted/);
});

check('the reason string explains the decision', () => {
    const r = api.pacedCacheDuration('300', 3, GAME);
    assert.match(r.reason, /paced: 300 credits over \d+d at 3\/fetch/);
});

section('The month boundary needs no special case');

check('the reset speeds it back up on its own', () => {
    const exhausted = api.pacedCacheDuration('5', 3, new Date(Date.UTC(2026, 8, 30, 12)));
    const reset = api.pacedCacheDuration('500', 3, new Date(Date.UTC(2026, 9, 1, 12)));
    assert.strictEqual(hours(exhausted), api.MAX_CACHE_HOURS, 'crawling at month end');
    assert.ok(hours(reset) < 6, 'and straight back to normal after the reset');
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
