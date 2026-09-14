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
    // Stable per id: a test that looks an element up twice has to see the
    // same one, or nothing set on it is observable.
    const nodes = new Map();
    const nodeFor = id => {
        if (!nodes.has(id)) nodes.set(id, node(id, written));
        return nodes.get(id);
    };
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
            getElementById: id => (withDom ? nodeFor(id) : null),
            querySelector: sel => (withDom ? nodeFor(sel) : null),
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
        renderLiveTab, renderActiveTab, getLiveGameStatus, renderDashboard,
        liveRefreshDelay, anyGameInProgress, shouldPollLiveScores,
        liveWindow, isLiveWindowOpen, updateLiveTabVisibility,
        LIVE_WINDOW_BUFFER_MS, LIVE_WINDOW_GAME_MS,
        LIVE_REFRESH_PLAYING_MS, LIVE_REFRESH_WAITING_MS,
        pickLineDiffers, signedLineForPick, renderBlazinGameBoxes,
        liveEntryFromEvent, liveCacheEntry,
        rankStandings, asIsPositionChange, formatPositionMove,
        renderAsIsStandings, CURRENT_NFL_WEEK,
        toggleAsIsDetail, asIsPickDetail, asIsExpanded,
        __setLiveScores: c => { liveScoresCache = c; },
        NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK,
        __category: () => currentCategory,
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
    api.__node = nodeFor;
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

/** Every box drawn, whichever of the three sections it landed in. */
function allBoxes(api) {
    return ['live-games-list', 'live-completed-list', 'live-upcoming-list']
        .map(id => api.__written[id] || '').join('');
}

