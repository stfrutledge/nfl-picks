// Tests for the Live tab.
//
// It answers one question during a slate: where would the Blazin' 5 table
// stand if the afternoon ended right now? That is the ordinary season table
// with games in progress counted at the score they are standing at - the same
// engine, the same picks, one extra source of results. The things worth
// guarding are that the provisional scores really are provisional (a scheduled
// or finished game must never take one), that the move column compares against
// the settled table, and that the game list only ever holds starred games.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const PARSER = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8');

/** An element stub that remembers what it was given. */
function node(id, written) {
    return {
        set innerHTML(v) { written[id] = v; },
        get innerHTML() { return written[id] || ''; },
        set textContent(v) { written[id + ':text'] = v; },
        get textContent() { return written[id + ':text'] || ''; },
        style: {}, className: '', disabled: false, title: '', dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
        addEventListener() {}, closest: () => null,
        querySelector: () => node(id + ' thead', written),
        querySelectorAll: () => [], getAttribute: () => null, focus() {}, click() {}
    };
}

function makeAppEnv({ withDom = false } = {}) {
    const store = new Map();
    const written = {};
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
            getElementById: id => (withDom ? node(id, written) : null),
            querySelector: sel => (withDom ? node(sel, written) : null),
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }),
            head: { appendChild: () => {} },
            body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: { clipboard: null },
        fetch: async () => ({ ok: true, json: async () => ({ success: true }), text: async () => '{}' }),
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 },
        alert() {},
        confirm: () => true,
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
    const exports = `;
    const TEST_TOASTS = [];
    showToast = (m, t) => TEST_TOASTS.push({ message: m, type: t });
    return ({
        PICKERS, PICKERS_WITH_COWHERD, COWHERD, COWHERD_CATEGORY,
        isGameInProgress, liveProvisionalResult, blazinGamesForWeek,
        liveGameRank, calculateStatsForWeeks, regularSeasonWeekRange,
        standingsFromComputed, saveCowherdPicks, pickKey, describeLineForSide,
        renderLiveTab, renderActiveTab, refreshLiveViews,
        pickLineDiffers, signedLineForPick, renderBlazinGameBoxes,
        liveEntryFromEvent, liveCacheEntry,
        rankStandings, asIsPositionChange, formatPositionMove,
        renderAsIsStandings, CURRENT_NFL_WEEK,
        __setLiveScores: c => { liveScoresCache = c; },
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __setState: s => {
            if ('allPicks' in s) allPicks = s.allPicks;
            if ('currentWeek' in s) currentWeek = s.currentWeek;
            if ('currentPicker' in s) currentPicker = s.currentPicker;
            if ('currentCategory' in s) currentCategory = s.currentCategory;
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
    api.__written = written;
    return api;
}

const WEEK = 1;

/**
 * A game carrying its own ESPN status, which is the branch getLiveGameStatus
 * takes before it reaches the live cache.
 */
function game(id, away, home, extra = {}) {
    return {
        id, away, home, spread: 3, favorite: 'home', day: 'Sun', time: '1:00 PM',
        kickoff: '2099-01-01T18:00:00Z', ...extra
    };
}

const inProgress = (id, away, home, awayScore, homeScore, extra = {}) =>
    game(id, away, home, { status: 'STATUS_IN_PROGRESS', awayScore, homeScore, period: 3, clock: '5:00', ...extra });

const finalGame = (id, away, home, awayScore, homeScore, extra = {}) =>
    game(id, away, home, { status: 'STATUS_FINAL', completed: true, awayScore, homeScore, ...extra });

function setup({ games, picks = {}, results = null, withDom = false } = {}) {
    const api = makeAppEnv({ withDom });
    api.NFL_GAMES_BY_WEEK[WEEK] = games;
    if (results) api.NFL_RESULTS_BY_WEEK[WEEK] = results;
    api.__setState({ currentWeek: WEEK, currentPicker: 'Stephen', allPicks: { [WEEK]: picks } });
    return api;
}

const b5 = side => ({ line: side, winner: side, blazin: true });

/**
 * A scoreboard event shaped like ESPN's, trimmed to the fields read.
 * Team ids are strings there, which is what makes possession resolvable.
 */
function espnEvent({ away = 'Los Angeles Rams', home = 'Seattle Seahawks',
    awayScore = 0, homeScore = 0, state = 'STATUS_IN_PROGRESS',
    shortDetail = '11:37 - 3rd', period = 3, clock = '11:37',
    situation = null } = {}) {
    return {
        status: {
            period, displayClock: clock,
            type: { name: state, shortDetail, detail: shortDetail,
                completed: state === 'STATUS_FINAL' }
        },
        competitions: [{
            situation: situation || undefined,
            competitors: [
                { homeAway: 'home', score: String(homeScore), team: { id: '1', displayName: home } },
                { homeAway: 'away', score: String(awayScore), team: { id: '2', displayName: away } }
            ]
        }]
    };
}

let failures = 0, total = 0;
function check(name, fn) {
    total++;
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

section('A score only counts as a result while the game is being played');

check('a game in progress offers its current score', () => {
    const g = inProgress(1, 'Rams', 'Seahawks', 20, 24);
    const api = setup({ games: [g] });
    assert.strictEqual(api.isGameInProgress(g), true);
    assert.deepStrictEqual(api.liveProvisionalResult(g),
        { winner: 'home', awayScore: 20, homeScore: 24, provisional: true });
});

check('a scheduled game offers nothing', () => {
    const g = game(1, 'Rams', 'Seahawks');
    const api = setup({ games: [g] });
    assert.strictEqual(api.isGameInProgress(g), false);
    assert.strictEqual(api.liveProvisionalResult(g), null);
});

check('a finished game offers nothing - it has a real result', () => {
    const g = finalGame(1, 'Rams', 'Seahawks', 20, 24);
    const api = setup({ games: [g] });
    assert.strictEqual(api.liveProvisionalResult(g), null);
});

check('a tied game in progress names no winner', () => {
    const g = inProgress(1, 'Rams', 'Seahawks', 21, 21);
    const api = setup({ games: [g] });
    assert.strictEqual(api.liveProvisionalResult(g).winner, null);
});

section('The as-is table is the settled one with today counted in');

check('a game in progress is scored only when live is asked for', () => {
    // Seahawks -3 and up by 4: Stephen's home pick is covering as it stands.
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, picks: { Stephen: { rams_seahawks: b5('home') } } });

    const settled = api.standingsFromComputed(
        api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS), 'blazin');
    assert.strictEqual(settled.Stephen.wins, 0, 'settled table has nothing to score yet');

    const asIs = api.standingsFromComputed(
        api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS, { includeLive: true }), 'blazin');
    assert.strictEqual(asIs.Stephen.wins, 1, 'as-is counts it as it stands');
});

check('a finished game counts in both', () => {
    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    ['settled', 'live'].forEach(mode => {
        const rows = api.standingsFromComputed(
            api.calculateStatsForWeeks(WEEK, WEEK, api.PICKERS,
                { includeLive: mode === 'live' }), 'blazin');
        assert.strictEqual(rows.Stephen.wins, 1, mode);
    });
});

/** The stats renderAsIsStandings hands to the shared standings renderer. */
function asIsRows(api) {
    const { first, last } = api.regularSeasonWeekRange();
    return api.standingsFromComputed(
        api.calculateStatsForWeeks(first, last, api.PICKERS_WITH_COWHERD,
            { includeLive: true }), api.COWHERD_CATEGORY);
}

check('settled results and live ones land in the same table', () => {
    // Sean has a win in the books; Stephen is covering live. Both show.
    const games = [
        finalGame(1, 'Bills', 'Chiefs', 30, 20),
        inProgress(2, 'Rams', 'Seahawks', 20, 24)
    ];
    const api = setup({
        games,
        picks: {
            Sean: { bills_chiefs: b5('away') },
            Stephen: { rams_seahawks: b5('home'), bills_chiefs: { line: 'home', winner: 'home' } }
        },
        results: { 1: { awayScore: 30, homeScore: 20, winner: 'away' } }
    });

    const rows = asIsRows(api);
    assert.strictEqual(rows.Stephen.wins, 1, 'the live cover counts');
    assert.strictEqual(rows.Sean.wins, 1, 'the settled win counts');
    // Stephen's unstarred Bills pick is not a Blazin' 5 pick and must not
    // reach this table, which is the Blazin' 5 one.
    assert.strictEqual(rows.Stephen.totalPicks, 1, 'only the starred pick counts');
});

check('Cowherd reaches the table on a live cover, like anyone else', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games });
    // Seahawks -3 by his own number, and up by 4 as it stands.
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    assert.strictEqual(asIsRows(api).Cowherd.wins, 1);
});

check('and stays off it with nothing of his scored', () => {
    const games = [game(1, 'Rams', 'Seahawks')];   // not started
    const api = setup({ games });
    api.saveCowherdPicks(1, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    assert.ok(!asIsRows(api).Cowherd, 'an empty row reads as a bug, not a scoreline');
});

section('The game list holds starred games only');

check('an unstarred game is left out entirely', () => {
    const games = [game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs')];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home'), bills_chiefs: { line: 'away', winner: 'away' } } }
    });
    const entries = api.blazinGamesForWeek(WEEK);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].game.id, 1);
});

check('both sides of a game are collected, Cowherd among them', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home') }, Sean: { rams_seahawks: b5('away') } }
    });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);

    const entry = api.blazinGamesForWeek(WEEK)[0];
    assert.deepStrictEqual(entry.sides.home.map(p => p.picker), ['Stephen']);
    assert.deepStrictEqual(entry.sides.away.map(p => p.picker).sort(), ['Cowherd', 'Sean']);
    assert.strictEqual(entry.count, 3);
});

check('a locked pick is described at its own number, not the board’s', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.away[0];
    assert.strictEqual(api.describeLineForSide(games[0], 'away', pick), 'Rams +7');
    assert.strictEqual(api.describeLineForSide(games[0], 'away'), 'Rams +3', 'the board still says +3');
});

section('What the scoreboard feed is reduced to');

check('an event in progress keeps its clock, quarter and situation', () => {
    const { key, entry } = makeAppEnv().liveEntryFromEvent(espnEvent({
        awayScore: 10, homeScore: 24,
        situation: { possession: '1', downDistanceText: '3rd & 7 at TB 28',
            shortDownDistanceText: '3rd & 7', isRedZone: false }
    }));
    assert.strictEqual(key, 'Los Angeles Rams@Seattle Seahawks');
    assert.strictEqual(entry.statusDetail, '11:37 - 3rd', 'ESPN\u2019s own wording');
    assert.strictEqual(entry.awayScore, 10);
    assert.strictEqual(entry.homeScore, 24);
    assert.strictEqual(entry.possession, 'home', 'the id resolved to a side');
    assert.strictEqual(entry.downDistance, '3rd & 7 at TB 28');
    assert.strictEqual(entry.isRedZone, false);
});

check('possession resolves to the away side too', () => {
    const { entry } = makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '2', downDistanceText: '1st & 10 at SEA 41' }
    }));
    assert.strictEqual(entry.possession, 'away');
});

check('halftime has no situation at all', () => {
    const { entry } = makeAppEnv().liveEntryFromEvent(espnEvent({
        state: 'STATUS_HALFTIME', shortDetail: 'Halftime'
    }));
    assert.strictEqual(entry.statusDetail, 'Halftime');
    assert.strictEqual(entry.possession, null, 'nobody has the ball');
    assert.strictEqual(entry.downDistance, '', 'and there is no down to show');
});

check('the red zone is carried through', () => {
    const { entry } = makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '2', downDistanceText: '2nd & 4 at SEA 5', isRedZone: true }
    }));
    assert.strictEqual(entry.isRedZone, true);
});

section('The box shows the clock, the score and the situation');

/** Render one box with `entry` standing in for the live-scores cache. */
function boxFor(entry, { picks = { Stephen: { rams_seahawks: b5('home') } } } = {}) {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games, picks, withDom: true });
    api.__setLiveScores({ 'Los Angeles Rams@Seattle Seahawks': entry });
    api.renderBlazinGameBoxes();
    return api.__written['live-games-list'] || '';
}

check('a game in progress shows the clock, quarter and down', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        awayScore: 10, homeScore: 24,
        situation: { possession: '1', downDistanceText: '3rd & 7 at TB 28' }
    })).entry);
    assert.ok(html.includes('11:37 - 3rd'), 'the clock and quarter are on the box');
    assert.ok(html.includes('live-score-num'), 'and the score has its own row');
    assert.ok(html.includes('3rd &amp; 7 at TB 28') || html.includes('3rd & 7 at TB 28'),
        'and the down and distance');
    assert.ok(!html.includes(' ball</span>'), 'possession is not spelled out');
});

check('a side with nobody on it is left empty', () => {
    // Only the home side is picked, so the away side carries its crest and
    // line and nothing else - no placeholder word.
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '1', downDistanceText: '3rd & 7 at SEA 28' }
    })).entry);
    assert.ok(!html.includes('nobody'), 'no placeholder for an unpicked side');
    assert.ok(html.includes('live-side empty'), 'it is still marked as empty');
});

check('the side rows name the team, where the score row shows the crest', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '1', downDistanceText: '3rd & 7 at SEA 28' }
    })).entry);
    assert.ok(!html.includes('live-side-logo'), 'no crest on the side rows');
    const names = html.match(/class="live-team-name"/g) || [];
    assert.strictEqual(names.length, 2, 'one name per side row');
    assert.ok(html.includes('live-team-line'), 'with the line beside it');
    // The score row above is the one that carries crests.
    assert.strictEqual((html.match(/class="live-score-logo"/g) || []).length, 2);
});

check('the score row carries crests, not names', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        awayScore: 10, homeScore: 24,
        situation: { possession: '1', downDistanceText: '3rd & 7 at SEA 28' }
    })).entry);
    const logos = html.match(/class="live-score-logo"/g) || [];
    assert.strictEqual(logos.length, 2, 'one crest per side');
    assert.ok(html.includes('alt="Rams"') && html.includes('alt="Seahawks"'),
        'each names its team for a reader who cannot see it');
    assert.ok(html.includes('handleLogoError'), 'and falls back to the initials badge');
    // The header still spells the matchup out.
    assert.ok(html.includes('Rams @ Seahawks'), 'the header keeps the names');
});

check('the ball sits under the crest of whoever has it', () => {
    // Home has it: the football goes in the home slot and the away slot stays
    // empty, rather than being left out, so nothing shifts as it changes hands.
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '1', downDistanceText: '3rd & 7 at SEA 28' }
    })).entry);
    const slots = html.match(/<span class="live-possession-icon"[^>]*>[^<]*</g) || [];
    assert.strictEqual(slots.length, 2, 'both sides carry a slot');
    const withBall = slots.filter(s => s.includes('&#127944;'));
    assert.strictEqual(withBall.length, 1, 'exactly one of them has the ball');
    assert.ok(withBall[0].includes('Seahawks have the ball'), 'and it is the home side');
});

check('the away side can have it too', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '2', downDistanceText: '1st & 10 at SEA 41' }
    })).entry);
    const withBall = (html.match(/<span class="live-possession-icon"[^>]*>&#127944;</g) || []);
    assert.strictEqual(withBall.length, 1);
    assert.ok(withBall[0].includes('Rams have the ball'));
});

check('nobody holds it between drives', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        state: 'STATUS_HALFTIME', shortDetail: 'Halftime', awayScore: 0, homeScore: 7
    })).entry);
    assert.ok(!html.includes('&#127944;'), 'no football while nobody has the ball');
});

check('halftime drops the situation row rather than showing a stale down', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        state: 'STATUS_HALFTIME', shortDetail: 'Halftime', awayScore: 0, homeScore: 7
    })).entry);
    assert.ok(html.includes('Halftime'), 'the state is still named');
    assert.ok(html.includes('live-score-num'), 'and the score still shows');
    assert.ok(!html.includes('live-situation'), 'but no down, distance or possession');
});

check('the red zone is not marked on the box', () => {
    // Still captured off the feed, deliberately not drawn: the tinted row it
    // used to get was louder than anything else on the tab.
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        situation: { possession: '2', downDistanceText: '2nd & 4 at SEA 5', isRedZone: true }
    })).entry);
    assert.ok(!html.includes('redzone'), 'no red-zone styling or label');
    assert.ok(html.includes('2nd &amp; 4 at SEA 5') || html.includes('2nd & 4 at SEA 5'),
        'the down still shows');
});

check('a game still to come has no score row and no situation', () => {
    const html = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        state: 'STATUS_SCHEDULED', shortDetail: '9/13 - 4:25 PM EDT', period: 0, clock: '0:00'
    })).entry);
    assert.ok(!html.includes('live-score-num'), 'nothing to score yet');
    assert.ok(!html.includes('live-situation'), 'and nothing happening');
    // The app's own kickoff time, in the reader's zone, not ESPN's US string.
    assert.ok(html.includes('1:00 PM'), 'the kickoff time is shown instead');
});

section('A line is printed by a name only where it differs');

// "Locked" is the wrong test: a locked pick usually locked at the number that
// is still up, and most of Cowherd's match the book too. Repeating the number
// already on the row next to every name is noise.

check('a pick at the board\u2019s own line differs from nothing', () => {
    const games = [game(1, 'Rams', 'Seahawks')];   // home -3
    const api = setup({ games });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.home[0];
    assert.strictEqual(api.pickLineDiffers(games[0], pick), false);
});

check('a pick at his own number does', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.away[0];
    assert.strictEqual(api.pickLineDiffers(games[0], pick), true);
    assert.strictEqual(api.signedLineForPick(games[0], pick, 'away'), '+7');
});

check('the same number on the other side of the game differs', () => {
    // Locked with the Rams laying 3 while the board has the Seahawks laying 3:
    // same magnitude, opposite favourite, and not the same line at all.
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: -3 }]);
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.away[0];
    assert.strictEqual(api.pickLineDiffers(games[0], pick), true);
    assert.strictEqual(api.signedLineForPick(games[0], pick, 'away'), '-3');
});

check('a riding pick never prints a line', () => {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games, picks: { Stephen: { rams_seahawks: b5('home') } } });
    const { pick } = api.blazinGamesForWeek(WEEK)[0].sides.home[0];
    assert.strictEqual(api.pickLineDiffers(games[0], pick), false,
        'it is graded at the board line, which is the one on the row');
});

check('the rendered chips follow the same rule', () => {
    const games = [game(1, 'Rams', 'Seahawks'), game(2, 'Bills', 'Chiefs')];
    const api = setup({ games, withDom: true });
    api.saveCowherdPicks(WEEK, [
        { key: 'rams_seahawks', side: 'away', spread: 7 },     // his own number
        { key: 'bills_chiefs', side: 'home', spread: -3 }      // the board's
    ]);
    api.renderBlazinGameBoxes();
    const html = api.__written['live-games-list'] || '';
    assert.ok(html.includes('Cowherd <em>+7</em>'), 'his own number is printed');
    assert.ok(!html.includes('Cowherd <em>-3</em>'), 'the board\u2019s is not repeated');
});

section('The as-is table carries a position change, and little else');

check('the column set is the record and the move', () => {
    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games, withDom: true,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    api.renderAsIsStandings();
    const head = api.__written['#as-is-standings-table thead'] || '';
    ['Picker', 'Win', 'Loss', 'Push', '%', 'Total', 'Move'].forEach(col =>
        assert.ok(head.includes(`>${col}<`), `${col} is a column`));
    ['Last 3-Wk', 'Best Week', 'Year Chg'].forEach(col =>
        assert.ok(!head.includes(col), `${col} is not`));
});

check('ties share a place', () => {
    const api = makeAppEnv();
    const places = api.rankStandings({
        A: { name: 'A', percentage: 75 },
        B: { name: 'B', percentage: 50 },
        C: { name: 'C', percentage: 50 },
        D: { name: 'D', percentage: 25 }
    });
    assert.deepStrictEqual(places, { A: 1, B: 2, C: 2, D: 4 },
        'two on 50% share second, and the next is fourth');
});

check('a picker with nothing scored does not rank above one who has lost', () => {
    const api = makeAppEnv();
    const places = api.rankStandings({
        A: { name: 'A', percentage: 0 },
        B: { name: 'B', percentage: null }
    });
    assert.strictEqual(places.A, places.B, 'both read as nothing to show');
});

check('week 1 has no last week, so nothing moves', () => {
    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    assert.deepStrictEqual(api.asIsPositionChange(), {},
        'no week to compare against');
});

check('a later week moves against where last week finished', () => {
    // Week 1: Sean covers, Stephen does not. Sean leads.
    // Week 2: Stephen covers twice, Sean misses. Stephen goes past him.
    const api = makeAppEnv();
    api.NFL_GAMES_BY_WEEK[1] = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    api.NFL_GAMES_BY_WEEK[2] = [
        finalGame(2, 'Bills', 'Chiefs', 30, 20),
        finalGame(3, 'Jets', 'Dolphins', 28, 14)
    ];
    api.NFL_RESULTS_BY_WEEK[1] = { 1: { awayScore: 20, homeScore: 24, winner: 'home' } };
    api.NFL_RESULTS_BY_WEEK[2] = {
        2: { awayScore: 30, homeScore: 20, winner: 'away' },
        3: { awayScore: 28, homeScore: 14, winner: 'away' }
    };
    api.__setState({
        currentWeek: 2, currentPicker: 'Stephen',
        allPicks: {
            1: {
                Sean: { rams_seahawks: b5('home') },        // covers
                Stephen: { rams_seahawks: b5('away') }      // does not
            },
            2: {
                Sean: { bills_chiefs: b5('home') },         // misses
                Stephen: { bills_chiefs: b5('away'), jets_dolphins: b5('away') }
            }
        }
    });

    const after1 = api.rankStandings(api.standingsFromComputed(
        api.calculateStatsForWeeks(1, 1, api.PICKERS_WITH_COWHERD), api.COWHERD_CATEGORY));
    assert.strictEqual(after1.Sean, 1, 'Sean led after week 1');
    assert.ok(after1.Stephen > 1, 'and Stephen did not');

    const moves = api.asIsPositionChange({ first: 1, last: 2 });
    assert.ok(moves.Stephen > 0, `Stephen climbed (got ${moves.Stephen})`);
    assert.ok(moves.Sean < 0, `Sean dropped (got ${moves.Sean})`);
});

check('standing still is no move at all', () => {
    const api = makeAppEnv();
    api.NFL_GAMES_BY_WEEK[1] = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    api.NFL_GAMES_BY_WEEK[2] = [finalGame(2, 'Bills', 'Chiefs', 30, 20)];
    api.NFL_RESULTS_BY_WEEK[1] = { 1: { awayScore: 20, homeScore: 24, winner: 'home' } };
    api.NFL_RESULTS_BY_WEEK[2] = { 2: { awayScore: 30, homeScore: 20, winner: 'away' } };
    api.__setState({
        currentWeek: 2, currentPicker: 'Stephen',
        allPicks: {
            1: { Sean: { rams_seahawks: b5('home') } },
            2: { Sean: { bills_chiefs: b5('away') } }     // covers again
        }
    });
    const moves = api.asIsPositionChange({ first: 1, last: 2 });
    assert.strictEqual(moves.Sean, 0, 'still top, so no move');
});

check('a move is drawn only when there is one', () => {
    const api = makeAppEnv();
    assert.ok(api.formatPositionMove(2).includes('move-up'), 'a climb');
    assert.ok(api.formatPositionMove(-1).includes('move-down'), 'a drop');
    assert.ok(api.formatPositionMove(0).includes('move-none'), 'level');
    assert.ok(api.formatPositionMove(null).includes('move-none'), 'nothing to compare');
});

section('The tab is redrawn when its data arrives');

// The backup load finishes long after the first paint. Every view that
// renders from picks has to be redrawn then, and the Live tab was the one
// left out: it drew once on the way in and kept what it had, so picks that
// came back from the sheet a moment later never appeared on it.

check('renderActiveTab draws the Live tab when it is the one showing', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, withDom: true });
    api.__setState({ currentCategory: 'live' });
    // Picks arrive from the backup after the tab has already been drawn.
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);

    api.renderActiveTab();
    const boxes = api.__written['live-games-list'] || '';
    assert.ok(boxes.includes('live-game-box'), 'the games were drawn');
    assert.ok(boxes.includes('Cowherd'), 'with the picks that had just landed');
});

check('and leaves it alone when another tab is showing', () => {
    const games = [inProgress(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({ games, withDom: true });
    api.__setState({ currentCategory: 'make-picks' });
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'home', spread: -3 }]);

    api.renderActiveTab();
    assert.ok(!api.__written['live-games-list'], 'no work done for a hidden tab');
});

section('In progress first, then finished, then still to come');

check('the three states rank in that order', () => {
    const api = setup({ games: [] });
    const results = { 3: { awayScore: 20, homeScore: 24, winner: 'home' } };
    assert.strictEqual(api.liveGameRank(inProgress(1, 'Rams', 'Seahawks', 7, 3), {}), 0);
    assert.strictEqual(api.liveGameRank(finalGame(3, 'Jets', 'Dolphins', 20, 24), results), 1);
    assert.strictEqual(api.liveGameRank(game(2, 'Bills', 'Chiefs'), {}), 2);
});

if (failures > 0) {
    console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
    process.exit(1);
}
console.log(`\nALL ${total} CHECKS PASSED\n`);
process.exit(0);
