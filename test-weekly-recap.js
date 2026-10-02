// Tests for the Weekly Recap card on the Insights panel: which week it is
// about, what it says about that week, and the WhatsApp text it copies.
//
// The recap adds no scoring of its own - every number in it comes from the
// engine the standings run on - so these check that it picks the right week
// and the right people out of that engine's output, not the arithmetic.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixedClock } = require('./fixed-clock');

// A Wednesday in week 5 of 2026, so weeks 1-4 are all in the regular-season range.
const TEST_NOW = '2026-10-07T16:00:00Z';

function makeEnv(nodes) {
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
            getElementById: id => nodes[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async url => { throw new Error('fetch not stubbed: ' + url); },
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {}, confirm: () => false,
        addEventListener: () => {},
        matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;

    const snapshot = `
        const HISTORICAL_DATA_SEASON = 2026;
        const HISTORICAL_GAMES = {};
        const HISTORICAL_RESULTS = {};
        const HISTORICAL_PICKS = {};
    `;
    const parserSrc = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const exports = `;return ({
        PICKERS, COWHERD, NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        latestCompletedWeek, weeklyRecap, recapToText, renderWeeklyRecapCard, ordinal,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentSubcategory' in s) currentSubcategory = s.currentSubcategory;
        }
    });`;
    const fn = new Function(
        'window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date',
        parserSrc + '\n' + snapshot + '\n' + appSrc + exports
    );
    return fn(env.window, env.document, env.localStorage, env.navigator,
        (...a) => env.fetch(...a), env.console, env.performance, env.alert,
        env.confirm, env.addEventListener, env.matchMedia, fixedClock(TEST_NOW));
}

// Five games a week. Every home team is a 3-point favourite and wins 20-10,
// so a home line pick always wins and an away one always loses.
const TEAMS = [['Rams', 'Seahawks'], ['Bills', 'Chiefs'], ['Jets', 'Dolphins'], ['Bears', 'Packers'], ['Giants', 'Eagles']];
const KEYS = TEAMS.map(([a, h]) => `${a.toLowerCase()}_${h.toLowerCase()}`);

function week(finished = TEAMS.length) {
    return TEAMS.map(([away, home], i) => ({
        id: i + 1, away, home, spread: 3, favorite: 'home', day: 'Sunday', time: '1:00 PM',
        ...(i < finished ? { completed: true, status: 'STATUS_FINAL', awayScore: 10, homeScore: 20 } : {})
    }));
}

/** Five starred line picks from a string of sides: 'HHHAA'. */
function starred(sides) {
    const picks = {};
    [...sides].forEach((s, i) => { picks[KEYS[i]] = { line: s === 'H' ? 'home' : 'away', blazin: true }; });
    return picks;
}

// Week 1: Stephen 5-0, Sean 3-2, Dylan 2-3, Daniel 1-4, Jason 0-5, Cowherd 2-3.
// Stephen is alone on the Eagles (game 5) and right; Jason is alone on the
// Rams (game 1) and wrong.
const WEEK_1 = {
    Stephen: starred('HHHHH'), Sean: starred('HHHAA'), Dylan: starred('HHAAA'),
    Daniel: starred('HAAAA'), Jason: starred('AAAAA'), Cowherd: starred('HHAAA')
};
// Week 2: Stephen and Jason swap - Jason is the one alone on the Eagles now.
const WEEK_2 = { ...WEEK_1, Stephen: starred('AAAAA'), Jason: starred('HHHHH') };

function setup({ weeks = { 1: week(), 2: week() }, picks = { 1: WEEK_1, 2: WEEK_2 }, subcategory = 'blazin' } = {}) {
    const nodes = {};
    const node = { innerHTML: '', classList: { hidden: false, toggle(c, on) { if (c === 'hidden') this.hidden = on; } } };
    nodes['weekly-recap-card'] = node;
    const api = makeEnv(nodes);
    for (const [w, games] of Object.entries(weeks)) api.NFL_GAMES_BY_WEEK[w] = games;
    api.__setState({ allPicks: picks, currentSubcategory: subcategory });
    return { api, card: node };
}

const section = (recap, heading) => recap.sections.find(s => s.heading === heading)?.lines || [];

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function title(name) { console.log(`\n${name}`); }

title('Which week it is about');

check('the latest week with every game final', () => {
    const { api } = setup();
    assert.strictEqual(api.latestCompletedWeek(), 2);
});

check('a week with a game still to finish is skipped for the one before', () => {
    // Monday night not in yet: the recap stays on last week.
    const { api } = setup({ weeks: { 1: week(), 2: week(), 3: week(4) } });
    assert.strictEqual(api.latestCompletedWeek(), 2);
});

check('no finished week, no recap', () => {
    const { api, card } = setup({ weeks: { 1: week(4) } });
    assert.strictEqual(api.latestCompletedWeek(), null);
    api.renderWeeklyRecapCard();
    assert.strictEqual(card.classList.hidden, true);
});

title("The Blazin' 5 week");

check('top, bottom and the 5-0', () => {
    const { api } = setup();
    const lines = section(api.weeklyRecap(1), "Blazin' 5");
    assert.ok(lines.includes('Top: Stephen 5-0'), lines.join(' | '));
    assert.ok(lines.includes('Bottom: Jason 0-5'), lines.join(' | '));
    assert.ok(lines.includes('5-0: Stephen'), lines.join(' | '));
});

check('Cowherd, and who beat him', () => {
    const { api } = setup();
    const lines = section(api.weeklyRecap(1), "Blazin' 5");
    assert.ok(lines.includes('Cowherd 2-3, beaten by Sean, Stephen'), lines.join(' | '));
});

check('pickers sharing a place are named together', () => {
    const { api } = setup({ picks: { 1: { ...WEEK_1, Sean: starred('HHHHH') }, 2: WEEK_2 } });
    const lines = section(api.weeklyRecap(1), "Blazin' 5");
    assert.ok(lines.includes('Top: Sean, Stephen 5-0'), lines.join(' | '));
    assert.ok(lines.includes('5-0: Sean, Stephen'), lines.join(' | '));
});

check('everybody level is said as such', () => {
    const same = starred('HHHAA');
    const picks = { 1: Object.fromEntries(['Stephen', 'Sean', 'Dylan', 'Daniel', 'Jason'].map(p => [p, same])) };
    const { api } = setup({ weeks: { 1: week() }, picks });
    assert.deepStrictEqual(section(api.weeklyRecap(1), "Blazin' 5"), ['All level at 3-2']);
});

title('Lone wolves, money and the table');

check('a right lone wolf is listed, starred, and a wrong one is not', () => {
    const { api } = setup();
    // Games 4 and 5 both have Stephen alone on the home side in week 1, and
    // Jason in week 2. Jason alone on the Rams in week 1 lost, so is not here.
    assert.deepStrictEqual(section(api.weeklyRecap(1), 'Lone wolves who got it right'),
        ["Stephen on Packers -3 (Blazin' 5)", "Stephen on Eagles -3 (Blazin' 5)"]);
    assert.deepStrictEqual(section(api.weeklyRecap(2), 'Lone wolves who got it right'),
        ["Jason on Packers -3 (Blazin' 5)", "Jason on Eagles -3 (Blazin' 5)"], 'only the week asked about');
});

check("the week's biggest winner and loser at the stake", () => {
    const { api } = setup();
    const recap = api.weeklyRecap(1, { stake: 20 });
    assert.deepStrictEqual(section(recap, "Winnings ($20 a Blazin' 5 pick)"),
        ['Up most: Stephen +$90.91', 'Down most: Jason -$100.00']);
});

check('week 1 has no table moves to report', () => {
    const { api } = setup();
    assert.deepStrictEqual(section(api.weeklyRecap(1), "Blazin' 5 table"), []);
});

check('moves are against the table a week earlier', () => {
    // After week 1: Stephen 1st, Sean 2nd, Jason last. After week 2 Sean leads,
    // and Stephen and Jason share 2nd on 5-5.
    const { api } = setup();
    const lines = section(api.weeklyRecap(2), "Blazin' 5 table");
    assert.ok(lines.includes('Sean ▲1 to 1st'), lines.join(' | '));
    assert.ok(lines.includes('Stephen ▼1 to 2nd'), lines.join(' | '));
    assert.ok(lines.includes('Jason ▲4 to 2nd'), lines.join(' | '));
    assert.strictEqual(lines[0], 'Sean ▲1 to 1st', 'listed in table order');
});

title('Line and straight up');

check('line top and bottom come from the same week', () => {
    const { api } = setup();
    const lines = section(api.weeklyRecap(1), 'Line');
    assert.deepStrictEqual(lines, ['Top: Stephen 5-0', 'Bottom: Jason 0-5']);
});

check('a category nobody picked is left out', () => {
    const { api } = setup();
    assert.deepStrictEqual(section(api.weeklyRecap(1), 'Straight up'), []);
});

title('The card and the WhatsApp text');

check('the text is the same sections, with bold headings', () => {
    const { api } = setup();
    const text = api.recapToText(api.weeklyRecap(1, { stake: 20 }));
    const lines = text.split('\n');
    assert.strictEqual(lines[0], '*Week 1 Recap*');
    assert.ok(lines.includes("*Blazin' 5*"));
    assert.ok(lines.includes('Top: Stephen 5-0'));
    assert.ok(!/<[a-z]/i.test(text), 'no HTML in a chat message');
});

check('the card shows the last finished week with a copy button', () => {
    const { api, card } = setup();
    api.renderWeeklyRecapCard();
    assert.strictEqual(card.classList.hidden, false);
    assert.ok(card.innerHTML.includes('Week 2 Recap'));
    assert.ok(card.innerHTML.includes('copyWeeklyRecap()'));
});

check('the card is hidden on the Playoffs sub-tab', () => {
    const { api, card } = setup({ subcategory: 'playoffs' });
    api.renderWeeklyRecapCard();
    assert.strictEqual(card.classList.hidden, true);
});

check('ordinals', () => {
    const { api } = setup();
    assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(api.ordinal),
        ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