/** Render one box with `entry` standing in for the live-scores cache. */
function boxFor(entry, { picks = { Stephen: { rams_seahawks: b5('home') } } } = {}) {
    const games = [game(1, 'Rams', 'Seahawks')];
    const api = setup({ games, picks, withDom: true });
    api.__setLiveScores({ 'Los Angeles Rams@Seattle Seahawks': entry });
    api.renderBlazinGameBoxes();
    return allBoxes(api);
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

check('no side is marked as covering, in any state', () => {
    // The box shows the score, the situation and who is on each side. Which
    // side is ahead of the line is left to be read off the score.
    const live = boxFor(makeAppEnv().liveEntryFromEvent(espnEvent({
        awayScore: 20, homeScore: 24,
        situation: { possession: '1', downDistanceText: '3rd & 7 at SEA 28' }
    })).entry);
    assert.ok(!live.includes('covering'), 'not while it is being played');

    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games, withDom: true,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    api.renderBlazinGameBoxes();
    const done = api.__written['live-completed-list'] || '';
    assert.ok(!done.includes('covering'), 'and not once it is over');
    assert.ok(done.includes('live-score-num'), 'the score is still there');
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
    const html = allBoxes(api);
    assert.ok(html.includes('Cowherd <em>+7</em>'), 'his own number is printed');
    assert.ok(!html.includes('Cowherd <em>-3</em>'), 'the board\u2019s is not repeated');
});

section('Opening a picker shows their week');

/** A week with one settled pick, one still being played, one not started. */
function weekOfPicks() {
    return {
        games: [
            finalGame(1, 'Rams', 'Seahawks', 20, 24),
            inProgress(2, 'Bills', 'Chiefs', 30, 20),
            game(3, 'Jets', 'Dolphins')
        ],
        withDom: true,
        picks: {
            Stephen: {
                rams_seahawks: b5('home'),      // covered, settled
                bills_chiefs: b5('away'),       // ahead, still playing
                jets_dolphins: b5('home')       // not started
            },
            Sean: { rams_seahawks: b5('away') }
        },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    };
}

check('a row is closed until it is opened', () => {
    const api = setup(weekOfPicks());
    api.asIsExpanded.clear();
    api.renderAsIsStandings();
    const body = api.__written['as-is-standings-body'] || '';
    assert.ok(!body.includes('team-details-row'), 'no detail until asked for');
    assert.ok(body.includes('toggleAsIsDetail('), 'but the name is clickable');
    assert.ok(!body.includes('as-is-caret'), 'and no arrow on it');
});

check('opening one shows that picker\u2019s picks for the week', () => {
    const api = setup(weekOfPicks());
    api.asIsExpanded.clear();
    api.toggleAsIsDetail('Stephen');
    const body = api.__written['as-is-standings-body'] || '';

    assert.ok(body.includes('team-details-row'), 'the row opened');
    assert.ok(body.includes('Rams 20 @ Seahawks 24'), 'his settled pick, with its score');
    assert.ok(body.includes('Bills 30 @ Chiefs 20'), 'his live one');
    assert.ok(body.includes('Jets @ Dolphins'), 'and the one still to come, without one');
});

check('and nobody else\u2019s', () => {
    const api = setup(weekOfPicks());
    api.asIsExpanded.clear();
    api.toggleAsIsDetail('Sean');
    const detail = (api.__written['as-is-standings-body'] || '')
        .split('team-details-row')[1] || '';
    assert.ok(detail.includes('Rams 20 @ Seahawks 24'), 'Sean took that game');
    assert.ok(!detail.includes('Chiefs'), 'he did not take that one');
});

check('each pick says where it stands', () => {
    const api = setup(weekOfPicks());
    const rows = api.asIsPickDetail('Stephen').split('game-detail-row').slice(1);
    assert.strictEqual(rows.length, 3, 'one row per starred pick');

    // Seahawks -3 at home, won by 4: settled win, and said so outright.
    const settled = rows.find(r => r.includes('Seahawks 24'));
    assert.ok(settled.includes('outcome-win'), 'the settled one is a win');
    assert.ok(!settled.includes('outcome-provisional'), 'and not provisional');
    assert.ok(settled.includes('>WIN<'), 'labelled like the Team Records rows');
    assert.ok(settled.includes('Final'), 'with its state in the first slot');

    // Bills +3 away and up by 10 with the game still on: a win as it stands,
    // marked provisional rather than claimed outright.
    const live = rows.find(r => r.includes('Chiefs 20'));
    assert.ok(live.includes('outcome-win') && live.includes('outcome-provisional'),
        'the live one is a win as it stands');

    // Nothing to say about a game that has not started.
    const soon = rows.find(r => r.includes('Jets @ Dolphins'));
    assert.ok(soon.includes('outcome-pending'), 'the unplayed one is pending');
    assert.ok(!soon.includes('outcome-provisional'), 'and not called provisional');
});

check('the detail is shaped like the Team Records one', () => {
    // Same row class, same slots, same outcome classes - the two expansions
    // are one thing, not two takes on it.
    const api = setup(weekOfPicks());
    const html = api.asIsPickDetail('Stephen');
    ['game-detail-row', 'game-week', 'game-matchup', 'game-spread',
     'game-picked', 'game-outcome'].forEach(cls =>
        assert.ok(html.includes(cls), cls + ' is used'));
    assert.ok(html.includes('Picked: '), 'including the picked-team slot');
});

check('a pick is shown at the line it is graded against', () => {
    const api = setup(weekOfPicks());
    api.saveCowherdPicks(WEEK, [{ key: 'rams_seahawks', side: 'away', spread: 7 }]);
    const html = api.asIsPickDetail('Cowherd');
    assert.ok(html.includes('Rams +7'), 'his own number, not the board\u2019s +3');
});

check('a picker with nothing starred this week says so', () => {
    const api = setup(weekOfPicks());
    assert.ok(api.asIsPickDetail('Daniel').includes('No Blazin'), 'nothing to show');
});

check('an open row survives the thirty-second redraw', () => {
    // The table is rebuilt on every score poll. Holding the open rows outside
    // the render is what stops one snapping shut while it is being read.
    const api = setup(weekOfPicks());
    api.asIsExpanded.clear();
    api.toggleAsIsDetail('Stephen');
    api.renderAsIsStandings();          // as a poll would
    assert.ok((api.__written['as-is-standings-body'] || '').includes('team-details-row'),
        'still open');
});

check('clicking it again closes it', () => {
    const api = setup(weekOfPicks());
    api.asIsExpanded.clear();
    api.toggleAsIsDetail('Stephen');
    api.toggleAsIsDetail('Stephen');
    assert.ok(!(api.__written['as-is-standings-body'] || '').includes('team-details-row'));
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

section('The Live tab is only up while the games are on');

const HOUR = 60 * 60 * 1000;

/** A slate kicking off at 18:00 UTC, the last game at 01:20 the next day. */
function slate() {
    const first = Date.parse('2026-09-13T18:00:00Z');
    const last = Date.parse('2026-09-14T01:20:00Z');
    const games = [
        { ...game(1, 'Rams', 'Seahawks'), kickoff: new Date(first).toISOString() },
        { ...game(2, 'Bills', 'Chiefs'), kickoff: new Date(last).toISOString() }
    ];
    return { games, first, last };
}

check('the window opens an hour before the first kickoff', () => {
    const { games, first } = slate();
    const api = setup({ games });
    const w = api.liveWindow(WEEK);
    assert.strictEqual(w.opens, first - HOUR);
    assert.strictEqual(api.LIVE_WINDOW_BUFFER_MS, HOUR, 'an hour, either side');
});

check('and closes an hour after the last game should have ended', () => {
    const { games, last } = slate();
    const api = setup({ games });
    assert.strictEqual(api.liveWindow(WEEK).closes,
        last + api.LIVE_WINDOW_GAME_MS + HOUR);
});

check('it is down well before the first game', () => {
    const { games, first } = slate();
    const api = setup({ games });
    assert.strictEqual(api.isLiveWindowOpen(first - 3 * HOUR, WEEK), false);
});

check('up from the hour before it', () => {
    const { games, first } = slate();
    const api = setup({ games });
    assert.strictEqual(api.isLiveWindowOpen(first - HOUR, WEEK), true, 'on the hour');
    assert.strictEqual(api.isLiveWindowOpen(first - HOUR - 1, WEEK), false, 'a moment before');
});

check('up through the afternoon', () => {
    const { games, first } = slate();
    const api = setup({ games });
    assert.strictEqual(api.isLiveWindowOpen(first + 2 * HOUR, WEEK), true);
});

check('and down again the next morning', () => {
    const { games, last } = slate();
    const api = setup({ games });
    const closes = last + api.LIVE_WINDOW_GAME_MS + HOUR;
    assert.strictEqual(api.isLiveWindowOpen(closes, WEEK), true, 'on the hour');
    assert.strictEqual(api.isLiveWindowOpen(closes + 1, WEEK), false, 'a moment after');
    assert.strictEqual(api.isLiveWindowOpen(closes + 24 * HOUR, WEEK), false, 'and the day after');
});

check('a game running long keeps it up whatever the clock says', () => {
    // The far edge is guesswork - nothing records when a game actually ended.
    // One still being played is the case that guess would get wrong.
    const { games, last } = slate();
    const stillOn = [...games, inProgress(3, 'Jets', 'Dolphins', 10, 7)];
    const api = setup({ games: stillOn });
    const wellPast = last + 12 * HOUR;
    assert.strictEqual(api.isLiveWindowOpen(wellPast, WEEK), true);
});

check('the tab itself comes down with the window', () => {
    const { games, first } = slate();
    const api = setup({ games, withDom: true });
    const tab = api.__node('.tab[data-category="live"]');

    api.__setState({ currentCategory: 'standings' });
    api.updateLiveTabVisibility();
    assert.strictEqual(tab.style.display, 'none', 'down outside the window');
});

check('and nobody is left standing on a tab that is not there', () => {
    const { games } = slate();
    const api = setup({ games, withDom: true });
    api.__setState({ currentCategory: 'live' });
    api.updateLiveTabVisibility();
    assert.notStrictEqual(api.__category(), 'live', 'moved off it');
});

check('a week with no schedule yet leaves it up', () => {
    // Unknown is not the same as closed, and hiding the tab during a slate is
    // the worse way to be wrong.
    const api = setup({ games: [] });
    assert.strictEqual(api.liveWindow(WEEK), null, 'nothing to read');
    assert.strictEqual(api.isLiveWindowOpen(Date.now(), WEEK), true);
});

section('How often the scores are fetched');

check('half a minute while a game is being played', () => {
    const api = makeAppEnv();
    api.__setLiveScores({
        a: api.liveEntryFromEvent(espnEvent({ state: 'STATUS_IN_PROGRESS' })).entry
    });
    assert.strictEqual(api.anyGameInProgress(), true);
    assert.strictEqual(api.liveRefreshDelay(), api.LIVE_REFRESH_PLAYING_MS);
    assert.strictEqual(api.LIVE_REFRESH_PLAYING_MS, 30000);
});

check('halftime still counts as being played', () => {
    const api = makeAppEnv();
    api.__setLiveScores({
        a: api.liveEntryFromEvent(espnEvent({
            state: 'STATUS_HALFTIME', shortDetail: 'Halftime'
        })).entry
    });
    assert.strictEqual(api.liveRefreshDelay(), api.LIVE_REFRESH_PLAYING_MS);
});

check('slower while the only thing to catch is a kickoff', () => {
    // shouldPollLiveScores stays true on scheduled games, which is most of the
    // week - polling that every 30s would be for nothing.
    const api = makeAppEnv();
    api.__setLiveScores({
        a: api.liveEntryFromEvent(espnEvent({
            state: 'STATUS_SCHEDULED', shortDetail: '9/13 - 4:25 PM EDT'
        })).entry
    });
    assert.strictEqual(api.shouldPollLiveScores(), true, 'still worth polling');
    assert.strictEqual(api.anyGameInProgress(), false);
    assert.strictEqual(api.liveRefreshDelay(), api.LIVE_REFRESH_WAITING_MS);
});

check('one game in progress is enough to speed everything up', () => {
    const api = makeAppEnv();
    api.__setLiveScores({
        a: api.liveEntryFromEvent(espnEvent({ state: 'STATUS_FINAL', shortDetail: 'Final' })).entry,
        b: api.liveEntryFromEvent(espnEvent({ state: 'STATUS_SCHEDULED' })).entry,
        c: api.liveEntryFromEvent(espnEvent({ state: 'STATUS_IN_PROGRESS' })).entry
    });
    assert.strictEqual(api.liveRefreshDelay(), api.LIVE_REFRESH_PLAYING_MS);
});

check('nothing left to watch stops the polling', () => {
    const api = makeAppEnv();
    api.__setLiveScores({
        a: api.liveEntryFromEvent(espnEvent({ state: 'STATUS_FINAL', shortDetail: 'Final' })).entry
    });
    assert.strictEqual(api.shouldPollLiveScores(), false, 'all final, so stop');
});

section('The score follows the poll, not the page load');

// A game carries ESPN's status and score from whenever the schedule was
// fetched. The poll refreshes the cache every couple of minutes, and reading
// the snapshot in preference to it froze every score the moment its game
// kicked off - the score only moved again on a reload.

check('a fresher poll beats the score baked into the schedule', () => {
    const stale = inProgress(1, 'Rams', 'Seahawks', 7, 3);   // as the page loaded
    stale.espnId = 'evt-1';
    const api = setup({ games: [stale] });
    assert.strictEqual(api.getLiveGameStatus(stale).homeScore, 3, 'the snapshot, with nothing polled');

    api.__setLiveScores({
        'Los Angeles Rams@Seattle Seahawks': api.liveEntryFromEvent(espnEvent({
            awayScore: 20, homeScore: 24
        })).entry
    });
    // liveEntryFromEvent has no id on this stub event, so match by name.
    delete stale.espnId;
    const live = api.getLiveGameStatus(stale);
    assert.strictEqual(live.homeScore, 24, 'the poll wins');
    assert.strictEqual(live.awayScore, 20);
});

check('the snapshot still covers a week the scoreboard is not carrying', () => {
    const played = finalGame(1, 'Rams', 'Seahawks', 20, 24);
    const api = setup({ games: [played] });
    api.__setLiveScores({});   // scoreboard has moved on to another week
    const status = api.getLiveGameStatus(played);
    assert.strictEqual(status.homeScore, 24, 'falls back to what the schedule knows');
    assert.strictEqual(status.completed, true);
});

check('a game the scoreboard is not carrying takes no other game\u2019s score', () => {
    // Same two teams, a different meeting. Matching on names alone would hand
    // this one the live score of the rematch.
    const earlier = finalGame(1, 'Rams', 'Seahawks', 20, 24);
    earlier.espnId = 'week-1-meeting';
    const api = setup({ games: [earlier] });
    api.__setLiveScores({
        'Los Angeles Rams@Seattle Seahawks': {
            ...api.liveEntryFromEvent(espnEvent({ awayScore: 3, homeScore: 0 })).entry,
            espnId: 'week-12-rematch'
        }
    });
    const status = api.getLiveGameStatus(earlier);
    assert.strictEqual(status.awayScore, 20, 'its own score, not the rematch\u2019s');
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

check('every tab that shows data is covered by the one redraw path', () => {
    // Each caller that named tabs itself eventually missed one: the backup
    // load forgot the Live tab, and the score poll forgot Standings, so a
    // game going final left the standings where they were.
    const src = APP.match(/function renderActiveTab\(\)[\s\S]*?\n\}/)[0];
    ['renderGames', 'renderScoringSummary', 'renderDashboard', 'renderLiveTab']
        .forEach(fn => assert.ok(src.includes(fn + '('), fn + ' is redrawn'));
});

check('nothing refreshes by naming tabs on its own any more', () => {
    assert.doesNotMatch(APP, /function refreshLiveViews/,
        'one redraw path, not two that can drift apart');
});

check('the poll reschedules itself even when a refresh throws', () => {
    // A self-rescheduling timeout that only requeues at the end of its body
    // stops for good the first time anything in it throws - a failed fetch is
    // enough. An interval would have kept firing regardless.
    const src = APP.match(/function scheduleLiveScoresRefresh\(\)[\s\S]*?\n\}/)[0];
    assert.ok(src.includes('finally'), 'the requeue is in a finally');
    assert.ok(src.includes('catch'), 'and a throw is caught rather than killing it');
});

section('A long section can be scrolled to the end of');

check('an open collapsible section caps its height at nothing', () => {
    // max-height with overflow: hidden is a cap as well as an animation. At
    // 2000px a dozen completed game boxes - one per row on a phone - were cut
    // off with no way to reach the rest of them.
    // Exactly that selector, not every rule mentioning it.
    const open = rulesFor('.collapsible-content')
        .find(block => block.split('{')[0].trim() === '.collapsible-content');
    assert.ok(open, 'found the open-state rule');
    const cap = open.match(/max-height:\s*([^;]+);/);
    assert.ok(cap, 'it says what its max-height is');
    assert.strictEqual(cap[1].trim(), 'none', 'and it is uncapped');
});

check('a closed one is still closed', () => {
    const closed = rulesFor('.collapsible-content')
        .find(block => block.split('{')[0].trim() === '.collapsible-section.collapsed .collapsible-content');
    assert.ok(closed, 'found the collapsed rule');
    assert.ok(/max-height:\s*0/.test(closed), 'it still shuts');
});

section('A finished game recedes');

/**
 * The rule blocks in styles.css whose selector mentions `token`.
 *
 * Comments are stripped first: one sitting above a rule would otherwise be
 * read as part of that rule's selector.
 */
function rulesFor(token) {
    const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    return (styles.match(/[^{}]+\{[^{}]*\}/g) || [])
        .filter(block => block.split('{')[0].includes(token));
}

check('a box is marked with the state it is in', () => {
    const api = setup(threeStates());
    api.renderBlazinGameBoxes();
    assert.ok((api.__written['live-games-list'] || '').includes('live-game-box in-progress'));
    assert.ok((api.__written['live-completed-list'] || '').includes('live-game-box final'));
    assert.ok((api.__written['live-upcoming-list'] || '').includes('live-game-box upcoming'));
});

check('finished and upcoming are both faded', () => {
    ['.live-game-box.final', '.live-game-box.upcoming'].forEach(sel => {
        const faded = rulesFor(sel).some(block => /opacity:\s*0?\.\d+/.test(block));
        assert.ok(faded, sel + ' is faded');
    });
});

check('a game being played is not', () => {
    const faded = rulesFor('.live-game-box.in-progress')
        .some(block => /opacity:\s*0?\.\d+/.test(block));
    assert.ok(!faded, 'it keeps full attention');
});

section('Finished games go in their own section');

/** One of each: being played, done, still to come. */
function threeStates() {
    return {
        games: [
            inProgress(1, 'Rams', 'Seahawks', 20, 24),
            finalGame(2, 'Bills', 'Chiefs', 30, 20),
            game(3, 'Jets', 'Dolphins')
        ],
        withDom: true,
        picks: {
            Stephen: {
                rams_seahawks: b5('home'),
                bills_chiefs: b5('away'),
                jets_dolphins: b5('home')
            }
        },
        results: { 2: { awayScore: 30, homeScore: 20, winner: 'away' } }
    };
}

check('only what is being played is on the page outright', () => {
    const api = setup(threeStates());
    api.renderBlazinGameBoxes();

    const active = api.__written['live-games-list'] || '';
    assert.strictEqual((active.match(/live-game-box/g) || []).length, 1, 'just the live one');
    assert.ok(active.includes('Rams @ Seahawks'));
});

check('the finished one goes to Completed, the unplayed one to Upcoming', () => {
    const api = setup(threeStates());
    api.renderBlazinGameBoxes();

    const done = api.__written['live-completed-list'] || '';
    const soon = api.__written['live-upcoming-list'] || '';
    assert.ok(done.includes('Bills @ Chiefs'), 'finished');
    assert.ok(soon.includes('Jets @ Dolphins'), 'still to come');
    assert.ok(!done.includes('Jets @ Dolphins') && !soon.includes('Bills @ Chiefs'),
        'and neither strays into the other');
});

check('each section counts what it holds', () => {
    const api = setup(threeStates());
    api.renderBlazinGameBoxes();
    assert.strictEqual(api.__written['live-completed-count:text'], '(1)');
    assert.strictEqual(api.__written['live-upcoming-count:text'], '(1)');
});

check('with nothing being played, the main list says so', () => {
    const games = [finalGame(1, 'Rams', 'Seahawks', 20, 24)];
    const api = setup({
        games, withDom: true,
        picks: { Stephen: { rams_seahawks: b5('home') } },
        results: { 1: { awayScore: 20, homeScore: 24, winner: 'home' } }
    });
    api.renderBlazinGameBoxes();
    assert.ok((api.__written['live-games-list'] || '').includes('No games in progress'));
    assert.ok((api.__written['live-completed-list'] || '').includes('live-game-box'));
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
