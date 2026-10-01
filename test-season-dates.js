// Tests for which NFL week a date falls in.
//
// The playoff weeks used to be pinned to the 2025-26 calendar, which was a
// week early for 2026: Labor Day fell a week later, so from January 10 2027
// the app would have put week 18's Sunday in week 19 and locked the games
// before kickoff. These pin both real calendars, and the November night the
// clocks go back, when the week used to turn during Monday Night Football.
//
// Run with: node test-season-dates.js
process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// The date functions only, cut from app.js between getLaborDay and the
// constant that calls them, so nothing else in the app needs a stub.
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const from = APP.indexOf('function getLaborDay');
const to = APP.indexOf('const CURRENT_NFL_WEEK = calculateCurrentNFLWeek();');
assert.ok(from > 0 && to > from, 'date functions not found in app.js');
const api = new Function('TOTAL_WEEKS', 'CURRENT_SEASON',
    APP.slice(from, to) + '\nreturn { getSeasonDates, calculateCurrentNFLWeek };')(18, 2026);

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

/** Local time, month 1-based. */
const at = (y, m, d, h = 13, min = 0) => new Date(y, m - 1, d, h, min);
const weekOn = (season, ...date) => api.calculateCurrentNFLWeek(at(...date), season);
const ymd = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

for (const [season, cal] of Object.entries({
    // Real schedules. 2025: Super Bowl LX, Feb 8 2026.
    2025: {
        start: '2025-9-2', week1: [2025, 9, 4], week18Sunday: [2026, 1, 4],
        wildCard: [2026, 1, 10], divisional: [2026, 1, 17],
        conference: [2026, 1, 25], superBowl: [2026, 2, 8]
    },
    // 2026: Super Bowl LXI, Feb 14 2027.
    2026: {
        start: '2026-9-8', week1: [2026, 9, 10], week18Sunday: [2027, 1, 10],
        wildCard: [2027, 1, 16], divisional: [2027, 1, 24],
        conference: [2027, 1, 31], superBowl: [2027, 2, 14]
    }
})) {
    section(`${season} season`);
    const s = Number(season);

    check('starts the Tuesday after Labor Day', () => {
        assert.strictEqual(ymd(api.getSeasonDates(s).seasonStart), cal.start);
    });
    check('the week 1 opener is week 1', () => assert.strictEqual(weekOn(s, ...cal.week1), 1));
    check('the week 18 Sunday is week 18', () => assert.strictEqual(weekOn(s, ...cal.week18Sunday), 18));
    check('Wild Card weekend is week 19', () => assert.strictEqual(weekOn(s, ...cal.wildCard), 19));
    check('Divisional weekend is week 20', () => assert.strictEqual(weekOn(s, ...cal.divisional), 20));
    check('Conference Sunday is week 21', () => assert.strictEqual(weekOn(s, ...cal.conference), 21));
    check('the Super Bowl is week 22', () => assert.strictEqual(weekOn(s, ...cal.superBowl), 22));
    check('and so is the bye week before it', () => {
        const sb = at(...cal.superBowl);
        assert.strictEqual(api.calculateCurrentNFLWeek(new Date(sb - 10 * 864e5), s), 22);
    });
    check('and everything after, until the next season', () => {
        assert.strictEqual(weekOn(s, s + 1, 6, 30), 22);
    });
}

section('Edges');

check('before the season is week 1', () => assert.strictEqual(weekOn(2026, 2026, 8, 20), 1));

check('a week turns at midnight going into Tuesday', () => {
    // Week 4 of 2026 starts Tuesday Sept 29.
    assert.strictEqual(weekOn(2026, 2026, 9, 28, 23, 59), 3);
    assert.strictEqual(weekOn(2026, 2026, 9, 29, 0, 0), 4);
});

check('after the clocks go back, Monday Night Football stays in its week', () => {
    // DST ends Sunday Nov 1 2026; week 9 starts Tuesday Nov 3.
    assert.strictEqual(weekOn(2026, 2026, 11, 2, 23, 30), 8);
    assert.strictEqual(weekOn(2026, 2026, 11, 3, 0, 0), 9);
});

console.log(`\n${failures ? `${failures} of ${total} CHECKS FAILED` : `all ${total} checks passed`}`);
process.exit(failures ? 1 : 0);
