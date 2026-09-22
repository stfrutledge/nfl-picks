/**
 * NFL Picks Dashboard - Main Application
 */

// Cloudflare Worker Proxy URL - handles all external API calls (Odds API, Google Sheets, sync)
// Deploy nfl-picks-proxy.js to Cloudflare Workers and set this URL
const WORKER_PROXY_URL = 'https://nfl-picks-proxy.stfrutledge.workers.dev';

// Google Apps Script URL (legacy - now proxied through worker)
// Not fetched directly - every call goes through WORKER_PROXY_URL/sync, and the
// worker holds the live URL in its own APPS_SCRIPT_URL env var. This is the
// flag for "is the Backup sheet configured at all", and a record of which
// deployment the worker should be pointed at. Keep the two in step: a stale
// value here is invisible until somebody trusts it.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw1xNy3GxkpU3PIviAJJd7BiCUUTUt7lf_9GWAOI5yXaWxv-9VJDQLUl8-3rL-oc-5f/exec';

// Track pending syncs to avoid duplicate requests
let pendingSyncTimeout = null;
// Wait this long after the last change before syncing. Long enough that
// clicking through a slate is one write rather than one per pick; short enough
// that little is outstanding at any moment. flushPendingSync() covers the tab
// being closed or backgrounded inside the window.
const SYNC_DEBOUNCE_MS = 5000;

let dashboardData = null;
let currentCategory = 'make-picks';
let currentSubcategory = null; // Will be set after CURRENT_NFL_WEEK is calculated
let currentPicker = localStorage.getItem('selectedPicker') || null;
let currentWeek = null; // Will be set to CURRENT_NFL_WEEK after it's calculated
let allPicks = {}; // Store picks for all pickers: { week: { picker: { gameId: { line: 'away'|'home', winner: 'away'|'home' } } } }
let clearedPicks = {}; // Track intentionally cleared picks: { week: { picker: true } } - loaded from season-scoped storage below
let backupFetchedThisSession = false; // Only fetch all picks from backup once per session
let resultsFetchedThisSession = false; // Only fetch results from backup once per session
let initialLoadComplete = false; // Track whether initial data load is complete

// Season configuration
// Automatically determine current season based on date (switches on July 1st)
function calculateCurrentSeason() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed, so July = 6
    // If July (6) or later, use current year; otherwise use previous year
    return month >= 6 ? year : year - 1;
}
const CURRENT_SEASON = calculateCurrentSeason();
let currentSeason = CURRENT_SEASON;
// Generate available seasons from current season back to 2016
const AVAILABLE_SEASONS = Array.from(
    { length: CURRENT_SEASON - 2016 + 1 },
    (_, i) => CURRENT_SEASON - i
);

// --- Automatic offseason reset (rolls over every July 1st) -----------------
// Everything below is scoped to CURRENT_SEASON, so a new season automatically
// starts from a clean slate:
// - localStorage keys change with the season, leaving old picks behind
// - a historical-data.js snapshot from a previous season is emptied in place
// - Google Sheet backup rows are season-prefixed, so old rows are ignored

// Season-scoped localStorage keys
const PICKS_STORAGE_KEY = `nflPicks_${CURRENT_SEASON}`;
const CLEARED_PICKS_KEY = `clearedPicks_${CURRENT_SEASON}`;
clearedPicks = JSON.parse(localStorage.getItem(CLEARED_PICKS_KEY) || '{}');

// If historical-data.js holds a previous season's snapshot (or an untagged one),
// empty it in place so stale games/results/picks never leak into a new season.
if (typeof HISTORICAL_GAMES !== 'undefined' &&
    (typeof HISTORICAL_DATA_SEASON === 'undefined' || HISTORICAL_DATA_SEASON !== CURRENT_SEASON)) {
    console.log('[Season] Clearing stale historical-data.js snapshot from a previous season');
    for (const week in HISTORICAL_GAMES) delete HISTORICAL_GAMES[week];
    if (typeof HISTORICAL_RESULTS !== 'undefined') {
        for (const week in HISTORICAL_RESULTS) delete HISTORICAL_RESULTS[week];
    }
    if (typeof HISTORICAL_PICKS !== 'undefined') {
        for (const week in HISTORICAL_PICKS) delete HISTORICAL_PICKS[week];
    }
}

// The Google Sheet backup keeps rows forever and has no season column, so week
// keys written from 2026 on are prefixed with the season (e.g. "2026_5").
// Un-prefixed numeric weeks in the sheet are 2025-season rows and are ignored.
function toSheetWeek(week) {
    return `${CURRENT_SEASON}_${week}`;
}
// Returns the local week number, or null if the row belongs to another season.
function fromSheetWeek(sheetWeek) {
    const match = String(sheetWeek).match(/^(\d{4})_(\d+)$/);
    if (!match) return null;
    return parseInt(match[1]) === CURRENT_SEASON ? parseInt(match[2]) : null;
}

// Get pickers available for a given season (Jason and Daniel started in 2023, Dylan stopped after 2019)
function getPickersForSeason(season) {
    if (season <= 2019) {
        return ['Stephen', 'Sean', 'Dylan'];
    }
    if (season <= 2022) {
        return PICKERS.filter(p => p !== 'Jason' && p !== 'Daniel');
    }
    return PICKERS;
}

// Season data storage - keyed by season year
// The current season uses NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, allPicks directly
// Historical seasons loaded on-demand from historical-YYYY.js files
let seasonData = {};
let seasonDataLoading = {}; // Track which seasons are currently being loaded

// Lazy-loaded script tracking
let historical2024Loaded = false;
let historical2024Loading = null; // Promise for loading in progress

// Track if spreads are still loading in background
let spreadsLoading = true;

// Whether the standings on screen are still filling in.
//
// They are computed from picks + results + every played week's schedule and
// lines, and none of that is cached locally - results deliberately so, since
// they change too often for a stored copy to be trusted. The first paint is
// therefore a real calculation over a partial dataset: the records climb for
// a few seconds as the background loads land. The table stays up, because a
// partial record is still worth reading and hiding it only makes the wait
// longer, but it is marked so nobody takes an in-progress number as final.
// Cleared once the background block in loadFromGoogleSheets() settles.
let standingsProvisional = true;

// Available weeks (1-18 for regular season)
const TOTAL_WEEKS = 18;

// Playoff week configuration
const PLAYOFF_WEEKS = {
    19: { name: 'Wild Card', shortName: 'WC', espnWeek: 1 },
    20: { name: 'Divisional', shortName: 'DIV', espnWeek: 2 },
    21: { name: 'Conference Championships', shortName: 'CONF', espnWeek: 3 },
    22: { name: 'Super Bowl', shortName: 'SB', espnWeek: 5 }  // ESPN week 4 is Pro Bowl, week 5 is Super Bowl
};
const FIRST_PLAYOFF_WEEK = 19;
const LAST_PLAYOFF_WEEK = 22;

/**
 * Check if a week is a playoff week
 */
function isPlayoffWeek(week) {
    return week >= FIRST_PLAYOFF_WEEK && week <= LAST_PLAYOFF_WEEK;
}

/**
 * Get display name for a week (e.g., "5" or "Wild Card")
 */
function getWeekDisplayName(week) {
    if (isPlayoffWeek(week)) {
        return PLAYOFF_WEEKS[week].name;
    }
    return week;
}

/**
 * Get full title for a week (e.g., "Week 5 Picks" or "Wild Card Week Picks")
 */
function getWeekTitle(week, suffix = 'Picks') {
    if (isPlayoffWeek(week)) {
        return `${PLAYOFF_WEEKS[week].name} Week ${suffix}`;
    }
    return `Week ${week} ${suffix}`;
}

/**
 * Get Labor Day (first Monday of September) for a given year
 */
function getLaborDay(year) {
    // Start at September 1st
    const sept1 = new Date(year, 8, 1); // Month is 0-indexed, so 8 = September
    // Find the first Monday (day 1)
    const dayOfWeek = sept1.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
    return new Date(year, 8, 1 + daysUntilMonday);
}

/**
 * Calculate NFL season dates dynamically based on season year
 * NFL season starts Thursday after Labor Day
 * Week 1 Tuesday is 2 days before that Thursday
 */
function getSeasonDates(seasonYear) {
    const laborDay = getLaborDay(seasonYear);

    // Season starts Tuesday before Week 1 Thursday (Thursday after Labor Day)
    // Labor Day (Monday) + 3 days = Thursday, so Tuesday = Labor Day + 1
    const seasonStart = new Date(laborDay);
    seasonStart.setDate(laborDay.getDate() + 1); // Tuesday before Week 1

    // Regular season is 18 weeks, ends ~18 weeks after start
    const regularSeasonEnd = new Date(seasonStart);
    regularSeasonEnd.setDate(seasonStart.getDate() + (18 * 7) + 1);

    // Playoff dates (approximate - typically 2nd weekend of January for Wild Card)
    const nextYear = seasonYear + 1;
    // Wild Card is typically the 2nd Saturday/Sunday of January
    const wildCardStart = new Date(nextYear, 0, 10); // ~January 10
    const divisionalStart = new Date(nextYear, 0, 17); // ~January 17
    const conferenceStart = new Date(nextYear, 0, 25); // ~January 25
    const superBowlStart = new Date(nextYear, 0, 26); // Day after Conference Championships
    const superBowlEnd = new Date(nextYear, 1, 9); // ~February 9

    return {
        seasonStart,
        regularSeasonEnd,
        wildCardStart,
        divisionalStart,
        conferenceStart,
        superBowlStart,
        superBowlEnd
    };
}

/**
 * Calculate current NFL week based on date
 * Dynamically calculates dates based on CURRENT_SEASON
 */
function calculateCurrentNFLWeek() {
    const dates = getSeasonDates(CURRENT_SEASON);
    const now = new Date();

    // If before season start, return week 1
    if (now < dates.seasonStart) return 1;

    // Playoff weeks
    if (now >= dates.superBowlEnd) return 22; // Season completely over, stay on Super Bowl week
    if (now >= dates.superBowlStart) return 22; // Super Bowl
    if (now >= dates.conferenceStart) return 21; // Conference Championships
    if (now >= dates.divisionalStart) return 20; // Divisional
    if (now >= dates.wildCardStart) return 19; // Wild Card

    // If after regular season but before Wild Card
    if (now >= dates.regularSeasonEnd) return 19;

    // Calculate weeks elapsed (each NFL week starts on Tuesday)
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weeksElapsed = Math.floor((now - dates.seasonStart) / msPerWeek);

    // Clamp to valid range (1-18)
    return Math.min(Math.max(weeksElapsed + 1, 1), TOTAL_WEEKS);
}

const CURRENT_NFL_WEEK = calculateCurrentNFLWeek();

/**
 * Whether the playoffs have started, which is what gates the Playoffs tab.
 *
 * Out of season CURRENT_NFL_WEEK is week 1 of the coming season, so this is
 * false all summer rather than lingering true from last January.
 */
function isPlayoffsUnderway() {
    return CURRENT_NFL_WEEK >= FIRST_PLAYOFF_WEEK && CURRENT_NFL_WEEK <= LAST_PLAYOFF_WEEK;
}

// Default standings view. Note > rather than >=: Wild Card week still opens on
// the season standings, and only the divisional round onwards defaults to the
// playoff view. isPlayoffsUnderway() is the wider test, used for the tab itself.
currentSubcategory = CURRENT_NFL_WEEK > FIRST_PLAYOFF_WEEK ? 'playoffs' : 'blazin';

// Team name aliases (CSV name -> standard name)
const TEAM_NAME_MAP = {
    'Buccs': 'Buccaneers',
    'Bucs': 'Buccaneers',
    'TB': 'Buccaneers',
    'NYJ': 'Jets',
    'JAX': 'Jaguars',
    'CLE': 'Browns',
    'CHI': 'Bears',
    'BUF': 'Bills',
    'NE': 'Patriots',
    'BAL': 'Ravens',
    'CIN': 'Bengals',
    'ARI': 'Cardinals',
    'HOU': 'Texans',
    'LV': 'Raiders',
    'PHI': 'Eagles',
    'LAC': 'Chargers',
    'KC': 'Chiefs',
    'WSH': 'Commanders',
    'NYG': 'Giants',
    'IND': 'Colts',
    'SEA': 'Seahawks',
    'TEN': 'Titans',
    'SF': '49ers',
    'GB': 'Packers',
    'DEN': 'Broncos',
    'DET': 'Lions',
    'LAR': 'Rams',
    'CAR': 'Panthers',
    'NO': 'Saints',
    'MIN': 'Vikings',
    'DAL': 'Cowboys',
    'MIA': 'Dolphins',
    'PIT': 'Steelers',
    'ATL': 'Falcons'
};

// Team abbreviations for fallback display when logos fail to load
const TEAM_ABBREVIATIONS = {
    'Falcons': 'ATL', 'Buccaneers': 'TB', 'Jets': 'NYJ', 'Jaguars': 'JAX',
    'Browns': 'CLE', 'Bears': 'CHI', 'Bills': 'BUF', 'Patriots': 'NE',
    'Ravens': 'BAL', 'Bengals': 'CIN', 'Cardinals': 'ARI', 'Texans': 'HOU',
    'Raiders': 'LV', 'Eagles': 'PHI', 'Chargers': 'LAC', 'Chiefs': 'KC',
    'Commanders': 'WSH', 'Giants': 'NYG', 'Colts': 'IND', 'Seahawks': 'SEA',
    'Titans': 'TEN', '49ers': 'SF', 'Packers': 'GB', 'Broncos': 'DEN',
    'Lions': 'DET', 'Rams': 'LAR', 'Panthers': 'CAR', 'Saints': 'NO',
    'Vikings': 'MIN', 'Cowboys': 'DAL', 'Dolphins': 'MIA', 'Steelers': 'PIT'
};

// Team colors for fallback display
const TEAM_COLORS = {
    'Falcons': '#A71930', 'Buccaneers': '#D50A0A', 'Jets': '#125740', 'Jaguars': '#006778',
    'Browns': '#311D00', 'Bears': '#0B162A', 'Bills': '#00338D', 'Patriots': '#002244',
    'Ravens': '#241773', 'Bengals': '#FB4F14', 'Cardinals': '#97233F', 'Texans': '#03202F',
    'Raiders': '#000000', 'Eagles': '#004C54', 'Chargers': '#0080C6', 'Chiefs': '#E31837',
    'Commanders': '#5A1414', 'Giants': '#0B2265', 'Colts': '#002C5F', 'Seahawks': '#002244',
    'Titans': '#0C2340', '49ers': '#AA0000', 'Packers': '#203731', 'Broncos': '#FB4F14',
    'Lions': '#0076B6', 'Rams': '#003594', 'Panthers': '#0085CA', 'Saints': '#D3BC8D',
    'Vikings': '#4F2683', 'Cowboys': '#003594', 'Dolphins': '#008E97', 'Steelers': '#FFB612'
};

// Helper to get team logo URL (handles aliases)
function getTeamLogo(teamName) {
    const normalized = TEAM_NAME_MAP[teamName] || teamName;
    return TEAM_LOGOS[normalized] || '';
}

// Helper to get team abbreviation for fallback
function getTeamAbbreviation(teamName) {
    const normalized = TEAM_NAME_MAP[teamName] || teamName;
    return TEAM_ABBREVIATIONS[normalized] || teamName.substring(0, 3).toUpperCase();
}

// Helper to get team color for fallback
function getTeamColor(teamName) {
    const normalized = TEAM_NAME_MAP[teamName] || teamName;
    return TEAM_COLORS[normalized] || '#666666';
}

// Format moneyline with + or - prefix
function formatMoneyline(ml) {
    if (ml === null || ml === undefined) return 'N/A';
    return ml > 0 ? `+${ml}` : `${ml}`;
}

// Handle logo load error - show abbreviation fallback
function handleLogoError(img, teamName) {
    const abbrev = getTeamAbbreviation(teamName);
    const color = getTeamColor(teamName);
    const fallback = document.createElement('span');
    fallback.className = 'team-logo-fallback';
    fallback.textContent = abbrev;
    fallback.style.backgroundColor = color;
    fallback.setAttribute('title', teamName);
    img.replaceWith(fallback);
}

// Toggle compact card expansion
function toggleCompactCard(card) {
    card.classList.toggle('expanded');
}

// Toggle full card expansion (shows hidden stats like Worst Week)
function toggleFullCard(card) {
    card.classList.toggle('expanded');
    const expandedStats = card.querySelectorAll('.expanded-stat');
    expandedStats.forEach(stat => stat.classList.toggle('hidden'));
}

// NFL Team Logos (ESPN CDN)
const TEAM_LOGOS = {
    'Falcons': 'https://a.espncdn.com/i/teamlogos/nfl/500/atl.png',
    'Buccaneers': 'https://a.espncdn.com/i/teamlogos/nfl/500/tb.png',
    'Jets': 'https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png',
    'Jaguars': 'https://a.espncdn.com/i/teamlogos/nfl/500/jax.png',
    'Browns': 'https://a.espncdn.com/i/teamlogos/nfl/500/cle.png',
    'Bears': 'https://a.espncdn.com/i/teamlogos/nfl/500/chi.png',
    'Bills': 'https://a.espncdn.com/i/teamlogos/nfl/500/buf.png',
    'Patriots': 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png',
    'Ravens': 'https://a.espncdn.com/i/teamlogos/nfl/500/bal.png',
    'Bengals': 'https://a.espncdn.com/i/teamlogos/nfl/500/cin.png',
    'Cardinals': 'https://a.espncdn.com/i/teamlogos/nfl/500/ari.png',
    'Texans': 'https://a.espncdn.com/i/teamlogos/nfl/500/hou.png',
    'Raiders': 'https://a.espncdn.com/i/teamlogos/nfl/500/lv.png',
    'Eagles': 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png',
    'Chargers': 'https://a.espncdn.com/i/teamlogos/nfl/500/lac.png',
    'Chiefs': 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png',
    'Commanders': 'https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png',
    'Giants': 'https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png',
    'Colts': 'https://a.espncdn.com/i/teamlogos/nfl/500/ind.png',
    'Seahawks': 'https://a.espncdn.com/i/teamlogos/nfl/500/sea.png',
    'Titans': 'https://a.espncdn.com/i/teamlogos/nfl/500/ten.png',
    '49ers': 'https://a.espncdn.com/i/teamlogos/nfl/500/sf.png',
    'Packers': 'https://a.espncdn.com/i/teamlogos/nfl/500/gb.png',
    'Broncos': 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
    'Lions': 'https://a.espncdn.com/i/teamlogos/nfl/500/det.png',
    'Rams': 'https://a.espncdn.com/i/teamlogos/nfl/500/lar.png',
    'Panthers': 'https://a.espncdn.com/i/teamlogos/nfl/500/car.png',
    'Saints': 'https://a.espncdn.com/i/teamlogos/nfl/500/no.png',
    'Vikings': 'https://a.espncdn.com/i/teamlogos/nfl/500/min.png',
    'Cowboys': 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png',
    'Dolphins': 'https://a.espncdn.com/i/teamlogos/nfl/500/mia.png',
    'Steelers': 'https://a.espncdn.com/i/teamlogos/nfl/500/pit.png'
};

// Fallback spreads for games - used when the Odds API doesn't return data (e.g., completed games).
// Weeks can be hardcoded here during the season; anything added belongs to
// HARDCODED_DATA_SEASON (below) and is cleared automatically once the season
// rolls over each July 1st.
const FALLBACK_SPREADS = {};

// NFL Games by Week - populated dynamically from the ESPN API.
// Weeks can be hardcoded here as an in-season fallback; when adding games,
// update HARDCODED_DATA_SEASON below to the season they belong to.
const NFL_GAMES_BY_WEEK = {};

// Season that any hardcoded FALLBACK_SPREADS / NFL_GAMES_BY_WEEK entries above
// belong to. If it isn't the current season the entries are stale leftovers,
// so they are cleared in place (part of the automatic July 1st offseason reset).
const HARDCODED_DATA_SEASON = 2026;
if (HARDCODED_DATA_SEASON !== CURRENT_SEASON) {
    console.log('[Season] Clearing stale hardcoded games/spreads from a previous season');
    for (const week in NFL_GAMES_BY_WEEK) delete NFL_GAMES_BY_WEEK[week];
    for (const week in FALLBACK_SPREADS) delete FALLBACK_SPREADS[week];
}

// Immediately merge historical games if available (historical-data.js loads before app.js)
if (typeof HISTORICAL_GAMES !== 'undefined') {
    for (const week in HISTORICAL_GAMES) {
        if (!NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[week].length === 0) {
            NFL_GAMES_BY_WEEK[week] = HISTORICAL_GAMES[week];
        }
    }
    console.log('Historical games merged into NFL_GAMES_BY_WEEK');
}

/**
 * Check if a game is locked (past week, kickoff time has passed, or game is final)
 * @param {object} game - The game object
 * @param {number} week - The week number (optional, defaults to currentWeek)
 */
function isGameLocked(game, week = null) {
    const checkWeek = week !== null ? week : currentWeek;

    // All games from previous weeks are locked (historical data)
    if (checkWeek < CURRENT_NFL_WEEK) {
        return true;
    }

    // Check kickoff time first - if game hasn't started, it can't be locked
    // (this prevents false positives from stale live data)
    if (game.kickoff) {
        const kickoffTime = new Date(game.kickoff);
        const now = new Date();
        if (now < kickoffTime) {
            return false; // Game hasn't started yet, definitely not locked
        }
    }

    // Check if game has a stored result (completed game)
    const weekResults = getResultsForWeek(checkWeek);
    if (weekResults && weekResults[game.id]) {
        return true;
    }

    // Check if game is final from live scores
    const liveData = getLiveGameStatus(game);
    if (liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed)) {
        return true;
    }

    // Kickoff time has passed (checked above), so game is locked
    if (game.kickoff) {
        return true;
    }

    return false;
}

// Live scores cache (populated from ESPN API)
let liveScoresCache = {};
let liveScoresRefreshTimer = null;

/**
 * Fetch live scores from ESPN API
 */
async function fetchLiveScores() {
    try {
        const response = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
        const data = await response.json();

        const scores = {};

        if (data.events) {
            data.events.forEach(event => {
                const { key, entry } = liveEntryFromEvent(event);
                scores[key] = entry;
            });
        }

        liveScoresCache = scores;
        return scores;
    } catch (error) {
        console.error('Error fetching live scores:', error);
        return liveScoresCache; // Return cached data on error
    }
}

/**
 * One ESPN scoreboard event, reduced to what this app keeps.
 *
 * Pulled out of the fetch so the shape ESPN hands over can be tested without
 * one - it is the only place the feed's layout is known, and the only place a
 * change in it would show up.
 */
function liveEntryFromEvent(event) {
    const competition = event.competitions[0];
    const competitors = competition.competitors;
    const homeTeam = competitors.find(c => c.homeAway === 'home');
    const awayTeam = competitors.find(c => c.homeAway === 'away');
    const status = event.status;
    const situation = competition.situation || {};

    // Possession arrives as a team id, which is meaningless anywhere else in
    // the app. Resolved to a side here, once.
    const possessionId = situation.possession;
    const possession = possessionId === undefined ? null
        : possessionId === homeTeam.team.id ? 'home'
        : possessionId === awayTeam.team.id ? 'away' : null;

    return {
        // Keyed by team names, which is how a game is matched back to it when
        // there is no id to match on.
        key: `${awayTeam.team.displayName}@${homeTeam.team.displayName}`,
        entry: {
            // The exact game. Team names alone cannot tell two meetings of the
            // same pair apart, and ESPN's scoreboard only ever carries the
            // current week - so a division rematch could otherwise put a live
            // score on the earlier fixture.
            espnId: event.id,
            homeTeam: homeTeam.team.displayName,
            awayTeam: awayTeam.team.displayName,
            homeScore: parseInt(homeTeam.score) || 0,
            awayScore: parseInt(awayTeam.score) || 0,
            status: status.type.name, // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL, etc.
            // ESPN's own short form, which already reads correctly in every
            // state: "11:37 - 3rd", "Halftime", "Final". Worth preferring to
            // anything hand-built from clock and period.
            statusDetail: status.type.shortDetail || status.type.detail,
            period: status.period,
            clock: status.displayClock,
            completed: status.type.completed,
            // Absent between drives and at the half, which is why the row
            // that shows them is dropped rather than left stale.
            possession,
            downDistance: situation.downDistanceText || '',
            shortDownDistance: situation.shortDownDistanceText || '',
            isRedZone: Boolean(situation.isRedZone)
        }
    };
}

/**
 * Get live score info for a specific game
 * First checks if game object has embedded status/scores (from ESPN schedule fetch),
 * then falls back to live scores cache
 */
/**
 * The live state of a game: score, status, clock.
 *
 * The cache first, because it is refreshed every couple of minutes while the
 * status embedded in a game is a snapshot from whenever the schedule was
 * fetched. Preferring the snapshot meant a score froze the moment a game
 * kicked off and only moved again on a page reload - the poll was updating a
 * cache that nothing read.
 *
 * The snapshot is still the fallback, which is what covers a week the
 * scoreboard is not currently carrying.
 */
function getLiveGameStatus(game) {
    const cached = liveCacheEntry(game);
    if (cached) return cached;

    if (game.status && game.status !== 'STATUS_SCHEDULED') {
        return {
            homeTeam: game.homeFull || game.home,
            awayTeam: game.awayFull || game.away,
            homeScore: game.homeScore || 0,
            awayScore: game.awayScore || 0,
            status: game.status,
            completed: game.completed || game.status === 'STATUS_FINAL'
        };
    }

    return null;
}

/**
 * The live-scores cache entry for a game, as fresh as the last poll.
 *
 * By ESPN id where the game has one, since team names cannot tell two meetings
 * of the same pair apart and the scoreboard only carries the current week.
 * Names are the fallback, for a game the schedule never matched to an event.
 */
function liveCacheEntry(game) {
    if (!game) return null;
    const entries = Object.values(liveScoresCache);

    if (game.espnId) {
        const byId = entries.find(e => e.espnId && String(e.espnId) === String(game.espnId));
        // A game with an id that the scoreboard is not carrying is not this
        // week's, and must not fall through to matching on names.
        return byId || null;
    }

    const awayName = game.away;
    const homeName = game.home;
    for (const scoreData of entries) {
        if ((scoreData.homeTeam.includes(homeName) || homeName.includes(scoreData.homeTeam.split(' ').pop())) &&
            (scoreData.awayTeam.includes(awayName) || awayName.includes(scoreData.awayTeam.split(' ').pop()))) {
            return scoreData;
        }
    }

    return null;
}

/**
 * ESPN Schedule API
 * Fetches game schedule for any NFL week
 */
const ESPN_SCHEDULE_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SCHEDULE_CACHE_KEY = 'nfl_schedule_cache';
const SCHEDULE_CACHE_VERSION = 8; // Increment to invalidate all caches (v8 stores a missing line as null, not 0)
const SCHEDULE_CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const PLAYOFF_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for playoffs (schedules may update)

/**
 * Validate that cached game data has the expected structure including full ESPN data
 */
function isValidGameData(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    // Check that at least the first game has required fields including ESPN metadata
    const game = data[0];
    return game && typeof game.id !== 'undefined' && game.away && game.home && game.day && game.kickoff;
}

/**
 * Get cached schedule from localStorage
 */
function getCachedSchedule(week) {
    try {
        const cached = localStorage.getItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`);
        if (!cached) return null;

        const parsed = JSON.parse(cached);
        const { timestamp, data, version } = parsed;

        // Invalidate old cache versions
        if (version !== SCHEDULE_CACHE_VERSION) {
            console.log(`[ESPN] Cache version mismatch for week ${week}, invalidating`);
            localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`);
            return null;
        }
        const age = Date.now() - timestamp;

        // Use shorter cache duration for playoff weeks
        const maxAge = isPlayoffWeek(week) ? PLAYOFF_CACHE_DURATION : SCHEDULE_CACHE_DURATION;

        if (age < maxAge) {
            // Validate data structure - treat invalid data as cache miss
            if (!isValidGameData(data)) {
                console.log(`[ESPN] Invalid/empty cache data for week ${week}, treating as cache miss`);
                localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`);
                return null;
            }
            const minsAgo = (age / (1000 * 60)).toFixed(0);
            console.log(`[ESPN] Using cached schedule for week ${week} (${minsAgo} mins old, ${data.length} games)`);
            // Sort cached data by kickoff time to ensure proper order
            data.sort((a, b) => {
                const timeA = a.kickoff ? new Date(a.kickoff).getTime() : 0;
                const timeB = b.kickoff ? new Date(b.kickoff).getTime() : 0;
                return timeA - timeB;
            });
            // Reassign IDs and recalculate day in ET timezone after sorting
            data.forEach((game, index) => {
                game.id = index + 1;
                // Recalculate day in ET timezone from kickoff
                if (game.kickoff) {
                    game.day = getDayName(new Date(game.kickoff));
                }
            });
            return data;
        }

        console.log(`[ESPN] Schedule cache expired for week ${week}`);
        localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`);
        return null;
    } catch (e) {
        console.warn('[ESPN] Error reading schedule cache:', e);
        return null;
    }
}

/**
 * Save schedule to localStorage cache
 */
function cacheSchedule(week, data) {
    // Validate data before caching
    if (!isValidGameData(data)) {
        console.log(`[ESPN] Not caching invalid/empty schedule for week ${week}`);
        return;
    }
    try {
        localStorage.setItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`, JSON.stringify({
            version: SCHEDULE_CACHE_VERSION,
            timestamp: Date.now(),
            data: data
        }));
        console.log(`[ESPN] Schedule cached for week ${week} (${data.length} games, v${SCHEDULE_CACHE_VERSION})`);
    } catch (e) {
        console.warn('[ESPN] Error caching schedule:', e);
    }
}

/**
 * Clean up old/corrupt schedule caches on startup
 * Removes caches with wrong version or invalid data
 */
function cleanupScheduleCaches() {
    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(SCHEDULE_CACHE_KEY)) {
                try {
                    const cached = JSON.parse(localStorage.getItem(key));
                    // Remove if wrong version or invalid data
                    if (!cached.version || cached.version !== SCHEDULE_CACHE_VERSION || !isValidGameData(cached.data)) {
                        keysToRemove.push(key);
                    }
                } catch (e) {
                    keysToRemove.push(key); // Remove corrupt entries
                }
            }
        }
        if (keysToRemove.length > 0) {
            keysToRemove.forEach(key => localStorage.removeItem(key));
            console.log(`[ESPN] Cleaned up ${keysToRemove.length} old/corrupt cache entries`);
        }
    } catch (e) {
        console.warn('[ESPN] Error during cache cleanup:', e);
    }
}

// Run cache cleanup on load
cleanupScheduleCaches();

/**
 * Format day name from date in ET timezone
 */
function getDayName(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'America/New_York'
    });
}

/**
 * Format time in ET
 */
function formatGameTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York'
    }) + ' ET';
}

/**
 * Extract team nickname from full team name
 * e.g., "Kansas City Chiefs" -> "Chiefs"
 */
function getTeamNickname(fullName) {
    // Handle special cases
    const specialCases = {
        'Washington Commanders': 'Commanders',
        'New York Giants': 'Giants',
        'New York Jets': 'Jets',
        'Los Angeles Rams': 'Rams',
        'Los Angeles Chargers': 'Chargers',
        'Las Vegas Raiders': 'Raiders',
        'New England Patriots': 'Patriots',
        'New Orleans Saints': 'Saints',
        'Green Bay Packers': 'Packers',
        'Kansas City Chiefs': 'Chiefs',
        'San Francisco 49ers': '49ers',
        'Tampa Bay Buccaneers': 'Buccaneers'
    };

    if (specialCases[fullName]) {
        return specialCases[fullName];
    }

    // Default: take the last word
    const parts = fullName.split(' ');
    return parts[parts.length - 1];
}

/**
 * Fetch NFL schedule from ESPN for a specific week
 */
async function fetchNFLSchedule(week, forceRefresh = false) {
    // Check cache first unless force refresh
    // Empty arrays are treated as cache misses - always try fresh fetch
    if (!forceRefresh) {
        const cached = getCachedSchedule(week);
        if (cached && cached.length > 0) {
            return cached;
        }
        if (cached && cached.length === 0) {
            console.log(`[ESPN] Empty cache for week ${week}, attempting fresh fetch`);
        }
    }

    try {
        let url;
        if (isPlayoffWeek(week)) {
            const playoffInfo = PLAYOFF_WEEKS[week];
            url = `${ESPN_SCHEDULE_URL}?seasontype=3&week=${playoffInfo.espnWeek}&dates=${CURRENT_SEASON}`;
            console.log(`[ESPN] Fetching playoff schedule for ${playoffInfo.name}...`);
        } else {
            url = `${ESPN_SCHEDULE_URL}?seasontype=2&week=${week}&dates=${CURRENT_SEASON}`;
            console.log(`[ESPN] Fetching schedule for week ${week}...`);
        }
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`ESPN API error: ${response.status}`);
        }

        const data = await response.json();
        const games = [];

        console.log(`[ESPN] Raw response for week ${week}:`, data.events?.length || 0, 'events');

        if (data.events) {
            let gameIndex = 0;
            data.events.forEach((event) => {
                console.log(`[ESPN] Event: "${event.name}", Date: ${event.date}, ID: ${event.id}`);
                const competition = event.competitions[0];
                const competitors = competition.competitors;

                // Skip events that aren't actual NFL games (e.g., Pro Bowl, NFL Experience)
                // Real games have exactly 2 competitors with valid team IDs
                if (!competitors || competitors.length !== 2) {
                    console.log(`[ESPN] Skipping non-game event: ${event.name}`);
                    return;
                }

                const homeTeam = competitors.find(c => c.homeAway === 'home');
                const awayTeam = competitors.find(c => c.homeAway === 'away');

                // Skip if teams don't look like real NFL teams
                if (!homeTeam?.team?.displayName || !awayTeam?.team?.displayName) {
                    console.log(`[ESPN] Skipping event with invalid teams: ${event.name}`);
                    return;
                }

                // Skip Pro Bowl and other exhibition games
                const eventName = (event.name || '').toLowerCase();
                if (eventName.includes('pro bowl') || eventName.includes('experience') ||
                    eventName.includes('skills') || eventName.includes('flag')) {
                    console.log(`[ESPN] Skipping exhibition event: ${event.name}`);
                    return;
                }

                const venue = competition.venue;
                const gameDate = new Date(event.date);

                // Extract game status and scores
                const status = event.status?.type?.name || 'STATUS_SCHEDULED';
                const completed = event.status?.type?.completed || false;
                const homeScore = parseInt(homeTeam.score) || 0;
                const awayScore = parseInt(awayTeam.score) || 0;

                games.push({
                    id: ++gameIndex,
                    espnId: event.id,
                    away: getTeamNickname(awayTeam.team.displayName),
                    home: getTeamNickname(homeTeam.team.displayName),
                    awayFull: awayTeam.team.displayName,
                    homeFull: homeTeam.team.displayName,
                    // No line yet. This MUST NOT be 0: a real pick'em is 0, and
                    // a placeholder that looks like one is scored as a pick'em
                    // rather than skipped - which silently grades a line pick
                    // straight up. hasUsableLine() is what tells them apart.
                    spread: null,
                    favorite: null,
                    day: getDayName(gameDate),
                    time: formatGameTime(event.date),
                    kickoff: event.date,
                    location: venue?.address ? [venue.address.city, venue.address.state].filter(Boolean).join(', ') : '',
                    stadium: venue?.fullName || '',
                    broadcast: competition.broadcasts?.[0]?.names?.[0] || '',
                    // Game status and scores from ESPN
                    status: status,
                    completed: completed,
                    homeScore: homeScore,
                    awayScore: awayScore
                });
            });
        }

        console.log(`[ESPN] Fetched ${games.length} games for week ${week}`);

        // Cache the results
        cacheSchedule(week, games);

        return games;
    } catch (error) {
        console.error(`[ESPN] Error fetching schedule for week ${week}:`, error);
        // Try to return stale cache on error
        const staleCache = localStorage.getItem(`${SCHEDULE_CACHE_KEY}_${CURRENT_SEASON}_week${week}`);
        if (staleCache) {
            console.log('[ESPN] Using stale cache due to fetch error');
            return JSON.parse(staleCache).data;
        }
        return null;
    }
}

/**
 * Load schedule for a week, merging ESPN data with existing spreads
 */
async function loadWeekSchedule(week, forceRefresh = false, skipSpreadsLoad = false) {
    // Pull this week's lines from the sheet before the games are built, so the
    // spread-application below has something to apply.
    //
    // This used to run for PLAYOFF weeks only. Every past regular-season week
    // therefore had no line source but this device's localStorage, because
    // prefetchAndSaveSpreads() only ever covers the current week and the next
    // one - so a phone that was not here in week 1 scored week 1 with no lines
    // at all, and graded every line pick straight up.
    //
    // Callers that load the spreads themselves pass skipSpreadsLoad.
    if (!skipSpreadsLoad) {
        await loadSpreadsFromGoogleSheets(week);
    }

    // For playoff weeks, fetch from ESPN
    if (isPlayoffWeek(week)) {
        const savedSpreads = getSavedSpreads();
        const weekStr = String(week);

        // Helper to apply saved spreads and fallback spreads to playoff games
        const applySpreadsToGames = (gameList) => {
            if (!gameList) return;
            const weekNum = parseInt(week); // Ensure numeric key for FALLBACK_SPREADS lookup
            gameList.forEach(game => {
                const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;

                // Only apply if the game has no usable line of its own
                if (!hasUsableSpread(game)) {
                    // Try saved spreads first (from localStorage - uses string keys)
                    if (savedSpreads[week] && savedSpreads[week][key]) {
                        game.spread = savedSpreads[week][key].spread;
                        game.favorite = savedSpreads[week][key].favorite;
                        if (savedSpreads[week][key].overUnder) {
                            game.overUnder = savedSpreads[week][key].overUnder;
                        }
                        console.log(`[Schedule] Applied saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
                    }
                    // Fall back to hardcoded fallback spreads (uses numeric keys)
                    else if (FALLBACK_SPREADS[weekNum] && FALLBACK_SPREADS[weekNum][key]) {
                        game.spread = FALLBACK_SPREADS[weekNum][key].spread;
                        game.favorite = FALLBACK_SPREADS[weekNum][key].favorite;
                        if (FALLBACK_SPREADS[weekNum][key].overUnder) {
                            game.overUnder = FALLBACK_SPREADS[weekNum][key].overUnder;
                        }
                        console.log(`[Schedule] Applied fallback spread for ${game.away} @ ${game.home}: ${game.spread}`);
                    }
                }
                // Apply O/U if missing
                if (!game.overUnder || game.overUnder === 0) {
                    if (savedSpreads[week] && savedSpreads[week][key] && savedSpreads[week][key].overUnder) {
                        game.overUnder = savedSpreads[week][key].overUnder;
                    } else if (FALLBACK_SPREADS[weekNum] && FALLBACK_SPREADS[weekNum][key] && FALLBACK_SPREADS[weekNum][key].overUnder) {
                        game.overUnder = FALLBACK_SPREADS[weekNum][key].overUnder;
                    }
                }
            });
        };

        // Fetch ESPN games first
        const espnGames = await fetchNFLSchedule(week, forceRefresh);
        const normalizeTeam = (name) => TEAM_NAME_MAP[name] || name;

        // Check if we have historical games for this playoff week (preserves pick ID mapping)
        const historicalGames = HISTORICAL_GAMES && (HISTORICAL_GAMES[week] || HISTORICAL_GAMES[weekStr]);

        if (espnGames && espnGames.length > 0) {
            let mergedGames = [];
            const usedEspnIndices = new Set();

            // First, add historical games with ESPN data merged in (preserving IDs)
            if (historicalGames && historicalGames.length > 0) {
                historicalGames.forEach(histGame => {
                    const histAway = normalizeTeam(histGame.away).toLowerCase();
                    const histHome = normalizeTeam(histGame.home).toLowerCase();
                    const espnIndex = espnGames.findIndex(eg =>
                        eg.away.toLowerCase() === histAway && eg.home.toLowerCase() === histHome
                    );

                    if (espnIndex !== -1) {
                        const espnMatch = espnGames[espnIndex];
                        usedEspnIndices.add(espnIndex);
                        // Merge ESPN data (scores, status, times) with historical data (ID, spread)
                        mergedGames.push({
                            ...histGame,
                            espnId: espnMatch.espnId,
                            day: espnMatch.day || histGame.day,
                            time: espnMatch.time || histGame.time,
                            kickoff: espnMatch.kickoff || histGame.kickoff,
                            location: espnMatch.location || histGame.location,
                            stadium: espnMatch.stadium || histGame.stadium,
                            broadcast: espnMatch.broadcast,
                            status: espnMatch.status,
                            completed: espnMatch.completed,
                            homeScore: espnMatch.homeScore,
                            awayScore: espnMatch.awayScore
                        });
                    } else {
                        mergedGames.push(histGame);
                    }
                });
            }

            // Then, add any ESPN games that weren't in historical data (upcoming games)
            // These get IDs starting after the last historical game ID
            const nextId = historicalGames ? historicalGames.length + 1 : 1;
            espnGames.forEach((espnGame, index) => {
                if (!usedEspnIndices.has(index)) {
                    mergedGames.push({
                        ...espnGame,
                        id: nextId + (mergedGames.length - (historicalGames ? historicalGames.length : 0))
                    });
                }
            });

            // Sort by kickoff time to keep games in chronological order
            mergedGames.sort((a, b) => {
                const timeA = a.kickoff ? new Date(a.kickoff).getTime() : 0;
                const timeB = b.kickoff ? new Date(b.kickoff).getTime() : 0;
                return timeA - timeB;
            });

            applySpreadsToGames(mergedGames);
            NFL_GAMES_BY_WEEK[week] = mergedGames;
            console.log(`[Schedule] Merged ${mergedGames.length} ${getWeekDisplayName(week)} games (${historicalGames ? historicalGames.length : 0} historical + ${mergedGames.length - (historicalGames ? historicalGames.length : 0)} ESPN)`);
            return mergedGames;
        } else if (historicalGames && historicalGames.length > 0) {
            // No ESPN data, use historical games only
            applySpreadsToGames(historicalGames);
            NFL_GAMES_BY_WEEK[week] = historicalGames;
            console.log(`[Schedule] Using ${historicalGames.length} historical ${getWeekDisplayName(week)} games (no ESPN data)`);
            return historicalGames;
        }

        // No historical or ESPN data available
        NFL_GAMES_BY_WEEK[week] = [];
        console.warn(`[Schedule] No games found for ${getWeekDisplayName(week)}`);
        return NFL_GAMES_BY_WEEK[week];
    }

    // For current/future regular season weeks, use cached Google Sheets games if available
    // For historical weeks, always merge with ESPN to get full game info (status, location, etc.)
    if (!forceRefresh && week >= CURRENT_NFL_WEEK && NFL_GAMES_BY_WEEK[week] && NFL_GAMES_BY_WEEK[week].length > 0) {
        console.log(`[Schedule] Using existing games for week ${week} (${NFL_GAMES_BY_WEEK[week].length} games)`);
        return NFL_GAMES_BY_WEEK[week];
    }

    // For historical weeks, merge ESPN data with historical IDs
    // ESPN provides full game info (status, location, scores) but historical data has correct IDs for picks
    if (week < CURRENT_NFL_WEEK && HISTORICAL_GAMES && HISTORICAL_GAMES[week]) {
        const historicalGames = HISTORICAL_GAMES[week];
        const espnGames = await fetchNFLSchedule(week, forceRefresh);

        if (espnGames && espnGames.length > 0) {
            // Get saved spreads for fallback
            const savedSpreads = getSavedSpreads();
            // Helper to normalize team names using TEAM_NAME_MAP
            const normalizeTeam = (name) => TEAM_NAME_MAP[name] || name;
            // Match ESPN games to historical games by team names and merge
            const mergedGames = historicalGames.map(histGame => {
                // Normalize historical team names for comparison
                const histAway = normalizeTeam(histGame.away).toLowerCase();
                const histHome = normalizeTeam(histGame.home).toLowerCase();
                // Find matching ESPN game by normalized team names
                const espnMatch = espnGames.find(eg =>
                    eg.away.toLowerCase() === histAway && eg.home.toLowerCase() === histHome
                );

                if (espnMatch) {
                    const key = `${histGame.away.toLowerCase()}_${histGame.home.toLowerCase()}`;
                    // Use saved spread if historical spread is missing
                    let spread = hasUsableLine(histGame.spread) ? histGame.spread : espnMatch.spread;
                    let favorite = hasUsableLine(histGame.spread) ? histGame.favorite : espnMatch.favorite;
                    if (!hasUsableLine(spread) && savedSpreads[week] && savedSpreads[week][key]) {
                        spread = savedSpreads[week][key].spread;
                        favorite = savedSpreads[week][key].favorite;
                    }
                    // Merge: use historical ID, best available spread, ESPN for everything else
                    return {
                        ...espnMatch,
                        id: histGame.id,
                        spread: spread,
                        favorite: favorite
                    };
                }
                // If no ESPN match, use historical data with defaults
                return {
                    ...histGame,
                    status: 'final',
                    awayScore: HISTORICAL_RESULTS[week]?.[histGame.id]?.awayScore || 0,
                    homeScore: HISTORICAL_RESULTS[week]?.[histGame.id]?.homeScore || 0
                };
            });

            NFL_GAMES_BY_WEEK[week] = mergedGames;
            console.log(`[Schedule] Merged ESPN data with historical IDs for week ${week}`);
            return mergedGames;
        }

        // Fallback: use historical data with status/scores added
        const gamesWithStatus = historicalGames.map(game => ({
            ...game,
            status: 'final',
            awayScore: HISTORICAL_RESULTS[week]?.[game.id]?.awayScore || 0,
            homeScore: HISTORICAL_RESULTS[week]?.[game.id]?.homeScore || 0
        }));
        NFL_GAMES_BY_WEEK[week] = gamesWithStatus;
        console.log(`[Schedule] Using historical data for week ${week} (ESPN unavailable)`);
        return gamesWithStatus;
    }

    // Save existing hardcoded spreads before fetching ESPN data
    const existingGames = NFL_GAMES_BY_WEEK[week] || [];
    const existingSpreads = {};
    existingGames.forEach(game => {
        // Create a key based on team matchup
        const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
        if (hasUsableLine(game.spread)) {
            existingSpreads[key] = { spread: game.spread, favorite: game.favorite };
        }
    });

    // Fetch fresh schedule from ESPN
    const espnGames = await fetchNFLSchedule(week, forceRefresh);

    if (espnGames && espnGames.length > 0) {
        // Merge existing spreads into ESPN data
        // Get saved spreads once for efficiency
        const savedSpreads = getSavedSpreads();
        espnGames.forEach(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
            if (existingSpreads[key]) {
                game.spread = existingSpreads[key].spread;
                game.favorite = existingSpreads[key].favorite;
                console.log(`[Schedule] Preserved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }
            // Apply saved spreads for games still without a line (from previous API fetches)
            if (!hasUsableSpread(game) && hasUsableLine(savedSpreads[week]?.[key]?.spread)) {
                game.spread = savedSpreads[week][key].spread;
                game.favorite = savedSpreads[week][key].favorite;
                if (savedSpreads[week][key].overUnder) {
                    game.overUnder = savedSpreads[week][key].overUnder;
                }
                console.log(`[Schedule] Applied saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }
            // Apply hardcoded fallback spreads for games still without a line (use parseInt for numeric key lookup)
            const weekNum = parseInt(week);
            if (!hasUsableSpread(game) && FALLBACK_SPREADS[weekNum] && FALLBACK_SPREADS[weekNum][key]) {
                game.spread = FALLBACK_SPREADS[weekNum][key].spread;
                game.favorite = FALLBACK_SPREADS[weekNum][key].favorite;
                console.log(`[Schedule] Applied fallback spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }
        });
        // Sort games by kickoff time
        espnGames.sort((a, b) => {
            const timeA = a.kickoff ? new Date(a.kickoff).getTime() : 0;
            const timeB = b.kickoff ? new Date(b.kickoff).getTime() : 0;
            return timeA - timeB;
        });
        // Reassign IDs after sorting to maintain sequential order
        espnGames.forEach((game, index) => {
            game.id = index + 1;
        });
        NFL_GAMES_BY_WEEK[week] = espnGames;
        // Re-cache with sorted order
        cacheSchedule(week, espnGames);
        console.log(`[Schedule] Loaded ${espnGames.length} games for week ${week} from ESPN (sorted by kickoff)`);
    } else if (!NFL_GAMES_BY_WEEK[week]) {
        // Fallback to empty array if no data available
        NFL_GAMES_BY_WEEK[week] = [];
        console.warn(`[Schedule] No games found for week ${week}`);
    }

    // Migrate any stored picks to matchup keys now that games are available
    migrateWeekPicksToMatchupKeys(week);

    return NFL_GAMES_BY_WEEK[week];
}

/**
 * Migrate stored picks from numeric IDs to matchup keys for a specific week
 * This ensures picks remain matched to the correct games regardless of data source
 */
function migrateWeekPicksToMatchupKeys(week) {
    const weekGames = NFL_GAMES_BY_WEEK[week];
    if (!weekGames || weekGames.length === 0) return;

    const weekPicks = allPicks[week];
    if (!weekPicks) return;

    let converted = 0;
    const orphans = [];

    for (const picker in weekPicks) {
        const rekeyed = rekeyPicksByMatchup(weekPicks[picker], weekGames);
        if (rekeyed.converted > 0) {
            allPicks[week][picker] = rekeyed.picks;
            converted += rekeyed.converted;
        }
        rekeyed.orphans.forEach(key => orphans.push(`${picker}:${key}`));
    }

    // Orphans are kept, not dropped - but they are a symptom (a stale key, or a
    // schedule that changed under stored picks), so make them visible.
    if (orphans.length > 0) {
        console.warn(`[Picks] Week ${week}: ${orphans.length} pick key(s) match no game this week:`, orphans);
    }

    if (converted > 0) {
        console.warn(`[Picks] Week ${week}: converted ${converted} legacy game-id pick key(s) to matchup keys`);
        savePicksToStorage(false, true); // Save without toast, skip sync
    }
}

/**
 * Odds API cache configuration
 * Note: API key is stored in Cloudflare Worker environment variables
 */
const ODDS_CACHE_KEY = 'nfl_odds_cache';
const ODDS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const SAVED_SPREADS_KEY = `nfl_saved_spreads_${CURRENT_SEASON}`; // Permanent storage for spreads, season-scoped (used for completed games)

// Last seen Odds API quota, for the admin readout. The worker paces its own
// cache against this, so the display is a window onto that rather than
// something anyone needs to act on.
let apiQuota = { remaining: null, used: null, window: null };

function recordApiQuota(remaining, used, cacheWindow) {
    if (remaining !== null && remaining !== undefined) apiQuota.remaining = Number(remaining);
    if (used !== null && used !== undefined) apiQuota.used = Number(used);
    if (cacheWindow) apiQuota.window = cacheWindow;
    renderApiQuota();
}

function renderApiQuota() {
    const el = document.getElementById('api-quota');
    if (!el || apiQuota.remaining === null) return;

    const total = apiQuota.remaining + (apiQuota.used || 0);
    const low = apiQuota.remaining < 100;
    el.textContent = `Odds API: ${apiQuota.remaining} left${total ? ` of ${total}` : ''}`;
    el.title = apiQuota.window
        ? `Refreshing every ${apiQuota.window}`
        : 'Odds API credits left this month';
    el.classList.toggle('low', low);
}

/**
 * Get cached odds from localStorage
 */
function getCachedOdds() {
    try {
        const cached = localStorage.getItem(ODDS_CACHE_KEY);
        if (!cached) return null;

        const { timestamp, data } = JSON.parse(cached);
        const age = Date.now() - timestamp;

        if (age < ODDS_CACHE_DURATION) {
            const hoursAgo = (age / (1000 * 60 * 60)).toFixed(1);
            console.log(`[Odds API] Using cached odds (${hoursAgo} hours old)`);
            return data;
        }

        console.log('[Odds API] Cache expired, will fetch fresh data');
        return null;
    } catch (e) {
        console.warn('[Odds API] Error reading cache:', e);
        return null;
    }
}

/**
 * Save odds to localStorage cache
 */
function cacheOdds(data) {
    try {
        localStorage.setItem(ODDS_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            data: data
        }));
        console.log('[Odds API] Odds cached for 24 hours');
    } catch (e) {
        console.warn('[Odds API] Error caching odds:', e);
    }
}

/**
 * Get saved spreads from localStorage (permanent storage for completed games)
 * Returns object: { week: { 'away_home': { spread, favorite, overUnder } } }
 */
function getSavedSpreads() {
    try {
        const saved = localStorage.getItem(SAVED_SPREADS_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch (e) {
        console.warn('[Spreads] Error reading saved spreads:', e);
        return {};
    }
}

/**
 * Save a spread to localStorage (permanent storage)
 * This is called when we get spreads from the API, so they're preserved after games complete
 */
function saveSpread(week, awayTeam, homeTeam, spread, favorite, overUnder = null) {
    try {
        const saved = getSavedSpreads();
        if (!saved[week]) saved[week] = {};

        const key = `${awayTeam.toLowerCase()}_${homeTeam.toLowerCase()}`;
        saved[week][key] = { spread, favorite };
        if (overUnder !== null) {
            saved[week][key].overUnder = overUnder;
        }

        localStorage.setItem(SAVED_SPREADS_KEY, JSON.stringify(saved));
    } catch (e) {
        console.warn('[Spreads] Error saving spread:', e);
    }
}

/**
 * True while a game's line can still legitimately change: it is in the current
 * week or later and its kickoff is known and still ahead. Once a game has
 * kicked off its line is fixed for grading, and a game whose kickoff we do not
 * know is left alone rather than guessed at.
 */
function lineStillOpen(game, week) {
    if (parseInt(week) < CURRENT_NFL_WEEK) return false;
    if (!game.kickoff) return false;
    return new Date(game.kickoff) > new Date();
}

/**
 * Apply saved spreads to the games in memory.
 *
 * A game with no line takes the saved one - that is how a completed game keeps
 * showing the spread it was played at. A game that has NOT kicked off also
 * takes the saved one when it differs: the saved bucket is refreshed from the
 * shared sheet, so it is as fresh as the last device to hit the Odds API,
 * whereas the game object may be carrying whatever this device stored a week
 * ago. Seahawks -10 (the lookahead line before Darnold's injury) sat on one
 * screen through a whole Sunday of everyone else seeing -3.5 because this only
 * ever filled in a blank.
 *
 * A game that has kicked off keeps the line it has: the same rule as
 * applyOddsData(), which stops writing spreads at kickoff.
 */
function applySavedSpreads() {
    const saved = getSavedSpreads();
    let appliedCount = 0;

    Object.entries(NFL_GAMES_BY_WEEK).forEach(([week, games]) => {
        if (!games) return;

        games.forEach(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;

            // If game has a spread but we don't have it saved, save it now (preserves spreads before games complete)
            if (hasUsableLine(game.spread) && (!saved[week] || !saved[week][key])) {
                saveSpread(week, game.away, game.home, game.spread, game.favorite, game.overUnder);
                console.log(`[Spreads] Auto-saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }

            // A blank sheet cell reads as '', which is not a line and must not
            // be copied onto the game.
            const savedLine = saved[week]?.[key];
            if (!hasUsableLine(savedLine?.spread)) return;

            const differs = Number(savedLine.spread) !== Number(game.spread)
                || savedLine.favorite !== game.favorite;
            const takeSaved = !hasUsableSpread(game)
                || (differs && lineStillOpen(game, week));
            if (!takeSaved) return;

            game.spread = savedLine.spread;
            game.favorite = savedLine.favorite;
            if (savedLine.overUnder && (!game.overUnder || game.overUnder === 0)) {
                game.overUnder = savedLine.overUnder;
            }
            appliedCount++;
            console.log(`[Spreads] Applied saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
        });
    });

    if (appliedCount > 0) {
        console.log(`[Spreads] Applied ${appliedCount} saved spreads`);
    }
}

/**
 * Check if today is an NFL game day (Thursday, Saturday, Sunday, Monday)
 * Games typically occur on these days during the season
 */
function isNFLGameDay() {
    const day = new Date().getDay();
    // 0 = Sunday, 1 = Monday, 4 = Thursday, 5 = Friday (holiday weeks), 6 = Saturday
    // Friday added for holiday week games (e.g., day after Christmas)
    return day === 0 || day === 1 || day === 4 || day === 5 || day === 6;
}

/**
 * Fetch current NFL odds from The Odds API via worker proxy
 * Fetches spreads, moneyline (h2h), and totals (over/under)
 * Uses DraftKings as the primary source
 */
async function fetchNFLOdds(forceRefresh = false) {
    // Returns { games, fresh } or null. `fresh` is true only when the lines came
    // from the worker on this call; false means this device's own localStorage
    // copy, which may be up to a day old and must never be pushed to the sheet.
    // Check cache first unless force refresh
    if (!forceRefresh) {
        const cached = getCachedOdds();
        if (cached) return { games: cached, fresh: false };
    }

    try {
        console.log('[Odds API] Fetching odds via worker proxy...');
        const response = await fetch(`${WORKER_PROXY_URL}/odds`);

        if (!response.ok) {
            throw new Error(`Odds API error: ${response.status}`);
        }

        const games = await response.json();

        // Log remaining API requests from headers
        const remaining = response.headers.get('x-requests-remaining');
        const used = response.headers.get('x-requests-used');
        if (remaining) {
            console.log(`[Odds API] Requests used: ${used}, remaining: ${remaining}`);
        }
        // The worker forwards these on cache hits too, so this stays current
        // without costing a call. It also reports the window its pacer chose.
        recordApiQuota(remaining, used, response.headers.get('X-Cache-Duration'));

        console.log(`[Odds API] Fetched odds for ${games.length} games`);

        // Cache the results
        cacheOdds(games);

        return { games, fresh: true };
    } catch (error) {
        console.warn('[Odds API] Fetch failed:', error.message);

        // Try stale cache on error
        const staleCache = localStorage.getItem(ODDS_CACHE_KEY);
        if (staleCache) {
            console.log('[Odds API] Using stale cache due to fetch error');
            return { games: JSON.parse(staleCache).data, fresh: false };
        }
        return null;
    }
}

/**
 * Check if current week has hardcoded fallback spreads
 */
function hasHardcodedSpreads(week) {
    const games = NFL_GAMES_BY_WEEK[week];
    if (!games || games.length === 0) return false;
    // Check if at least one game carries a usable line
    return games.some(g => hasUsableLine(g.spread));
}

/**
 * Update NFL_GAMES_BY_WEEK with odds from The Odds API
 * Includes spreads, moneyline (h2h), and totals (over/under)
 *
 * Hybrid approach to conserve API calls:
 * - Game days: Fetch fresh odds from API
 * - Non-game days with cached odds: Use cached data (no API call)
 * - Non-game days with fallback spreads: Use fallbacks (no API call)
 * - Non-game days without cache or fallbacks: Fetch from API (first playoff load)
 *
 * This ensures playoff weeks also conserve API calls after the first fetch.
 *
 * @param {boolean} forceRefresh - If true, bypass cache and fetch fresh data
 * @returns {Promise<boolean>} true only when lines FROM THE WORKER were applied
 *   on this call. Every fallback - this device's cached odds, hardcoded
 *   spreads - applies what it can and returns false, because those numbers
 *   may be a day old and the caller must not push them to the shared sheet.
 *   The admin refresh button and prefetchAndSaveSpreads both gate on it.
 */
async function updateOddsFromAPI(forceRefresh = false) {
    const cached = getCachedOdds();
    const isGameDay = isNFLGameDay();
    const hasFallbackSpreads = hasHardcodedSpreads(currentWeek);
    const isPlayoff = isPlayoffWeek(currentWeek);

    // Hybrid logic to conserve API calls on non-game days:
    // 1. If we have valid cached odds → use them (works for both regular season and playoffs)
    // 2. If we have fallback spreads → use them (regular season only)
    // 3. Otherwise → need to fetch from API
    if (!forceRefresh && !isGameDay) {
        // Priority 1: Use cached odds if available (applies to playoffs too)
        if (cached) {
            console.log(`[Odds API] Non-game day - using cached odds${isPlayoff ? ' (playoff week)' : ''}`);
            applyOddsData(cached);
            return false;
        }
        // Priority 2: Use fallback spreads for regular season
        if (hasFallbackSpreads) {
            console.log('[Odds API] Non-game day with fallback spreads - skipping API call');
            return false;
        }
        // No cache and no fallbacks - need to fetch (first load of playoff week)
        console.log(`[Odds API] Non-game day but no cached odds${isPlayoff ? ' for playoff week' : ''} - fetching from API`);
    }

    // Fetch odds from API (will use cache if valid)
    const fetched = await fetchNFLOdds(forceRefresh);
    if (!fetched) {
        console.warn('[Odds API] Could not fetch odds');
        // Fall back to cached data or hardcoded spreads
        if (cached) {
            console.log('[Odds API] API failed, using stale cached odds');
            applyOddsData(cached);
        } else if (hasFallbackSpreads) {
            console.log('[Odds API] API failed, using hardcoded fallback spreads');
        }
        return false;
    }

    applyOddsData(fetched.games);
    if (!fetched.fresh) {
        console.log('[Odds API] Applied this device\'s cached odds - not fresh, not for syncing');
    }
    return fetched.fresh;
}

/**
 * Apply odds data to NFL_GAMES_BY_WEEK
 */
function applyOddsData(oddsData) {

    let updatedCount = 0;

    // Process each game from the API
    oddsData.forEach(game => {
        const homeTeam = game.home_team;
        const awayTeam = game.away_team;

        // Find bookmaker (prefer DraftKings, fallback to FanDuel)
        const bookmaker = game.bookmakers?.find(b => b.key === 'draftkings') ||
                          game.bookmakers?.find(b => b.key === 'fanduel');

        if (!bookmaker) return;

        // Extract spread data
        const spreadsMarket = bookmaker.markets?.find(m => m.key === 'spreads');
        let spread = null;
        let favorite = null;
        if (spreadsMarket) {
            const homeOutcome = spreadsMarket.outcomes?.find(o => o.name === homeTeam);
            if (homeOutcome) {
                const homeSpread = homeOutcome.point;
                spread = Math.abs(homeSpread);
                favorite = homeSpread < 0 ? 'home' : 'away';
            }
        }

        // Extract moneyline data
        const h2hMarket = bookmaker.markets?.find(m => m.key === 'h2h');
        let homeMoneyline = null;
        let awayMoneyline = null;
        if (h2hMarket) {
            const homeOutcome = h2hMarket.outcomes?.find(o => o.name === homeTeam);
            const awayOutcome = h2hMarket.outcomes?.find(o => o.name === awayTeam);
            if (homeOutcome) homeMoneyline = homeOutcome.price;
            if (awayOutcome) awayMoneyline = awayOutcome.price;
        }

        // Extract totals (over/under) data
        const totalsMarket = bookmaker.markets?.find(m => m.key === 'totals');
        let overUnder = null;
        if (totalsMarket) {
            const overOutcome = totalsMarket.outcomes?.find(o => o.name === 'Over');
            if (overOutcome) {
                overUnder = overOutcome.point;
            }
        }

        // Match to our games by team name
        for (const week in NFL_GAMES_BY_WEEK) {
            const weekGames = NFL_GAMES_BY_WEEK[week];
            if (!weekGames || weekGames.length === 0) continue;

            for (const weekGame of weekGames) {
                // Match by full team name or nickname
                const homeTeamLower = homeTeam.toLowerCase();
                const awayTeamLower = awayTeam.toLowerCase();
                const gameHomeLower = weekGame.home.toLowerCase();
                const gameAwayLower = weekGame.away.toLowerCase();
                const gameHomeFullLower = (weekGame.homeFull || weekGame.home).toLowerCase();
                const gameAwayFullLower = (weekGame.awayFull || weekGame.away).toLowerCase();

                // Check if home teams match
                const homeMatch = homeTeamLower === gameHomeFullLower ||
                                  homeTeamLower.includes(gameHomeLower) ||
                                  gameHomeLower.includes(homeTeamLower.split(' ').pop());

                // Check if away teams match
                const awayMatch = awayTeamLower === gameAwayFullLower ||
                                  awayTeamLower.includes(gameAwayLower) ||
                                  gameAwayLower.includes(awayTeamLower.split(' ').pop());

                if (homeMatch && awayMatch) {
                    // NEVER update spreads for games that have already started
                    // Once a game begins, the line is locked for pick evaluation
                    const weekNum = parseInt(week);
                    const gameHasStarted = weekNum < CURRENT_NFL_WEEK ||
                        (weekGame.kickoff && new Date(weekGame.kickoff) <= new Date());

                    if (gameHasStarted) {
                        // Game has started - only update moneylines for display
                        // Spreads and over/under are locked for pick evaluation
                        if (homeMoneyline !== null) weekGame.homeMoneyline = homeMoneyline;
                        if (awayMoneyline !== null) weekGame.awayMoneyline = awayMoneyline;
                        // Skip spread and over/under updates - lines are locked
                        break;
                    }

                    // Game hasn't started - safe to update all odds data
                    if (spread !== null) {
                        weekGame.spread = spread;
                        weekGame.favorite = favorite;
                        // Save spread permanently so it's preserved after the game completes
                        saveSpread(week, weekGame.away, weekGame.home, spread, favorite, overUnder);
                    }
                    if (homeMoneyline !== null) weekGame.homeMoneyline = homeMoneyline;
                    if (awayMoneyline !== null) weekGame.awayMoneyline = awayMoneyline;
                    if (overUnder !== null) weekGame.overUnder = overUnder;
                    updatedCount++;
                    break;
                }
            }
        }
    });

    // Debug: log matching details
    console.log('[Odds API] API games:', oddsData.map(g => `${g.away_team} @ ${g.home_team}`));
    console.log('[Odds API] Local games by week:', Object.entries(NFL_GAMES_BY_WEEK).map(([w, games]) =>
        `Week ${w}: ${games?.length || 0} games - ${games?.slice(0, 2).map(g => `${g.away} @ ${g.home}`).join(', ') || 'none'}`
    ));

    // Debug: log unmatched games from the API
    if (updatedCount === 0) {
        console.log('[Odds API] No games matched! First few API games:', oddsData.slice(0, 3).map(g => `${g.away_team} @ ${g.home_team}`));
        console.log('[Odds API] First few local games:', Object.values(NFL_GAMES_BY_WEEK).flat().slice(0, 3).map(g => `${g.away} @ ${g.home} (${g.awayFull || 'no full'} @ ${g.homeFull || 'no full'})`));
    }

    console.log(`[Odds API] Applied odds to ${updatedCount} games`);

    // First, apply saved spreads (from previous API fetches) for completed games
    applySavedSpreads();

    // Then apply fallback spreads for any games still at 0 (e.g., games never fetched from API)
    Object.entries(NFL_GAMES_BY_WEEK).forEach(([week, games]) => {
        const weekNum = parseInt(week); // Convert to number for FALLBACK_SPREADS lookup
        if (!games || !FALLBACK_SPREADS[weekNum]) return;
        games.forEach(game => {
            if (!hasUsableSpread(game)) {
                const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
                if (FALLBACK_SPREADS[weekNum][key]) {
                    game.spread = FALLBACK_SPREADS[weekNum][key].spread;
                    game.favorite = FALLBACK_SPREADS[weekNum][key].favorite;
                    console.log(`[Odds API] Applied fallback spread for ${game.away} @ ${game.home}: ${game.spread}`);
                }
            }
        });
    });

    // Debug: log what weeks have games loaded
    console.log('[Odds API] Weeks with games:', Object.keys(NFL_GAMES_BY_WEEK).filter(w => NFL_GAMES_BY_WEEK[w]?.length > 0));

    // Re-cache schedules with updated spreads so they persist
    Object.entries(NFL_GAMES_BY_WEEK).forEach(([week, games]) => {
        if (games && games.length > 0) {
            // Only re-cache if any game has a spread (to preserve the data)
            const hasSpread = games.some(g => hasUsableLine(g.spread));
            if (hasSpread) {
                cacheSchedule(parseInt(week), games);
            }
        }
    });

    // Re-render if we're on the picks tab
    if (currentCategory === 'make-picks') {
        renderGames();
    }

    return true;
}

// Keep old function name for backwards compatibility
async function updateSpreadsFromAPI(forceRefresh = false) {
    return updateOddsFromAPI(forceRefresh);
}

// How long to wait between live-score fetches.
//
// Two rates, because shouldPollLiveScores() stays true on nothing but
// scheduled games - which is most of the week. Half a minute is right while
// something is being played and wasteful when the only thing to catch is a
// kickoff.
const LIVE_REFRESH_PLAYING_MS = 30000;
const LIVE_REFRESH_WAITING_MS = 120000;

/** True while any game is actually being played. */
function anyGameInProgress() {
    return Object.values(liveScoresCache)
        .some(scoreData => LIVE_IN_PROGRESS_STATUSES.includes(scoreData.status));
}

/** How long to wait before the next fetch. */
function liveRefreshDelay() {
    return anyGameInProgress() ? LIVE_REFRESH_PLAYING_MS : LIVE_REFRESH_WAITING_MS;
}

/**
 * Check if we should keep polling for live scores
 * Returns true if any games are in progress OR scheduled (not yet final)
 */
function shouldPollLiveScores() {
    const scores = Object.values(liveScoresCache);
    if (scores.length === 0) return false;

    for (const scoreData of scores) {
        // Keep polling if any game is in progress (a delay included - it
        // resumes, and the resumption is exactly what the poll is for)
        if (LIVE_IN_PROGRESS_STATUSES.includes(scoreData.status)) {
            return true;
        }
        // Also keep polling if games are scheduled (to catch when they start)
        if (scoreData.status === 'STATUS_SCHEDULED') {
            return true;
        }
    }
    // All games are final - no need to poll
    return false;
}

function startLiveScoresRefresh() {
    stopLiveScoresRefresh();

    // Fetch immediately to get current game states
    fetchLiveScores().then(async () => {
        // Only render if initial load is complete (odds have been fetched)
        // During initial load, renderGames is called after updateOddsFromAPI
        if (initialLoadComplete) {
            renderActiveTab();

            // Sync any final games to Google Sheets
            await syncResultsToGoogleSheets(currentWeek, 'ESPN');
        }

        // Only start polling interval if games are scheduled or in progress
        if (shouldPollLiveScores()) {
            console.log('Games scheduled or in progress - starting live refresh');
            scheduleLiveScoresRefresh();
        } else {
            console.log('All games final or no games - skipping live refresh');

            // Even if not polling, sync any final games
            await syncResultsToGoogleSheets(currentWeek, 'ESPN');
        }
    });
}

/**
 * Check if all games in a week are completed
 */
function areAllGamesCompleted(week) {
    const games = NFL_GAMES_BY_WEEK[week];
    if (!games || games.length === 0) return false;

    return games.every(game => {
        // Check embedded status from ESPN schedule data
        if (game.status === 'STATUS_FINAL' || game.completed) {
            return true;
        }
        // Check live scores cache
        const liveData = getLiveGameStatus(game);
        return liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed);
    });
}

/**
 * Check if current week's games are all complete and advance to next week if so
 * Returns true if we advanced to the next week
 */
async function checkAndAdvanceWeekIfNeeded() {
    const games = NFL_GAMES_BY_WEEK[currentWeek];
    if (!games || games.length === 0) return false;

    const allComplete = areAllGamesCompleted(currentWeek);
    if (!allComplete) return false;

    // All games are complete - check if next week is available
    const nextWeek = currentWeek + 1;
    if (nextWeek > LAST_PLAYOFF_WEEK) return false; // Season is over

    console.log(`[Auto-advance] All ${getWeekDisplayName(currentWeek)} games are complete, advancing to ${getWeekDisplayName(nextWeek)}`);

    // Load next week's schedule
    await loadWeekSchedule(nextWeek, true); // Force refresh to get latest data

    // Only advance if next week actually has games
    if (NFL_GAMES_BY_WEEK[nextWeek] && NFL_GAMES_BY_WEEK[nextWeek].length > 0) {
        currentWeek = nextWeek;
        setupWeekButtons();
        updateWeekUI();
        return true;
    }

    return false;
}

/**
 * Proactively fetch and save spreads for upcoming weeks
 * This ensures spreads are captured before games start
 * Falls back to Google Sheets backup if spreads are missing locally
 */
/** True when two instants fall on the same calendar day in this device's timezone. */
function sameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
}

// How stale the sheet's lines may get on a day with a game still to kick off.
// The worker's own cache floor is 2h, so asking more often than that is wasted.
const GAME_DAY_REFRESH_MS = 3 * 60 * 60 * 1000;

/**
 * Should this load spend an Odds API fetch on the current week?
 *
 * Once a day used to be the whole rule - the first visitor refreshes, everyone
 * else reads the sheet. Cheap, but a Wednesday injury did not reach anyone
 * until Thursday's first visitor, and Sunday's number was whatever the morning
 * caught. So on a day when a current-week game is still to kick off, refresh
 * once the sheet is more than GAME_DAY_REFRESH_MS old; otherwise stay daily.
 *
 * "Game day" is read off the week's own kickoffs rather than a fixed list of
 * weekdays, so Saturday slates, holiday Fridays and playoff weekends count and
 * a quiet Thursday does not. A game that has already kicked off does not count
 * either: its line is fixed, so there is nothing left to catch.
 *
 * Cost at this rate: roughly 15 fetches a week, ~200 credits a month of the
 * 500. The worker's pacer still backstops it if that ever runs hot.
 */
function spreadsNeedRefresh(lastUpdated, games, now = new Date()) {
    if (!lastUpdated) return true;
    const updated = new Date(lastUpdated);
    if (isNaN(updated.getTime())) return true;

    const lineStillToCatch = (games || []).some(g => {
        if (!g.kickoff) return false;
        const kickoff = new Date(g.kickoff);
        return kickoff > now && sameLocalDay(kickoff, now);
    });
    if (lineStillToCatch) return now - updated > GAME_DAY_REFRESH_MS;
    return !sameLocalDay(updated, now);
}

async function prefetchAndSaveSpreads() {
    console.warn(`[Prefetch] === STARTING prefetchAndSaveSpreads, currentWeek=${currentWeek} ===`);
    const weeksToCheck = [currentWeek];

    // Also check next week if it exists
    if (currentWeek < LAST_PLAYOFF_WEEK) {
        weeksToCheck.push(currentWeek + 1);
    }

    // Load schedules in parallel for weeks that need them
    const schedulePromises = weeksToCheck
        .filter(week => !NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[week].length === 0)
        .map(week => {
            console.log(`[Prefetch] Loading schedule for week ${week}...`);
            // Spreads are loaded for every week in this list just below.
            return loadWeekSchedule(week, false, true);
        });

    if (schedulePromises.length > 0) {
        await Promise.all(schedulePromises);
    }

    // Load spreads from Google Sheets in parallel for all weeks
    console.log(`[Prefetch] Loading spreads from Google Sheets for weeks: ${weeksToCheck.join(', ')}...`);
    const spreadResults = await Promise.all(
        weeksToCheck.map(async (week) => {
            const games = NFL_GAMES_BY_WEEK[week];
            if (!games || games.length === 0) {
                return { week, sheetResult: null, games: [] };
            }
            const sheetResult = await loadSpreadsFromGoogleSheets(week);
            return { week, sheetResult, games };
        })
    );

    // Apply saved spreads once after all loads complete
    let saved = getSavedSpreads();
    applySavedSpreads();

    // Determine if we need Odds API refresh based on results
    let needsOddsApiRefresh = false;

    for (const { week, sheetResult, games } of spreadResults) {
        if (!games || games.length === 0) continue;

        const weekNum = parseInt(week);

        // For current week: daily, or every few hours on a day with a game to come
        if (weekNum === CURRENT_NFL_WEEK && !needsOddsApiRefresh) {
            const lastUpdated = sheetResult?.lastUpdated;
            if (spreadsNeedRefresh(lastUpdated, games)) {
                console.log(`[Prefetch] Week ${week} spreads last updated: ${lastUpdated || 'never'} - refreshing`);
                needsOddsApiRefresh = true;
            } else {
                console.log(`[Prefetch] Week ${week} spreads are recent enough (${lastUpdated})`);
            }
        }

        // Check if we have spreads saved for all games in this week
        let missingSpreadGames = games.filter(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
            const hasSaved = hasUsableLine(saved[week]?.[key]?.spread);
            const hasGame = hasUsableLine(game.spread);
            return !hasSaved && !hasGame;
        });

        // Only trigger API refresh for missing spreads in the CURRENT week
        if (missingSpreadGames.length > 0) {
            if (weekNum === CURRENT_NFL_WEEK) {
                console.log(`[Prefetch] Week ${week} has ${missingSpreadGames.length} games missing spreads - will fetch from API`);
                needsOddsApiRefresh = true;
            } else {
                console.log(`[Prefetch] Week ${week} has ${missingSpreadGames.length} games missing spreads (future week - skipping API fetch)`);
            }
        } else {
            console.log(`[Prefetch] Week ${week} spreads are complete`);
        }
    }

    // If we need fresh spreads (sheet too old, or lines missing), call Odds API
    if (needsOddsApiRefresh) {
        console.log(`[Prefetch] Fetching fresh spreads from Odds API...`);
        const fresh = await updateOddsFromAPI(true);
        // Push to the sheet ONLY when the lines actually came from the worker,
        // so later visitors read them instead of fetching again. On a failed
        // fetch the local bucket still holds whatever this device stored last
        // time - a week-old lookahead line, say - and pushing that would
        // overwrite the sheet's fresher numbers for everyone.
        if (fresh) {
            await syncSpreadsToGoogleSheets();
        } else {
            console.warn('[Prefetch] Odds refresh returned no fresh lines - not syncing spreads to the sheet');
        }
        applySavedSpreads();
    }

    // Re-cache schedules with updated spreads
    for (const week of weeksToCheck) {
        if (NFL_GAMES_BY_WEEK[week] && NFL_GAMES_BY_WEEK[week].length > 0) {
            cacheSchedule(week, NFL_GAMES_BY_WEEK[week]);
        }
    }
}

/**
 * Preload next week's games when current week is complete
 * This helps ensure playoff weeks transition smoothly
 */
async function preloadNextWeekIfAvailable() {
    const nextWeek = currentWeek + 1;
    // Allow preloading up to LAST_PLAYOFF_WEEK (don't limit to CURRENT_NFL_WEEK)
    const maxWeek = LAST_PLAYOFF_WEEK;

    // Don't preload beyond max week
    if (nextWeek > maxWeek) return;

    // Check if we already have games for next week
    if (NFL_GAMES_BY_WEEK[nextWeek] && NFL_GAMES_BY_WEEK[nextWeek].length > 0) {
        console.log(`[Preload] Next week ${nextWeek} already has ${NFL_GAMES_BY_WEEK[nextWeek].length} games`);
        // Load spreads from Google Sheets
        await loadSpreadsFromGoogleSheets(nextWeek);
        applySavedSpreads();
        return;
    }

    console.log(`[Preload] Loading games for ${getWeekDisplayName(nextWeek)}...`);
    await loadWeekSchedule(nextWeek);

    // Load spreads from Google Sheets
    await loadSpreadsFromGoogleSheets(nextWeek);
    applySavedSpreads();

    // Update the week dropdown to show the new week if not already there
    setupWeekButtons();
    console.log(`[Preload] ${getWeekDisplayName(nextWeek)} is now available`);
}

/**
 * Queue the next live-scores fetch.
 *
 * A timeout that reschedules itself rather than a fixed interval, for two
 * reasons: the rate depends on whether anything is being played, which can
 * change between fetches; and at half a minute a slow fetch would otherwise
 * overlap the one behind it.
 */
function scheduleLiveScoresRefresh() {
    liveScoresRefreshTimer = setTimeout(async () => {
        // Anything in here can throw - a failed fetch, a sync that times out
        // - and a timeout that reschedules itself only at the end would then
        // never fire again, stopping the afternoon's updates dead. An interval
        // would have survived it by firing again regardless, so the rescheduling
        // goes in a finally.
        let done = false;
        try {
            await fetchLiveScores();
            renderActiveTab();

            // Sync any newly final games to Google Sheets
            await syncResultsToGoogleSheets(currentWeek, 'ESPN');

            // Stop polling when all games are final
            if (!shouldPollLiveScores()) {
                console.log('All games final - stopping live refresh');
                done = true;
                stopLiveScoresRefresh();

                // Check if next week's games are available and preload them
                await preloadNextWeekIfAvailable();
            }
        } catch (error) {
            console.error('[Live] Refresh failed, will try again:', error);
        } finally {
            if (!done) scheduleLiveScoresRefresh();
        }
    }, liveRefreshDelay());
}

/**
 * Stop live scores refresh
 */
function stopLiveScoresRefresh() {
    if (liveScoresRefreshTimer) {
        clearTimeout(liveScoresRefreshTimer);
        liveScoresRefreshTimer = null;
    }
}

// Game Results by Week - Update as games finish
// Format: { week: { gameId: { winner: 'away'|'home', awayScore: X, homeScore: Y } } }
const NFL_RESULTS_BY_WEEK = {
    // Example for week 15:
    // 15: {
    //     1: { winner: 'home', awayScore: 17, homeScore: 24 }
    // }
};

// Merge historical results if available
if (typeof HISTORICAL_RESULTS !== 'undefined') {
    for (const week in HISTORICAL_RESULTS) {
        if (!NFL_RESULTS_BY_WEEK[week]) {
            NFL_RESULTS_BY_WEEK[week] = HISTORICAL_RESULTS[week];
        }
    }
    console.log('Historical results merged into NFL_RESULTS_BY_WEEK');
}

// Helper function to get games for current week (season-aware)
function getGamesForWeek(week) {
    // If viewing a historical season, get data from seasonData
    if (typeof currentSeason !== 'undefined' && currentSeason !== CURRENT_SEASON && seasonData[currentSeason]) {
        const data = seasonData[currentSeason];
        return data.games[week] || data.games[String(week)] || [];
    }
    // Current season uses live data
    return NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[String(week)] || [];
}

// Helper function to get results for current week (season-aware)
function getResultsForWeek(week) {
    // If viewing a historical season, get data from seasonData
    if (typeof currentSeason !== 'undefined' && currentSeason !== CURRENT_SEASON && seasonData[currentSeason]) {
        const data = seasonData[currentSeason];
        return data.results[week] || data.results[String(week)] || {};
    }
    // Current season uses live data
    return NFL_RESULTS_BY_WEEK[week] || NFL_RESULTS_BY_WEEK[String(week)] || {};
}

// Helper function to get all picks for a week (season-aware)
function getPicksForWeek(week) {
    // If viewing a historical season, get data from seasonData
    if (typeof currentSeason !== 'undefined' && currentSeason !== CURRENT_SEASON && seasonData[currentSeason]) {
        const data = seasonData[currentSeason];
        return data.picks[week] || data.picks[String(week)] || {};
    }
    // Current season uses live data
    return allPicks[week] || allPicks[String(week)] || {};
}

// --- Pick keys -------------------------------------------------------------
// Picks are keyed by matchup ("away_home") rather than by game.id, because game
// ids are positional: loadWeekSchedule reassigns them (id = index + 1) after
// sorting by kickoff, and they differ between the ESPN, Google Sheets and
// historical-YYYY.js sources. A matchup key means the same thing everywhere.
//
// The season is deliberately NOT part of the key. Every store that holds picks
// is already season-scoped one level up, so 2025 and 2026 keys can never meet:
//   - localStorage:  nflPicks_<season> / clearedPicks_<season>
//   - Google Sheet:  the Week column is season-prefixed ("2026_5", see toSheetWeek)
//   - historical:    getSeasonData(season), loaded from a per-season file
// Within a season the week is part of the path, and division rematches flip
// home/away, so a repeated matchup still gets a distinct key.

// TEAM_NAME_MAP re-keyed by lowercase alias, so a name that has already been
// lowercased (e.g. read back out of a stored key) still normalizes.
const TEAM_ALIAS_LOWER = Object.fromEntries(
    Object.entries(TEAM_NAME_MAP).map(([alias, name]) => [alias.toLowerCase(), name.toLowerCase()])
);

// Normalize a team name so aliases and relocations map to one canonical form
// ("Buccs"/"Bucs"/"TB" -> "buccaneers"). Without this a rename would orphan
// every pick on that team.
function normalizeTeamName(name) {
    if (!name) return '';
    const trimmed = String(name).trim();
    const canonical = TEAM_NAME_MAP[trimmed] || TEAM_ALIAS_LOWER[trimmed.toLowerCase()] || trimmed;
    return canonical.toLowerCase();
}

// Re-normalize a key that was built elsewhere. The Apps Script backup composes
// "away_home" from the raw team-name columns without going through
// TEAM_NAME_MAP, so keys coming back from the sheet are normalized on ingest to
// stop the client and server drifting apart on aliases.
// Keys that are not "a_b" (e.g. a legacy numeric id) are returned untouched and
// converted later by rekeyPicksByMatchup().
function normalizePickKey(rawKey) {
    const parts = String(rawKey).split('_');
    if (parts.length !== 2) return String(rawKey);
    return `${normalizeTeamName(parts[0])}_${normalizeTeamName(parts[1])}`;
}

// The one place a pick key is constructed. Everything that reads or writes a
// pick must go through this.
function pickKey(game) {
    if (!game) return '';
    return `${normalizeTeamName(game.away)}_${normalizeTeamName(game.home)}`;
}

// Look up a picker's picks for a game. Matchup key only - no game-id fallback,
// since a positional id would silently attribute picks to whichever game landed
// in that slot. Legacy id-keyed data is converted up front by
// rekeyPicksByMatchup(), not tolerated here.
function getPicksForGame(pickerPicks, game) {
    if (!pickerPicks) return {};
    return pickerPicks[pickKey(game)] || {};
}

/**
 * One picker's pick for one game, from the two places a pick can be.
 *
 * What is stored locally wins over what came back from the sheet: the local
 * copy is this device's own edit, the cache is what the backup held when it was
 * last read. The two are merged rather than chosen between, so a pick split
 * across them - a line here, the Blazin' star there - comes back whole.
 */
function pickFromSources(game, localPicks, cachedPicks) {
    return {
        ...getPicksForGame(cachedPicks, game),
        ...getPicksForGame(localPicks, game)
    };
}

/**
 * Convert one picker's picks for a week from game-id keys to matchup keys.
 *
 * Idempotent: keys that are already valid matchup keys for this week pass
 * through untouched. Fields are merged rather than overwritten, so a game that
 * ended up split across two keys (e.g. {line,winner} under "rams_seahawks" and
 * {blazin:true} under "1") is reunited instead of losing one half.
 *
 * Keys that match neither a game id nor a matchup in this week are kept as-is
 * and reported as orphans - dropping them would lose picks silently.
 *
 * @returns {{picks: object, converted: number, orphans: string[]}}
 */
function rekeyPicksByMatchup(pickerPicks, weekGames) {
    const result = { picks: {}, converted: 0, orphans: [] };
    if (!pickerPicks) return result;
    if (!weekGames || weekGames.length === 0) {
        result.picks = pickerPicks;
        return result;
    }

    const idToKey = {};
    const validKeys = new Set();
    weekGames.forEach(game => {
        const key = pickKey(game);
        idToKey[String(game.id)] = key;
        validKeys.add(key);
    });

    // Integer-like keys iterate first in JS, so legacy id-keyed entries are
    // merged in before the matchup-keyed ones and lose any field conflict.
    for (const storedKey of Object.keys(pickerPicks)) {
        const pick = pickerPicks[storedKey];
        let target;

        if (validKeys.has(storedKey)) {
            target = storedKey;
        } else if (idToKey[storedKey]) {
            target = idToKey[storedKey];
            result.converted++;
        } else {
            target = storedKey;
            result.orphans.push(storedKey);
        }

        result.picks[target] = { ...(result.picks[target] || {}), ...pick };
    }

    return result;
}

/**
 * The picks a picker has for a week as the UI sees them: the Google Sheets
 * cache with local picks layered on top (local wins).
 *
 * renderGames and updateBlazinStarStates MUST read picks through this. When
 * they read different views, a star renders enabled and then disables itself
 * on the next click - the Blazin' 5 "works for a moment" bug.
 */
function getPickerPicksForWeek(week = currentWeek, picker = currentPicker) {
    const weekStr = String(week);
    const seasonPicks = getPicksForWeekAndSeason(week, currentSeason) || {};
    const localPicks = seasonPicks[picker] || {};
    const cachedPicks = weeklyPicksCache[week]?.picks?.[picker]
        || weeklyPicksCache[weekStr]?.picks?.[picker] || {};
    return { ...cachedPicks, ...localPicks };
}

/**
 * Count a picker's Blazin' 5 picks for a week, for the 5-pick cap.
 *
 * Counted over the week's full schedule rather than Object.values(picks): a
 * stale orphan key would inflate the count and disable every star, and the
 * card filter (all/upcoming/completed) must not change the cap either.
 */
function countBlazinPicks(week = currentWeek, picker = currentPicker) {
    if (isPlayoffWeek(week)) return 0;
    const picks = getPickerPicksForWeek(week, picker);
    return getGamesForWeekAndSeason(week, currentSeason)
        .reduce((n, game) => n + (getPicksForGame(picks, game).blazin ? 1 : 0), 0);
}

// Season-aware helper functions

/**
 * Check if viewing a historical (non-current) season
 */
function isHistoricalSeason() {
    return currentSeason !== CURRENT_SEASON;
}

/**
 * Get games for a specific week and season
 * @param {number} week - Week number
 * @param {number} season - Season year (defaults to currentSeason)
 */
function getGamesForWeekAndSeason(week, season = currentSeason) {
    season = Number(season);
    if (season === CURRENT_SEASON) {
        return getGamesForWeek(week);
    }
    const data = getSeasonData(season);
    if (!data || !data.games) return [];
    return data.games[week] || data.games[String(week)] || [];
}

/**
 * Get results for a specific week and season
 * @param {number} week - Week number
 * @param {number} season - Season year (defaults to currentSeason)
 */
function getResultsForWeekAndSeason(week, season = currentSeason) {
    season = Number(season);
    if (season === CURRENT_SEASON) {
        return getResultsForWeek(week);
    }
    const data = getSeasonData(season);
    if (!data || !data.results) return {};
    return data.results[week] || data.results[String(week)] || {};
}

/**
 * Get picks for a specific week and season
 * @param {number} week - Week number
 * @param {number} season - Season year (defaults to currentSeason)
 */
function getPicksForWeekAndSeason(week, season = currentSeason) {
    season = Number(season);
    if (season === CURRENT_SEASON) {
        return allPicks[week] || allPicks[String(week)] || {};
    }
    const data = getSeasonData(season);
    if (!data || !data.picks) return {};
    return data.picks[week] || data.picks[String(week)] || {};
}

/**
 * Get the maximum week number for a season
 * Historical seasons have all weeks complete; current season uses CURRENT_NFL_WEEK
 * @param {number} season - Season year (defaults to currentSeason)
 */
function getMaxWeekForSeason(season = currentSeason) {
    if (season === CURRENT_SEASON) {
        return CURRENT_NFL_WEEK;
    }
    // Historical seasons are complete - return 22 (includes playoffs) or check actual data
    const data = getSeasonData(season);
    if (data && data.games) {
        const weeks = Object.keys(data.games).map(Number).filter(n => !isNaN(n));
        return weeks.length > 0 ? Math.max(...weeks) : LAST_PLAYOFF_WEEK;
    }
    return LAST_PLAYOFF_WEEK;
}

/**
 * Historical season files (historical-YYYY.js) key their picks by game id.
 * Convert them to matchup keys once, at load time, so that every consumer can
 * read picks the same way regardless of which season is being viewed.
 * Results stay id-keyed - they are always read alongside the same games array
 * they were generated with.
 */
function normalizeSeasonPicks(data, season) {
    if (!data || !data.picks || !data.games || data.__pickKeysNormalized) return data;

    let converted = 0;
    const orphans = [];

    for (const weekKey of Object.keys(data.picks)) {
        const weekGames = data.games[weekKey] || data.games[String(weekKey)] || [];
        if (weekGames.length === 0) continue;

        for (const picker of Object.keys(data.picks[weekKey])) {
            const rekeyed = rekeyPicksByMatchup(data.picks[weekKey][picker], weekGames);
            data.picks[weekKey][picker] = rekeyed.picks;
            converted += rekeyed.converted;
            rekeyed.orphans.forEach(key => orphans.push(`wk${weekKey} ${picker}:${key}`));
        }
    }

    data.__pickKeysNormalized = true;
    if (orphans.length > 0) {
        console.warn(`[Picks] ${season}: ${orphans.length} pick key(s) match no game that week:`, orphans.slice(0, 20));
    }
    console.log(`[Picks] ${season}: converted ${converted} pick key(s) to matchup keys`);
    return data;
}

/**
 * Load season data (lazy loading for historical seasons)
 * @param {number} season - Season year to load
 * @returns {Promise<object|null>} - Season data or null if load failed
 */
/**
 * The current season, presented in the same shape as a historical archive.
 *
 * There is no historical-<CURRENT_SEASON>.js: the live season lives in
 * NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK and allPicks until it is archived at
 * the end of the year. Without this, History offered the current season in its
 * dropdown and then failed to load it, because loadSeasonData went looking for
 * an archive file that will not exist until the season is over.
 *
 * Only `games` is really needed - it builds the week list - since every read
 * after that goes through the season-aware getters, which already return live
 * data for CURRENT_SEASON. The rest is included so the object is honest about
 * what it represents.
 *
 * Built fresh each call rather than cached: it changes as picks and results
 * come in, and a cached copy would quietly go stale mid-season.
 */
/**
 * Season data for reading, whichever season it is.
 *
 * seasonData only ever holds ARCHIVED seasons - loadSeasonData fills it from
 * historical-<year>.js. The season in progress has no archive, so anything
 * that reached into seasonData directly found nothing for it and rendered an
 * empty state: that is why History showed "No data available" for the current
 * season even once it loaded.
 *
 * Read through this rather than getSeasonData(season). The only place that should
 * touch the map directly is loadSeasonData, which owns it.
 */
function getSeasonData(season) {
    const year = Number(season);
    if (year === CURRENT_SEASON) return buildCurrentSeasonView();
    return seasonData[year];
}

function buildCurrentSeasonView() {
    const games = {};
    const results = {};
    const picks = {};

    for (let week = 1; week <= LAST_PLAYOFF_WEEK; week++) {
        const weekGames = NFL_GAMES_BY_WEEK[week];
        if (!weekGames || weekGames.length === 0) continue;

        games[week] = weekGames;
        if (NFL_RESULTS_BY_WEEK[week]) results[week] = NFL_RESULTS_BY_WEEK[week];
        if (allPicks[week]) picks[week] = allPicks[week];
    }

    return { games, results, picks, season: CURRENT_SEASON, isLive: true };
}

async function loadSeasonData(rawSeason, { quiet = false } = {}) {
    // Season values come off <select> elements, so they arrive as strings as
    // often as numbers, and '2026' === 2026 is false. Coerce once here rather
    // than trust every caller: getting this wrong sent the current season to
    // the archive loader, which 404ed on a historical-<year>.js that will not
    // exist until the season is over.
    const season = Number(rawSeason);
    if (!Number.isFinite(season)) {
        console.error(`[Season] Not a season: ${rawSeason}`);
        return null;
    }

    // The season in progress has no archive file - assemble it from the live
    // data instead. Deliberately before the seasonData cache check, so it is
    // never served stale.
    if (season === CURRENT_SEASON) {
        return buildCurrentSeasonView();
    }

    // Already loaded into seasonData
    if (seasonData[season]) {
        return seasonData[season];
    }

    // Check if data is already available on window (from historical-data.js loaded at startup)
    const dataKey = `SEASON_${season}_DATA`;
    if (window[dataKey]) {
        seasonData[season] = normalizeSeasonPicks(window[dataKey], season);
        console.log(`Using pre-loaded ${season} season data`);
        return seasonData[season];
    }

    // Already loading - wait for it
    if (seasonDataLoading[season]) {
        return seasonDataLoading[season];
    }

    // Show loading indicator. Not for a background probe: the standings do not
    // wait on it, so a full-screen overlay for a column would be a lie about
    // what is blocking - and hiding it again would pull an overlay somebody
    // else put up.
    const releaseLoadingState = () => { if (!quiet) hideLoadingState(); };
    if (!quiet) showLoadingState(`Loading ${season} season...`);

    // Create loading promise
    seasonDataLoading[season] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `historical-${season}.js`;

        script.onload = () => {
            // Access the loaded data (file sets window.SEASON_XXXX_DATA)
            const dataKey = `SEASON_${season}_DATA`;
            if (window[dataKey]) {
                seasonData[season] = normalizeSeasonPicks(window[dataKey], season);
                console.log(`Loaded ${season} season data`);
                releaseLoadingState();
                resolve(seasonData[season]);
            } else {
                console.error(`${dataKey} not found after loading script`);
                releaseLoadingState();
                reject(new Error(`Season data not found`));
            }
            delete seasonDataLoading[season];
        };

        script.onerror = () => {
            // quiet: a background probe, not something anybody asked for. The
            // season rolls over on July 1st and the year just finished is not
            // archived until someone does it by hand, so for those weeks a
            // missing archive is the expected state - shouting about it on every
            // page load would train people to ignore the toast.
            const msg = `historical-${season}.js did not load - the season is not archived yet`;
            if (quiet) console.log(`[Season] ${msg}`); else console.error(msg);
            releaseLoadingState();
            if (!quiet) showToast(`Failed to load ${season} season data`, 'error');
            delete seasonDataLoading[season];
            reject(new Error(`Failed to load season data`));
        };

        document.head.appendChild(script);
    });

    try {
        return await seasonDataLoading[season];
    } catch (error) {
        return null;
    }
}

// DOM Elements
const dashboard = document.getElementById('dashboard');
const leaderboard = document.getElementById('leaderboard');
const tabs = document.querySelectorAll('.tab');
// The Standings strip's buttons only. The Live tab has a strip of the same
// class; catching its buttons here would hand them to setActiveSubcategory
// with no subcategory and toggle their highlight from the wrong tab.
const subtabs = document.querySelectorAll('#standings-subtabs .subtab');
const standingsSubtabs = document.getElementById('standings-subtabs');
const liveSubtabs = document.getElementById('live-subtabs');

// Initialize picks storage for all weeks and pickers
function initializePicksStorage() {
    for (let week = 1; week <= TOTAL_WEEKS; week++) {
        if (!allPicks[week]) {
            allPicks[week] = {};
        }
        PICKERS.forEach(picker => {
            if (!allPicks[week][picker]) {
                allPicks[week][picker] = {};
            }
        });
    }
}
initializePicksStorage();

// (game-id -> matchup key conversion now lives in rekeyPicksByMatchup, above)

// Merge historical picks if available (from historical-data.js)
if (typeof HISTORICAL_PICKS !== 'undefined') {
    for (const week in HISTORICAL_PICKS) {
        if (!allPicks[week]) {
            allPicks[week] = {};
        }

        // Get historical games for this week to enable ID-to-matchup-key conversion
        const weekGames = (typeof HISTORICAL_GAMES !== 'undefined') ? HISTORICAL_GAMES[week] : null;

        for (const picker in HISTORICAL_PICKS[week]) {
            // For playoff weeks (19+), always use historical data (overrides localStorage)
            // For regular season, only merge if picker has no picks
            const weekNum = parseInt(week);
            if (weekNum >= 19 || !allPicks[week][picker] || Object.keys(allPicks[week][picker]).length === 0) {
                // Migrate numeric IDs to matchup keys for portability
                allPicks[week][picker] = rekeyPicksByMatchup(HISTORICAL_PICKS[week][picker], weekGames).picks;
            }
        }
    }
    console.log('Historical picks merged into allPicks (with matchup key migration)');
}

/**
 * Initialize the application
 */
function init() {
    // Initialize currentWeek with calculated value
    currentWeek = CURRENT_NFL_WEEK;

    // Show the current season in the header and tab title
    // (index.html only has an empty placeholder, so the year can never go stale)
    const seasonDisplay = document.getElementById('season-display');
    if (seasonDisplay) {
        seasonDisplay.textContent = CURRENT_SEASON;
    }
    document.title = `NFL Picks Dashboard - ${CURRENT_SEASON} Season`;

    // Fill the week headings ("Week 1 Picks" etc.) - index.html defaults them to "--"
    // and loadCSVData no longer runs when the legacy stats workbook is stale.
    const picksWeekNum = document.getElementById('picks-week-num');
    if (picksWeekNum) {
        picksWeekNum.textContent = getWeekTitle(currentWeek, 'Picks');
    }
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (scoringWeekNum) {
        scoringWeekNum.textContent = getWeekTitle(currentWeek, 'Scoring Summary');
    }

    // Note: Historical data (games, results, picks) is merged immediately when app.js loads
    // See the merge blocks after NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, and initializePicksStorage()

    setupTabs();
    setupSeasonDropdown();
    setupWeekButtons();
    setupPickerButtons();
    setupPicksActions();
    setupDarkMode();
    setupWeekNavigation();
    setupGameFilters();
    setupConfirmModal();
    setupRetryButton();
    initCollapsibleSections();
    setupConsolidatedTabs();
    setupPullToRefresh();
    setupTeamRecordsDropdown();
    setupBlazinTeamRecordsDropdown();
    setupHistoryBlazinRecords();
    setupPatternFilters();
    syncPickerDropdowns(false);
    setupPlayoffComparisonControls();
    trackTabsHeight();
    loadPicksFromStorage();

    // Show loading state
    showLoadingState();

    // Load data from Google Sheets
    loadFromGoogleSheets();
}

/**
 * Setup dark mode toggle
 */
function setupDarkMode() {
    const toggle = document.getElementById('dark-mode-toggle');
    if (!toggle) return;

    // Load saved preference
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }

    // Toggle handler
    toggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        if (newTheme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }

        localStorage.setItem('theme', newTheme);
        showToast(newTheme === 'dark' ? 'Dark mode enabled' : 'Light mode enabled');

        // Re-render charts with new colors
        if ((dashboardData || usingComputedStandings()) && currentCategory !== 'make-picks') {
            renderDashboard();
        }
    });
}

/**
 * Setup week selection dropdown
 */
function setupWeekButtons() {
    const weekDropdown = document.getElementById('week-dropdown');
    if (!weekDropdown) return;

    let optionsHtml = '';
    // Use getMaxNavigableWeek if available (it accounts for completed weeks)
    const effectiveWeek = typeof getMaxNavigableWeek === 'function'
        ? getMaxNavigableWeek()
        : Math.min(CURRENT_NFL_WEEK, LAST_PLAYOFF_WEEK);

    // Playoffs section (if we're in or past playoffs)
    if (effectiveWeek >= FIRST_PLAYOFF_WEEK) {
        optionsHtml += '<optgroup label="Playoffs">';
        for (let week = effectiveWeek; week >= FIRST_PLAYOFF_WEEK; week--) {
            const selected = week === currentWeek ? 'selected' : '';
            optionsHtml += `<option value="${week}" ${selected}>${PLAYOFF_WEEKS[week].name}</option>`;
        }
        optionsHtml += '</optgroup>';
    }

    // Regular Season section
    optionsHtml += '<optgroup label="Regular Season">';
    const maxRegularWeek = Math.min(effectiveWeek, TOTAL_WEEKS);
    for (let week = maxRegularWeek; week >= 1; week--) {
        const selected = week === currentWeek ? 'selected' : '';
        optionsHtml += `<option value="${week}" ${selected}>Week ${week}</option>`;
    }
    optionsHtml += '</optgroup>';

    weekDropdown.innerHTML = optionsHtml;

    // Add change handler
    weekDropdown.addEventListener('change', (e) => {
        const week = parseInt(e.target.value);
        setCurrentWeek(week);
    });
}

/**
 * Setup season dropdown
 */
function setupSeasonDropdown() {
    // Show/hide History tab based on available historical seasons
    const historyTab = document.getElementById('history-tab');
    const hasHistoricalSeasons = AVAILABLE_SEASONS.length > 0;

    if (historyTab) {
        historyTab.style.display = hasHistoricalSeasons ? '' : 'none';
    }

    // The Playoffs standings tab only means anything once there are playoff
    // games to score, so it stays hidden for the regular season.
    const playoffsSubtab = document.getElementById('playoffs-subtab');
    if (playoffsSubtab) {
        playoffsSubtab.style.display = isPlayoffsUnderway() ? '' : 'none';
    }

    // Setup history section dropdowns
    const historySeasonDropdown = document.getElementById('history-season-dropdown');
    if (historySeasonDropdown && hasHistoricalSeasons) {
        // Show all seasons including current (2025 season is complete)
        // Add "Lifetime" option, then seasons with most recent selected by default
        let optionsHtml = '<option value="lifetime">Lifetime</option>';
        AVAILABLE_SEASONS.forEach((season, index) => {
            const isSelected = index === 0 ? ' selected' : '';
            optionsHtml += `<option value="${season}"${isSelected}>${season}</option>`;
        });
        historySeasonDropdown.innerHTML = optionsHtml;

        historySeasonDropdown.addEventListener('change', async (e) => {
            const value = e.target.value;
            if (value === 'lifetime') {
                await loadLifetimeHistory();
            } else {
                const season = parseInt(value);
                await loadHistorySeason(season);
            }
        });
    }

    const historyWeekDropdown = document.getElementById('history-week-dropdown');
    if (historyWeekDropdown) {
        historyWeekDropdown.addEventListener('change', (e) => {
            const week = parseInt(e.target.value);
            renderHistoryWeek(week);
            updateHistoryWeekDisplay(week);
        });
    }

    // Standings scope: the season so far, or one week of it.
    document.querySelectorAll('[data-history-scope]').forEach(btn => {
        btn.addEventListener('click', () => setHistoryStandingsScope(btn.dataset.historyScope));
    });
    const historyStandingsWeekDropdown = document.getElementById('history-standings-week');
    if (historyStandingsWeekDropdown) {
        historyStandingsWeekDropdown.addEventListener('change', (e) => {
            historyStandingsWeek = parseInt(e.target.value);
            const season = historySelectedSeason();
            if (season) renderHistoryStandingsTable(season);
        });
    }

    // History picker dropdown
    const historyPickerDropdown = document.getElementById('history-picker-dropdown');
    if (historyPickerDropdown) {
        historyPickerDropdown.addEventListener('change', () => {
            const weekDropdown = document.getElementById('history-week-dropdown');
            const week = weekDropdown ? parseInt(weekDropdown.value) : 1;
            renderHistoryWeek(week);
        });
    }

    // History week navigation buttons
    const historyPrevWeekBtn = document.getElementById('history-prev-week-btn');
    const historyNextWeekBtn = document.getElementById('history-next-week-btn');
    if (historyPrevWeekBtn && historyWeekDropdown) {
        historyPrevWeekBtn.addEventListener('click', () => {
            const currentIdx = historyWeekDropdown.selectedIndex;
            if (currentIdx > 0) {
                historyWeekDropdown.selectedIndex = currentIdx - 1;
                const week = parseInt(historyWeekDropdown.value);
                renderHistoryWeek(week);
                updateHistoryWeekDisplay(week);
            }
        });
    }
    if (historyNextWeekBtn && historyWeekDropdown) {
        historyNextWeekBtn.addEventListener('click', () => {
            const currentIdx = historyWeekDropdown.selectedIndex;
            if (currentIdx < historyWeekDropdown.options.length - 1) {
                historyWeekDropdown.selectedIndex = currentIdx + 1;
                const week = parseInt(historyWeekDropdown.value);
                renderHistoryWeek(week);
                updateHistoryWeekDisplay(week);
            }
        });
    }

    // History picker navigation buttons
    const historyPrevPickerBtn = document.getElementById('history-prev-picker-btn');
    const historyNextPickerBtn = document.getElementById('history-next-picker-btn');
    if (historyPrevPickerBtn && historyPickerDropdown) {
        historyPrevPickerBtn.addEventListener('click', () => {
            const currentIdx = historyPickerDropdown.selectedIndex;
            if (currentIdx > 0) {
                historyPickerDropdown.selectedIndex = currentIdx - 1;
                const weekDropdown = document.getElementById('history-week-dropdown');
                const week = weekDropdown ? parseInt(weekDropdown.value) : 1;
                renderHistoryWeek(week);
            }
        });
    }
    if (historyNextPickerBtn && historyPickerDropdown) {
        historyNextPickerBtn.addEventListener('click', () => {
            const currentIdx = historyPickerDropdown.selectedIndex;
            if (currentIdx < historyPickerDropdown.options.length - 1) {
                historyPickerDropdown.selectedIndex = currentIdx + 1;
                const weekDropdown = document.getElementById('history-week-dropdown');
                const week = weekDropdown ? parseInt(weekDropdown.value) : 1;
                renderHistoryWeek(week);
            }
        });
    }
}

/**
 * Update the history week display header
 */
function updateHistoryWeekDisplay(week) {
    const weekDisplay = document.getElementById('history-week-display');

    if (weekDisplay) {
        if (isPlayoffWeek(week)) {
            weekDisplay.textContent = PLAYOFF_WEEKS[week].name;
        } else {
            weekDisplay.textContent = `Week ${week}`;
        }
    }
}

/**
 * Load and display a historical season
 */
async function loadHistorySeason(season) {
    const data = await loadSeasonData(season);
    if (!data) {
        showToast(`Failed to load ${season} season data`, 'error');
        return;
    }

    // Show week section (may have been hidden by Lifetime view)
    const historySection = document.getElementById('history-section');
    if (historySection) {
        const picksHeader = historySection.querySelector('.picks-header');
        const selectionRow = historySection.querySelector('.selection-row');
        const historyContent = document.getElementById('history-content');
        if (picksHeader) picksHeader.style.display = '';
        if (selectionRow) selectionRow.style.display = '';
        if (historyContent) historyContent.style.display = '';
    }

    // Populate week dropdown
    const weekDropdown = document.getElementById('history-week-dropdown');
    if (weekDropdown && data.games) {
        const weeks = Object.keys(data.games).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        let optionsHtml = '';

        // Regular season weeks
        const regularWeeks = weeks.filter(w => w <= TOTAL_WEEKS);
        if (regularWeeks.length > 0) {
            optionsHtml += '<optgroup label="Regular Season">';
            regularWeeks.forEach(week => {
                optionsHtml += `<option value="${week}">Week ${week}</option>`;
            });
            optionsHtml += '</optgroup>';
        }

        // Playoff weeks
        const playoffWeeks = weeks.filter(w => w > TOTAL_WEEKS);
        if (playoffWeeks.length > 0) {
            optionsHtml += '<optgroup label="Playoffs">';
            playoffWeeks.forEach(week => {
                const name = PLAYOFF_WEEKS[week]?.name || `Week ${week}`;
                optionsHtml += `<option value="${week}">${name}</option>`;
            });
            optionsHtml += '</optgroup>';
        }

        weekDropdown.innerHTML = optionsHtml;
    }

    // Update picker dropdowns based on season (Jason/Daniel started in 2023)
    const seasonPickers = getPickersForSeason(season);

    const pickerDropdown = document.getElementById('history-picker-dropdown');
    if (pickerDropdown) {
        const currentSelection = pickerDropdown.value;
        pickerDropdown.innerHTML = seasonPickers.map(p =>
            `<option value="${p}"${p === currentSelection ? ' selected' : ''}>${p}</option>`
        ).join('');
        // If current selection is not available, select first picker
        if (!seasonPickers.includes(currentSelection)) {
            pickerDropdown.value = seasonPickers[0];
        }
    }

    // Update Blazin' 5 records picker dropdown
    const blazinPickerDropdown = document.getElementById('history-blazin-picker');
    if (blazinPickerDropdown) {
        const currentSelection = blazinPickerDropdown.value;
        // Include "All" option at the beginning (excludes Cowherd in calculations)
        const allOption = `<option value="All"${currentSelection === 'All' ? ' selected' : ''}>All</option>`;
        blazinPickerDropdown.innerHTML = allOption + seasonPickers.map(p =>
            `<option value="${p}"${p === currentSelection ? ' selected' : ''}>${p}</option>`
        ).join('');
        // If current selection is not available, select "All"
        if (currentSelection !== 'All' && !seasonPickers.includes(currentSelection)) {
            blazinPickerDropdown.value = 'All';
        }
    }

    // Render first week by default and update display
    renderHistoryWeek(1);
    updateHistoryWeekDisplay(1);

    // Season standings table, at whichever scope the reader had it on.
    // The scope and week live in module state rather than in the controls,
    // so the live-season refresh that comes back through here keeps them.
    updateHistoryScopeControls(season);
    populateHistoryStandingsWeeks(season);
    renderHistoryStandingsTable(season);

    // Render Blazin' 5 records tables
    renderHistoryBlazinTeamRecords();
    renderHistoryBlazinSpreadRecords();
}

/**
 * Load and display lifetime (all seasons combined) history
 */
async function loadLifetimeHistory() {
    showLoadingState('Loading lifetime data...');

    // Load all available season data
    const loadPromises = AVAILABLE_SEASONS.map(season => loadSeasonData(season));
    await Promise.all(loadPromises);

    hideLoadingState();

    // Hide week-by-week section for lifetime view
    const historySection = document.getElementById('history-section');
    if (historySection) {
        const picksHeader = historySection.querySelector('.picks-header');
        const selectionRow = historySection.querySelector('.selection-row');
        const historyContent = document.getElementById('history-content');
        if (picksHeader) picksHeader.style.display = 'none';
        if (selectionRow) selectionRow.style.display = 'none';
        if (historyContent) historyContent.style.display = 'none';
    }
    updateHistoryScopeControls(null);

    // Update picker dropdown to include all pickers across all seasons
    const allPickers = new Set();
    AVAILABLE_SEASONS.forEach(season => {
        getPickersForSeason(season).forEach(p => allPickers.add(p));
    });
    const sortedPickers = Array.from(allPickers).sort();

    // Update Blazin' 5 records picker dropdown
    const blazinPickerDropdown = document.getElementById('history-blazin-picker');
    if (blazinPickerDropdown) {
        const currentSelection = blazinPickerDropdown.value;
        const allOption = `<option value="All"${currentSelection === 'All' ? ' selected' : ''}>All</option>`;
        blazinPickerDropdown.innerHTML = allOption + sortedPickers.map(p =>
            `<option value="${p}"${p === currentSelection ? ' selected' : ''}>${p}</option>`
        ).join('');
        if (currentSelection !== 'All' && !sortedPickers.includes(currentSelection)) {
            blazinPickerDropdown.value = 'All';
        }
    }

    // Render lifetime standings table
    renderLifetimeStandingsTable();

    // Render Blazin' 5 records tables (they will detect lifetime mode from dropdown)
    renderHistoryBlazinTeamRecords();
    renderHistoryBlazinSpreadRecords();
}

/**
 * Render standings table aggregated across all seasons (lifetime view)
 */
function renderLifetimeStandingsTable() {
    const tbody = document.getElementById('history-standings-table-body');
    const titleSpan = document.getElementById('history-standings-title');
    if (!tbody) return;

    if (titleSpan) {
        titleSpan.textContent = 'Lifetime';
    }

    // Aggregate stats across all seasons
    const pickerStats = {};

    AVAILABLE_SEASONS.forEach(season => {
        if (!getSeasonData(season)) return;

        const data = getSeasonData(season);
        const games = data.games || {};
        const results = data.results || {};
        const picks = data.picks || {};
        const seasonPickers = getPickersForSeason(season);

        // Initialize pickers if not already
        seasonPickers.forEach(picker => {
            if (!pickerStats[picker]) {
                pickerStats[picker] = {
                    name: picker,
                    lineWins: 0, lineLosses: 0, linePushes: 0,
                    suWins: 0, suLosses: 0,
                    blazinWins: 0, blazinLosses: 0, blazinPushes: 0,
                    totalWins: 0, totalLosses: 0, totalPushes: 0
                };
            }
        });

        // Iterate through all weeks
        Object.keys(games).forEach(weekKey => {
            const weekNum = parseInt(weekKey);
            if (isNaN(weekNum)) return;

            const weekGames = games[weekKey] || [];
            const weekResults = results[weekKey] || results[String(weekKey)] || {};
            const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

            weekGames.forEach(game => {
                const gameResult = weekResults[game.id] || weekResults[String(game.id)];
                if (!gameResult) return;

                seasonPickers.forEach(picker => {
                    const pickerWeekPicks = weekPicks[picker] || {};
                    const gamePick = getPicksForGame(pickerWeekPicks, game);
                    const stats = pickerStats[picker];
                    // Per picker, not per game: each is graded at their own
                    // line, which a locked pick carries its own copy of.
                    const atsWinner = atsWinnerForPick(game, gamePick, gameResult);

                    if (gamePick.line && atsWinner) {
                        if (atsWinner === 'push') {
                            stats.linePushes++;
                            stats.totalPushes++;
                        } else if (atsWinner === gamePick.line) {
                            stats.lineWins++;
                            stats.totalWins++;
                        } else {
                            stats.lineLosses++;
                            stats.totalLosses++;
                        }

                        if (gamePick.blazin) {
                            if (atsWinner === 'push') {
                                stats.blazinPushes++;
                            } else if (atsWinner === gamePick.line) {
                                stats.blazinWins++;
                            } else {
                                stats.blazinLosses++;
                            }
                        }
                    }

                    if (gamePick.winner) {
                        if (gameResult.winner === gamePick.winner) {
                            stats.suWins++;
                            stats.totalWins++;
                        } else {
                            stats.suLosses++;
                            stats.totalLosses++;
                        }
                    }
                });
            });
        });

        // Cowherd's Blazin' 5 for this season - archived for a finished one,
        // scored from the entered picks for the season in progress.
        const cowherdTotal = totalCowherdRecord(cowherdWeeklyResults(season));
        if (cowherdTotal.wins + cowherdTotal.losses + cowherdTotal.pushes > 0) {
            if (!pickerStats[COWHERD]) {
                pickerStats[COWHERD] = {
                    name: COWHERD,
                    lineWins: 0, lineLosses: 0, linePushes: 0,
                    suWins: 0, suLosses: 0,
                    blazinWins: 0, blazinLosses: 0, blazinPushes: 0,
                    totalWins: 0, totalLosses: 0, totalPushes: 0
                };
            }
            pickerStats[COWHERD].blazinWins += cowherdTotal.wins;
            pickerStats[COWHERD].blazinLosses += cowherdTotal.losses;
            pickerStats[COWHERD].blazinPushes += cowherdTotal.pushes;
        }
    });

    // Sort by Blazin' 5 percentage descending
    const sorted = Object.values(pickerStats).sort((a, b) => {
        const aBlazinTotal = a.blazinWins + a.blazinLosses;
        const bBlazinTotal = b.blazinWins + b.blazinLosses;
        const aBlazinPct = aBlazinTotal > 0 ? a.blazinWins / aBlazinTotal : 0;
        const bBlazinPct = bBlazinTotal > 0 ? b.blazinWins / bBlazinTotal : 0;
        if (bBlazinPct !== aBlazinPct) return bBlazinPct - aBlazinPct;
        return b.blazinWins - a.blazinWins;
    });

    tbody.innerHTML = sorted.map((stats, index) => {
        const hasLineData = stats.lineWins + stats.lineLosses + stats.linePushes > 0;
        const hasSuData = stats.suWins + stats.suLosses > 0;
        const lineRecord = hasLineData ? `${stats.lineWins}-${stats.lineLosses}${stats.linePushes > 0 ? `-${stats.linePushes}` : ''}` : '-';
        const suRecord = hasSuData ? `${stats.suWins}-${stats.suLosses}` : '-';
        const blazinRecord = `${stats.blazinWins}-${stats.blazinLosses}${stats.blazinPushes > 0 ? `-${stats.blazinPushes}` : ''}`;

        const lineTotal = stats.lineWins + stats.lineLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const linePctValue = lineTotal > 0 ? (stats.lineWins / lineTotal) * 100 : null;
        const linePct = lineTotal > 0 ? linePctValue.toFixed(1) + '%' : '-';
        const linePctClass = pctCellClass(linePctValue);

        const suTotal = stats.suWins + stats.suLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const suPctValue = suTotal > 0 ? (stats.suWins / suTotal) * 100 : null;
        const suPct = suTotal > 0 ? suPctValue.toFixed(1) + '%' : '-';
        const suPctClass = pctCellClass(suPctValue);

        const blazinTotal = stats.blazinWins + stats.blazinLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const blazinPctValue = blazinTotal > 0 ? (stats.blazinWins / blazinTotal) * 100 : null;
        const blazinPct = blazinTotal > 0 ? blazinPctValue.toFixed(1) + '%' : '-';
        const blazinPctClass = pctCellClass(blazinPctValue);

        return `
            <tr class="${index === 0 ? 'leader' : ''}" data-picker="${stats.name}">
                <td class="picker-name">${stats.name}</td>
                <td data-sort="${stats.lineWins}">${lineRecord}</td>
                <td class="${linePctClass}" data-sort="${linePctValue}">${linePct}</td>
                <td class="divider-left" data-sort="${stats.blazinWins}">${blazinRecord}</td>
                <td class="${blazinPctClass}" data-sort="${blazinPctValue}">${blazinPct}</td>
                <td class="divider-left" data-sort="${stats.suWins}">${suRecord}</td>
                <td class="${suPctClass}" data-sort="${suPctValue}">${suPct}</td>
            </tr>
        `;
    }).join('');

    // Reset sort indicators
    const table = document.getElementById('history-standings-table');
    if (table) {
        const headers = table.querySelectorAll('thead th');
        headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        if (headers[4]) {
            headers[4].classList.add('sort-desc');
        }
    }
}

/**
 * Render historical data for a specific week - matches Make Picks layout exactly
 */
function renderHistoryWeek(week) {
    const content = document.getElementById('history-content');
    if (!content) return;

    const seasonDropdown = document.getElementById('history-season-dropdown');
    const pickerDropdown = document.getElementById('history-picker-dropdown');
    const season = seasonDropdown ? parseInt(seasonDropdown.value) : null;
    const selectedPicker = pickerDropdown ? pickerDropdown.value : PICKERS[0];

    if (!season || !getSeasonData(season)) {
        content.innerHTML = '<p class="no-data-message">No historical data available.</p>';
        return;
    }

    const data = getSeasonData(season);
    const games = data.games[week] || data.games[String(week)] || [];
    const results = data.results[week] || data.results[String(week)] || {};
    const allPicks = data.picks[week] || data.picks[String(week)] || {};
    const pickerPicks = allPicks[selectedPicker] || {};

    if (games.length === 0) {
        content.innerHTML = '<p class="no-data-message">No games data for this week.</p>';
        return;
    }

    // Render game cards matching the Make Picks layout exactly
    content.innerHTML = games.map(game => {
        const gameIdStr = String(game.id);
        const gamePick = getPicksForGame(pickerPicks, game);
        const linePick = gamePick.line;
        const winnerPick = gamePick.winner;
        const isBlazin = gamePick.blazin || false;

        const result = results[game.id] || results[gameIdStr];
        const gameComplete = !!result;

        const spreadMissing = !hasUsableSpread(game);
        const awaySpreadDisplay = signedSpreadDisplay(game, 'away');
        const homeSpreadDisplay = signedSpreadDisplay(game, 'home');
        const awaySpreadWithParens = spreadMissing ? '' : `(${awaySpreadDisplay})`;
        const homeSpreadWithParens = spreadMissing ? '' : `(${homeSpreadDisplay})`;

        // Calculate pick results
        let lineAwayResult = '', lineHomeResult = '', winnerAwayResult = '', winnerHomeResult = '';
        if (gameComplete && result) {
            const atsWinner = atsWinnerForPick(game, gamePick, result);
            // Line pick results
            if (linePick === 'away' && atsWinner) {
                lineAwayResult = atsWinner === 'push' ? 'push' : (atsWinner === 'away' ? 'correct' : 'incorrect');
            }
            if (linePick === 'home' && atsWinner) {
                lineHomeResult = atsWinner === 'push' ? 'push' : (atsWinner === 'home' ? 'correct' : 'incorrect');
            }
            // Winner pick results
            if (winnerPick === 'away') {
                winnerAwayResult = result.winner === 'away' ? 'correct' : 'incorrect';
            }
            if (winnerPick === 'home') {
                winnerHomeResult = result.winner === 'home' ? 'correct' : 'incorrect';
            }
        }

        // Build final score display
        let gameStatusDisplay = '';
        if (gameComplete && result) {
            const awayWon = result.awayScore > result.homeScore;
            const homeWon = result.homeScore > result.awayScore;
            gameStatusDisplay = `
                <div class="game-final-score">
                    <span class="final-score-team ${awayWon ? 'winner' : ''}">
                        <span class="final-team-name">${game.away}</span>
                        <span class="final-team-score">${result.awayScore}</span>
                    </span>
                    <span class="final-score-divider">-</span>
                    <span class="final-score-team ${homeWon ? 'winner' : ''}">
                        <span class="final-team-score">${result.homeScore}</span>
                        <span class="final-team-name">${game.home}</span>
                    </span>
                </div>`;
        }

        const cardClasses = [
            'game-card',
            (linePick && winnerPick) ? 'has-pick' : ((linePick || winnerPick) ? 'has-partial-pick' : ''),
            'game-locked',
            gameComplete ? 'game-final' : ''
        ].filter(Boolean).join(' ');

        // Status badge
        const statusBadge = gameComplete
            ? '<span class="status-badge final">FINAL</span>'
            : '<span class="locked-badge">LOCKED</span>';

        return `
            <div class="${cardClasses}" data-game-id="${game.id}">
                <div class="game-header">
                    <span class="game-time">${game.time || ''}</span>
                    ${statusBadge}
                    <span class="game-day">${game.day || ''}</span>
                </div>
                ${gameStatusDisplay}

                <div class="game-matchup-line">
                    <span class="away-team">
                        <img src="${getTeamLogo(game.away)}" alt="${game.away} logo" class="team-logo" onerror="handleLogoError(this, '${game.away}')">
                        ${game.away} ${awaySpreadWithParens}
                    </span>
                    <span class="at-symbol">@</span>
                    <span class="home-team">
                        <img src="${getTeamLogo(game.home)}" alt="${game.home} logo" class="team-logo" onerror="handleLogoError(this, '${game.home}')">
                        ${game.home} ${homeSpreadWithParens}
                    </span>
                </div>

                <div class="picks-row">
                    <div class="pick-type">
                        <span class="pick-label">Line Pick (ATS)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${linePick === 'away' ? 'selected' : ''} ${lineAwayResult}" disabled>
                                ${game.away} ${awaySpreadDisplay}
                            </button>
                            <button class="pick-btn ${linePick === 'home' ? 'selected' : ''} ${lineHomeResult}" disabled>
                                ${game.home} ${homeSpreadDisplay}
                            </button>
                        </div>
                    </div>
                    <div class="pick-type">
                        <span class="pick-label">Straight Up (Winner)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${winnerPick === 'away' ? 'selected' : ''} ${winnerAwayResult}" disabled>
                                ${game.away}
                            </button>
                            <button class="pick-btn ${winnerPick === 'home' ? 'selected' : ''} ${winnerHomeResult}" disabled>
                                ${game.home}
                            </button>
                        </div>
                    </div>
                </div>

                <div class="game-footer">
                    <div class="game-location">
                        <span class="location-city">${game.location || ''}</span>
                        <span class="location-stadium">${game.stadium || ''}</span>
                    </div>
                    <button class="blazin-star ${isBlazin ? 'active' : ''}" disabled title="${isBlazin ? 'Blazin\' 5 Pick' : ''}">
                        <span class="blazin-label">B5</span>${isBlazin ? '★' : '☆'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// What the History standings table covers: 'season' is every week of the
// chosen season so far, 'week' is the one week in historyStandingsWeek.
// Module state, not read back off the controls, so the live-season refresh
// (which rebuilds the controls through loadHistorySeason) keeps the reader
// where they were.
let historyStandingsScope = 'season';
let historyStandingsWeek = null;

/** The season the History tab is on, or null for Lifetime. */
function historySelectedSeason() {
    const value = document.getElementById('history-season-dropdown')?.value;
    const season = Number(value);
    return value && !isNaN(season) ? season : null;
}

/**
 * The weeks of a season that have anything to stand on: at least one result.
 * A week of games still to be played has a row of dashes and nothing else,
 * which is not worth a place in the list.
 */
function historyStandingsWeeks(season) {
    const data = getSeasonData(season);
    if (!data) return [];
    const results = data.results || {};
    return Object.keys(data.games || {})
        .map(Number)
        .filter(week => !isNaN(week)
            && Object.keys(results[week] || results[String(week)] || {}).length > 0)
        .sort((a, b) => a - b);
}

/**
 * Fill the standings week dropdown for a season. The chosen week is kept
 * where the season still has it; otherwise the latest week, which for the
 * season in progress is the one just played.
 */
function populateHistoryStandingsWeeks(season) {
    const dropdown = document.getElementById('history-standings-week');
    const weeks = historyStandingsWeeks(season);
    if (!weeks.includes(historyStandingsWeek)) {
        historyStandingsWeek = weeks.length ? weeks[weeks.length - 1] : null;
    }
    if (!dropdown) return;
    dropdown.innerHTML = weeks.map(week =>
        `<option value="${week}"${week === historyStandingsWeek ? ' selected' : ''}>${historyWeekName(week)}</option>`
    ).join('');
}

/** "Week 3", or the round's name in the playoffs. */
function historyWeekName(week) {
    return isPlayoffWeek(week) ? PLAYOFF_WEEKS[week].name : `Week ${week}`;
}

/**
 * The toggle and week dropdown, matched to the season: "Season to Date"
 * while a season is being played, "Full Season" once it is over, and the
 * whole thing hidden on Lifetime, which has no weeks to choose between.
 */
function updateHistoryScopeControls(season) {
    const scope = document.getElementById('history-scope');
    if (!scope) return;
    scope.classList.toggle('hidden', !season);
    const seasonBtn = document.getElementById('history-scope-season');
    if (seasonBtn && season) {
        seasonBtn.textContent = Number(season) === CURRENT_SEASON ? 'Season to Date' : 'Full Season';
    }
    document.querySelectorAll('[data-history-scope]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.historyScope === historyStandingsScope);
    });
    document.getElementById('history-standings-week-selector')
        ?.classList.toggle('hidden', historyStandingsScope !== 'week');
}

/** Switch the standings table between the season and one week of it. */
function setHistoryStandingsScope(scope) {
    if (scope !== 'season' && scope !== 'week') return;
    historyStandingsScope = scope;
    const season = historySelectedSeason();
    updateHistoryScopeControls(season);
    if (season) renderHistoryStandingsTable(season);
}

/**
 * Each picker's ATS, Blazin' 5 and straight-up record for a season - or,
 * given a week, for that week alone. The one pass behind the History
 * standings table at either scope, so the two can never disagree.
 *
 * Cowherd is scored from his own weekly record. The 2022 and earlier
 * archives hold his as a season aggregate with no weeks in it, so there he
 * is on the season table and absent from any week's.
 */
function historyStandingsStats(season, week = null) {
    const data = getSeasonData(season);
    if (!data) return null;
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    // Get pickers for this season (Jason/Daniel started in 2023)
    const seasonPickers = getPickersForSeason(season);

    // Calculate stats for each picker
    const pickerStats = {};
    seasonPickers.forEach(picker => {
        pickerStats[picker] = {
            name: picker,
            lineWins: 0, lineLosses: 0, linePushes: 0,
            suWins: 0, suLosses: 0,
            blazinWins: 0, blazinLosses: 0, blazinPushes: 0,
            totalWins: 0, totalLosses: 0, totalPushes: 0
        };
    });

    // Iterate through the weeks in scope
    const weekKeys = week === null ? Object.keys(games) : [String(week)];
    weekKeys.forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        weekGames.forEach(game => {
            const gameResult = weekResults[game.id] || weekResults[String(game.id)];
            if (!gameResult) return; // Skip games without results

            seasonPickers.forEach(picker => {
                const pickerWeekPicks = weekPicks[picker] || {};
                const gamePick = getPicksForGame(pickerWeekPicks, game);
                const stats = pickerStats[picker];
                // Per picker, not per game: each is graded at their own
                // line, which a locked pick carries its own copy of.
                const atsWinner = atsWinnerForPick(game, gamePick, gameResult);

                // Line pick (ATS)
                if (gamePick.line && atsWinner) {
                    if (atsWinner === 'push') {
                        stats.linePushes++;
                        stats.totalPushes++;
                    } else if (atsWinner === gamePick.line) {
                        stats.lineWins++;
                        stats.totalWins++;
                    } else {
                        stats.lineLosses++;
                        stats.totalLosses++;
                    }

                    // Blazin' 5 tracking
                    if (gamePick.blazin) {
                        if (atsWinner === 'push') {
                            stats.blazinPushes++;
                        } else if (atsWinner === gamePick.line) {
                            stats.blazinWins++;
                        } else {
                            stats.blazinLosses++;
                        }
                    }
                }

                // Winner pick (Straight Up)
                if (gamePick.winner) {
                    if (gameResult.winner === gamePick.winner) {
                        stats.suWins++;
                        stats.totalWins++;
                    } else {
                        stats.suLosses++;
                        stats.totalLosses++;
                    }
                }
            });
        });
    });

    // Cowherd has a Blazin' 5 record and nothing else, whether it comes from
    // the season's archive or, for the season in progress, from the picks
    // entered so far.
    const cowherdWeekly = cowherdWeeklyResults(season);
    const cowherdTotal = week === null
        ? totalCowherdRecord(cowherdWeekly)
        : (cowherdWeekly && !cowherdWeekly.aggregate && cowherdWeekly[week]) || emptyRecord();
    if (cowherdTotal.wins + cowherdTotal.losses + cowherdTotal.pushes > 0) {
        pickerStats[COWHERD] = {
            name: COWHERD,
            lineWins: 0, lineLosses: 0, linePushes: 0,
            suWins: 0, suLosses: 0,
            blazinWins: cowherdTotal.wins || 0,
            blazinLosses: cowherdTotal.losses || 0,
            blazinPushes: cowherdTotal.pushes || 0,
            totalWins: 0, totalLosses: 0, totalPushes: 0
        };
    }

    return pickerStats;
}

/**
 * Render the History standings table: the season's totals, or one week's
 * when the scope toggle is on Individual Weeks.
 */
function renderHistoryStandingsTable(season) {
    const tbody = document.getElementById('history-standings-table-body');
    const titleSpan = document.getElementById('history-standings-title');
    const scopeLabel = document.getElementById('history-standings-scope-label');
    if (!tbody) return;

    const week = historyStandingsScope === 'week' ? historyStandingsWeek : null;

    if (titleSpan) {
        titleSpan.textContent = season;
    }
    if (scopeLabel) {
        scopeLabel.textContent = week === null ? 'Season' : historyWeekName(week);
    }

    const pickerStats = historyStandingsStats(season, week);
    if (!pickerStats) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">No data available</td></tr>';
        return;
    }
    if (historyStandingsScope === 'week' && week === null) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">No weeks played yet</td></tr>';
        return;
    }

    // Sort by Blazin' 5 percentage descending, then by Blazin' wins
    const sorted = Object.values(pickerStats).sort((a, b) => {
        const aBlazinTotal = a.blazinWins + a.blazinLosses;
        const bBlazinTotal = b.blazinWins + b.blazinLosses;
        const aBlazinPct = aBlazinTotal > 0 ? a.blazinWins / aBlazinTotal : 0;
        const bBlazinPct = bBlazinTotal > 0 ? b.blazinWins / bBlazinTotal : 0;
        if (bBlazinPct !== aBlazinPct) return bBlazinPct - aBlazinPct;
        return b.blazinWins - a.blazinWins;
    });

    tbody.innerHTML = sorted.map((stats, index) => {
        const hasLineData = stats.lineWins + stats.lineLosses + stats.linePushes > 0;
        const hasSuData = stats.suWins + stats.suLosses > 0;
        const lineRecord = hasLineData ? `${stats.lineWins}-${stats.lineLosses}${stats.linePushes > 0 ? `-${stats.linePushes}` : ''}` : '-';
        const suRecord = hasSuData ? `${stats.suWins}-${stats.suLosses}` : '-';
        const blazinRecord = `${stats.blazinWins}-${stats.blazinLosses}${stats.blazinPushes > 0 ? `-${stats.blazinPushes}` : ''}`;

        // ATS percentage
        const lineTotal = stats.lineWins + stats.lineLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const linePctValue = lineTotal > 0 ? (stats.lineWins / lineTotal) * 100 : null;
        const linePct = lineTotal > 0 ? linePctValue.toFixed(1) + '%' : '-';
        const linePctClass = pctCellClass(linePctValue);

        // Straight Up percentage
        const suTotal = stats.suWins + stats.suLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const suPctValue = suTotal > 0 ? (stats.suWins / suTotal) * 100 : null;
        const suPct = suTotal > 0 ? suPctValue.toFixed(1) + '%' : '-';
        const suPctClass = pctCellClass(suPctValue);

        // Blazin' 5 percentage
        const blazinTotal = stats.blazinWins + stats.blazinLosses;
        // null, not 0, when there is nothing to average: an empty record
        // is not a total loss, and pctCellClass reads it that way.
        const blazinPctValue = blazinTotal > 0 ? (stats.blazinWins / blazinTotal) * 100 : null;
        const blazinPct = blazinTotal > 0 ? blazinPctValue.toFixed(1) + '%' : '-';
        const blazinPctClass = pctCellClass(blazinPctValue);

        return `
            <tr class="${index === 0 ? 'leader' : ''}" data-picker="${stats.name}">
                <td class="picker-name">${stats.name}</td>
                <td data-sort="${stats.lineWins}">${lineRecord}</td>
                <td class="${linePctClass}" data-sort="${linePctValue}">${linePct}</td>
                <td class="divider-left" data-sort="${stats.blazinWins}">${blazinRecord}</td>
                <td class="${blazinPctClass}" data-sort="${blazinPctValue}">${blazinPct}</td>
                <td class="divider-left" data-sort="${stats.suWins}">${suRecord}</td>
                <td class="${suPctClass}" data-sort="${suPctValue}">${suPct}</td>
            </tr>
        `;
    }).join('');

    // Setup sortable headers
    const table = document.getElementById('history-standings-table');
    if (table && !table._sortInitialized) {
        setupHistoryTableSorting(table);
        table._sortInitialized = true;
    }

    // Mark Blazin' 5 % column (index 4) as default sorted
    if (table) {
        const headers = table.querySelectorAll('thead th');
        headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        if (headers[4]) {
            headers[4].classList.add('sort-desc');
        }
    }
}

/**
 * Setup sorting for history standings table
 */
function setupHistoryTableSorting(table) {
    const headers = table.querySelectorAll('thead th');

    headers.forEach((th, index) => {
        th.style.cursor = 'pointer';
        th.title = 'Click to sort';

        th.addEventListener('click', () => {
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const isAscending = th.classList.contains('sort-asc');

            headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));

            rows.sort((a, b) => {
                const aCell = a.cells[index];
                const bCell = b.cells[index];

                let aVal = aCell.dataset.sort !== undefined ? parseFloat(aCell.dataset.sort) : aCell.textContent.trim();
                let bVal = bCell.dataset.sort !== undefined ? parseFloat(bCell.dataset.sort) : bCell.textContent.trim();

                if (index === 0) {
                    return isAscending ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                }

                if (isNaN(aVal)) aVal = 0;
                if (isNaN(bVal)) bVal = 0;

                return isAscending ? aVal - bVal : bVal - aVal;
            });

            th.classList.add(isAscending ? 'sort-desc' : 'sort-asc');

            rows.forEach((row, i) => {
                row.classList.remove('leader');
                if (i === 0) row.classList.add('leader');
                tbody.appendChild(row);
            });
        });
    });
}

/**
 * Set current season and reload data
 * @param {number} season - Season year to switch to
 */
async function setCurrentSeason(season) {
    if (season === currentSeason) return;

    const previousSeason = currentSeason;
    currentSeason = season;

    // Update season display in header
    const seasonDisplay = document.getElementById('season-display');
    if (seasonDisplay) {
        seasonDisplay.textContent = season;
    }

    // Update dropdown selection
    const seasonDropdown = document.getElementById('season-dropdown');
    if (seasonDropdown) {
        seasonDropdown.value = season;
    }

    // Load season data (lazy loading for historical seasons)
    if (isHistoricalSeason()) {
        const data = await loadSeasonData(season);
        if (!data) {
            // Failed to load - revert
            currentSeason = previousSeason;
            if (seasonDropdown) seasonDropdown.value = previousSeason;
            if (seasonDisplay) seasonDisplay.textContent = previousSeason;
            return;
        }
    }

    // Update week to appropriate default
    if (isHistoricalSeason()) {
        // Historical season: start at week 1 (or keep current if valid)
        const maxWeek = getMaxWeekForSeason(season);
        if (currentWeek > maxWeek) {
            currentWeek = 1;
        }
    } else {
        // Current season: go to current NFL week
        currentWeek = CURRENT_NFL_WEEK;
    }

    // Rebuild week dropdown for the season
    setupWeekButtonsForSeason(season);

    // Update read-only state
    updateSeasonReadOnlyState();

    // Refresh the UI
    updateWeekUI();

    // Re-render dashboard if on standings tab
    if (currentCategory === 'standings') {
        renderDashboard();
    }

    console.log(`Switched to ${season} season`);
}

/**
 * Setup week buttons for a specific season
 * @param {number} season - Season year
 */
function setupWeekButtonsForSeason(season) {
    const weekDropdown = document.getElementById('week-dropdown');
    if (!weekDropdown) return;

    let optionsHtml = '';

    if (isHistoricalSeason()) {
        // Historical season: show all weeks with data
        const maxWeek = getMaxWeekForSeason(season);

        // Playoffs section
        if (maxWeek >= FIRST_PLAYOFF_WEEK) {
            optionsHtml += '<optgroup label="Playoffs">';
            for (let week = Math.min(maxWeek, LAST_PLAYOFF_WEEK); week >= FIRST_PLAYOFF_WEEK; week--) {
                const games = getGamesForWeekAndSeason(week, season);
                if (games.length > 0) {
                    const selected = week === currentWeek ? 'selected' : '';
                    optionsHtml += `<option value="${week}" ${selected}>${PLAYOFF_WEEKS[week].name}</option>`;
                }
            }
            optionsHtml += '</optgroup>';
        }

        // Regular Season section
        optionsHtml += '<optgroup label="Regular Season">';
        for (let week = TOTAL_WEEKS; week >= 1; week--) {
            const games = getGamesForWeekAndSeason(week, season);
            if (games.length > 0) {
                const selected = week === currentWeek ? 'selected' : '';
                optionsHtml += `<option value="${week}" ${selected}>Week ${week}</option>`;
            }
        }
        optionsHtml += '</optgroup>';
    } else {
        // Current season: use existing logic
        const effectiveWeek = typeof getMaxNavigableWeek === 'function'
            ? getMaxNavigableWeek()
            : Math.min(CURRENT_NFL_WEEK, LAST_PLAYOFF_WEEK);

        // Playoffs section (if we're in or past playoffs)
        if (effectiveWeek >= FIRST_PLAYOFF_WEEK) {
            optionsHtml += '<optgroup label="Playoffs">';
            for (let week = effectiveWeek; week >= FIRST_PLAYOFF_WEEK; week--) {
                const selected = week === currentWeek ? 'selected' : '';
                optionsHtml += `<option value="${week}" ${selected}>${PLAYOFF_WEEKS[week].name}</option>`;
            }
            optionsHtml += '</optgroup>';
        }

        // Regular Season section
        optionsHtml += '<optgroup label="Regular Season">';
        const maxRegularWeek = Math.min(effectiveWeek, TOTAL_WEEKS);
        for (let week = maxRegularWeek; week >= 1; week--) {
            const selected = week === currentWeek ? 'selected' : '';
            optionsHtml += `<option value="${week}" ${selected}>Week ${week}</option>`;
        }
        optionsHtml += '</optgroup>';
    }

    weekDropdown.innerHTML = optionsHtml;
}

/**
 * Update the read-only state based on current season
 */
function updateSeasonReadOnlyState() {
    const makePicksSection = document.getElementById('make-picks-section');
    const historicalBanner = document.getElementById('historical-season-banner');
    const bannerSeasonYear = document.getElementById('banner-season-year');

    if (isHistoricalSeason()) {
        // Add read-only class
        if (makePicksSection) {
            makePicksSection.classList.add('season-readonly');
        }
        // Show historical banner
        if (historicalBanner) {
            historicalBanner.classList.remove('hidden');
        }
        if (bannerSeasonYear) {
            bannerSeasonYear.textContent = currentSeason;
        }
    } else {
        // Remove read-only class
        if (makePicksSection) {
            makePicksSection.classList.remove('season-readonly');
        }
        // Hide historical banner
        if (historicalBanner) {
            historicalBanner.classList.add('hidden');
        }
    }
}

/**
 * Set current week and fetch data if needed
 */
async function setCurrentWeek(week) {
    currentWeek = week;

    // Update dropdown
    const weekDropdown = document.getElementById('week-dropdown');
    if (weekDropdown) {
        weekDropdown.value = week;
    }

    // Update header with correct week name (e.g., "Wild Card Week Picks" for playoff weeks)
    const picksWeekNum = document.getElementById('picks-week-num');
    if (picksWeekNum) {
        picksWeekNum.textContent = getWeekTitle(week, 'Picks');
    }
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (scoringWeekNum) {
        scoringWeekNum.textContent = getWeekTitle(week, 'Scoring Summary');
    }

    // Hide game filters for playoff weeks (not useful with only 4-6 games)
    const gameFilters = document.querySelector('.game-filters');
    if (gameFilters) {
        if (week >= 19) {
            gameFilters.style.display = 'none';
            // Reset filter to 'all' so all games show
            currentGameFilter = 'all';
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
            if (allBtn) allBtn.classList.add('active');
        } else {
            gameFilters.style.display = '';
        }
    }

    // Show loading indicator
    const loadingIndicator = document.getElementById('week-loading');
    if (loadingIndicator) {
        loadingIndicator.classList.remove('hidden');
    }

    // Fetch week data if we have a GID for it and it's not cached
    // (skipped when the workbook belongs to a previous season)
    if (LEGACY_SHEETS_SEASON === CURRENT_SEASON && WEEK_SHEET_GIDS[week] && !weeklyPicksCache[week]) {
        const weekUrl = `${GOOGLE_SHEETS_BASE_URL}&gid=${WEEK_SHEET_GIDS[week]}`;
        const CORS_PROXIES = [
            '', // Try direct first
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url='
        ];

        for (const proxy of CORS_PROXIES) {
            try {
                const url = proxy ? proxy + encodeURIComponent(weekUrl) : weekUrl;

                // Add 10 second timeout to prevent hanging on slow proxies
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(url, { method: 'GET', signal: controller.signal });
                clearTimeout(timeoutId);

                if (!response.ok) continue;

                const csvText = await response.text();
                if (csvText.includes('<!DOCTYPE') || csvText.length < 50) continue;

                const weekData = parseWeeklyPicksCSV(csvText, week);
                weeklyPicksCache[week] = weekData;

                // DISABLED: Pick data now comes from historical-data.js
                // if (weekData.picks) {
                //     allPicks[week] = weekData.picks;
                // }
                if (weekData.games && weekData.games.length > 0) {
                    NFL_GAMES_BY_WEEK[week] = weekData.games;
                }
                if (weekData.results) {
                    NFL_RESULTS_BY_WEEK[week] = weekData.results;
                }

                console.log(`Loaded week ${week} data` + (proxy ? ' via proxy' : ' directly'));
                break;
            } catch (err) {
                // Try next proxy
            }
        }
    }

    // Load schedule from ESPN for current/future weeks, playoffs, and historical weeks missing full game info
    const existingGames = NFL_GAMES_BY_WEEK[week];
    const hasIncompleteData = existingGames && existingGames.length > 0 && !existingGames[0].day;
    const needsScheduleFetch = week >= CURRENT_NFL_WEEK ||
                               isPlayoffWeek(week) ||
                               !existingGames ||
                               existingGames.length === 0 ||
                               hasIncompleteData;

    if (needsScheduleFetch) {
        await loadWeekSchedule(week);

        // For playoff weeks, also refresh odds to get O/U lines
        if (isPlayoffWeek(week)) {
            await updateOddsFromAPI(false); // Use cache if fresh, otherwise fetch
        }
    }

    // Load picks from Google Sheets backup if localStorage is empty for this week
    await loadAllPicksFromBackup();

    // Hide loading indicator
    if (loadingIndicator) {
        loadingIndicator.classList.add('hidden');
    }

    // Update navigation buttons
    updateWeekNavButtons();

    // Re-render
    renderGames();
    renderScoringSummary();
}


/**
 * Setup category tab switching
 */
function setupTabs() {
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const category = tab.dataset.category;
            setActiveCategory(category);
        });
    });

    // Setup subtab clicks for standings
    subtabs.forEach(subtab => {
        subtab.addEventListener('click', () => {
            const subcategory = subtab.dataset.subcategory;
            setActiveSubcategory(subcategory);
        });
    });

    // And for the Live tab's strip
    document.querySelectorAll('#live-subtabs .subtab').forEach(subtab => {
        subtab.addEventListener('click', () => {
            setLiveSubcategory(subtab.dataset.liveSubcategory);
        });
    });

    // Standings table scope: the season so far, or one week of it.
    document.querySelectorAll('[data-standings-scope]').forEach(btn => {
        btn.addEventListener('click', () => setStandingsScope(btn.dataset.standingsScope));
    });
    const standingsWeekDropdown = document.getElementById('standings-week');
    if (standingsWeekDropdown) {
        standingsWeekDropdown.addEventListener('change', (e) => {
            standingsWeek = parseInt(e.target.value);
            renderDashboard();
        });
    }
}

/**
 * Set active subcategory within standings
 */
async function setActiveSubcategory(subcategory) {
    currentSubcategory = subcategory;

    // Update subtab styling
    subtabs.forEach(subtab => {
        subtab.classList.toggle('active', subtab.dataset.subcategory === subcategory);
    });

    // For playoffs tab, show loading state while data loads
    if (subcategory === 'playoffs') {
        // Immediately hide current content and show loading
        const leaderboard = document.getElementById('leaderboard');
        const performanceSection = document.getElementById('performance-insights-section');
        const recordsSection = document.getElementById('records-analysis-section');
        const playoffStandingsSection = document.getElementById('playoff-standings-section');
        const playoffComparisonSection = document.getElementById('playoff-comparison-section');
        const tabLoadingEl = document.getElementById('tab-loading');

        // Hide all content sections
        leaderboard?.classList.add('hidden');
        performanceSection?.classList.add('hidden');
        recordsSection?.classList.add('hidden');
        playoffStandingsSection?.classList.add('hidden');
        playoffComparisonSection?.classList.add('hidden');

        // Show loading message
        if (tabLoadingEl) {
            tabLoadingEl.classList.remove('hidden');
        }

        // Load playoff data
        await loadAllPlayoffSchedules();

        // Check if user switched away from standings tab during async load
        if (currentCategory !== 'standings') {
            // User navigated away, don't show standings content
            if (tabLoadingEl) {
                tabLoadingEl.classList.add('hidden');
            }
            return;
        }

        // Hide loading message
        if (tabLoadingEl) {
            tabLoadingEl.classList.add('hidden');
        }

        // Show leaderboard again for the render
        leaderboard?.classList.remove('hidden');
    }

    // Check again before rendering (in case of fast tab switches)
    if (currentCategory !== 'standings') {
        return;
    }

    // Re-render dashboard with new subcategory
    renderDashboard();
}

// Track if playoff schedules have been loaded this session
let playoffSchedulesLoaded = false;

/**
 * Load schedules for all playoff weeks
 * Only fetches from ESPN if games are missing scores (for completed games)
 */
async function loadAllPlayoffSchedules() {
    const weeksToLoad = [];

    for (let week = FIRST_PLAYOFF_WEEK; week <= LAST_PLAYOFF_WEEK; week++) {
        const games = getGamesForWeek(week);

        // Always fetch if no games for this week (e.g., Super Bowl not yet available)
        if (!games || games.length === 0) {
            weeksToLoad.push(week);
            continue;
        }

        // Skip if already loaded this session and we have games
        if (playoffSchedulesLoaded) {
            continue;
        }

        // Check if we need to fetch: games without scores/status for completed games
        const needsFetch = games.some(game => {
            // If game has a status indicating it's complete but no scores, we need to fetch
            const isComplete = game.status === 'STATUS_FINAL' || game.status === 'final' || game.completed;
            const hasScores = (game.homeScore !== undefined && game.homeScore !== 0) ||
                             (game.awayScore !== undefined && game.awayScore !== 0);
            // Also fetch if game should be complete (kickoff in the past) but we don't have status
            const kickoffPassed = game.kickoff && new Date(game.kickoff) < new Date();
            const missingStatus = kickoffPassed && !game.status;
            // For historical games without status/kickoff, always fetch to get ESPN data
            const isHistoricalWithoutStatus = !game.status && !game.kickoff;

            return (isComplete && !hasScores) || missingStatus || isHistoricalWithoutStatus;
        });

        if (needsFetch) {
            weeksToLoad.push(week);
        }
    }

    if (weeksToLoad.length > 0) {
        const loadPromises = weeksToLoad.map(async (week) => {
            console.log(`[Playoffs] Loading schedule for week ${week}...`);
            await loadWeekSchedule(week, false);
        });

        await Promise.all(loadPromises);
        console.log(`[Playoffs] Loaded ${weeksToLoad.length} playoff week schedules`);
    } else {
        console.log(`[Playoffs] All playoff schedules already loaded with scores`);
    }

    // Mark as loaded for this session
    playoffSchedulesLoaded = true;
}

/**
 * Every other picker dropdown that follows the Make Picks selection.
 * history-blazin-picker is deliberately left out: it keeps its own
 * group-wide "All" default.
 */
const LINKED_PICKER_DROPDOWNS = [
    'team-records-picker',
    'blazin-records-picker',
    'patterns-picker-filter',
    'history-picker-dropdown'
];

/**
 * Point the Records & Analysis / History picker dropdowns at whoever is
 * selected in Make Picks, so the whole page is showing the same player.
 * @param {boolean} render - fire each dropdown's change handler to redraw its panel
 */
function syncPickerDropdowns(render = true) {
    if (!currentPicker) return;

    LINKED_PICKER_DROPDOWNS.forEach(id => {
        if (id === 'patterns-picker-filter') populatePatternsPickerOptions();
        const dropdown = document.getElementById(id);
        if (!dropdown) return;
        // Pre-2023 seasons have no Jason/Daniel, so the option may not exist
        const hasPicker = Array.from(dropdown.options).some(o => o.value === currentPicker);
        if (!hasPicker || dropdown.value === currentPicker) return;
        dropdown.value = currentPicker;
        if (render) dropdown.dispatchEvent(new Event('change'));
    });
}

/**
 * Setup picker selection dropdown
 */
function setupPickerButtons() {
    const pickerDropdown = document.getElementById('picker-dropdown');
    if (!pickerDropdown) return;

    // Set initial value (empty string for null picker shows "- Choose Picker -")
    pickerDropdown.value = currentPicker || '';

    // Update picks-disabled class based on picker selection
    updatePicksDisabledState();

    // Show/hide admin-only buttons based on picker
    updateAdminButtons();

    pickerDropdown.addEventListener('change', (e) => {
        const newValue = e.target.value;
        currentPicker = newValue || null;
        if (currentPicker) {
            localStorage.setItem('selectedPicker', currentPicker);
        } else {
            localStorage.removeItem('selectedPicker');
        }
        // Update picks-disabled class
        updatePicksDisabledState();
        // Show/hide admin-only buttons based on picker
        updateAdminButtons();
        // Update nav button states
        updatePickerNavButtons();
        // Re-render games with current picker's selections
        renderGames();
        renderScoringSummary();
        syncPickerDropdowns();
    });

    // Setup picker navigation buttons
    setupPickerNavigation();
}

/**
 * Setup picker navigation (prev/next buttons)
 */
function setupPickerNavigation() {
    const prevBtn = document.getElementById('prev-picker-btn');
    const nextBtn = document.getElementById('next-picker-btn');
    const pickerDropdown = document.getElementById('picker-dropdown');

    if (!prevBtn || !nextBtn || !pickerDropdown) return;

    prevBtn.addEventListener('click', () => {
        const currentIndex = PICKERS.indexOf(currentPicker);
        if (currentIndex > 0) {
            currentPicker = PICKERS[currentIndex - 1];
            pickerDropdown.value = currentPicker;
            localStorage.setItem('selectedPicker', currentPicker);
            updateAdminButtons();
            updatePickerNavButtons();
            renderGames();
            renderScoringSummary();
            syncPickerDropdowns();
        }
    });

    nextBtn.addEventListener('click', () => {
        const currentIndex = PICKERS.indexOf(currentPicker);
        if (currentIndex < PICKERS.length - 1) {
            currentPicker = PICKERS[currentIndex + 1];
            pickerDropdown.value = currentPicker;
            localStorage.setItem('selectedPicker', currentPicker);
            updateAdminButtons();
            updatePickerNavButtons();
            renderGames();
            renderScoringSummary();
            syncPickerDropdowns();
        }
    });

    // Set initial button states
    updatePickerNavButtons();
}

/**
 * Update picker navigation button states
 */
function updatePickerNavButtons() {
    const prevBtn = document.getElementById('prev-picker-btn');
    const nextBtn = document.getElementById('next-picker-btn');
    const currentIndex = currentPicker ? PICKERS.indexOf(currentPicker) : -1;

    // Disable prev if no picker selected or at first picker
    if (prevBtn) prevBtn.disabled = currentIndex <= 0;
    // Disable next if no picker selected or at last picker
    if (nextBtn) nextBtn.disabled = !currentPicker || currentIndex >= PICKERS.length - 1;
}

/**
 * Update picks-disabled state based on whether a picker is selected
 */
function updatePicksDisabledState() {
    const makePicksSection = document.getElementById('make-picks-section');
    if (makePicksSection) {
        if (!currentPicker) {
            makePicksSection.classList.add('picks-disabled');
        } else {
            makePicksSection.classList.remove('picks-disabled');
        }
    }
}

/**
 * Show/hide admin-only buttons based on current picker
 */
function updateAdminButtons() {
    const adminButtons = document.querySelectorAll('.admin-only');
    adminButtons.forEach(btn => {
        if (currentPicker === 'Stephen') {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }
    });

    // Hide/show the picker-specific action buttons based on picker selection.
    ['clear-picks-btn', 'freeze-all-btn-mobile'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.style.display = currentPicker ? '' : 'none';
    });
}

/**
 * Setup picks action buttons
 */
function setupPicksActions() {
    document.getElementById('clear-picks-btn')?.addEventListener('click', clearCurrentPickerPicks);
    document.getElementById('freeze-all-btn')?.addEventListener('click', freezeAllCompleteGames);

    // A longer debounce means more can be outstanding when someone closes the
    // tab or switches away, and unsynced picks would be overwritten by the
    // backup on the next load. visibilitychange is the reliable hook for this;
    // beforeunload cannot be trusted to complete a fetch.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushPendingSync();
        }
    });
    document.getElementById('freeze-all-btn-mobile')?.addEventListener('click', freezeAllCompleteGames);

    // Cowherd's Blazin' 5, admin only. Delegated because the rows are redrawn
    // from storage on every week change.
    document.getElementById('cowherd-save-btn')?.addEventListener('click', saveCowherdPanel);
    document.getElementById('cowherd-clear-btn')?.addEventListener('click', () => {
        requestConfirmation(
            `Clear Cowherd's picks for ${isPlayoffWeek(currentWeek) ? getWeekDisplayName(currentWeek) : `week ${currentWeek}`}?`,
            'They can be entered again at any time.',
            { confirmLabel: 'Clear' },
            () => {
                saveCowherdPicks(currentWeek, []);
                renderCowherdPanel();
                showToast('Cleared Cowherd\u2019s picks for this week');
            });
    });
    document.getElementById('cowherd-rows')?.addEventListener('change', handleCowherdRowChange);
    document.getElementById('reset-all-picks-btn')?.addEventListener('click', resetAllPicks);
    document.getElementById('copy-picks-btn')?.addEventListener('click', copyPicksToClipboard);

    // Refresh spreads button (admin only - at bottom of picks section)
    document.getElementById('refresh-spreads-btn')?.addEventListener('click', async () => {
        showToast('Refreshing spreads from API...');
        const success = await updateSpreadsFromAPI(true); // Force refresh
        if (success) {
            // Sync to Google Sheets so other users get the updated spreads
            await syncSpreadsToGoogleSheets();
            showToast('Spreads updated and synced!', 'success');
            renderGames(); // Re-render to show new spreads
        } else {
            showToast('Could not fetch odds. Using saved/fallback spreads.', 'warning');
            // Still render - saved spreads should be applied
            renderGames();
        }
    });

    // Export all picks button (admin only)
    document.getElementById('export-all-picks-btn')?.addEventListener('click', exportAllPicksToClipboard);
}

// Countdown interval reference
let countdownInterval = null;

/**
 * Update individual game countdowns
 */
function updateGameCountdowns() {
    const countdownElements = document.querySelectorAll('.game-lock-countdown');
    const now = new Date();

    countdownElements.forEach(el => {
        const kickoff = el.dataset.kickoff;
        if (!kickoff) return;

        const kickoffTime = new Date(kickoff);
        const diff = kickoffTime - now;

        if (diff <= 0) {
            // Game has started - hide countdown, will be updated on next render
            el.innerHTML = '<span class="countdown-locked">Locked</span>';
            el.classList.add('locked');
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        let timeStr;
        if (hours > 24) {
            const days = Math.floor(hours / 24);
            timeStr = `${days}d ${hours % 24}h`;
        } else if (hours > 0) {
            timeStr = `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            timeStr = `${minutes}m ${seconds}s`;
        } else {
            timeStr = `${seconds}s`;
        }

        // Check if urgent (less than 1 hour)
        const isUrgent = diff < 60 * 60 * 1000;
        el.classList.toggle('urgent', isUrgent);

        el.innerHTML = `<span class="countdown-label">Game begins in</span> <span class="countdown-time">${timeStr}</span>`;
    });
}

/**
 * Start the countdown timer for individual games
 */
function startCountdownTimer() {
    // Clear existing interval
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    // Update immediately
    updateGameCountdowns();

    // Update every second
    countdownInterval = setInterval(() => {
        updateGameCountdowns();
    }, 1000);
}

/**
 * Stop the countdown timer
 */
function stopCountdownTimer() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
}


/**
 * Load CSV data from text content
 */
function loadCSVData(csvText) {
    dashboardData = parseNFLPicksCSV(csvText);

    // Update week info (if element exists)
    const currentWeekEl = document.getElementById('current-week');
    if (currentWeekEl) {
        currentWeekEl.textContent = `Week ${dashboardData.currentWeek}`;
    }

    // Update picks week number
    const picksWeekNum = document.getElementById('picks-week-num');
    if (picksWeekNum) {
        picksWeekNum.textContent = getWeekTitle(currentWeek, 'Picks');
    }
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (scoringWeekNum) {
        scoringWeekNum.textContent = getWeekTitle(currentWeek, 'Scoring Summary');
    }

    // Note: hideLoadingState() is now called after schedule/odds load in loadFromGoogleSheets()
    setActiveCategory(currentCategory);
}

// Google Sheets base URL and sheet IDs
// The main sheet (gid=0) has overall stats, each week has its own tab
// LEGACY_SHEETS_SEASON tags which season this workbook tracks. When it isn't the
// current season, the workbook is not loaded (part of the automatic July 1st
// offseason reset). When the new season's workbook is ready, update the URL,
// the WEEK_SHEET_GIDS, and this tag together.
const LEGACY_SHEETS_SEASON = 2025;
const GOOGLE_SHEETS_BASE_URL = 'https://docs.google.com/spreadsheets/d/1JuftzmWWIlquN1oKrFqPNaGjMu9ysdnCHqCDj9lYzfE/export?format=csv';
const GOOGLE_SHEETS_CSV_URL = GOOGLE_SHEETS_BASE_URL + '&gid=0';

// Sheet GIDs for each week tab
const WEEK_SHEET_GIDS = {
    1: '1734615654',
    2: '1689030244',
    3: '1682701664',
    4: '64532151',
    5: '1746053715',
    6: '198483855',
    7: '1162901378',
    8: '2082913151',
    9: '1101281524',
    10: '238951705',
    11: '323147745',
    12: '1165295828',
    13: '1809558420',
    14: '1764593710',
    15: '1886857596',
    16: '1562551321',
    17: '1473362295',
    18: '2065335001'
};

// Cache for loaded week data
const weeklyPicksCache = {};

/**
 * Load data from published Google Sheet via worker proxy
 */
async function loadFromGoogleSheets() {
    console.log('Fetching from Google Sheets...');
    const loadStart = performance.now();
    updateLoadingProgress(15, 'Connecting to data source...');

    try {
        let stepStart;
        if (LEGACY_SHEETS_SEASON === CURRENT_SEASON) {
            updateLoadingProgress(25, 'Fetching dashboard data...');

            // Use worker proxy to avoid CORS issues
            const proxyUrl = `${WORKER_PROXY_URL}/sheets?url=${encodeURIComponent(GOOGLE_SHEETS_CSV_URL)}`;

            // Add 15 second timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            stepStart = performance.now();
            const response = await fetch(proxyUrl, { method: 'GET', signal: controller.signal });
            clearTimeout(timeoutId);
            console.log(`[Timing] Main CSV fetch: ${(performance.now() - stepStart).toFixed(0)}ms`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            updateLoadingProgress(50, 'Processing data...');
            const csvText = await response.text();

            // Validate we got actual CSV data (not an error page)
            if (csvText.includes('<!DOCTYPE') || csvText.length < 100) {
                throw new Error('Invalid response');
            }

            updateLoadingProgress(70, 'Preparing charts...');
            stepStart = performance.now();
            loadCSVData(csvText);
            console.log(`[Timing] CSV parsing: ${(performance.now() - stepStart).toFixed(0)}ms`);
        } else {
            // The stats workbook belongs to a previous season - start the new season
            // with empty dashboard data instead of last season's numbers.
            console.log(`[Season] Skipping legacy stats workbook (tagged ${LEGACY_SHEETS_SEASON}, current season is ${CURRENT_SEASON})`);
            updateLoadingProgress(70, 'Preparing charts...');
        }

        // Load only ESPN schedule on critical path (picks already loaded from localStorage)
        // Skip spreads load for faster startup - will load in background
        updateLoadingProgress(85, 'Loading schedule...');
        stepStart = performance.now();
        await loadWeekSchedule(currentWeek, true, true); // skipSpreadsLoad=true
        console.log(`[Timing] ESPN schedule: ${(performance.now() - stepStart).toFixed(0)}ms`);

        // Check if all games in current week are complete and advance if needed
        const advanced = await checkAndAdvanceWeekIfNeeded();
        if (advanced) {
            console.log(`[Init] Advanced to ${getWeekDisplayName(currentWeek)}`);
        }

        // Mark initial load as complete before rendering
        initialLoadComplete = true;
        console.log(`[Timing] === TOTAL LOAD TIME: ${(performance.now() - loadStart).toFixed(0)}ms ===`);

        // Re-render after schedule and odds are loaded
        renderActiveTab();

        // Now hide loading state after all data is loaded
        hideLoadingState();

        // Background load remaining data (non-blocking)
        setTimeout(async () => {
            const bgStart = performance.now();

            // Load all background data in parallel
            console.log('[Background] Syncing all background data...');
            // Season standings are computed from picks + results once the
            // legacy stats workbook is out of date, which needs every played
            // week's schedule, not just the one on screen.
            const schedulesReady = LEGACY_SHEETS_SEASON !== CURRENT_SEASON
                ? preloadSeasonSchedules()
                : Promise.resolve();
            const resultsReady = loadAllResultsFromBackup();

            // A result is filed against a game, so the standings need both: the
            // sheet's rows AND the schedules to hang them on.
            const standingsReady = Promise.all([schedulesReady, resultsReady])
                .then(() => {
                    applyPendingSheetResults();
                    renderActiveTab();
                });

            // Writing down what ESPN knows and the sheet does not. Deliberately
            // NOT awaited with the rest, and deliberately chained AFTER the
            // results load rather than beside it:
            //
            //   - beside it, the schedule preload won the race on every load,
            //     so backfill read an empty NFL_RESULTS_BY_WEEK, concluded the
            //     sheet held nothing, and rewrote a week of results that were
            //     already there. saveResults() writes a row at a time, so that
            //     was ~30s in one request, on every single page load.
            //   - awaited, that request also held up the final render, which is
            //     what made a cold load take half a minute to settle.
            //
            // It is a write-out: nothing on screen is waiting for it.
            standingsReady
                .then(() => backfillResults())
                .catch(err => console.error('[Results] Backfill failed:', err));

            // .catch, not a bare await: one failed background load used to
            // reject the whole block and skip everything below it, leaving
            // spreadsLoading true for the rest of the session - and the
            // standings marked provisional for ever. The numbers are as good
            // as they are going to get either way, so finish the pass.
            await Promise.all([
                loadAllPicksFromBackup(),
                loadAllWeeklyDataForBlazin(),
                // Year Chg is a delta against last season, and getSeasonData()
                // is synchronous - so the archive has to be in before the
                // standings render or the column silently stays blank.
                loadPriorSeasonForComparison(),
                standingsReady,
                prefetchAndSaveSpreads()
            ]).catch(err => {
                console.error('[Background] A background load failed:', err);
            });

            console.log(`[Background] All data synced: ${(performance.now() - bgStart).toFixed(0)}ms`);

            // preloadSeasonSchedules() and prefetchAndSaveSpreads() run
            // concurrently above, and the first REPLACES the game objects the
            // second writes lines onto. Landing in that order left past weeks
            // holding no line, which is why a record could differ between two
            // loads of the same page. Re-apply once here, when both are done,
            // so the last render is the same whichever order they finished in.
            applySavedSpreads();

            // Mark spreads as loaded and re-render once. Line picks cannot be
            // scored without spreads, so the standings and the as-is table
            // have to be recomputed now that they are in.
            spreadsLoading = false;
            // Everything the standings are computed from is in, so the numbers
            // stop moving here - drop the marking before the last render.
            standingsProvisional = false;
            updateProvisionalIndicator();
            renderActiveTab();
        }, 100);

    } catch (err) {
        console.error('Failed to load data from Google Sheets:', err.message);
        showErrorState('Unable to load picks data. Please check your internet connection and try again.');
    }
}

/**
 * Set active category and re-render
 */
async function setActiveCategory(category) {
    currentCategory = category;

    // Reset scroll position to top when switching tabs to prevent rendering artifacts
    window.scrollTo(0, 0);

    // Update tabs
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.category === category);
    });

    // Get all content sections
    const makePicksSection = document.getElementById('make-picks-section');
    const performanceInsightsSection = document.getElementById('performance-insights-section');
    const recordsAnalysisSection = document.getElementById('records-analysis-section');
    const vsMarketSection = document.getElementById('vs-market-section');
    const historySection = document.getElementById('history-section');
    const liveSection = document.getElementById('live-section');
    const playoffStandingsSection = document.getElementById('playoff-standings-section');
    const playoffComparisonSection = document.getElementById('playoff-comparison-section');
    const tabLoading = document.getElementById('tab-loading');

    // FIRST: Hide ALL sections to ensure clean slate
    standingsSubtabs?.classList.add('hidden');
    liveSubtabs?.classList.add('hidden');
    leaderboard?.classList.add('hidden');
    makePicksSection?.classList.add('hidden');
    performanceInsightsSection?.classList.add('hidden');
    recordsAnalysisSection?.classList.add('hidden');
    vsMarketSection?.classList.add('hidden');
    historySection?.classList.add('hidden');
    liveSection?.classList.add('hidden');
    playoffStandingsSection?.classList.add('hidden');
    playoffComparisonSection?.classList.add('hidden');
    tabLoading?.classList.add('hidden');

    // Destroy chart instances to prevent memory leaks (for any tab switch)
    if (typeof destroyAllCharts === 'function') {
        destroyAllCharts();
    }

    // Live scores drive both the pick cards and the Live tab, so the refresh
    // stops only when neither is on screen.
    if (category !== 'make-picks' && category !== 'live') {
        stopLiveScoresRefresh();
    }

    // THEN: Show only sections needed for the selected category
    if (category === 'make-picks') {
        makePicksSection?.classList.remove('hidden');
        startLiveScoresRefresh();
        renderScoringSummary();
    } else if (category === 'live') {
        liveSubtabs?.classList.remove('hidden');
        liveSection?.classList.remove('hidden');
        renderLiveTab();
        startLiveScoresRefresh();
    } else if (category === 'standings') {
        standingsSubtabs?.classList.remove('hidden');
        // Use the default subcategory (playoffs after Wild Card week is complete)
        setActiveSubcategory(currentSubcategory);
    } else if (category === 'vs-market') {
        vsMarketSection?.classList.remove('hidden');
        renderVsMarketSection();
    } else if (category === 'history') {
        historySection?.classList.remove('hidden');
        // Load the first available season (includes current since 2025 is complete)
        if (AVAILABLE_SEASONS.length > 0) {
            const historySeasonDropdown = document.getElementById('history-season-dropdown');
            if (historySeasonDropdown) {
                historySeasonDropdown.value = AVAILABLE_SEASONS[0];
            }
            loadHistorySeason(AVAILABLE_SEASONS[0]);
        }
    }

    // renderDashboard() only runs for Standings, so leaving the tab needs its
    // own call to take the marking off the body.
    updateProvisionalIndicator();
}

/**
 * Setup consolidated section tabs
 */
function setupConsolidatedTabs() {
    document.querySelectorAll('.consolidated-tabs').forEach(tabContainer => {
        tabContainer.querySelectorAll('.consolidated-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panelId = tab.dataset.panel;
                const section = tab.closest('.consolidated-section');

                // Update active tab
                tabContainer.querySelectorAll('.consolidated-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Update active panel
                section.querySelectorAll('.consolidated-panel').forEach(panel => {
                    panel.classList.toggle('active', panel.id === panelId);
                });
            });
        });
    });
}

/**
 * Calculate combined playoff stats (Line + SU + O/U) for weeks 19-22
 * Uses the same calculation logic as renderScoringSummary for consistency
 */
/**
 * Final results for a week that ESPN knows about but the backup sheet does not.
 *
 * Keyed by matchup, which is how the Results sheet stores them.
 */
function unstoredResultsForWeek(week) {
    const games = getGamesForWeekAndSeason(week, currentSeason);
    if (!games || games.length === 0) return {};

    const stored = getResultsForWeekAndSeason(week, currentSeason) || {};
    const pending = {};

    for (const game of games) {
        if (stored[game.id] || stored[String(game.id)]) continue; // already durable
        // Pass no stored results: we are looking for what ESPN has and the
        // sheet is still missing.
        const result = getGameResult(game, null);
        if (!result) continue;
        pending[pickKey(game)] = {
            awayScore: result.awayScore,
            homeScore: result.homeScore
        };
    }

    return pending;
}

/**
 * Write one week's results to the backup sheet, and mirror them into
 * NFL_RESULTS_BY_WEEK so the rest of the session treats them as stored.
 *
 * @returns {number} how many results were persisted
 */
async function postResultsToSheet(week, results, source) {
    const count = Object.keys(results).length;
    if (count === 0) return 0;

    const payload = { week: toSheetWeek(week), results: results, source: source };

    try {
        const response = await fetch(`${WORKER_PROXY_URL}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (!result.success) {
            console.error(`[Results] Week ${week} save failed:`, result.error);
            return 0;
        }

        // Mirror locally so this session stops treating them as missing. On a
        // failure we deliberately do NOT mirror, so the next pass retries.
        if (!NFL_RESULTS_BY_WEEK[week]) NFL_RESULTS_BY_WEEK[week] = {};
        const games = getGamesForWeekAndSeason(week, currentSeason) || [];
        for (const [gameKey, data] of Object.entries(results)) {
            const game = games.find(g => pickKey(g) === gameKey);
            if (!game) continue;
            NFL_RESULTS_BY_WEEK[week][game.id] = {
                winner: data.awayScore > data.homeScore ? 'away' : 'home',
                awayScore: data.awayScore,
                homeScore: data.homeScore
            };
        }

        console.log(`[Results] Week ${week}: persisted ${count} result(s)`);
        return count;
    } catch (error) {
        console.error(`[Results] Week ${week} save failed:`, error);
        return 0;
    }
}

/**
 * Persist every final result the sheet is missing, across the whole season.
 *
 * The sheet is the record we keep; ESPN is just where scores arrive. Syncing
 * only the current week (the old behaviour) meant a week nobody had open while
 * its games finished was never written down at all, and the data was then gone
 * for good the moment ESPN stopped serving it.
 *
 * saveResults() upserts on week + matchup, so re-running this is harmless and
 * the Results sheet stays at one row per game.
 */
async function backfillResults(source = 'ESPN') {
    if (!APPS_SCRIPT_URL) return 0;

    // Every week, not a range derived from CURRENT_NFL_WEEK: if that is ever
    // wrong or lagging, a finished week would be skipped and its scores lost
    // when ESPN stops serving them. A week with no loaded schedule, or no
    // finished games, yields nothing and costs nothing.
    let persisted = 0;
    for (let week = 1; week <= LAST_PLAYOFF_WEEK; week++) {
        persisted += await postResultsToSheet(week, unstoredResultsForWeek(week), source);
    }

    if (persisted > 0) {
        console.log(`[Results] Backfilled ${persisted} result(s) to the backup sheet`);
    }
    return persisted;
}

/**
 * The result for a game, from the best source available.
 *
 * The Results sheet is the source of truth. ESPN is an upstream we do not
 * control - it can go down, rate-limit us, or drop past seasons - so a score
 * seen there is only real once it has been written to the sheet. backfillResults()
 * does that writing; this function reads:
 *   1. a stored result (the Results sheet, loaded into NFL_RESULTS_BY_WEEK)
 *   2. the live-scores cache - current week, a game that just went final
 *   3. the ESPN fields loadWeekSchedule merges onto the game itself
 *
 * (2) and (3) exist only to cover the gap between a game going final and the
 * backfill persisting it. They are never the long-term record: anything they
 * surface is written to the sheet on the same pass.
 *
 * @returns {{winner: string, awayScore: number, homeScore: number}|null}
 */
function getGameResult(game, weekResults) {
    const stored = weekResults && (weekResults[game.id] || weekResults[String(game.id)]);
    if (stored) return stored;

    const live = getLiveGameStatus(game);
    if (live && (live.status === 'STATUS_FINAL' || live.completed)) {
        return {
            winner: live.homeScore > live.awayScore ? 'home' : 'away',
            awayScore: live.awayScore,
            homeScore: live.homeScore
        };
    }

    const finished = game.completed || game.status === 'STATUS_FINAL' || game.status === 'final';
    if (finished && (game.awayScore > 0 || game.homeScore > 0)) {
        return {
            winner: game.homeScore > game.awayScore ? 'home' : 'away',
            awayScore: game.awayScore,
            homeScore: game.homeScore
        };
    }

    return null;
}

/**
 * Whether a game carries a spread we can actually score a line pick against.
 *
 * Spreads load asynchronously (prefetchAndSaveSpreads, and the Spreads sheet),
 * so a current-season game can be rendered before its spread exists. Scoring
 * anyway makes the ATS comparison return 'push' for every game, which reads as
 * "the maths is broken" rather than "the data has not arrived".
 */
function hasUsableSpread(game) {
    return hasUsableLine(game?.spread);
}

/**
 * Whether a spread value can actually be scored against.
 *
 * Empty string must not slip through: Number('') is 0, which would be scored
 * as a pick em. A real 0 spread IS valid, so this cannot just test truthiness
 * either.
 */
function hasUsableLine(raw) {
    if (raw === null || raw === undefined || raw === '') return false;
    return Number.isFinite(Number(raw));
}

// --- Frozen lines ----------------------------------------------------------
// A pick rides the line by default: it stores a side ('home'/'away'), never a
// number, so it is graded against whatever the spread is when it is scored. A
// player may instead FREEZE a game, which snapshots the current line onto the
// pick and makes that game final - see freezeGame().
//
// "Frozen" is not "locked": locked means the game has kicked off and nobody can
// edit it (isGameLocked). Frozen is a choice made before kickoff.

/**
 * The line a pick is graded against: its own frozen number if it has one,
 * otherwise the game's current line.
 */
function lineForPick(game, pick) {
    if (pick && pick.frozenAt) {
        return {
            spread: pick.frozenSpread,
            favorite: pick.frozenFavorite,
            overUnder: pick.frozenOverUnder,
            frozen: true
        };
    }
    return {
        spread: game?.spread,
        favorite: game?.favorite,
        overUnder: game?.overUnder,
        frozen: false
    };
}

/**
 * Which side covered for one picker, honouring a frozen line. Returns null when
 * the line cannot be scored yet, so callers skip rather than record a false push.
 */
function atsWinnerForPick(game, pick, result) {
    const line = lineForPick(game, pick);
    if (!hasUsableLine(line.spread)) return null;
    return calculateATSWinnerFrom(Number(line.spread), line.favorite, result);
}

/** True when a pick has been frozen at its own line. */
function isPickFrozen(pick) {
    return Boolean(pick && pick.frozenAt);
}

const MAX_BLAZIN_PICKS = 5;

/**
 * Whether a card carries every pick it needs before it can be frozen.
 *
 * Same definition as checkAllPicksComplete - line + winner - plus the O/U pick,
 * which only exists in the playoffs (the card renders the O/U picker when
 * isPlayoff, and the Blazin' star otherwise).
 *
 * The Blazin' star is deliberately NOT required: it is capped at five a week, so
 * most cards will never carry one. The star is protected by
 * blazinReachableAfterFreezing() instead.
 */
function isCardComplete(game, pick, week = currentWeek) {
    if (!pick || !pick.line || !pick.winner) return false;
    if (isPlayoffWeek(week) && hasUsableLine(game?.overUnder) && !pick.overUnder) return false;
    return true;
}

/**
 * How many Blazin' picks a picker could still end the week with, if the games
 * in `alsoFreezing` were frozen right now.
 *
 * Freezing a card freezes its star along with everything else, so freezing an
 * unstarred game permanently removes it as a candidate. Without this check a
 * picker could freeze their way down to two of five and only find out later.
 * Games are counted as candidates whether or not they currently hold a line
 * pick, since one can still be added before kickoff.
 */
function blazinReachableAfterFreezing(alsoFreezing = [], week = currentWeek, picker = currentPicker) {
    if (isPlayoffWeek(week)) return MAX_BLAZIN_PICKS; // no Blazin' 5 in the playoffs

    const picks = getPickerPicksForWeek(week, picker);
    const freezing = new Set(alsoFreezing);
    const used = countBlazinPicks(week, picker);

    const openCandidates = getGamesForWeekAndSeason(week, currentSeason).filter(game => {
        const pick = getPicksForGame(picks, game);
        if (pick.blazin) return false;            // already counted in `used`
        if (isPickFrozen(pick)) return false;     // frozen, so can never be starred
        if (freezing.has(pickKey(game))) return false; // about to be frozen
        if (isGameLocked(game, week)) return false;
        return true;
    }).length;

    return used + openCandidates;
}

/**
 * Whether one game can be frozen right now, and why not if it cannot.
 *
 * @returns {{canFreeze: boolean, reason: string}}
 */
function freezeEligibility(game, week = currentWeek, picker = currentPicker) {
    const pick = getPicksForGame(getPickerPicksForWeek(week, picker), game);

    if (isPickFrozen(pick)) {
        return { canFreeze: false, reason: 'Pick is already locked' };
    }
    if (isGameLocked(game, week)) {
        return { canFreeze: false, reason: 'Game has already started' };
    }
    if (!isCardComplete(game, pick, week)) {
        return { canFreeze: false, reason: 'Make all picks for this game first' };
    }
    // Freezing at a missing spread would store undefined and score as a push
    // for ever - the failure mode fixed in 5a31244.
    if (!hasUsableSpread(game)) {
        return { canFreeze: false, reason: 'No line available to lock yet' };
    }
    if (blazinReachableAfterFreezing([pickKey(game)], week, picker) < MAX_BLAZIN_PICKS) {
        return {
            canFreeze: false,
            reason: `Locking this would leave you unable to make ${MAX_BLAZIN_PICKS} Blazin' picks`
        };
    }
    return { canFreeze: true, reason: '' };
}

/** Every game this picker could freeze right now. */
function freezableGames(week = currentWeek, picker = currentPicker) {
    return getGamesForWeekAndSeason(week, currentSeason)
        .filter(game => freezeEligibility(game, week, picker).canFreeze);
}

/**
 * One side's number as it appears on a game card: "+3.5", "-7", "PK", or ''
 * when there is no line to show.
 *
 * A pick'em is 0, which is a real line and prints as PK. A game whose line has
 * not loaded carries null and prints as nothing - the two used to be the same
 * value and a pick'em therefore rendered blank.
 */
function signedSpreadDisplay(game, side) {
    if (!hasUsableSpread(game)) return '';
    const spread = Number(game.spread);
    if (spread === 0) return 'PK';
    return game.favorite === side ? `-${spread}` : `+${spread}`;
}

/** A line as a player reads it: "Seahawks -3", "Pick'em". Names the favourite. */
function describeLine(game) {
    const spread = Number(game?.spread);
    if (!hasUsableSpread(game)) return 'no line';
    if (spread === 0) return "Pick'em";
    const favourite = game.favorite === 'home' ? game.home : game.away;
    return `${favourite} -${spread}`;
}

/**
 * The same line read from one side of it: "Buccaneers +3.5" rather than
 * "Bengals -3.5".
 *
 * Anywhere we are describing somebody's PICK - locking it, the tooltip on a
 * locked badge, a line that has drifted under it - it has to be their own team
 * and their own number. describeLine() names the favourite, which is the same
 * line seen from the other side of the table and reads as the wrong pick.
 * Falls back to the favourite when there is no side to read it from.
 */
function describeLineForSide(game, side, pick = null) {
    if (!side) return describeLine(game);
    // A pick frozen at its own number is described at that number, not the
    // board's - the same rule lineForPick() scores by.
    if (pick) game = { ...game, ...lineForPick(game, pick) };
    if (!hasUsableSpread(game)) return 'no line';
    const spread = Number(game.spread);
    const team = side === 'home' ? game.home : game.away;
    if (spread === 0) return `${team} Pick'em`;
    return `${team} ${game.favorite === side ? '-' : '+'}${spread}`;
}

/**
 * Write the current line onto a pick, making it frozen.
 *
 * Reads through the merged view (sheet cache + local) so a pick that only
 * exists in the backup is materialised into allPicks rather than lost, then
 * writes the whole object back to allPicks, which is what gets synced.
 */
function applyFreeze(game, week = currentWeek, picker = currentPicker) {
    const frozen = { ...getPicksForGame(getPickerPicksForWeek(week, picker), game) };

    frozen.frozenSpread = Number(game.spread);
    frozen.frozenFavorite = game.favorite;
    if (hasUsableLine(game.overUnder)) {
        frozen.frozenOverUnder = Number(game.overUnder);
        // totalLine is the field that actually reaches the backup sheet, so
        // write the frozen total there too or it is lost on the next reload.
        frozen.totalLine = Number(game.overUnder);
    }
    frozen.frozenAt = new Date().toISOString();

    if (!allPicks[week]) allPicks[week] = {};
    if (!allPicks[week][picker]) allPicks[week][picker] = {};
    allPicks[week][picker][pickKey(game)] = frozen;

    return frozen;
}

/**
 * The running Blazin' 5 count above the games list.
 *
 * The stars sit one per game card, so by the time a picker is near the bottom
 * of the week they have no way of knowing how many they have already spent
 * without scrolling back up - the cap only announces itself once the sixth
 * star is already disabled. This shows the tally the whole way down.
 *
 * Reads the count fresh each call rather than tracking it, so it cannot drift
 * from the picks: see getPickerPicksForWeek.
 *
 * The bar is a reminder, so once all five are placed it has nothing left to
 * say and stops being sticky (.released) - but not instantly. The picker has
 * just placed the fifth star, usually well down the page, and the bar is the
 * confirmation that they are done; yanking it out of view at that moment
 * reads as a glitch. So the fifth star holds it for BLAZIN_COMPLETE_HOLD_MS
 * (noteBlazinCompleted), after which a timer lets it go. A week that is
 * already complete when it comes on screen - a page load, switching to a
 * picker who finished earlier - is released straight away: nobody just did
 * anything that needs confirming.
 */
const BLAZIN_COMPLETE_HOLD_MS = 60 * 1000;
let blazinCompletedAt = null;   // when the fifth star was placed on this device
let blazinCompletedFor = null;  // `${week}|${picker}` it was placed for
let blazinReleaseTimer = null;

/** Call when a star click has just made the current picker's week complete. */
function noteBlazinCompleted(now = Date.now()) {
    blazinCompletedAt = now;
    blazinCompletedFor = `${currentWeek}|${currentPicker}`;
}

function blazinHoldRemaining(now = Date.now()) {
    if (blazinCompletedAt === null) return 0;
    if (blazinCompletedFor !== `${currentWeek}|${currentPicker}`) return 0;
    return Math.max(0, BLAZIN_COMPLETE_HOLD_MS - (now - blazinCompletedAt));
}

function updateBlazinProgress(now = Date.now()) {
    const bar = document.getElementById('blazin-progress');
    if (!bar) return;

    clearTimeout(blazinReleaseTimer);
    blazinReleaseTimer = null;

    // Nothing to count without a picker, and there is no Blazin' 5 in the playoffs.
    if (!currentPicker || isPlayoffWeek(currentWeek)) {
        bar.classList.add('hidden');
        return;
    }

    const used = countBlazinPicks(currentWeek, currentPicker);
    const left = blazinRemaining(currentWeek, currentPicker);
    const complete = left === 0;

    bar.classList.remove('hidden');
    bar.classList.toggle('complete', complete);

    if (!complete) {
        // A star came back out: the reminder is live again, and whatever
        // completion was noted no longer describes this week.
        if (blazinCompletedFor === `${currentWeek}|${currentPicker}`) {
            blazinCompletedAt = null;
            blazinCompletedFor = null;
        }
        bar.classList.remove('released');
    } else {
        const hold = blazinHoldRemaining(now);
        bar.classList.toggle('released', hold === 0);
        if (hold > 0) {
            blazinReleaseTimer = setTimeout(() => updateBlazinProgress(), hold);
        }
    }

    const pips = document.getElementById('blazin-progress-pips');
    if (pips) {
        pips.innerHTML = Array.from({ length: MAX_BLAZIN_PICKS }, (_, i) =>
            `<span class="blazin-pip${i < used ? ' filled' : ''}">${i < used ? '★' : '☆'}</span>`
        ).join('');
    }

    const count = document.getElementById('blazin-progress-count');
    if (count) {
        count.textContent = left === 0
            ? `All ${MAX_BLAZIN_PICKS} picked`
            : `${used} of ${MAX_BLAZIN_PICKS} picked · ${left} to go`;
    }
}

/** Blazin' picks still to be allocated this week. */
function blazinRemaining(week = currentWeek, picker = currentPicker) {
    if (isPlayoffWeek(week)) return 0;
    return Math.max(0, MAX_BLAZIN_PICKS - countBlazinPicks(week, picker));
}

/**
 * Freeze one game at its current line, after confirming. Irreversible.
 */
function freezeGameByKey(key) {
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return false;
    }
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return false;
    }

    const game = getGamesForWeek(currentWeek).find(g => pickKey(g) === key);
    if (!game) return false;

    const { canFreeze, reason } = freezeEligibility(game);
    if (!canFreeze) {
        showToast(reason, 'warning');
        return false;
    }

    const pick = getPicksForGame(getPickerPicksForWeek(currentWeek, currentPicker), game);
    const line = describeLineForSide(game, pick.line);
    const remaining = blazinRemaining();
    const starWarning = remaining > 0
        ? ` You still have ${remaining} Blazin' 5 pick${remaining === 1 ? '' : 's'} to make,`
          + ' and locking this game locks its star too.'
        : '';

    return requestConfirmation(
        `Lock ${game.away} @ ${game.home} at ${line}?`,
        'These picks become final: you will not be able to change them, and you ' +
        'will be graded at this line however it moves.' + starWarning,
        { confirmLabel: 'Lock Pick', dontShowKey: 'lockPick' },
        () => {
            applyFreeze(game);
            savePicksToStorage(true);
            renderGames();
            renderScoringSummary();
            showToast(`Locked at ${line}`);
        });
}

/**
 * Freeze every complete game for the week, leaving incomplete ones riding.
 *
 * Blocked until all five Blazin' picks are allocated: this is the action most
 * likely to strand a picker at two of five, since it freezes everything at once.
 */
function freezeAllCompleteGames() {
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return false;
    }
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return false;
    }

    const week = currentWeek;
    const remaining = blazinRemaining(week, currentPicker);
    if (remaining > 0) {
        const used = countBlazinPicks(week, currentPicker);
        showToast(
            `Make all ${MAX_BLAZIN_PICKS} Blazin' picks first - you have ${used}. ` +
            'Locking the week would lock the stars too.', 'warning');
        return false;
    }

    const picks = getPickerPicksForWeek(week, currentPicker);
    const open = getGamesForWeekAndSeason(week, currentSeason).filter(game =>
        !isGameLocked(game, week) && !isPickFrozen(getPicksForGame(picks, game)));
    const ready = open.filter(game => freezeEligibility(game, week, currentPicker).canFreeze);
    const notReady = open.length - ready.length;

    if (ready.length === 0) {
        showToast(notReady > 0
            ? `No complete games to lock - ${notReady} still need picks`
            : 'Nothing left to lock', 'warning');
        return false;
    }

    const summary = notReady > 0
        ? `Lock ${ready.length} completed pick${ready.length === 1 ? '' : 's'}? ` +
          `${notReady} game${notReady === 1 ? ' is' : 's are'} incomplete and will keep riding the line.`
        : `Lock all ${ready.length} pick${ready.length === 1 ? '' : 's'} at their current lines?`;

    // Deliberately NOT suppressible: this finalises the whole week at once, so
    // it should always ask.
    return requestConfirmation(
        summary,
        'Locked picks become final and cannot be changed.',
        { confirmLabel: `Lock ${ready.length} Pick${ready.length === 1 ? '' : 's'}` },
        () => {
            ready.forEach(game => applyFreeze(game, week, currentPicker));
            savePicksToStorage(true);
            renderGames();
            renderScoringSummary();
            showToast(notReady > 0
                ? `Locked ${ready.length} picks. ${notReady} incomplete and still riding the line.`
                : `Locked all ${ready.length} picks.`);
        });
}

// --- Cowherd's Blazin' 5 ---------------------------------------------------
// The group plays against Colin Cowherd's Blazin' 5, so his five picks are
// entered by hand each week and scored by the same engine as everyone else.
//
// Two things stop him being just a sixth picker:
//
//   - He only ever has a Blazin' 5 record. He makes no straight-up picks, and
//     his five line picks ARE the Blazin' 5, so letting them into the Line
//     standings would put five picks a week against everyone else's sixteen.
//     COWHERD_CATEGORY is the single place that says which column he is in.
//   - He calls his own numbers, and they are not always the book's. Each pick
//     therefore carries the line he gave, stored in the same frozen* fields a
//     locked pick uses, so lineForPick() and atsWinnerForPick() grade him at
//     his number with no new scoring code.
//
// His picks live in allPicks under the picker name 'Cowherd', which is what
// gets localStorage, the Backup sheet round trip and the History view for
// free - none of them know he is special. Entry is admin-only (Stephen).

/**
 * Redraw whatever the current tab shows from live scores.
 *
 * The refresh loop called renderGames()/renderScoringSummary() directly, which
 * does nothing for the Live tab - the one view where a stale score is the
 * whole problem.
 */

/**
 * Redraw the tab that is showing, whenever data has landed - a backup load,
 * a spread fetch, or a live-score poll.
 *
 * Everything that changes what a view shows calls this rather than naming
 * tabs itself, because every time a caller named them one got missed. The
 * backup load forgot the Live tab, so picks that arrived a moment after it
 * was drawn never appeared on it; the score poll forgot Standings, so a game
 * going final left the table where it was until you switched tabs.
 */
function renderActiveTab() {
    updateLiveTabVisibility();
    renderGames();
    renderScoringSummary();
    if (currentCategory === 'standings') renderDashboard();
    if (currentCategory === 'live') renderLiveTab();
    if (currentCategory === 'history') refreshLiveHistoryView();
}

/** Guards refreshLiveHistoryView() against overlapping rebuilds. */
let historyRefreshInFlight = false;

/**
 * Rebuild the History tab when the data behind it changes.
 *
 * The season in progress has no archive file, so loadSeasonData() assembles it
 * on the spot from NFL_GAMES_BY_WEEK (buildCurrentSeasonView). Open History
 * while the background loads are still running and it was built from a
 * half-empty schedule - and nothing rebuilt it afterwards, so it stayed blank
 * until the tab was switched away and back. renderActiveTab() already fires on
 * every arrival; this hooks History onto it.
 *
 * Only the live season: an archived one is a static file and cannot change
 * under us, and Lifetime spans them all.
 */
async function refreshLiveHistoryView() {
    if (currentCategory !== 'history' || historyRefreshInFlight) return;

    const seasonDropdown = document.getElementById('history-season-dropdown');
    if (Number(seasonDropdown?.value) !== CURRENT_SEASON) return;

    const weekDropdown = document.getElementById('history-week-dropdown');
    const week = weekDropdown?.value;

    historyRefreshInFlight = true;
    try {
        await loadHistorySeason(CURRENT_SEASON);

        // loadHistorySeason() rebuilds the week list and drops back to week 1,
        // so put the reader back on the week they were looking at.
        if (week && weekDropdown && [...weekDropdown.options].some(o => o.value === week)) {
            weekDropdown.value = week;
            renderHistoryWeek(Number(week));
            updateHistoryWeekDisplay(Number(week));
        }
    } finally {
        historyRefreshInFlight = false;
    }
}

/**
 * ESPN statuses that mean the game has kicked off and is not over.
 *
 * STATUS_DELAYED is a weather (or other) stoppage: the score stands, the
 * clock is frozen, and the game will resume. It is what ESPN reported for
 * Browns at Buccaneers on 2026-09-20, stopped at 2:00 in the 4th - and
 * without it here a game in a delay is neither playing nor finished, so it
 * dropped out of the Live tab's playing list into "Upcoming" with no score,
 * and its card showed LOCKED instead of the score. This is the one list;
 * anything deciding "is this game on right now" reads it.
 */
const LIVE_IN_PROGRESS_STATUSES = ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD', 'STATUS_DELAYED'];

/** How a live status reads on a badge, where ESPN's own wording is not to hand. */
function liveClockLabel(live) {
    if (!live) return '';
    if (live.status === 'STATUS_DELAYED') return 'Delayed';
    if (live.status === 'STATUS_HALFTIME') return 'Half';
    if (live.status === 'STATUS_END_PERIOD') return `End Q${live.period}`;
    return live.clock ? `${live.clock} Q${live.period}` : 'Live';
}

/** Whether a game is being played right now. */
function isGameInProgress(game) {
    const live = getLiveGameStatus(game);
    return Boolean(live && LIVE_IN_PROGRESS_STATUSES.includes(live.status));
}

/**
 * The score of a game in progress, shaped like a real result so it can be
 * scored by the same code - the "as is" standings are exactly the settled
 * ones with these counted as though the games had ended.
 *
 * Only for a game actually in progress: a finished one already has a real
 * result through getGameResult(), and a scheduled one has nothing to say.
 * Marked provisional so nothing mistakes it for a settled score.
 */
function liveProvisionalResult(game) {
    if (!isGameInProgress(game)) return null;
    const live = getLiveGameStatus(game);
    const { awayScore = 0, homeScore = 0 } = live;
    return {
        winner: homeScore > awayScore ? 'home' : (awayScore > homeScore ? 'away' : null),
        awayScore,
        homeScore,
        provisional: true
    };
}

/** The one standings column Cowherd appears in. */
const COWHERD_CATEGORY = 'blazin';

/** The other side of a game. */
function otherSide(side) {
    return side === 'home' ? 'away' : 'home';
}

/**
 * Split a line as Cowherd called it - a side plus a number signed from that
 * side, "Rams +3.5" or "Seahawks -3.5" - into the (magnitude, favourite) pair
 * every other pick is stored with.
 */
function cowherdLineFields(game, side, signedSpread) {
    // hasUsableLine, not Number.isFinite: Number('') is 0, so a blank field
    // would otherwise be stored as a pick'em and scored for ever.
    if (!hasUsableLine(signedSpread)) return null;
    const signed = Number(signedSpread);
    const spread = Math.abs(signed);
    // Laying the points makes his side the favourite. At a pick'em nobody is,
    // and scoring never reads it, so his own side is as good a value as any.
    const favorite = signed <= 0 ? side : otherSide(side);
    return { frozenSpread: spread, frozenFavorite: favorite };
}

/**
 * The line on a stored Cowherd pick, signed from the side he took - the
 * inverse of cowherdLineFields(), for putting his number back in the input.
 */
function cowherdSignedSpread(pick) {
    if (!pick || !hasUsableLine(pick.frozenSpread)) return null;
    const spread = Number(pick.frozenSpread);
    return pick.frozenFavorite === pick.line ? -spread : spread;
}

/** Cowherd's entered picks for a week: local, plus anything from the backup. */
function getCowherdPicksForWeek(week = currentWeek) {
    const seasonPicks = getPicksForWeekAndSeason(week, currentSeason) || {};
    const local = seasonPicks[COWHERD] || {};
    const cached = weeklyPicksCache[week]?.picks?.[COWHERD]
        || weeklyPicksCache[String(week)]?.picks?.[COWHERD] || {};
    return { ...cached, ...local };
}

/**
 * Replace Cowherd's picks for a week with `entries`, each { key, side, spread }
 * - the game's pick key, the side he took, and the number he gave it signed
 * from that side.
 *
 * The week is written whole: an entry left out is a pick he no longer has, and
 * the week-snapshot sync then tombstones it in the sheet. Returns how many
 * picks were stored.
 */
function saveCowherdPicks(week, entries) {
    const games = getGamesForWeekAndSeason(week, currentSeason) || [];
    const byKey = new Map(games.map(g => [pickKey(g), g]));
    const stamp = new Date().toISOString();
    const picks = {};

    entries.forEach(entry => {
        const game = byKey.get(entry.key);
        if (!game || !entry.side) return;
        const fields = cowherdLineFields(game, entry.side, entry.spread);
        if (!fields) return;
        picks[entry.key] = { line: entry.side, blazin: true, ...fields, frozenAt: stamp };
    });

    if (!allPicks[week]) allPicks[week] = {};
    allPicks[week][COWHERD] = picks;
    localStorage.setItem(PICKS_STORAGE_KEY, JSON.stringify(allPicks));
    // A deliberate single Save, not a click-through: sync it now rather than
    // through the debounce that exists to batch a player working down a slate.
    syncPicksToGoogleSheets(false, COWHERD, week);
    return Object.keys(picks).length;
}

/**
 * Cowherd's week-by-week Blazin' 5 record, in the { "1": {wins,losses,pushes} }
 * shape the season archives store.
 *
 * One source for both halves of his history: a finished season reads its
 * archived COWHERD_<year>_RESULTS, the season in progress is scored from the
 * picks entered so far. Returns null when there is nothing either way.
 */
function cowherdWeeklyResults(season) {
    const year = Number(season);
    if (year !== CURRENT_SEASON) {
        return (typeof window !== 'undefined' && window[`COWHERD_${year}_RESULTS`]) || null;
    }

    const computed = calculateStatsForWeeks(1, LAST_PLAYOFF_WEEK, [COWHERD]);
    const weekly = {};
    computed[COWHERD].byWeek.forEach(w => {
        const rec = w.blazin;
        if (rec.wins + rec.losses + rec.pushes > 0) weekly[w.week] = rec;
    });
    return Object.keys(weekly).length > 0 ? weekly : null;
}

/**
 * Draw the admin entry panel for the current week: five rows of
 * game / side / his number, filled in from whatever is already stored.
 *
 * Rebuilt from storage every time rather than patched in place, so switching
 * week or picking the picks up from another device cannot leave a stale row
 * behind. Reading it back out is readCowherdRows().
 */
function renderCowherdPanel() {
    const rows = document.getElementById('cowherd-rows');
    if (!rows) return;

    const weekLabel = document.getElementById('cowherd-week-num');
    if (weekLabel) {
        weekLabel.textContent = isPlayoffWeek(currentWeek)
            ? getWeekDisplayName(currentWeek)
            : `Week ${getWeekDisplayName(currentWeek)}`;
    }

    const games = getGamesForWeekAndSeason(currentWeek, currentSeason) || [];
    const stored = getCowherdPicksForWeek(currentWeek);
    // Stable order so a row does not jump as the number is typed into it.
    const entries = games
        .map(game => ({ game, pick: getPicksForGame(stored, game) }))
        .filter(e => e.pick.line);

    const gameOption = (game, selectedKey) => {
        const key = pickKey(game);
        const selected = key === selectedKey ? ' selected' : '';
        return `<option value="${key}"${selected}>${game.away} @ ${game.home}</option>`;
    };

    let html = '';
    for (let i = 0; i < MAX_BLAZIN_PICKS; i++) {
        const entry = entries[i];
        const game = entry ? entry.game : null;
        const key = game ? pickKey(game) : '';
        const side = entry ? entry.pick.line : '';
        const signed = entry ? cowherdSignedSpread(entry.pick) : null;

        const sideOptions = game
            ? `<option value=""></option>`
              + `<option value="away"${side === 'away' ? ' selected' : ''}>${game.away}</option>`
              + `<option value="home"${side === 'home' ? ' selected' : ''}>${game.home}</option>`
            : '<option value=""></option>';

        const incomplete = key && (!side || signed === null) ? ' incomplete' : '';

        html += `
            <div class="cowherd-row${incomplete}" data-row="${i}">
                <select class="cowherd-game" aria-label="Game ${i + 1}">
                    <option value="">- Game -</option>
                    ${games.map(g => gameOption(g, key)).join('')}
                </select>
                <select class="cowherd-side" aria-label="Cowherd's side, pick ${i + 1}">${sideOptions}</select>
                <input class="cowherd-spread" type="number" step="0.5" inputmode="decimal"
                       aria-label="Cowherd's line, pick ${i + 1}" placeholder="line"
                       value="${signed === null ? '' : signed}">
            </div>`;
    }
    rows.innerHTML = html;

    renderCowherdRecord();
}

/** The running Blazin' 5 record under the entry panel. */
function renderCowherdRecord() {
    const label = document.getElementById('cowherd-record');
    if (!label) return;
    const total = totalCowherdRecord(cowherdWeeklyResults(CURRENT_SEASON));
    const played = total.wins + total.losses + total.pushes;
    label.textContent = played
        ? `Season: ${total.wins}-${total.losses}${total.pushes ? `-${total.pushes}` : ''}`
        : '';
}

/**
 * Keep a row consistent as it is edited: choosing a game repopulates the two
 * sides, and choosing a side fills in the book's number for it so only a line
 * Cowherd actually moved has to be typed.
 */
function handleCowherdRowChange(event) {
    const row = event.target.closest('.cowherd-row');
    if (!row) return;

    const gameSelect = row.querySelector('.cowherd-game');
    const sideSelect = row.querySelector('.cowherd-side');
    const spreadInput = row.querySelector('.cowherd-spread');
    const games = getGamesForWeekAndSeason(currentWeek, currentSeason) || [];
    const game = games.find(g => pickKey(g) === gameSelect?.value);

    if (event.target === gameSelect) {
        sideSelect.innerHTML = game
            ? `<option value=""></option><option value="away">${game.away}</option><option value="home">${game.home}</option>`
            : '<option value=""></option>';
        spreadInput.value = '';
    }

    // Prefill the book's line for the chosen side, but never overwrite a
    // number already typed - that number is the whole point of the field.
    if (event.target === sideSelect && game && sideSelect.value && spreadInput.value === '') {
        if (hasUsableSpread(game)) {
            const signed = game.favorite === sideSelect.value ? -Number(game.spread) : Number(game.spread);
            spreadInput.value = signed;
        }
    }

    const complete = gameSelect.value && sideSelect.value && spreadInput.value !== '';
    row.classList.toggle('incomplete', Boolean(gameSelect.value) && !complete);
}

/** Read the entry panel back out as saveCowherdPicks() entries. */
function readCowherdRows() {
    return Array.from(document.querySelectorAll('#cowherd-rows .cowherd-row')).map(row => ({
        key: row.querySelector('.cowherd-game')?.value || '',
        side: row.querySelector('.cowherd-side')?.value || '',
        spread: row.querySelector('.cowherd-spread')?.value ?? ''
    }));
}

/**
 * Validate and store what is in the panel.
 *
 * A row is either empty or complete - a game with no side or no number is a
 * half-entered pick, and saving it silently would drop it. The same game twice
 * is a mis-click rather than two picks.
 */
function saveCowherdPanel() {
    const rows = readCowherdRows();
    const filled = rows.filter(r => r.key || r.side || r.spread !== '');

    const halfDone = filled.filter(r => !r.key || !r.side || !Number.isFinite(Number(r.spread)) || r.spread === '');
    if (halfDone.length > 0) {
        showToast(`${halfDone.length} row${halfDone.length === 1 ? ' needs' : 's need'} a game, a side and a line`, 'warning');
        return false;
    }

    const keys = filled.map(r => r.key);
    if (new Set(keys).size !== keys.length) {
        showToast('The same game is picked twice', 'warning');
        return false;
    }

    const saved = saveCowherdPicks(currentWeek, filled);
    renderCowherdPanel();
    showToast(saved === MAX_BLAZIN_PICKS
        ? `Saved Cowherd's Blazin' ${MAX_BLAZIN_PICKS}`
        : `Saved ${saved} of ${MAX_BLAZIN_PICKS} Cowherd picks`);
    return true;
}

// --- The Live tab ----------------------------------------------------------
// The week's Blazin' 5 games, who is on which side of each, and where the
// season table would stand if the afternoon ended right now.

/**
 * Every game this week that somebody starred, with the pickers on it.
 *
 * Cowherd included - the whole point of the tab is watching the group's five
 * against his. A game nobody starred is left out entirely.
 */
function blazinGamesForWeek(week = currentWeek, category = COWHERD_CATEGORY) {
    const games = getGamesForWeekAndSeason(week, currentSeason) || [];
    const byPicker = {};
    PICKERS_WITH_COWHERD.forEach(picker => {
        byPicker[picker] = getPickerPicksForWeek(week, picker);
    });

    // Which side a picker is on depends on what is being watched: the line
    // for Blazin' 5 and Line Picks (the first is the starred subset of the
    // second), the winner for Straight Up.
    const straightUp = category === 'winner';
    // Cowherd's five are Blazin' 5 picks and nothing else - the same gate that
    // keeps him off the Line Picks and Straight Up tables (cowherdBelongsIn).
    const pickers = category === COWHERD_CATEGORY ? PICKERS_WITH_COWHERD : PICKERS;
    return games.map(game => {
        const sides = { away: [], home: [] };
        pickers.forEach(picker => {
            const pick = getPicksForGame(byPicker[picker], game);
            const side = straightUp ? pick.winner : pick.line;
            if (!side) return;
            if (category === 'blazin' && !pick.blazin) return;
            sides[side].push({ picker, pick });
        });
        return { game, sides, count: sides.away.length + sides.home.length };
    }).filter(entry => entry.count > 0);
}

/**
 * Whether a pick is graded at a different line from the one on the board.
 *
 * A locked pick usually locked at the number that is still up, and most of
 * Cowherd's match the book too - so "locked" on its own is the wrong test for
 * whether a line is worth printing next to a name. Only a number that differs
 * from the one already on the row says anything.
 */
function pickLineDiffers(game, pick) {
    const line = lineForPick(game, pick);
    if (!hasUsableLine(line.spread)) return false;
    if (!hasUsableSpread(game)) return true;
    return Number(line.spread) !== Number(game.spread) || line.favorite !== game.favorite;
}

/**
 * A pick's own line as a signed number from the side taken: "+7", "-6.5".
 * Just the number - the row it sits on already names the team.
 */
function signedLineForPick(game, pick, side) {
    const line = lineForPick(game, pick);
    if (!hasUsableLine(line.spread)) return '';
    const spread = Number(line.spread);
    if (spread === 0) return 'PK';
    return `${line.favorite === side ? '-' : '+'}${spread}`;
}

/**
 * In progress first, then finished, then still to come; kickoff order within
 * each. What is happening now is what the tab is for.
 */
function liveGameRank(game, weekResults) {
    if (isGameInProgress(game)) return 0;
    return getGameResult(game, weekResults) ? 1 : 2;
}


// Which record the Live tab is showing: the same three the Standings tab has,
// each with games in progress counted as they stand. Separate from
// currentSubcategory on purpose - the two tabs are looked at for different
// reasons and should not drag each other about.
const LIVE_SUBCATEGORIES = {
    blazin: { label: 'Blazin’ 5', note: 'Season Blazin’ 5' },
    line:   { label: 'Line Picks',    note: 'Season line picks, starred or not' },
    winner: { label: 'Straight Up',   note: 'Season straight-up picks' }
};
let liveSubcategory = 'blazin';

/** Switch the Live tab between its three tables. An unknown name is ignored. */
function setLiveSubcategory(subcategory) {
    if (!LIVE_SUBCATEGORIES[subcategory]) return;
    liveSubcategory = subcategory;
    document.querySelectorAll('#live-subtabs .subtab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.liveSubcategory === subcategory);
    });
    renderLiveTab();
}

/** Draw the whole Live tab. Cheap enough to redraw on every score refresh. */
function renderLiveTab() {
    const section = document.getElementById('live-section');
    if (!section) return;

    const view = LIVE_SUBCATEGORIES[liveSubcategory];
    const title = document.getElementById('live-title-category');
    if (title) title.textContent = view.label;

    const label = document.getElementById('live-week-label');
    if (label) {
        label.textContent = isPlayoffWeek(currentWeek)
            ? getWeekDisplayName(currentWeek)
            : `Week ${getWeekDisplayName(currentWeek)}`;
    }

    const note = document.getElementById('as-is-note');
    if (note) {
        note.textContent = `${view.note}, with games in progress counted as they stand. `
            + 'Move is against the end of last week.';
    }

    renderAsIsStandings(liveSubcategory);
    // The game boxes follow the record: starred games, every game with a line
    // pick on it, or every game with a winner picked.
    renderBlazinGameBoxes(liveSubcategory);
}

// The Live tab is only up while the week's games are on: from an hour before
// the first kickoff to an hour after the last game should have finished.
//
// Nothing records when a game actually ended, so the far edge is the last
// kickoff plus a generous allowance for the game itself. A game that runs
// past it is caught separately - a game still being played keeps the tab up
// whatever the clock says, which is the case the allowance would get wrong.
const LIVE_WINDOW_BUFFER_MS = 60 * 60 * 1000;
const LIVE_WINDOW_GAME_MS = 4 * 60 * 60 * 1000;

/**
 * When the Live tab should be up for a week, or null when that cannot be
 * known yet - a schedule that has not loaded has no kickoffs to read.
 */
function liveWindow(week = CURRENT_NFL_WEEK) {
    const games = getGamesForWeekAndSeason(week, currentSeason) || [];
    const kickoffs = games.map(game => Date.parse(game.kickoff)).filter(Number.isFinite);
    if (kickoffs.length === 0) return null;

    return {
        opens: Math.min(...kickoffs) - LIVE_WINDOW_BUFFER_MS,
        closes: Math.max(...kickoffs) + LIVE_WINDOW_GAME_MS + LIVE_WINDOW_BUFFER_MS
    };
}

/**
 * Whether the Live tab belongs on screen.
 *
 * Unknown counts as open. Hiding a tab the reader wants during a slate is a
 * worse failure than showing one on a Wednesday, and the schedule usually
 * arrives a moment later and settles it either way.
 */
function isLiveWindowOpen(now = Date.now(), week = CURRENT_NFL_WEEK) {
    const games = getGamesForWeekAndSeason(week, currentSeason) || [];
    if (games.some(isGameInProgress)) return true;

    const window = liveWindow(week);
    if (!window) return true;
    return now >= window.opens && now <= window.closes;
}

/**
 * Put the Live tab up or take it down. Anyone left standing on it when it
 * goes is moved off, rather than left looking at a tab that is not there.
 */
function updateLiveTabVisibility() {
    const tab = document.querySelector('.tab[data-category="live"]');
    if (!tab) return;

    const open = isLiveWindowOpen();
    tab.style.display = open ? '' : 'none';
    if (!open && currentCategory === 'live') {
        setActiveCategory('make-picks');
    }
}

// Which pickers have their week's picks open on the as-is table. Kept outside
// the render because that runs on every score poll - without it an open row
// would snap shut every thirty seconds.
const asIsExpanded = new Set();

/** Open or close one picker's week on the as-is table. */
function toggleAsIsDetail(picker) {
    if (!asIsExpanded.delete(picker)) asIsExpanded.add(picker);
    renderAsIsStandings();
}

/**
 * One picker's picks in one category for the current week: what they took, at
 * what line where a line is what is being played, and where each stands.
 *
 * This week only. The table above is a season record, and the reason to open
 * a row is to see what is behind today's movement in it.
 *
 * Blazin' 5 and Line Picks are both against the spread - the first is the
 * starred subset of the second. Straight Up is the winner, and has no line
 * to show. The same rules calculateStatsForWeeks scores by, so a row here
 * always agrees with the table it opened from.
 */
function asIsPickDetail(picker, category = liveSubcategory) {
    const games = getGamesForWeekAndSeason(currentWeek, currentSeason) || [];
    const weekResults = getResultsForWeekAndSeason(currentWeek, currentSeason) || {};
    const picks = getPickerPicksForWeek(currentWeek, picker);
    const straightUp = category === 'winner';

    const rows = games.map(game => {
        const pick = getPicksForGame(picks, game);
        const side = straightUp ? pick.winner : pick.line;
        if (!side) return null;
        if (category === 'blazin' && !pick.blazin) return null;

        const settled = getGameResult(game, weekResults);
        const result = settled || liveProvisionalResult(game);

        // A game in progress is scored as it stands, and said to be so - the
        // same claim the table above makes about the record.
        let outcome;
        if (straightUp) {
            // A tied game in progress has no leader yet: pending, not a push.
            outcome = !result?.winner ? 'pending' : result.winner === side ? 'win' : 'loss';
        } else {
            const ats = result ? atsWinnerForPick(game, pick, result) : null;
            outcome = !ats ? 'pending' : ats === 'push' ? 'push' : ats === side ? 'win' : 'loss';
        }
        const label = outcome === 'pending' ? '&ndash;' : outcome.toUpperCase();

        const live = getLiveGameStatus(game);
        const status = settled ? 'Final'
            : (isGameInProgress(game) && live?.status === 'STATUS_DELAYED' ? 'Delayed'
                : isGameInProgress(game) && live?.clock ? live.clock : (game.time || ''));
        const matchup = result
            ? `${game.away} ${result.awayScore} @ ${game.home} ${result.homeScore}`
            : `${game.away} @ ${game.home}`;
        const picked = side === 'away' ? game.away : game.home;
        const line = straightUp ? '' : describeLineForSide(game, side, pick);

        // Same shape as the Team Records detail, down to the class names, so
        // the two read as one thing rather than two takes on it.
        return `
            <div class="game-detail-row outcome-${outcome}${settled || outcome === 'pending' ? '' : ' outcome-provisional'}">
                <span class="game-week">${status}</span>
                <span class="game-matchup">${matchup}</span>
                <span class="game-spread">${line}</span>
                <span class="game-picked">Picked: ${picked}</span>
                <span class="game-outcome"${settled || outcome === 'pending' ? '' : ' title="As it stands"'}>${label}</span>
            </div>`;
    }).filter(Boolean);

    if (rows.length === 0) {
        const what = category === 'blazin' ? 'Blazin&rsquo; 5'
            : straightUp ? 'straight-up' : 'line';
        return `<p class="as-is-no-picks">No ${what} picks for this week.</p>`;
    }
    return rows.join('');
}

/**
 * A position change as a cell: up, down, or nothing to say.
 *
 * A dash for both "level" and "no last week to compare against" - the
 * difference between them is not worth a second symbol, and in week 1 every
 * row is the second case.
 */
function formatPositionMove(move) {
    if (!move) return '<span class="move-none">&ndash;</span>';
    return `<span class="move-${move > 0 ? 'up' : 'down'}">`
        + `${move > 0 ? '&#9650;' : '&#9660;'}${Math.abs(move)}</span>`;
}

/**
 * Places in a standings map, in the order the table draws them.
 *
 * Equal records share a place. Without that, five pickers level on 0-0 get
 * five arbitrary places and the first result of the season reads as a
 * four-place climb.
 */
function rankStandings(rows) {
    const order = getSortedPickers(rows);
    const places = {};
    let place = 0;
    order.forEach((row, i) => {
        const same = i > 0 && (row.percentage ?? 0) === (order[i - 1].percentage ?? 0);
        if (!same) place = i + 1;
        places[row.name] = place;
    });
    return places;
}

/**
 * How far each picker has moved since the end of last week.
 *
 * Now - live games counted as they stand - against the table as it finished
 * last week. Positive is a climb. Null where there is nothing to compare
 * against: week 1 has no last week, and a picker with nothing scored before
 * now has not moved, they have arrived.
 */
function asIsPositionChange({ first, last } = regularSeasonWeekRange(), category = COWHERD_CATEGORY) {
    const now = rankStandings(standingsFromComputed(
        calculateStatsForWeeks(first, last, PICKERS_WITH_COWHERD, { includeLive: true }),
        category));

    if (last <= first) return {};

    // Last week is settled, so no live results belong in it.
    const before = rankStandings(standingsFromComputed(
        calculateStatsForWeeks(first, last - 1, PICKERS_WITH_COWHERD),
        category));

    const moves = {};
    Object.keys(now).forEach(name => {
        moves[name] = before[name] ? before[name] - now[name] : null;
    });
    return moves;
}

/**
 * The "as is" table: the Blazin' 5 season standings with games in progress
 * counted at the score they are standing at.
 *
 * Drawn by renderStandingsTable so it keeps the Standings tab's styling and
 * sort, with its own narrower column set - the per-week shape of a season,
 * which is what Last 3-Wk, Best Week and Year Chg describe, says nothing
 * about where an afternoon is heading.
 */
function renderAsIsStandings(category = liveSubcategory) {
    const { first, last } = regularSeasonWeekRange();
    const computed = calculateStatsForWeeks(
        first, last, PICKERS_WITH_COWHERD, { includeLive: true });
    renderStandingsTable(standingsFromComputed(computed, category), {
        tableId: 'as-is-standings-table',
        tbodyId: 'as-is-standings-body',
        category,
        setTitle: false,
        columns: 'as-is',
        positionChange: asIsPositionChange(undefined, category),
        // currentWeek, not `last`: it is the week the detail rows open onto,
        // and the box is the summary of what is behind them.
        weekRecord: asIsWeekRecord(currentWeek, category)
    });
}

/**
 * Each picker's record in one category over the games being played right now
 * (a delay included), as they stand - the small W-L-P beside the name on the
 * as-is table.
 *
 * The table is a season record; this is what the games on at this moment are
 * doing to it. Settled games are left out on purpose: the table already has
 * them, and the point of the box is to show what is still moving. It read the
 * whole week until September 2026, which by late Sunday was mostly finished
 * games and said nothing about the two still running. Same engine, narrowed
 * to the one week and to live games only, so the box and the table can never
 * disagree about a score. Cowherd falls out of the non-Blazin' categories here
 * the same way he does from the table (cowherdBelongsIn).
 */
function asIsWeekRecord(week, category = COWHERD_CATEGORY) {
    return standingsFromComputed(
        calculateStatsForWeeks(week, week, PICKERS_WITH_COWHERD, { liveOnly: true }),
        category);
}

/** "1-2-0": a record as the box reads it. Nothing in play reads 0-0-0. */
function formatWeekRecord(record) {
    const r = record || {};
    return `${r.wins || 0}-${r.losses || 0}-${r.pushes || 0}`;
}

/**
 * Whether a picker has anything in play at all. Nothing is a plain 0-0-0,
 * and there is no box for that: a row of grey 0-0-0s (Cowherd's, whenever
 * his five are done; everyone's, between slates) says nothing the empty
 * space does not, and the box is meant to be read as a signal.
 */
function weekRecordInPlay(record) {
    const r = record || {};
    return (r.wins || 0) + (r.losses || 0) + (r.pushes || 0) > 0;
}

/**
 * Which way the box is coloured: 'above' 50% is green, 'below' is red, dead
 * on 50% is blue. Same arithmetic as the % column (recordPercentage - pushes
 * do not count), so the box and the column never disagree. Nothing decided
 * yet is '' - the plain box, since there is nothing to have an opinion about.
 */
function weekRecordTone(record) {
    const r = record || { wins: 0, losses: 0 };
    const pct = recordPercentage({ wins: r.wins || 0, losses: r.losses || 0 });
    if (pct === null) return '';
    if (pct > 50) return 'above';
    if (pct < 50) return 'below';
    return 'level';
}

/**
 * The starred games, in three groups: being played, done, and still to come.
 *
 * What is happening now comes first, on its own. A finished game is still
 * worth reading and so is one about to start, but by the end of a Sunday they
 * are the whole list between them, and burying the two games actually running
 * underneath a dozen of them is the wrong way round. Each gets a section of
 * its own - open by default, and collapsing one is remembered.
 */
function renderBlazinGameBoxes(category = liveSubcategory) {
    const list = document.getElementById('live-games-list');
    if (!list) return;

    const weekResults = getResultsForWeekAndSeason(currentWeek, currentSeason) || {};
    const byKickoff = (a, b) =>
        String(a.game.kickoff || '').localeCompare(String(b.game.kickoff || ''));

    const entries = blazinGamesForWeek(currentWeek, category);
    // liveGameRank: 0 in progress, 1 finished, 2 still to come.
    const inRank = rank => entries.filter(e => liveGameRank(e.game, weekResults) === rank)
        .sort(byKickoff);
    const playing = inRank(0);
    const finished = inRank(1);
    const upcoming = inRank(2);

    if (entries.length === 0) {
        const nothing = category === 'blazin' ? 'Nobody has starred a game this week yet.'
            : category === 'winner' ? 'No straight-up picks this week yet.'
            : 'No line picks this week yet.';
        list.innerHTML = `<p class="no-data-message">${nothing}</p>`;
    } else if (playing.length === 0) {
        list.innerHTML = '<p class="no-data-message">No games in progress.</p>';
    } else {
        list.innerHTML = playing.map(entry => renderBlazinGameBox(entry, weekResults, category)).join('');
    }

    renderGameSection('live-completed', finished, weekResults, category);
    renderGameSection('live-upcoming', upcoming, weekResults, category);
}

/**
 * One of the collapsible game sections, hidden entirely while it is empty.
 * Ids follow the section name: <id>-section, <id>-list, <id>-count.
 */
function renderGameSection(id, entries, weekResults, category = liveSubcategory) {
    const section = document.getElementById(`${id}-section`);
    const list = document.getElementById(`${id}-list`);
    const count = document.getElementById(`${id}-count`);
    if (!section || !list) return;

    section.classList.toggle('hidden', entries.length === 0);
    if (count) {
        count.textContent = entries.length ? `(${entries.length})` : '';
    }
    list.innerHTML = entries.map(entry => renderBlazinGameBox(entry, weekResults, category)).join('');
}

function renderBlazinGameBox({ game, sides }, weekResults, category = liveSubcategory) {
    const live = getLiveGameStatus(game);
    // The cache, not the schedule: down, distance and possession only exist
    // here, and its clock is as fresh as the last poll.
    const detail = liveCacheEntry(game);
    const result = getGameResult(game, weekResults);
    const inProgress = isGameInProgress(game);
    const scored = result || liveProvisionalResult(game);

    let state = 'upcoming';
    // A scheduled game keeps the app's own kickoff time, which is in the
    // reader's zone; ESPN's short form for one is a US time string.
    let status = game.time ? `${game.day} ${game.time}` : 'Scheduled';
    if (inProgress) {
        state = 'in-progress';
        status = detail?.statusDetail
            || (live.status === 'STATUS_HALFTIME' ? 'Halftime'
                : live.status === 'STATUS_END_PERIOD' ? `End of ${live.period}`
                : live.status === 'STATUS_DELAYED' ? 'Delayed'
                : (live.clock ? `${live.clock} - Q${live.period}` : 'Live'));
    } else if (result) {
        state = 'final';
        status = 'Final';
    }

    // Who has the ball, shown as a football under their logo. Not spelled out:
    // the header above already names both teams.
    const hasBall = side => inProgress && detail?.possession === side;
    const teamCol = side => {
        const team = side === 'away' ? game.away : game.home;
        // onerror hands over to the abbreviation badge the pick cards use, so
        // a CDN miss is a team's initials rather than a broken image.
        return `<span class="live-score-teamcol">
                <img class="live-score-logo" src="${getTeamLogo(team)}" alt="${team}"
                     title="${team}" onerror="handleLogoError(this, '${team}')">
                <span class="live-possession-icon"${hasBall(side) ? ` title="${team} have the ball"` : ''}>`
            + `${hasBall(side) ? '&#127944;' : ''}</span>
            </span>`;
    };

    // The score gets its own row once there is one, rather than being folded
    // into the status line where the clock now lives.
    const score = scored ? `
        <div class="live-score">
            <span class="live-score-side">
                ${teamCol('away')}
                <span class="live-score-num">${scored.awayScore}</span>
            </span>
            <span class="live-score-sep">&ndash;</span>
            <span class="live-score-side">
                <span class="live-score-num">${scored.homeScore}</span>
                ${teamCol('home')}
            </span>
        </div>` : '';

    // Between drives - and at halftime - ESPN reports no down, so the row is
    // dropped rather than left showing a stale one.
    const downText = detail?.downDistance
        || (detail?.shortDownDistance ? detail.shortDownDistance : '');
    const situation = (inProgress && downText) ? `
        <div class="live-situation">
            <span class="live-down">${downText}</span>
        </div>` : '';

    // Straight Up is about who wins, so its rows carry no line and a picker's
    // own number never comes into it.
    const straightUp = category === 'winner';
    const sideRow = side => {
        const picks = sides[side];
        const team = side === 'away' ? game.away : game.home;
        const line = straightUp ? '' : describeLineForSide(game, side).replace(team, '').trim();

        const chips = picks.map(({ picker, pick }) => {
            // Only where it is not the number already on the row.
            const own = !straightUp && pickLineDiffers(game, pick)
                ? signedLineForPick(game, pick, side) : '';
            return `<span class="live-picker${picker === COWHERD ? ' cowherd' : ''}">`
                + `${picker}${own ? ` <em>${own}</em>` : ''}</span>`;
        }).join('');

        return `
            <div class="live-side${picks.length ? '' : ' empty'}">
                <div class="live-side-team">
                    <span class="live-team-name">${team}</span>
                    <span class="live-team-line">${line}</span>
                </div>
                <div class="live-pickers">${chips}</div>
            </div>`;
    };

    return `
        <div class="live-game-box ${state}">
            <div class="live-game-header">
                <span class="live-matchup">${game.away} @ ${game.home}</span>
                <span class="live-status ${state}">${status}</span>
            </div>
            ${score}
            ${situation}
            ${sideRow('away')}
            ${sideRow('home')}
        </div>`;
}

/** Total a cowherdWeeklyResults()-shaped object, aggregate form included. */
function totalCowherdRecord(weekly) {
    const total = emptyRecord();
    if (!weekly) return total;
    // 2022 and earlier were archived as one season aggregate, not by week.
    const buckets = weekly.aggregate ? [weekly.aggregate] : Object.values(weekly);
    buckets.forEach(rec => {
        if (!rec) return;
        total.wins += rec.wins || 0;
        total.losses += rec.losses || 0;
        total.pushes += rec.pushes || 0;
    });
    return total;
}

function emptyRecord() {
    return { wins: 0, losses: 0, pushes: 0 };
}

/**
 * Score every pick a picker made between two weeks, from picks + results.
 *
 * This is the engine the dashboard runs on instead of the hand-maintained
 * stats workbook. It returns per-category totals and a per-week breakdown, so
 * the standings table, the trend chart, last-3-week form and best week all
 * come out of one pass.
 *
 * Blazin' 5 is scored on the ATS outcome of the starred line pick - a B5 pick
 * is a line pick, not a separate kind of pick.
 *
 * `pickers` is a list rather than PICKERS outright so Cowherd can be scored by
 * the same pass - see COWHERD_CATEGORY for why he is then kept to one column.
 *
 * With `includeLive`, a game in progress is scored at the score it is standing
 * at. That is the whole of the Live tab's "as is" table: the same engine over
 * the same picks, with the afternoon's games counted as though they had ended.
 *
 * With `liveOnly`, only those games are scored - the settled ones are left
 * out. That is the box beside each name on that table: what the games being
 * played right now are doing to the record, on its own.
 */
function calculateStatsForWeeks(firstWeek, lastWeek, pickers = PICKERS, { includeLive = false, liveOnly = false, season = currentSeason } = {}) {
    const stats = {};
    pickers.forEach(picker => {
        stats[picker] = {
            name: picker,
            line: emptyRecord(), blazin: emptyRecord(),
            winner: emptyRecord(), ou: emptyRecord(),
            byWeek: []
        };
    });

    for (let week = firstWeek; week <= lastWeek; week++) {
        const weekStr = String(week);
        const weekGames = getGamesForWeekAndSeason(week, season);
        if (!weekGames || weekGames.length === 0) continue;

        const weekResults = getResultsForWeekAndSeason(week, season);
        const seasonPicks = getPicksForWeekAndSeason(week, season) || {};
        // The sheet cache holds the live season only, so it must not be merged
        // into an archived one - its keys would land on the wrong games.
        const cachedWeek = Number(season) === CURRENT_SEASON
            ? (weeklyPicksCache[week] || weeklyPicksCache[weekStr])
            : null;

        pickers.forEach(picker => {
            const weekly = {
                week: week,
                line: emptyRecord(), blazin: emptyRecord(),
                winner: emptyRecord(), ou: emptyRecord()
            };
            const localPicks = seasonPicks[picker] || {};
            const cachedPicks = cachedWeek?.picks?.[picker] || {};

            weekGames.forEach(game => {
                const pick = pickFromSources(game, localPicks, cachedPicks);
                const result = liveOnly ? liveProvisionalResult(game)
                    : (getGameResult(game, weekResults)
                        || (includeLive ? liveProvisionalResult(game) : null));
                if (!result) return;

                // Scored against this picker's own line: a frozen pick keeps
                // the number it was frozen at, whatever the game has moved to.
                // Null means no usable line yet - unscored, not a push, which
                // would otherwise show every line pick as a push until spreads
                // load.
                const atsWinner = atsWinnerForPick(game, pick, result);

                if (pick.line && atsWinner) {
                    const bucket = atsWinner === 'push' ? 'pushes'
                        : (pick.line === atsWinner ? 'wins' : 'losses');
                    weekly.line[bucket]++;
                    // A starred pick is scored again in its own column.
                    if (pick.blazin) weekly.blazin[bucket]++;
                }

                if (pick.winner) {
                    weekly.winner[pick.winner === result.winner ? 'wins' : 'losses']++;
                }

                const ouLine = lineForPick(game, pick).overUnder || pick.totalLine;
                if (pick.overUnder && ouLine > 0) {
                    const total = (result.awayScore || 0) + (result.homeScore || 0);
                    const ouResult = total > ouLine ? 'over' : (total < ouLine ? 'under' : 'push');
                    weekly.ou[ouResult === 'push' ? 'pushes'
                        : (pick.overUnder === ouResult ? 'wins' : 'losses')]++;
                }
            });

            const s = stats[picker];
            ['line', 'blazin', 'winner', 'ou'].forEach(cat => {
                s[cat].wins += weekly[cat].wins;
                s[cat].losses += weekly[cat].losses;
                s[cat].pushes += weekly[cat].pushes;
            });
            // Only keep weeks the picker actually played, so an unplayed week
            // is a gap in the trend line rather than a 0%.
            const played = ['line', 'blazin', 'winner', 'ou'].some(cat =>
                weekly[cat].wins + weekly[cat].losses + weekly[cat].pushes > 0);
            if (played) s.byWeek.push(weekly);
        });
    }

    return stats;
}

/** How many weeks the Last 3-Wk column averages, and the minimum it needs. */
const LAST_3_WEEK_WINDOW = 3;

/** Win percentage over decided picks; pushes are excluded, not counted as losses. */
function recordPercentage(record) {
    const decided = record.wins + record.losses;
    return decided > 0 ? (record.wins / decided) * 100 : null;
}

/**
 * A percentage for display, or '-' when there is not one.
 *
 * The callers used to inline this as `pct?.toFixed ? pct.toFixed(2) : pct || '-'`
 * with a literal '%' after it, so a null rendered as '-%'.
 */
function formatPercent(pct, digits = 2) {
    return typeof pct === 'number' && !Number.isNaN(pct) ? pct.toFixed(digits) + '%' : '-';
}

/**
 * positive/negative for a .stat-value, and neither when there is no number.
 *
 * parseFloat(null) >= 50 is false, so the old inline test painted every absent
 * percentage red - the same mistake pctCellClass() exists to avoid.
 */
function statValueClass(pct) {
    if (typeof pct !== 'number' || Number.isNaN(pct)) return '';
    return pct >= 50 ? 'positive' : 'negative';
}

/**
 * The class for a win-percentage cell: green above 50, red below, neutral at
 * it - and neutral when there is no percentage at all.
 *
 * That last case is the one worth spelling out. A picker with nothing scored
 * has no percentage, and the callers that stood in a 0 for it were painting
 * an empty record as though it were a total loss - a red dash, or a 0.0% that
 * the main standings table then rendered green anyway, because its .pct rule
 * was a flat colour that ignored the number entirely.
 */
function pctCellClass(percentage) {
    if (typeof percentage !== 'number' || Number.isNaN(percentage)) return 'pct pct-neutral';
    if (percentage > 50) return 'pct pct-positive';
    if (percentage < 50) return 'pct pct-negative';
    return 'pct pct-neutral';
}

/**
 * Last season's record over the SAME week range, scored by the same engine.
 *
 * Returns null when there is nothing to compare against - the first season, or
 * an archive that has not been loaded (getSeasonData is synchronous and only
 * sees what loadSeasonData has already pulled in; startup kicks that off).
 *
 * Mid-week the comparison is honest but not flattering to read: week 3 half
 * played is being set against week 3 finished. It settles once the week does,
 * and the alternative - dropping the week in progress - answers a different
 * question than "the same point last year".
 */
function priorSeasonStats(firstWeek, lastWeek, pickers = PICKERS) {
    const prior = CURRENT_SEASON - 1;
    if (!AVAILABLE_SEASONS.includes(prior)) return null;
    if (!getSeasonData(prior)) return null;

    const stats = calculateStatsForWeeks(firstWeek, lastWeek, pickers, { season: prior });
    applyCowherdPriorRecord(stats, prior, firstWeek, lastWeek);
    return stats;
}

/**
 * Put Cowherd's archived record into a prior season's stats, in place.
 *
 * Every other picker's history is re-scored from the archive's stored picks.
 * Cowherd's are NOT in there: the offseason archive keeps his week-by-week
 * record in COWHERD_<year>_RESULTS instead, because his picks are cleared with
 * everyone else's and his record is the one thing that cannot be re-derived
 * afterwards (see the offseason checklist).
 *
 * So scoring him the normal way found no picks, gave him an empty record, and
 * yearChangeFor() read that as "no comparison available" - which is why his was
 * the one row with a blank Year Chg while the data sat in the same archive file.
 *
 * cowherdWeeklyResults() is the single source for his history; this only sums
 * the weeks in range. Blazin' 5 is the only column he has (COWHERD_CATEGORY),
 * so it is the only one there is anything to fill.
 */
function applyCowherdPriorRecord(stats, season, firstWeek, lastWeek) {
    if (!stats[COWHERD]) return;
    const weekly = cowherdWeeklyResults(season);
    if (!weekly) return;

    const record = emptyRecord();
    for (let week = firstWeek; week <= lastWeek; week++) {
        const w = weekly[week] || weekly[String(week)];
        if (!w) continue;
        record.wins += w.wins || 0;
        record.losses += w.losses || 0;
        record.pushes += w.pushes || 0;
    }
    stats[COWHERD][COWHERD_CATEGORY] = record;
}

/**
 * The Year Chg cell: this season's win percentage minus last season's over the
 * same weeks, as '\u25b22.4%' / '\u25bc1.1%'.
 *
 * Blank - not a zero and not a dash - whenever there is no comparison to make:
 * no prior season loaded, or either side holding no decided picks. The card
 * view keys off a blank to drop the row entirely, and a 0.0% would claim the
 * picker held level when the truth is that nobody knows.
 */
function yearChangeFor(currentRecord, priorRecord) {
    if (!priorRecord) return '';
    const now = recordPercentage(currentRecord);
    const before = recordPercentage(priorRecord);
    if (now === null || before === null) return '';

    const delta = now - before;
    const size = Math.abs(delta).toFixed(1) + '%';
    if (Math.abs(delta) < 0.05) return 'even';
    return (delta > 0 ? '\u25b2' : '\u25bc') + size;
}

/**
 * Shape one category of calculateStatsForWeeks output for renderStandingsTable.
 * category is 'line', 'blazin', 'winner' or 'ou'.
 *
 * `prior` is the same shape for last season over the same weeks, or null.
 */
function standingsFromComputed(computed, category, prior = null) {
    const out = {};
    Object.keys(computed).forEach(picker => {
        const s = computed[picker];
        const rec = s[category];
        if (!cowherdBelongsIn(picker, category, rec)) return;
        const weekly = s.byWeek
            .map(w => ({ week: w.week, pct: recordPercentage(w[category]) }))
            .filter(w => w.pct !== null);

        // Null until there are three weeks to average. With one or two it was
        // averaging whatever it had, which in week 1 is arithmetically the
        // season percentage sitting in the column to its left - the same number
        // twice, presented as two different measurements. A dash says "not yet",
        // which is the truth.
        //
        // Three of the PICKER'S OWN scored weeks, not three weeks of calendar:
        // somebody who has played twice has no three-week form either.
        const last3 = weekly.slice(-LAST_3_WEEK_WINDOW);
        const last3Pct = last3.length === LAST_3_WEEK_WINDOW
            ? last3.reduce((n, w) => n + w.pct, 0) / last3.length
            : null;
        const best = weekly.reduce((b, w) => (b === null || w.pct > b.pct ? w : b), null);

        out[picker] = {
            name: picker,
            wins: rec.wins,
            losses: rec.losses,
            pushes: rec.pushes,
            draws: 0,
            percentage: recordPercentage(rec),
            totalPicks: rec.wins + rec.losses + rec.pushes,
            last3WeekPct: last3Pct,
            bestWeek: best ? String(best.week) : '',
            yearChange: yearChangeFor(rec, prior?.[picker]?.[category] || null)
        };
    });
    return out;
}

/** The category keys renderGroupStats() and the stats workbook both use. */
const GROUP_OVERALL_KEYS = { line: 'linePicks', blazin: 'blazin5', winner: 'winnerPicks' };

/**
 * The five pickers' records in each category, added together - the shape the
 * retired stats workbook used to hand over as `groupOverall`.
 *
 * How the group did as one, which is a different question from the standings:
 * sixteen line picks a week across five people is the sample the "are we any
 * good at this" number wants.
 *
 * Cowherd is left out. He is what the group plays against, and he makes five
 * picks a week to their sixteen, so folding him in would move the group's own
 * number by his form - the same reasoning cowherdBelongsIn() applies to the
 * standings.
 */
function groupOverallFromComputed(computed) {
    const out = {};
    Object.entries(GROUP_OVERALL_KEYS).forEach(([category, key]) => {
        const total = emptyRecord();
        PICKERS.forEach(picker => {
            const record = computed?.[picker]?.[category];
            if (!record) return;
            total.wins += record.wins;
            total.losses += record.losses;
            total.pushes += record.pushes;
        });
        out[key] = { ...total, percentage: recordPercentage(total) };
    });
    return out;
}

/** Whether a group record has anything in it yet. */
function groupRecordHasPicks(record) {
    return Boolean(record) && (record.wins + record.losses + record.pushes) > 0;
}

/**
 * Each picker's line record split by which side of the price they took - the
 * shape the retired stats workbook handed over as `favoritesVsUnderdogs`.
 *
 * Favourite or underdog is decided by **the line the pick is graded at**, not
 * the one on the board now: a pick frozen with the Seahawks at -3 is a
 * favourite pick even if they have since drifted to +1. lineForPick() is what
 * knows the difference, and it is the same line atsWinnerForPick() scores by,
 * so the two can never disagree about which bucket a win belongs in.
 *
 * A pick'em belongs to neither. It is a real line - see "A missing line is
 * null, never 0" - but nobody is favoured at it, so counting it as a dog pick
 * (which `favorite === 'home'` on a 0 would quietly do) would be inventing a
 * price that was never there. Games with no usable line are skipped for the
 * same reason they are skipped everywhere else: unscored, not a push.
 */
function favoritesVsUnderdogsFromPicks() {
    const data = { favorites: {}, underdogs: {} };
    PICKERS.forEach(picker => {
        data.favorites[picker] = emptyRecord();
        data.underdogs[picker] = emptyRecord();
    });

    const { first, last } = regularSeasonWeekRange();
    for (let week = first; week <= last; week++) {
        const weekGames = getGamesForWeekAndSeason(week, currentSeason);
        if (!weekGames || weekGames.length === 0) continue;

        const weekResults = getResultsForWeekAndSeason(week, currentSeason);
        const seasonPicks = getPicksForWeekAndSeason(week, currentSeason) || {};
        const cachedWeek = Number(currentSeason) === CURRENT_SEASON
            ? (weeklyPicksCache[week] || weeklyPicksCache[String(week)])
            : null;

        weekGames.forEach(game => {
            const result = getGameResult(game, weekResults);
            if (!result) return;

            PICKERS.forEach(picker => {
                const pick = pickFromSources(
                    game, seasonPicks[picker], cachedWeek?.picks?.[picker]);
                if (!pick.line) return;

                const line = lineForPick(game, pick);
                if (!hasUsableLine(line.spread)) return;   // no price to take a side of
                if (Number(line.spread) === 0) return;     // pick'em: nobody is favoured

                const ats = atsWinnerForPick(game, pick, result);
                if (!ats) return;

                const bucket = line.favorite === pick.line ? 'favorites' : 'underdogs';
                const outcome = ats === 'push' ? 'pushes'
                    : (pick.line === ats ? 'wins' : 'losses');
                data[bucket][picker][outcome]++;
            });
        });
    }

    ['favorites', 'underdogs'].forEach(bucket => {
        PICKERS.forEach(picker => {
            const record = data[bucket][picker];
            record.percentage = recordPercentage(record);
            record.totalPicks = record.wins + record.losses + record.pushes;
        });
    });

    return data;
}

/** Whether either side of the favourites/underdogs split holds a pick. */
function favUnderdogHasPicks(data) {
    if (!data) return false;
    return ['favorites', 'underdogs'].some(bucket =>
        PICKERS.some(picker => (data[bucket]?.[picker]?.totalPicks || 0) > 0));
}

/**
 * { picker: [{week, pct}] } - the shape renderTrendChart expects.
 *
 * `pct` is the record **from the start of the season up to and including that
 * week**, not the week on its own. The chart is a season tracking where each
 * point is the standing at that moment, which is the same number the standings
 * table shows once the last week is in.
 *
 * A per-week percentage was the wrong series for it. The Blazin' 5 is five
 * picks, so a week can only ever be 0, 20, 40, 60, 80 or 100 - the line spent
 * every week at an extreme and said nothing about how a season was going. It
 * also put most points outside the chart's own default 30-70% window.
 */
function weeklySeriesFromComputed(computed, category) {
    const out = {};
    Object.keys(computed).forEach(picker => {
        if (!cowherdBelongsIn(picker, category, computed[picker][category])) return;
        const running = emptyRecord();
        out[picker] = computed[picker].byWeek
            .map(w => {
                running.wins += w[category].wins;
                running.losses += w[category].losses;
                running.pushes += w[category].pushes;
                return { week: w.week, pct: recordPercentage(running) };
            })
            // Weeks before the picker's first decided pick have no percentage
            // to plot - a gap, not a 0%.
            .filter(w => w.pct !== null);
    });
    return out;
}

/**
 * Whether a picker belongs in a standings category at all.
 *
 * Only Cowherd is ever excluded, and for two reasons: he has no record but a
 * Blazin' 5 one (his line picks ARE the Blazin' 5, so the Line column would be
 * five picks a week against everyone else's sixteen), and an empty Cowherd row
 * before the first week of his picks is entered reads as a bug rather than as
 * a scoreline.
 */
function cowherdBelongsIn(picker, category, record) {
    if (picker !== COWHERD) return true;
    if (category !== COWHERD_CATEGORY) return false;
    return record.wins + record.losses + record.pushes > 0;
}

/**
 * Load every regular-season schedule up to the current week, in parallel.
 *
 * calculateStatsForWeeks can only score a week whose games are loaded, and
 * schedules are otherwise fetched lazily as you navigate - so without this the
 * season standings would only count the weeks you happened to visit. Weeks
 * already in NFL_GAMES_BY_WEEK are skipped, and loadWeekSchedule serves from
 * its own per-week localStorage cache, so this is cheap after the first run.
 */
async function loadPriorSeasonForComparison() {
    const prior = CURRENT_SEASON - 1;
    // AVAILABLE_SEASONS runs back to 2016, so this is really asking "is there a
    // season before this one at all". A year that is in the list but not yet
    // archived resolves to null, which the Year Chg column reads as no
    // comparison - loadSeasonData already swallows the 404.
    if (!AVAILABLE_SEASONS.includes(prior)) return null;
    if (getSeasonData(prior)) return getSeasonData(prior);
    return loadSeasonData(prior, { quiet: true });
}

async function preloadSeasonSchedules() {
    const { first, last } = regularSeasonWeekRange();
    const missing = [];

    for (let week = first; week <= last; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        if (!games || games.length === 0) missing.push(week);
    }

    if (missing.length === 0) return;

    console.log(`[Standings] Loading ${missing.length} week schedule(s) for season stats...`);
    // Spreads included: without them there is no line to score against, so
    // skipping the spread load here silently broke ATS standings.
    await Promise.all(missing.map(week => loadWeekSchedule(week, false)));
}

/**
 * True when standings are computed from picks + results rather than read from
 * the legacy stats workbook - i.e. every season after LEGACY_SHEETS_SEASON.
 *
 * Guards must ask this rather than testing dashboardData, which is only ever
 * populated by the workbook CSV and is null for a computed season.
 */
function usingComputedStandings() {
    return LEGACY_SHEETS_SEASON !== CURRENT_SEASON;
}

/** The regular-season week range that currently has games to score. */
function regularSeasonWeekRange() {
    const lastRegular = FIRST_PLAYOFF_WEEK - 1;
    return { first: 1, last: Math.min(CURRENT_NFL_WEEK || lastRegular, lastRegular) };
}

/**
 * Playoff standings: the same engine over weeks 19-22, flattened into the
 * combined Line + Straight Up + Over/Under record the playoff table shows.
 */
function calculatePlayoffStats() {
    const computed = calculateStatsForWeeks(FIRST_PLAYOFF_WEEK, LAST_PLAYOFF_WEEK);
    const stats = {};

    PICKERS.forEach(picker => {
        const c = computed[picker];
        const s = {
            name: picker,
            lineWins: c.line.wins, lineLosses: c.line.losses, linePushes: c.line.pushes,
            suWins: c.winner.wins, suLosses: c.winner.losses,
            ouWins: c.ou.wins, ouLosses: c.ou.losses, ouPushes: c.ou.pushes
        };

        s.wins = s.lineWins + s.suWins + s.ouWins;
        s.losses = s.lineLosses + s.suLosses + s.ouLosses;
        s.pushes = s.linePushes + s.ouPushes;
        s.totalPicks = s.wins + s.losses + s.pushes;

        const decided = s.wins + s.losses;
        s.percentage = decided > 0 ? (s.wins / decided) * 100 : 0;

        const linePush = s.linePushes > 0 ? `-${s.linePushes}` : '';
        const ouPush = s.ouPushes > 0 ? `-${s.ouPushes}` : '';
        s.lineRecord = `${s.lineWins}-${s.lineLosses}${linePush}`;
        s.suRecord = `${s.suWins}-${s.suLosses}`;
        s.ouRecord = `${s.ouWins}-${s.ouLosses}${ouPush}`;

        stats[picker] = s;
    });

    return stats;
}

/**
 * Show or clear the "still loading" marking on the standings.
 *
 * Driven by standingsProvisional, and scoped to the Standings tab - every
 * other tab either reads archived data or shows the current week only, so
 * neither is waiting on the background block.
 */
function updateProvisionalIndicator() {
    const show = standingsProvisional && currentCategory === 'standings';
    document.body.classList.toggle('standings-provisional', show);

    const overlay = document.getElementById('provisional-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden', !show);
    if (!show) return;

    // Moved into the panel holding whichever standings table is on screen, so
    // the circle sits over that table rather than over the middle of the
    // window. The playoff table lives in its own section.
    const host = document.querySelector('#playoff-standings-section:not(.hidden) .standings-panel')
        || document.getElementById('standings-panel');
    if (host && overlay.parentElement !== host) host.appendChild(overlay);
}

/**
 * Render the full dashboard
 */
// What the Standings tab's table covers: 'season' is every week so far,
// 'week' is the one week in standingsWeek. Module state, as on the History
// tab: renderDashboard runs again on every live-score refresh and would
// otherwise have to read the controls back to stay where the reader put it.
let standingsScope = 'season';
let standingsWeek = null;

/** The current season's weeks with a result in them - the ones worth a table. */
function standingsWeeks() {
    return historyStandingsWeeks(CURRENT_SEASON).filter(w => w < FIRST_PLAYOFF_WEEK);
}

/**
 * Fill the Standings tab's week dropdown. The chosen week is kept while it
 * is still on offer; otherwise the latest, which is the week just played.
 */
function populateStandingsWeeks() {
    const dropdown = document.getElementById('standings-week');
    const weeks = standingsWeeks();
    if (!weeks.includes(standingsWeek)) {
        standingsWeek = weeks.length ? weeks[weeks.length - 1] : null;
    }
    if (!dropdown) return;
    const html = weeks.map(week =>
        `<option value="${week}"${week === standingsWeek ? ' selected' : ''}>${historyWeekName(week)}</option>`
    ).join('');
    // Only when it has changed: this runs on every refresh, and rewriting an
    // open dropdown closes it under the reader.
    if (dropdown.innerHTML !== html) dropdown.innerHTML = html;
}

/**
 * The toggle and week dropdown. Hidden on the Playoffs sub-tab, whose table
 * is the combined playoff record and not one of the weekly ones.
 */
function updateStandingsScopeControls() {
    document.getElementById('standings-scope')
        ?.classList.toggle('hidden', currentSubcategory === 'playoffs');
    document.querySelectorAll('[data-standings-scope]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.standingsScope === standingsScope);
    });
    document.getElementById('standings-week-selector')
        ?.classList.toggle('hidden', standingsScope !== 'week');
}

/** Switch the Standings tab's table between the season and one week of it. */
function setStandingsScope(scope) {
    if (scope !== 'season' && scope !== 'week') return;
    standingsScope = scope;
    renderDashboard();
}

/**
 * One week's record in a category, shaped for renderStandingsTable. The same
 * engine as the season table over the one week, so the season is the sum of
 * the weeks. Last 3-Wk, Best Week and Year Chg are season measures and are
 * not shown for a week; the 'week' column set leaves them out.
 */
function standingsWeekStats(week, category) {
    return standingsFromComputed(
        calculateStatsForWeeks(week, week, PICKERS_WITH_COWHERD), category);
}

function renderDashboard() {
    // Before the guard below: the marking has to come off even on the render
    // that bails out, or it outlives the data it describes.
    updateProvisionalIndicator();

    // dashboardData only exists when the legacy workbook was loaded. A computed
    // season has none and must still render, so bail only when there is neither.
    if (!dashboardData && !usingComputedStandings()) return;

    let stats, weeklyData;

    // Use subcategory to determine which stats to show
    // The stats workbook only exists for LEGACY_SHEETS_SEASON. From the season
    // after that, the same numbers are computed from picks + results instead,
    // so nobody has to hand-maintain a spreadsheet for the standings to work.
    const computeLocally = usingComputedStandings();
    const range = regularSeasonWeekRange();
    // Cowherd is scored in the same pass and then kept to the Blazin' 5
    // column by cowherdBelongsIn(); see COWHERD_CATEGORY.
    const computed = computeLocally
        ? calculateStatsForWeeks(range.first, range.last, PICKERS_WITH_COWHERD)
        : null;
    // Same weeks, last season - what the Year Chg column is a delta against.
    const prior = computeLocally
        ? priorSeasonStats(range.first, range.last, PICKERS_WITH_COWHERD)
        : null;
    // The two priced categories carry each picker's winnings onto their card,
    // at the stake chosen on the Winnings card. Same computed stats, so the
    // money and the record on a card are always the same picks.
    const winnings = computeLocally && WINNINGS_CATEGORIES.includes(currentSubcategory)
        ? calculateWinnings(getWinningsStake(), { computed })
        : null;
    const useComputed = category => {
        stats = standingsFromComputed(computed, category, prior);
        weeklyData = weeklySeriesFromComputed(computed, category);
    };

    switch (currentSubcategory) {
        case 'line':
            if (computeLocally) { useComputed('line'); break; }
            stats = dashboardData.linePicks;
            weeklyData = dashboardData.weeklyLinePicks;
            break;
        case 'blazin':
            if (computeLocally) { useComputed('blazin'); break; }
            stats = dashboardData.blazin5;
            weeklyData = dashboardData.weeklyBlazin5;
            break;
        case 'winner':
            if (computeLocally) { useComputed('winner'); break; }
            stats = dashboardData.winnerPicks;
            weeklyData = dashboardData.weeklyWinnerPicks;
            break;
        case 'playoffs':
            stats = calculatePlayoffStats();
            weeklyData = null; // No weekly trend for combined playoffs
            break;
        default:
            return;
    }

    // Calculate worst week from actual picks data (for Blazin' 5)
    if (currentSubcategory === 'blazin' && stats) {
        const worstWeeks = calculateWorstBlazinWeeks();
        Object.keys(stats).forEach(picker => {
            if (worstWeeks[picker]) {
                stats[picker].worstWeek = worstWeeks[picker];
            }
        });
    }

    if (winnings && stats) {
        Object.keys(stats).forEach(picker => {
            const w = winnings[picker]?.[currentSubcategory];
            if (w) stats[picker].winnings = w;
        });
    }

    // PRIMARY: Render leaderboard
    renderLeaderboard(stats);

    // Get section elements
    const performanceInsightsSection = document.getElementById('performance-insights-section');
    const recordsAnalysisSection = document.getElementById('records-analysis-section');
    const playoffStandingsSection = document.getElementById('playoff-standings-section');
    const playoffComparisonSection = document.getElementById('playoff-comparison-section');

    // Playoffs tab: show leaderboard cards and playoff standings table, hide other sections
    if (currentSubcategory === 'playoffs') {
        updateStandingsScopeControls();
        performanceInsightsSection?.classList.add('hidden');
        recordsAnalysisSection?.classList.add('hidden');
        playoffStandingsSection?.classList.remove('hidden');
        playoffComparisonSection?.classList.remove('hidden');
        renderPlayoffStandingsTable(stats);
        renderPlayoffComparison();
        return;
    }

    // Hide playoff standings table and comparison for non-playoff tabs
    playoffStandingsSection?.classList.add('hidden');
    playoffComparisonSection?.classList.add('hidden');

    // Show sections for non-playoff tabs
    performanceInsightsSection?.classList.remove('hidden');
    recordsAnalysisSection?.classList.remove('hidden');

    // SECONDARY: the standings table on its own, at the chosen scope. The
    // cards above and the charts below stay on the season.
    populateStandingsWeeks();
    updateStandingsScopeControls();
    if (standingsScope === 'week' && computeLocally) {
        renderStandingsTable(
            standingsWeek === null ? {} : standingsWeekStats(standingsWeek, currentSubcategory),
            { columns: 'week', week: standingsWeek });
    } else {
        renderStandingsTable(stats);
    }

    // TERTIARY: the charts, insights and patterns that sit with the records
    renderTrendChart(weeklyData, currentSubcategory);
    // Lone wolf and consensus are both computed from picks + results, like the
    // standings are, so neither is behind the dashboardData gate that used to
    // blank the whole Insights panel. Group stats and favourites-vs-underdogs
    // are still the workbook's and stay blank until they get the same
    // treatment as the standings table.
    renderInsights(computeLocally
        ? calculateConsensusRecord(currentSubcategory)
        : dashboardData?.universalAgreement);
    renderPatternsPanel();
    // Heading and grid together: the heading on its own over an empty grid
    // reads as a panel that failed to load rather than one with nothing to say.
    // Hidden on the subtab's own record, not on the object: a season can have
    // line picks scored and no Blazin' 5 yet.
    const groupOverall = computeLocally
        ? groupOverallFromComputed(computed)
        : dashboardData?.groupOverall;
    const groupRecord = groupOverall?.[GROUP_OVERALL_KEYS[currentSubcategory]];
    document.getElementById('group-performance-section')
        ?.classList.toggle('hidden', !groupRecordHasPicks(groupRecord));
    if (groupRecordHasPicks(groupRecord)) {
        renderGroupStats(groupOverall);
    }

    // Only show Favorites vs Underdogs chart on Line Picks tab
    const standingsChartContainer = document.getElementById('standings-chart-container');
    if (standingsChartContainer) {
        // Line Picks only - the split is about which side of a price was taken,
        // which the straight-up and Blazin' 5 tabs are not asking about.
        const favUnderdog = currentSubcategory !== 'line' ? null
            : (computeLocally ? favoritesVsUnderdogsFromPicks() : dashboardData?.favoritesVsUnderdogs);
        // Hidden until there is something to plot: renderFavUnderdogChart()
        // returns early on empty data, which used to leave an empty chart box
        // sitting on the tab all season.
        const showChart = favUnderdogHasPicks(favUnderdog);
        standingsChartContainer.classList.toggle('hidden', !showChart);
        if (showChart) {
            renderFavUnderdogChart(favUnderdog);
        }
    }

    // TERTIARY: Records & Analysis - configure tabs based on subcategory
    const blazinRecordsTab = document.querySelector('[data-panel="blazin-records-panel"]');
    const teamRecordsTab = document.querySelector('[data-panel="team-records-panel"]');

    if (currentSubcategory === 'blazin') {
        // Show Blazin' 5 Records tab, hide Team Records tab
        blazinRecordsTab?.classList.remove('hidden');
        teamRecordsTab?.classList.add('hidden');
        renderBlazinTeamPickRecords();
        renderBlazinSpreadRecords();
    } else if (currentSubcategory === 'line') {
        // Show Team Records tab, hide Blazin' 5 Records tab
        blazinRecordsTab?.classList.add('hidden');
        teamRecordsTab?.classList.remove('hidden');
        renderTeamPickRecords();
    } else {
        // Winner tab - hide both record tabs
        blazinRecordsTab?.classList.add('hidden');
        teamRecordsTab?.classList.add('hidden');
    }

    activateFirstVisibleConsolidatedTab(recordsAnalysisSection);
}

/**
 * Keep a consolidated section on a tab that is actually up.
 *
 * The two records tabs come and go with the subcategory, so the active one can
 * be hidden out from under the panel it is showing. Only a hidden active tab
 * moves the section: the section also holds Charts, Insights and Patterns now,
 * and re-rendering must not pull somebody off one of those and back onto
 * whichever records table the subcategory happens to imply.
 */
function activateFirstVisibleConsolidatedTab(section) {
    if (!section) return;

    const tabs = Array.from(section.querySelectorAll('.consolidated-tab'));
    const active = tabs.find(tab => tab.classList.contains('active'));
    if (active && !active.classList.contains('hidden')) return;

    tabs.find(tab => !tab.classList.contains('hidden'))?.click();
}

/**
 * Calculate team pick records for a specific picker (line picks)
 */
function calculateTeamPickRecords(picker) {
    const teamRecords = {};

    // Use season-aware max week
    const maxWeek = isHistoricalSeason() ? getMaxWeekForSeason(currentSeason) : CURRENT_NFL_WEEK;

    // Loop through all weeks with results
    for (let week = 1; week <= maxWeek; week++) {
        const games = getGamesForWeekAndSeason(week, currentSeason);
        const results = getResultsForWeekAndSeason(week, currentSeason);
        const weekPicks = getPicksForWeekAndSeason(week, currentSeason);
        // Get picks from both season data AND weeklyPicksCache (Google Sheets data)
        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || !results) continue;

        games.forEach(game => {
            // Try both string and number keys for compatibility
            const gameId = game.id;
            // Check both allPicks and weeklyPicksCache for the pick
            const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };
            const result = results[gameId] || results[String(gameId)];

            if (!pick?.line || !result) return;

            // Calculate if the pick was correct
            const atsWinner = atsWinnerForPick(game, pick, result);
            if (!atsWinner) return;
            const isWin = pick.line === atsWinner;
            const isPush = atsWinner === 'push';
            const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

            // Build game detail for expansion
            const pickedTeam = pick.line === 'away' ? game.away : game.home;
            const gameDetail = {
                week,
                away: game.away,
                home: game.home,
                awayScore: result.awayScore,
                homeScore: result.homeScore,
                spread: game.spread,
                favorite: game.favorite,
                picked: pickedTeam,
                outcome
            };

            // Record result for BOTH teams involved in the game
            [game.away, game.home].forEach(team => {
                // Normalize team name (e.g., "Buccs" -> "Buccaneers")
                const normalizedTeam = TEAM_NAME_MAP[team] || team;

                // Initialize team record if needed
                if (!teamRecords[normalizedTeam]) {
                    teamRecords[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                }

                // Store game detail
                teamRecords[normalizedTeam].games.push(gameDetail);

                if (isPush) {
                    teamRecords[normalizedTeam].pushes++;
                } else if (isWin) {
                    teamRecords[normalizedTeam].wins++;
                } else {
                    teamRecords[normalizedTeam].losses++;
                }
            });
        });
    }

    return teamRecords;
}

// Sort state for team records tables
const teamRecordsSortState = {
    line: { column: 'pct', direction: 'desc' },
    blazin: { column: 'record', direction: 'desc' },
    spread: { column: 'record', direction: 'desc' },
    'history-blazin': { column: 'record', direction: 'desc' },
    'history-spread': { column: 'record', direction: 'desc' }
};

/**
 * Sort team records data based on column and direction
 */
function sortTeamRecordsData(data, column, direction) {
    return [...data].sort((a, b) => {
        let comparison = 0;
        switch (column) {
            case 'team':
                comparison = a.team.localeCompare(b.team);
                break;
            case 'spread':
                // Sort by spread value numerically
                comparison = a.spreadValue - b.spreadValue;
                break;
            case 'record':
                // Sort by margin (wins - losses), then by more wins as tiebreaker
                const marginA = a.wins - a.losses;
                const marginB = b.wins - b.losses;
                comparison = marginB - marginA;
                if (comparison === 0) comparison = b.wins - a.wins;
                break;
            case 'picks':
                comparison = b.total - a.total;
                break;
            case 'pct':
            default:
                comparison = b.pct - a.pct;
                if (comparison === 0) comparison = b.total - a.total;
                break;
        }
        return direction === 'asc' ? -comparison : comparison;
    });
}

/**
 * Handle sorting when column header is clicked
 */
function handleTeamRecordsSort(tableType, column) {
    const state = teamRecordsSortState[tableType];

    // Toggle direction if same column, otherwise default to desc (except team/spread which defaults to asc)
    if (state.column === column) {
        state.direction = state.direction === 'desc' ? 'asc' : 'desc';
    } else {
        state.column = column;
        state.direction = (column === 'team' || column === 'spread') ? 'asc' : 'desc';
    }

    // Update header icons
    const tableIds = {
        line: 'team-records-table',
        blazin: 'blazin-team-records-table',
        spread: 'blazin-spread-records-table',
        'history-blazin': 'history-blazin-team-table',
        'history-spread': 'history-blazin-spread-table'
    };
    const table = document.getElementById(tableIds[tableType]);
    if (table) {
        table.querySelectorAll('th.sortable').forEach(th => {
            const sortCol = th.getAttribute('data-sort');
            const icon = th.querySelector('.sort-icon');
            if (sortCol === column) {
                th.classList.add('active');
                th.classList.toggle('desc', state.direction === 'desc');
                th.classList.toggle('asc', state.direction === 'asc');
                icon.textContent = state.direction === 'desc' ? '▼' : '▲';
            } else {
                th.classList.remove('active', 'desc', 'asc');
                icon.textContent = '';
            }
        });
    }

    // Re-render the table
    if (tableType === 'line') {
        renderTeamPickRecords();
    } else if (tableType === 'blazin') {
        renderBlazinTeamPickRecords();
    } else if (tableType === 'spread') {
        renderBlazinSpreadRecords();
    } else if (tableType === 'history-blazin') {
        renderHistoryBlazinTeamRecords();
    } else if (tableType === 'history-spread') {
        renderHistoryBlazinSpreadRecords();
    }
}

/**
 * Render the team pick records table
 */
function renderTeamPickRecords(picker = null) {
    const dropdown = document.getElementById('team-records-picker');
    const tbody = document.getElementById('team-records-body');

    if (!tbody) return;

    // Use provided picker or get from dropdown
    const selectedPicker = picker || dropdown?.value || 'Stephen';

    // Calculate records for this picker
    const teamRecords = calculateTeamPickRecords(selectedPicker);

    // Convert to array
    const teamsData = Object.entries(teamRecords)
        .map(([team, record]) => {
            const total = record.wins + record.losses;
            const pct = total > 0 ? (record.wins / total) * 100 : 0;
            return { team, ...record, total: total + record.pushes, pct };
        })
        .filter(t => t.total > 0);

    // Sort based on current sort state
    const { column, direction } = teamRecordsSortState.line;
    const sortedTeams = sortTeamRecordsData(teamsData, column, direction);

    // Render table rows with expandable details
    tbody.innerHTML = sortedTeams.map(({ team, wins, losses, pushes, total, pct, games }, index) => {
        const pushStr = pushes > 0 ? `-${pushes}` : '';
        const pctClass = pct >= 50 ? 'positive' : pct < 50 ? 'negative' : 'neutral';
        const teamId = team.replace(/[^a-zA-Z0-9]/g, '');

        // Sort games by week
        const sortedGames = [...games].sort((a, b) => a.week - b.week);

        // Build game details HTML
        const gameDetailsHtml = sortedGames.map(g => {
            const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
            const outcomeText = g.outcome.toUpperCase();
            const spreadText = g.favorite === 'away'
                ? `${g.away} -${g.spread}`
                : `${g.home} -${g.spread}`;
            const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

            return `
                <div class="game-detail-row ${outcomeClass}">
                    <span class="game-week">Wk ${g.week}</span>
                    <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                    <span class="game-spread">${spreadText}</span>
                    <span class="game-picked">Picked: ${pickedNormalized}</span>
                    <span class="game-outcome">${outcomeText}</span>
                </div>
            `;
        }).join('');

        const logoUrl = getTeamLogo(team);
        const abbrev = getTeamAbbreviation(team);
        const color = getTeamColor(team);

        return `
            <tr class="team-row" data-team="${teamId}" onclick="toggleTeamDetails('${teamId}')">
                <td class="team-name">
                    <img src="${logoUrl}" alt="${team}" class="team-logo-small" onerror="this.outerHTML='<span class=\\'team-logo-fallback-small\\' style=\\'background-color:${color}\\'>${abbrev}</span>'">
                    ${team}
                </td>
                <td class="record">${wins}-${losses}${pushStr}</td>
                <td class="picks-count">${total}</td>
                <td class="win-pct ${pctClass}">${pct.toFixed(1)}%</td>
            </tr>
            <tr class="team-details-row hidden" id="details-${teamId}">
                <td colspan="4">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (sortedTeams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-light);">No picks data available</td></tr>';
    }
}

/**
 * Toggle team details expansion
 */
function toggleTeamDetails(teamId) {
    const detailsRow = document.getElementById(`details-${teamId}`);
    if (detailsRow) {
        detailsRow.classList.toggle('hidden');
    }
}

/** A Blazin' 5 week is perfect at five wins, no losses and no pushes. */
const PERFECT_BLAZIN_WINS = 5;

/** Whether a week's record is a perfect one. */
function isPerfectBlazinWeek(rec) {
    return Boolean(rec) && rec.wins === PERFECT_BLAZIN_WINS && !rec.losses && !rec.pushes;
}

/**
 * A season's 5-0 Blazin' 5 weeks, per picker, as a list of week numbers.
 *
 * Read off calculateStatsForWeeks' per-week breakdown, so a week is scored
 * exactly as the standings score it - each pick at its own line. Strictly
 * 5-0-0: a push is not a win, so 4-0-1 is not a perfect week. Regular season
 * only, which is the only time the star is offered.
 *
 * Cowherd's picks are not in the archives, only his week-by-week record, so
 * his come from cowherdWeeklyResults() for every season alike. The 2022 and
 * earlier archives hold his as a season aggregate with no weeks in it, so
 * those seasons can say nothing about his.
 */
function perfectBlazinWeeks(season = CURRENT_SEASON) {
    const lastRegular = FIRST_PLAYOFF_WEEK - 1;
    const last = Number(season) === CURRENT_SEASON
        ? regularSeasonWeekRange().last
        : Math.min(getMaxWeekForSeason(season), lastRegular);
    const pickers = getPickersForSeason(season);
    const computed = calculateStatsForWeeks(1, last, pickers, { season });
    const out = {};
    pickers.forEach(picker => {
        out[picker] = computed[picker].byWeek
            .filter(w => isPerfectBlazinWeek(w.blazin))
            .map(w => w.week);
    });

    const cowherd = cowherdWeeklyResults(season);
    if (cowherd && !cowherd.aggregate) {
        out[COWHERD] = Object.keys(cowherd).map(Number)
            .filter(week => week <= lastRegular && isPerfectBlazinWeek(cowherd[week]))
            .sort((a, b) => a - b);
    }
    return out;
}

/**
 * Every picker's 5-0 Blazin' 5 weeks across all the seasons on hand, oldest
 * first, with the count and the most recent one to hand. `missing` names the
 * archived seasons not loaded yet, which the card says while it waits.
 */
function perfectBlazinWeeksAllTime() {
    const seasons = [...AVAILABLE_SEASONS].sort((a, b) => a - b);
    const missing = seasons.filter(s => s !== CURRENT_SEASON && !getSeasonData(s));
    const byPicker = {};
    PICKERS_WITH_COWHERD.forEach(p => { byPicker[p] = { count: 0, weeks: [], last: null }; });

    seasons.filter(s => !missing.includes(s)).forEach(season => {
        const weeks = perfectBlazinWeeks(season);
        Object.keys(weeks).forEach(picker => {
            const entry = byPicker[picker];
            if (!entry) return;
            weeks[picker].forEach(week => {
                entry.weeks.push({ season, week });
                entry.count++;
                entry.last = { season, week };
            });
        });
    });
    return { byPicker, missing };
}

// One load of the archives for the all-time card, shared by every render.
let archivesLoading = null;

// Which pickers' rows on the 5-0 card are open onto their weeks. Outside the
// render, as asIsExpanded is: the card is redrawn when the archives land and
// on every dashboard refresh, and an open row must not snap shut.
const perfectWeeksExpanded = new Set();

// How the 5-0 card is ordered: by total, or by the most recent one. Total is
// the default - it is a tally first.
let perfectWeeksSort = 'total';

/** Order the 5-0 card by 'total' or 'last'. */
function setPerfectWeeksSort(sort) {
    if (sort !== 'total' && sort !== 'last') return;
    perfectWeeksSort = sort;
    renderPerfectWeeksCard();
}

/**
 * The card's order. By total: most first, the more recent breaking a tie. By
 * last: most recent first, the bigger total breaking a tie, and anyone who
 * has never done it at the bottom either way.
 */
function comparePerfectWeeks(a, b, sort = perfectWeeksSort) {
    const byTotal = b.count - a.count;
    const byLast = compareSeasonWeek(b.last, a.last);
    return sort === 'last' ? (byLast || byTotal) : (byTotal || byLast);
}

/** Open or close a picker's row on the 5-0 card. */
function togglePerfectWeeks(picker) {
    if (perfectWeeksExpanded.has(picker)) perfectWeeksExpanded.delete(picker);
    else perfectWeeksExpanded.add(picker);
    renderPerfectWeeksCard();
}

/**
 * Load every archived season that is not in yet, quietly, once. The Perfect
 * Weeks card is all-time, and the archives are otherwise only loaded on
 * demand for the History tab. A season that fails to load (the year just
 * finished, before it is archived) resolves to null and is simply not
 * counted; loadSeasonData already swallows that 404.
 */
function ensureArchivesLoaded() {
    if (!archivesLoading) {
        archivesLoading = Promise.all(AVAILABLE_SEASONS
            .filter(s => s !== CURRENT_SEASON && !getSeasonData(s))
            .map(s => loadSeasonData(s, { quiet: true }).catch(() => null)));
    }
    return archivesLoading;
}

/**
 * The Perfect Weeks card on the Insights panel: who has gone 5-0, how many
 * times across every season, and when they last did. Blazin' 5 sub-tab
 * only - it is a Blazin' 5 record - and hidden on the others.
 *
 * Drawn from whatever seasons are loaded, straight away, and again once the
 * rest of the archives arrive, so the current season is never held behind a
 * megabyte of history.
 */
function renderPerfectWeeksCard() {
    const card = document.getElementById('perfect-weeks-card');
    if (!card) return;
    const show = currentSubcategory === 'blazin' && usingComputedStandings();
    card.classList.toggle('hidden', !show);
    if (!show) return;

    const { byPicker, missing } = perfectBlazinWeeksAllTime();
    if (missing.length > 0) {
        ensureArchivesLoaded().then(() => renderPerfectWeeksCard());
    }

    // Cowherd is listed once any season has a week of his to count; the
    // others always are, since a zero is the point of a tracker.
    const listed = PICKERS_WITH_COWHERD.filter(p => p !== COWHERD
        || AVAILABLE_SEASONS.some(s => !missing.includes(s) && cowherdWeeklyResults(s) && !cowherdWeeklyResults(s).aggregate));
    const sorted = listed.sort((a, b) => comparePerfectWeeks(byPicker[a], byPicker[b]));
    const best = Math.max(0, ...sorted.map(p => byPicker[p].count));

    // One line a picker: name, when they last did it, and the count on the
    // right. No rank column - the order says it. A row with anything in it
    // opens onto the weeks themselves, newest first.
    const rows = sorted.map(picker => {
        const { count, last, weeks } = byPicker[picker];
        const leader = best > 0 && count === best;
        const open = count > 0 && perfectWeeksExpanded.has(picker);
        const detail = open ? `
            <div class="perfect-weeks-detail">
                ${[...weeks].reverse().map(w => `<span class="perfect-week-chip">${w.season} Wk ${w.week}</span>`).join('')}
            </div>` : '';
        return `
            <div class="perfect-weeks-row ${leader ? 'leader' : ''} ${count ? 'openable' : 'none'} ${open ? 'open' : ''}"
                ${count ? `onclick="togglePerfectWeeks('${picker}')" title="Show the weeks"` : ''}>
                <span class="lone-wolf-name">${picker}</span>
                <span class="perfect-weeks-last">${last ? `${last.season} Wk ${last.week}` : '&ndash;'}</span>
                <span class="perfect-weeks-count">${count}</span>
            </div>${detail}
        `;
    }).join('');

    const note = missing.length > 0
        ? `<p class="insight-description">Loading ${missing.length} earlier season${missing.length === 1 ? '' : 's'}&hellip;</p>`
        : (best === 0 ? '<p class="insight-description">Nobody has gone 5-0 yet.</p>' : '');

    // The same header as the lone wolf card: a picture, then the title and
    // subtitle. blazin-5.png is a local 160px crop of a Blazin' 5 segment
    // still - the original is a 3.7 MB frame, which is not for hotlinking
    // into a 60px slot.
    // The sort controls sit in the header, above the line, over the columns
    // they order; the list then starts where the lone wolf card's does.
    card.innerHTML = `
        <div class="insight-header insight-image-header perfect-weeks-header">
            <img src="blazin-5.png" alt="Blazin' 5" class="insight-image">
            <div>
                <span class="insight-title">5-0 Blazin' 5 Weeks</span>
                <p class="insight-subtitle">All seasons</p>
            </div>
            <div class="perfect-weeks-sorts">
                <button type="button" class="perfect-weeks-sort perfect-weeks-last"
                    onclick="setPerfectWeeksSort('last')" title="Sort by most recent">Last</button>
                <button type="button" class="perfect-weeks-sort perfect-weeks-count"
                    onclick="setPerfectWeeksSort('total')" title="Sort by total">Total</button>
            </div>
        </div>
        ${note}
        <div class="perfect-weeks-list">
            ${rows}
        </div>
    `;
}

// ============================================================================
// Winnings card
// ============================================================================

/** Which Winnings rows are open onto their weeks. */
const winningsExpanded = new Set();

function toggleWinningsRow(picker) {
    if (winningsExpanded.has(picker)) winningsExpanded.delete(picker);
    else winningsExpanded.add(picker);
    renderWinningsCard();
}

/**
 * A new stake from the card's input. Everything that shows money is redrawn:
 * the card itself and the profit line on every leaderboard card.
 */
function changeWinningsStake(value) {
    const stake = setWinningsStake(value);
    const input = document.getElementById('winnings-stake-input');
    if (input) input.value = stake;
    renderDashboard();
}

/**
 * The profit line on a leaderboard card: what this picker is up or down at
 * the chosen flat stake. Blank when there is no price to score at (straight
 * up, playoffs) or nothing scored yet.
 */
function bettingWinningsHtml(picker) {
    const w = picker.winnings;
    if (!w || w.picks === 0) return '';
    return `
        <div class="betting-winnings ${profitTone(w.profit)}">
            <span class="comparison-label">${formatStake(getWinningsStake())}/pick ${w.profit < 0 ? 'loss' : 'profit'}:</span>
            <span class="comparison-value">${formatCurrency(w.profit)}</span>
        </div>`;
}

/**
 * The Winnings card on the Insights panel: every picker's profit at a flat
 * stake on each pick of the sub-tab's category, best first, with the stake
 * itself editable in the header. Blazin' 5 and Line Picks only - straight up
 * has no price - and hidden on the others.
 *
 * One line a picker: name over record and ROI, the profit on the right. A
 * row opens onto its weeks, newest first.
 */
function renderWinningsCard() {
    const card = document.getElementById('winnings-card');
    if (!card) return;
    const category = currentSubcategory;
    const show = WINNINGS_CATEGORIES.includes(category) && usingComputedStandings();
    card.classList.toggle('hidden', !show);
    if (!show) return;

    const stake = getWinningsStake();
    const all = calculateWinnings(stake);
    const rows = Object.keys(all)
        .filter(p => all[p][category] && all[p][category].picks > 0)
        .map(p => ({ picker: p, ...all[p][category] }))
        .sort((a, b) => (b.profit - a.profit) || ((b.roi || 0) - (a.roi || 0)) || a.picker.localeCompare(b.picker));

    const best = rows.length ? rows[0].profit : 0;
    const what = category === 'blazin' ? "Blazin' 5 pick" : 'line pick';

    const list = rows.map(r => {
        const tone = profitTone(r.profit);
        const leader = r.profit > 0 && r.profit === best;
        const open = winningsExpanded.has(r.picker);
        const detail = open ? `
            <div class="winnings-detail">
                ${[...r.byWeek].reverse().map(w => `
                    <span class="winnings-week-chip ${profitTone(w.profit)}" title="${w.wins}-${w.losses}-${w.pushes}">Wk ${w.week} ${formatCurrency(w.profit)}</span>`).join('')}
            </div>` : '';
        return `
            <div class="winnings-row ${leader ? 'leader' : ''} openable ${open ? 'open' : ''}"
                onclick="toggleWinningsRow('${r.picker}')" title="Show the weeks">
                <div class="winnings-who">
                    <span class="lone-wolf-name">${r.picker}</span>
                    <span class="winnings-record">${r.wins}-${r.losses}-${r.pushes}
                        <span class="winnings-roi ${tone}">${formatSignedPercent(r.roi)} ROI</span></span>
                </div>
                <span class="winnings-profit ${tone}">${formatCurrency(r.profit)}</span>
            </div>${detail}`;
    }).join('');

    card.innerHTML = `
        <div class="insight-header winnings-header">
            <div>
                <span class="insight-title">Winnings</span>
                <p class="insight-subtitle">${formatStake(stake)} on every ${what}, at -110</p>
            </div>
            <label class="winnings-stake" onclick="event.stopPropagation()">
                <span class="winnings-stake-label">Stake</span>
                <span class="winnings-stake-field">
                    <span aria-hidden="true">$</span>
                    <input type="number" id="winnings-stake-input" class="winnings-stake-input"
                        min="1" step="5" value="${stake}" inputmode="decimal"
                        aria-label="Stake per pick, in dollars"
                        onchange="changeWinningsStake(this.value)">
                </span>
            </label>
        </div>
        <div class="winnings-list">
            ${list || '<p class="insight-description">Nothing scored yet.</p>'}
        </div>
        <p class="insight-description winnings-note">A win pays ${formatCurrency(profitForOutcome(stake, 'win'))}, a loss costs ${formatStake(stake)}, a push returns it. Straight-up picks are not priced.</p>
    `;
}

/** Order two { season, week } marks, null last. */
function compareSeasonWeek(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return (a.season - b.season) || (a.week - b.week);
}

/**
 * Calculate worst Blazin' 5 week for each picker (by record like "0-5")
 */
function calculateWorstBlazinWeeks() {
    const worstWeeks = {};
    const pickers = PICKERS_WITH_COWHERD;

    // Use season-aware max week
    const maxWeek = isHistoricalSeason() ? getMaxWeekForSeason(currentSeason) : CURRENT_NFL_WEEK;

    pickers.forEach(picker => {
        const weeklyRecords = {};

        // Calculate record for each week
        for (let week = 1; week <= maxWeek; week++) {
            const games = getGamesForWeekAndSeason(week, currentSeason);
            const results = getResultsForWeekAndSeason(week, currentSeason);
            const weekPicks = getPicksForWeekAndSeason(week, currentSeason);
            const pickerPicks = weekPicks[picker] || {};
            const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

            if (!games || games.length === 0 || !results) continue;

            let wins = 0, losses = 0, pushes = 0;

            games.forEach(game => {
                const gameId = game.id;
                const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };
                const result = results[gameId] || results[String(gameId)];

                // Only count Blazin' 5 picks
                if (!pick?.line || !pick?.blazin || !result) return;

                // Against the pick's OWN line, not the market's: a locked
                // pick keeps the number it was locked at, and every Cowherd
                // pick carries the number he called.
                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';

                if (isPush) pushes++;
                else if (isWin) wins++;
                else losses++;
            });

            const total = wins + losses + pushes;
            if (total > 0) {
                weeklyRecords[week] = { wins, losses, pushes, total };
            }
        }

        // Find the worst week (lowest win percentage, then most losses as tiebreaker)
        let worstWeek = null;
        let worstPct = 101;
        let worstRecord = '';

        Object.entries(weeklyRecords).forEach(([week, record]) => {
            const pct = record.total > 0 ? (record.wins / (record.wins + record.losses)) * 100 : 0;
            if (pct < worstPct || (pct === worstPct && record.losses > (worstWeek ? weeklyRecords[worstWeek].losses : 0))) {
                worstPct = pct;
                worstWeek = week;
                const pushStr = record.pushes > 0 ? `-${record.pushes}` : '';
                worstRecord = `Wk ${week}: ${record.wins}-${record.losses}${pushStr}`;
            }
        });

        if (worstRecord) {
            worstWeeks[picker] = worstRecord;
        }
    });

    return worstWeeks;
}

/**
 * Calculate Blazin' 5 team pick records for a specific picker
 */
function calculateBlazinTeamPickRecords(picker) {
    const teamRecords = {};

    // Use season-aware max week
    const maxWeek = isHistoricalSeason() ? getMaxWeekForSeason(currentSeason) : CURRENT_NFL_WEEK;

    // Loop through all weeks with results
    for (let week = 1; week <= maxWeek; week++) {
        const games = getGamesForWeekAndSeason(week, currentSeason);
        const results = getResultsForWeekAndSeason(week, currentSeason);
        const weekPicks = getPicksForWeekAndSeason(week, currentSeason);
        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || games.length === 0 || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };
            const result = results[gameId] || results[String(gameId)];

            // Only count Blazin' 5 picks
            if (!pick?.line || !pick?.blazin || !result) return;

            const atsWinner = atsWinnerForPick(game, pick, result);
            if (!atsWinner) return;
            const isWin = pick.line === atsWinner;
            const isPush = atsWinner === 'push';
            const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

            const pickedTeam = pick.line === 'away' ? game.away : game.home;
            const gameDetail = {
                week,
                away: game.away,
                home: game.home,
                awayScore: result.awayScore,
                homeScore: result.homeScore,
                spread: game.spread,
                favorite: game.favorite,
                picked: pickedTeam,
                outcome
            };

            // Record result for BOTH teams involved in the game
            [game.away, game.home].forEach(team => {
                const normalizedTeam = TEAM_NAME_MAP[team] || team;

                if (!teamRecords[normalizedTeam]) {
                    teamRecords[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                }

                teamRecords[normalizedTeam].games.push(gameDetail);

                if (isPush) {
                    teamRecords[normalizedTeam].pushes++;
                } else if (isWin) {
                    teamRecords[normalizedTeam].wins++;
                } else {
                    teamRecords[normalizedTeam].losses++;
                }
            });
        });
    }

    return teamRecords;
}

/**
 * Render the Blazin' 5 team pick records table
 */
function renderBlazinTeamPickRecords(picker = null) {
    const dropdown = document.getElementById('blazin-records-picker');
    const tbody = document.getElementById('blazin-team-records-body');

    if (!tbody) return;

    const selectedPicker = picker || dropdown?.value || 'Stephen';
    const teamRecords = calculateBlazinTeamPickRecords(selectedPicker);

    // Convert to array
    const teamsData = Object.entries(teamRecords)
        .map(([team, record]) => {
            const total = record.wins + record.losses;
            const pct = total > 0 ? (record.wins / total) * 100 : 0;
            return { team, ...record, total: total + record.pushes, pct };
        })
        .filter(t => t.total > 0);

    // Sort based on current sort state
    const { column, direction } = teamRecordsSortState.blazin;
    const sortedTeams = sortTeamRecordsData(teamsData, column, direction);

    tbody.innerHTML = sortedTeams.map(({ team, wins, losses, pushes, total, pct, games }) => {
        const pushStr = pushes > 0 ? `-${pushes}` : '';
        const pctClass = pct >= 50 ? 'positive' : pct < 50 ? 'negative' : 'neutral';
        const teamId = 'blazin-' + team.replace(/[^a-zA-Z0-9]/g, '');

        const sortedGames = [...games].sort((a, b) => a.week - b.week);

        const gameDetailsHtml = sortedGames.map(g => {
            const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
            const outcomeText = g.outcome.toUpperCase();
            const spreadText = g.favorite === 'away'
                ? `${g.away} -${g.spread}`
                : `${g.home} -${g.spread}`;
            const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

            return `
                <div class="game-detail-row ${outcomeClass}">
                    <span class="game-week">Wk ${g.week}</span>
                    <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                    <span class="game-spread">${spreadText}</span>
                    <span class="game-picked">Picked: ${pickedNormalized}</span>
                    <span class="game-outcome">${outcomeText}</span>
                </div>
            `;
        }).join('');

        const logoUrl = getTeamLogo(team);
        const abbrev = getTeamAbbreviation(team);
        const color = getTeamColor(team);

        return `
            <tr class="team-row" data-team="${teamId}" onclick="toggleTeamDetails('${teamId}')">
                <td class="team-name">
                    <img src="${logoUrl}" alt="${team}" class="team-logo-small" onerror="this.outerHTML='<span class=\\'team-logo-fallback-small\\' style=\\'background-color:${color}\\'>${abbrev}</span>'">
                    ${team}
                </td>
                <td class="record">${wins}-${losses}${pushStr}</td>
                <td class="picks-count">${total}</td>
                <td class="win-pct ${pctClass}">${pct.toFixed(1)}%</td>
            </tr>
            <tr class="team-details-row hidden" id="details-${teamId}">
                <td colspan="4">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (sortedTeams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-light);">No Blazin\' 5 picks data available</td></tr>';
    }
}

/**
 * Setup Blazin' 5 records dropdown and sorting (shared for both tables)
 */
function setupBlazinTeamRecordsDropdown() {
    const dropdown = document.getElementById('blazin-records-picker');
    if (dropdown) {
        dropdown.addEventListener('change', (e) => {
            const picker = e.target.value;
            renderBlazinTeamPickRecords(picker);
            renderBlazinSpreadRecords(picker);
        });
    }

    // Setup sortable headers for team table
    const teamTable = document.getElementById('blazin-team-records-table');
    if (teamTable) {
        teamTable.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.getAttribute('data-sort');
                handleTeamRecordsSort('blazin', column);
            });
        });
    }

    // Setup sortable headers for spread table
    const spreadTable = document.getElementById('blazin-spread-records-table');
    if (spreadTable) {
        spreadTable.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.getAttribute('data-sort');
                handleTeamRecordsSort('spread', column);
            });
        });
    }
}

/**
 * Calculate Blazin' 5 spread records for a specific picker
 * Groups picks by the spread size and tracks wins/losses/pushes
 */
function calculateBlazinSpreadRecords(picker) {
    const spreadRecords = {};

    // Use season-aware max week
    const maxWeek = isHistoricalSeason() ? getMaxWeekForSeason(currentSeason) : CURRENT_NFL_WEEK;

    // Loop through all weeks with results
    for (let week = 1; week <= maxWeek; week++) {
        const games = getGamesForWeekAndSeason(week, currentSeason);
        const results = getResultsForWeekAndSeason(week, currentSeason);
        const weekPicks = getPicksForWeekAndSeason(week, currentSeason);
        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || games.length === 0 || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };
            const result = results[gameId] || results[String(gameId)];

            // Only count Blazin' 5 picks
            if (!pick?.line || !pick?.blazin || !result) return;

            const atsWinner = atsWinnerForPick(game, pick, result);
            if (!atsWinner) return;
            const isWin = pick.line === atsWinner;
            const isPush = atsWinner === 'push';
            const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

            // Determine the spread for the picked team
            const pickedTeam = pick.line === 'away' ? game.away : game.home;
            const isFavorite = (game.favorite === 'away' && pick.line === 'away') ||
                             (game.favorite === 'home' && pick.line === 'home');

            // Format spread: negative for favorites, positive for underdogs
            const spreadValue = isFavorite ? -game.spread : game.spread;
            const spreadKey = spreadValue === 0 ? 'PK' :
                            (spreadValue > 0 ? `+${spreadValue}` : `${spreadValue}`);

            const gameDetail = {
                week,
                away: game.away,
                home: game.home,
                awayScore: result.awayScore,
                homeScore: result.homeScore,
                spread: game.spread,
                favorite: game.favorite,
                picked: pickedTeam,
                pickedSpread: spreadKey,
                outcome
            };

            if (!spreadRecords[spreadKey]) {
                spreadRecords[spreadKey] = {
                    wins: 0,
                    losses: 0,
                    pushes: 0,
                    games: [],
                    spreadValue: spreadValue
                };
            }

            spreadRecords[spreadKey].games.push(gameDetail);

            if (isPush) {
                spreadRecords[spreadKey].pushes++;
            } else if (isWin) {
                spreadRecords[spreadKey].wins++;
            } else {
                spreadRecords[spreadKey].losses++;
            }
        });
    }

    return spreadRecords;
}

/**
 * Render the Blazin' 5 spread records table
 */
function renderBlazinSpreadRecords(picker = null) {
    const dropdown = document.getElementById('blazin-records-picker');
    const tbody = document.getElementById('blazin-spread-records-body');

    if (!tbody) return;

    const selectedPicker = picker || dropdown?.value || 'Stephen';
    const spreadRecords = calculateBlazinSpreadRecords(selectedPicker);

    // Convert to array
    const spreadsData = Object.entries(spreadRecords)
        .map(([spread, record]) => {
            const total = record.wins + record.losses;
            const pct = total > 0 ? (record.wins / total) * 100 : 0;
            return {
                spread,
                spreadValue: record.spreadValue,
                ...record,
                total: total + record.pushes,
                pct
            };
        })
        .filter(s => s.total > 0);

    // Sort based on current sort state
    const { column, direction } = teamRecordsSortState.spread;
    const sortedSpreads = sortTeamRecordsData(spreadsData, column, direction);

    tbody.innerHTML = sortedSpreads.map(({ spread, wins, losses, pushes, total, pct, games }) => {
        const pushStr = pushes > 0 ? `-${pushes}` : '';
        const pctClass = pct >= 50 ? 'positive' : pct < 50 ? 'negative' : 'neutral';
        const spreadId = 'spread-' + spread.replace(/[^a-zA-Z0-9]/g, '');

        const sortedGames = [...games].sort((a, b) => a.week - b.week);

        const gameDetailsHtml = sortedGames.map(g => {
            const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
            const outcomeText = g.outcome.toUpperCase();
            const spreadText = g.favorite === 'away'
                ? `${g.away} -${g.spread}`
                : `${g.home} -${g.spread}`;
            const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

            return `
                <div class="game-detail-row ${outcomeClass}">
                    <span class="game-week">Wk ${g.week}</span>
                    <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                    <span class="game-spread">${spreadText}</span>
                    <span class="game-picked">Picked: ${pickedNormalized} (${g.pickedSpread})</span>
                    <span class="game-outcome">${outcomeText}</span>
                </div>
            `;
        }).join('');

        return `
            <tr class="team-row" data-team="${spreadId}" onclick="toggleTeamDetails('${spreadId}')">
                <td class="spread-value">${spread}</td>
                <td class="record">${wins}-${losses}${pushStr}</td>
                <td class="picks-count">${total}</td>
                <td class="win-pct ${pctClass}">${pct.toFixed(1)}%</td>
            </tr>
            <tr class="team-details-row hidden" id="details-${spreadId}">
                <td colspan="4">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (sortedSpreads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-light);">No Blazin\' 5 picks data available</td></tr>';
    }
}

/**
 * Calculate historical Blazin' 5 team pick records for a specific picker and season
 */
function calculateHistoryBlazinTeamRecords(picker, season) {
    const teamRecords = {};

    if (!getSeasonData(season)) return teamRecords;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    // Determine which pickers to include
    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    // Loop through all weeks
    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                // Only count Blazin' 5 picks
                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';
                const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

                const pickedTeam = pick.line === 'away' ? game.away : game.home;
                const gameDetail = {
                    week: weekNum,
                    picker: currentPicker,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome
                };

                // Record result for BOTH teams involved in the game
                [game.away, game.home].forEach(team => {
                    const normalizedTeam = TEAM_NAME_MAP[team] || team;

                    if (!teamRecords[normalizedTeam]) {
                        teamRecords[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                    }

                    teamRecords[normalizedTeam].games.push(gameDetail);

                    if (isPush) {
                        teamRecords[normalizedTeam].pushes++;
                    } else if (isWin) {
                        teamRecords[normalizedTeam].wins++;
                    } else {
                        teamRecords[normalizedTeam].losses++;
                    }
                });
            });
        });
    });

    return teamRecords;
}

/**
 * Calculate historical Blazin' 5 records when PICKING a specific team
 */
function calculateHistoryBlazinTeamPicked(picker, season) {
    const teamRecords = {};

    if (!getSeasonData(season)) return teamRecords;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';

                // Only record for the team that was PICKED
                const pickedTeam = pick.line === 'away' ? game.away : game.home;
                const normalizedTeam = TEAM_NAME_MAP[pickedTeam] || pickedTeam;

                if (!teamRecords[normalizedTeam]) {
                    teamRecords[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                }

                teamRecords[normalizedTeam].games.push({
                    week: weekNum,
                    picker: currentPicker,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome: isPush ? 'push' : (isWin ? 'win' : 'loss')
                });

                if (isPush) {
                    teamRecords[normalizedTeam].pushes++;
                } else if (isWin) {
                    teamRecords[normalizedTeam].wins++;
                } else {
                    teamRecords[normalizedTeam].losses++;
                }
            });
        });
    });

    return teamRecords;
}

/**
 * Calculate historical Blazin' 5 records when FADING (picking against) a specific team
 */
function calculateHistoryBlazinTeamFaded(picker, season) {
    const teamRecords = {};

    if (!getSeasonData(season)) return teamRecords;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';

                // Record for the team that was FADED (not picked)
                const pickedTeam = pick.line === 'away' ? game.away : game.home;
                const fadedTeam = pick.line === 'away' ? game.home : game.away;
                const normalizedTeam = TEAM_NAME_MAP[fadedTeam] || fadedTeam;

                if (!teamRecords[normalizedTeam]) {
                    teamRecords[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                }

                teamRecords[normalizedTeam].games.push({
                    week: weekNum,
                    picker: currentPicker,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome: isPush ? 'push' : (isWin ? 'win' : 'loss')
                });

                if (isPush) {
                    teamRecords[normalizedTeam].pushes++;
                } else if (isWin) {
                    teamRecords[normalizedTeam].wins++;
                } else {
                    teamRecords[normalizedTeam].losses++;
                }
            });
        });
    });

    return teamRecords;
}

/**
 * Calculate historical Blazin' 5 records by Home vs Away picks
 */
function calculateHistoryBlazinHomeAway(picker, season) {
    const records = {
        'Home': { wins: 0, losses: 0, pushes: 0, games: [] },
        'Away': { wins: 0, losses: 0, pushes: 0, games: [] }
    };

    if (!getSeasonData(season)) return records;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';

                const category = pick.line === 'home' ? 'Home' : 'Away';
                const pickedTeam = pick.line === 'away' ? game.away : game.home;

                records[category].games.push({
                    week: weekNum,
                    picker: currentPicker,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome: isPush ? 'push' : (isWin ? 'win' : 'loss')
                });

                if (isPush) {
                    records[category].pushes++;
                } else if (isWin) {
                    records[category].wins++;
                } else {
                    records[category].losses++;
                }
            });
        });
    });

    return records;
}

/**
 * Calculate historical Blazin' 5 records by Favorite vs Underdog picks
 */
function calculateHistoryBlazinFavDog(picker, season) {
    const records = {
        'Favorite': { wins: 0, losses: 0, pushes: 0, games: [] },
        'Underdog': { wins: 0, losses: 0, pushes: 0, games: [] }
    };

    if (!getSeasonData(season)) return records;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';

                const isFavorite = pick.line === game.favorite;
                const category = isFavorite ? 'Favorite' : 'Underdog';
                const pickedTeam = pick.line === 'away' ? game.away : game.home;

                records[category].games.push({
                    week: weekNum,
                    picker: currentPicker,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome: isPush ? 'push' : (isWin ? 'win' : 'loss')
                });

                if (isPush) {
                    records[category].pushes++;
                } else if (isWin) {
                    records[category].wins++;
                } else {
                    records[category].losses++;
                }
            });
        });
    });

    return records;
}

/**
 * Render the historical Blazin' 5 team pick records table
 */
function renderHistoryBlazinTeamRecords(picker = null) {
    const dropdown = document.getElementById('history-blazin-picker');
    const tbody = document.getElementById('history-blazin-team-body');
    const seasonDropdown = document.getElementById('history-season-dropdown');
    const analysisTypeDropdown = document.getElementById('history-team-analysis-type');

    if (!tbody) return;

    const selectedPicker = picker || dropdown?.value || 'Stephen';
    const seasonValue = seasonDropdown?.value;
    const isLifetime = seasonValue === 'lifetime';
    const seasons = isLifetime ? AVAILABLE_SEASONS : [parseInt(seasonValue) || 2024];
    // Matches the dropdown's own default (Team Picked) - the fallback only
    // applies when the element is missing, and disagreeing with the markup
    // would render a table the selector does not describe.
    const analysisType = analysisTypeDropdown?.value || 'picked';

    // Get records based on analysis type (aggregate across all seasons for lifetime)
    let teamRecords = {};
    seasons.forEach(season => {
        let seasonRecords;
        switch (analysisType) {
            case 'picked':
                seasonRecords = calculateHistoryBlazinTeamPicked(selectedPicker, season);
                break;
            case 'faded':
                seasonRecords = calculateHistoryBlazinTeamFaded(selectedPicker, season);
                break;
            case 'involved':
            default:
                seasonRecords = calculateHistoryBlazinTeamRecords(selectedPicker, season);
                break;
        }
        // Merge season records into aggregate
        Object.entries(seasonRecords).forEach(([team, record]) => {
            if (!teamRecords[team]) {
                teamRecords[team] = { wins: 0, losses: 0, pushes: 0, games: [] };
            }
            teamRecords[team].wins += record.wins;
            teamRecords[team].losses += record.losses;
            teamRecords[team].pushes += record.pushes;
            teamRecords[team].games.push(...(record.games || []).map(g => ({ ...g, season })));
        });
    });

    // Convert to array
    const teamsData = Object.entries(teamRecords)
        .map(([team, record]) => {
            const total = record.wins + record.losses;
            const pct = total > 0 ? (record.wins / total) * 100 : 0;
            return { team, ...record, total: total + record.pushes, pct };
        })
        .filter(t => t.total > 0);

    // Sort based on current sort state
    const { column, direction } = teamRecordsSortState['history-blazin'];
    const sortedTeams = sortTeamRecordsData(teamsData, column, direction);

    tbody.innerHTML = sortedTeams.map(({ team, wins, losses, pushes, total, pct, games }) => {
        const pushStr = pushes > 0 ? `-${pushes}` : '';
        const pctClass = pct >= 50 ? 'positive' : pct < 50 ? 'negative' : 'neutral';
        const teamId = 'hist-blazin-' + team.replace(/[^a-zA-Z0-9]/g, '');

        const sortedGames = [...games].sort((a, b) => (a.season || 0) - (b.season || 0) || a.week - b.week);

        const gameDetailsHtml = sortedGames.map(g => {
            const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
            const outcomeText = g.outcome.toUpperCase();
            const spreadText = g.favorite === 'away'
                ? `${g.away} -${g.spread}`
                : `${g.home} -${g.spread}`;
            const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

            return `
                <div class="game-detail-row ${outcomeClass}">
                    <span class="game-week${isLifetime ? ' with-season' : ''}">${isLifetime ? g.season + ' ' : ''}Wk ${g.week}</span>
                    <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                    <span class="game-spread">${spreadText}</span>
                    <span class="game-picked">Picked: ${pickedNormalized}</span>
                    <span class="game-outcome">${outcomeText}</span>
                </div>
            `;
        }).join('');

        const logoUrl = getTeamLogo(team);
        const abbrev = getTeamAbbreviation(team);
        const color = getTeamColor(team);

        return `
            <tr class="team-row" data-team="${teamId}" onclick="toggleTeamDetails('${teamId}')">
                <td class="team-name">
                    <img src="${logoUrl}" alt="${team}" class="team-logo-small" onerror="this.outerHTML='<span class=\\'team-logo-fallback-small\\' style=\\'background-color:${color}\\'>${abbrev}</span>'">
                    ${team}
                </td>
                <td class="record">${wins}-${losses}${pushStr}</td>
                <td class="picks-count">${total}</td>
                <td class="win-pct ${pctClass}">${pct.toFixed(1)}%</td>
            </tr>
            <tr class="team-details-row hidden" id="details-${teamId}">
                <td colspan="4">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (sortedTeams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-light);">No Blazin\' 5 picks data available</td></tr>';
    }
}

/**
 * Calculate historical Blazin' 5 spread records for a specific picker and season
 */
function calculateHistoryBlazinSpreadRecords(picker, season) {
    const spreadRecords = {};

    if (!getSeasonData(season)) return spreadRecords;

    const data = getSeasonData(season);
    const games = data.games || {};
    const results = data.results || {};
    const picks = data.picks || {};

    // Support "All" option - aggregate all pickers (excluding Cowherd)
    const pickersToInclude = picker === 'All' ? PICKERS : [picker];

    // Loop through all weeks
    Object.keys(games).forEach(weekKey => {
        const weekNum = parseInt(weekKey);
        if (isNaN(weekNum)) return;

        const weekGames = games[weekKey] || [];
        const weekResults = results[weekKey] || results[String(weekKey)] || {};
        const weekPicks = picks[weekKey] || picks[String(weekKey)] || {};

        pickersToInclude.forEach(currentPicker => {
            const pickerPicks = weekPicks[currentPicker] || {};

            weekGames.forEach(game => {
                const gameIdStr = String(game.id);
                const pick = getPicksForGame(pickerPicks, game);
                const result = weekResults[game.id] || weekResults[gameIdStr];

                // Only count Blazin' 5 picks
                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = atsWinnerForPick(game, pick, result);
                if (!atsWinner) return;
                const isWin = pick.line === atsWinner;
                const isPush = atsWinner === 'push';
                const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

                // Determine the spread for the picked team
                const pickedTeam = pick.line === 'away' ? game.away : game.home;
                const isFavorite = (game.favorite === 'away' && pick.line === 'away') ||
                                 (game.favorite === 'home' && pick.line === 'home');

                // Format spread: negative for favorites, positive for underdogs
                const spreadValue = isFavorite ? -game.spread : game.spread;
                const spreadKey = spreadValue === 0 ? 'PK' :
                                (spreadValue > 0 ? `+${spreadValue}` : `${spreadValue}`);

                const gameDetail = {
                    week: weekNum,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    pickedSpread: spreadKey,
                    outcome,
                    picker: currentPicker
                };

                if (!spreadRecords[spreadKey]) {
                    spreadRecords[spreadKey] = {
                        wins: 0,
                        losses: 0,
                        pushes: 0,
                        games: [],
                        spreadValue: spreadValue
                    };
                }

                spreadRecords[spreadKey].games.push(gameDetail);

                if (isPush) {
                    spreadRecords[spreadKey].pushes++;
                } else if (isWin) {
                    spreadRecords[spreadKey].wins++;
                } else {
                    spreadRecords[spreadKey].losses++;
                }
            });
        });
    });

    return spreadRecords;
}

/**
 * Render the historical Blazin' 5 spread records table
 */
function renderHistoryBlazinSpreadRecords(picker = null) {
    const dropdown = document.getElementById('history-blazin-picker');
    const tbody = document.getElementById('history-blazin-spread-body');
    const thead = document.getElementById('history-blazin-spread-thead');
    const seasonDropdown = document.getElementById('history-season-dropdown');
    const analysisTypeDropdown = document.getElementById('history-spread-analysis-type');

    if (!tbody) return;

    const selectedPicker = picker || dropdown?.value || 'Stephen';
    const seasonValue = seasonDropdown?.value;
    const isLifetime = seasonValue === 'lifetime';
    const seasons = isLifetime ? AVAILABLE_SEASONS : [parseInt(seasonValue) || 2024];
    const analysisType = analysisTypeDropdown?.value || 'spread';

    // Update table header based on analysis type
    if (thead) {
        const headerLabel = analysisType === 'spread' ? 'Spread' :
                           analysisType === 'homeaway' ? 'Location' : 'Type';
        thead.innerHTML = `
            <tr>
                <th class="sortable" data-sort="spread" data-table="history-spread">${headerLabel} <span class="sort-icon"></span></th>
                <th class="sortable active desc" data-sort="record" data-table="history-spread">Record <span class="sort-icon">▼</span></th>
                <th class="sortable" data-sort="picks" data-table="history-spread"># Picks <span class="sort-icon"></span></th>
                <th class="sortable" data-sort="pct" data-table="history-spread">Win % <span class="sort-icon"></span></th>
            </tr>
        `;
    }

    // Get records based on analysis type (aggregate across all seasons for lifetime)
    let records = {};
    seasons.forEach(season => {
        let seasonRecords;
        switch (analysisType) {
            case 'homeaway':
                seasonRecords = calculateHistoryBlazinHomeAway(selectedPicker, season);
                break;
            case 'favdog':
                seasonRecords = calculateHistoryBlazinFavDog(selectedPicker, season);
                break;
            case 'spread':
            default:
                seasonRecords = calculateHistoryBlazinSpreadRecords(selectedPicker, season);
                break;
        }
        // Merge season records into aggregate
        Object.entries(seasonRecords).forEach(([key, record]) => {
            if (!records[key]) {
                records[key] = { wins: 0, losses: 0, pushes: 0, games: [], spreadValue: record.spreadValue };
            }
            records[key].wins += record.wins;
            records[key].losses += record.losses;
            records[key].pushes += record.pushes;
            records[key].games.push(...(record.games || []).map(g => ({ ...g, season })));
        });
    });

    // Convert to array
    const spreadsData = Object.entries(records)
        .map(([spread, record]) => {
            const total = record.wins + record.losses;
            const pct = total > 0 ? (record.wins / total) * 100 : 0;
            return {
                spread,
                spreadValue: record.spreadValue || 0,
                ...record,
                total: total + record.pushes,
                pct
            };
        })
        .filter(s => s.total > 0);

    // Sort based on current sort state
    const { column, direction } = teamRecordsSortState['history-spread'];
    const sortedSpreads = sortTeamRecordsData(spreadsData, column, direction);

    tbody.innerHTML = sortedSpreads.map(({ spread, wins, losses, pushes, total, pct, games }) => {
        const pushStr = pushes > 0 ? `-${pushes}` : '';
        const pctClass = pct >= 50 ? 'positive' : pct < 50 ? 'negative' : 'neutral';
        const spreadId = 'hist-spread-' + spread.replace(/[^a-zA-Z0-9]/g, '');

        const sortedGames = [...games].sort((a, b) => (a.season || 0) - (b.season || 0) || a.week - b.week);

        const gameDetailsHtml = sortedGames.map(g => {
            const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
            const outcomeText = g.outcome.toUpperCase();
            const spreadText = g.favorite === 'away'
                ? `${g.away} -${g.spread}`
                : `${g.home} -${g.spread}`;
            const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

            return `
                <div class="game-detail-row ${outcomeClass}">
                    <span class="game-week${isLifetime ? ' with-season' : ''}">${isLifetime ? g.season + ' ' : ''}Wk ${g.week}</span>
                    <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                    <span class="game-spread">${spreadText}</span>
                    <span class="game-picked">Picked: ${pickedNormalized} (${g.pickedSpread})</span>
                    <span class="game-outcome">${outcomeText}</span>
                </div>
            `;
        }).join('');

        return `
            <tr class="team-row" data-team="${spreadId}" onclick="toggleTeamDetails('${spreadId}')">
                <td class="spread-value">${spread}</td>
                <td class="record">${wins}-${losses}${pushStr}</td>
                <td class="picks-count">${total}</td>
                <td class="win-pct ${pctClass}">${pct.toFixed(1)}%</td>
            </tr>
            <tr class="team-details-row hidden" id="details-${spreadId}">
                <td colspan="4">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (sortedSpreads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-light);">No Blazin\' 5 picks data available</td></tr>';
    }
}

/**
 * Setup history Blazin' 5 records dropdown and sorting
 */
function setupHistoryBlazinRecords() {
    const dropdown = document.getElementById('history-blazin-picker');
    if (dropdown) {
        dropdown.addEventListener('change', (e) => {
            const picker = e.target.value;
            renderHistoryBlazinTeamRecords(picker);
            renderHistoryBlazinSpreadRecords(picker);
        });
    }

    // Setup analysis type dropdowns
    const teamAnalysisDropdown = document.getElementById('history-team-analysis-type');
    if (teamAnalysisDropdown) {
        teamAnalysisDropdown.addEventListener('change', () => {
            renderHistoryBlazinTeamRecords();
        });
    }

    const spreadAnalysisDropdown = document.getElementById('history-spread-analysis-type');
    if (spreadAnalysisDropdown) {
        spreadAnalysisDropdown.addEventListener('change', () => {
            renderHistoryBlazinSpreadRecords();
        });
    }

    // Setup sortable headers for team table
    const teamTable = document.getElementById('history-blazin-team-table');
    if (teamTable) {
        teamTable.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.getAttribute('data-sort');
                handleTeamRecordsSort('history-blazin', column);
            });
        });
    }

    // Setup sortable headers for spread table
    const spreadTable = document.getElementById('history-blazin-spread-table');
    if (spreadTable) {
        spreadTable.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.getAttribute('data-sort');
                handleTeamRecordsSort('history-spread', column);
            });
        });
    }
}

/**
 * Setup team records dropdown and sorting
 */
function setupTeamRecordsDropdown() {
    const dropdown = document.getElementById('team-records-picker');
    if (dropdown) {
        dropdown.addEventListener('change', (e) => {
            renderTeamPickRecords(e.target.value);
        });
    }

    // Setup sortable headers
    const table = document.getElementById('team-records-table');
    if (table) {
        table.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const column = th.getAttribute('data-sort');
                handleTeamRecordsSort('line', column);
            });
        });
    }
}

/**
 * Calculate Lone Wolf picks with game details
 * A lone wolf pick is when only one picker chose a line while all others chose differently
 */
function calculateLoneWolfPicksWithDetails() {
    const loneWolfData = {};

    PICKERS.forEach(picker => {
        loneWolfData[picker] = {
            wins: 0,
            losses: 0,
            pushes: 0,
            games: []
        };
    });

    // Use season-aware max week
    const maxWeek = isHistoricalSeason() ? getMaxWeekForSeason(currentSeason) : CURRENT_NFL_WEEK;

    // Loop through all weeks
    for (let week = 1; week <= maxWeek; week++) {
        const games = getGamesForWeekAndSeason(week, currentSeason);
        const results = getResultsForWeekAndSeason(week, currentSeason);

        if (!games || games.length === 0 || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const result = results[gameId] || results[String(gameId)];
            if (!result) return;

            // Collect all picks for this game
            const picksByChoice = { away: [], home: [] };
            const pickByPicker = {};   // the wolf is graded at their own line
            const weekPicks = getPicksForWeekAndSeason(week, currentSeason);

            PICKERS.forEach(picker => {
                const pickerPicks = weekPicks[picker] || {};
                const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
                const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };

                if (pick?.line) {
                    picksByChoice[pick.line].push(picker);
                    pickByPicker[picker] = pick;
                }
            });

            // Check if there's a lone wolf (exactly 1 picker on one side, 4 on the other)
            const awayCount = picksByChoice.away.length;
            const homeCount = picksByChoice.home.length;

            let loneWolfPicker = null;
            let loneWolfSide = null;

            if (awayCount === 1 && homeCount === 4) {
                loneWolfPicker = picksByChoice.away[0];
                loneWolfSide = 'away';
            } else if (homeCount === 1 && awayCount === 4) {
                loneWolfPicker = picksByChoice.home[0];
                loneWolfSide = 'home';
            }

            if (loneWolfPicker) {
                const atsWinner = atsWinnerForPick(
                    game, pickByPicker[loneWolfPicker], result);
                if (!atsWinner) return;
                const isWin = loneWolfSide === atsWinner;
                const isPush = atsWinner === 'push';
                const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

                const pickedTeam = loneWolfSide === 'away' ? game.away : game.home;

                const gameDetail = {
                    week,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome
                };

                loneWolfData[loneWolfPicker].games.push(gameDetail);

                if (isPush) {
                    loneWolfData[loneWolfPicker].pushes++;
                } else if (isWin) {
                    loneWolfData[loneWolfPicker].wins++;
                } else {
                    loneWolfData[loneWolfPicker].losses++;
                }
            }
        });
    }

    return loneWolfData;
}

/**
 * Calculate Straight Up Lone Wolf picks with game details
 * A straight up lone wolf is when only one picker chose a winner while all others chose differently
 */
function calculateStraightUpLoneWolfPicks() {
    const loneWolfData = {};

    PICKERS.forEach(picker => {
        loneWolfData[picker] = {
            wins: 0,
            losses: 0,
            pushes: 0, // No pushes in straight up, but kept for consistency
            games: []
        };
    });

    // Loop through all weeks
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];

        if (!games || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const result = results[gameId] || results[String(gameId)];
            if (!result || !result.winner) return;

            // Collect all winner picks for this game
            const picksByChoice = { away: [], home: [] };

            PICKERS.forEach(picker => {
                const pickerPicks = allPicks[week]?.[picker] || {};
                const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
                const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };

                if (pick?.winner) {
                    picksByChoice[pick.winner].push(picker);
                }
            });

            // Check if there's a lone wolf (exactly 1 picker on one side, 4 on the other)
            const awayCount = picksByChoice.away.length;
            const homeCount = picksByChoice.home.length;

            let loneWolfPicker = null;
            let loneWolfSide = null;

            if (awayCount === 1 && homeCount === 4) {
                loneWolfPicker = picksByChoice.away[0];
                loneWolfSide = 'away';
            } else if (homeCount === 1 && awayCount === 4) {
                loneWolfPicker = picksByChoice.home[0];
                loneWolfSide = 'home';
            }

            if (loneWolfPicker) {
                const isWin = loneWolfSide === result.winner;
                const outcome = isWin ? 'win' : 'loss';

                const pickedTeam = loneWolfSide === 'away' ? game.away : game.home;

                const gameDetail = {
                    week,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome
                };

                loneWolfData[loneWolfPicker].games.push(gameDetail);

                if (isWin) {
                    loneWolfData[loneWolfPicker].wins++;
                } else {
                    loneWolfData[loneWolfPicker].losses++;
                }
            }
        });
    }

    return loneWolfData;
}

/**
 * Calculate Blazin' 5 Lone Wolf picks with game details
 * A Blazin' 5 lone wolf is when:
 * 1. There's a regular lone wolf (1 picker vs 4 on opposite sides for line picks)
 * 2. AND the lone wolf picker also marked that pick as Blazin' 5
 */
function calculateBlazinLoneWolfPicks() {
    const loneWolfData = {};

    PICKERS.forEach(picker => {
        loneWolfData[picker] = {
            wins: 0,
            losses: 0,
            pushes: 0,
            games: []
        };
    });

    // Loop through all weeks
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];

        if (!games || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const result = results[gameId] || results[String(gameId)];
            if (!result) return;

            // Collect ALL line picks for this game (to find regular lone wolves)
            const picksByChoice = { away: [], home: [] };
            const pickerPickData = {}; // Store full pick data to check Blazin' 5 status

            PICKERS.forEach(picker => {
                const pickerPicks = allPicks[week]?.[picker] || {};
                const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
                const pick = { ...getPicksForGame(cachedPicks, game), ...getPicksForGame(pickerPicks, game) };

                if (pick?.line) {
                    picksByChoice[pick.line].push(picker);
                    pickerPickData[picker] = pick;
                }
            });

            // Check if there's a regular lone wolf (1 vs 4)
            const awayCount = picksByChoice.away.length;
            const homeCount = picksByChoice.home.length;

            let loneWolfPicker = null;
            let loneWolfSide = null;

            if (awayCount === 1 && homeCount === 4) {
                loneWolfPicker = picksByChoice.away[0];
                loneWolfSide = 'away';
            } else if (homeCount === 1 && awayCount === 4) {
                loneWolfPicker = picksByChoice.home[0];
                loneWolfSide = 'home';
            }

            // Only count if the lone wolf picker ALSO made it a Blazin' 5 pick
            if (loneWolfPicker && pickerPickData[loneWolfPicker]?.blazin) {
                const atsWinner = atsWinnerForPick(game, pickerPickData[loneWolfPicker], result);
                if (!atsWinner) return;
                const isWin = loneWolfSide === atsWinner;
                const isPush = atsWinner === 'push';
                const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

                const pickedTeam = loneWolfSide === 'away' ? game.away : game.home;

                const gameDetail = {
                    week,
                    away: game.away,
                    home: game.home,
                    awayScore: result.awayScore,
                    homeScore: result.homeScore,
                    spread: game.spread,
                    favorite: game.favorite,
                    picked: pickedTeam,
                    outcome
                };

                loneWolfData[loneWolfPicker].games.push(gameDetail);

                if (isPush) {
                    loneWolfData[loneWolfPicker].pushes++;
                } else if (isWin) {
                    loneWolfData[loneWolfPicker].wins++;
                } else {
                    loneWolfData[loneWolfPicker].losses++;
                }
            }
        });
    }

    return loneWolfData;
}

/**
 * Toggle lone wolf details visibility
 */
function toggleLoneWolfDetails(pickerId) {
    const detailsRow = document.getElementById(`lone-wolf-details-${pickerId}`);
    if (detailsRow) {
        detailsRow.classList.toggle('hidden');
    }
}

/**
 * Toggle the list of games behind the consensus record.
 *
 * Collapsed by default: the card's job is the headline number, and on a full
 * season the Straight Up list runs to dozens of games.
 */
function toggleConsensusGames() {
    const games = document.getElementById('consensus-games');
    const button = document.getElementById('consensus-toggle');
    if (!games) return;

    const nowHidden = games.classList.toggle('hidden');
    if (button) {
        const count = games.querySelectorAll('.game-detail-row').length;
        button.textContent = nowHidden
            ? `Show the ${count} game${count === 1 ? '' : 's'}`
            : 'Hide games';
    }
}

/**
 * The side a pick takes in a category, or null when it takes none.
 *
 * The Blazin' 5 is a line pick with a star on it, so a game only counts as
 * agreement there when everybody starred it AND took the same side.
 */
function consensusSideFor(pick, category) {
    if (category === 'winner') return pick.winner || null;
    if (category === 'blazin' && !pick.blazin) return null;
    return pick.line || null;
}

/**
 * The group's record on games where all five pickers took the same side.
 *
 * Computed from picks + results, like the standings. It used to be read out of
 * the retired stats workbook (`universalAgreement`), which is why the card was
 * blank from the 2026 season on.
 *
 * Cowherd is not in it: PICKERS is the five players, and he picks five games a
 * week against their sixteen, so "all of us agreed" cannot mean him.
 *
 * **A consensus game is still scored one pick at a time.** Everybody taking the
 * same side does not mean everybody is on the same number - one may have locked
 * at -3 while the rest ride at -6.5 - so each pick goes through
 * atsWinnerForPick() and the game counts only when all five got the same
 * outcome. The rest are counted as `split` and reported rather than quietly
 * folded in, because there is no single group result to record. Reading the
 * line off the game instead would be the bug calculateATSWinner() was deleted
 * for; see "One line per pick" in CLAUDE.md.
 *
 * @returns {{wins, losses, pushes, games, split, percentage}|null} null when no
 *          game has qualified yet, which is the card's cue to stay hidden.
 *          `games` is every qualifying game, for the card's expanded list.
 */
function calculateConsensusRecord(category = currentSubcategory) {
    const record = { wins: 0, losses: 0, pushes: 0, games: [], split: 0 };
    const { first, last } = regularSeasonWeekRange();

    for (let week = first; week <= last; week++) {
        const weekGames = getGamesForWeekAndSeason(week, currentSeason);
        if (!weekGames || weekGames.length === 0) continue;

        const weekResults = getResultsForWeekAndSeason(week, currentSeason);
        const seasonPicks = getPicksForWeekAndSeason(week, currentSeason) || {};
        const cachedWeek = Number(currentSeason) === CURRENT_SEASON
            ? (weeklyPicksCache[week] || weeklyPicksCache[String(week)])
            : null;

        weekGames.forEach(game => {
            const result = getGameResult(game, weekResults);
            if (!result) return;

            let side = null;
            const outcomes = [];
            const lines = [];

            for (const picker of PICKERS) {
                const pick = pickFromSources(
                    game, seasonPicks[picker], cachedWeek?.picks?.[picker]);

                const taken = consensusSideFor(pick, category);
                if (!taken) return;                 // somebody sat this one out
                if (side === null) side = taken;
                else if (side !== taken) return;    // not unanimous

                if (category === 'winner') {
                    outcomes.push(pick.winner === result.winner ? 'wins' : 'losses');
                } else {
                    const ats = atsWinnerForPick(game, pick, result);
                    if (!ats) return;               // no usable line yet - unscored
                    outcomes.push(ats === 'push' ? 'pushes'
                        : (pick.line === ats ? 'wins' : 'losses'));
                    lines.push(describeLineForSide(game, side, pick));
                }
            }

            if (outcomes.length !== PICKERS.length) return;

            const agreed = outcomes.every(o => o === outcomes[0]);
            if (agreed) record[outcomes[0]]++; else record.split++;

            record.games.push({
                week,
                away: game.away,
                home: game.home,
                awayScore: result.awayScore,
                homeScore: result.homeScore,
                side,
                picked: side === 'home' ? game.home : game.away,
                // One line only when all five were graded at the same number.
                // They can hold different ones and still land on the same
                // outcome, and printing one of them would be a claim about the
                // other four.
                line: lines.length && lines.every(l => l === lines[0]) ? lines[0]
                    : (lines.length ? 'mixed lines' : ''),
                outcome: agreed
                    ? { wins: 'win', losses: 'loss', pushes: 'push' }[outcomes[0]]
                    : 'split'
            });
        });
    }

    if (record.games.length === 0) return null;
    record.games.sort((a, b) => a.week - b.week);
    return { ...record, percentage: recordPercentage(record) };
}

/**
 * Render Group Insights section (Lone Wolf + Consensus)
 *
 * Lone wolf is computed here from picks + results, so it needs nothing passed
 * in and works on a computed season. It used to take a `loneWolf` argument off
 * the retired stats workbook, which the body had already stopped reading -
 * dead, but it made the whole panel look like workbook data and is why it was
 * gated behind one.
 *
 * `consensus` is still the workbook's, and is absent from the season after
 * LEGACY_SHEETS_SEASON. That card stays blank until it gets the same treatment
 * the standings table did.
 */
function renderInsights(consensus) {
    // Render Consensus card. Hidden outright without the numbers rather than
    // left as an empty box beside a full lone wolf card.
    const consensusCard = document.getElementById('consensus-card');
    consensusCard?.classList.toggle('hidden', !consensus);
    if (consensusCard && consensus) {
        const pct = consensus.percentage;
        // formatPercent, not toFixed: a consensus game that is all pushes has
        // no percentage, and `null?.toFixed(1)` renders the word "undefined".
        const pctClass = typeof pct !== 'number' ? '' : (pct >= 50 ? 'positive' : 'negative');

        const what = currentSubcategory === 'winner' ? 'the same winner'
            : currentSubcategory === 'blazin' ? "the same Blazin' 5 pick"
            : 'the same side of the line';
        // Split games are consensus games with no single group outcome - the
        // five were on the same side at different locked numbers. Named rather
        // than dropped, so the count adds up against the record beside it.
        const splitNote = consensus.split > 0
            ? ` ${consensus.split} of ${consensus.games.length} graded at different locked lines and are not counted.`
            : '';

        const gameRows = consensus.games.map(g => `
            <div class="game-detail-row outcome-${g.outcome}">
                <span class="game-week">Wk ${g.week}</span>
                <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                <span class="game-spread">${g.line}</span>
                <span class="game-picked">All 5: ${g.picked}</span>
                <span class="game-outcome">${g.outcome.toUpperCase()}</span>
            </div>
        `).join('');

        const count = consensus.games.length;
        consensusCard.innerHTML = `
            <div class="insight-header">
                <span class="insight-title">When We All Agree</span>
            </div>
            <div class="insight-stat">
                <span class="insight-percentage ${pctClass}">${formatPercent(pct, 1)}</span>
                <span class="insight-record">${consensus.wins}-${consensus.losses}-${consensus.pushes}</span>
            </div>
            <p class="insight-description">Group record when all ${PICKERS.length} pickers take ${what}.${splitNote}</p>
            <button class="consensus-toggle" id="consensus-toggle" onclick="toggleConsensusGames()">
                Show the ${count} game${count === 1 ? '' : 's'}
            </button>
            <div class="consensus-games hidden" id="consensus-games">
                <div class="team-details-container">
                    ${gameRows}
                </div>
            </div>
        `;
    }

    renderPerfectWeeksCard();
    renderWinningsCard();

    // Calculate lone wolf with game details based on current tab
    let loneWolfDetails;
    if (currentSubcategory === 'blazin') {
        loneWolfDetails = calculateBlazinLoneWolfPicks();
    } else if (currentSubcategory === 'winner') {
        loneWolfDetails = calculateStraightUpLoneWolfPicks();
    } else {
        // 'line' tab - spread picks
        loneWolfDetails = calculateLoneWolfPicksWithDetails();
    }

    // Render Lone Wolf card
    const loneWolfCard = document.getElementById('lone-wolf-card');
    if (loneWolfCard && loneWolfDetails) {
        // Convert to array and calculate percentages
        const sorted = Object.entries(loneWolfDetails)
            .map(([name, data]) => {
                const total = data.wins + data.losses;
                const percentage = total > 0 ? (data.wins / total) * 100 : 0;
                return { name, ...data, percentage, total: total + data.pushes };
            })
            .filter(p => p.total > 0)
            .sort((a, b) => {
                // Sort by percentage first, then by total picks as tiebreaker
                if (b.percentage !== a.percentage) return b.percentage - a.percentage;
                return b.total - a.total;
            });

        const rows = sorted.map((picker, idx) => {
            const pickerId = picker.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const pushStr = picker.pushes > 0 ? `-${picker.pushes}` : '';

            // Build game details HTML
            const sortedGames = [...picker.games].sort((a, b) => a.week - b.week);
            const gameDetailsHtml = sortedGames.map(g => {
                const outcomeClass = g.outcome === 'win' ? 'outcome-win' : g.outcome === 'loss' ? 'outcome-loss' : 'outcome-push';
                const outcomeText = g.outcome.toUpperCase();
                const spreadText = g.favorite === 'away'
                    ? `${g.away} -${g.spread}`
                    : `${g.home} -${g.spread}`;
                const pickedNormalized = TEAM_NAME_MAP[g.picked] || g.picked;

                return `
                    <div class="game-detail-row ${outcomeClass}">
                        <span class="game-week">Wk ${g.week}</span>
                        <span class="game-matchup">${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore}</span>
                        <span class="game-spread">${spreadText}</span>
                        <span class="game-picked">Picked: ${pickedNormalized}</span>
                        <span class="game-outcome">${outcomeText}</span>
                    </div>
                `;
            }).join('');

            return `
                <div class="lone-wolf-row ${idx === 0 ? 'leader' : ''}" onclick="toggleLoneWolfDetails('${pickerId}')">
                    <span class="lone-wolf-rank">${idx + 1}</span>
                    <span class="lone-wolf-name">${picker.name}</span>
                    <span class="lone-wolf-pct ${picker.percentage >= 50 ? 'positive' : 'negative'}">${picker.percentage.toFixed(1)}%</span>
                    <span class="lone-wolf-record">${picker.wins}-${picker.losses}${pushStr}</span>
                </div>
                <div class="lone-wolf-details hidden" id="lone-wolf-details-${pickerId}">
                    <div class="team-details-container">
                        ${gameDetailsHtml}
                    </div>
                </div>
            `;
        }).join('');

        let loneWolfTitle = 'Lone Wolf Picks';
        let subtitle = '';

        if (currentSubcategory === 'blazin') {
            loneWolfTitle = "Lone Wolf Blazin' 5 Picks";
            subtitle = "Lone wolf picks (1 vs 4) that were also Blazin' 5'd";
        } else if (currentSubcategory === 'winner') {
            loneWolfTitle = 'Lone Wolf Straight Up Picks';
            subtitle = "Success rate when only one picker takes a winner";
        } else {
            loneWolfTitle = 'Lone Wolf Spread Picks';
            subtitle = "Success rate when only one picker takes a spread";
        }

        loneWolfCard.innerHTML = `
            <div class="insight-header lone-wolf-header">
                <img src="https://pbs.twimg.com/media/Crt1l8jWAAAmNyH.jpg" alt="Lone Wolf" class="lone-wolf-image">
                <div>
                    <span class="insight-title">${loneWolfTitle}</span>
                    <p class="insight-subtitle">${subtitle}</p>
                </div>
            </div>
            <div class="lone-wolf-leaderboard">
                ${rows}
            </div>
        `;
    }
}

/**
 * Populate the Patterns picker filter options (once)
 */
function populatePatternsPickerOptions() {
    const pickerFilter = document.getElementById('patterns-picker-filter');
    if (!pickerFilter || pickerFilter.options.length > 1) return;
    PICKERS.forEach(picker => {
        const option = document.createElement('option');
        option.value = picker;
        option.textContent = picker;
        pickerFilter.appendChild(option);
    });
}

/**
 * Render Pattern Insights panel
 */
function renderPatternsPanel() {
    const grid = document.getElementById('patterns-grid');
    const pickerFilter = document.getElementById('patterns-picker-filter');
    if (!grid) return;

    populatePatternsPickerOptions();

    // Get current filter values
    const selectedPicker = pickerFilter ? pickerFilter.value : 'all';
    const activeTypeBtn = document.querySelector('.pattern-type-btn.active');
    const selectedType = activeTypeBtn ? activeTypeBtn.dataset.type : 'all';

    // Get insights
    let insights = InsightsManager.getAllInterestingInsights();

    // Apply filters
    if (selectedPicker !== 'all') {
        insights = insights.filter(i => i.picker === selectedPicker);
    }
    if (selectedType !== 'all') {
        insights = insights.filter(i => i.type === selectedType);
    }

    if (insights.length === 0) {
        grid.innerHTML = `
            <div class="no-patterns-message">
                <p>No notable patterns found with current filters.</p>
                <p class="no-patterns-hint">Patterns are detected when there's a significant deviation from 50% win rate with enough sample size.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = insights.map(pattern => {
        const sentimentClass = pattern.sentiment === 'negative' ? 'pattern-negative' :
                               pattern.sentiment === 'positive' ? 'pattern-positive' : 'pattern-neutral';
        const typeBadge = pattern.type === 'primetime' ? 'Primetime' : 'Team';
        const pushText = pattern.pushes > 0 ? `-${pattern.pushes}` : '';

        return `
            <div class="pattern-card ${sentimentClass}">
                <div class="pattern-header">
                    <span class="pattern-picker">${pattern.picker}</span>
                    <span class="pattern-type-badge">${typeBadge}</span>
                </div>
                <div class="pattern-stat">${pattern.wins}-${pattern.losses}${pushText}</div>
                <div class="pattern-percentage ${sentimentClass}">${pattern.percentage}%</div>
                <div class="pattern-headline">${pattern.headline}</div>
                <div class="pattern-sample">${pattern.total} games</div>
            </div>
        `;
    }).join('');
}

/**
 * Set up pattern panel filter event handlers
 */
function setupPatternFilters() {
    const pickerFilter = document.getElementById('patterns-picker-filter');
    const typeButtons = document.querySelectorAll('.pattern-type-btn');

    if (pickerFilter) {
        pickerFilter.addEventListener('change', renderPatternsPanel);
    }

    typeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            typeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderPatternsPanel();
        });
    });
}

/**
 * Render Group Overall Stats section
 * Shows only the relevant category based on current tab
 */
function renderGroupStats(groupOverall) {
    const grid = document.getElementById('group-stats-grid');
    if (!grid) return;

    // Map current category to the relevant group stat
    const categoryMap = {
        'line': {
            key: 'linePicks',
            label: 'Line Picks',
            description: 'Combined against-the-spread picks'
        },
        'blazin': {
            key: 'blazin5',
            label: "Blazin' 5",
            description: 'Combined Blazin\' 5 picks performance'
        },
        'winner': {
            key: 'winnerPicks',
            label: 'Straight Up',
            description: 'Combined winner predictions'
        }
    };

    // Get only the category relevant to the current subtab
    const cat = categoryMap[currentSubcategory];
    if (!cat) return;

    const categories = [cat];

    grid.innerHTML = categories.map(cat => {
        const data = groupOverall[cat.key];
        if (!data) return '';

        const total = data.wins + data.losses + data.pushes;
        // formatPercent, not `data.percentage || 0`: a record of nothing but
        // pushes has no percentage, and calling it 0.0% paints the group red
        // for a set of picks none of which lost.
        const percentage = data.percentage;
        const pctClass = typeof percentage !== 'number' ? ''
            : (percentage >= 50 ? 'positive' : 'negative');
        const pushText = data.pushes > 0 ? `-${data.pushes}` : '';

        return `
            <div class="group-stat-card">
                <div class="group-stat-header">
                    <span class="group-stat-label">${cat.label}</span>
                </div>
                <div class="group-stat-percentage ${pctClass}">
                    ${formatPercent(percentage, 1)}
                </div>
                <div class="group-stat-record">
                    ${data.wins}-${data.losses}${pushText}
                </div>
                <div class="group-stat-total">
                    ${total} total picks
                </div>
                <p class="group-stat-description">${cat.description}</p>
            </div>
        `;
    }).join('');
}

/**
 * Winnings: what a flat stake on every pick would have returned.
 *
 * The book's price on a spread is not stored anywhere - applyOddsData keeps
 * the point and drops the price - so every line pick is scored at the
 * standard -110: a win returns 10/11 of the stake, a loss costs the stake, a
 * push returns it. Straight-up picks have no price either and are not scored;
 * a moneyline model would need the h2h prices kept, which the worker already
 * fetches (see formatMoneyline).
 */
const STANDARD_PRICE = -110;

/** Profit on a $1 stake at an American price: -110 -> 0.909..., +150 -> 1.5. */
function profitPerDollar(price = STANDARD_PRICE) {
    return price < 0 ? 100 / -price : price / 100;
}

/** Profit (or loss, negative) of one pick: outcome is 'win', 'loss' or 'push'. */
function profitForOutcome(stake, outcome, price = STANDARD_PRICE) {
    if (outcome === 'win') return stake * profitPerDollar(price);
    if (outcome === 'loss') return -stake;
    return 0;
}

/** Profit of a whole { wins, losses, pushes } record at a flat stake. */
function profitForRecord(record, stake, price = STANDARD_PRICE) {
    return record.wins * profitForOutcome(stake, 'win', price)
        + record.losses * profitForOutcome(stake, 'loss', price);
}

const WINNINGS_STAKE_KEY = 'nfl_winnings_stake';
const DEFAULT_WINNINGS_STAKE = 20;
/** The two categories that carry a price. Straight up does not. */
const WINNINGS_CATEGORIES = ['line', 'blazin'];

/** The stake this device's viewer chose; $20 until they choose one. */
function getWinningsStake() {
    try {
        const stored = Number(localStorage.getItem(WINNINGS_STAKE_KEY));
        if (Number.isFinite(stored) && stored > 0) return stored;
    } catch (e) { /* no storage - use the default */ }
    return DEFAULT_WINNINGS_STAKE;
}

/** Remember a stake. Anything that is not a positive number leaves it alone. */
function setWinningsStake(stake) {
    const value = Number(stake);
    if (!Number.isFinite(value) || value <= 0) return getWinningsStake();
    try { localStorage.setItem(WINNINGS_STAKE_KEY, String(value)); } catch (e) { /* fine */ }
    return value;
}

/**
 * Every picker's winnings at a flat stake, scored exactly as the standings
 * are - same picks, same results, same frozen lines, same season scoping,
 * Cowherd in the Blazin' 5 column only. Pass `computed` to reuse a
 * calculateStatsForWeeks result already in hand.
 *
 * @returns {Object} picker -> { line?, blazin? }, each
 *   { wins, losses, pushes, picks, staked, profit, roi, byWeek } where byWeek
 *   is [{ week, wins, losses, pushes, profit, running }] over the weeks that
 *   picker had something scored in the category. roi is profit over money
 *   staked as a percentage, null when nothing was staked. A category the
 *   picker does not belong in (cowherdBelongsIn) is left out.
 */
function calculateWinnings(stake = getWinningsStake(), {
    firstWeek, lastWeek, pickers = PICKERS_WITH_COWHERD, season = currentSeason, computed = null
} = {}) {
    const range = regularSeasonWeekRange();
    const first = firstWeek ?? range.first;
    const last = lastWeek ?? range.last;
    const stats = computed || calculateStatsForWeeks(first, last, pickers, { season });

    const out = {};
    Object.keys(stats).forEach(picker => {
        out[picker] = {};
        WINNINGS_CATEGORIES.forEach(category => {
            const rec = stats[picker][category];
            if (!cowherdBelongsIn(picker, category, rec)) return;
            let running = 0;
            const byWeek = stats[picker].byWeek
                .filter(w => w[category].wins + w[category].losses + w[category].pushes > 0)
                .map(w => {
                    const profit = profitForRecord(w[category], stake);
                    running += profit;
                    return { week: w.week, ...w[category], profit, running };
                });
            const picks = rec.wins + rec.losses + rec.pushes;
            const staked = picks * stake;
            const profit = profitForRecord(rec, stake);
            out[picker][category] = {
                wins: rec.wins, losses: rec.losses, pushes: rec.pushes,
                picks, staked, profit,
                roi: staked > 0 ? (profit / staked) * 100 : null,
                byWeek
            };
        });
    });
    return out;
}

/** '$20' or '$12.50': a stake, for a label. */
function formatStake(stake) {
    return '$' + (Number.isInteger(stake) ? String(stake) : stake.toFixed(2));
}

/** '+8.2%' / '-3.0%' / '0.0%'. */
function formatSignedPercent(pct, digits = 1) {
    if (typeof pct !== 'number' || Number.isNaN(pct)) return '';
    return (pct > 0 ? '+' : '') + pct.toFixed(digits) + '%';
}

/** positive / negative / neutral, for colouring a money figure. */
function profitTone(amount) {
    return amount > 0 ? 'positive' : amount < 0 ? 'negative' : 'neutral';
}

/**
 * Format currency for display
 */
function formatCurrency(amount) {
    const absAmount = Math.abs(amount);
    const formatted = absAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (amount > 0) return `+$${formatted}`;
    if (amount < 0) return `-$${formatted}`;
    return '$0.00';
}

/**
 * Load all weekly data for Blazin' 5 analysis
 * Fetches each week's sheet to get the * markers
 */
async function loadAllWeeklyDataForBlazin(weeksToLoad = null) {
    // The weekly tabs belong to LEGACY_SHEETS_SEASON's workbook - don't load
    // last season's picks into a new season.
    if (LEGACY_SHEETS_SEASON !== CURRENT_SEASON) {
        console.log('[Season] Skipping legacy weekly tabs (previous season workbook)');
        return;
    }

    // Only use corsproxy.io which we know works
    const proxy = 'https://corsproxy.io/?';

    let loadedWeeks = 0;
    let failedWeeks = 0;

    // Build array of weeks that need fetching
    const weeksToFetch = [];
    const weekRange = weeksToLoad || [];

    // If no specific weeks provided, load all weeks up to current
    if (weekRange.length === 0) {
        for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
            weekRange.push(week);
        }
    }

    for (const week of weekRange) {
        if (weeklyPicksCache[week]) {
            loadedWeeks++;
            continue; // Already cached
        }
        if (!WEEK_SHEET_GIDS[week]) continue; // No GID for this week
        weeksToFetch.push(week);
    }

    // Fetch all weeks in parallel
    const fetchPromises = weeksToFetch.map(async (week) => {
        const weekUrl = `${GOOGLE_SHEETS_BASE_URL}&gid=${WEEK_SHEET_GIDS[week]}`;
        try {
            const url = proxy + encodeURIComponent(weekUrl);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            const response = await fetch(url, { method: 'GET', signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.warn(`Week ${week}: HTTP ${response.status}`);
                return { week, success: false };
            }

            const csvText = await response.text();
            if (csvText.includes('<!DOCTYPE') || csvText.length < 50) {
                console.warn(`Week ${week}: Invalid response`);
                return { week, success: false };
            }

            const weekData = parseWeeklyPicksCSV(csvText, week);
            return { week, success: true, data: weekData };
        } catch (err) {
            console.warn(`Week ${week}: ${err.message}`);
            return { week, success: false };
        }
    });

    // Wait for all fetches to complete
    const results = await Promise.all(fetchPromises);

    // Process results and merge data
    for (const result of results) {
        if (!result.success) {
            failedWeeks++;
            continue;
        }

        const { week, data: weekData } = result;
        weeklyPicksCache[week] = weekData;

        // DISABLED: Pick data now comes from historical-data.js, not Google Sheets
        // Google Sheets picks merge is disabled to prevent overwriting historical data
        // The weeklyPicksCache is still populated for game/result data only

        // Merge results into NFL_RESULTS_BY_WEEK (Google Sheets takes priority)
        if (weekData.results && Object.keys(weekData.results).length > 0) {
            if (!NFL_RESULTS_BY_WEEK[week]) {
                NFL_RESULTS_BY_WEEK[week] = weekData.results;
            } else {
                // Google Sheets results OVERWRITE historical data
                for (const gameId in weekData.results) {
                    NFL_RESULTS_BY_WEEK[week][gameId] = weekData.results[gameId];
                }
            }
        }

        // Merge games into NFL_GAMES_BY_WEEK (Google Sheets takes priority for spreads)
        if (weekData.games && weekData.games.length > 0) {
            NFL_GAMES_BY_WEEK[week] = weekData.games;
        }

        // Count blazin picks for debugging
        let blazinCount = 0;
        for (const picker in weekData.picks) {
            for (const gameId in weekData.picks[picker]) {
                if (weekData.picks[picker][gameId].blazin) {
                    blazinCount++;
                }
            }
        }
        console.log(`Week ${week}: ${blazinCount} Blazin' 5 picks`);
        loadedWeeks++;
    }

    console.log(`Blazin' 5 data: ${loadedWeeks} weeks loaded, ${failedWeeks} failed`);

    // Save merged picks to localStorage so they persist (skip sync - just loading data)
    if (loadedWeeks > 0) {
        savePicksToStorage(false, true);
    }
}

/**
 * Render a single picker card
 */
function renderPickerCard(picker, index, isCompact = false) {
    const rankClass = index < 3 ? `rank-${index + 1}` : '';
    const colorClass = `color-${picker.name.toLowerCase()}`;
    // Level is not a fall, and a blank means there is nothing to compare
    // against - neither should be painted red.
    const yearChangeClass = picker.yearChange?.includes('▲') ? 'up'
        : picker.yearChange?.includes('▼') ? 'down'
        : '';
    const pctClass = picker.percentage >= 50 ? 'positive' : 'negative';
    const compactClass = isCompact ? 'compact' : '';
    const isPlayoffs = currentSubcategory === 'playoffs';
    const winningsHtml = isPlayoffs ? '' : bettingWinningsHtml(picker);

    // Playoff-specific stats breakdown
    const playoffStatsHtml = `
        <div class="stat-row">
            <span class="stat-label">Line (ATS)</span>
            <span class="stat-value">${picker.lineRecord || '-'}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Straight Up</span>
            <span class="stat-value">${picker.suRecord || '-'}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Over/Under</span>
            <span class="stat-value">${picker.ouRecord || '-'}</span>
        </div>
    `;

    // Regular season stats
    const regularStatsHtml = `
        <div class="stat-row">
            <span class="stat-label">Total Picks</span>
            <span class="stat-value">${picker.totalPicks || 0}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Last 3 Weeks</span>
            <span class="stat-value ${statValueClass(picker.last3WeekPct)}">
                ${formatPercent(picker.last3WeekPct)}
            </span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Best Week</span>
            <span class="stat-value">${picker.bestWeek || '-'}</span>
        </div>
        ${picker.worstWeek ? `
        <div class="stat-row">
            <span class="stat-label">Worst Week</span>
            <span class="stat-value">${picker.worstWeek}</span>
        </div>
        ` : ''}
    `;

    if (isCompact) {
        // Expandable compact card for runners-up section
        return `
            <div class="picker-card ${rankClass} ${compactClass}" onclick="toggleCompactCard(this)">
                <div class="compact-header">
                    <div class="compact-rank">#${index + 1}</div>
                    <div class="picker-name">
                        <span class="picker-color ${colorClass}"></span>
                        ${picker.name}
                    </div>
                    <div class="compact-stats">
                        <div class="win-pct ${pctClass}">${picker.percentage?.toFixed(2) || 0}%</div>
                        <div class="record">${picker.wins}-${picker.losses}-${picker.pushes || picker.draws || 0}</div>
                    </div>
                    <div class="expand-icon">▼</div>
                </div>
                <div class="compact-expanded">
                    <div class="picker-stats">
                        ${isPlayoffs ? playoffStatsHtml : regularStatsHtml}
                    </div>
                    ${winningsHtml ? `<div class="year-comparison">${winningsHtml}</div>` : ''}
                </div>
            </div>
        `;
    }

    // Full card for podium
    return `
        <div class="picker-card ${rankClass}" onclick="toggleFullCard(this)">
            <div class="picker-name">
                <span class="picker-color ${colorClass}"></span>
                ${picker.name}
            </div>
            <div class="win-pct ${pctClass}">${picker.percentage?.toFixed(2) || 0}%</div>
            <div class="record">${picker.wins}-${picker.losses}-${picker.pushes || picker.draws || 0}</div>
            <div class="picker-stats">
                ${isPlayoffs ? playoffStatsHtml : `
                <div class="stat-row">
                    <span class="stat-label">Total Picks</span>
                    <span class="stat-value">${picker.totalPicks || 0}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Last 3 Weeks</span>
                    <span class="stat-value ${statValueClass(picker.last3WeekPct)}">
                        ${formatPercent(picker.last3WeekPct)}
                    </span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Best Week</span>
                    <span class="stat-value">${picker.bestWeek || '-'}</span>
                </div>
                ${picker.worstWeek ? `
                <div class="stat-row expanded-stat hidden">
                    <span class="stat-label">Worst Week</span>
                    <span class="stat-value">${picker.worstWeek}</span>
                </div>
                ` : ''}`}
            </div>
            ${!isPlayoffs && picker.bestTeam && picker.worstTeam ? `
            <div class="team-records">
                <div class="team-record best">
                    <img src="${getTeamLogo(picker.bestTeam.team)}" alt="${picker.bestTeam.team} logo" class="team-badge-logo" onerror="handleLogoError(this, '${picker.bestTeam.team}')">
                    <span class="team-badge-name">${picker.bestTeam.team}</span>
                    <span class="team-badge-stats">${picker.bestTeam.record} (${picker.bestTeam.percentage?.toFixed(0)}%)</span>
                </div>
                <div class="team-record worst">
                    <img src="${getTeamLogo(picker.worstTeam.team)}" alt="${picker.worstTeam.team} logo" class="team-badge-logo" onerror="handleLogoError(this, '${picker.worstTeam.team}')">
                    <span class="team-badge-name">${picker.worstTeam.team}</span>
                    <span class="team-badge-stats">${picker.worstTeam.record} (${picker.worstTeam.percentage?.toFixed(0)}%)</span>
                </div>
            </div>
            ` : ''}
            ${!isPlayoffs ? `
            <div class="year-comparison">
                ${picker.yearChange ? `
                    <div class="year-change ${yearChangeClass}">
                        <span class="comparison-label">vs Last Year:</span>
                        <span class="comparison-value">${picker.yearChange}</span>
                    </div>
                ` : ''}
                ${winningsHtml}
            </div>
            ` : ''}
        </div>
    `;
}

/**
 * Render standings table
 */
/**
 * Draw a standings table.
 *
 * Targets the Standings tab by default. The Live tab's "as is" table passes
 * its own ids so it is the same table, drawn by the same code, rather than a
 * lookalike that drifts from it - and passes its own category, since it is
 * always the Blazin' 5 one whatever the Standings tab happens to be showing.
 */
function renderStandingsTable(stats, {
    tableId = 'standings-table',
    tbodyId = 'standings-table-body',
    category = currentSubcategory,
    setTitle = true,
    columns = 'season',
    positionChange = null,
    weekRecord = null,
    week = null
} = {}) {
    const tbody = document.getElementById(tbodyId);
    const thead = document.querySelector(`#${tableId} thead`);
    if (!tbody || !thead) return;

    const sorted = getSortedPickers(stats);

    // One week of the season: the record and nothing that describes a
    // season's shape. Empty when no week has been played yet.
    if (columns === 'week') {
        thead.innerHTML = `
            <tr>
                <th>Picker</th>
                <th>Win</th>
                <th>Loss</th>
                <th>Push</th>
                <th>%</th>
                <th>Total</th>
            </tr>
        `;
        if (week === null) {
            tbody.innerHTML = '<tr><td colspan="6" class="no-data">No weeks played yet</td></tr>';
            return;
        }
        tbody.innerHTML = sorted.map((picker, index) => {
            const pct = typeof picker.percentage === 'number'
                ? picker.percentage.toFixed(2) + '%' : '-';
            const pushOrDraw = category === 'winner' ? picker.draws || 0 : picker.pushes || 0;
            return `
                <tr class="${index === 0 ? 'leader' : ''}" data-picker="${picker.name}">
                    <td class="picker-name">${picker.name}</td>
                    <td>${picker.wins || 0}</td>
                    <td>${picker.losses || 0}</td>
                    <td>${pushOrDraw}</td>
                    <td class="${pctCellClass(picker.percentage)}">${pct}</td>
                    <td>${picker.totalPicks || 0}</td>
                </tr>
            `;
        }).join('');
        return;
    }

    // The Live tab's table: the record, and how far it has moved since last
    // week. No Last 3-Wk, Best Week or Year Chg - they describe the shape of a
    // season, which is not what is being watched on a Sunday afternoon.
    if (columns === 'as-is') {
        thead.innerHTML = `
            <tr>
                <th>Picker</th>
                <th>Win</th>
                <th>Loss</th>
                <th>Push</th>
                <th>%</th>
                <th>Total</th>
                <th title="Position change since the end of last week">Move</th>
            </tr>
        `;

        tbody.innerHTML = sorted.map((picker, index) => {
            const pct = typeof picker.percentage === 'number'
                ? picker.percentage.toFixed(2) + '%' : '-';
            const move = positionChange ? positionChange[picker.name] : null;
            const open = asIsExpanded.has(picker.name);
            // The games in play, as they stand, in a box beside the name. A div inside the
            // cell, not a flex cell: a td that stops being a table-cell
            // breaks the column it sits in. The box sits at the cell's right
            // edge, which is one line down the whole column.
            // No box at all for a picker with nothing in play.
            const record = weekRecord ? weekRecord[picker.name] : null;
            const tone = weekRecordTone(record);
            const week = weekRecord && weekRecordInPlay(record) ? `
                        <span class="week-record${tone ? ' ' + tone : ''}" title="Games in progress, as they stand">`
                            + `${formatWeekRecord(record)}</span>` : '';
            return `
                <tr class="as-is-row ${open ? 'open' : ''} ${index === 0 ? 'leader' : ''}"
                    onclick="toggleAsIsDetail('${picker.name}')"
                    title="Show this week&rsquo;s picks">
                    <td class="picker-name"><div class="as-is-name-cell">
                        <span class="as-is-name">${picker.name}</span>${week}
                    </div></td>
                    <td>${picker.wins || 0}</td>
                    <td>${picker.losses || 0}</td>
                    <td>${picker.pushes || 0}</td>
                    <td class="${pctCellClass(picker.percentage)}">${pct}</td>
                    <td>${picker.totalPicks || 0}</td>
                    <td class="position-move">${formatPositionMove(move)}</td>
                </tr>
                ${open ? `
                <tr class="team-details-row">
                    <td colspan="7">
                        <div class="team-details-container">${asIsPickDetail(picker.name)}</div>
                    </td>
                </tr>` : ''}
            `;
        }).join('');
        return;
    }

    // Playoffs uses a different table layout showing Line/SU/O/U breakdown
    if (category === 'playoffs') {
        // Update table title to explain combined scoring (only target the one in performance-insights)
        const tableTitle = setTitle
            ? document.querySelector('#performance-insights-section .standings-panel h3')
            : null;
        if (tableTitle) {
            tableTitle.innerHTML = 'Playoff Standings <span style="font-weight: normal; font-size: 0.85em; color: var(--text-secondary);">(Combined: Line + Straight Up + Over/Under)</span>';
        }

        thead.innerHTML = `
            <tr>
                <th>Picker</th>
                <th colspan="4" style="text-align: center; border-bottom: 2px solid var(--border-color);">Combined Record</th>
                <th colspan="3" style="text-align: center; border-bottom: 2px solid var(--border-color);">Breakdown</th>
            </tr>
            <tr>
                <th></th>
                <th>W</th>
                <th>L</th>
                <th>P</th>
                <th>%</th>
                <th>Line (ATS)</th>
                <th>Straight Up</th>
                <th>Over/Under</th>
            </tr>
        `;

        tbody.innerHTML = sorted.map((picker, index) => {
            const pct = typeof picker.percentage === 'number' ? picker.percentage.toFixed(1) + '%' : '-';
            return `
                <tr class="${index === 0 ? 'leader' : ''}">
                    <td class="picker-name">${picker.name}</td>
                    <td>${picker.wins || 0}</td>
                    <td>${picker.losses || 0}</td>
                    <td>${picker.pushes || 0}</td>
                    <td class="pct">${pct}</td>
                    <td>${picker.lineRecord || '-'}</td>
                    <td>${picker.suRecord || '-'}</td>
                    <td>${picker.ouRecord || '-'}</td>
                </tr>
            `;
        }).join('');
        return;
    }

    // Restore default table title for non-playoff tabs (only target the one in performance-insights)
    const tableTitle = setTitle
        ? document.querySelector('#performance-insights-section .standings-panel h3')
        : null;
    if (tableTitle) {
        tableTitle.textContent = 'Season Standings';
    }

    // Default table layout for other subcategories
    thead.innerHTML = `
        <tr>
            <th>Picker</th>
            <th>Win</th>
            <th>Loss</th>
            <th>Push</th>
            <th>%</th>
            <th>Total</th>
            <th>Last 3-Wk</th>
            <th>Best Week</th>
            <th>Year Chg</th>
        </tr>
    `;

    tbody.innerHTML = sorted.map((picker, index) => {
        const yearChange = picker.yearChange || '';
        let yearChangeClass = '';
        let yearChangeDisplay = yearChange;

        if (yearChange.includes('\u25b2') || yearChange.includes('+')) {
            yearChangeClass = 'positive';
        } else if (yearChange.includes('\u25bc') || yearChange.includes('-')) {
            yearChangeClass = 'negative';
        }
        // 'even' carries neither class: level is not a fall, and the legacy
        // workbook never produced the value so nothing covered it before.

        // Format percentages
        const pct = typeof picker.percentage === 'number' ? picker.percentage.toFixed(2) + '%' : picker.percentage || '-';
        const last3Wk = formatPercent(picker.last3WeekPct);
        const pctClass = pctCellClass(picker.percentage);

        // Determine push/draw label based on category
        const pushOrDraw = category === 'winner' ? picker.draws || 0 : picker.pushes || 0;

        return `
            <tr class="${index === 0 ? 'leader' : ''}">
                <td class="picker-name">${picker.name}</td>
                <td>${picker.wins || 0}</td>
                <td>${picker.losses || 0}</td>
                <td>${pushOrDraw}</td>
                <td class="${pctClass}">${pct}</td>
                <td>${picker.totalPicks || 0}</td>
                <td>${last3Wk}</td>
                <td class="best-week">${picker.bestWeek || '-'}</td>
                <td class="year-change ${yearChangeClass}">${yearChangeDisplay || '-'}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Render the playoff standings table with detailed breakdown
 */
function renderPlayoffStandingsTable(stats) {
    const table = document.getElementById('playoff-standings-table');
    const tbody = document.getElementById('playoff-standings-table-body');
    if (!tbody || !table) return;

    // Store stats for sorting
    table._playoffStats = stats;

    const sorted = getSortedPickers(stats);

    tbody.innerHTML = sorted.map((picker, index) => {
        const pctValue = typeof picker.percentage === 'number' ? picker.percentage : 0;
        const pct = typeof picker.percentage === 'number' ? picker.percentage.toFixed(1) + '%' : '-';

        const pctClass = pctCellClass(picker.percentage);

        // Calculate wins from records for sorting
        const lineWins = picker.lineWins || 0;
        const suWins = picker.suWins || 0;
        const ouWins = picker.ouWins || 0;

        return `
            <tr class="${index === 0 ? 'leader' : ''}" data-picker="${picker.name}">
                <td class="picker-name">${picker.name}</td>
                <td data-sort="${lineWins}">${picker.lineRecord || '-'}</td>
                <td data-sort="${suWins}">${picker.suRecord || '-'}</td>
                <td data-sort="${ouWins}">${picker.ouRecord || '-'}</td>
                <td class="divider-left" data-sort="${picker.wins || 0}">${picker.wins || 0}</td>
                <td data-sort="${picker.losses || 0}">${picker.losses || 0}</td>
                <td data-sort="${picker.pushes || 0}">${picker.pushes || 0}</td>
                <td class="${pctClass}" data-sort="${pctValue}">${pct}</td>
            </tr>
        `;
    }).join('');

    // Setup sortable headers (only once)
    if (!table._sortInitialized) {
        setupPlayoffTableSorting(table);
        table._sortInitialized = true;
    }
}

/**
 * Setup sorting for playoff standings table
 */
function setupPlayoffTableSorting(table) {
    const headers = table.querySelectorAll('thead th');

    headers.forEach((th, index) => {
        // Make headers look clickable
        th.style.cursor = 'pointer';
        th.title = 'Click to sort';

        th.addEventListener('click', () => {
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const isAscending = th.classList.contains('sort-asc');

            // Remove sort classes from all headers
            headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));

            // Sort rows
            rows.sort((a, b) => {
                const aCell = a.cells[index];
                const bCell = b.cells[index];

                // Use data-sort attribute if available, otherwise use text content
                let aVal = aCell.dataset.sort !== undefined ? parseFloat(aCell.dataset.sort) : aCell.textContent.trim();
                let bVal = bCell.dataset.sort !== undefined ? parseFloat(bCell.dataset.sort) : bCell.textContent.trim();

                // Handle string comparison for picker names
                if (index === 0) {
                    return isAscending ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                }

                // Numeric comparison
                if (isNaN(aVal)) aVal = 0;
                if (isNaN(bVal)) bVal = 0;

                return isAscending ? aVal - bVal : bVal - aVal;
            });

            // Toggle sort direction
            th.classList.add(isAscending ? 'sort-desc' : 'sort-asc');

            // Re-append sorted rows and update leader class
            rows.forEach((row, i) => {
                row.classList.remove('leader');
                if (i === 0) row.classList.add('leader');
                tbody.appendChild(row);
            });
        });
    });
}

/**
 * Calculate agreement percentage between two pickers for playoff picks
 * @param {string} picker1 - First picker name
 * @param {string} picker2 - Second picker name
 * @param {string} pickType - 'line', 'winner', 'overUnder', or 'all'
 * @returns {object} { agreement: number, total: number, agreed: number, picker1, picker2 }
 */
function calculatePlayoffAgreement(picker1, picker2, pickType = 'all') {
    let agreed = 0;
    let total = 0;

    for (let week = FIRST_PLAYOFF_WEEK; week <= LAST_PLAYOFF_WEEK; week++) {
        const weekStr = String(week);
        const weekGames = getGamesForWeekAndSeason(week, currentSeason);
        const seasonPicks = getPicksForWeekAndSeason(week, currentSeason);
        const weekPicks = seasonPicks || {};
        const cachedWeek = weeklyPicksCache[week] || weeklyPicksCache[weekStr];

        if (!weekGames || weekGames.length === 0) continue;

        const picks1 = weekPicks[picker1] || {};
        const picks2 = weekPicks[picker2] || {};
        const cachedPicks1 = cachedWeek?.picks?.[picker1] || {};
        const cachedPicks2 = cachedWeek?.picks?.[picker2] || {};

        weekGames.forEach(game => {
            const gamePicks1 = getPicksForGame(picks1, game);
            const gamePicks2 = getPicksForGame(picks2, game);
            const cachedGamePicks1 = getPicksForGame(cachedPicks1, game);
            const cachedGamePicks2 = getPicksForGame(cachedPicks2, game);

            // Check each pick type
            const pickTypes = pickType === 'all' ? ['line', 'winner', 'overUnder'] : [pickType];

            pickTypes.forEach(type => {
                const p1Pick = gamePicks1[type] || cachedGamePicks1[type];
                const p2Pick = gamePicks2[type] || cachedGamePicks2[type];

                // Only count if both pickers made a pick
                if (p1Pick && p2Pick) {
                    total++;
                    if (p1Pick === p2Pick) {
                        agreed++;
                    }
                }
            });
        });
    }

    return {
        agreement: total > 0 ? (agreed / total * 100) : 0,
        total,
        agreed,
        picker1,
        picker2
    };
}

/**
 * Generate the full agreement matrix for all picker pairs
 * @param {string} pickType - 'line', 'winner', 'overUnder', or 'all'
 * @returns {object} Matrix object with picker names as keys
 */
function generatePlayoffAgreementMatrix(pickType = 'all') {
    const matrix = {};

    PICKERS.forEach(picker1 => {
        matrix[picker1] = {};
        PICKERS.forEach(picker2 => {
            if (picker1 === picker2) {
                matrix[picker1][picker2] = { agreement: 100, total: 0, agreed: 0, self: true };
            } else {
                matrix[picker1][picker2] = calculatePlayoffAgreement(picker1, picker2, pickType);
            }
        });
    });

    return matrix;
}

/**
 * Get sorted list of picker pairs by similarity
 * @param {string} pickType - 'line', 'winner', 'overUnder', or 'all'
 * @returns {array} Array of agreement objects sorted by agreement descending
 */
function getPlayoffSimilarityRanking(pickType = 'all') {
    const pairs = [];
    const seen = new Set();

    PICKERS.forEach(picker1 => {
        PICKERS.forEach(picker2 => {
            if (picker1 === picker2) return;
            const pairKey = [picker1, picker2].sort().join('-');
            if (seen.has(pairKey)) return;
            seen.add(pairKey);

            pairs.push(calculatePlayoffAgreement(picker1, picker2, pickType));
        });
    });

    return pairs.sort((a, b) => b.agreement - a.agreement);
}

/**
 * Get all playoff picks organized by game
 * @returns {array} Array of game breakdown objects
 */
function getPlayoffGameBreakdown() {
    const breakdown = [];

    for (let week = FIRST_PLAYOFF_WEEK; week <= LAST_PLAYOFF_WEEK; week++) {
        const weekStr = String(week);
        const weekGames = getGamesForWeek(week);
        const weekPicks = allPicks[week] || allPicks[weekStr] || {};
        const cachedWeek = weeklyPicksCache[week] || weeklyPicksCache[weekStr];
        const weekName = PLAYOFF_WEEKS[week]?.name || `Week ${week}`;

        if (!weekGames || weekGames.length === 0) continue;

        weekGames.forEach(game => {
            const gameEntry = {
                game,
                week,
                weekName,
                picks: {},
                consensus: {
                    line: { away: 0, home: 0 },
                    winner: { away: 0, home: 0 },
                    overUnder: { over: 0, under: 0 }
                }
            };

            PICKERS.forEach(picker => {
                const pickerPicks = weekPicks[picker] || {};
                const cachedPicks = cachedWeek?.picks?.[picker] || {};
                const gamePicks = getPicksForGame(pickerPicks, game);
                const cachedGamePicks = getPicksForGame(cachedPicks, game);

                gameEntry.picks[picker] = {
                    line: gamePicks.line || cachedGamePicks.line || null,
                    winner: gamePicks.winner || cachedGamePicks.winner || null,
                    overUnder: gamePicks.overUnder || cachedGamePicks.overUnder || null
                };

                // Count for consensus
                if (gameEntry.picks[picker].line) {
                    gameEntry.consensus.line[gameEntry.picks[picker].line]++;
                }
                if (gameEntry.picks[picker].winner) {
                    gameEntry.consensus.winner[gameEntry.picks[picker].winner]++;
                }
                if (gameEntry.picks[picker].overUnder) {
                    gameEntry.consensus.overUnder[gameEntry.picks[picker].overUnder]++;
                }
            });

            breakdown.push(gameEntry);
        });
    }

    return breakdown;
}

/**
 * Render the agreement matrix table
 */
function renderPlayoffAgreementMatrix() {
    const selectEl = document.getElementById('agreement-pick-type');
    const pickType = selectEl?.value || 'all';
    const matrix = generatePlayoffAgreementMatrix(pickType);
    const ranking = getPlayoffSimilarityRanking(pickType);

    // Create a lookup for rank by picker pair
    const rankLookup = {};
    ranking.forEach((pair, index) => {
        const key1 = `${pair.picker1}-${pair.picker2}`;
        const key2 = `${pair.picker2}-${pair.picker1}`;
        rankLookup[key1] = index + 1;
        rankLookup[key2] = index + 1;
    });

    const thead = document.getElementById('agreement-matrix-header');
    const tbody = document.getElementById('agreement-matrix-body');
    if (!thead || !tbody) return;

    // Render header row
    thead.innerHTML = `
        <tr>
            <th></th>
            ${PICKERS.map(p => `<th>${p}</th>`).join('')}
        </tr>
    `;

    // Find the highest agreement (rank 1)
    const bestPairs = new Set();
    if (ranking.length > 0) {
        const bestAgreement = ranking[0].agreement;
        ranking.forEach(pair => {
            if (pair.agreement === bestAgreement) {
                bestPairs.add(`${pair.picker1}-${pair.picker2}`);
                bestPairs.add(`${pair.picker2}-${pair.picker1}`);
            }
        });
    }

    // Render matrix rows
    tbody.innerHTML = PICKERS.map(picker1 => {
        const cells = PICKERS.map(picker2 => {
            const data = matrix[picker1][picker2];
            if (data.self) {
                return `<td class="agreement-cell agreement-self">-</td>`;
            }
            const pct = data.agreement.toFixed(0);
            const pairKey = `${picker1}-${picker2}`;
            const rank = rankLookup[pairKey] || '-';
            const isBestMatch = bestPairs.has(pairKey);
            const cellClass = `agreement-cell${isBestMatch ? ' best-match' : ''}`;
            return `<td class="${cellClass}" data-picker1="${picker1}" data-picker2="${picker2}" data-rank="${rank}" data-agreed="${data.agreed}" data-total="${data.total}" data-pct="${pct}">${pct}%</td>`;
        }).join('');

        return `<tr><td>${picker1}</td>${cells}</tr>`;
    }).join('');

    // Add click handlers to cells
    tbody.querySelectorAll('.agreement-cell:not(.agreement-self)').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', showAgreementPopup);
    });
}

/**
 * Show popup with agreement details when cell is clicked
 */
function showAgreementPopup(e) {
    const cell = e.currentTarget;
    const picker1 = cell.dataset.picker1;
    const picker2 = cell.dataset.picker2;
    const rank = cell.dataset.rank;
    const agreed = cell.dataset.agreed;
    const total = cell.dataset.total;
    const pct = cell.dataset.pct;

    // Remove any existing popup
    const existingPopup = document.querySelector('.agreement-popup');
    if (existingPopup) {
        existingPopup.remove();
    }

    // Create popup
    const popup = document.createElement('div');
    popup.className = 'agreement-popup';
    popup.innerHTML = `
        <div class="agreement-popup-header">
            <strong>${picker1} & ${picker2}</strong>
            <button class="agreement-popup-close">&times;</button>
        </div>
        <div class="agreement-popup-content">
            <div class="agreement-popup-stat">
                <span class="agreement-popup-label">Agreement</span>
                <span class="agreement-popup-value">${pct}%</span>
            </div>
            <div class="agreement-popup-stat">
                <span class="agreement-popup-label">Picks Match</span>
                <span class="agreement-popup-value">${agreed}/${total}</span>
            </div>
            <div class="agreement-popup-stat">
                <span class="agreement-popup-label">Similarity Rank</span>
                <span class="agreement-popup-value">#${rank} of 10</span>
            </div>
        </div>
    `;

    document.body.appendChild(popup);

    // Position popup near the clicked cell
    const rect = cell.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - popupRect.width / 2;
    let top = rect.bottom + 8;

    // Keep popup within viewport
    if (left < 10) left = 10;
    if (left + popupRect.width > window.innerWidth - 10) {
        left = window.innerWidth - popupRect.width - 10;
    }
    if (top + popupRect.height > window.innerHeight - 10) {
        top = rect.top - popupRect.height - 8;
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    // Close button handler
    popup.querySelector('.agreement-popup-close').addEventListener('click', () => {
        popup.remove();
    });

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', function closePopup(e) {
            if (!popup.contains(e.target) && e.target !== cell) {
                popup.remove();
                document.removeEventListener('click', closePopup);
            }
        });
    }, 0);
}

/**
 * Render the similarity ranking cards
 */
function renderPlayoffSimilarityRanking() {
    const selectEl = document.getElementById('agreement-pick-type');
    const pickType = selectEl?.value || 'all';
    const ranking = getPlayoffSimilarityRanking(pickType);
    const container = document.getElementById('similarity-ranking');
    if (!container) return;

    container.innerHTML = ranking.map((pair, index) => {
        return `
            <div class="similarity-card">
                <span class="similarity-rank">${index + 1}.</span>
                <div class="similarity-pair">
                    <span class="similarity-pair-names">${pair.picker1} & ${pair.picker2}</span>
                    <span class="similarity-pair-detail">${pair.agreed}/${pair.total} picks match</span>
                </div>
                <span class="similarity-pct">${pair.agreement.toFixed(0)}%</span>
            </div>
        `;
    }).join('');
}

/**
 * Render the game-by-game breakdown tables
 */
function renderPlayoffGameBreakdown() {
    const container = document.getElementById('game-breakdown-container');
    if (!container) return;

    const breakdown = getPlayoffGameBreakdown();

    // Group by week
    const byWeek = {};
    breakdown.forEach(entry => {
        if (!byWeek[entry.week]) {
            byWeek[entry.week] = {
                weekName: entry.weekName,
                games: []
            };
        }
        byWeek[entry.week].games.push(entry);
    });

    if (Object.keys(byWeek).length === 0) {
        container.innerHTML = '<p class="no-data-message">No playoff picks data available yet.</p>';
        return;
    }

    container.innerHTML = Object.entries(byWeek).map(([week, data]) => {
        const gamesHtml = data.games.map(entry => {
            const game = entry.game;
            const gameLabel = `${game.away} @ ${game.home}`;
            const spreadLabel = game.spread ? `${game.favorite === 'away' ? game.away : game.home} -${game.spread}` : '-';

            // Determine consensus and lone wolves for line picks
            const lineConsensus = entry.consensus.line.away >= entry.consensus.line.home ? 'away' : 'home';
            const lineCounts = entry.consensus.line;
            const isLineUnanimous = lineCounts.away === PICKERS.length || lineCounts.home === PICKERS.length;

            const pickerCells = PICKERS.map(picker => {
                const pick = entry.picks[picker];
                let lineClass = 'pick-cell';
                let lineText = '-';

                if (pick.line) {
                    lineText = pick.line === 'away' ? game.away : game.home;
                    // Check if lone wolf (only one with this pick)
                    const count = lineCounts[pick.line];
                    if (count === 1) lineClass += ' lone-wolf';
                } else {
                    lineClass += ' no-pick';
                }

                return `<td class="${lineClass}">${lineText}</td>`;
            }).join('');

            // Consensus display
            const consensusText = lineCounts.away + lineCounts.home > 0
                ? `${lineConsensus === 'away' ? game.away : game.home} (${Math.max(lineCounts.away, lineCounts.home)}/${lineCounts.away + lineCounts.home})`
                : '-';
            const consensusClass = isLineUnanimous ? 'consensus-cell unanimous' : 'consensus-cell';

            return `
                <tr>
                    <td class="game-cell">${gameLabel}</td>
                    <td class="spread-cell">${spreadLabel}</td>
                    ${pickerCells}
                    <td class="${consensusClass}">${consensusText}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="game-breakdown-week">
                <div class="game-breakdown-week-header">${data.weekName}</div>
                <div class="game-breakdown-table-container">
                    <table class="game-breakdown-table">
                        <thead>
                            <tr>
                                <th>Game</th>
                                <th>Spread</th>
                                ${PICKERS.map(p => `<th>${p}</th>`).join('')}
                                <th>Consensus</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${gamesHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the complete playoff comparison section
 */
function renderPlayoffComparison() {
    const section = document.getElementById('playoff-comparison-section');
    if (!section) return;

    // Check if we have any playoff data
    let hasData = false;
    for (let week = FIRST_PLAYOFF_WEEK; week <= LAST_PLAYOFF_WEEK; week++) {
        const games = getGamesForWeek(week);
        if (games && games.length > 0) {
            hasData = true;
            break;
        }
    }

    if (!hasData) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    renderPlayoffAgreementMatrix();
    renderPlayoffGameBreakdown();
}

/**
 * Setup event listeners for playoff comparison controls
 */
function setupPlayoffComparisonControls() {
    const selectEl = document.getElementById('agreement-pick-type');
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            renderPlayoffAgreementMatrix();
        });
    }
}

/**
 * Render leaderboard cards
 */
function renderLeaderboard(stats) {
    const sorted = getSortedPickers(stats);

    // Standard grid layout for all categories (consistent styling)
    leaderboard.innerHTML = sorted.map((picker, index) => renderPickerCard(picker, index, false)).join('');
}

/**
 * Render the games list for picks
 */
function renderGames() {
    const gamesList = document.getElementById('games-list');
    if (!gamesList) return;

    updateBlazinProgress();

    let weekGames = getGamesForWeekAndSeason(currentWeek, currentSeason);
    const pickerPicks = getPickerPicksForWeek(currentWeek, currentPicker);
    // For historical seasons, all weeks are historical; for current season, check against CURRENT_NFL_WEEK
    const isHistoricalWeek = isHistoricalSeason() || currentWeek < CURRENT_NFL_WEEK;

    // Apply filter
    if (currentGameFilter !== 'all') {
        weekGames = weekGames.filter(game => {
            const liveData = getLiveGameStatus(game);
            const isFinal = (liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed)) || isHistoricalWeek;
            if (currentGameFilter === 'completed') return isFinal;
            if (currentGameFilter === 'upcoming') return !isFinal;
            return true;
        });
    }

    if (weekGames.length === 0) {
        const filterMessage = currentGameFilter === 'all' ? '' : ` (${currentGameFilter})`;
        const isPlayoff = isPlayoffWeek(currentWeek);
        const weekName = isPlayoff ? getWeekDisplayName(currentWeek) : `Week ${getWeekDisplayName(currentWeek)}`;
        const subtitle = currentGameFilter !== 'all'
            ? 'Try changing the filter above.'
            : (isPlayoff ? 'Playoff games will appear once the schedule is available.' : 'Game data can be added to NFL_GAMES_BY_WEEK in app.js');
        gamesList.innerHTML = `
            <div class="no-games-message">
                <p>No games${filterMessage} for ${weekName}.</p>
                <p class="no-games-subtitle">${subtitle}</p>
            </div>
        `;
        return;
    }

    // Count current blazin picks for the week (only for regular season)
    const isPlayoff = isPlayoffWeek(currentWeek);
    const blazinCount = countBlazinPicks(currentWeek, currentPicker);

    gamesList.innerHTML = weekGames.map(game => {
        // The storage key travels with the markup (data-pick-key) so click
        // handlers never have to re-derive it from the positional game id.
        const key = pickKey(game);
        const gamePicks = getPicksForGame(pickerPicks, game);
        const linePick = gamePicks.line;
        const winnerPick = gamePicks.winner;
        const isBlazin = gamePicks.blazin || false;
        // Truthiness, not !== undefined: picks restored from the sheet backup
        // carry every field as '' rather than omitting it, so an undefined
        // check counts a blank as a real pick and enables the B5 star.
        const hasLinePick = Boolean(linePick);
        const hasWinnerPick = Boolean(winnerPick);
        const hasBothPicks = hasLinePick && hasWinnerPick;

        // Get live score data if available
        const liveData = getLiveGameStatus(game);
        const isInProgress = liveData && LIVE_IN_PROGRESS_STATUSES.includes(liveData.status);
        const isFinal = liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed);

        // Game is locked if: isGameLocked returns true OR game is final from live data
        const locked = isGameLocked(game) || isFinal;

        // Frozen state. "Frozen" is a pre-kickoff choice by the picker; "locked"
        // is the game having started. A frozen card is read-only either way.
        const frozen = isPickFrozen(gamePicks);
        const readOnly = locked || frozen;
        const frozenLineLabel = frozen
            ? describeLineForSide(
                { ...game, spread: gamePicks.frozenSpread, favorite: gamePicks.frozenFavorite }, linePick)
            : '';
        const freezeState = (locked || frozen || isHistoricalWeek || isHistoricalSeason())
            ? null
            : freezeEligibility(game, currentWeek, currentPicker);

        // Line drift, for a riding pick whose line has moved since it was made.
        const ridingDrift = (!frozen && !locked && hasLinePick
                && hasUsableLine(gamePicks.pickedSpread) && hasUsableSpread(game)
                && (Number(gamePicks.pickedSpread) !== Number(game.spread)
                    || gamePicks.pickedFavorite !== game.favorite))
            ? describeLineForSide(
                { ...game, spread: gamePicks.pickedSpread, favorite: gamePicks.pickedFavorite }, linePick)
            : '';

        // Show loading indicator if spread is missing and still loading
        const spreadMissing = !hasUsableSpread(game);
        const awaySpreadDisplay = signedSpreadDisplay(game, 'away');
        const homeSpreadDisplay = signedSpreadDisplay(game, 'home');
        // For game matchup line, show spread in parentheses only if available
        const awaySpreadWithParens = spreadMissing
            ? (spreadsLoading ? '<span class="spread-loading"></span>' : '')
            : `(${awaySpreadDisplay})`;
        const homeSpreadWithParens = spreadMissing
            ? (spreadsLoading ? '<span class="spread-loading"></span>' : '')
            : `(${homeSpreadDisplay})`;

        // Calculate pick results for completed games
        const gameCompleted = isFinal || isHistoricalWeek;
        let lineAwayResult = '', lineHomeResult = '', winnerAwayResult = '', winnerHomeResult = '';
        if (gameCompleted) {
            // Use live data for final games, fall back to historical results
            let result = getResultsForWeek(currentWeek)[game.id];
            if (!result && liveData && isFinal) {
                // Build result from live data for games that just finished
                result = {
                    winner: liveData.homeScore > liveData.awayScore ? 'home' : 'away',
                    homeScore: liveData.homeScore,
                    awayScore: liveData.awayScore
                };
            }
            if (result) {
                // The current picker's own line, so a frozen card shows the
                // outcome it was actually graded at. Left blank while there is
                // no usable line, rather than marked as a push.
                const atsWinner = atsWinnerForPick(game, gamePicks, result);
                if (linePick === 'away' && atsWinner) {
                    lineAwayResult = atsWinner === 'push' ? 'push' : (atsWinner === 'away' ? 'correct' : 'incorrect');
                }
                if (linePick === 'home' && atsWinner) {
                    lineHomeResult = atsWinner === 'push' ? 'push' : (atsWinner === 'home' ? 'correct' : 'incorrect');
                }
                // Winner pick results
                if (winnerPick === 'away') {
                    winnerAwayResult = result.winner === 'away' ? 'correct' : 'incorrect';
                }
                if (winnerPick === 'home') {
                    winnerHomeResult = result.winner === 'home' ? 'correct' : 'incorrect';
                }
            }
        }

        // Over/Under pick data (for playoffs)
        const ouPick = gamePicks.overUnder;
        const ouLine = game.overUnder || gamePicks.totalLine || 0;
        let ouOverResult = '', ouUnderResult = '';
        if (isPlayoff && gameCompleted && ouPick && ouLine > 0) {
            const result = getResultsForWeek(currentWeek)[game.id] || (liveData && isFinal ? {
                awayScore: liveData.awayScore,
                homeScore: liveData.homeScore
            } : null);
            if (result) {
                const totalScore = (result.awayScore || 0) + (result.homeScore || 0);
                const ouResult = totalScore > ouLine ? 'over' : (totalScore < ouLine ? 'under' : 'push');
                if (ouPick === 'over') {
                    ouOverResult = ouResult === 'push' ? 'push' : (ouResult === 'over' ? 'correct' : 'incorrect');
                }
                if (ouPick === 'under') {
                    ouUnderResult = ouResult === 'push' ? 'push' : (ouResult === 'under' ? 'correct' : 'incorrect');
                }
            }
        }

        const cardClasses = [
            'game-card',
            hasBothPicks ? 'has-pick' : (hasLinePick || hasWinnerPick ? 'has-partial-pick' : ''),
            locked ? 'game-locked' : '',
            frozen ? 'pick-frozen' : '',
            isFinal ? 'game-final' : '',
            isInProgress ? 'game-in-progress' : ''
        ].filter(Boolean).join(' ');

        // Build status badge
        let statusBadge = '';
        if (isFinal || isHistoricalWeek) {
            statusBadge = `<span class="status-badge final">FINAL</span>`;
        } else if (isInProgress) {
            const clockDisplay = liveClockLabel(liveData);
            statusBadge = `<span class="status-badge in-progress">${liveData.awayScore} - ${liveData.homeScore} (${clockDisplay})</span>`;
        } else if (locked) {
            statusBadge = '<span class="locked-badge">LOCKED</span>';
        }

        // Build lock countdown for unlocked games or final score for completed games
        let gameStatusDisplay = '';
        const historicalResult = getResultsForWeek(currentWeek)[game.id];
        const scoreData = liveData || historicalResult;
        if (gameCompleted && scoreData) {
            const awayScore = scoreData.awayScore ?? '';
            const homeScore = scoreData.homeScore ?? '';
            const awayWon = awayScore > homeScore;
            const homeWon = homeScore > awayScore;
            gameStatusDisplay = `
                <div class="game-final-score">
                    <span class="final-score-team ${awayWon ? 'winner' : ''}">
                        <span class="final-team-name">${game.away}</span>
                        <span class="final-team-score">${awayScore}</span>
                    </span>
                    <span class="final-score-divider">-</span>
                    <span class="final-score-team ${homeWon ? 'winner' : ''}">
                        <span class="final-team-score">${homeScore}</span>
                        <span class="final-team-name">${game.home}</span>
                    </span>
                </div>`;
        }

        // Blazin star button - disabled if locked, no line pick, or already at 5 and not already selected
        const canToggleBlazin = !readOnly && hasLinePick && (isBlazin || blazinCount < MAX_BLAZIN_PICKS);
        const blazinDisabled = readOnly || !hasLinePick || (!isBlazin && blazinCount >= MAX_BLAZIN_PICKS);
        const blazinTitle = blazinDisabled
            ? (frozen ? 'Pick is frozen'
                : locked ? 'Game is locked'
                : !hasLinePick ? 'Make a line pick first'
                : `Maximum ${MAX_BLAZIN_PICKS} Blazin picks reached`)
            : (isBlazin ? 'Remove from Blazin 5' : 'Add to Blazin 5');

        return `
            <div class="${cardClasses}" data-game-id="${game.id}" data-kickoff="${game.kickoff || ''}">
                <div class="game-header">
                    <span class="game-time">${game.time}</span>
                    ${statusBadge}
                    <span class="game-day">${game.day}</span>
                </div>
                ${gameStatusDisplay}

                <div class="game-matchup-line">
                    <span class="away-team">
                        <img src="${getTeamLogo(game.away)}" alt="${game.away} logo" class="team-logo" onerror="handleLogoError(this, '${game.away}')">
                        ${game.away} ${awaySpreadWithParens}
                    </span>
                    <span class="at-symbol">@</span>
                    <span class="home-team">
                        <img src="${getTeamLogo(game.home)}" alt="${game.home} logo" class="team-logo" onerror="handleLogoError(this, '${game.home}')">
                        ${game.home} ${homeSpreadWithParens}
                    </span>
                </div>

                <div class="picks-row">
                    <div class="pick-type">
                        <span class="pick-label">Line Pick (ATS)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${linePick === 'away' ? 'selected' : ''} ${lineAwayResult}"
                                    data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="line" data-team="away"
                                    ${readOnly ? 'disabled' : ''}>
                                ${game.away} ${awaySpreadDisplay}
                            </button>
                            <button class="pick-btn ${linePick === 'home' ? 'selected' : ''} ${lineHomeResult}"
                                    data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="line" data-team="home"
                                    ${readOnly ? 'disabled' : ''}>
                                ${game.home} ${homeSpreadDisplay}
                            </button>
                        </div>
                    </div>
                    <div class="pick-type">
                        <span class="pick-label">Straight Up (Winner)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${winnerPick === 'away' ? 'selected' : ''} ${winnerAwayResult}"
                                    data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="winner" data-team="away"
                                    ${readOnly ? 'disabled' : ''}>
                                ${game.away}
                            </button>
                            <button class="pick-btn ${winnerPick === 'home' ? 'selected' : ''} ${winnerHomeResult}"
                                    data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="winner" data-team="home"
                                    ${readOnly ? 'disabled' : ''}>
                                ${game.home}
                            </button>
                        </div>
                    </div>
                </div>

                <div class="game-footer">
                    <div class="game-location">
                        <span class="location-city">${game.location}</span>
                        <span class="location-stadium">${game.stadium}</span>
                    </div>
                    ${frozen ? `
                        <span class="freeze-state frozen" title="Locked at ${frozenLineLabel}">
                            Locked
                        </span>
                    ` : (ridingDrift ? `
                        <span class="freeze-state drifted" title="You picked ${ridingDrift}; the line has since moved">
                            Picked at ${ridingDrift} &rarr; now ${describeLineForSide(game, linePick)}
                        </span>
                    ` : '')}
                    ${freezeState ? `
                        <button class="freeze-btn" data-game-id="${game.id}" data-pick-key="${key}"
                                ${freezeState.canFreeze ? '' : 'disabled'}
                                title="${freezeState.canFreeze ? `Lock this pick at ${describeLineForSide(game, linePick)} - the game becomes final` : freezeState.reason}">
                            Lock Pick
                        </button>
                    ` : ''}
                    ${isPlayoff ? `
                        <div class="ou-picker" data-game-id="${game.id}">
                            <span class="ou-label">O/U ${ouLine > 0 ? ouLine : 'TBD'}</span>
                            ${ouLine > 0 ? `
                                <button class="ou-btn ${ouPick === 'over' ? 'selected' : ''} ${ouOverResult}"
                                        data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="overUnder" data-value="over"
                                        ${readOnly ? 'disabled' : ''}>
                                    Over
                                </button>
                                <button class="ou-btn ${ouPick === 'under' ? 'selected' : ''} ${ouUnderResult}"
                                        data-game-id="${game.id}" data-pick-key="${key}" data-pick-type="overUnder" data-value="under"
                                        ${readOnly ? 'disabled' : ''}>
                                    Under
                                </button>
                            ` : '<span class="ou-unavailable">Line TBD</span>'}
                        </div>
                    ` : `
                        <button class="blazin-star ${isBlazin ? 'active' : ''}"
                                data-game-id="${game.id}" data-pick-key="${key}"
                                ${blazinDisabled ? 'disabled' : ''}
                                title="${blazinTitle}">
                            <span class="blazin-label">B5</span>${isBlazin ? '★' : '☆'}
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers for pick buttons
    document.querySelectorAll('.pick-btn').forEach(btn => {
        btn.addEventListener('click', handlePickSelect);
    });

    // Add click handlers for blazin star buttons
    document.querySelectorAll('.freeze-btn').forEach(btn => {
        btn.addEventListener('click', handleFreezeClick);
    });

    document.querySelectorAll('.blazin-star').forEach(btn => {
        btn.addEventListener('click', handleBlazinToggle);
    });

    // Add click handlers for O/U buttons (playoffs)
    document.querySelectorAll('.ou-btn').forEach(btn => {
        btn.addEventListener('click', handleOUSelect);
    });

    // Setup keyboard navigation
    setupKeyboardNavigation();

    // Cowherd's entry panel is keyed to the same week and schedule, so it is
    // redrawn here rather than needing its own week-change hook.
    renderCowherdPanel();

    // Start countdown timer
    startCountdownTimer();
}

/**
 * Setup keyboard navigation for games list
 */
function setupKeyboardNavigation() {
    const gameCards = document.querySelectorAll('.game-card');
    if (gameCards.length === 0) return;

    // Make first game card focusable
    gameCards.forEach((card, idx) => {
        card.setAttribute('tabindex', idx === 0 ? '0' : '-1');
        card.dataset.gameIndex = idx;
    });

    // Add keyboard event listener to games list
    const gamesList = document.getElementById('games-list');
    if (!gamesList) return;

    gamesList.addEventListener('keydown', handleGameKeydown);
}

/**
 * Handle keyboard navigation in games list
 */
function handleGameKeydown(e) {
    const gameCards = Array.from(document.querySelectorAll('.game-card'));
    const focusedCard = document.activeElement.closest('.game-card');

    if (!focusedCard || !gameCards.includes(focusedCard)) return;

    const currentIndex = parseInt(focusedCard.dataset.gameIndex);
    const gameId = focusedCard.dataset.gameId;

    switch (e.key) {
        case 'ArrowUp':
            e.preventDefault();
            if (currentIndex > 0) {
                focusGameCard(gameCards[currentIndex - 1]);
            }
            break;

        case 'ArrowDown':
            e.preventDefault();
            if (currentIndex < gameCards.length - 1) {
                focusGameCard(gameCards[currentIndex + 1]);
            }
            break;

        case '1':
        case 'a':
        case 'A':
            // Select away team for line pick
            e.preventDefault();
            simulatePickClick(gameId, 'line', 'away');
            break;

        case '2':
        case 'h':
        case 'H':
            // Select home team for line pick
            e.preventDefault();
            simulatePickClick(gameId, 'line', 'home');
            break;

        case '3':
            // Select away team for winner pick
            e.preventDefault();
            simulatePickClick(gameId, 'winner', 'away');
            break;

        case '4':
            // Select home team for winner pick
            e.preventDefault();
            simulatePickClick(gameId, 'winner', 'home');
            break;
    }
}

/**
 * Focus a game card and update tabindex
 */
function focusGameCard(card) {
    document.querySelectorAll('.game-card').forEach(c => {
        c.setAttribute('tabindex', '-1');
    });
    card.setAttribute('tabindex', '0');
    card.focus();
}

/**
 * Simulate a pick button click
 */
function simulatePickClick(gameId, pickType, team) {
    const btn = document.querySelector(
        `.pick-btn[data-game-id="${gameId}"][data-pick-type="${pickType}"][data-team="${team}"]`
    );
    if (btn && !btn.disabled) {
        btn.click();
    }
}

// Track last selected pick for animation
let lastSelectedPick = null;

/**
 * Handle pick selection (line or winner)
 */
function handlePickSelect(e) {
    e.preventDefault();
    e.stopPropagation();

    // Block edits for historical seasons
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return;
    }

    // Require a picker to be selected before making picks
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId;   // DOM addressing only - never a storage key
    const key = btn.dataset.pickKey;     // storage key, rendered onto the card
    const pickType = btn.dataset.pickType; // 'line' or 'winner'
    const team = btn.dataset.team; // 'away' or 'home'

    if (!key) return;

    // The game object is still needed for the "picked the favorite" auto-winner rule
    const weekGames = getGamesForWeek(currentWeek);
    const game = weekGames.find(g => String(g.id) === gameId);

    // Ensure week and picker structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    // Initialize game picks object if needed
    if (!allPicks[currentWeek][currentPicker][key]) {
        allPicks[currentWeek][currentPicker][key] = {};
    }

    // Get current selection state
    const currentSelection = allPicks[currentWeek][currentPicker][key][pickType];
    const isDeselecting = currentSelection === team;
    const otherTeam = team === 'home' ? 'away' : 'home';
    let autoSelectWinner = false;

    // Toggle selection
    if (isDeselecting) {
        delete allPicks[currentWeek][currentPicker][key][pickType];

        // Clean up a game object that holds no actual picks any more. Checking
        // for real pick fields rather than an empty object matters because
        // pickedSpread/pickedFavorite are bookkeeping, not picks - left behind
        // they would keep a fully deselected game looking like a picked one.
        const remaining = allPicks[currentWeek][currentPicker][key];
        const stillPicked = remaining.line || remaining.winner
            || remaining.overUnder || remaining.blazin;
        if (!stillPicked) {
            delete allPicks[currentWeek][currentPicker][key];
        }
    } else {
        allPicks[currentWeek][currentPicker][key][pickType] = team;

        // Remember the line this pick was made at. Display only - a riding pick
        // is still graded against the current line - but without it there is no
        // way to show a player that the line has moved under them.
        if (pickType === 'line' && hasUsableSpread(game)) {
            allPicks[currentWeek][currentPicker][key].pickedSpread = Number(game.spread);
            allPicks[currentWeek][currentPicker][key].pickedFavorite = game.favorite;
        }

        // If picking a favorite on the line, automatically pick them to win
        if (pickType === 'line') {
            if (game && game.favorite === team) {
                // Picked the favorite to cover, auto-select them as winner
                allPicks[currentWeek][currentPicker][key].winner = team;
                autoSelectWinner = true;
            }
        }
    }

    // Clear the "intentionally cleared" flag since user is making new picks
    // This allows future backup restores
    if (clearedPicks[currentWeek]?.[currentPicker]) {
        delete clearedPicks[currentWeek][currentPicker];
        localStorage.setItem(CLEARED_PICKS_KEY, JSON.stringify(clearedPicks));
    }

    // Save to localStorage. The debounced sync reads the flag deleted just
    // above, so it carries the lift to the sheet with the picks.
    savePicksToStorage();

    // Check if all picks are complete for the week (only when making a pick, not deselecting)
    if (!isDeselecting) {
        checkAllPicksComplete();
    }

    // Update only the relevant buttons instead of re-rendering all games
    // Deselect the other team's button in the same row
    const otherBtn = document.querySelector(`.pick-btn[data-game-id="${gameId}"][data-pick-type="${pickType}"][data-team="${otherTeam}"]`);
    if (otherBtn) {
        otherBtn.classList.remove('selected');
    }

    // Toggle the clicked button
    if (isDeselecting) {
        btn.classList.remove('selected');
    } else {
        btn.classList.add('selected');
        btn.classList.add('just-selected');
        setTimeout(() => btn.classList.remove('just-selected'), 400);
    }

    // Handle auto-selection of winner button
    if (autoSelectWinner) {
        const winnerBtn = document.querySelector(`.pick-btn[data-game-id="${gameId}"][data-pick-type="winner"][data-team="${team}"]`);
        const otherWinnerBtn = document.querySelector(`.pick-btn[data-game-id="${gameId}"][data-pick-type="winner"][data-team="${otherTeam}"]`);
        if (winnerBtn) {
            winnerBtn.classList.add('selected');
        }
        if (otherWinnerBtn) {
            otherWinnerBtn.classList.remove('selected');
        }
    }

    // Update Blazin' 5 star buttons (enable/disable based on line picks)
    updateBlazinStarStates();
    updateFreezeControls();

    // Update scoring summary
    renderScoringSummary();
}

/**
 * Refresh the Lock Pick buttons in place.
 *
 * renderGames works out each button's state once, when the card is drawn, and
 * handlePickSelect deliberately does NOT re-render - it updates the individual
 * buttons it touched. So without this a Lock button keeps whatever state it had
 * at draw time: completing a card leaves it stuck disabled, and emptying one
 * leaves it stuck enabled.
 *
 * Starring a game can change OTHER cards' eligibility too, via the Blazin'
 * allocation guard, so every button is recomputed rather than just one.
 */
function updateFreezeControls() {
    const buttons = document.querySelectorAll('.freeze-btn');
    if (buttons.length === 0) return;

    const weekGames = getGamesForWeek(currentWeek);
    const pickerPicks = getPickerPicksForWeek(currentWeek, currentPicker);
    buttons.forEach(btn => {
        const game = weekGames.find(g => pickKey(g) === btn.dataset.pickKey);
        if (!game) return;

        const { canFreeze, reason } = freezeEligibility(game, currentWeek, currentPicker);
        btn.disabled = !canFreeze;
        btn.title = canFreeze
            ? `Lock this pick at ${describeLineForSide(game, getPicksForGame(pickerPicks, game).line)} - the game becomes final`
            : reason;
    });
}

/**
 * Enable/disable every Blazin' 5 star for the current picker, based on the
 * 5-pick cap, whether the game has a line pick, and whether it is locked.
 * Reads picks by data-pick-key so it stays in step with how they are stored.
 */
function updateBlazinStarStates() {
    const pickerPicks = getPickerPicksForWeek(currentWeek, currentPicker);
    const blazinCount = countBlazinPicks(currentWeek, currentPicker);

    updateBlazinProgress();

    document.querySelectorAll('.blazin-star').forEach(starBtn => {
        const isActive = starBtn.classList.contains('active');
        const gameCard = starBtn.closest('.game-card');
        const isLocked = gameCard && gameCard.classList.contains('game-locked');
        const starGamePicks = pickerPicks[starBtn.dataset.pickKey] || {};
        const hasStarLinePick = Boolean(starGamePicks.line);

        if (isLocked) {
            starBtn.disabled = true;
            starBtn.title = 'Game is locked';
        } else if (!hasStarLinePick && !isActive) {
            starBtn.disabled = true;
            starBtn.title = 'Make a line pick first';
        } else if (isActive) {
            starBtn.disabled = false;
            starBtn.title = 'Remove from Blazin 5';
        } else {
            starBtn.disabled = blazinCount >= 5;
            starBtn.title = blazinCount >= 5 ? 'Maximum 5 Blazin picks reached' : 'Add to Blazin 5';
        }
    });
}

// Track if we've already shown the "all picks complete" message for this week/picker
let allPicksCompleteShown = {};

/**
 * Check if all picks are complete for the current week and show confirmation
 */
function checkAllPicksComplete() {
    const weekGames = getGamesForWeek(currentWeek);
    if (!weekGames || weekGames.length === 0) return;

    const pickerPicks = allPicks[currentWeek]?.[currentPicker] || {};
    const key = `${currentWeek}-${currentPicker}`;

    // Count games with complete picks (both line and winner)
    let completeCount = 0;
    for (const game of weekGames) {
        const gamePicks = getPicksForGame(pickerPicks, game);
        if (gamePicks.line && gamePicks.winner) {
            completeCount++;
        }
    }

    // Check if all games are complete
    if (completeCount === weekGames.length) {
        // Only show the message once per week/picker combination
        if (!allPicksCompleteShown[key]) {
            allPicksCompleteShown[key] = true;
            showToast(`All ${weekGames.length} picks saved!`, 'success');
        }
    } else {
        // Reset the flag if picks become incomplete (user deselected something)
        allPicksCompleteShown[key] = false;
    }
}

/**
 * Handle Over/Under pick selection (playoffs)
 */
function handleOUSelect(e) {
    e.preventDefault();
    e.stopPropagation();

    // Block edits for historical seasons
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return;
    }

    // Require a picker to be selected before making picks
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId;   // DOM addressing only
    const key = btn.dataset.pickKey;     // storage key, rendered onto the card
    const value = btn.dataset.value; // 'over' or 'under'

    if (!key || btn.disabled) return;

    // The game object is still needed to record the O/U line at time of pick
    const weekGames = getGamesForWeek(currentWeek);
    const game = weekGames.find(g => String(g.id) === gameId);

    // Initialize picks structure
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }
    if (!allPicks[currentWeek][currentPicker][key]) {
        allPicks[currentWeek][currentPicker][key] = {};
    }

    // Get current selection
    const currentSelection = allPicks[currentWeek][currentPicker][key].overUnder;
    const isDeselecting = currentSelection === value;

    // Toggle selection
    if (isDeselecting) {
        delete allPicks[currentWeek][currentPicker][key].overUnder;
        delete allPicks[currentWeek][currentPicker][key].totalLine;
    } else {
        allPicks[currentWeek][currentPicker][key].overUnder = value;
        // Store the line at time of pick
        if (game && game.overUnder) {
            allPicks[currentWeek][currentPicker][key].totalLine = game.overUnder;
        }
    }

    // Save to localStorage
    savePicksToStorage();

    // Update button states
    const otherValue = value === 'over' ? 'under' : 'over';
    const otherBtn = document.querySelector(`.ou-btn[data-game-id="${gameId}"][data-value="${otherValue}"]`);
    if (otherBtn) {
        otherBtn.classList.remove('selected');
    }

    if (isDeselecting) {
        btn.classList.remove('selected');
    } else {
        btn.classList.add('selected');
        btn.classList.add('just-selected');
        setTimeout(() => btn.classList.remove('just-selected'), 400);
    }

    // An O/U pick is part of a complete card in the playoffs, so it can change
    // whether this game may be locked.
    updateFreezeControls();

    // Update scoring summary
    renderScoringSummary();
}

/**
 * Handle Blazin' 5 star toggle
 */
/** Freeze button on a game card. */
function handleFreezeClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.currentTarget;
    if (btn.disabled) return;

    const key = btn.dataset.pickKey;
    if (key) freezeGameByKey(key);
}

function handleBlazinToggle(e) {
    e.preventDefault();
    e.stopPropagation();

    // Block edits for historical seasons
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return;
    }

    // Require a picker to be selected before making picks
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const btn = e.currentTarget;
    // Must be the same key handlePickSelect writes the line pick under, or the
    // star lands on a separate entry and is lost on the next render.
    const key = btn.dataset.pickKey;

    if (!key || btn.disabled) return;

    // Initialize picks structure
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }
    if (!allPicks[currentWeek][currentPicker][key]) {
        allPicks[currentWeek][currentPicker][key] = {};
    }

    // Toggle blazin status
    const currentBlazin = allPicks[currentWeek][currentPicker][key].blazin || false;
    const newBlazin = !currentBlazin;
    allPicks[currentWeek][currentPicker][key].blazin = newBlazin;

    // Update just this button
    btn.classList.toggle('active', newBlazin);
    btn.innerHTML = `<span class="blazin-label">B5</span>${newBlazin ? '★' : '☆'}`;
    btn.title = newBlazin ? 'Remove from Blazin 5' : 'Add to Blazin 5';

    // The fifth star: keep the tally in view a while as confirmation before it
    // stops following the picker down the page. See updateBlazinProgress.
    if (newBlazin && blazinRemaining() === 0) {
        noteBlazinCompleted();
    }

    // Enable/disable the other star buttons based on the new count
    updateBlazinStarStates();
    // A star can make another card ineligible via the Blazin' allocation guard.
    updateFreezeControls();

    // Save to localStorage
    savePicksToStorage();
}

// ============================================
// PATTERN INSIGHTS ENGINE
// ============================================

/**
 * Check if a game is a primetime game (Thursday, Monday, or Sunday Night)
 */
function isPrimetimeGame(game) {
    if (!game.day || !game.time) return false;
    // Thursday Night Football
    if (game.day === 'Thursday') return true;
    // Monday Night Football
    if (game.day === 'Monday') return true;
    // Sunday Night Football (8:15 PM or 8:20 PM ET)
    if (game.day === 'Sunday' && game.time && game.time.includes('8:')) return true;
    // Saturday primetime (late games)
    if (game.day === 'Saturday' && game.time && game.time.includes('8:')) return true;
    return false;
}

/**
 * Pattern Detection Engine
 * Detects interesting picking patterns for analysis
 */
const PatternEngine = {
    /**
     * Detect all patterns for all pickers
     */
    detectAllPatterns: function() {
        const patterns = {};
        PICKERS.forEach(picker => {
            patterns[picker] = this.detectPatternsForPicker(picker);
        });
        return patterns;
    },

    /**
     * Detect patterns for a single picker
     */
    detectPatternsForPicker: function(picker) {
        return {
            teamPatterns: this.detectTeamPatterns(picker),
            primetimePattern: this.detectPrimetimePattern(picker)
        };
    },

    /**
     * Detect team-specific patterns
     * Returns patterns for each team the picker has picked
     */
    detectTeamPatterns: function(picker) {
        const teamStats = {}; // { teamName: { wins, losses, pushes, games: [] } }

        // Iterate through all weeks
        for (let week = 1; week <= TOTAL_WEEKS; week++) {
            const games = getGamesForWeek(week);
            const results = getResultsForWeek(week);
            const weekPicks = allPicks[week] && allPicks[week][picker];

            if (!games || !results || !weekPicks) continue;

            games.forEach(game => {
                const pick = getPicksForGame(weekPicks, game);
                if (!pick || !pick.line) return;

                const result = results[game.id];
                if (!result) return;

                const atsResult = atsWinnerForPick(game, pick, result);
                if (!atsResult) return;

                // Determine which team was picked
                const pickedTeam = pick.line === 'away' ? game.away : game.home;
                const normalizedTeam = TEAM_NAME_MAP[pickedTeam] || pickedTeam;

                if (!teamStats[normalizedTeam]) {
                    teamStats[normalizedTeam] = { wins: 0, losses: 0, pushes: 0, games: [] };
                }

                const outcome = pick.line === atsResult ? 'win' : (atsResult === 'push' ? 'push' : 'loss');
                if (outcome === 'win') teamStats[normalizedTeam].wins++;
                else if (outcome === 'loss') teamStats[normalizedTeam].losses++;
                else teamStats[normalizedTeam].pushes++;

                teamStats[normalizedTeam].games.push({
                    week,
                    gameId: game.id,
                    away: game.away,
                    home: game.home,
                    spread: game.spread,
                    favorite: game.favorite,
                    pick: pick.line,
                    outcome
                });
            });
        }

        // Convert to pattern objects
        const patterns = [];
        Object.keys(teamStats).forEach(team => {
            const stats = teamStats[team];
            const total = stats.wins + stats.losses + stats.pushes;
            const percentage = total > 0 ? (stats.wins / (stats.wins + stats.losses || 1)) * 100 : 0;

            // Determine if interesting (min 3 games, notable deviation from 50%)
            const isInteresting = total >= 3 && (
                percentage <= 35 ||
                percentage >= 65 ||
                stats.wins === 0 ||
                stats.losses === 0
            );

            let sentiment = 'neutral';
            if (percentage < 40) sentiment = 'negative';
            else if (percentage > 60) sentiment = 'positive';

            // Generate headline
            let headline = `${picker} is ${stats.wins}-${stats.losses}`;
            if (stats.pushes > 0) headline += `-${stats.pushes}`;
            headline += ` picking ${team}`;

            patterns.push({
                id: `${picker.toLowerCase()}_team_${team.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                type: 'team',
                picker,
                team,
                wins: stats.wins,
                losses: stats.losses,
                pushes: stats.pushes,
                total,
                percentage: Math.round(percentage),
                headline,
                sentiment,
                isInteresting,
                context: { team },
                relevantTeams: [team]
            });
        });

        return patterns.sort((a, b) => b.total - a.total);
    },

    /**
     * Detect primetime performance pattern
     */
    detectPrimetimePattern: function(picker) {
        let wins = 0, losses = 0, pushes = 0;
        const games = [];

        // Iterate through all weeks
        for (let week = 1; week <= TOTAL_WEEKS; week++) {
            const weekGames = getGamesForWeek(week);
            const results = getResultsForWeek(week);
            const weekPicks = allPicks[week] && allPicks[week][picker];

            if (!weekGames || !results || !weekPicks) continue;

            weekGames.forEach(game => {
                if (!isPrimetimeGame(game)) return;

                const pick = getPicksForGame(weekPicks, game);
                if (!pick || !pick.line) return;

                const result = results[game.id];
                if (!result) return;

                const atsResult = atsWinnerForPick(game, pick, result);
                if (!atsResult) return;

                const outcome = pick.line === atsResult ? 'win' : (atsResult === 'push' ? 'push' : 'loss');
                if (outcome === 'win') wins++;
                else if (outcome === 'loss') losses++;
                else pushes++;

                games.push({
                    week,
                    gameId: game.id,
                    away: game.away,
                    home: game.home,
                    day: game.day,
                    time: game.time,
                    pick: pick.line,
                    outcome
                });
            });
        }

        const total = wins + losses + pushes;
        const percentage = total > 0 ? (wins / (wins + losses || 1)) * 100 : 0;

        // Interesting if 5+ games and deviation > 15% from 50%
        const isInteresting = total >= 5 && Math.abs(50 - percentage) > 15;

        let sentiment = 'neutral';
        if (percentage < 40) sentiment = 'negative';
        else if (percentage > 60) sentiment = 'positive';

        let headline = `${picker} is ${wins}-${losses}`;
        if (pushes > 0) headline += `-${pushes}`;
        headline += ` in primetime games`;

        return {
            id: `${picker.toLowerCase()}_primetime`,
            type: 'primetime',
            picker,
            wins,
            losses,
            pushes,
            total,
            percentage: Math.round(percentage),
            headline,
            sentiment,
            isInteresting,
            context: { gameType: 'primetime' },
            relevantTeams: [],
            games
        };
    }
};

/**
 * Insights Manager - Caching and retrieval
 */
const InsightsManager = {
    cache: null,
    cacheTimestamp: null,
    byTeam: {},
    byType: {},
    CACHE_DURATION: 5 * 60 * 1000, // 5 minutes

    /**
     * Get all insights, regenerate if stale
     */
    getInsights: function(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.cache && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
            return this.cache;
        }

        console.log('Regenerating pattern insights...');
        this.cache = PatternEngine.detectAllPatterns();
        this.cacheTimestamp = now;
        this.buildIndexes();
        return this.cache;
    },

    /**
     * Build lookup indexes for quick access
     */
    buildIndexes: function() {
        this.byTeam = {};
        this.byType = {};

        Object.keys(this.cache).forEach(picker => {
            const pickerPatterns = this.cache[picker];

            // Index team patterns
            if (pickerPatterns.teamPatterns) {
                pickerPatterns.teamPatterns.forEach(pattern => {
                    // By type
                    if (!this.byType['team']) this.byType['team'] = [];
                    this.byType['team'].push(pattern);

                    // By team
                    (pattern.relevantTeams || []).forEach(team => {
                        const normalizedTeam = TEAM_NAME_MAP[team] || team;
                        if (!this.byTeam[normalizedTeam]) this.byTeam[normalizedTeam] = [];
                        this.byTeam[normalizedTeam].push(pattern);
                    });
                });
            }

            // Index primetime pattern
            if (pickerPatterns.primetimePattern) {
                if (!this.byType['primetime']) this.byType['primetime'] = [];
                this.byType['primetime'].push(pickerPatterns.primetimePattern);
            }
        });
    },

    /**
     * Get insights relevant to a specific game
     */
    getInsightsForGame: function(game) {
        this.getInsights(); // Ensure cache is fresh
        const insights = [];

        // Team insights for both teams
        [game.away, game.home].forEach(team => {
            const normalizedTeam = TEAM_NAME_MAP[team] || team;
            const teamInsights = (this.byTeam[normalizedTeam] || [])
                .filter(i => i.isInteresting);
            insights.push(...teamInsights);
        });

        // Primetime insights if applicable
        if (isPrimetimeGame(game)) {
            const primetimeInsights = (this.byType['primetime'] || [])
                .filter(i => i.isInteresting);
            insights.push(...primetimeInsights);
        }

        // Sort by most notable (negative first, then by deviation from 50%)
        return insights.sort((a, b) => {
            if (a.sentiment === 'negative' && b.sentiment !== 'negative') return -1;
            if (b.sentiment === 'negative' && a.sentiment !== 'negative') return 1;
            const marginA = Math.abs(50 - a.percentage);
            const marginB = Math.abs(50 - b.percentage);
            return marginB - marginA;
        });
    },

    /**
     * Get top insights for a picker
     */
    getTopInsightsForPicker: function(picker, limit = 5) {
        this.getInsights(); // Ensure cache is fresh
        const pickerPatterns = this.cache[picker];
        if (!pickerPatterns) return [];

        const allInsights = [
            ...(pickerPatterns.teamPatterns || []),
            pickerPatterns.primetimePattern
        ].filter(Boolean);

        return allInsights
            .filter(i => i.isInteresting)
            .sort((a, b) => {
                const marginA = Math.abs(50 - a.percentage);
                const marginB = Math.abs(50 - b.percentage);
                return marginB - marginA;
            })
            .slice(0, limit);
    },

    /**
     * Get all interesting insights
     */
    getAllInterestingInsights: function() {
        this.getInsights(); // Ensure cache is fresh
        const allInsights = [];

        Object.keys(this.cache).forEach(picker => {
            const pickerPatterns = this.cache[picker];
            if (pickerPatterns.teamPatterns) {
                allInsights.push(...pickerPatterns.teamPatterns.filter(p => p.isInteresting));
            }
            if (pickerPatterns.primetimePattern && pickerPatterns.primetimePattern.isInteresting) {
                allInsights.push(pickerPatterns.primetimePattern);
            }
        });

        return allInsights.sort((a, b) => {
            const marginA = Math.abs(50 - a.percentage);
            const marginB = Math.abs(50 - b.percentage);
            return marginB - marginA;
        });
    }
};

/**
 * Which side covered, against an explicitly supplied line.
 *
 * Takes the line rather than reading it off the game, because a pick can be
 * frozen at its own number: two players can be graded on different spreads
 * for the same game. Everything that scores a PICK goes through
 * atsWinnerForPick(); this is the shared arithmetic underneath it.
 *
 * NOTE: with a missing or non-numeric spread both comparisons are NaN and this
 * returns 'push' - a silent wrong answer, not an error. Callers must check
 * hasUsableSpread() / hasUsableLine() first on live data, where spreads arrive
 * asynchronously and may not have landed yet.
 */
function calculateATSWinnerFrom(spread, favorite, result) {
    if (!result) return null;

    // The underdog gets the points; the favourite gives them.
    const awayWithSpread = result.awayScore + (favorite === 'away' ? 0 : spread);
    const homeWithSpread = result.homeScore + (favorite === 'home' ? 0 : spread);

    if (awayWithSpread > homeWithSpread) return 'away';
    if (homeWithSpread > awayWithSpread) return 'home';
    return 'push';
}

/**
 * Render scoring summary table - Simple per-player summary
 * For Super Bowl week (22), shows picks summary instead of scoring summary
 */
function renderScoringSummary() {
    const scoringTable = document.getElementById('scoring-table');
    if (!scoringTable) return;

    const weekGames = getGamesForWeekAndSeason(currentWeek, currentSeason);
    const weekResults = getResultsForWeekAndSeason(currentWeek, currentSeason);
    const seasonPicks = getPicksForWeekAndSeason(currentWeek, currentSeason);
    const weekPicks = seasonPicks || {};
    const cachedWeek = weeklyPicksCache[currentWeek];

    // Update the summary header
    const summaryHeader = document.querySelector('.scoring-summary h3');
    const isSuperBowl = currentWeek === 22;

    if (summaryHeader) {
        const weekLabel = isPlayoffWeek(currentWeek) ? getWeekDisplayName(currentWeek) : `Week ${getWeekDisplayName(currentWeek)}`;
        summaryHeader.textContent = isSuperBowl ? `${weekLabel} Picks Summary` : `${weekLabel} Scoring Summary`;
    }

    const isPlayoff = isPlayoffWeek(currentWeek);

    // Super Bowl week: Show picks summary instead of scoring summary
    if (isSuperBowl) {
        renderSuperBowlPicksSummary(scoringTable, weekGames, weekPicks, cachedWeek);
        return;
    }

    if (weekGames.length === 0) {
        scoringTable.innerHTML = '<tbody><tr><td colspan="4" class="no-games-message">No games data available for this week.</td></tr></tbody>';
        return;
    }

    // Calculate stats for each picker
    const stats = {};
    PICKERS.forEach(picker => {
        stats[picker] = {
            lineWins: 0, lineLosses: 0, linePushes: 0,
            suWins: 0, suLosses: 0,
            blazinWins: 0, blazinLosses: 0, blazinPushes: 0,
            ouWins: 0, ouLosses: 0, ouPushes: 0
        };

        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = cachedWeek?.picks?.[picker] || {};

        weekGames.forEach(game => {
            const gamePicks = getPicksForGame(pickerPicks, game);
            const cachedGamePicks = getPicksForGame(cachedPicks, game);

            // Get result from historical data or live scores
            let result = weekResults[game.id];
            if (!result) {
                // Try to get result from live scores for completed games
                const liveData = getLiveGameStatus(game);
                if (liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed)) {
                    result = {
                        winner: liveData.homeScore > liveData.awayScore ? 'home' : 'away',
                        homeScore: liveData.homeScore,
                        awayScore: liveData.awayScore
                    };
                }
            }

            if (!result) return;

            // Honour a frozen line, same as the standings and the card.
            const summaryPick = { ...cachedGamePicks, ...gamePicks };
            const atsWinner = atsWinnerForPick(game, summaryPick, result);
            const isBlazin = gamePicks.blazin || cachedGamePicks.blazin;

            // Line pick result
            const linePick = gamePicks.line || cachedGamePicks.line;
            if (linePick) {
                if (atsWinner === 'push') {
                    stats[picker].linePushes++;
                    if (isBlazin) stats[picker].blazinPushes++;
                } else if (linePick === atsWinner) {
                    stats[picker].lineWins++;
                    if (isBlazin) stats[picker].blazinWins++;
                } else {
                    stats[picker].lineLosses++;
                    if (isBlazin) stats[picker].blazinLosses++;
                }
            }

            // Straight up result
            const winnerPick = gamePicks.winner || cachedGamePicks.winner;
            if (winnerPick) {
                if (winnerPick === result.winner) {
                    stats[picker].suWins++;
                } else {
                    stats[picker].suLosses++;
                }
            }

            // Over/Under result (playoffs only)
            if (isPlayoff) {
                const ouPick = gamePicks.overUnder || cachedGamePicks.overUnder;
                const ouLine = lineForPick(game, summaryPick).overUnder
                    || gamePicks.totalLine || cachedGamePicks.totalLine;
                if (ouPick && ouLine > 0) {
                    const totalScore = (result.awayScore || 0) + (result.homeScore || 0);
                    const ouResult = totalScore > ouLine ? 'over' : (totalScore < ouLine ? 'under' : 'push');
                    if (ouResult === 'push') {
                        stats[picker].ouPushes++;
                    } else if (ouPick === ouResult) {
                        stats[picker].ouWins++;
                    } else {
                        stats[picker].ouLosses++;
                    }
                }
            }
        });
    });

    // Build simple table
    // Check if there are results from historical data or any completed live games
    const hasLiveResults = weekGames.some(game => {
        const liveData = getLiveGameStatus(game);
        return liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed);
    });
    const hasResults = Object.keys(weekResults).length > 0 || hasLiveResults;

    let headerHtml = `
        <thead>
            <tr>
                <th>Picker</th>
                <th>Line (ATS)</th>
                <th>Straight Up</th>
                <th>${isPlayoff ? 'Over/Under' : "Blazin' 5"}</th>
            </tr>
        </thead>
    `;

    let bodyHtml = '<tbody>';
    PICKERS.forEach(picker => {
        const s = stats[picker];
        const linePush = s.linePushes > 0 ? `-${s.linePushes}` : '';
        const blazinPush = s.blazinPushes > 0 ? `-${s.blazinPushes}` : '';
        const blazinTotal = s.blazinWins + s.blazinLosses + s.blazinPushes;
        const ouPush = s.ouPushes > 0 ? `-${s.ouPushes}` : '';
        const ouTotal = s.ouWins + s.ouLosses + s.ouPushes;

        // Fourth column: O/U for playoffs, Blazin' 5 for regular season
        const fourthCol = isPlayoff
            ? (hasResults && ouTotal > 0 ? `${s.ouWins}-${s.ouLosses}${ouPush}` : '-')
            : (hasResults && blazinTotal > 0 ? `${s.blazinWins}-${s.blazinLosses}${blazinPush}` : '-');

        bodyHtml += `
            <tr>
                <td class="picker-name-cell">
                    <span class="picker-color color-${picker.toLowerCase()}"></span>
                    ${picker}
                </td>
                <td class="stat-cell">${hasResults ? `${s.lineWins}-${s.lineLosses}${linePush}` : '-'}</td>
                <td class="stat-cell">${hasResults ? `${s.suWins}-${s.suLosses}` : '-'}</td>
                <td class="stat-cell">${fourthCol}</td>
            </tr>
        `;
    });
    bodyHtml += '</tbody>';

    scoringTable.innerHTML = headerHtml + bodyHtml;
}

/**
 * Render Super Bowl picks summary - Shows what each picker has selected
 */
function renderSuperBowlPicksSummary(scoringTable, weekGames, weekPicks, cachedWeek) {
    if (weekGames.length === 0) {
        scoringTable.innerHTML = '<tbody><tr><td colspan="4" class="no-games-message">No game data available yet.</td></tr></tbody>';
        return;
    }

    const game = weekGames[0]; // Super Bowl is just one game
    const spread = hasUsableSpread(game) ? Number(game.spread) : null;
    const overUnder = hasUsableLine(game.overUnder) ? Number(game.overUnder) : null;

    let headerHtml = `
        <thead>
            <tr>
                <th>Picker</th>
                <th>ATS Pick</th>
                <th>Winner</th>
                <th>Over/Under</th>
            </tr>
        </thead>
    `;

    let bodyHtml = '<tbody>';
    PICKERS.forEach(picker => {
        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = cachedWeek?.picks?.[picker] || {};
        const gamePicks = getPicksForGame(pickerPicks, game);
        const cachedGamePicks = getPicksForGame(cachedPicks, game);

        // Get line pick
        const linePick = gamePicks.line || cachedGamePicks.line;
        let atsDisplay = '-';
        if (linePick) {
            const pickedTeam = linePick === 'home' ? game.home : game.away;
            const isPickedFavorite = (linePick === 'home' && game.favorite === 'home') ||
                                     (linePick === 'away' && game.favorite === 'away');
            const spreadDisplay = isPickedFavorite ? `-${spread}` : `+${spread}`;
            atsDisplay = `${pickedTeam} (${spreadDisplay})`;
        }

        // Get winner pick
        const winnerPick = gamePicks.winner || cachedGamePicks.winner;
        let winnerDisplay = '-';
        if (winnerPick) {
            winnerDisplay = winnerPick === 'home' ? game.home : game.away;
        }

        // Get over/under pick
        const ouPick = gamePicks.overUnder || cachedGamePicks.overUnder;
        const ouLine = overUnder || gamePicks.totalLine || cachedGamePicks.totalLine || 0;
        let ouDisplay = '-';
        if (ouPick && ouLine > 0) {
            ouDisplay = ouPick === 'over' ? `Over ${ouLine}` : `Under ${ouLine}`;
        }

        bodyHtml += `
            <tr>
                <td style="font-weight: 600;">${picker}</td>
                <td style="font-weight: normal;">${atsDisplay}</td>
                <td style="font-weight: normal;">${winnerDisplay}</td>
                <td style="font-weight: normal;">${ouDisplay}</td>
            </tr>
        `;
    });
    bodyHtml += '</tbody>';

    scoringTable.innerHTML = headerHtml + bodyHtml;
}

/**
 * Clear current picker's picks for the current week (only unlocked games)
 */
function clearCurrentPickerPicks() {
    // Block edits for historical seasons
    if (isHistoricalSeason()) {
        showToast('Cannot edit picks for historical seasons', 'warning');
        return;
    }

    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    showConfirmModal(
        'Clear Picks',
        `Clear Week ${currentWeek} picks for ${currentPicker}? Picks for locked/completed games will be preserved.`,
        () => {
            // Save current picks for undo functionality
            const savedPicks = allPicks[currentWeek] && allPicks[currentWeek][currentPicker]
                ? JSON.parse(JSON.stringify(allPicks[currentWeek][currentPicker]))
                : {};
            const savedWeek = currentWeek;
            const savedPicker = currentPicker;

            if (allPicks[currentWeek] && allPicks[currentWeek][currentPicker]) {
                const games = getGamesForWeek(currentWeek);
                const preservedPicks = {};

                // Preserve picks for locked games, and for frozen ones - a
                // freeze is final, so Clear Picks must not undo it.
                games.forEach(game => {
                    const key = pickKey(game);
                    const existingPick = allPicks[currentWeek][currentPicker][key];

                    if (existingPick && (isGameLocked(game) || isPickFrozen(existingPick))) {
                        preservedPicks[key] = existingPick;
                    }
                });

                allPicks[currentWeek][currentPicker] = preservedPicks;
            }

            // Mark picks as intentionally cleared (prevents backup restore)
            if (!clearedPicks[currentWeek]) {
                clearedPicks[currentWeek] = {};
            }
            clearedPicks[currentWeek][currentPicker] = true;
            localStorage.setItem(CLEARED_PICKS_KEY, JSON.stringify(clearedPicks));

            // Sync cleared status to Google Sheets
            syncClearedStatusToGoogleSheets(currentWeek, currentPicker, true);

            savePicksToStorage();
            renderGames();
            renderScoringSummary();

            // Show undo toast with 5 second window
            showUndoToast('Picks cleared', () => {
                // Restore the saved picks
                if (!allPicks[savedWeek]) {
                    allPicks[savedWeek] = {};
                }
                allPicks[savedWeek][savedPicker] = savedPicks;

                // Remove the cleared flag since we're restoring
                if (clearedPicks[savedWeek]) {
                    delete clearedPicks[savedWeek][savedPicker];
                    localStorage.setItem(CLEARED_PICKS_KEY, JSON.stringify(clearedPicks));
                    syncClearedStatusToGoogleSheets(savedWeek, savedPicker, false);
                }

                savePicksToStorage();
                renderGames();
                renderScoringSummary();
            });
        }
    );
}

/**
 * Reset all picks for all pickers
 */
function resetAllPicks() {
    if (confirm('Reset ALL picks for ALL pickers? This cannot be undone.')) {
        PICKERS.forEach(picker => {
            allPicks[picker] = {};
        });
        savePicksToStorage();
        renderGames();
        renderScoringSummary();
    }
}

/**
 * Clear all local picks and reimport from Google Sheets
 * Run in console: clearAndReimportFromSheets()
 */
function clearAndReimportFromSheets() {
    if (confirm('Clear all local picks and reimport from Google Sheets? This will replace any picks you made locally.')) {
        // Clear localStorage
        localStorage.removeItem(PICKS_STORAGE_KEY);
        // Clear in-memory data
        allPicks = {};
        // Clear weekly cache to force re-fetch
        Object.keys(weeklyPicksCache).forEach(key => delete weeklyPicksCache[key]);
        // Reload the page to fetch fresh data from Google Sheets
        location.reload();
    }
}

/**
 * Export all picks to a text/CSV format
 */
function exportAllPicks() {
    const weekGames = getGamesForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};

    let exportText = `Week ${currentWeek} Picks Export\n`;
    exportText += '='.repeat(25) + '\n\n';

    if (weekGames.length === 0) {
        exportText += 'No games data available for this week.\n';
    } else {
        PICKERS.forEach(picker => {
            exportText += `${picker}:\n`;
            exportText += '-'.repeat(40) + '\n';
            const pickerPicks = weekPicks[picker] || {};

            let completePicks = 0;
            let linePicks = 0;
            let winnerPicks = 0;

            weekGames.forEach(game => {
                const gamePicks = getPicksForGame(pickerPicks, game);
                const linePick = gamePicks.line;
                const winnerPick = gamePicks.winner;

                const lineTeam = linePick === 'away' ? game.away : linePick === 'home' ? game.home : null;
                const winnerTeam = winnerPick === 'away' ? game.away : winnerPick === 'home' ? game.home : null;

                // Calculate spread for display
                const spreadDisplay = linePick ? signedSpreadDisplay(game, linePick) : '';

                // Count picks
                if (linePick) linePicks++;
                if (winnerPick) winnerPicks++;
                if (linePick && winnerPick) completePicks++;

                exportText += `  ${game.away} @ ${game.home}\n`;
                exportText += `    Line (ATS): ${lineTeam || 'No pick'}${spreadDisplay ? ` (${spreadDisplay})` : ''}\n`;
                exportText += `    Winner:     ${winnerTeam || 'No pick'}\n`;
            });

            exportText += `\n  Summary: ${completePicks}/${weekGames.length} complete`;
            exportText += ` (Line: ${linePicks}, Winner: ${winnerPicks})\n\n`;
        });
    }

    // Create downloadable file
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `week${currentWeek}_picks.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Copy current picker's picks to clipboard in a shareable format
 */
function copyPicksToClipboard() {
    const weekGames = getGamesForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};
    const pickerPicks = weekPicks[currentPicker] || {};

    if (weekGames.length === 0) {
        showToast('No games available for this week');
        return;
    }

    let pickCount = 0;
    let text = `${currentPicker}'s Week ${currentWeek} Picks\n`;
    text += '━'.repeat(30) + '\n\n';

    weekGames.forEach(game => {
        const gamePicks = getPicksForGame(pickerPicks, game);

        if (gamePicks.line || gamePicks.winner) {
            pickCount++;
            text += `${game.away} @ ${game.home}\n`;

            if (gamePicks.line) {
                const lineTeam = gamePicks.line === 'away' ? game.away : game.home;
                const spreadStr = signedSpreadDisplay(game, gamePicks.line);
                text += spreadStr
                    ? `  ATS: ${lineTeam} (${spreadStr})\n`
                    : `  ATS: ${lineTeam}\n`;
            }

            if (gamePicks.winner) {
                const winnerTeam = gamePicks.winner === 'away' ? game.away : game.home;
                text += `  Winner: ${winnerTeam}\n`;
            }

            text += '\n';
        }
    });

    if (pickCount === 0) {
        showToast('No picks to copy');
        return;
    }

    text += `${pickCount}/${weekGames.length} games picked`;

    navigator.clipboard.writeText(text).then(() => {
        showToast('Picks copied! Ready to share.');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy picks');
    });
}

/**
 * Export all pickers' picks for the current week in WhatsApp-friendly format
 * Format: *PickerName* (bold) followed by each game on its own line
 */
function exportAllPicksToClipboard() {
    const weekGames = getGamesForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};

    if (weekGames.length === 0) {
        showToast('No games available for this week');
        return;
    }

    const lines = [];
    const weekTitle = getWeekTitle(currentWeek, '').trim();
    lines.push(`*${weekTitle} Picks*`);
    lines.push('');

    // Loop through all pickers in alphabetical order
    PICKERS.forEach((picker, index) => {
        const pickerPicks = weekPicks[picker] || {};
        const gameLines = [];

        weekGames.forEach(game => {
            const gamePicks = getPicksForGame(pickerPicks, game);

            // Only include if there's at least a line pick
            if (gamePicks.line) {
                const parts = [];

                // Line pick with spread
                const lineTeam = gamePicks.line === 'away' ? game.away : game.home;
                const spreadStr = signedSpreadDisplay(game, gamePicks.line);
                parts.push(spreadStr ? `${lineTeam} (${spreadStr})` : lineTeam);

                // Winner pick
                if (gamePicks.winner) {
                    const winnerTeam = gamePicks.winner === 'away' ? game.away : game.home;
                    parts.push(`${winnerTeam} win`);
                }

                // Over/Under pick
                if (gamePicks.overUnder) {
                    parts.push(gamePicks.overUnder.charAt(0).toUpperCase() + gamePicks.overUnder.slice(1));
                }

                gameLines.push(parts.join(', '));
            }
        });

        // Add picker name with WhatsApp bold formatting
        lines.push(`*${picker}*`);

        if (gameLines.length > 0) {
            gameLines.forEach(gameLine => {
                lines.push(gameLine);
            });
        } else {
            lines.push('No picks yet');
        }

        // Add blank line between pickers (except after the last one)
        if (index < PICKERS.length - 1) {
            lines.push('');
        }
    });

    const text = lines.join('\n');

    navigator.clipboard.writeText(text).then(() => {
        showToast('All picks exported!', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to export picks');
    });
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - Optional type: 'success', 'error', 'warning' (default: neutral)
 */
function showToast(message, type = '') {
    // Remove existing toast if any
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type) {
        toast.classList.add(`toast-${type}`);
    }
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after delay
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

/**
 * Show a toast notification with an undo button
 * @param {string} message - The message to display
 * @param {Function} undoCallback - Function to call when undo is clicked
 * @param {number} duration - How long to show the toast (default 5000ms)
 */
function showUndoToast(message, undoCallback, duration = 5000) {
    // Remove existing toast if any
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast toast-undo';

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;

    const undoBtn = document.createElement('button');
    undoBtn.className = 'toast-undo-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.setAttribute('aria-label', 'Undo action');

    let undoTimeoutId;
    let hideTimeoutId;

    const dismissToast = () => {
        clearTimeout(undoTimeoutId);
        clearTimeout(hideTimeoutId);
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    };

    undoBtn.addEventListener('click', () => {
        undoCallback();
        dismissToast();
        showToast('Action undone');
    });

    toast.appendChild(messageSpan);
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after delay
    hideTimeoutId = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * Save picks to localStorage and optionally sync to Google Sheets
 * @param {boolean} showSyncToast - Whether to show a toast on successful sync
 * @param {boolean} skipSync - If true, skip syncing to Google Sheets (used when loading from backup)
 */
// Signature of the last payload successfully sent, per week and picker, so an
// unchanged slate is not written again. Re-renders, picker switches and
// background loads can all trigger a save without anything having changed.
const lastSyncedSignature = {};

/** Send any pending sync now instead of waiting out the debounce. */
function flushPendingSync() {
    if (!pendingSyncTimeout) return;
    clearTimeout(pendingSyncTimeout);
    pendingSyncTimeout = null;
    syncPicksToGoogleSheets(false);
}

function savePicksToStorage(showSyncToast = false, skipSync = false) {
    localStorage.setItem(PICKS_STORAGE_KEY, JSON.stringify(allPicks));

    // Debounce sync to Google Sheets (skip if we're just loading data)
    if (APPS_SCRIPT_URL && !skipSync) {
        if (pendingSyncTimeout) {
            clearTimeout(pendingSyncTimeout);
        }
        pendingSyncTimeout = setTimeout(() => {
            syncPicksToGoogleSheets(showSyncToast);
        }, SYNC_DEBOUNCE_MS);
    }
}

/**
 * Sync one picker's picks for one week to Google Sheets.
 *
 * Defaults to the current picker and week, which is every call from the pick
 * UI. Cowherd's picks are saved by an admin who is signed in as themselves,
 * so his sync has to name him explicitly.
 */
async function syncPicksToGoogleSheets(displayToast = true, picker = currentPicker, week = currentWeek) {
    if (!APPS_SCRIPT_URL) {
        return;
    }

    const weekPicks = allPicks[week]?.[picker] || {};
    const weekGames = getGamesForWeekAndSeason(week, currentSeason) || [];

    // A sync writes a SNAPSHOT of the whole week, one row per game, blank
    // where there is no pick - not just the games that currently have one.
    //
    // The Backup sheet is append-only and the reader takes the newest sync
    // batch as the client's full state. A game left out of the batch has no
    // newest row, so the reader falls back to an older one and the pick comes
    // back from the dead on the next load. Deselecting a game clears its entry
    // entirely, which is exactly the case that used to go unsent.
    //
    // So the week's schedule, not the picks object, drives the payload. Bail if
    // the schedule has not loaded: writing blanks for games we cannot see would
    // tombstone real picks.
    if (weekGames.length === 0) {
        console.warn(`[Sync] No schedule for week ${week}, skipping sync`);
        return;
    }

    // A blank row in the snapshot is a tombstone, and foldPickRow gives a
    // frozen row precedence over any later row that lacks the freeze - so an
    // unstamped tombstone loses to the very row it is meant to retire.
    //
    // For a player that never matters: a frozen pick is read-only, so it cannot
    // be deselected and a later blank really is a stale tab. Every Cowherd pick
    // is stored frozen (that is how his own line is carried) while staying
    // editable, so without this his picks could be added but never removed -
    // a corrected week would resurrect the pick it replaced on the next load.
    //
    // Stamping his tombstones puts them in the same class as the rows they
    // replace, so the newest batch wins on timestamp as intended. The stamp is
    // taken from his own picks rather than from the clock, so an unchanged
    // payload stays byte-identical and lastSyncedSignature still dedupes it.
    const tombstoneStamp = picker === COWHERD
        ? (Object.values(weekPicks).map(p => p.frozenAt).filter(Boolean).sort().pop()
            || new Date().toISOString())
        : '';

    const knownKeys = new Set(weekGames.map(g => pickKey(g)));
    for (const storedKey of Object.keys(weekPicks)) {
        if (!knownKeys.has(storedKey)) {
            console.warn(`[Sync] Pick key with no matching game in week ${week}, not synced: ${storedKey}`);
        }
    }

    const formattedPicks = weekGames.map(game => {
        const pickData = weekPicks[pickKey(game)] || {};

        // The spread columns record the line this pick is GRADED against, not
        // whatever the game currently shows - so a frozen pick carries its own
        // number into the sheet and the row stays a faithful record of it.
        // A game with no line yet must write a BLANK spread cell, not 0: 0 is a
        // real pick'em, and a fake one persisted here would be read back as a
        // line and scored as one for ever.
        const line = lineForPick(game, pickData);
        const graded = hasUsableLine(line.spread) ? Number(line.spread) : null;
        const awaySpread = graded === null ? '' : (line.favorite === 'away' ? -graded : graded);
        const homeSpread = graded === null ? '' : (line.favorite === 'home' ? -graded : graded);

        // Convert 'away'/'home' to actual team names; blank means "no pick",
        // which is what makes this row a tombstone.
        const lineTeam = pickData.line ? (pickData.line === 'away' ? game.away : game.home) : '';
        const winnerTeam = pickData.winner ? (pickData.winner === 'away' ? game.away : game.home) : '';

        return {
            gameId: pickKey(game),
            away: game.away,
            home: game.home,
            awaySpread: awaySpread,
            homeSpread: homeSpread,
            linePick: lineTeam,
            winnerPick: winnerTeam,
            blazin: pickData.blazin || false,
            overUnder: pickData.overUnder || '',
            totalLine: pickData.totalLine || '',
            frozenAt: pickData.frozenAt || tombstoneStamp
        };
    });

    // Nothing to do if this is byte-for-byte what was last written. Without
    // this, a couple of clicks a few seconds apart write the whole week twice.
    const signature = JSON.stringify(formattedPicks);
    const signatureKey = `${week}|${picker}`;
    if (lastSyncedSignature[signatureKey] === signature) {
        console.log(`[Sync] Week ${week} unchanged since last sync, skipping`);
        return;
    }

    const payload = {
        week: toSheetWeek(week),
        picker: picker,
        picks: formattedPicks,
        // Report the flag as it actually stands, rather than asserting a
        // constant. This sync lands 5s after whatever scheduled it, so the
        // hardcoded false it used to send arrived after Clear Picks had
        // written true and switched the guard back off - the guard whose only
        // job is telling another device not to restore the week just cleared.
        //
        // Reading the flag keeps both directions right: a clear reinforces it,
        // and the pick that lifts it locally lifts it here too, so a device
        // that picks without having seen the clear still un-clears the week
        // instead of having its picks suppressed on the next load.
        cleared: Boolean(clearedPicks[week]?.[picker])
    };

    console.log('[Sync] Syncing picks to Google Sheets:', payload);

    try {
        // Use worker proxy to avoid CORS issues
        const response = await fetch(`${WORKER_PROXY_URL}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        console.log('[Sync] Response:', responseText);

        let result;
        try {
            result = JSON.parse(responseText);
        } catch (e) {
            console.error('[Sync] Failed to parse response:', e);
            if (displayToast) {
                showToast('Sync failed: Invalid response', 'error');
            }
            return;
        }

        if (result.success) {
            // Only remember it once the write actually landed, so a failure
            // retries rather than being skipped as a duplicate.
            lastSyncedSignature[signatureKey] = signature;
            console.log('[Sync] Picks synced to Google Sheets');
            if (displayToast) {
                showToast('Picks saved to Google Sheets');
            }
        } else {
            console.error('[Sync] Sync failed:', result.error);
            if (displayToast) {
                showToast('Sync failed: ' + (result.error || 'Unknown error'), 'error');
            }
        }
    } catch (error) {
        console.error('[Sync] Failed to sync picks to Google Sheets:', error);
        if (displayToast) {
            showToast('Failed to sync to Google Sheets', 'error');
        }
    }
}

/**
 * Sync cleared status to Google Sheets
 * This tells the backup whether picks were intentionally cleared
 */
async function syncClearedStatusToGoogleSheets(week, picker, cleared) {
    if (!APPS_SCRIPT_URL) {
        return;
    }

    const payload = {
        week: toSheetWeek(week),
        picker: picker,
        cleared: cleared
    };

    console.log('[Sync] Syncing cleared status to Google Sheets:', payload);

    try {
        const response = await fetch(`${WORKER_PROXY_URL}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (result.success) {
            console.log(`[Sync] Cleared status synced for ${picker} week ${week}: ${cleared}`);
        } else {
            console.warn('[Sync] Failed to sync cleared status:', result.error);
        }
    } catch (error) {
        console.warn('[Sync] Failed to sync cleared status:', error.message);
    }
}

/**
 * Sync spreads to Google Sheets for backup
 * This ensures spreads are preserved even if localStorage is cleared
 */
async function syncSpreadsToGoogleSheets() {
    const savedSpreads = getSavedSpreads();

    // Sync spreads for current week and next week
    const weeksToSync = [currentWeek];
    if (currentWeek < LAST_PLAYOFF_WEEK) {
        weeksToSync.push(currentWeek + 1);
    }

    for (const week of weeksToSync) {
        const weekSpreads = savedSpreads[week];
        if (!weekSpreads || Object.keys(weekSpreads).length === 0) {
            continue;
        }

        const payload = {
            week: toSheetWeek(week),
            spreads: weekSpreads
        };

        try {
            const response = await fetch(`${WORKER_PROXY_URL}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (result.success && result.results?.spreads) {
                console.log(`[Spreads Sync] Week ${week}: ${result.results.spreads.message}`);
            }
        } catch (error) {
            console.warn(`[Spreads Sync] Failed to sync week ${week} spreads:`, error.message);
        }
    }
}

/**
 * Load spreads from Google Sheets backup.
 *
 * The sheet is authoritative for every week, future ones included. It is
 * rewritten by whichever device last hit the Odds API, so it is never older
 * than this device's own copy - and it is where a manual correction lands.
 * Future weeks used to keep the local value instead ("avoids unnecessary
 * overwrites"), which meant a line captured for next week never moved on this
 * device until it triggered an API refresh itself. That is how one screen
 * showed the pre-injury Seahawks -10 all Sunday while the sheet said -3.5.
 *
 * Returns { spreads, lastUpdated } or null if failed
 */
async function loadSpreadsFromGoogleSheets(week) {
    try {
        console.log(`[Spreads Load] Fetching spreads for week ${week} from Google Sheets...`);
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=spreads&week=${toSheetWeek(week)}`);
        const result = await response.json();

        if (result.spreads && Object.keys(result.spreads).length > 0) {
            console.log(`[Spreads Load] Loaded ${result.count} spreads for week ${week} from Google Sheets (last updated: ${result.lastUpdated || 'unknown'})`);

            const saved = getSavedSpreads();
            if (!saved[week]) {
                saved[week] = {};
            }

            for (const [key, data] of Object.entries(result.spreads)) {
                saved[week][key] = data;
            }

            localStorage.setItem(SAVED_SPREADS_KEY, JSON.stringify(saved));
            return { spreads: result.spreads, lastUpdated: result.lastUpdated };
        }
    } catch (error) {
        console.warn(`[Spreads Load] Failed to load week ${week} spreads from Google Sheets:`, error.message);
    }
    return null;
}

/**
 * Load picks from Google Sheets backup
 * Called during initialization to restore picks if localStorage is empty for a picker
 */
async function loadPicksFromGoogleSheets(week, picker) {
    // Skip playoff weeks that have historical data - historical data is authoritative
    const weekNum = parseInt(week);
    if (weekNum >= 19 && typeof HISTORICAL_PICKS !== 'undefined' && HISTORICAL_PICKS[week]) {
        console.log(`[Picks Load] Skipping playoff week ${week} - using historical data`);
        return null;
    }

    try {
        console.log(`[Picks Load] Attempting to load picks for ${picker} week ${week} from Google Sheets...`);
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=picks&week=${toSheetWeek(week)}&picker=${encodeURIComponent(picker)}`);
        const result = await response.json();

        if (result.error) {
            console.warn(`[Picks Load] Error from Google Sheets:`, result.error);
            return null;
        }

        // Check if picks were intentionally cleared (from Google Sheets)
        if (result.cleared) {
            console.log(`[Picks Load] ${picker} week ${week} was intentionally cleared (from Google Sheets), skipping restore`);
            // Update local cleared status to match
            if (!clearedPicks[week]) {
                clearedPicks[week] = {};
            }
            clearedPicks[week][picker] = true;
            localStorage.setItem(CLEARED_PICKS_KEY, JSON.stringify(clearedPicks));
            return null;
        }

        if (result.picks && Object.keys(result.picks).length > 0) {
            console.log(`[Picks Load] Loaded ${result.count} picks for ${picker} week ${week} from Google Sheets`);

            // Merge into allPicks - prefer backup data over historical data
            if (!allPicks[week]) {
                allPicks[week] = {};
            }
            if (!allPicks[week][picker]) {
                allPicks[week][picker] = {};
            }

            for (const [rawKey, pickData] of Object.entries(result.picks)) {
                // Overwrite with backup data (backup is source of truth)
                allPicks[week][picker][normalizePickKey(rawKey)] = pickData;
            }

            // Save to localStorage for future loads (skip sync - we just loaded from backup)
            savePicksToStorage(false, true);
            return result.picks;
        } else {
            console.log(`[Picks Load] No picks found for ${picker} week ${week} in Google Sheets`);
        }
    } catch (error) {
        console.warn(`[Picks Load] Failed to load ${picker} week ${week} picks from Google Sheets:`, error.message);
    }
    return null;
}

/**
 * Load ALL picks from Google Sheets backup in one API call
 * This fetches picks for all weeks and all pickers at once
 */
async function loadAllPicksFromBackup() {
    // Only fetch from Google Sheets once per session to avoid excessive API calls
    if (backupFetchedThisSession) {
        console.log('[Picks Load] Backup already fetched this session, skipping');
        return;
    }

    // Mark as fetched immediately to prevent duplicate calls
    backupFetchedThisSession = true;
    console.log('[Picks Load] Starting backup fetch from Google Sheets...');

    try {
        // Ask for this season only. The sheet is never pruned, so without the
        // filter every load also downloads and parses every past season, which
        // the merge loop below then discards. An older Apps Script deployment
        // ignores the parameter and returns everything, which still works.
        const response = await fetch(
            `${WORKER_PROXY_URL}/sync?action=allpicks&season=${CURRENT_SEASON}`);
        console.log('[Picks Load] Got response, parsing JSON...');
        const result = await response.json();
        console.log('[Picks Load] Response:', result);

        if (result.error) {
            console.warn('[Picks Load] Error from Google Sheets:', result.error);
            return;
        }

        // Reset local clearedPicks to match server state exactly
        // This ensures "No" entries on server remove local "Yes" entries
        clearedPicks = {};
        if (result.cleared) {
            for (const sheetWeek in result.cleared) {
                const weekNum = fromSheetWeek(sheetWeek);
                if (weekNum === null) continue; // row belongs to another season
                const week = String(weekNum);
                if (!clearedPicks[week]) {
                    clearedPicks[week] = {};
                }
                for (const picker in result.cleared[sheetWeek]) {
                    clearedPicks[week][picker] = true;
                    // Also clear local picks to match server state
                    if (allPicks[weekNum]?.[picker]) {
                        console.log(`[Picks Load] Clearing local picks for ${picker} week ${week} (server says cleared)`);
                        delete allPicks[weekNum][picker];
                    }
                    if (allPicks[week]?.[picker]) {
                        delete allPicks[week][picker];
                    }
                }
            }
        }
        localStorage.setItem(CLEARED_PICKS_KEY, JSON.stringify(clearedPicks));
        console.log('[Picks Load] Synced clearedPicks from server:', clearedPicks);

        // Merge picks from backup into allPicks
        if (result.picks) {
            let totalPicks = 0;
            for (const sheetWeek in result.picks) {
                const weekNum = fromSheetWeek(sheetWeek);
                if (weekNum === null) continue; // row belongs to another season
                const week = String(weekNum);

                // Skip playoff weeks that have historical data - historical data is authoritative
                if (weekNum >= 19 && typeof HISTORICAL_PICKS !== 'undefined' && HISTORICAL_PICKS[week]) {
                    continue;
                }

                for (const picker in result.picks[sheetWeek]) {
                    // Skip if user intentionally cleared picks for this week/picker
                    if (clearedPicks[week]?.[picker]) {
                        console.log(`[Picks Load] ${picker} week ${week} was cleared, skipping`);
                        continue;
                    }

                    if (!allPicks[weekNum]) {
                        allPicks[weekNum] = {};
                    }
                    if (!allPicks[weekNum][picker]) {
                        allPicks[weekNum][picker] = {};
                    }

                    // Overwrite with backup data (backup is source of truth).
                    // Keys are re-normalized because the sheet builds them from
                    // raw team names without going through TEAM_NAME_MAP.
                    for (const rawKey in result.picks[sheetWeek][picker]) {
                        const key = normalizePickKey(rawKey);
                        allPicks[weekNum][picker][key] = result.picks[sheetWeek][picker][rawKey];
                        totalPicks++;
                    }
                }
            }
            console.log(`[Picks Load] Loaded ${totalPicks} picks across ${result.weekCount} weeks from Google Sheets backup`);

            // Save to localStorage (skip sync - we just loaded from backup)
            savePicksToStorage(false, true);
        } else {
            console.log('[Picks Load] No picks in response');
        }

    } catch (error) {
        console.error('[Picks Load] Failed to load picks from Google Sheets backup:', error);
    }

    // Draw what landed, rather than leaving it sitting in memory until the
    // slowest of the background loads settles. This is the only source for a
    // pick made anywhere but this browser - all of Cowherd’s, on every device
    // but the one they were typed into - so the wait was the difference
    // between his five being up and the panel looking empty.
    //
    // Not gated on having merged anything: a week the sheet has cleared is
    // also news. Guarded on initialLoadComplete because changeWeek() awaits
    // this before its own render during boot.
    if (initialLoadComplete) renderActiveTab();
}

/**
 * Results the sheet sent for a week whose schedule had not loaded yet, kept by
 * matchup key until it has.
 *
 * NFL_RESULTS_BY_WEEK is keyed by game id, so a result can only be filed once
 * its week's games exist. The sheet read and the schedule preload run
 * concurrently, so for a past week the results usually arrive first - and they
 * used to be dropped on the floor, which left backfillResults() believing the
 * sheet held nothing and rewriting a whole week of results on every page load.
 */
let pendingSheetResults = {};

/**
 * File one result from the sheet against its game, or park it until the week's
 * schedule is in.
 *
 * @returns {boolean} whether it was filed
 */
function fileSheetResult(week, rawKey, data, games = getGamesForWeek(week)) {
    // normalizePickKey/pickKey, not a raw toLowerCase comparison: the Apps
    // Script composes its key from the team-name columns without going through
    // TEAM_NAME_MAP, so an alias on either side would never match.
    const gameKey = normalizePickKey(rawKey);
    const game = (games || []).find(g => pickKey(g) === gameKey);

    if (!game) {
        if (!pendingSheetResults[week]) pendingSheetResults[week] = {};
        pendingSheetResults[week][gameKey] = data;
        return false;
    }

    if (!NFL_RESULTS_BY_WEEK[week]) NFL_RESULTS_BY_WEEK[week] = {};
    NFL_RESULTS_BY_WEEK[week][game.id] = {
        winner: data.winner,
        awayScore: data.awayScore,
        homeScore: data.homeScore
    };
    if (pendingSheetResults[week]) delete pendingSheetResults[week][gameKey];
    return true;
}

/**
 * File everything that was parked, now that more schedules are loaded.
 *
 * Must run before backfillResults(), which works out what the sheet is missing
 * from what has been filed.
 */
function applyPendingSheetResults() {
    let filed = 0;
    for (const week of Object.keys(pendingSheetResults)) {
        const weekNum = Number(week);
        const games = getGamesForWeek(weekNum);
        if (!games || games.length === 0) continue;
        for (const [gameKey, data] of Object.entries(pendingSheetResults[week])) {
            if (fileSheetResult(weekNum, gameKey, data, games)) filed++;
        }
    }
    if (filed > 0) {
        console.log(`[Results Load] Filed ${filed} parked result(s) once their schedules loaded`);
    }
    return filed;
}

/**
 * Load ALL results from Google Sheets backup in one API call
 * This fetches results for all weeks at once and merges into NFL_RESULTS_BY_WEEK
 */
async function loadAllResultsFromBackup() {
    // Only fetch from Google Sheets once per session
    if (resultsFetchedThisSession) {
        console.log('[Results Load] Results already fetched this session, skipping');
        return;
    }

    resultsFetchedThisSession = true;
    console.log('[Results Load] Starting results fetch from Google Sheets...');

    try {
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=allresults`);
        const result = await response.json();

        if (result.error) {
            console.warn('[Results Load] Error from Google Sheets:', result.error);
            return;
        }

        if (result.results && Object.keys(result.results).length > 0) {
            let totalResults = 0;
            let parked = 0;
            for (const sheetWeek in result.results) {
                const weekNum = fromSheetWeek(sheetWeek);
                if (weekNum === null) continue; // row belongs to another season

                // Hoisted: the lookup used to rebuild the week's game list once
                // per result row.
                const games = getGamesForWeek(weekNum);

                for (const gameKey in result.results[sheetWeek]) {
                    // Parked rather than discarded when the week's schedule is
                    // not in yet; applyPendingSheetResults() files it after.
                    if (fileSheetResult(weekNum, gameKey, result.results[sheetWeek][gameKey], games)) {
                        totalResults++;
                    } else {
                        parked++;
                    }
                }
            }
            const parkedNote = parked > 0 ? `, ${parked} awaiting their schedules` : '';
            console.log(`[Results Load] Loaded ${totalResults} results across ${result.weekCount} weeks from Google Sheets backup${parkedNote}`);
        } else {
            console.log('[Results Load] No results in response');
        }
    } catch (error) {
        console.error('[Results Load] Failed to load results from Google Sheets backup:', error);
    }

    // Same reason as the picks load: draw it now rather than when the slowest
    // sibling in the background block settles. Results are not cached locally,
    // so every load starts with none of them - which is what keeps Cowherd out
    // of the Blazin’ 5 table, since cowherdBelongsIn() wants a scored pick and
    // an unscored season gives him none.
    if (initialLoadComplete) renderActiveTab();
}

/**
 * Sync game results to Google Sheets when games finish
 * @param {number} week - The week number
 * @param {string} source - Source of the results (e.g., 'ESPN')
 */
/**
 * Persist any newly final results for one week. Called as live scores refresh,
 * so a game is written to the sheet within a poll of going final.
 */
async function syncResultsToGoogleSheets(week, source = 'ESPN') {
    if (!APPS_SCRIPT_URL) return 0;
    return postResultsToSheet(week, unstoredResultsForWeek(week), source);
}

/**
 * Load picks from localStorage
 */
function loadPicksFromStorage() {
    const saved = localStorage.getItem(PICKS_STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);

            // Check if it's the new week-based format (keys are numbers) or old format (keys are picker names)
            const keys = Object.keys(parsed);
            const isNewFormat = keys.length > 0 && !isNaN(parseInt(keys[0]));

            if (isNewFormat) {
                // New format: { week: { picker: { gameId: picks } } }
                Object.keys(parsed).forEach(week => {
                    const weekNum = parseInt(week);
                    // Skip playoff weeks that have historical data - historical data is authoritative
                    // This means games are complete and results are final
                    if (weekNum >= 19 && typeof HISTORICAL_PICKS !== 'undefined' && HISTORICAL_PICKS[week]) {
                        return;
                    }
                    if (!allPicks[weekNum]) {
                        allPicks[weekNum] = {};
                    }
                    Object.keys(parsed[week]).forEach(picker => {
                        if (PICKERS.includes(picker)) {
                            allPicks[weekNum][picker] = parsed[week][picker];
                        }
                    });
                });
            } else {
                // Old format: { picker: { gameId: picks } } - migrate to week 15
                PICKERS.forEach(picker => {
                    if (parsed[picker]) {
                        if (!allPicks[15]) {
                            allPicks[15] = {};
                        }
                        allPicks[15][picker] = {};
                        Object.keys(parsed[picker]).forEach(gameId => {
                            const pick = parsed[picker][gameId];
                            if (typeof pick === 'string') {
                                allPicks[15][picker][gameId] = { line: pick };
                            } else if (typeof pick === 'object' && pick !== null) {
                                allPicks[15][picker][gameId] = pick;
                            }
                        });
                    }
                });
                // Save migrated data (no toast, skip sync for migration)
                savePicksToStorage(false, true);
            }
        } catch (e) {
            console.error('Failed to load picks from storage, clearing...', e);
            localStorage.removeItem(PICKS_STORAGE_KEY);
        }
    }
}

/**
 * Show loading state with skeleton screens
 */
function showLoadingState() {
    const loadingState = document.getElementById('loading-state');
    const skeletonGames = document.getElementById('skeleton-games');
    const skeletonLeaderboard = loadingState?.querySelector('.skeleton-leaderboard');

    if (loadingState) {
        loadingState.classList.remove('hidden');

        // Show appropriate skeleton based on active tab
        if (currentCategory === 'make-picks') {
            if (skeletonGames) skeletonGames.style.display = 'grid';
            if (skeletonLeaderboard) skeletonLeaderboard.style.display = 'none';
        } else {
            if (skeletonGames) skeletonGames.style.display = 'none';
            if (skeletonLeaderboard) skeletonLeaderboard.style.display = 'grid';
        }

        // Reset progress
        updateLoadingProgress(0, 'Loading dashboard data...');
    }
}

/**
 * Update loading progress indicator
 * @param {number} percent - Progress percentage (0-100)
 * @param {string} message - Status message to display
 */
function updateLoadingProgress(percent, message) {
    const progressFill = document.getElementById('loading-progress-fill');
    const progressText = document.getElementById('loading-progress-text');

    if (progressFill) {
        progressFill.style.width = `${percent}%`;
    }
    if (progressText && message) {
        progressText.textContent = message;
    }
}

/**
 * Hide loading state
 */
function hideLoadingState() {
    const loadingState = document.getElementById('loading-state');
    if (loadingState) {
        // Complete the progress bar before hiding
        updateLoadingProgress(100, 'Ready!');

        // Brief delay to show completion, then hide
        setTimeout(() => {
            loadingState.classList.add('hidden');
        }, 200);
    }
}

/**
 * Show error state
 */
function showErrorState(message) {
    hideLoadingState();
    const errorState = document.getElementById('error-state');
    const errorMessage = document.getElementById('error-message');
    if (errorState) {
        errorState.classList.remove('hidden');
        if (errorMessage && message) {
            errorMessage.textContent = message;
        }
    }
}

/**
 * Hide error state
 */
function hideErrorState() {
    const errorState = document.getElementById('error-state');
    if (errorState) {
        errorState.classList.add('hidden');
    }
}

// Current game filter
let currentGameFilter = 'all';

/**
 * Setup game filters
 */
function setupGameFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            currentGameFilter = filter;

            // Update active state
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Re-render games with filter
            renderGames();
        });
    });
}

/**
 * Setup week navigation buttons
 */
function setupWeekNavigation() {
    const prevBtn = document.getElementById('prev-week-btn');
    const nextBtn = document.getElementById('next-week-btn');

    prevBtn?.addEventListener('click', () => {
        if (currentWeek > 1) {
            setCurrentWeek(currentWeek - 1);
        }
    });

    nextBtn?.addEventListener('click', () => {
        const maxWeek = getMaxNavigableWeek();
        if (currentWeek < maxWeek) {
            setCurrentWeek(currentWeek + 1);
        }
    });

    updateWeekNavButtons();
}

/**
 * Get the maximum week that can be navigated to
 * This is either CURRENT_NFL_WEEK or the next week if all current games are complete
 */
function getMaxNavigableWeek() {
    let maxWeek = Math.min(CURRENT_NFL_WEEK, LAST_PLAYOFF_WEEK);

    // If all games in the date-based current week are complete, allow navigation to next week
    if (areAllGamesCompleted(CURRENT_NFL_WEEK) && CURRENT_NFL_WEEK < LAST_PLAYOFF_WEEK) {
        maxWeek = Math.min(CURRENT_NFL_WEEK + 1, LAST_PLAYOFF_WEEK);
    }

    return maxWeek;
}

/**
 * Update week navigation button states
 */
function updateWeekNavButtons() {
    const prevBtn = document.getElementById('prev-week-btn');
    const nextBtn = document.getElementById('next-week-btn');
    const maxWeek = getMaxNavigableWeek();

    if (prevBtn) prevBtn.disabled = currentWeek <= 1;
    if (nextBtn) nextBtn.disabled = currentWeek >= maxWeek;
}

/**
 * Update week UI after navigation
 */
function updateWeekUI() {
    const weekDropdown = document.getElementById('week-dropdown');
    if (weekDropdown) weekDropdown.value = currentWeek;

    const picksWeekNum = document.getElementById('picks-week-num');
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (picksWeekNum) picksWeekNum.textContent = getWeekTitle(currentWeek, 'Picks');
    if (scoringWeekNum) scoringWeekNum.textContent = getWeekTitle(currentWeek, 'Scoring Summary');

    updateWeekNavButtons();
    renderGames();
    renderScoringSummary();
}

/**
 * Show confirmation modal
 */
let modalConfirmCallback = null;
let modalDontShowKey = null;

/**
 * @param {object} [options]
 * @param {string} [options.confirmLabel] text for the confirm button
 * @param {string} [options.dontShowKey] localStorage key for a
 *        "Don't show this again" checkbox. Omit it and the checkbox is hidden.
 */
function showConfirmModal(title, message, onConfirm, options = {}) {
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');
    if (!modal || !modalTitle || !modalMessage) return false;

    modalTitle.textContent = title;
    modalMessage.textContent = message;

    const confirmBtn = document.getElementById('modal-confirm-btn');
    if (confirmBtn) confirmBtn.textContent = options.confirmLabel || 'Confirm';

    // The checkbox is shared, so it has to be reset every time or a previous
    // dialog's tick would silently apply to this one.
    const row = document.getElementById('modal-dont-show-row');
    const box = document.getElementById('modal-dont-show');
    modalDontShowKey = options.dontShowKey || null;
    if (box) box.checked = false;
    if (row) row.classList.toggle('hidden', !modalDontShowKey);

    modalConfirmCallback = onConfirm;
    modal.classList.add('show');
    return true;
}

const SUPPRESSED_CONFIRMS_KEY = 'nfl_suppressed_confirms';

/** Has the user ticked "don't show this again" for this dialog? */
function isConfirmSuppressed(key) {
    if (!key) return false;
    try {
        const raw = localStorage.getItem(SUPPRESSED_CONFIRMS_KEY);
        return Boolean(raw && JSON.parse(raw)[key]);
    } catch (e) {
        return false;
    }
}

function suppressConfirm(key) {
    if (!key) return;
    try {
        const raw = localStorage.getItem(SUPPRESSED_CONFIRMS_KEY);
        const map = raw ? JSON.parse(raw) : {};
        map[key] = true;
        localStorage.setItem(SUPPRESSED_CONFIRMS_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn('[Confirm] Could not save preference:', e);
    }
}

/**
 * Ask the user to confirm something, then run onConfirm.
 *
 * Uses the in-page modal, which is what carries the "don't show this again"
 * checkbox. Falls back to the native confirm() when the modal markup is not
 * present, so the flow still works if the dialog is missing.
 *
 * Returns true if onConfirm ran synchronously, false if it was deferred to the
 * modal or declined.
 */
function requestConfirmation(title, message, options, onConfirm) {
    if (options && options.dontShowKey && isConfirmSuppressed(options.dontShowKey)) {
        onConfirm();
        return true;
    }
    if (showConfirmModal(title, message, onConfirm, options)) {
        return false;
    }
    if (confirm(`${title}\n\n${message}`)) {
        onConfirm();
        return true;
    }
    return false;
}

function hideConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    modalConfirmCallback = null;
    modalDontShowKey = null;
}

function setupConfirmModal() {
    document.getElementById('modal-cancel-btn')?.addEventListener('click', hideConfirmModal);
    document.getElementById('modal-confirm-btn')?.addEventListener('click', () => {
        // Only remember the preference when the action is actually confirmed -
        // ticking the box and then cancelling should not suppress anything.
        const box = document.getElementById('modal-dont-show');
        if (modalDontShowKey && box?.checked) {
            suppressConfirm(modalDontShowKey);
        }
        if (modalConfirmCallback) {
            modalConfirmCallback();
        }
        hideConfirmModal();
    });

    // Close on overlay click
    document.getElementById('confirm-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'confirm-modal') {
            hideConfirmModal();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('confirm-modal');
            if (modal && modal.classList.contains('show')) {
                hideConfirmModal();
            }
        }
    });
}

/**
 * Setup first-visit onboarding overlay
 */
function setupOnboarding() {
    const ONBOARDING_KEY = 'nfl-picks-onboarding-seen';
    const overlay = document.getElementById('onboarding-overlay');
    const closeBtn = document.getElementById('onboarding-close-btn');
    const dontShowCheckbox = document.getElementById('onboarding-dont-show');

    if (!overlay || !closeBtn) return;

    // Check if user has seen onboarding before
    const hasSeenOnboarding = localStorage.getItem(ONBOARDING_KEY) === 'true';

    if (!hasSeenOnboarding) {
        // Show onboarding after a brief delay to let page load
        setTimeout(() => {
            overlay.classList.add('show');
        }, 500);
    }

    // Close button handler
    closeBtn.addEventListener('click', () => {
        overlay.classList.remove('show');

        // Save preference if checkbox is checked
        if (dontShowCheckbox && dontShowCheckbox.checked) {
            localStorage.setItem(ONBOARDING_KEY, 'true');
        }
    });

    // Close on overlay click (outside modal)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.classList.remove('show');
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                localStorage.setItem(ONBOARDING_KEY, 'true');
            }
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
            overlay.classList.remove('show');
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                localStorage.setItem(ONBOARDING_KEY, 'true');
            }
        }
    });
}

/**
 * Export picks to JSON file
 */
function exportPicks() {
    const data = {
        exportDate: new Date().toISOString(),
        picks: allPicks
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nfl-picks-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Picks exported successfully');
}

/**
 * Import picks from JSON file
 */
function importPicks(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.picks) {
                // Merge imported picks with existing
                Object.keys(data.picks).forEach(week => {
                    if (!allPicks[week]) allPicks[week] = {};
                    Object.keys(data.picks[week]).forEach(picker => {
                        if (!allPicks[week][picker]) allPicks[week][picker] = {};
                        Object.assign(allPicks[week][picker], data.picks[week][picker]);
                    });
                });
                savePicksToStorage();
                renderGames();
                renderScoringSummary();
                showToast('Picks imported successfully');
            } else {
                showToast('Invalid file format');
            }
        } catch (err) {
            showToast('Failed to import picks');
            console.error('Import error:', err);
        }
    };
    reader.readAsText(file);
}

function setupExportImport() {
    document.getElementById('export-picks-btn')?.addEventListener('click', exportPicks);
    document.getElementById('import-picks-btn')?.addEventListener('click', () => {
        document.getElementById('import-file-input')?.click();
    });
    document.getElementById('import-file-input')?.addEventListener('change', (e) => {
        if (e.target.files[0]) {
            importPicks(e.target.files[0]);
            e.target.value = ''; // Reset for next import
        }
    });
}


/**
 * Setup retry button for error state
 */
function setupRetryButton() {
    document.getElementById('retry-btn')?.addEventListener('click', () => {
        hideErrorState();
        showLoadingState();
        loadFromGoogleSheets();
    });
}

/**
 * Collapsible Sections
 * Allows users to collapse/expand chart and insight sections
 */
const COLLAPSED_SECTIONS_KEY = 'collapsedSections';

function getCollapsedSections() {
    try {
        const saved = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch (e) {
        return {};
    }
}

function saveCollapsedSections(sections) {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(sections));
}

function toggleSection(sectionId) {
    const section = document.querySelector(`[data-section="${sectionId}"]`);
    if (!section) return;

    const isCollapsed = section.classList.toggle('collapsed');

    // Update icon
    const icon = section.querySelector('.collapse-toggle-icon');
    if (icon) {
        icon.textContent = isCollapsed ? '+' : '−';
    }

    // Save state to localStorage. Both states, not just the collapsed one:
    // deleting the key left a section that starts collapsed in its markup
    // unable to be opened for good, since the next load would find nothing
    // saved and fall back to the markup again.
    const collapsedSections = getCollapsedSections();
    collapsedSections[sectionId] = isCollapsed;
    saveCollapsedSections(collapsedSections);
}

function initCollapsibleSections() {
    const collapsedSections = getCollapsedSections();

    // Apply saved states, opening as well as closing: a section whose markup
    // starts it collapsed has to be able to stay open once it is opened.
    // Anything with nothing saved keeps whatever its markup says.
    Object.entries(collapsedSections).forEach(([sectionId, isCollapsed]) => {
        const section = document.querySelector(`[data-section="${sectionId}"]`);
        if (!section) return;

        section.classList.toggle('collapsed', Boolean(isCollapsed));
        const icon = section.querySelector('.collapse-toggle-icon');
        if (icon) {
            icon.textContent = isCollapsed ? '+' : '\u2212';
        }
    });
}

/**
 * Pull to Refresh
 * Mobile gesture to refresh live scores
 */
function setupPullToRefresh() {
    const pullIndicator = document.getElementById('pull-to-refresh');
    if (!pullIndicator) return;

    // Only enable on touch devices
    if (!('ontouchstart' in window)) return;

    const textEl = pullIndicator.querySelector('.pull-to-refresh-text');
    const PULL_THRESHOLD = 80; // Pixels to pull before refresh triggers
    const MAX_PULL = 120; // Maximum pull distance

    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    let isRefreshing = false;

    function canPull() {
        // Only allow pull when at top of page
        return window.scrollY <= 0;
    }

    function handleTouchStart(e) {
        if (isRefreshing || !canPull()) return;
        startY = e.touches[0].clientY;
        isPulling = false;
    }

    function handleTouchMove(e) {
        if (isRefreshing) return;

        currentY = e.touches[0].clientY;
        const pullDistance = currentY - startY;

        // Only pull when scrolled to top and pulling down
        if (pullDistance > 0 && canPull()) {
            // Prevent default only when we're actually pulling
            if (pullDistance > 10) {
                e.preventDefault();
                isPulling = true;

                // Apply resistance to pull
                const resistedPull = Math.min(pullDistance * 0.5, MAX_PULL);

                pullIndicator.classList.add('pulling');
                pullIndicator.style.setProperty('--pull-height', `${resistedPull}px`);

                // Update text and state based on pull distance
                if (resistedPull >= PULL_THRESHOLD) {
                    pullIndicator.classList.add('ready');
                    if (textEl) textEl.textContent = 'Release to refresh';
                } else {
                    pullIndicator.classList.remove('ready');
                    if (textEl) textEl.textContent = 'Pull to refresh';
                }
            }
        }
    }

    function handleTouchEnd() {
        if (isRefreshing) return;

        const pullDistance = currentY - startY;
        const resistedPull = Math.min(pullDistance * 0.5, MAX_PULL);

        if (isPulling && resistedPull >= PULL_THRESHOLD) {
            // Trigger refresh
            triggerRefresh();
        } else {
            // Reset without refresh
            resetPullIndicator();
        }

        isPulling = false;
        startY = 0;
        currentY = 0;
    }

    async function triggerRefresh() {
        isRefreshing = true;
        pullIndicator.classList.remove('pulling', 'ready');
        pullIndicator.classList.add('refreshing');
        pullIndicator.style.removeProperty('--pull-height');
        if (textEl) textEl.textContent = 'Refreshing...';

        try {
            // Refresh live scores
            await fetchLiveScores();
            renderGames();
            renderScoringSummary();

            // Show success briefly
            if (textEl) textEl.textContent = 'Updated!';
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('Pull to refresh failed:', error);
            if (textEl) textEl.textContent = 'Refresh failed';
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        resetPullIndicator();
        isRefreshing = false;
    }

    function resetPullIndicator() {
        pullIndicator.classList.remove('pulling', 'ready', 'refreshing');
        pullIndicator.style.removeProperty('--pull-height');
        if (textEl) textEl.textContent = 'Pull to refresh';
    }

    // Add touch listeners with passive: false for touchmove to allow preventDefault
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
}

// ============================================
// VS MARKET - COMPARE PICKS TO INVESTMENT RETURNS
// ============================================

const MARKET_CACHE_KEY = 'marketPricesCache';
const MARKET_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const CUSTOM_MARKETS_KEY = 'customMarkets';
const HIDDEN_DEFAULTS_KEY = 'hiddenDefaultMarkets';
const MARKET_LAST_UPDATED_KEY = 'marketLastUpdated';

// Default markets (can be hidden by user)
const DEFAULT_MARKETS = [
    { symbol: '^GSPC', name: 'S&P 500', type: 'index' },
    { symbol: 'GC=F', name: 'Gold', type: 'commodity' },
    { symbol: 'BTC', name: 'Bitcoin', type: 'crypto' }
];

// CORS proxies to try in order if one fails
const CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    'https://cors-anywhere.herokuapp.com/'
];

// Track market data state
let marketDataState = {
    lastUpdated: null,
    loading: false,
    error: null,
    data: null
};

/**
 * Get hidden default market symbols
 * @returns {Array} Array of hidden symbol strings
 */
function getHiddenDefaults() {
    const hiddenJson = localStorage.getItem(HIDDEN_DEFAULTS_KEY);
    return hiddenJson ? JSON.parse(hiddenJson) : [];
}

/**
 * Save hidden default markets to localStorage
 * @param {Array} symbols - Array of hidden symbol strings
 */
function saveHiddenDefaults(symbols) {
    localStorage.setItem(HIDDEN_DEFAULTS_KEY, JSON.stringify(symbols));
}

/**
 * Get all active markets (visible defaults + custom)
 * @returns {Array} Array of market objects { symbol, name, type }
 */
function getActiveMarkets() {
    const hiddenDefaults = getHiddenDefaults();
    const visibleDefaults = DEFAULT_MARKETS.filter(m => !hiddenDefaults.includes(m.symbol));
    const customMarketsJson = localStorage.getItem(CUSTOM_MARKETS_KEY);
    const customMarkets = customMarketsJson ? JSON.parse(customMarketsJson) : [];
    return [...visibleDefaults, ...customMarkets];
}

/**
 * Get custom markets only
 * @returns {Array} Array of custom market objects
 */
function getCustomMarkets() {
    const customMarketsJson = localStorage.getItem(CUSTOM_MARKETS_KEY);
    return customMarketsJson ? JSON.parse(customMarketsJson) : [];
}

/**
 * Save custom markets to localStorage
 * @param {Array} markets - Array of custom market objects
 */
function saveCustomMarkets(markets) {
    localStorage.setItem(CUSTOM_MARKETS_KEY, JSON.stringify(markets));
}

/**
 * Hide a default market
 * @param {string} symbol - Symbol to hide
 * @returns {boolean} True if hidden
 */
function hideDefaultMarket(symbol) {
    const isDefault = DEFAULT_MARKETS.some(m => m.symbol === symbol);
    if (!isDefault) return false;

    const hidden = getHiddenDefaults();
    if (!hidden.includes(symbol)) {
        hidden.push(symbol);
        saveHiddenDefaults(hidden);
        localStorage.removeItem(MARKET_CACHE_KEY);
        return true;
    }
    return false;
}

/**
 * Restore a hidden default market
 * @param {string} symbol - Symbol to restore
 * @returns {boolean} True if restored
 */
function restoreDefaultMarket(symbol) {
    const hidden = getHiddenDefaults();
    const index = hidden.indexOf(symbol);
    if (index > -1) {
        hidden.splice(index, 1);
        saveHiddenDefaults(hidden);
        localStorage.removeItem(MARKET_CACHE_KEY);
        return true;
    }
    return false;
}

/**
 * Validate a ticker symbol by checking Yahoo Finance
 * @param {string} symbol - Ticker symbol to validate
 * @returns {Promise<Object|null>} Market object if valid, null if invalid
 */
async function validateTicker(symbol) {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol || cleanSymbol.length > 10) {
        return null;
    }

    // Check if already exists
    const activeMarkets = getActiveMarkets();
    if (activeMarkets.some(m => m.symbol.toUpperCase() === cleanSymbol)) {
        return { error: 'Market already added' };
    }

    // Try to fetch from Yahoo Finance to validate
    for (const proxy of CORS_PROXIES) {
        try {
            const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}?interval=1d&range=5d`)}`;
            const response = await fetch(url, { timeout: 5000 });
            if (response.ok) {
                const data = await response.json();
                const result = data.chart?.result?.[0];
                if (result && result.meta) {
                    const name = result.meta.shortName || result.meta.symbol || cleanSymbol;
                    return {
                        symbol: cleanSymbol,
                        name: name.length > 20 ? name.substring(0, 20) + '...' : name,
                        type: 'custom'
                    };
                }
            }
        } catch (e) {
            console.warn(`[Market] Proxy ${proxy} failed for validation:`, e.message);
            continue;
        }
    }

    return null;
}

/**
 * Add a custom market
 * @param {string} symbol - Ticker symbol to add
 * @returns {Promise<Object>} Result object { success, market?, error? }
 */
async function addCustomMarket(symbol) {
    const validatedMarket = await validateTicker(symbol);

    if (!validatedMarket) {
        return { success: false, error: 'Invalid ticker symbol' };
    }

    if (validatedMarket.error) {
        return { success: false, error: validatedMarket.error };
    }

    const customMarkets = getCustomMarkets();
    customMarkets.push(validatedMarket);
    saveCustomMarkets(customMarkets);

    // Clear cache to force refetch with new market
    localStorage.removeItem(MARKET_CACHE_KEY);

    return { success: true, market: validatedMarket };
}

/**
 * Remove a custom market
 * @param {string} symbol - Ticker symbol to remove
 * @returns {boolean} True if removed
 */
function removeCustomMarket(symbol) {
    const customMarkets = getCustomMarkets();
    const filtered = customMarkets.filter(m => m.symbol !== symbol);

    if (filtered.length < customMarkets.length) {
        saveCustomMarkets(filtered);
        localStorage.removeItem(MARKET_CACHE_KEY);
        return true;
    }
    return false;
}

/**
 * Get the start date for an NFL week
 * @param {number} week - NFL week number (1-18)
 * @returns {Date} Start date of that week (Thursday)
 */
function getNFLWeekStartDate(week) {
    const SEASON_START = new Date('2025-09-04'); // Thursday of Week 1
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    return new Date(SEASON_START.getTime() + (week - 1) * msPerWeek);
}

/**
 * Weekly bankroll for the vs Market chart: $100 deposited each week, a flat
 * $20 on every Blazin' 5 pick at -110. The betting is calculateWinnings, so
 * this cannot drift from what the Standings tab shows.
 * @param {string} picker - Picker name
 * @returns {Array} Array of { week, bankroll, invested, returnPct } objects
 */
function calculatePickerWeeklyBankroll(picker) {
    const betPerPick = 20;
    const winnings = calculateWinnings(betPerPick, { pickers: [picker], firstWeek: 1, lastWeek: CURRENT_NFL_WEEK });
    const profitByWeek = new Map((winnings[picker]?.blazin?.byWeek || []).map(w => [w.week, w.profit]));

    const weeklyData = [];
    let totalInvested = 0;
    let bankroll = 0;
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        totalInvested += 100;
        bankroll += 100 + (profitByWeek.get(week) || 0);
        weeklyData.push({
            week,
            bankroll,
            invested: totalInvested,
            returnPct: ((bankroll - totalInvested) / totalInvested) * 100
        });
    }
    return weeklyData;
}

/**
 * Fetch market prices from APIs for all active markets
 * @param {boolean} forceRefresh - Skip cache and force fresh data
 * @returns {Promise<Object>} Market data keyed by symbol
 */
async function fetchMarketPrices(forceRefresh = false) {
    const activeMarkets = getActiveMarkets();

    // Check cache first (unless forcing refresh)
    if (!forceRefresh) {
        const cached = localStorage.getItem(MARKET_CACHE_KEY);
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < MARKET_CACHE_EXPIRY) {
                console.log('[Market] Using cached market data');
                marketDataState.lastUpdated = new Date(timestamp);
                // Check if all active markets are in cache
                const cachedSymbols = Object.keys(data);
                const missingMarkets = activeMarkets.filter(m =>
                    !cachedSymbols.includes(m.symbol) && m.symbol !== 'BTC'
                );
                if (missingMarkets.length === 0) {
                    return data;
                }
                console.log('[Market] Cache missing markets:', missingMarkets.map(m => m.symbol));
            }
        }
    }

    console.log('[Market] Fetching fresh market data...');
    marketDataState.loading = true;
    marketDataState.error = null;

    const marketData = {};
    let hasError = false;

    // Fetch Bitcoin from CoinGecko
    const btcMarket = activeMarkets.find(m => m.symbol === 'BTC');
    if (btcMarket) {
        try {
            const btcResponse = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=180&interval=daily');
            if (btcResponse.ok) {
                const btcData = await btcResponse.json();
                marketData['BTC'] = {
                    name: 'Bitcoin',
                    prices: btcData.prices.map(([timestamp, price]) => ({
                        date: new Date(timestamp),
                        price
                    }))
                };
            } else {
                hasError = true;
            }
        } catch (e) {
            console.warn('[Market] Failed to fetch Bitcoin prices:', e);
            hasError = true;
        }
    }

    // Fetch all Yahoo Finance symbols
    const yahooMarkets = activeMarkets.filter(m => m.symbol !== 'BTC');

    for (const market of yahooMarkets) {
        let fetched = false;

        for (const proxy of CORS_PROXIES) {
            if (fetched) break;

            try {
                const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${market.symbol}?interval=1d&range=6mo`)}`;
                const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

                if (response.ok) {
                    const data = await response.json();
                    const quotes = data.chart?.result?.[0];

                    if (quotes) {
                        const timestamps = quotes.timestamp || [];
                        const prices = quotes.indicators?.quote?.[0]?.close || [];
                        const priceData = timestamps.map((ts, i) => ({
                            date: new Date(ts * 1000),
                            price: prices[i]
                        })).filter(p => p.price != null);

                        marketData[market.symbol] = {
                            name: market.name,
                            prices: priceData
                        };
                        fetched = true;
                    }
                }
            } catch (e) {
                console.warn(`[Market] Proxy ${proxy} failed for ${market.symbol}:`, e.message);
                continue;
            }
        }

        if (!fetched) {
            console.warn(`[Market] All proxies failed for ${market.symbol}`);
            hasError = true;
        }
    }

    // Update state
    marketDataState.loading = false;
    marketDataState.lastUpdated = new Date();
    marketDataState.error = hasError ? 'Some market data could not be fetched' : null;
    marketDataState.data = marketData;

    // Cache the data
    localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify({
        data: marketData,
        timestamp: Date.now()
    }));

    localStorage.setItem(MARKET_LAST_UPDATED_KEY, marketDataState.lastUpdated.toISOString());

    return marketData;
}

/**
 * Get last updated timestamp
 * @returns {Date|null}
 */
function getMarketLastUpdated() {
    if (marketDataState.lastUpdated) {
        return marketDataState.lastUpdated;
    }
    const stored = localStorage.getItem(MARKET_LAST_UPDATED_KEY);
    return stored ? new Date(stored) : null;
}

/**
 * Get price for a specific date from price array
 * @param {Array} prices - Array of { date, price } objects
 * @param {Date} targetDate - Date to find price for
 * @returns {number|null} Price or null if not found
 */
function getPriceForDate(prices, targetDate) {
    if (!prices || prices.length === 0) return null;

    const targetTime = targetDate.getTime();
    let closest = null;
    let closestDiff = Infinity;

    for (const p of prices) {
        const diff = Math.abs(new Date(p.date).getTime() - targetTime);
        if (diff < closestDiff) {
            closestDiff = diff;
            closest = p;
        }
    }

    // Only return if within 3 days
    if (closestDiff < 3 * 24 * 60 * 60 * 1000) {
        return closest.price;
    }
    return null;
}

/**
 * Calculate DCA returns for a market
 * @param {Array} prices - Array of { date, price } objects
 * @param {number} weeklyInvestment - Amount to invest per week
 * @returns {Array} Array of { week, value, invested, returnPct } objects
 */
function calculateMarketDCA(prices, weeklyInvestment = 100) {
    const weeklyData = [];
    let totalShares = 0;
    let totalInvested = 0;

    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const weekDate = getNFLWeekStartDate(week);
        const priceAtWeek = getPriceForDate(prices, weekDate);

        totalInvested += weeklyInvestment;

        if (priceAtWeek) {
            // Buy shares at this week's price
            totalShares += weeklyInvestment / priceAtWeek;
        }

        // Value portfolio at THIS week's price (not final price)
        const currentValue = totalShares * (priceAtWeek || 0);

        weeklyData.push({
            week,
            value: currentValue,
            invested: totalInvested,
            returnPct: totalInvested > 0 ? ((currentValue - totalInvested) / totalInvested) * 100 : 0
        });
    }

    return weeklyData;
}

/**
 * Calculate final portfolio value at current/latest price
 * @param {Array} weeklyData - Weekly DCA data
 * @param {Array} prices - Price history
 * @returns {Object} Final value and return %
 */
function calculateFinalMarketValue(weeklyData, prices) {
    if (!weeklyData || weeklyData.length === 0 || !prices || prices.length === 0) {
        return { value: 0, returnPct: 0, invested: 0 };
    }

    const lastWeek = weeklyData[weeklyData.length - 1];
    const latestPrice = prices[prices.length - 1].price;

    // Calculate total shares from invested amount and weekly prices
    let totalShares = 0;
    for (let i = 0; i < weeklyData.length; i++) {
        const weekDate = getNFLWeekStartDate(i + 1);
        const priceAtWeek = getPriceForDate(prices, weekDate);
        if (priceAtWeek) {
            totalShares += 100 / priceAtWeek;
        }
    }

    const currentValue = totalShares * latestPrice;
    const invested = lastWeek.invested;

    return {
        value: currentValue,
        invested: invested,
        returnPct: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0
    };
}

/**
 * Get all comparison data (pickers + markets)
 * @param {boolean} forceRefresh - Force refresh market data
 * @returns {Promise<Object>} Comparison data
 */
async function getVsMarketData(forceRefresh = false) {
    const marketPrices = await fetchMarketPrices(forceRefresh);
    const activeMarkets = getActiveMarkets();

    // Calculate picker returns
    const pickerData = {};
    PICKERS.forEach(picker => {
        pickerData[picker] = calculatePickerWeeklyBankroll(picker);
    });

    // Calculate market returns (weekly values for chart) - keyed by symbol
    const marketReturns = {};
    const finalValues = {};

    for (const market of activeMarkets) {
        const priceData = marketPrices[market.symbol]?.prices || [];
        if (priceData.length > 0) {
            marketReturns[market.symbol] = {
                name: market.name,
                symbol: market.symbol,
                type: market.type,
                weekly: calculateMarketDCA(priceData)
            };
            finalValues[market.symbol] = {
                name: market.name,
                symbol: market.symbol,
                type: market.type,
                ...calculateFinalMarketValue(marketReturns[market.symbol].weekly, priceData)
            };
        }
    }

    return {
        pickerData,
        marketReturns,
        marketPrices,
        finalValues,
        activeMarkets,
        lastUpdated: marketDataState.lastUpdated,
        error: marketDataState.error
    };
}

// Track current market view
let currentMarketView = 'summary';

/**
 * Format timestamp for display
 * @param {Date} date
 * @returns {string}
 */
function formatMarketTimestamp(date) {
    if (!date) return 'Never';
    const now = new Date();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
}

/**
 * Get picker final return data
 * @param {Array} data - Weekly bankroll data
 * @returns {Object}
 */
function getPickerFinalReturn(data) {
    if (!data || data.length === 0) return { value: 0, returnPct: 0, invested: 0 };
    const last = data[data.length - 1];
    return {
        value: last.bankroll || last.value || 0,
        returnPct: last.returnPct || 0,
        invested: last.invested || 0
    };
}

/**
 * Show market status banner
 * @param {string} message
 * @param {string} type - 'error' or 'warning'
 */
function showMarketStatusBanner(message, type = 'error') {
    const banner = document.getElementById('market-status-banner');
    if (!banner) return;

    // Update message while keeping dismiss button
    banner.innerHTML = `
        <span class="message">${message}</span>
        <button class="dismiss-btn" onclick="this.parentElement.classList.remove('visible')">&times;</button>
    `;
    banner.className = `market-status-banner visible ${type}`;

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
        banner.classList.remove('visible');
    }, 10000);
}

/**
 * Render the vs Market section
 */
async function renderVsMarketSection() {
    const section = document.getElementById('vs-market-section');
    if (!section) return;

    // Show loading state
    section.innerHTML = `
        <div class="vs-market-loading">
            <div class="loading-spinner"></div>
            <p>Loading market data...</p>
        </div>
    `;

    try {
        const data = await getVsMarketData();
        renderVsMarketContent(section, data);
    } catch (error) {
        console.error('[Market] Error rendering vs market section:', error);
        section.innerHTML = `
            <div class="vs-market-error">
                <p>Failed to load market data. Please try again later.</p>
                <p style="font-size: 0.8rem; margin-top: 8px;">${error.message || ''}</p>
            </div>
        `;
    }
}

/**
 * Render the market content with data
 * @param {HTMLElement} section
 * @param {Object} data
 */
function renderVsMarketContent(section, data) {
    const { pickerData, marketReturns, finalValues, activeMarkets, lastUpdated, error } = data;
    const customMarkets = getCustomMarkets();

    // Calculate picker finals
    const pickerFinals = {};
    PICKERS.forEach(picker => {
        pickerFinals[picker] = getPickerFinalReturn(pickerData[picker]);
    });

    // Find best performer (picker or market)
    let bestPerformer = { name: '', returnPct: -Infinity, type: 'picker' };

    // Check pickers
    PICKERS.forEach(picker => {
        if (pickerFinals[picker].returnPct > bestPerformer.returnPct) {
            bestPerformer = { name: picker, returnPct: pickerFinals[picker].returnPct, type: 'picker' };
        }
    });

    // Check markets
    Object.values(finalValues).forEach(market => {
        if (market.returnPct > bestPerformer.returnPct) {
            bestPerformer = { name: market.name, returnPct: market.returnPct, type: 'market' };
        }
    });

    // Build leaderboard
    const leaderboard = [
        ...Object.values(finalValues).map(m => ({
            name: m.name,
            symbol: m.symbol,
            type: 'market',
            returnPct: m.returnPct || 0,
            value: m.value || 0,
            invested: m.invested || 0
        })),
        ...PICKERS.map(picker => ({
            name: picker,
            type: 'picker',
            ...pickerFinals[picker]
        }))
    ].sort((a, b) => b.returnPct - a.returnPct);

    // Generate ticker strip HTML - focus on P&L
    const tickerHtml = [
        ...Object.values(finalValues).map(m => {
            const pnl = m.value - m.invested;
            return `
                <div class="ticker-item">
                    <span class="ticker-symbol">${m.symbol || m.name}</span>
                    <span class="ticker-pnl ${pnl >= 0 ? 'positive' : 'negative'}">
                        ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                    </span>
                    <span class="ticker-change ${m.returnPct >= 0 ? 'positive' : 'negative'}">
                        ${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(1)}%
                    </span>
                </div>
            `;
        }),
        ...PICKERS.map(picker => {
            const f = pickerFinals[picker];
            const pnl = f.value - f.invested;
            return `
                <div class="ticker-item picker">
                    <span class="ticker-symbol">${picker}</span>
                    <span class="ticker-pnl ${pnl >= 0 ? 'positive' : 'negative'}">
                        ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                    </span>
                    <span class="ticker-change ${f.returnPct >= 0 ? 'positive' : 'negative'}">
                        ${f.returnPct >= 0 ? '+' : ''}${f.returnPct.toFixed(1)}%
                    </span>
                </div>
            `;
        })
    ].join('');

    // Generate market chips HTML - all markets can be removed
    const hiddenDefaults = getHiddenDefaults();
    const visibleDefaults = DEFAULT_MARKETS.filter(m => !hiddenDefaults.includes(m.symbol));
    const hiddenDefaultMarkets = DEFAULT_MARKETS.filter(m => hiddenDefaults.includes(m.symbol));

    const chipsHtml = [
        // Visible default markets (can be removed)
        ...visibleDefaults.map(m => `
            <span class="market-chip default">
                ${m.name}
                <button class="remove-btn" data-symbol="${m.symbol}" data-type="default" title="Remove">&times;</button>
            </span>
        `),
        // Custom markets (can be removed)
        ...customMarkets.map(m => `
            <span class="market-chip custom">
                ${m.name}
                <button class="remove-btn" data-symbol="${m.symbol}" data-type="custom" title="Remove">&times;</button>
            </span>
        `),
        // Hidden defaults (can be restored)
        ...hiddenDefaultMarkets.map(m => `
            <span class="market-chip hidden">
                ${m.name}
                <button class="restore-btn" data-symbol="${m.symbol}" title="Restore">+</button>
            </span>
        `)
    ].join('');

    // Generate leaderboard rows HTML - P&L first for emphasis
    const leaderboardHtml = leaderboard.map((item, i) => {
        const pnl = item.value - item.invested;
        const typeLabel = item.type === 'picker' ? 'Picker' : 'Market';
        return `
            <tr class="${item.type}">
                <td class="rank">${i + 1}</td>
                <td class="type-cell"><span class="type-badge ${item.type}">${typeLabel}</span></td>
                <td class="name">
                    ${item.name}
                    ${item.symbol ? `<span class="symbol">${item.symbol}</span>` : ''}
                </td>
                <td class="pnl-main ${pnl >= 0 ? 'positive' : 'negative'}">
                    ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
                </td>
                <td class="return ${item.returnPct >= 0 ? 'positive' : 'negative'}">
                    ${item.returnPct >= 0 ? '+' : ''}${item.returnPct.toFixed(1)}%
                </td>
                <td class="value">$${item.value.toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    // Generate picker cards HTML
    const pickerCardsHtml = PICKERS.map(picker => {
        const f = pickerFinals[picker];
        const isBest = picker === bestPerformer.name;
        const pnl = f.value - f.invested;
        return `
            <div class="market-card ${isBest ? 'best-performer' : ''}">
                <div class="market-card-header">
                    <span class="market-card-name">${picker}</span>
                    <span class="market-card-type picker">Picker</span>
                </div>
                <div class="market-card-pnl ${pnl >= 0 ? 'positive' : 'negative'}">
                    ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
                </div>
                <div class="market-card-return-small ${f.returnPct >= 0 ? 'positive' : 'negative'}">
                    ${f.returnPct >= 0 ? '+' : ''}${f.returnPct.toFixed(1)}%
                </div>
                <div class="market-card-details">
                    <span class="market-card-value">$${f.value.toFixed(2)}</span>
                    <span class="market-card-invested">invested $${f.invested.toFixed(0)}</span>
                </div>
            </div>
        `;
    }).join('');

    // Generate market cards HTML
    const marketCardsHtml = Object.values(finalValues).map(m => {
        const isBest = m.name === bestPerformer.name;
        const pnl = m.value - m.invested;
        return `
            <div class="market-card ${isBest ? 'best-performer' : ''}">
                <div class="market-card-header">
                    <span class="market-card-name">${m.name}</span>
                    <span class="market-card-type market">Market</span>
                </div>
                <div class="market-card-pnl ${pnl >= 0 ? 'positive' : 'negative'}">
                    ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
                </div>
                <div class="market-card-return-small ${m.returnPct >= 0 ? 'positive' : 'negative'}">
                    ${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(1)}%
                </div>
                <div class="market-card-details">
                    <span class="market-card-value">$${m.value.toFixed(2)}</span>
                    <span class="market-card-invested">invested $${m.invested.toFixed(0)}</span>
                </div>
            </div>
        `;
    }).join('');

    // Render main HTML
    section.innerHTML = `
        <div class="market-header">
            <div class="market-header-left">
                <h2>vs Market</h2>
                <p class="market-subtitle">Blazin' 5 picks ($20/pick) vs. investing $100/week</p>
            </div>
            <div class="market-header-right">
                <span class="market-last-updated">Updated: ${formatMarketTimestamp(lastUpdated)}</span>
                <button class="market-refresh-btn" id="market-refresh-btn">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                        <path d="M16 16h5v5"/>
                    </svg>
                    Refresh
                </button>
            </div>
        </div>

        <details class="how-it-works-box">
            <summary class="how-it-works-toggle">How It Works</summary>
            <div class="how-it-works-content">
                <div class="how-it-works-column">
                    <div class="how-it-works-title">Pickers (Betting)</div>
                    <p>$20 bet on each Blazin' 5 pick (5 picks/week = $100/week)</p>
                    <ul>
                        <li>Wins pay at -110 odds (~$18.18 profit per win)</li>
                        <li>Losses cost $20 each</li>
                    </ul>
                </div>
                <div class="how-it-works-column">
                    <div class="how-it-works-title">Markets (Investing)</div>
                    <p>$100/week invested (dollar-cost averaging)</p>
                    <ul>
                        <li>Buy shares at each week's price</li>
                        <li>Value = total shares × current price</li>
                    </ul>
                </div>
            </div>
        </details>

        <div id="market-status-banner" class="market-status-banner">
            <span class="message"></span>
            <button class="dismiss-btn">&times;</button>
        </div>

        <div class="market-view-tabs">
            <button class="market-view-tab ${currentMarketView === 'summary' ? 'active' : ''}" data-view="summary">Summary</button>
            <button class="market-view-tab ${currentMarketView === 'weekly' ? 'active' : ''}" data-view="weekly">Weekly Breakdown</button>
        </div>

        <div class="summary-view ${currentMarketView === 'summary' ? 'active' : ''}">
            <div class="market-ticker-strip">
                ${tickerHtml}
            </div>

            <div class="card-sections-container">
                <div class="card-section">
                    <div class="card-section-header">
                        <span class="card-section-title">Pickers</span>
                        <span class="card-section-subtitle">$20/pick betting strategy</span>
                    </div>
                    <div class="market-summary-grid">
                        ${pickerCardsHtml}
                    </div>
                </div>
                <div class="card-section">
                    <div class="card-section-header">
                        <span class="card-section-title">Markets</span>
                        <span class="card-section-subtitle">$100/week investing strategy</span>
                    </div>
                    <div class="market-summary-grid">
                        ${marketCardsHtml}
                    </div>
                </div>
            </div>

            <div class="add-market-container">
                <div class="add-market-header">Add Custom Market</div>
                <div class="add-market-form">
                    <input type="text" class="add-market-input" id="add-market-input" placeholder="e.g. AAPL, QQQ, TSLA" maxlength="10">
                    <button class="add-market-btn" id="add-market-btn">Add Market</button>
                </div>
                <div class="market-chips">
                    ${chipsHtml}
                </div>
                <div class="add-market-error" id="add-market-error"></div>
            </div>

            <div class="vs-market-chart-container">
                <div class="chart-header">
                    <h3>Profit Over Time</h3>
                    <div class="chart-filters">
                        <button class="chart-filter-btn active" data-filter="all">All</button>
                        <button class="chart-filter-btn" data-filter="markets">Markets</button>
                        <button class="chart-filter-btn" data-filter="pickers">Pickers</button>
                    </div>
                </div>
                <canvas id="vs-market-chart"></canvas>
                <div class="chart-legend-note">
                    <span class="legend-line solid"></span> Pickers (solid)
                    <span class="legend-line dotted"></span> Markets (dotted)
                </div>
            </div>

            <div class="vs-market-leaderboard">
                <h3>Rankings</h3>
                <table class="vs-market-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Type</th>
                            <th>Name</th>
                            <th>Profit</th>
                            <th>Return</th>
                            <th>Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${leaderboardHtml}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="weekly-breakdown-view ${currentMarketView === 'weekly' ? 'active' : ''}" id="weekly-breakdown-view">
            <!-- Will be rendered by renderWeeklyBreakdown -->
        </div>
    `;

    // Show error banner if needed
    if (error) {
        showMarketStatusBanner(error, 'warning');
    }

    // Render chart
    renderVsMarketChart(pickerData, marketReturns);

    // Render weekly breakdown
    renderWeeklyBreakdown(pickerData, marketReturns);

    // Setup event listeners
    setupMarketEventListeners(data);
}

/**
 * Setup event listeners for market section
 * @param {Object} data - Market data
 */
function setupMarketEventListeners(data) {
    // Refresh button
    const refreshBtn = document.getElementById('market-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.classList.add('loading');
            refreshBtn.disabled = true;

            try {
                const newData = await getVsMarketData(true);
                const section = document.getElementById('vs-market-section');
                if (section) {
                    renderVsMarketContent(section, newData);
                }
            } catch (error) {
                showMarketStatusBanner('Failed to refresh market data', 'error');
            } finally {
                const btn = document.getElementById('market-refresh-btn');
                if (btn) {
                    btn.classList.remove('loading');
                    btn.disabled = false;
                }
            }
        });
    }

    // View tabs
    document.querySelectorAll('.market-view-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.view;
            switchMarketView(view);
        });
    });

    // Add market form
    const addMarketBtn = document.getElementById('add-market-btn');
    const addMarketInput = document.getElementById('add-market-input');

    if (addMarketBtn && addMarketInput) {
        addMarketBtn.addEventListener('click', () => handleAddMarket(addMarketInput.value));

        addMarketInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleAddMarket(addMarketInput.value);
            }
        });
    }

    // Remove market buttons (handles both default and custom)
    document.querySelectorAll('.market-chip .remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const symbol = btn.dataset.symbol;
            const type = btn.dataset.type;

            if (!symbol) return;

            let removed = false;
            if (type === 'default') {
                removed = hideDefaultMarket(symbol);
            } else {
                removed = removeCustomMarket(symbol);
            }

            if (removed) {
                renderVsMarketSection();
            }
        });
    });

    // Restore hidden default market buttons
    document.querySelectorAll('.market-chip .restore-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const symbol = btn.dataset.symbol;
            if (symbol && restoreDefaultMarket(symbol)) {
                renderVsMarketSection();
            }
        });
    });

    // Chart filter buttons
    document.querySelectorAll('.chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterChartDatasets(btn.dataset.filter);
        });
    });

    // Status banner dismiss
    const dismissBtn = document.querySelector('.market-status-banner .dismiss-btn');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
            document.getElementById('market-status-banner')?.classList.remove('visible');
        });
    }
}

/**
 * Handle adding a custom market
 * @param {string} symbol
 */
async function handleAddMarket(symbol) {
    const input = document.getElementById('add-market-input');
    const errorDiv = document.getElementById('add-market-error');
    const btn = document.getElementById('add-market-btn');

    if (!symbol || !symbol.trim()) {
        if (errorDiv) errorDiv.textContent = 'Please enter a ticker symbol';
        return;
    }

    if (btn) btn.disabled = true;
    if (errorDiv) errorDiv.textContent = '';

    try {
        const result = await addCustomMarket(symbol);

        if (result.success) {
            if (input) input.value = '';
            renderVsMarketSection();
        } else {
            if (errorDiv) errorDiv.textContent = result.error || 'Failed to add market';
        }
    } catch (error) {
        if (errorDiv) errorDiv.textContent = 'Failed to validate ticker';
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Switch between summary and weekly views
 * @param {string} view - 'summary' or 'weekly'
 */
function switchMarketView(view) {
    currentMarketView = view;

    // Update tabs
    document.querySelectorAll('.market-view-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
    });

    // Update views
    document.querySelector('.summary-view')?.classList.toggle('active', view === 'summary');
    document.querySelector('.weekly-breakdown-view')?.classList.toggle('active', view === 'weekly');
}

/**
 * Filter chart datasets by type
 * @param {string} filter - 'all', 'markets', or 'pickers'
 */
function filterChartDatasets(filter) {
    if (!window.vsMarketChart) return;

    window.vsMarketChart.data.datasets.forEach((dataset, index) => {
        const meta = window.vsMarketChart.getDatasetMeta(index);
        const isMarket = dataset.isMarket;
        const isBaseline = dataset.label === 'Total Invested';

        if (filter === 'all') {
            meta.hidden = false;
        } else if (filter === 'markets') {
            meta.hidden = !isMarket && !isBaseline;
        } else if (filter === 'pickers') {
            meta.hidden = isMarket;
        }
    });

    window.vsMarketChart.update();
}

/**
 * Render the comparison chart
 * @param {Object} pickerData
 * @param {Object} marketReturns
 */
function renderVsMarketChart(pickerData, marketReturns) {
    const canvas = document.getElementById('vs-market-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Regular season only (weeks 1-18)
    const REGULAR_SEASON_WEEKS = 18;
    const maxWeeks = Math.min(CURRENT_NFL_WEEK, REGULAR_SEASON_WEEKS);

    // Prepare datasets - showing PROFIT (value - invested), not total value
    const weeks = Array.from({ length: maxWeeks }, (_, i) => `Week ${i + 1}`);

    // Market colors
    const marketColors = {
        '^GSPC': '#3b82f6',
        'GC=F': '#eab308',
        'BTC': '#f97316',
        // Custom markets get generated colors
    };

    const customColors = ['#ec4899', '#14b8a6', '#8b5cf6', '#f43f5e', '#06b6d4'];
    let customColorIndex = 0;

    const datasets = [];

    // Add breakeven baseline (dotted gray line at $0)
    const breakevenLine = Array.from({ length: maxWeeks }, () => 0);
    datasets.push({
        label: 'Breakeven',
        data: breakevenLine,
        borderColor: '#6b7280',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [4, 4],
        tension: 0,
        pointRadius: 0,
        isMarket: false,
        order: 999 // Draw behind other lines
    });

    // Add market datasets - plot PROFIT (value - invested) - DOTTED lines
    Object.entries(marketReturns).forEach(([symbol, marketData]) => {
        let color = marketColors[symbol];
        if (!color) {
            color = customColors[customColorIndex % customColors.length];
            customColorIndex++;
        }

        // Limit to regular season
        const regularSeasonData = marketData.weekly.slice(0, REGULAR_SEASON_WEEKS);

        datasets.push({
            label: marketData.name,
            data: regularSeasonData.map(d => d.value - d.invested), // PROFIT
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [5, 5], // Dotted for markets
            tension: 0.3,
            pointRadius: 0,
            isMarket: true
        });
    });

    // Picker colors
    const pickerColors = {
        'Stephen': '#3b82f6',
        'Sean': '#059669',
        'Dylan': '#8b5cf6',
        'Jason': '#f97316',
        'Daniel': '#06b6d4'
    };

    // Add picker datasets - plot PROFIT (bankroll - invested) - SOLID lines
    PICKERS.forEach(picker => {
        if (pickerData[picker]) {
            // Limit to regular season
            const regularSeasonData = pickerData[picker].slice(0, REGULAR_SEASON_WEEKS);

            datasets.push({
                label: picker,
                data: regularSeasonData.map(d => d.bankroll - d.invested), // PROFIT
                borderColor: pickerColors[picker] || '#6b7280',
                backgroundColor: (pickerColors[picker] || '#6b7280') + '1A', // 10% opacity
                borderWidth: 3,
                tension: 0.3,
                pointRadius: 0,
                isMarket: false
            });
        }
    });

    // Destroy existing chart if any
    if (window.vsMarketChart) {
        window.vsMarketChart.destroy();
    }

    window.vsMarketChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: weeks,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        padding: 20
                    }
                },
                tooltip: {
                    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim() || '#ffffff',
                    titleColor: getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#0a0a0a',
                    bodyColor: getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#0a0a0a',
                    borderColor: getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#e5e7eb',
                    borderWidth: 1,
                    titleFont: { family: "'Inter', sans-serif", weight: '700', size: 13 },
                    bodyFont: { family: "'SF Mono', 'Monaco', 'Consolas', monospace", size: 12 },
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true,
                    boxPadding: 4,
                    filter: function(tooltipItem) {
                        // Hide breakeven line from tooltip
                        return tooltipItem.dataset.label !== 'Breakeven';
                    },
                    callbacks: {
                        label: function(context) {
                            const profit = context.raw || 0;
                            const sign = profit >= 0 ? '+' : '';
                            return ` ${context.dataset.label}: ${sign}$${profit.toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    grid: {
                        color: function(context) {
                            // Highlight zero line
                            if (context.tick.value === 0) {
                                return 'rgba(128, 128, 128, 0.4)';
                            }
                            return 'rgba(128, 128, 128, 0.1)';
                        }
                    },
                    ticks: {
                        callback: function(value) {
                            const sign = value >= 0 ? '+' : '';
                            return `${sign}$${value}`;
                        }
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

/**
 * Render the weekly breakdown table
 * Shows week-by-week % changes for each picker and market
 * Regular season only (weeks 1-18)
 * @param {Object} pickerData
 * @param {Object} marketReturns
 */
function renderWeeklyBreakdown(pickerData, marketReturns) {
    const container = document.getElementById('weekly-breakdown-view');
    if (!container) return;

    // Regular season is weeks 1-18
    const REGULAR_SEASON_WEEKS = 18;
    const maxWeeks = Math.min(CURRENT_NFL_WEEK, REGULAR_SEASON_WEEKS);

    // Build rows data - each row is a picker or market
    const rows = [];

    // Add market rows
    Object.entries(marketReturns).forEach(([symbol, marketData]) => {
        const weeklyChanges = [];
        let prevValue = 100; // Starting investment

        // Only include regular season weeks
        const regularSeasonData = marketData.weekly.slice(0, REGULAR_SEASON_WEEKS);

        regularSeasonData.forEach((week, i) => {
            const weeklyInvestment = 100;
            const expectedValue = (i + 1) * weeklyInvestment;
            const weeklyReturn = expectedValue > 0 ? ((week.value - expectedValue) / expectedValue) * 100 : 0;

            // Calculate week-over-week change
            let weekChange = 0;
            if (i === 0) {
                weekChange = weeklyReturn;
            } else {
                const prevWeekValue = regularSeasonData[i - 1].value;
                const prevExpected = i * weeklyInvestment;
                const prevReturn = prevExpected > 0 ? ((prevWeekValue - prevExpected) / prevExpected) * 100 : 0;
                weekChange = weeklyReturn - prevReturn;
            }

            weeklyChanges.push({
                week: i + 1,
                value: week.value,
                returnPct: weeklyReturn,
                change: weekChange
            });
        });

        const lastWeek = regularSeasonData[regularSeasonData.length - 1];
        rows.push({
            name: marketData.name,
            symbol: symbol,
            type: 'market',
            weeklyChanges,
            totalReturn: lastWeek?.returnPct || 0,
            finalValue: lastWeek?.value || 0
        });
    });

    // Add picker rows
    PICKERS.forEach(picker => {
        const data = pickerData[picker];
        if (!data) return;

        // Only include regular season weeks
        const regularSeasonData = data.slice(0, REGULAR_SEASON_WEEKS);
        const weeklyChanges = [];

        regularSeasonData.forEach((week, i) => {
            let weekChange = 0;
            if (i === 0) {
                weekChange = week.returnPct;
            } else {
                weekChange = week.returnPct - regularSeasonData[i - 1].returnPct;
            }

            weeklyChanges.push({
                week: i + 1,
                value: week.bankroll,
                returnPct: week.returnPct,
                change: weekChange
            });
        });

        const lastWeek = regularSeasonData[regularSeasonData.length - 1];
        rows.push({
            name: picker,
            type: 'picker',
            weeklyChanges,
            totalReturn: lastWeek?.returnPct || 0,
            finalValue: lastWeek?.bankroll || 0
        });
    });

    // Sort by total return descending
    rows.sort((a, b) => b.totalReturn - a.totalReturn);

    // Generate table HTML - regular season weeks only (1-18)
    const weekHeaders = Array.from({ length: maxWeeks }, (_, i) => `
        <th class="week-cell">W${i + 1}</th>
    `).join('');

    const tableRows = rows.map(row => {
        const weekCells = row.weeklyChanges.map(w => {
            const changeClass = w.change >= 0 ? 'positive' : 'negative';
            const sign = w.change >= 0 ? '+' : '';
            return `<td class="week-cell ${changeClass}">${sign}${w.change.toFixed(1)}%</td>`;
        }).join('');

        const totalClass = row.totalReturn >= 0 ? 'positive' : 'negative';
        const totalSign = row.totalReturn >= 0 ? '+' : '';
        const typeLabel = row.type === 'picker' ? 'Picker' : 'Market';

        return `
            <tr class="${row.type}-row">
                <td class="type-cell"><span class="type-badge ${row.type}">${typeLabel}</span></td>
                <td>${row.name}</td>
                ${weekCells}
                <td class="total-cell ${totalClass}">${totalSign}${row.totalReturn.toFixed(1)}%</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="weekly-breakdown-table-container">
            <table class="weekly-breakdown-table">
                <thead>
                    <tr>
                        <th class="type-header">Type</th>
                        <th>Name</th>
                        ${weekHeaders}
                        <th class="total-cell">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>
    `;
}

// Initialize when DOM is ready
/**
 * Publish the sticky tab bar's height as --tabs-height, so anything that parks
 * under it (the Blazin' 5 counter) lands flush instead of guessing at a number
 * that changes with the viewport - the tabs are shorter on mobile.
 */
function trackTabsHeight() {
    const tabs = document.querySelector('.category-tabs');
    if (!tabs) return;

    const measure = () => {
        const height = Math.round(tabs.getBoundingClientRect().height);
        if (height > 0) document.documentElement.style.setProperty('--tabs-height', height + 'px');
    };

    measure();
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(measure).observe(tabs);
    } else {
        window.addEventListener('resize', measure);
    }
}

document.addEventListener('DOMContentLoaded', init);

/**
 * Export current data to historical-data.js format
 * Call this from the browser console after data loads: exportHistoricalData()
 */
window.exportHistoricalData = function() {
    const output = {
        games: {},
        results: {},
        picks: {}
    };

    // Export games
    for (let week = 1; week <= 18; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        if (games && games.length > 0) {
            output.games[week] = games.map(g => ({
                id: g.id,
                away: g.away,
                home: g.home,
                // null, not 0: an archived season must not come back with its
                // missing lines indistinguishable from its pick'ems.
                spread: hasUsableLine(g.spread) ? Number(g.spread) : null,
                favorite: hasUsableLine(g.spread) ? (g.favorite || null) : null
            }));
        }
    }

    // Export results
    for (let week = 1; week <= 18; week++) {
        const results = NFL_RESULTS_BY_WEEK[week];
        if (results && Object.keys(results).length > 0) {
            output.results[week] = {};
            for (const gameId in results) {
                const r = results[gameId];
                output.results[week][gameId] = {
                    awayScore: r.awayScore,
                    homeScore: r.homeScore,
                    winner: r.winner
                };
            }
        }
    }

    // Export picks (merge allPicks and weeklyPicksCache)
    for (let week = 1; week <= 18; week++) {
        output.picks[week] = {};

        // Cowherd included: his picks are stored like anyone else's, and a
        // snapshot without them loses the week's Blazin' 5 opposition.
        PICKERS_WITH_COWHERD.forEach(picker => {
            const pickerPicks = allPicks[week]?.[picker] || {};
            const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

            // Merge both sources
            const mergedPicks = {};

            // First add from allPicks
            for (const gameId in pickerPicks) {
                const pick = pickerPicks[gameId];
                mergedPicks[gameId] = {
                    line: pick.line,
                    winner: pick.winner
                };
                // This export is a field whitelist, so anything not copied here
                // is lost when the season is archived.
                if (pick.overUnder) mergedPicks[gameId].overUnder = pick.overUnder;
                if (pick.totalLine) mergedPicks[gameId].totalLine = pick.totalLine;
                if (pick.frozenAt) {
                    mergedPicks[gameId].frozenAt = pick.frozenAt;
                    mergedPicks[gameId].frozenSpread = pick.frozenSpread;
                    mergedPicks[gameId].frozenFavorite = pick.frozenFavorite;
                    if (pick.frozenOverUnder !== undefined) {
                        mergedPicks[gameId].frozenOverUnder = pick.frozenOverUnder;
                    }
                }
                if (pick.blazin) {
                    mergedPicks[gameId].blazin = true;
                    if (pick.blazinTeam) mergedPicks[gameId].blazinTeam = pick.blazinTeam;
                }
            }

            // Then merge from cache (may have blazin info)
            for (const gameId in cachedPicks) {
                const pick = cachedPicks[gameId];
                if (!mergedPicks[gameId]) {
                    mergedPicks[gameId] = {
                        line: pick.line,
                        winner: pick.winner
                    };
                }
                if (pick.blazin) {
                    mergedPicks[gameId].blazin = true;
                    if (pick.blazinTeam) mergedPicks[gameId].blazinTeam = pick.blazinTeam;
                }
            }

            if (Object.keys(mergedPicks).length > 0) {
                output.picks[week][picker] = mergedPicks;
            }
        });
    }

    // Generate JavaScript code
    let jsCode = `// In-season snapshot of the ${CURRENT_SEASON} season's games/results/picks.
// Auto-generated with exportHistoricalData() on ${new Date().toISOString().split('T')[0]}
// HISTORICAL_DATA_SEASON lets app.js clear this data automatically once the season rolls over.

const HISTORICAL_DATA_SEASON = ${CURRENT_SEASON};

const HISTORICAL_GAMES = ${JSON.stringify(output.games, null, 4)};

const HISTORICAL_RESULTS = ${JSON.stringify(output.results, null, 4)};

const HISTORICAL_PICKS = ${JSON.stringify(output.picks, null, 4)};

// Note: The merge logic is now handled directly in app.js
// Historical data is merged when app.js loads (before init())
`;

    console.log('=== COPY EVERYTHING BELOW THIS LINE ===');
    console.log(jsCode);
    console.log('=== COPY EVERYTHING ABOVE THIS LINE ===');

    // Also copy to clipboard if possible
    if (navigator.clipboard) {
        navigator.clipboard.writeText(jsCode).then(() => {
            console.log('Code copied to clipboard!');
        }).catch(err => {
            console.log('Could not copy to clipboard:', err);
        });
    }

    return output;
};

/**
 * Print this season's Cowherd block for the offseason archive, ready to paste
 * into historical-<year>.js next to SEASON_<year>_DATA.
 *
 * The archives store his Blazin' 5 as a week-by-week record rather than as
 * picks, which is the one piece of the rollover that cannot be derived once
 * the season's picks are cleared. Run it in the browser console before then.
 */
window.exportCowherdResults = function() {
    const weekly = cowherdWeeklyResults(CURRENT_SEASON);
    if (!weekly) {
        console.log(`No Cowherd picks scored for ${CURRENT_SEASON} yet.`);
        return null;
    }

    const total = totalCowherdRecord(weekly);
    const jsCode = `// Cowherd's ${CURRENT_SEASON} Blazin' 5 results `
        + `(${total.wins}-${total.losses}${total.pushes ? `-${total.pushes}` : ''})\n`
        + `const COWHERD_${CURRENT_SEASON}_RESULTS = ${JSON.stringify(weekly, null, 2)};\n\n`
        + `if (typeof window !== 'undefined') {\n`
        + `    window.COWHERD_${CURRENT_SEASON}_RESULTS = COWHERD_${CURRENT_SEASON}_RESULTS;\n}`;

    console.log('=== COPY EVERYTHING BELOW THIS LINE ===');
    console.log(jsCode);
    console.log('=== COPY EVERYTHING ABOVE THIS LINE ===');
    if (navigator.clipboard) {
        navigator.clipboard.writeText(jsCode).catch(() => {});
    }
    return weekly;
};

/**
 * Export 2024 season data from the 2024 Google Sheet
 * Run this in the browser console: await export2024SeasonData()
 */
window.export2024SeasonData = async function() {
    const SHEET_2024_ID = '129rK45ReRLEbOpFvhFJ1gWLKlXnbbbe29hi53O7EGoQ';

    // GIDs for each week tab in the 2024 sheet
    const WEEK_GIDS_2024 = {
        1: '1734615654',
        2: '1689030244',
        3: '1682701664',
        4: '64532151',
        5: '1746053715',
        6: '198483855',
        7: '1162901378',
        8: '2082913151',
        9: '1101281524',
        10: '238951705',
        11: '323147745',
        12: '1165295828',
        13: '1809558420',
        14: '1764593710',
        15: '1886857596',
        16: '1562551321',
        17: '235789853',
        18: '2065335001',
        playoffs: '1441027737'
    };

    const output = {
        games: {},
        results: {},
        picks: {}
    };

    console.log('=== Exporting 2024 Season Data ===');

    // Fetch each regular season week
    for (let week = 1; week <= 18; week++) {
        const gid = WEEK_GIDS_2024[week];
        console.log(`Fetching week ${week}...`);

        try {
            const url = `https://docs.google.com/spreadsheets/d/${SHEET_2024_ID}/export?format=csv&gid=${gid}`;
            const response = await fetch(`${WORKER_PROXY_URL}/sheets?url=${encodeURIComponent(url)}`);

            if (!response.ok) {
                console.warn(`Failed to fetch week ${week}: ${response.status}`);
                continue;
            }

            const csvText = await response.text();
            const weekData = parseWeeklyPicksCSV(csvText, week);

            if (weekData) {
                output.games[week] = weekData.games || [];
                output.results[week] = weekData.results || {};
                output.picks[week] = weekData.picks || {};
                console.log(`  Week ${week}: ${weekData.games?.length || 0} games`);
            }
        } catch (err) {
            console.error(`Error fetching week ${week}:`, err);
        }
    }

    // Fetch playoffs (single tab with all playoff games)
    console.log('Fetching playoffs...');
    try {
        const playoffsGid = WEEK_GIDS_2024.playoffs;
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_2024_ID}/export?format=csv&gid=${playoffsGid}`;
        const response = await fetch(`${WORKER_PROXY_URL}/sheets?url=${encodeURIComponent(url)}`);

        if (response.ok) {
            const csvText = await response.text();
            // Log the raw CSV so we can see the playoff format
            console.log('Playoff CSV preview (first 2000 chars):');
            console.log(csvText.substring(0, 2000));
            console.log('');
            console.log('Playoff data will need manual parsing - see CSV above');
        }
    } catch (err) {
        console.error('Error fetching playoffs:', err);
    }

    // Generate the JavaScript file content
    const jsCode = `// Historical NFL Picks Data - 2024 Season
// Auto-generated on ${new Date().toISOString().split('T')[0]}

const SEASON_2024_DATA = {
    games: ${JSON.stringify(output.games, null, 4)},
    results: ${JSON.stringify(output.results, null, 4)},
    picks: ${JSON.stringify(output.picks, null, 4)}
};

window.SEASON_2024_DATA = SEASON_2024_DATA;
`;

    console.log('');
    console.log('=== COPY EVERYTHING BELOW THIS LINE ===');
    console.log(jsCode);
    console.log('=== COPY EVERYTHING ABOVE THIS LINE ===');

    // Copy to clipboard
    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(jsCode);
            console.log('');
            console.log('Code copied to clipboard! Save it as historical-2024.js');
        } catch (err) {
            console.log('Could not copy to clipboard:', err);
        }
    }

    return output;
};
