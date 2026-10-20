// Tests for the Game Details popup's tabs: Betting, Matchup, Players, Picks.
//
// The worker trims ESPN's ~110 KB game summary to injuries, last five and
// leaders; the site draws each tab from that and from its own data. What is
// worth guarding: ATS records are graded at the board line (never a picker's
// own number), head to head reads archived results from the archive alone,
// the Picks tab shows everyone including Cowherd before kickoff, and the
// viewer's record by team counts only their line picks on that team.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const { fixedClock } = require('./fixed-clock');

// Week 7 of 2026, on its Tuesday.
const TEST_NOW = '2026-10-20T17:00:00Z';

const SOURCE = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-tabs-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE + '\nexport { trimEspnSummary };\n');

function loadSite(search = '') {
    const elements = {};
    const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] });
    elements['game-details-modal'] = el();
    elements['game-details-body'] = el();
    const net = { fetch: async () => ({ ok: false, json: async () => ({}) }) };
    const store = new Map();
    const env = {
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } },
        document: {
            addEventListener() {}, getElementById: id => elements[id] || null, querySelector: () => null, querySelectorAll: () => [],
            createElement: el, head: { appendChild() {} },
            body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
            documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }
        },
        navigator: {}, fetch: (...args) => net.fetch(...args),
        console: { log() {}, warn() {}, error() {}, info() {} },
        performance: { now: () => 0 }, alert() {}, confirm: () => false,
        addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} })
    };
    env.window = env;
    env.location = { search };
    const snapshot = `const HISTORICAL_DATA_SEASON = 0; const HISTORICAL_GAMES = {}; const HISTORICAL_RESULTS = {}; const HISTORICAL_PICKS = {};`;
    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console',
        'performance', 'alert', 'confirm', 'addEventListener', 'matchMedia', 'Date',
        fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8') + '\n' + snapshot + '\n'
        + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        + `;return ({ gameDetailsHtml, teamAtsRecord, headToHeadMeetings, pickerTeamRecord, loadGameSummary,
            PICKERS, CURRENT_SEASON, AVAILABLE_SEASONS, NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, seasonData,
            __week: () => currentWeek,
            __setTab: t => { gameDetailsTab = t; },
            __setSummary: (id, data) => { gameSummaries.set(id, { at: Date.now(), data }); },
            __summary: id => gameSummaries.get(id),
            __injuriesOpen: () => injuriesOpen,
            weatherKind,
            __setPicks: p => { allPicks = p; },
            __setPicker: p => { currentPicker = p; }, __allPicks: () => allPicks });`);
    const api = fn(env.window, env.document, env.localStorage, env.navigator, env.fetch, env.console,
        env.performance, env.alert, env.confirm, env.addEventListener, env.matchMedia, fixedClock(TEST_NOW));
    api.__net = net;
    return api;
}

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&ndash;/g, '–').replace(/&#9733;/g, '★').replace(/\s+/g, ' ').trim();
const final = (away, home) => ({ completed: true, status: 'STATUS_FINAL', awayScore: away, homeScore: home });
const resultOf = g => ({ winner: g.homeScore > g.awayScore ? 'home' : g.awayScore > g.homeScore ? 'away' : 'tie', awayScore: g.awayScore, homeScore: g.homeScore });

/** Every finished game written to the Results sheet, as the backfill would. */
function setWeeks(site, weeks) {
    for (const [week, games] of Object.entries(weeks)) {
        site.NFL_GAMES_BY_WEEK[week] = games;
        site.NFL_RESULTS_BY_WEEK[week] = Object.fromEntries(games.filter(g => g.completed).map(g => [g.id, resultOf(g)]));
    }
}

/** Every earlier season loaded, empty unless given, so nothing reads "loading". */
function setArchives(site, archives = {}) {
    for (const s of site.AVAILABLE_SEASONS) {
        if (Number(s) === site.CURRENT_SEASON) continue;
        site.seasonData[s] = archives[s] || { games: {}, results: {}, picks: {}, __pickKeysNormalized: true };
    }
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 8).join(' | ')}`); }
}

(async () => {
    const { trimEspnSummary } = await import(pathToFileURL(tmp).href);

    console.log('\nWorker: ESPN summary trimmed');

    await check('injuries, last five and three leaders, by nickname; the rest dropped', () => {
        const espn = {
            injuries: [{ team: { displayName: 'San Francisco 49ers' }, injuries: [
                { athlete: { displayName: 'Nick Bosa', position: { abbreviation: 'DE' }, headshot: { href: 'https://a.espncdn.com/i/headshots/nfl/players/full/3051389.png' } }, status: 'Questionable', details: { type: 'Calf' } },
                { athlete: { displayName: 'Elsewhere', headshot: { href: 'https://evil.example/x.png' } }, status: 'Out' },
                { athlete: {}, status: 'Out' }
            ] }],
            lastFiveGames: [{ team: { displayName: 'Atlanta Falcons' }, events: Array.from({ length: 7 }, (_, i) => ({ gameResult: i % 2 ? 'L' : 'W', atVs: '@', opponent: { abbreviation: 'CHI' }, score: '31-23', gameDate: '2026-10-12' })) }],
            leaders: [{ team: { displayName: 'San Francisco 49ers' }, leaders: [
                { name: 'passingYards', displayName: 'Passing Yards', leaders: [{ displayValue: '1,640 YDS', athlete: { shortName: 'B. Purdy', position: { abbreviation: 'QB' } } }] },
                { name: 'sacks', displayName: 'Sacks', leaders: [{ displayValue: '6', athlete: { shortName: 'N. Bosa' } }] }
            ] }],
            boxscore: { huge: 'x'.repeat(1000) }, standings: {}, news: {}
        };
        const out = trimEspnSummary(espn);
        assert.deepStrictEqual(Object.keys(out), ['injuries', 'lastFive', 'leaders']);
        assert.strictEqual(out.injuries[0].team, '49ers');
        assert.deepStrictEqual(out.injuries[0].players, [
            { name: 'Nick Bosa', pos: 'DE', status: 'Questionable', detail: 'Calf', headshot: 'https://a.espncdn.com/i/headshots/nfl/players/full/3051389.png' },
            { name: 'Elsewhere', pos: '', status: 'Out', detail: '', headshot: '' }
        ], 'a nameless entry is dropped; a headshot only from ESPN’s image host');
        assert.strictEqual(out.lastFive[0].team, 'Falcons');
        assert.strictEqual(out.lastFive[0].games.length, 5, 'five, not seven');
        assert.strictEqual(out.lastFive[0].games[0].week, null, 'no week from ESPN: null');
        assert.strictEqual(trimEspnSummary({ lastFiveGames: [{ team: {}, events: [{ week: 6 }] }] }).lastFive[0].games[0].week, 6);
        assert.deepStrictEqual(out.leaders[0].items, [{ label: 'Passing Yards', name: 'B. Purdy', pos: 'QB', value: '1,640 YDS', headshot: '' }], 'sacks left out');
        assert.doesNotMatch(JSON.stringify(out), /huge|boxscore/, 'the rest of the summary is not passed on');
    });

    await check('an empty or odd summary gives empty lists, not a throw', () => {
        assert.deepStrictEqual(trimEspnSummary({}), { injuries: [], lastFive: [], leaders: [] });
        assert.deepStrictEqual(trimEspnSummary(null), { injuries: [], lastFive: [], leaders: [] });
    });

    await check('injuries: ESPN’s own list as `players`, the roster’s whole list as `all`', () => {
        const athlete = (name, status, date) => ({ displayName: name, position: { abbreviation: 'WR' }, injuries: status ? [{ status, date }] : [] });
        const roster = { athletes: [
            { items: [athlete('Brandon Aiyuk', 'Out', '2026-09-21T15:27Z'), athlete('Deebo Samuel Sr.', 'Out', '2026-10-20T16:04Z'),
                athlete('George Kittle', 'Active', '2026-10-01T00:00Z'), athlete('Brock Purdy', null)] },
            { items: [athlete('Ricky Pearsall', 'Injured Reserve', '2026-08-13T15:11Z')] }
        ] };
        const summary = { injuries: [{ team: { displayName: 'San Francisco 49ers' }, injuries: [
            { athlete: { displayName: 'Deebo Samuel Sr.' }, status: 'Out', details: { type: 'Hamstring' } }
        ] }, { team: { displayName: 'Atlanta Falcons' }, injuries: [
            { athlete: { displayName: 'C.J. Henderson' }, status: 'Questionable', details: { type: 'Groin' } }
        ] }] };
        const out = trimEspnSummary(summary, { 'San Francisco 49ers': roster });
        const sf = out.injuries.find(t => t.team === '49ers');
        assert.deepStrictEqual(sf.players.map(p => p.name), ['Deebo Samuel Sr.'], 'ESPN’s list unchanged');
        assert.deepStrictEqual(sf.all.map(p => `${p.name}:${p.status}:${p.detail}`),
            ['Deebo Samuel Sr.:Out:Hamstring', 'Brandon Aiyuk:Out:', 'Ricky Pearsall:Injured Reserve:'], 'Active and healthy players left out');
        const atl = out.injuries.find(t => t.team === 'Falcons');
        assert.deepStrictEqual(atl.all, atl.players, 'no roster: the summary’s list for both');
    });


    const site = loadSite();
    const week = site.__week();
    const game = { id: 70, espnId: '401772900', away: '49ers', home: 'Falcons', spread: 3, favorite: 'away', kickoff: '2026-10-25T17:00:00Z' };

    console.log('\nTabs');

    await check('four tabs under the header, Betting open by default', () => {
        setWeeks(site, { [week]: [game] });
        const html = site.gameDetailsHtml(game);
        assert.deepStrictEqual([...html.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]), ['betting', 'matchup', 'players', 'picks']);
        assert.match(html, /gd-tab active" data-tab="betting"/);
        assert.ok(html.indexOf('gd-tabs') > html.indexOf('gd-hero'), 'under the header');
    });

    await check('the header is plain black: no stadium photo (tried, and dropped by the owner)', () => {
        const html = site.gameDetailsHtml(game);
        assert.match(html, /<div class="gd-hero">/);
        assert.doesNotMatch(html, /venues\/nfl|gd-stadium/);
    });

    console.log('\nMatchup');

    await check('ATS this season at the board line; a picker’s locked number changes nothing', () => {
        setWeeks(site, {
            1: [{ id: 1, away: '49ers', home: 'Rams', spread: 3, favorite: 'away', ...final(24, 20) }],      // SF -3 by 4: cover
            2: [{ id: 2, away: 'Seahawks', home: '49ers', spread: 6, favorite: 'home', ...final(17, 20) }],  // SF -6 by 3: no
            3: [{ id: 3, away: '49ers', home: 'Bears', spread: 3, favorite: 'away', ...final(23, 20) }],     // push
            [week]: [game]
        });
        site.__setPicks({ 1: { Stephen: { '49ers_rams': { line: 'away', frozenAt: 'x', frozenSpread: 5, frozenFavorite: 'away' } } } });
        assert.deepStrictEqual(site.teamAtsRecord('49ers'), { w: 1, l: 1, p: 1 });
        assert.deepStrictEqual(site.teamAtsRecord('Rams'), { w: 0, l: 1, p: 0 });
        assert.deepStrictEqual(site.teamAtsRecord('Falcons'), { w: 0, l: 0, p: 0 }, 'not played yet');
    });

    await check('head to head across seasons, newest first, archived results from the archive', () => {
        setArchives(site, {
            2025: { games: { 7: [{ id: 9, away: 'Falcons', home: '49ers', spread: 1.5, favorite: 'home' }] },
                results: { 7: { 9: { winner: 'home', awayScore: 10, homeScore: 20 } } }, picks: {}, __pickKeysNormalized: true },
            2022: { games: { 6: [{ id: 4, away: '49ers', home: 'Falcons', spread: 4.5, favorite: 'away' }] },
                results: { 6: { 4: { winner: 'home', awayScore: 14, homeScore: 28 } } }, picks: {}, __pickKeysNormalized: true }
        });
        const meetings = site.headToHeadMeetings(game);
        assert.deepStrictEqual(meetings.map(m => `${m.season}:${m.week}:${m.ats}`), ['2025:7:home', '2022:6:home']);
        site.__setTab('matchup');
        const t = text(site.gameDetailsHtml(game));
        assert.match(t, /Week Winner Covered Week 7, 2025 SF 20-10 SF -1.5 Week 6, 2022 ATL 28-14 ATL \+4.5/,
            'as the Last five: when, the winner and score, the side that covered at its line');
        assert.match(t, /49ers 1-1 ATS in 2 meetings/);
        assert.match(t, /AGAINST THE SPREAD|Against the spread/i);
    });

    await check('last five: loading, then a table a team, newest first, by week, opponents with logos', () => {
        assert.match(text(site.gameDetailsHtml(game)), /Loading from ESPN/);
        // The schedule has 49ers @ Rams in week 1; ESPN's entry for it carries no week.
        site.NFL_GAMES_BY_WEEK[1][0].kickoff = '2026-09-13T20:25:00Z';
        site.__setSummary(game.espnId, {
            injuries: [{ team: 'Falcons', players: [
                { name: 'C. Henderson', pos: 'CB', status: 'Questionable', detail: 'Groin', headshot: 'https://a.espncdn.com/i/headshots/nfl/players/full/4240596.png' },
                { name: 'Y. Abdullah', pos: 'LB', status: 'Out', detail: 'Hamstring' }
            ] }],
            lastFive: [{ team: '49ers', games: [
                { result: 'W', atVs: '@', opp: 'LAR', score: '24-20', date: '2026-09-13T20:25Z' },
                { result: 'L', atVs: 'vs', opp: 'CAR', score: '34-3', date: '2025-12-28T18:00Z' },
                { result: 'W', atVs: '@', opp: 'SEA', score: '32-29', date: '2026-10-13T00:15Z', week: 6 }
            ] }],
            leaders: [{ team: '49ers', items: [{ label: 'Passing Yards', name: 'B. Purdy', pos: 'QB', value: '1,640 YDS' }] }]
        });
        const html = site.gameDetailsHtml(game);
        const t = text(html);
        assert.match(t, /49ers Week Opp Result Week 6 @ SEA W 32-29 Week 1 @ LAR W 24-20 2025 vs CAR L 34-3/,
            'ESPN’s week; else the schedule’s; a game from last season gets its year; newest first');
        assert.doesNotMatch(t, /\d+\/\d+\/\d+/, 'no US dates');
        assert.match(html, /gd-l5-opp-logo" src="https:\/\/a.espncdn.com\/i\/teamlogos\/nfl\/500\/sea.png"/);
        assert.match(html, /gd-l5-wl win">W<\/span> 32-29/);
        assert.match(html, /gd-l5-wl loss">L<\/span> 34-3/);
        assert.match(t, /Falcons No games yet/, 'Falcons: nothing from ESPN');
    });

    console.log('\nPlayers');

    await check('injuries worst first, with short chips; leaders by team', () => {
        site.__setTab('players');
        const html = site.gameDetailsHtml(game);
        assert.ok(html.indexOf('Y. Abdullah') < html.indexOf('C. Henderson'), 'Out before Questionable');
        assert.match(html, /gd-status out" title="Out">OUT</);
        assert.match(html, /gd-status questionable" title="Questionable">Q</);
        assert.match(text(html), /PASSING|Passing B. Purdy 1,640 YDS/);
        assert.match(text(html), /None listed/, '49ers: no injuries listed');
        assert.match(html, /<img src="https:\/\/a.espncdn.com\/combiner\/i\?img=%2Fi%2Fheadshots%2Fnfl%2Fplayers%2Ffull%2F4240596.png&amp;w=96&amp;h=70"/, 'a small headshot through ESPN’s resizer');
        assert.match(html, /gd-headshot"><\/span><span class="gd-injury-name">Y. Abdullah/, 'no headshot: an empty circle keeps the place');
    });

    await check('ESPN’s own injuries first; "Show all" opens the roster’s whole list', () => {
        const p = (name, status) => ({ name, pos: 'LB', status, detail: '' });
        const espn = [p('Nick Bosa', 'Questionable'), p('Deebo Samuel Sr.', 'Out')];
        const all = [...espn, p('Brandon Aiyuk', 'Out'), p('Ricky Pearsall', 'Injured Reserve')];
        site.__setSummary(game.espnId, { injuries: [{ team: '49ers', players: espn, all }], lastFive: [], leaders: [] });
        site.__setTab('players');
        let html = site.gameDetailsHtml(game);
        assert.ok(html.indexOf('Deebo Samuel Sr.') < html.indexOf('Nick Bosa'), 'worst first');
        assert.doesNotMatch(html, /Brandon Aiyuk/, 'only ESPN’s players until asked');
        assert.match(html, /class="gd-more" data-injuries="away">Show all 4</);
        site.__injuriesOpen().add('away');
        html = site.gameDetailsHtml(game);
        assert.match(html, /Brandon Aiyuk[\s\S]*Ricky Pearsall/);
        assert.match(html, /data-injuries="away">Show fewer</);
        site.__injuriesOpen().clear();
        site.__setSummary(game.espnId, { injuries: [{ team: '49ers', players: espn }], lastFive: [], leaders: [] });
        assert.doesNotMatch(site.gameDetailsHtml(game), /gd-more/, 'an older worker with no full list: no button');
    });

    console.log('\nWeather');

    await check('an icon for each kind of forecast, the worst weather named winning', () => {
        const cases = {
            Sunny: 'sun', Clear: 'sun', 'Mostly sunny': 'partly', 'Intermittent clouds': 'partly', 'Partly cloudy': 'partly',
            'Mostly cloudy': 'cloud', Cloudy: 'cloud', Dreary: 'cloud', Showers: 'rain', 'Light rain': 'rain',
            'Partly sunny w/ showers': 'rain', 'T-storms': 'storm', Thunderstorms: 'storm', Flurries: 'snow',
            'Freezing rain': 'snow', Fog: 'fog', Windy: 'wind', 'Hazy sunshine': 'partly', Gibberish: null
        };
        for (const [phrase, kind] of Object.entries(cases)) assert.strictEqual(site.weatherKind(phrase), kind, phrase);
        site.__setTab('betting');
        const html = site.gameDetailsHtml({ ...game, weather: { text: 'Intermittent clouds', temp: 58 } });
        assert.match(html, /<span class="gd-wx" role="img" aria-label="Intermittent clouds" title="Intermittent clouds"><svg/);
        assert.doesNotMatch(html.replace(/aria-label="[^"]*"|title="[^"]*"/g, ''), /Intermittent clouds/, 'the words only as the label');
        assert.match(site.gameDetailsHtml({ ...game, weather: { text: 'Gibberish', temp: 58 } }), /Gibberish, 58&deg;F/, 'no icon fits: the words');
        site.__setTab('players');
    });

    await check('no ESPN id: says so and asks nobody', async () => {
        let asked = 0;
        site.__net.fetch = async () => { asked++; return { ok: false }; };
        const noId = { ...game, espnId: undefined };
        assert.match(text(site.gameDetailsHtml(noId)), /Not available for this game/);
        await site.loadGameSummary(noId);
        assert.strictEqual(asked, 0);
    });

    await check('a failed fetch says it will try again, and does after a minute', async () => {
        const other = { ...game, espnId: '401772901' };
        await site.loadGameSummary(other);
        assert.ok(site.__summary(other.espnId).failed);
        site.__setTab('players');
        assert.match(text(site.gameDetailsHtml(other)), /Couldn’t load from ESPN/);
    });

    console.log('\nPicks');

    await check('every picker and Cowherd, before kickoff; the viewer’s row marked', () => {
        site.__setPicker('Stephen');
        site.__setPicks({ [week]: {
            Stephen: { '49ers_falcons': { line: 'home', winner: 'away', blazin: true } },
            Daniel: { '49ers_falcons': { line: 'away', winner: 'away', frozenAt: 'x', frozenSpread: 3.5, frozenFavorite: 'away' } },
            Cowherd: { '49ers_falcons': { line: 'home', blazin: true, frozenAt: 'x', frozenSpread: 3, frozenFavorite: 'away' } }
        } });
        site.__setTab('picks');
        const html = site.gameDetailsHtml(game);
        const t = text(html);
        assert.match(t, /2 of 5 picked/);
        assert.match(t, /SF 1 ATL 1/);
        assert.match(t, /Daniel SF -3.5 locked SF/, "the team as its abbreviation, with its logo");
        assert.match(html, /<span class="gd-l5-opp"><img class="gd-l5-opp-logo" src="https:\/\/a.espncdn.com\/i\/teamlogos\/nfl\/500\/sf.png"/);
        assert.match(t, /Stephen \(you\) ATL \+3 ★ SF/);
        assert.match(t, /Cowherd ATL \+3 –/, 'his line, no locked tag or star: all of his are');
        assert.match(html, /<tr class="you"><td>Stephen/);
        for (const p of site.PICKERS.filter(p => !['Stephen', 'Daniel'].includes(p))) {
            assert.doesNotMatch(t, new RegExp(`\\b${p}\\b`), `${p} has not picked: no row`);
        }
        assert.doesNotMatch(t, /no pick yet/);
    });

    await check('nobody has picked: the line says so, and no table of names', () => {
        site.__setPicks({ [week]: {} });
        const html = site.gameDetailsHtml(game);
        assert.match(text(html), /Nobody has picked this game yet/);
        assert.doesNotMatch(html, /gd-picks|not in his 5/);
        // Cowherd alone: his row, no empty tally bar.
        site.__setPicks({ [week]: { Cowherd: { '49ers_falcons': { line: 'away', blazin: true, frozenAt: 'x', frozenSpread: 3, frozenFavorite: 'away' } } } });
        const only = site.gameDetailsHtml(game);
        assert.match(text(only), /Cowherd SF -3/);
        assert.doesNotMatch(only, /gd-bar|Nobody has picked/);
    });

    await check('your record picking each team: line picks only, this season and all seasons', () => {
        setWeeks(site, {
            1: [{ id: 1, away: '49ers', home: 'Rams', spread: 3, favorite: 'away', ...final(24, 20) }],
            2: [{ id: 2, away: 'Seahawks', home: '49ers', spread: 6, favorite: 'home', ...final(17, 20) }],
            [week]: [game]
        });
        site.__setPicks({
            1: { Stephen: { '49ers_rams': { line: 'away', winner: 'away' } } },          // took SF: win
            2: { Stephen: { 'seahawks_49ers': { line: 'away', winner: 'home' } } },      // took SEA: not an SF pick
            [week]: {}
        });
        setArchives(site, {
            2025: { games: { 3: [{ id: 5, away: '49ers', home: 'Saints', spread: 7, favorite: 'away' }] },
                results: { 3: { 5: { winner: 'away', awayScore: 21, homeScore: 17 } } },
                picks: { 3: { Stephen: { '49ers_saints': { line: 'away' } } } }, __pickKeysNormalized: true }
        });
        assert.deepStrictEqual(site.pickerTeamRecord('Stephen', '49ers', [site.CURRENT_SEASON]), { w: 1, l: 0, p: 0 });
        assert.deepStrictEqual(site.pickerTeamRecord('Stephen', '49ers', site.AVAILABLE_SEASONS), { w: 1, l: 1, p: 0 }, '2025: SF -7 won by 4');
        assert.deepStrictEqual(site.pickerTeamRecord('Stephen', 'Seahawks', [site.CURRENT_SEASON]), { w: 1, l: 0, p: 0 }, 'SEA +6, lost by 3: covered');
        const t = text(site.gameDetailsHtml(game));
        assert.match(t, /Stephen’s record/);
        // Week 2 he took the Seahawks against the 49ers: that is an "against" pick.
        assert.deepStrictEqual(site.pickerTeamRecord('Stephen', '49ers', [site.CURRENT_SEASON], { against: true }), { w: 1, l: 0, p: 0 });
        assert.deepStrictEqual(site.pickerTeamRecord('Stephen', 'Seahawks', [site.CURRENT_SEASON], { against: true }), { w: 0, l: 0, p: 0 });
        assert.match(t, /Took the 49ers 1-0 1-1 Against the 49ers 1-0 1-0/, 'every 49ers game counted, one row or the other');
        assert.match(t, /Took the Falcons 0-0 0-0 Against the Falcons 0-0 0-0/);
    });

    await check('no picker chosen: asks for one', () => {
        site.__setPicker(null);
        assert.match(text(site.gameDetailsHtml(game)), /Choose a picker/);
    });

    fs.unlinkSync(tmp);
    console.log(failures ? `\n${failures} of ${total} CHECKS FAILED` : `\nALL ${total} CHECKS PASSED`);
    process.exit(failures ? 1 : 0);
})();
