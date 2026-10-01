// A Date whose "now" is fixed, for handing to app.js in place of the real one.
//
// app.js reads the clock as it loads - CURRENT_SEASON, CURRENT_NFL_WEEK and
// the Live tab's window all come off `new Date()` - so a test that ran in its
// own week would fail every week after. Pass the result as `Date` into the
// `new Function` that runs the app. Only "now" is pinned: a Date built from
// arguments, Date.parse and Date.UTC behave as normal.
function fixedClock(iso) {
    const NOW = Date.parse(iso);
    if (Number.isNaN(NOW)) throw new Error(`fixedClock: bad date ${iso}`);
    return class FixedDate extends Date {
        constructor(...args) {
            if (args.length === 0) super(NOW);
            else super(...args);
        }
        static now() { return NOW; }
    };
}

module.exports = { fixedClock };
