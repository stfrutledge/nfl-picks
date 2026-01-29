/**
 * NFL Picks Dashboard - Main Application
 */

// Cloudflare Worker Proxy URL - handles all external API calls (Odds API, Google Sheets, sync)
// Deploy nfl-picks-proxy.js to Cloudflare Workers and set this URL
const WORKER_PROXY_URL = 'https://nfl-picks-proxy.stfrutledge.workers.dev';

// Google Apps Script URL (legacy - now proxied through worker)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzCHuKNnwrPzu1noWrJS7i4BGo5UUnKKFQ_uN0hljS0KSfigusJQjuyearqRt-xGx31/exec';

// Track pending syncs to avoid duplicate requests
let pendingSyncTimeout = null;
const SYNC_DEBOUNCE_MS = 2000; // Wait 2 seconds after last change before syncing

let dashboardData = null;
let currentCategory = 'make-picks';
let currentSubcategory = 'blazin'; // Default standings subcategory
let currentPicker = localStorage.getItem('selectedPicker') || null;
let currentWeek = null; // Will be set to CURRENT_NFL_WEEK after it's calculated
let allPicks = {}; // Store picks for all pickers: { week: { picker: { gameId: { line: 'away'|'home', winner: 'away'|'home' } } } }
let clearedPicks = JSON.parse(localStorage.getItem('clearedPicks') || '{}'); // Track intentionally cleared picks: { week: { picker: true } }
let backupFetchedThisSession = false; // Only fetch all picks from backup once per session
let resultsFetchedThisSession = false; // Only fetch results from backup once per session
let resultsSyncedGames = {}; // Track which games have had results synced to avoid duplicates
let initialLoadComplete = false; // Track whether initial data load is complete

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
 * Calculate current NFL week based on date
 * 2025 NFL Season: Week 1 started September 4, 2025
 * Playoffs: Wild Card (Jan 10), Divisional (Jan 17), Conference (Jan 25), Super Bowl (Feb 8)
 */
function calculateCurrentNFLWeek() {
    const SEASON_START = new Date('2025-09-02T00:00:00'); // Tuesday before Week 1
    const REGULAR_SEASON_END = new Date('2026-01-06T00:00:00'); // Day after Week 18 games
    const WILD_CARD_START = new Date('2026-01-10T00:00:00');
    const DIVISIONAL_START = new Date('2026-01-17T00:00:00');
    const CONFERENCE_START = new Date('2026-01-25T00:00:00');
    const SUPER_BOWL_START = new Date('2026-01-26T00:00:00'); // Start showing Super Bowl after Conference Championship games
    const SUPER_BOWL_END = new Date('2026-02-09T00:00:00');
    const now = new Date();

    // If before season start, return week 1
    if (now < SEASON_START) return 1;

    // Playoff weeks
    if (now >= SUPER_BOWL_END) return 23; // Season completely over
    if (now >= SUPER_BOWL_START) return 22; // Super Bowl
    if (now >= CONFERENCE_START) return 21; // Conference Championships
    if (now >= DIVISIONAL_START) return 20; // Divisional
    if (now >= WILD_CARD_START) return 19; // Wild Card

    // If after regular season but before Wild Card
    if (now >= REGULAR_SEASON_END) return 19;

    // Calculate weeks elapsed (each NFL week starts on Tuesday)
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weeksElapsed = Math.floor((now - SEASON_START) / msPerWeek);

    // Clamp to valid range (1-18)
    return Math.min(Math.max(weeksElapsed + 1, 1), TOTAL_WEEKS);
}

const CURRENT_NFL_WEEK = calculateCurrentNFLWeek();

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

// Fallback spreads for games - used when Odds API doesn't return data (e.g., completed games)
// This is a separate constant that never gets overwritten
const FALLBACK_SPREADS = {
    15: { 'falcons_buccaneers': { spread: 4.5, favorite: 'home' }, 'jets_jaguars': { spread: 13.5, favorite: 'home' }, 'browns_bears': { spread: 7.5, favorite: 'home' }, 'bills_patriots': { spread: 1.5, favorite: 'away' }, 'ravens_bengals': { spread: 2.5, favorite: 'away' }, 'cardinals_texans': { spread: 9.5, favorite: 'home' }, 'raiders_eagles': { spread: 11.5, favorite: 'home' }, 'chargers_chiefs': { spread: 5.5, favorite: 'home' }, 'commanders_giants': { spread: 2.5, favorite: 'home' }, 'colts_seahawks': { spread: 13.5, favorite: 'home' }, 'titans_49ers': { spread: 12.5, favorite: 'home' }, 'packers_broncos': { spread: 2.5, favorite: 'away' }, 'lions_rams': { spread: 6, favorite: 'home' }, 'panthers_saints': { spread: 2.5, favorite: 'away' }, 'vikings_cowboys': { spread: 5.5, favorite: 'home' }, 'dolphins_steelers': { spread: 3, favorite: 'home' } },
    16: { 'rams_seahawks': { spread: 1.5, favorite: 'home' }, 'eagles_commanders': { spread: 6.5, favorite: 'away' }, 'packers_bears': { spread: 1.5, favorite: 'away' }, 'bills_browns': { spread: 10, favorite: 'away' }, 'chargers_cowboys': { spread: 1.5, favorite: 'home' }, 'chiefs_titans': { spread: 3.5, favorite: 'away' }, 'bengals_dolphins': { spread: 1.5, favorite: 'away' }, 'jets_saints': { spread: 4.5, favorite: 'home' }, 'vikings_giants': { spread: 3, favorite: 'away' }, 'buccaneers_panthers': { spread: 3, favorite: 'away' }, 'jaguars_broncos': { spread: 3, favorite: 'home' }, 'falcons_cardinals': { spread: 2.5, favorite: 'away' }, 'steelers_lions': { spread: 7, favorite: 'home' }, 'raiders_texans': { spread: 14.5, favorite: 'home' }, 'patriots_ravens': { spread: 3, favorite: 'home' }, '49ers_colts': { spread: 5.5, favorite: 'away' } },
    17: { 'cowboys_commanders': { spread: 4.5, favorite: 'home' }, 'lions_vikings': { spread: 3, favorite: 'away' }, 'broncos_chiefs': { spread: 10.5, favorite: 'home' }, 'texans_chargers': { spread: 1.5, favorite: 'home' }, 'ravens_packers': { spread: 4.5, favorite: 'home' }, 'cardinals_bengals': { spread: 7.5, favorite: 'home' }, 'steelers_browns': { spread: 3, favorite: 'away' }, 'jaguars_colts': { spread: 6, favorite: 'home' }, 'buccaneers_dolphins': { spread: 6, favorite: 'home' }, 'patriots_jets': { spread: 13.5, favorite: 'home' }, 'saints_titans': { spread: 2.5, favorite: 'home' }, 'giants_raiders': { spread: 1.5, favorite: 'home' }, 'eagles_bills': { spread: 1.5, favorite: 'home' }, 'seahawks_panthers': { spread: 7, favorite: 'away' }, 'bears_49ers': { spread: 3, favorite: 'home' }, 'rams_falcons': { spread: 7.5, favorite: 'away' } },
    18: { 'panthers_buccaneers': { spread: 2.5, favorite: 'home' } },
    // Wild Card Round (Week 19)
    19: {
        'rams_panthers': { spread: 10.5, favorite: 'away', overUnder: 46.5 },
        'packers_bears': { spread: 1, favorite: 'home', overUnder: 46.5 },
        'bills_jaguars': { spread: 1.5, favorite: 'away', overUnder: 51.5 },
        '49ers_eagles': { spread: 5, favorite: 'home', overUnder: 44.5 },
        'chargers_patriots': { spread: 3.5, favorite: 'home', overUnder: 43.5 },
        'texans_steelers': { spread: 3, favorite: 'away', overUnder: 39.5 }
    }
};

// NFL Games by Week - Full structure for all weeks
// Week 15 has full data, other weeks are placeholders that can be populated
// NFL Week 15 2025: Thu Dec 11, Sun Dec 14, Mon Dec 15
const NFL_GAMES_BY_WEEK = {
    15: [
        { id: 1, away: 'Falcons', home: 'Buccaneers', spread: 4.5, favorite: 'home', day: 'Thursday', time: '8:15 PM ET', kickoff: '2025-12-11T20:15:00-05:00', location: 'Tampa, FL', stadium: 'Raymond James Stadium' },
        { id: 2, away: 'Jets', home: 'Jaguars', spread: 13.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Jacksonville, FL', stadium: 'EverBank Stadium' },
        { id: 3, away: 'Browns', home: 'Bears', spread: 7.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Chicago, IL', stadium: 'Soldier Field' },
        { id: 4, away: 'Bills', home: 'Patriots', spread: 1.5, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Foxborough, MA', stadium: 'Gillette Stadium' },
        { id: 5, away: 'Ravens', home: 'Bengals', spread: 2.5, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Cincinnati, OH', stadium: 'Paycor Stadium' },
        { id: 6, away: 'Cardinals', home: 'Texans', spread: 9.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Houston, TX', stadium: 'NRG Stadium' },
        { id: 7, away: 'Raiders', home: 'Eagles', spread: 11.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Philadelphia, PA', stadium: 'Lincoln Financial Field' },
        { id: 8, away: 'Chargers', home: 'Chiefs', spread: 5.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'Kansas City, MO', stadium: 'GEHA Field at Arrowhead Stadium' },
        { id: 9, away: 'Commanders', home: 'Giants', spread: 2.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-14T13:00:00-05:00', location: 'East Rutherford, NJ', stadium: 'MetLife Stadium' },
        { id: 10, away: 'Colts', home: 'Seahawks', spread: 13.5, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-14T16:25:00-05:00', location: 'Seattle, WA', stadium: 'Lumen Field' },
        { id: 11, away: 'Titans', home: '49ers', spread: 12.5, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-14T16:25:00-05:00', location: 'Santa Clara, CA', stadium: 'Levi\'s Stadium' },
        { id: 12, away: 'Packers', home: 'Broncos', spread: 2.5, favorite: 'away', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-14T16:25:00-05:00', location: 'Denver, CO', stadium: 'Empower Field at Mile High' },
        { id: 13, away: 'Lions', home: 'Rams', spread: 6, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-14T16:25:00-05:00', location: 'Inglewood, CA', stadium: 'SoFi Stadium' },
        { id: 14, away: 'Panthers', home: 'Saints', spread: 2.5, favorite: 'away', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-14T16:25:00-05:00', location: 'New Orleans, LA', stadium: 'Caesars Superdome' },
        { id: 15, away: 'Vikings', home: 'Cowboys', spread: 5.5, favorite: 'home', day: 'Sunday', time: '8:20 PM ET', kickoff: '2025-12-14T20:20:00-05:00', location: 'Arlington, TX', stadium: 'AT&T Stadium' },
        { id: 16, away: 'Dolphins', home: 'Steelers', spread: 3, favorite: 'home', day: 'Monday', time: '8:15 PM ET', kickoff: '2025-12-15T20:15:00-05:00', location: 'Pittsburgh, PA', stadium: 'Acrisure Stadium' }
    ],
    16: [
        { id: 1, away: 'Rams', home: 'Seahawks', spread: 1.5, favorite: 'home', day: 'Thursday', time: '8:15 PM ET', kickoff: '2025-12-19T20:15:00-05:00', location: 'Seattle, WA', stadium: 'Lumen Field' },
        { id: 2, away: 'Eagles', home: 'Commanders', spread: 6.5, favorite: 'away', day: 'Saturday', time: '5:00 PM ET', kickoff: '2025-12-20T17:00:00-05:00', location: 'Landover, MD', stadium: 'Northwest Stadium' },
        { id: 3, away: 'Packers', home: 'Bears', spread: 1.5, favorite: 'away', day: 'Saturday', time: '8:20 PM ET', kickoff: '2025-12-20T20:20:00-05:00', location: 'Chicago, IL', stadium: 'Soldier Field' },
        { id: 4, away: 'Bills', home: 'Browns', spread: 10, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'Cleveland, OH', stadium: 'Huntington Bank Field' },
        { id: 5, away: 'Chargers', home: 'Cowboys', spread: 1.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'Arlington, TX', stadium: 'AT&T Stadium' },
        { id: 6, away: 'Chiefs', home: 'Titans', spread: 3.5, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'Nashville, TN', stadium: 'Nissan Stadium' },
        { id: 7, away: 'Bengals', home: 'Dolphins', spread: 1.5, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'Miami Gardens, FL', stadium: 'Hard Rock Stadium' },
        { id: 8, away: 'Jets', home: 'Saints', spread: 4.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'New Orleans, LA', stadium: 'Caesars Superdome' },
        { id: 9, away: 'Vikings', home: 'Giants', spread: 3, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'East Rutherford, NJ', stadium: 'MetLife Stadium' },
        { id: 10, away: 'Buccaneers', home: 'Panthers', spread: 3, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-21T13:00:00-05:00', location: 'Charlotte, NC', stadium: 'Bank of America Stadium' },
        { id: 11, away: 'Jaguars', home: 'Broncos', spread: 3, favorite: 'home', day: 'Sunday', time: '4:05 PM ET', kickoff: '2025-12-21T16:05:00-05:00', location: 'Denver, CO', stadium: 'Empower Field at Mile High' },
        { id: 12, away: 'Falcons', home: 'Cardinals', spread: 2.5, favorite: 'away', day: 'Sunday', time: '4:05 PM ET', kickoff: '2025-12-21T16:05:00-05:00', location: 'Glendale, AZ', stadium: 'State Farm Stadium' },
        { id: 13, away: 'Steelers', home: 'Lions', spread: 7, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-21T16:25:00-05:00', location: 'Detroit, MI', stadium: 'Ford Field' },
        { id: 14, away: 'Raiders', home: 'Texans', spread: 14.5, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-21T16:25:00-05:00', location: 'Houston, TX', stadium: 'NRG Stadium' },
        { id: 15, away: 'Patriots', home: 'Ravens', spread: 3, favorite: 'home', day: 'Sunday', time: '8:20 PM ET', kickoff: '2025-12-21T20:20:00-05:00', location: 'Baltimore, MD', stadium: 'M&T Bank Stadium' },
        { id: 16, away: '49ers', home: 'Colts', spread: 5.5, favorite: 'away', day: 'Monday', time: '8:15 PM ET', kickoff: '2025-12-22T20:15:00-05:00', location: 'Indianapolis, IN', stadium: 'Lucas Oil Stadium' }
    ],
    // Week 17 fallback spreads - updated from Odds API, will be overwritten by fresh API data on game days
    17: [
        { id: 1, away: 'Cowboys', home: 'Commanders', spread: 4.5, favorite: 'home', day: 'Wednesday', time: '1:00 PM ET', kickoff: '2025-12-25T13:00:00-05:00', location: 'Landover, MD', stadium: 'Northwest Stadium' },
        { id: 2, away: 'Lions', home: 'Vikings', spread: 3, favorite: 'away', day: 'Wednesday', time: '4:30 PM ET', kickoff: '2025-12-25T16:30:00-05:00', location: 'Minneapolis, MN', stadium: 'U.S. Bank Stadium' },
        { id: 3, away: 'Broncos', home: 'Chiefs', spread: 10.5, favorite: 'home', day: 'Thursday', time: '1:00 PM ET', kickoff: '2025-12-26T13:00:00-05:00', location: 'Kansas City, MO', stadium: 'GEHA Field at Arrowhead Stadium' },
        { id: 4, away: 'Texans', home: 'Chargers', spread: 1.5, favorite: 'home', day: 'Friday', time: '8:15 PM ET', kickoff: '2025-12-27T20:15:00-05:00', location: 'Inglewood, CA', stadium: 'SoFi Stadium' },
        { id: 5, away: 'Ravens', home: 'Packers', spread: 4.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Green Bay, WI', stadium: 'Lambeau Field' },
        { id: 6, away: 'Cardinals', home: 'Bengals', spread: 7.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Cincinnati, OH', stadium: 'Paycor Stadium' },
        { id: 7, away: 'Steelers', home: 'Browns', spread: 3, favorite: 'away', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Cleveland, OH', stadium: 'Huntington Bank Field' },
        { id: 8, away: 'Jaguars', home: 'Colts', spread: 6, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Indianapolis, IN', stadium: 'Lucas Oil Stadium' },
        { id: 9, away: 'Buccaneers', home: 'Dolphins', spread: 6, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Miami Gardens, FL', stadium: 'Hard Rock Stadium' },
        { id: 10, away: 'Patriots', home: 'Jets', spread: 13.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'East Rutherford, NJ', stadium: 'MetLife Stadium' },
        { id: 11, away: 'Saints', home: 'Titans', spread: 2.5, favorite: 'home', day: 'Sunday', time: '1:00 PM ET', kickoff: '2025-12-28T13:00:00-05:00', location: 'Nashville, TN', stadium: 'Nissan Stadium' },
        { id: 12, away: 'Giants', home: 'Raiders', spread: 1.5, favorite: 'home', day: 'Sunday', time: '4:05 PM ET', kickoff: '2025-12-28T16:05:00-05:00', location: 'Las Vegas, NV', stadium: 'Allegiant Stadium' },
        { id: 13, away: 'Eagles', home: 'Bills', spread: 1.5, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-28T16:25:00-05:00', location: 'Orchard Park, NY', stadium: 'Highmark Stadium' },
        { id: 14, away: 'Seahawks', home: 'Panthers', spread: 7, favorite: 'away', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-28T16:25:00-05:00', location: 'Charlotte, NC', stadium: 'Bank of America Stadium' },
        { id: 15, away: 'Bears', home: '49ers', spread: 3, favorite: 'home', day: 'Sunday', time: '4:25 PM ET', kickoff: '2025-12-28T16:25:00-05:00', location: 'Santa Clara, CA', stadium: 'Levi\'s Stadium' },
        { id: 16, away: 'Rams', home: 'Falcons', spread: 7.5, favorite: 'away', day: 'Monday', time: '8:15 PM ET', kickoff: '2025-12-29T20:15:00-05:00', location: 'Atlanta, GA', stadium: 'Mercedes-Benz Stadium' }
    ]
    // Week 18 games fetched dynamically from ESPN API, spreads from FALLBACK_SPREADS
};

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
let liveScoresRefreshInterval = null;

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
                const competitors = event.competitions[0].competitors;
                const homeTeam = competitors.find(c => c.homeAway === 'home');
                const awayTeam = competitors.find(c => c.homeAway === 'away');
                const status = event.status;

                // Create a key based on team names
                const gameKey = `${awayTeam.team.displayName}@${homeTeam.team.displayName}`;

                scores[gameKey] = {
                    homeTeam: homeTeam.team.displayName,
                    awayTeam: awayTeam.team.displayName,
                    homeScore: parseInt(homeTeam.score) || 0,
                    awayScore: parseInt(awayTeam.score) || 0,
                    status: status.type.name, // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL, etc.
                    statusDetail: status.type.shortDetail || status.type.detail,
                    period: status.period,
                    clock: status.displayClock,
                    completed: status.type.completed
                };
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
 * Get live score info for a specific game
 * First checks if game object has embedded status/scores (from ESPN schedule fetch),
 * then falls back to live scores cache
 */
function getLiveGameStatus(game) {
    // If game already has status from ESPN schedule data, use it
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

    // Try to match by team names in live cache
    const awayName = game.away;
    const homeName = game.home;

    // Search through cache for matching game
    for (const [key, scoreData] of Object.entries(liveScoresCache)) {
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
const SCHEDULE_CACHE_VERSION = 6; // Increment to invalidate all caches (v6 filters out non-game events)
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
        const cached = localStorage.getItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
        if (!cached) return null;

        const parsed = JSON.parse(cached);
        const { timestamp, data, version } = parsed;

        // Invalidate old cache versions
        if (version !== SCHEDULE_CACHE_VERSION) {
            console.log(`[ESPN] Cache version mismatch for week ${week}, invalidating`);
            localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
            return null;
        }
        const age = Date.now() - timestamp;

        // Use shorter cache duration for playoff weeks
        const maxAge = isPlayoffWeek(week) ? PLAYOFF_CACHE_DURATION : SCHEDULE_CACHE_DURATION;

        if (age < maxAge) {
            // Validate data structure - treat invalid data as cache miss
            if (!isValidGameData(data)) {
                console.log(`[ESPN] Invalid/empty cache data for week ${week}, treating as cache miss`);
                localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
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
        localStorage.removeItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
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
        localStorage.setItem(`${SCHEDULE_CACHE_KEY}_week${week}`, JSON.stringify({
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
            url = `${ESPN_SCHEDULE_URL}?seasontype=3&week=${playoffInfo.espnWeek}`;
            console.log(`[ESPN] Fetching playoff schedule for ${playoffInfo.name}...`);
        } else {
            url = `${ESPN_SCHEDULE_URL}?seasontype=2&week=${week}`;
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
                    spread: 0, // Will be updated from Odds API
                    favorite: 'home', // Default, will be updated from Odds API
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
        const staleCache = localStorage.getItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
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
async function loadWeekSchedule(week, forceRefresh = false) {
    // For playoff weeks, fetch from ESPN
    if (isPlayoffWeek(week)) {
        // Try to load spreads from Google Sheets backup first (ensures we have spreads even for completed games)
        await loadSpreadsFromGoogleSheets(week);
        const savedSpreads = getSavedSpreads();
        const weekStr = String(week);

        // Helper to apply saved spreads and fallback spreads to playoff games
        const applySpreadsToGames = (gameList) => {
            if (!gameList) return;
            const weekNum = parseInt(week); // Ensure numeric key for FALLBACK_SPREADS lookup
            gameList.forEach(game => {
                const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;

                // Only apply if game spread is 0 or missing
                if (!game.spread || game.spread === 0) {
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
                    let spread = histGame.spread || espnMatch.spread;
                    let favorite = histGame.favorite || espnMatch.favorite;
                    if ((!spread || spread === 0) && savedSpreads[week] && savedSpreads[week][key]) {
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
        if (game.spread && game.spread > 0) {
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
            // Apply saved spreads for games that still have spread: 0 (from previous API fetches)
            if ((!game.spread || game.spread === 0) && savedSpreads[week] && savedSpreads[week][key]) {
                game.spread = savedSpreads[week][key].spread;
                game.favorite = savedSpreads[week][key].favorite;
                if (savedSpreads[week][key].overUnder) {
                    game.overUnder = savedSpreads[week][key].overUnder;
                }
                console.log(`[Schedule] Applied saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }
            // Apply hardcoded fallback spreads for games still at 0 (use parseInt for numeric key lookup)
            const weekNum = parseInt(week);
            if ((!game.spread || game.spread === 0) && FALLBACK_SPREADS[weekNum] && FALLBACK_SPREADS[weekNum][key]) {
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

    // Build ID to matchup key mapping
    const idToMatchupKey = {};
    weekGames.forEach(game => {
        const matchupKey = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
        idToMatchupKey[String(game.id)] = matchupKey;
    });

    let migrated = false;
    const weekPicks = allPicks[week];
    if (!weekPicks) return;

    for (const picker in weekPicks) {
        const pickerPicks = weekPicks[picker];
        const newPickerPicks = {};

        for (const gameId in pickerPicks) {
            // Check if this looks like a numeric ID that should be converted
            if (idToMatchupKey[gameId]) {
                // Convert to matchup key
                newPickerPicks[idToMatchupKey[gameId]] = pickerPicks[gameId];
                migrated = true;
            } else {
                // Already a matchup key or unknown, keep as-is
                newPickerPicks[gameId] = pickerPicks[gameId];
            }
        }

        allPicks[week][picker] = newPickerPicks;
    }

    if (migrated) {
        console.log(`[Migration] Converted week ${week} picks to matchup keys`);
        savePicksToStorage(false, true); // Save without toast, skip sync
    }
}

/**
 * Odds API cache configuration
 * Note: API key is stored in Cloudflare Worker environment variables
 */
const ODDS_CACHE_KEY = 'nfl_odds_cache';
const ODDS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const SAVED_SPREADS_KEY = 'nfl_saved_spreads'; // Permanent storage for spreads (used for completed games)

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
 * Apply saved spreads to games that have spread: 0
 * This ensures completed games show their original spreads
 */
function applySavedSpreads() {
    const saved = getSavedSpreads();
    let appliedCount = 0;

    Object.entries(NFL_GAMES_BY_WEEK).forEach(([week, games]) => {
        if (!games) return;

        games.forEach(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;

            // If game has a spread but we don't have it saved, save it now (preserves spreads before games complete)
            if (game.spread && game.spread > 0 && (!saved[week] || !saved[week][key])) {
                saveSpread(week, game.away, game.home, game.spread, game.favorite, game.overUnder);
                console.log(`[Spreads] Auto-saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }

            // Apply saved spread if game spread is 0
            if ((!game.spread || game.spread === 0) && saved[week] && saved[week][key]) {
                game.spread = saved[week][key].spread;
                game.favorite = saved[week][key].favorite;
                if (saved[week][key].overUnder && (!game.overUnder || game.overUnder === 0)) {
                    game.overUnder = saved[week][key].overUnder;
                }
                appliedCount++;
                console.log(`[Spreads] Applied saved spread for ${game.away} @ ${game.home}: ${game.spread}`);
            }
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
    // Check cache first unless force refresh
    if (!forceRefresh) {
        const cached = getCachedOdds();
        if (cached) return cached;
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

        console.log(`[Odds API] Fetched odds for ${games.length} games`);

        // Cache the results
        cacheOdds(games);

        return games;
    } catch (error) {
        console.warn('[Odds API] Fetch failed:', error.message);

        // Try stale cache on error
        const staleCache = localStorage.getItem(ODDS_CACHE_KEY);
        if (staleCache) {
            console.log('[Odds API] Using stale cache due to fetch error');
            return JSON.parse(staleCache).data;
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
    // Check if at least one game has a non-zero spread
    return games.some(g => g.spread && g.spread > 0);
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
            return applyOddsData(cached);
        }
        // Priority 2: Use fallback spreads for regular season
        if (hasFallbackSpreads) {
            console.log('[Odds API] Non-game day with fallback spreads - skipping API call');
            return true;
        }
        // No cache and no fallbacks - need to fetch (first load of playoff week)
        console.log(`[Odds API] Non-game day but no cached odds${isPlayoff ? ' for playoff week' : ''} - fetching from API`);
    }

    // Fetch odds from API (will use cache if valid)
    const oddsData = await fetchNFLOdds(forceRefresh);
    if (!oddsData) {
        console.warn('[Odds API] Could not fetch odds');
        // Fall back to cached data or hardcoded spreads
        if (cached) {
            console.log('[Odds API] API failed, using stale cached odds');
            return applyOddsData(cached);
        }
        if (hasFallbackSpreads) {
            console.log('[Odds API] API failed, using hardcoded fallback spreads');
            return true;
        }
        return false;
    }

    return applyOddsData(oddsData);
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
            if (!game.spread || game.spread === 0) {
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
            const hasSpread = games.some(g => g.spread && g.spread > 0);
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

/**
 * Check if we should keep polling for live scores
 * Returns true if any games are in progress OR scheduled (not yet final)
 */
function shouldPollLiveScores() {
    const scores = Object.values(liveScoresCache);
    if (scores.length === 0) return false;

    for (const scoreData of scores) {
        // Keep polling if any game is in progress
        if (scoreData.status === 'STATUS_IN_PROGRESS' ||
            scoreData.status === 'STATUS_HALFTIME' ||
            scoreData.status === 'STATUS_END_PERIOD') {
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
    // Clear any existing interval
    if (liveScoresRefreshInterval) {
        clearInterval(liveScoresRefreshInterval);
        liveScoresRefreshInterval = null;
    }

    // Fetch immediately to get current game states
    fetchLiveScores().then(async () => {
        // Only render if initial load is complete (odds have been fetched)
        // During initial load, renderGames is called after updateOddsFromAPI
        if (initialLoadComplete) {
            renderGames();
            renderScoringSummary();

            // Sync any final games to Google Sheets
            await syncResultsToGoogleSheets(currentWeek, 'ESPN');
        }

        // Only start polling interval if games are scheduled or in progress
        if (shouldPollLiveScores()) {
            console.log('Games scheduled or in progress - starting live refresh');
            liveScoresRefreshInterval = setInterval(async () => {
                await fetchLiveScores();
                renderGames();
                renderScoringSummary();

                // Sync any newly final games to Google Sheets
                await syncResultsToGoogleSheets(currentWeek, 'ESPN');

                // Stop polling when all games are final
                if (!shouldPollLiveScores()) {
                    console.log('All games final - stopping live refresh');
                    stopLiveScoresRefresh();

                    // Check if next week's games are available and preload them
                    await preloadNextWeekIfAvailable();
                }
            }, 120000);
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
/**
 * Check if a timestamp is from today (in local timezone)
 */
function isFromToday(timestamp) {
    if (!timestamp) return false;
    const date = new Date(timestamp);
    const today = new Date();
    return date.getFullYear() === today.getFullYear() &&
           date.getMonth() === today.getMonth() &&
           date.getDate() === today.getDate();
}

async function prefetchAndSaveSpreads() {
    console.warn(`[Prefetch] === STARTING prefetchAndSaveSpreads, currentWeek=${currentWeek} ===`);
    let saved = getSavedSpreads();
    const weeksToCheck = [currentWeek];

    // Also check next week if it exists
    if (currentWeek < LAST_PLAYOFF_WEEK) {
        weeksToCheck.push(currentWeek + 1);
    }

    let needsOddsApiRefresh = false;

    for (const week of weeksToCheck) {
        // Load schedule if not already loaded
        if (!NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[week].length === 0) {
            console.log(`[Prefetch] Loading schedule for week ${week}...`);
            await loadWeekSchedule(week);
        }

        const games = NFL_GAMES_BY_WEEK[week];
        if (!games || games.length === 0) continue;

        // Load spreads from Google Sheets
        const weekNum = parseInt(week);
        console.log(`[Prefetch] Week ${week} - loading spreads from Google Sheets...`);
        const sheetResult = await loadSpreadsFromGoogleSheets(week);
        saved = getSavedSpreads();
        applySavedSpreads();

        // For current week: check if spreads need daily refresh
        // First visitor of each day should call Odds API to get fresh spreads
        if (weekNum === CURRENT_NFL_WEEK && !needsOddsApiRefresh) {
            const lastUpdated = sheetResult?.lastUpdated;
            if (!isFromToday(lastUpdated)) {
                console.log(`[Prefetch] Week ${week} spreads last updated: ${lastUpdated || 'never'} - needs daily refresh`);
                needsOddsApiRefresh = true;
            } else {
                console.log(`[Prefetch] Week ${week} spreads were already updated today (${lastUpdated})`);
            }
        }

        // Check if we have spreads saved for all games in this week
        let missingSpreadGames = games.filter(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
            const hasSaved = saved[week] && saved[week][key] && saved[week][key].spread > 0;
            const hasGame = game.spread && game.spread > 0;
            return !hasSaved && !hasGame;
        });

        // Only trigger API refresh for missing spreads in the CURRENT week
        // Future weeks may not have matchups determined yet (e.g., Super Bowl before Conference Championships)
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

    // If we need fresh spreads (first visitor of day or missing spreads), call Odds API
    if (needsOddsApiRefresh) {
        console.log(`[Prefetch] Fetching fresh spreads from Odds API (daily refresh)...`);
        await updateOddsFromAPI(true);
        // Sync to Google Sheets so subsequent visitors today don't need to call the API
        await syncSpreadsToGoogleSheets();
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
 * Stop live scores refresh
 */
function stopLiveScoresRefresh() {
    if (liveScoresRefreshInterval) {
        clearInterval(liveScoresRefreshInterval);
        liveScoresRefreshInterval = null;
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

// Helper function to get games for current week
function getGamesForWeek(week) {
    return NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[String(week)] || [];
}

// Helper function to get results for current week
function getResultsForWeek(week) {
    return NFL_RESULTS_BY_WEEK[week] || NFL_RESULTS_BY_WEEK[String(week)] || {};
}

// Helper function to get matchup key for a game (used for pick lookups)
function getMatchupKey(game) {
    return `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
}

// Helper function to look up picks for a game (tries matchup key first, then game ID)
function getPicksForGame(pickerPicks, game) {
    const matchupKey = getMatchupKey(game);
    const gameIdStr = String(game.id);
    // Try matchup key first (more reliable), then fall back to game ID
    return pickerPicks[matchupKey] || pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
}

// DOM Elements
const dashboard = document.getElementById('dashboard');
const leaderboard = document.getElementById('leaderboard');
const tabs = document.querySelectorAll('.tab');
const subtabs = document.querySelectorAll('.subtab');
const standingsSubtabs = document.getElementById('standings-subtabs');

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

// Helper function to convert numeric game IDs to matchup keys
// This makes picks portable across data sources (historical vs ESPN)
function migratePicksToMatchupKeys(weekPicks, weekGames) {
    if (!weekGames || !weekPicks) return weekPicks;

    // Build a map of numeric ID to matchup key
    const idToMatchupKey = {};
    weekGames.forEach(game => {
        const matchupKey = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
        idToMatchupKey[String(game.id)] = matchupKey;
    });

    // Convert picks from numeric IDs to matchup keys
    const migratedPicks = {};
    for (const gameId in weekPicks) {
        // If this looks like a numeric ID and we have a mapping, convert it
        if (idToMatchupKey[gameId]) {
            migratedPicks[idToMatchupKey[gameId]] = weekPicks[gameId];
        } else {
            // Already a matchup key or no mapping available, keep as-is
            migratedPicks[gameId] = weekPicks[gameId];
        }
    }
    return migratedPicks;
}

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
                allPicks[week][picker] = migratePicksToMatchupKeys(HISTORICAL_PICKS[week][picker], weekGames);
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

    // Note: Historical data (games, results, picks) is merged immediately when app.js loads
    // See the merge blocks after NFL_GAMES_BY_WEEK, NFL_RESULTS_BY_WEEK, and initializePicksStorage()

    setupTabs();
    setupWeekButtons();
    setupPickerButtons();
    setupPicksActions();
    setupDarkMode();
    setupWeekNavigation();
    setupGameFilters();
    setupConfirmModal();
    setupRetryButton();
    setupBackToTop();
    initCollapsibleSections();
    setupConsolidatedTabs();
    setupPullToRefresh();
    setupTeamRecordsDropdown();
    setupBlazinTeamRecordsDropdown();
    setupPatternFilters();
    setupPlayoffComparisonControls();
    loadPicksFromStorage();

    // Show loading state
    showLoadingState();

    // Load data from Google Sheets
    loadFromGoogleSheets();
}

/**
 * One-time fix: Restore Stephen's week 16 Seahawks pick that was accidentally cleared
 * Week 16 Game 1: Rams @ Seahawks, Seahawks -1.5 (home favorite)
 */
function restoreStephenWeek16Pick() {
    // Initialize week 16 picks if needed
    if (!allPicks[16]) {
        allPicks[16] = {};
    }
    if (!allPicks[16]['Stephen']) {
        allPicks[16]['Stephen'] = {};
    }

    // Week 16, Game ID 1 is Rams @ Seahawks, Seahawks are home and favored (-1.5)
    // Stephen picked Seahawks -1.5
    allPicks[16]['Stephen']['1'] = {
        line: 'home',    // Seahawks are home
        winner: 'home'   // Seahawks to win
    };

    savePicksToStorage(false, true); // No toast, skip sync for automated restore
    console.log('Restored Stephen\'s week 16 Seahawks pick (Game 1, home)');
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
        if (dashboardData && currentCategory !== 'make-picks') {
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
    if (WEEK_SHEET_GIDS[week] && !weeklyPicksCache[week]) {
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

        // Hide loading message
        if (tabLoadingEl) {
            tabLoadingEl.classList.add('hidden');
        }

        // Show leaderboard again for the render
        leaderboard?.classList.remove('hidden');
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
}

/**
 * Setup picks action buttons
 */
function setupPicksActions() {
    document.getElementById('clear-picks-btn')?.addEventListener('click', clearCurrentPickerPicks);
    document.getElementById('clear-picks-btn-mobile')?.addEventListener('click', clearCurrentPickerPicks);
    document.getElementById('reset-all-picks-btn')?.addEventListener('click', resetAllPicks);
    document.getElementById('randomize-picks-btn')?.addEventListener('click', () => {
        randomizePicks();
        closeDropdown();
    });
    document.getElementById('copy-picks-btn')?.addEventListener('click', copyPicksToClipboard);

    // Quick picks dropdown
    document.getElementById('quick-picks-btn')?.addEventListener('click', toggleDropdown);
    document.getElementById('pick-favorites-btn')?.addEventListener('click', () => {
        pickAllFavorites();
        closeDropdown();
    });
    document.getElementById('pick-underdogs-btn')?.addEventListener('click', () => {
        pickAllUnderdogs();
        closeDropdown();
    });

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

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('quick-picks-dropdown');
        if (dropdown && !dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });
}

/**
 * Toggle the quick picks dropdown
 */
function toggleDropdown(e) {
    e.stopPropagation();
    const dropdown = document.getElementById('quick-picks-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('open');
    }
}

/**
 * Close the dropdown
 */
function closeDropdown() {
    const dropdown = document.getElementById('quick-picks-dropdown');
    if (dropdown) {
        dropdown.classList.remove('open');
    }
}

/**
 * Pick all favorites for the current picker
 */
function pickAllFavorites() {
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const weekGames = getGamesForWeek(currentWeek);

    if (weekGames.length === 0) {
        showToast('No games available');
        return;
    }

    // Ensure structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    let pickedCount = 0;
    weekGames.forEach(game => {
        const gameIdStr = String(game.id);

        // Skip locked games
        if (isGameLocked(game)) return;

        // Pick the favorite for both line and winner
        allPicks[currentWeek][currentPicker][gameIdStr] = {
            line: game.favorite,
            winner: game.favorite
        };
        pickedCount++;
    });

    savePicksToStorage();
    renderGames();
    renderScoringSummary();
    showToast(`Picked ${pickedCount} favorites`);
}

/**
 * Pick all underdogs for the current picker
 */
function pickAllUnderdogs() {
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const weekGames = getGamesForWeek(currentWeek);

    if (weekGames.length === 0) {
        showToast('No games available');
        return;
    }

    // Ensure structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    let pickedCount = 0;
    weekGames.forEach(game => {
        const gameIdStr = String(game.id);

        // Skip locked games
        if (isGameLocked(game)) return;

        // Pick the underdog
        const underdog = game.favorite === 'home' ? 'away' : 'home';

        // For line pick, pick underdog
        // For winner, random (underdogs often lose straight up)
        allPicks[currentWeek][currentPicker][gameIdStr] = {
            line: underdog,
            winner: Math.random() < 0.5 ? 'away' : 'home'
        };
        pickedCount++;
    });

    savePicksToStorage();
    renderGames();
    renderScoringSummary();
    showToast(`Picked ${pickedCount} underdogs`);
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
    updateLoadingProgress(15, 'Connecting to data source...');

    try {
        updateLoadingProgress(25, 'Fetching dashboard data...');

        // Use worker proxy to avoid CORS issues
        const proxyUrl = `${WORKER_PROXY_URL}/sheets?url=${encodeURIComponent(GOOGLE_SHEETS_CSV_URL)}`;

        // Add 15 second timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(proxyUrl, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);

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
        console.log('Loaded data from Google Sheets via worker proxy');
        loadCSVData(csvText);

        // Also load weekly picks data from individual week tabs
        updateLoadingProgress(85, 'Loading weekly picks...');
        await loadAllWeeklyDataForBlazin();

        // Load schedule from ESPN for current week
        updateLoadingProgress(90, 'Loading game schedule...');
        await loadWeekSchedule(currentWeek, true); // Force refresh to get latest status/scores

        // Check if all games in current week are complete and advance if needed
        const advanced = await checkAndAdvanceWeekIfNeeded();
        if (advanced) {
            console.log(`[Init] Advanced to ${getWeekDisplayName(currentWeek)}`);
        }

        // Load spreads from Google Sheets (primary source for all users)
        updateLoadingProgress(95, 'Loading spreads...');
        await prefetchAndSaveSpreads();

        // Load picks from Google Sheets backup if localStorage is empty
        await loadAllPicksFromBackup();

        // Load results from Google Sheets backup
        await loadAllResultsFromBackup();

        // Mark initial load as complete before rendering
        initialLoadComplete = true;

        // Re-render games after schedule and odds are loaded
        renderGames();
        renderScoringSummary();

        // Now hide loading state after all data is loaded
        hideLoadingState();

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

    // Update tabs
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.category === category);
    });

    // Show/hide sections based on category
    const makePicksSection = document.getElementById('make-picks-section');
    const performanceInsightsSection = document.getElementById('performance-insights-section');
    const recordsAnalysisSection = document.getElementById('records-analysis-section');
    const vsMarketSection = document.getElementById('vs-market-section');

    if (category === 'make-picks') {
        // Destroy chart instances to prevent memory leaks
        if (typeof destroyAllCharts === 'function') {
            destroyAllCharts();
        }

        // Hide subtabs and dashboard sections
        standingsSubtabs?.classList.add('hidden');
        leaderboard.classList.add('hidden');
        performanceInsightsSection?.classList.add('hidden');
        recordsAnalysisSection?.classList.add('hidden');
        vsMarketSection?.classList.add('hidden');
        makePicksSection?.classList.remove('hidden');

        // Start live scores refresh and render the picks interface
        startLiveScoresRefresh();
        renderScoringSummary();
    } else if (category === 'standings') {
        // Stop live scores refresh when leaving picks tab
        stopLiveScoresRefresh();

        // Show subtabs and dashboard sections
        standingsSubtabs?.classList.remove('hidden');
        leaderboard.classList.remove('hidden');
        performanceInsightsSection?.classList.remove('hidden');
        recordsAnalysisSection?.classList.remove('hidden');
        vsMarketSection?.classList.add('hidden');
        makePicksSection?.classList.add('hidden');

        renderDashboard();
    } else if (category === 'vs-market') {
        // Stop live scores refresh when leaving picks tab
        stopLiveScoresRefresh();

        // Destroy chart instances to prevent memory leaks
        if (typeof destroyAllCharts === 'function') {
            destroyAllCharts();
        }

        // Hide other sections
        standingsSubtabs?.classList.add('hidden');
        leaderboard.classList.add('hidden');
        performanceInsightsSection?.classList.add('hidden');
        recordsAnalysisSection?.classList.add('hidden');
        makePicksSection?.classList.add('hidden');
        vsMarketSection?.classList.remove('hidden');

        // Render the vs market section
        renderVsMarketSection();
    }
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
function calculatePlayoffStats() {
    const stats = {};

    // Initialize stats for all pickers
    PICKERS.forEach(picker => {
        stats[picker] = {
            name: picker,
            // Line (ATS) totals
            lineWins: 0, lineLosses: 0, linePushes: 0,
            // Straight Up totals
            suWins: 0, suLosses: 0,
            // Over/Under totals
            ouWins: 0, ouLosses: 0, ouPushes: 0
        };
    });

    // Loop through playoff weeks (19-22)
    for (let week = FIRST_PLAYOFF_WEEK; week <= LAST_PLAYOFF_WEEK; week++) {
        const weekStr = String(week);
        const weekGames = getGamesForWeek(week);
        const weekResults = getResultsForWeek(week);
        // Try both string and number keys for allPicks (historical data uses string keys)
        const weekPicks = allPicks[week] || allPicks[weekStr] || {};
        const cachedWeek = weeklyPicksCache[week] || weeklyPicksCache[weekStr];

        if (!weekGames || weekGames.length === 0) continue;

        PICKERS.forEach(picker => {
            const pickerPicks = weekPicks[picker] || {};
            const cachedPicks = cachedWeek?.picks?.[picker] || {};

            weekGames.forEach(game => {
                const gamePicks = getPicksForGame(pickerPicks, game);
                const cachedGamePicks = getPicksForGame(cachedPicks, game);

                // Get result - try both string and number keys
                const gameIdStr = String(game.id);
                let result = weekResults[game.id] || weekResults[gameIdStr];
                if (!result) {
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

                const atsWinner = calculateATSWinner(game, result);

                // Line pick result (same logic as renderScoringSummary)
                const linePick = gamePicks.line || cachedGamePicks.line;
                if (linePick) {
                    if (atsWinner === 'push') {
                        stats[picker].linePushes++;
                    } else if (linePick === atsWinner) {
                        stats[picker].lineWins++;
                    } else {
                        stats[picker].lineLosses++;
                    }
                }

                // Straight up result (same logic as renderScoringSummary)
                const winnerPick = gamePicks.winner || cachedGamePicks.winner;
                if (winnerPick) {
                    if (winnerPick === result.winner) {
                        stats[picker].suWins++;
                    } else {
                        stats[picker].suLosses++;
                    }
                }

                // Over/Under result (same logic as renderScoringSummary)
                const ouPick = gamePicks.overUnder || cachedGamePicks.overUnder;
                const ouLine = game.overUnder || gamePicks.totalLine || cachedGamePicks.totalLine;
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
            });
        });
    }

    // Calculate combined totals and percentage for ranking
    PICKERS.forEach(picker => {
        const s = stats[picker];

        // Combined wins/losses across all three categories
        s.wins = s.lineWins + s.suWins + s.ouWins;
        s.losses = s.lineLosses + s.suLosses + s.ouLosses;
        s.pushes = s.linePushes + s.ouPushes;
        s.totalPicks = s.wins + s.losses + s.pushes;

        // Percentage based on combined record
        const total = s.wins + s.losses;
        s.percentage = total > 0 ? (s.wins / total * 100) : 0;

        // Format breakdown records for display
        const linePushStr = s.linePushes > 0 ? `-${s.linePushes}` : '';
        const ouPushStr = s.ouPushes > 0 ? `-${s.ouPushes}` : '';
        s.lineRecord = `${s.lineWins}-${s.lineLosses}${linePushStr}`;
        s.suRecord = `${s.suWins}-${s.suLosses}`;
        s.ouRecord = `${s.ouWins}-${s.ouLosses}${ouPushStr}`;
    });

    return stats;
}

/**
 * Render the full dashboard
 */
function renderDashboard() {
    if (!dashboardData) return;

    let stats, weeklyData;

    // Use subcategory to determine which stats to show
    switch (currentSubcategory) {
        case 'line':
            stats = dashboardData.linePicks;
            weeklyData = dashboardData.weeklyLinePicks;
            break;
        case 'blazin':
            stats = dashboardData.blazin5;
            weeklyData = dashboardData.weeklyBlazin5;
            break;
        case 'winner':
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

    // PRIMARY: Render leaderboard
    renderLeaderboard(stats);

    // Get section elements
    const performanceInsightsSection = document.getElementById('performance-insights-section');
    const recordsAnalysisSection = document.getElementById('records-analysis-section');
    const playoffStandingsSection = document.getElementById('playoff-standings-section');
    const playoffComparisonSection = document.getElementById('playoff-comparison-section');

    // Playoffs tab: show leaderboard cards and playoff standings table, hide other sections
    if (currentSubcategory === 'playoffs') {
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

    // Show all panels for non-playoff tabs
    document.getElementById('trend-chart-container')?.classList.remove('hidden');
    document.querySelector('.insights-panel')?.classList.remove('hidden');
    document.querySelector('.patterns-panel')?.classList.remove('hidden');
    document.querySelector('.group-stats-panel')?.classList.remove('hidden');

    // Show sections for non-playoff tabs
    performanceInsightsSection?.classList.remove('hidden');
    recordsAnalysisSection?.classList.remove('hidden');

    // SECONDARY: Performance & Insights - render all panels
    renderStandingsTable(stats);
    renderTrendChart(weeklyData, currentSubcategory);
    renderInsights(dashboardData.loneWolf, dashboardData.universalAgreement);
    renderPatternsPanel();
    if (dashboardData.groupOverall) {
        renderGroupStats(dashboardData.groupOverall);
    }

    // Only show Favorites vs Underdogs chart on Line Picks tab
    const standingsChartContainer = document.getElementById('standings-chart-container');
    if (standingsChartContainer) {
        if (currentSubcategory === 'line') {
            standingsChartContainer.classList.remove('hidden');
            renderFavUnderdogChart(dashboardData.favoritesVsUnderdogs);
        } else {
            standingsChartContainer.classList.add('hidden');
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
        // Make sure Blazin records panel is active
        if (blazinRecordsTab && !blazinRecordsTab.classList.contains('active')) {
            blazinRecordsTab.click();
        }
    } else if (currentSubcategory === 'line') {
        // Show Team Records tab, hide Blazin' 5 Records tab
        blazinRecordsTab?.classList.add('hidden');
        teamRecordsTab?.classList.remove('hidden');
        renderTeamPickRecords();
        // Make sure Team records panel is active
        if (teamRecordsTab && !teamRecordsTab.classList.contains('active')) {
            teamRecordsTab.click();
        }
    } else {
        // Winner tab - hide both record tabs
        blazinRecordsTab?.classList.add('hidden');
        teamRecordsTab?.classList.add('hidden');
    }
}

/**
 * Calculate team pick records for a specific picker (line picks)
 */
function calculateTeamPickRecords(picker) {
    const teamRecords = {};

    // Loop through all weeks with results
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];
        // Get picks from both allPicks AND weeklyPicksCache (Google Sheets data)
        const pickerPicks = allPicks[week]?.[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || !results) continue;

        games.forEach(game => {
            // Try both string and number keys for compatibility
            const gameId = game.id;
            // Check both allPicks and weeklyPicksCache for the pick
            const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] || cachedPicks[gameId] || cachedPicks[String(gameId)];
            const result = results[gameId] || results[String(gameId)];

            if (!pick?.line || !result) return;

            // Calculate if the pick was correct
            const atsWinner = calculateATSWinner(game, result);
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
    spread: { column: 'record', direction: 'desc' }
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
        spread: 'blazin-spread-records-table'
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

/**
 * Calculate worst Blazin' 5 week for each picker (by record like "0-5")
 */
function calculateWorstBlazinWeeks() {
    const worstWeeks = {};
    const pickers = PICKERS_WITH_COWHERD;

    pickers.forEach(picker => {
        const weeklyRecords = {};

        // Calculate record for each week
        for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
            const games = NFL_GAMES_BY_WEEK[week];
            const results = NFL_RESULTS_BY_WEEK[week];
            const pickerPicks = allPicks[week]?.[picker] || {};
            const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

            if (!games || !results) continue;

            let wins = 0, losses = 0, pushes = 0;

            games.forEach(game => {
                const gameId = game.id;
                const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] || cachedPicks[gameId] || cachedPicks[String(gameId)];
                const result = results[gameId] || results[String(gameId)];

                // Only count Blazin' 5 picks
                if (!pick?.line || !pick?.blazin || !result) return;

                const atsWinner = calculateATSWinner(game, result);
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

    // Loop through all weeks with results
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];
        const pickerPicks = allPicks[week]?.[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] || cachedPicks[gameId] || cachedPicks[String(gameId)];
            const result = results[gameId] || results[String(gameId)];

            // Only count Blazin' 5 picks
            if (!pick?.line || !pick?.blazin || !result) return;

            const atsWinner = calculateATSWinner(game, result);
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

    // Loop through all weeks with results
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];
        const pickerPicks = allPicks[week]?.[picker] || {};
        const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};

        if (!games || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] || cachedPicks[gameId] || cachedPicks[String(gameId)];
            const result = results[gameId] || results[String(gameId)];

            // Only count Blazin' 5 picks
            if (!pick?.line || !pick?.blazin || !result) return;

            const atsWinner = calculateATSWinner(game, result);
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

    // Loop through all weeks
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];

        if (!games || !results) continue;

        games.forEach(game => {
            const gameId = game.id;
            const result = results[gameId] || results[String(gameId)];
            if (!result) return;

            // Collect all picks for this game
            const picksByChoice = { away: [], home: [] };

            PICKERS.forEach(picker => {
                const pickerPicks = allPicks[week]?.[picker] || {};
                const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
                const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] ||
                           cachedPicks[gameId] || cachedPicks[String(gameId)];

                if (pick?.line) {
                    picksByChoice[pick.line].push(picker);
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
                const atsWinner = calculateATSWinner(game, result);
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
                const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] ||
                           cachedPicks[gameId] || cachedPicks[String(gameId)];

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
                const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] ||
                           cachedPicks[gameId] || cachedPicks[String(gameId)];

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
                const atsWinner = calculateATSWinner(game, result);
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
 * Render Group Insights section (Lone Wolf + Consensus)
 */
function renderInsights(loneWolf, consensus) {
    // Render Consensus card
    const consensusCard = document.getElementById('consensus-card');
    if (consensusCard && consensus) {
        consensusCard.innerHTML = `
            <div class="insight-header">
                <span class="insight-title">When We All Agree</span>
            </div>
            <div class="insight-stat">
                <span class="insight-percentage ${consensus.percentage >= 50 ? 'positive' : 'negative'}">${consensus.percentage?.toFixed(1)}%</span>
                <span class="insight-record">${consensus.wins}-${consensus.losses}-${consensus.pushes}</span>
            </div>
            <p class="insight-description">Group record when all 5 pickers choose the same line</p>
        `;
    }

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
 * Render Pattern Insights panel
 */
function renderPatternsPanel() {
    const grid = document.getElementById('patterns-grid');
    const pickerFilter = document.getElementById('patterns-picker-filter');
    if (!grid) return;

    // Populate picker filter options if not already done
    if (pickerFilter && pickerFilter.options.length <= 1) {
        PICKERS.forEach(picker => {
            const option = document.createElement('option');
            option.value = picker;
            option.textContent = picker;
            pickerFilter.appendChild(option);
        });
    }

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
        const percentage = data.percentage || 0;
        const isWinning = percentage >= 50;
        const pushText = data.pushes > 0 ? `-${data.pushes}` : '';

        return `
            <div class="group-stat-card">
                <div class="group-stat-header">
                    <span class="group-stat-label">${cat.label}</span>
                </div>
                <div class="group-stat-percentage ${isWinning ? 'positive' : 'negative'}">
                    ${percentage.toFixed(1)}%
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
 * Calculate profit/loss for a bet at -110 odds
 * @param {number} betAmount - Amount bet
 * @param {string} outcome - 'win', 'loss', or 'push'
 * @returns {number} Profit (positive) or loss (negative)
 */
function calculatePnLAt110(betAmount, outcome) {
    if (outcome === 'push') return 0;
    if (outcome === 'win') return betAmount * (100 / 110); // Win pays ~0.909x
    return -betAmount; // Loss
}

/**
 * Calculate P&L for all pickers
 * @param {number} betAmount - Amount to bet per pick
 * @returns {Object} P&L data for each picker
 */
function calculateAllPickersPnL(betAmount) {
    const pnlData = {};

    PICKERS.forEach(picker => {
        pnlData[picker] = {
            spread: { wins: 0, losses: 0, pushes: 0, profit: 0 },
            blazin: { wins: 0, losses: 0, pushes: 0, profit: 0 },
            total: 0
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

            PICKERS.forEach(picker => {
                const pickerPicks = allPicks[week]?.[picker] || {};
                const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
                const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] ||
                           cachedPicks[gameId] || cachedPicks[String(gameId)];

                if (!pick) return;

                // Calculate spread pick P&L
                if (pick.line) {
                    const atsWinner = calculateATSWinner(game, result);
                    const isPush = atsWinner === 'push';
                    const isWin = pick.line === atsWinner;
                    const outcome = isPush ? 'push' : (isWin ? 'win' : 'loss');

                    const profit = calculatePnLAt110(betAmount, outcome);
                    pnlData[picker].spread.profit += profit;
                    if (isPush) pnlData[picker].spread.pushes++;
                    else if (isWin) pnlData[picker].spread.wins++;
                    else pnlData[picker].spread.losses++;

                    // If also a Blazin' 5 pick, track separately
                    if (pick.blazin) {
                        pnlData[picker].blazin.profit += profit;
                        if (isPush) pnlData[picker].blazin.pushes++;
                        else if (isWin) pnlData[picker].blazin.wins++;
                        else pnlData[picker].blazin.losses++;
                    }
                }
            });
        });
    }

    // Calculate totals (Blazin' 5 picks only)
    PICKERS.forEach(picker => {
        pnlData[picker].total = pnlData[picker].blazin.profit;
    });

    return pnlData;
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
async function loadAllWeeklyDataForBlazin() {
    // Only use corsproxy.io which we know works
    const proxy = 'https://corsproxy.io/?';

    let loadedWeeks = 0;
    let failedWeeks = 0;

    // Build array of weeks that need fetching
    const weeksToFetch = [];
    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
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
    const yearChangeClass = picker.yearChange?.includes('▲') ? 'up' : 'down';
    const pctClass = picker.percentage >= 50 ? 'positive' : 'negative';
    const compactClass = isCompact ? 'compact' : '';
    const isPlayoffs = currentSubcategory === 'playoffs';

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
            <span class="stat-value ${parseFloat(picker.last3WeekPct) >= 50 ? 'positive' : 'negative'}">
                ${picker.last3WeekPct?.toFixed ? picker.last3WeekPct.toFixed(2) : picker.last3WeekPct || '-'}%
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
                    ${!isPlayoffs && picker.winnings !== undefined ? `
                        <div class="year-comparison">
                            <div class="betting-winnings ${picker.winningsRaw >= 0 ? 'positive' : 'negative'}">
                                <span class="comparison-label">$20/pick ${picker.winningsRaw >= 0 ? 'profit' : 'loss'}:</span>
                                <span class="comparison-value">${picker.winningsRaw >= 0 ? '+' : ''}${picker.winnings}</span>
                            </div>
                        </div>
                    ` : ''}
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
                    <span class="stat-value ${parseFloat(picker.last3WeekPct) >= 50 ? 'positive' : 'negative'}">
                        ${picker.last3WeekPct?.toFixed ? picker.last3WeekPct.toFixed(2) : picker.last3WeekPct || '-'}%
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
                ${picker.winnings !== undefined ? `
                    <div class="betting-winnings ${picker.winningsRaw >= 0 ? 'positive' : 'negative'}">
                        <span class="comparison-label">$20/pick ${picker.winningsRaw >= 0 ? 'profit' : 'loss'}:</span>
                        <span class="comparison-value">${picker.winningsRaw >= 0 ? '+' : ''}${picker.winnings}</span>
                    </div>
                ` : ''}
            </div>
            ` : ''}
        </div>
    `;
}

/**
 * Render standings table
 */
function renderStandingsTable(stats) {
    const tbody = document.getElementById('standings-table-body');
    const thead = document.querySelector('#standings-table thead');
    if (!tbody || !thead) return;

    const sorted = getSortedPickers(stats);

    // Playoffs uses a different table layout showing Line/SU/O/U breakdown
    if (currentSubcategory === 'playoffs') {
        // Update table title to explain combined scoring (only target the one in performance-insights)
        const tableTitle = document.querySelector('#performance-insights-section .standings-panel h3');
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
    const tableTitle = document.querySelector('#performance-insights-section .standings-panel h3');
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
            <th>High %</th>
            <th>Low %</th>
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

        // Format percentages
        const pct = typeof picker.percentage === 'number' ? picker.percentage.toFixed(2) + '%' : picker.percentage || '-';
        const last3Wk = typeof picker.last3WeekPct === 'number' ? picker.last3WeekPct.toFixed(2) + '%' : picker.last3WeekPct || '-';
        const highPct = typeof picker.highestPct === 'number' ? picker.highestPct.toFixed(2) + '%' : picker.highestPct || '-';
        const lowPct = typeof picker.lowestPct === 'number' ? picker.lowestPct.toFixed(2) + '%' : picker.lowestPct || '-';

        // Determine push/draw label based on category
        const pushOrDraw = currentSubcategory === 'winner' ? picker.draws || 0 : picker.pushes || 0;

        return `
            <tr class="${index === 0 ? 'leader' : ''}">
                <td class="picker-name">${picker.name}</td>
                <td>${picker.wins || 0}</td>
                <td>${picker.losses || 0}</td>
                <td>${pushOrDraw}</td>
                <td class="pct">${pct}</td>
                <td>${picker.totalPicks || 0}</td>
                <td>${last3Wk}</td>
                <td class="best-week">${picker.bestWeek || '-'}</td>
                <td>${highPct}</td>
                <td>${lowPct}</td>
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

        // Determine percentage color class
        let pctClass = 'pct';
        if (pctValue > 50) {
            pctClass += ' pct-positive';
        } else if (pctValue < 50) {
            pctClass += ' pct-negative';
        } else {
            pctClass += ' pct-neutral';
        }

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
        const weekGames = getGamesForWeek(week);
        const weekPicks = allPicks[week] || allPicks[weekStr] || {};
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

    let weekGames = getGamesForWeek(currentWeek);
    const weekStr = String(currentWeek);
    // Merge picks from both allPicks and weeklyPicksCache (Google Sheets data)
    // Try both number and string keys for compatibility with historical data
    const weekPicks = allPicks[currentWeek] || allPicks[weekStr] || {};
    const localPicks = weekPicks[currentPicker] || {};
    const cachedPicks = weeklyPicksCache[currentWeek]?.picks?.[currentPicker] || weeklyPicksCache[weekStr]?.picks?.[currentPicker] || {};
    const pickerPicks = { ...cachedPicks, ...localPicks }; // Local picks override cached
    const isHistoricalWeek = currentWeek < CURRENT_NFL_WEEK;

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
    const blazinCount = isPlayoff ? 0 : weekGames.reduce((count, g) => {
        const gPicks = getPicksForGame(pickerPicks, g);
        return count + (gPicks.blazin ? 1 : 0);
    }, 0);

    gamesList.innerHTML = weekGames.map(game => {
        const gameIdStr = String(game.id);
        const gamePicks = getPicksForGame(pickerPicks, game);
        const linePick = gamePicks.line;
        const winnerPick = gamePicks.winner;
        const isBlazin = gamePicks.blazin || false;
        const hasLinePick = linePick !== undefined;
        const hasWinnerPick = winnerPick !== undefined;
        const hasBothPicks = hasLinePick && hasWinnerPick;

        // Get live score data if available
        const liveData = getLiveGameStatus(game);
        const inProgressStatuses = ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD'];
        const isInProgress = liveData && inProgressStatuses.includes(liveData.status);
        const isFinal = liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed);

        // Game is locked if: isGameLocked returns true OR game is final from live data
        const locked = isGameLocked(game) || isFinal;

        const awaySpread = game.favorite === 'away' ? -game.spread : game.spread;
        const homeSpread = game.favorite === 'home' ? -game.spread : game.spread;

        const awaySpreadDisplay = awaySpread > 0 ? `+${awaySpread}` : awaySpread;
        const homeSpreadDisplay = homeSpread > 0 ? `+${homeSpread}` : homeSpread;

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
                const atsWinner = calculateATSWinner(game, result);
                // Line pick results
                if (linePick === 'away') {
                    lineAwayResult = atsWinner === 'push' ? 'push' : (atsWinner === 'away' ? 'correct' : 'incorrect');
                }
                if (linePick === 'home') {
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
            isFinal ? 'game-final' : '',
            isInProgress ? 'game-in-progress' : ''
        ].filter(Boolean).join(' ');

        // Build status badge
        let statusBadge = '';
        if (isFinal || isHistoricalWeek) {
            statusBadge = `<span class="status-badge final">FINAL</span>`;
        } else if (isInProgress) {
            let clockDisplay;
            if (liveData.status === 'STATUS_HALFTIME') {
                clockDisplay = 'Half';
            } else if (liveData.status === 'STATUS_END_PERIOD') {
                clockDisplay = `End Q${liveData.period}`;
            } else {
                clockDisplay = liveData.clock ? `${liveData.clock} Q${liveData.period}` : 'Live';
            }
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
        const canToggleBlazin = !locked && hasLinePick && (isBlazin || blazinCount < 5);
        const blazinDisabled = locked || !hasLinePick || (!isBlazin && blazinCount >= 5);
        const blazinTitle = blazinDisabled
            ? (locked ? 'Game is locked' : (!hasLinePick ? 'Make a line pick first' : 'Maximum 5 Blazin picks reached'))
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
                        ${game.away} (${awaySpreadDisplay})
                    </span>
                    <span class="at-symbol">@</span>
                    <span class="home-team">
                        <img src="${getTeamLogo(game.home)}" alt="${game.home} logo" class="team-logo" onerror="handleLogoError(this, '${game.home}')">
                        ${game.home} (${homeSpreadDisplay})
                    </span>
                </div>

                <div class="picks-row">
                    <div class="pick-type">
                        <span class="pick-label">Line Pick (ATS)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${linePick === 'away' ? 'selected' : ''} ${lineAwayResult}"
                                    data-game-id="${game.id}" data-pick-type="line" data-team="away"
                                    ${locked ? 'disabled' : ''}>
                                ${game.away} ${awaySpreadDisplay}
                            </button>
                            <button class="pick-btn ${linePick === 'home' ? 'selected' : ''} ${lineHomeResult}"
                                    data-game-id="${game.id}" data-pick-type="line" data-team="home"
                                    ${locked ? 'disabled' : ''}>
                                ${game.home} ${homeSpreadDisplay}
                            </button>
                        </div>
                    </div>
                    <div class="pick-type">
                        <span class="pick-label">Straight Up (Winner)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${winnerPick === 'away' ? 'selected' : ''} ${winnerAwayResult}"
                                    data-game-id="${game.id}" data-pick-type="winner" data-team="away"
                                    ${locked ? 'disabled' : ''}>
                                ${game.away}
                            </button>
                            <button class="pick-btn ${winnerPick === 'home' ? 'selected' : ''} ${winnerHomeResult}"
                                    data-game-id="${game.id}" data-pick-type="winner" data-team="home"
                                    ${locked ? 'disabled' : ''}>
                                ${game.home}
                            </button>
                        </div>
                    </div>
                </div>

                ${renderLivePickStatus(game, liveData, gamePicks)}

                <div class="game-footer">
                    <div class="game-location">
                        <span class="location-city">${game.location}</span>
                        <span class="location-stadium">${game.stadium}</span>
                    </div>
                    ${isPlayoff ? `
                        <div class="ou-picker" data-game-id="${game.id}">
                            <span class="ou-label">O/U ${ouLine > 0 ? ouLine : 'TBD'}</span>
                            ${ouLine > 0 ? `
                                <button class="ou-btn ${ouPick === 'over' ? 'selected' : ''} ${ouOverResult}"
                                        data-game-id="${game.id}" data-pick-type="overUnder" data-value="over"
                                        ${locked ? 'disabled' : ''}>
                                    Over
                                </button>
                                <button class="ou-btn ${ouPick === 'under' ? 'selected' : ''} ${ouUnderResult}"
                                        data-game-id="${game.id}" data-pick-type="overUnder" data-value="under"
                                        ${locked ? 'disabled' : ''}>
                                    Under
                                </button>
                            ` : '<span class="ou-unavailable">Line TBD</span>'}
                        </div>
                    ` : `
                        <button class="blazin-star ${isBlazin ? 'active' : ''}"
                                data-game-id="${game.id}"
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
    document.querySelectorAll('.blazin-star').forEach(btn => {
        btn.addEventListener('click', handleBlazinToggle);
    });

    // Add click handlers for O/U buttons (playoffs)
    document.querySelectorAll('.ou-btn').forEach(btn => {
        btn.addEventListener('click', handleOUSelect);
    });

    // Setup keyboard navigation
    setupKeyboardNavigation();

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

    // Require a picker to be selected before making picks
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId; // Keep as string for consistent object keys
    const pickType = btn.dataset.pickType; // 'line' or 'winner'
    const team = btn.dataset.team; // 'away' or 'home'

    // Look up the game to get matchup key (more reliable than game ID across data sources)
    const weekGames = getGamesForWeek(currentWeek);
    const game = weekGames.find(g => String(g.id) === gameId);

    // Use matchup key for storing picks (portable across ESPN/historical data sources)
    // Fall back to gameId if game not found (shouldn't happen)
    const pickKey = game ? getMatchupKey(game) : gameId;

    // Ensure week and picker structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    // Initialize game picks object if needed
    if (!allPicks[currentWeek][currentPicker][pickKey]) {
        allPicks[currentWeek][currentPicker][pickKey] = {};
    }

    // Get current selection state
    const currentSelection = allPicks[currentWeek][currentPicker][pickKey][pickType];
    const isDeselecting = currentSelection === team;
    const otherTeam = team === 'home' ? 'away' : 'home';
    let autoSelectWinner = false;

    // Toggle selection
    if (isDeselecting) {
        delete allPicks[currentWeek][currentPicker][pickKey][pickType];
        // Clean up empty game object
        if (Object.keys(allPicks[currentWeek][currentPicker][pickKey]).length === 0) {
            delete allPicks[currentWeek][currentPicker][pickKey];
        }
    } else {
        allPicks[currentWeek][currentPicker][pickKey][pickType] = team;

        // If picking a favorite on the line, automatically pick them to win
        if (pickType === 'line') {
            if (game && game.favorite === team) {
                // Picked the favorite to cover, auto-select them as winner
                allPicks[currentWeek][currentPicker][pickKey].winner = team;
                autoSelectWinner = true;
            }
        }
    }

    // Clear the "intentionally cleared" flag since user is making new picks
    // This allows future backup restores
    if (clearedPicks[currentWeek]?.[currentPicker]) {
        delete clearedPicks[currentWeek][currentPicker];
        localStorage.setItem('clearedPicks', JSON.stringify(clearedPicks));
    }

    // Save to localStorage (this will also sync cleared=false to Google Sheets)
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
    const pickerPicks = allPicks[currentWeek][currentPicker] || {};
    const blazinCount = Object.values(pickerPicks).filter(p => p.blazin).length;
    document.querySelectorAll('.blazin-star').forEach(starBtn => {
        const isActive = starBtn.classList.contains('active');
        const gameCard = starBtn.closest('.game-card');
        const isLocked = gameCard && gameCard.classList.contains('game-locked');
        const starGameId = starBtn.dataset.gameId;
        const starGamePicks = pickerPicks[starGameId] || {};
        const hasStarLinePick = starGamePicks.line !== undefined;

        if (isLocked) {
            starBtn.disabled = true;
        } else if (!hasStarLinePick && !isActive) {
            starBtn.disabled = true;
            starBtn.title = 'Make a line pick first';
        } else if (isActive) {
            starBtn.disabled = false;
        } else {
            starBtn.disabled = blazinCount >= 5;
        }
    });

    // Update scoring summary
    renderScoringSummary();
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
        const gameId = String(game.id);
        const gamePicks = pickerPicks[gameId];
        if (gamePicks?.line && gamePicks?.winner) {
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

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId;
    const value = btn.dataset.value; // 'over' or 'under'

    if (!gameId || btn.disabled) return;

    // Initialize picks structure
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }
    if (!allPicks[currentWeek][currentPicker][gameId]) {
        allPicks[currentWeek][currentPicker][gameId] = {};
    }

    // Get current selection
    const currentSelection = allPicks[currentWeek][currentPicker][gameId].overUnder;
    const isDeselecting = currentSelection === value;

    // Toggle selection
    if (isDeselecting) {
        delete allPicks[currentWeek][currentPicker][gameId].overUnder;
        delete allPicks[currentWeek][currentPicker][gameId].totalLine;
    } else {
        allPicks[currentWeek][currentPicker][gameId].overUnder = value;
        // Store the line at time of pick
        const weekGames = getGamesForWeek(currentWeek);
        const game = weekGames.find(g => String(g.id) === gameId);
        if (game && game.overUnder) {
            allPicks[currentWeek][currentPicker][gameId].totalLine = game.overUnder;
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

    // Update scoring summary
    renderScoringSummary();
}

/**
 * Handle Blazin' 5 star toggle
 */
function handleBlazinToggle(e) {
    e.preventDefault();
    e.stopPropagation();

    // Require a picker to be selected before making picks
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId;

    if (!gameId || btn.disabled) return;

    // Initialize picks structure
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }
    if (!allPicks[currentWeek][currentPicker][gameId]) {
        allPicks[currentWeek][currentPicker][gameId] = {};
    }

    // Toggle blazin status
    const currentBlazin = allPicks[currentWeek][currentPicker][gameId].blazin || false;
    const newBlazin = !currentBlazin;
    allPicks[currentWeek][currentPicker][gameId].blazin = newBlazin;

    // Update just this button
    btn.classList.toggle('active', newBlazin);
    btn.innerHTML = `<span class="blazin-label">B5</span>${newBlazin ? '★' : '☆'}`;
    btn.title = newBlazin ? 'Remove from Blazin 5' : 'Add to Blazin 5';

    // Count current blazin picks and update other star buttons
    const pickerPicks = allPicks[currentWeek][currentPicker] || {};
    const blazinCount = Object.values(pickerPicks).filter(p => p.blazin).length;

    // Enable/disable other star buttons based on count and line picks
    document.querySelectorAll('.blazin-star').forEach(starBtn => {
        const isActive = starBtn.classList.contains('active');
        const gameCard = starBtn.closest('.game-card');
        const isLocked = gameCard && gameCard.classList.contains('game-locked');
        const starGameId = starBtn.dataset.gameId;
        const starGamePicks = pickerPicks[starGameId] || {};
        const hasStarLinePick = starGamePicks.line !== undefined;

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
                const pick = weekPicks[game.id];
                if (!pick || !pick.line) return;

                const result = results[game.id];
                if (!result) return;

                const atsResult = calculateATSWinner(game, result);
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

                const pick = weekPicks[game.id];
                if (!pick || !pick.line) return;

                const result = results[game.id];
                if (!result) return;

                const atsResult = calculateATSWinner(game, result);
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
 * Calculate ATS winner based on score and spread
 */
function calculateATSWinner(game, result) {
    if (!result) return null;

    const awayScoreAdjusted = result.awayScore + (game.favorite === 'home' ? game.spread : -game.spread);
    const homeScoreAdjusted = result.homeScore + (game.favorite === 'away' ? game.spread : -game.spread);

    // Actually simpler: away team gets points if home is favorite, vice versa
    const awayWithSpread = result.awayScore + (game.favorite === 'away' ? 0 : game.spread);
    const homeWithSpread = result.homeScore + (game.favorite === 'home' ? 0 : game.spread);

    if (awayWithSpread > homeWithSpread) return 'away';
    if (homeWithSpread > awayWithSpread) return 'home';
    return 'push';
}

/**
 * Calculate live pick margin for in-progress games
 * Returns the current spread margin for the picker's selection
 */
function calculateLivePickMargin(game, liveData, pick) {
    if (!liveData || !pick || !pick.line) return null;

    const { awayScore, homeScore } = liveData;
    const { spread, favorite } = game;

    // Calculate the picked team's spread
    let pickedTeam, pickedSpread, currentMargin;

    if (pick.line === 'away') {
        pickedTeam = game.away;
        // Away team gets points if home is favorite, loses points if away is favorite
        pickedSpread = favorite === 'away' ? -spread : spread;
        // Current margin from away team's perspective (positive = away winning)
        currentMargin = (awayScore - homeScore) + pickedSpread;
    } else {
        pickedTeam = game.home;
        // Home team gets points if away is favorite, loses points if home is favorite
        pickedSpread = favorite === 'home' ? -spread : spread;
        // Current margin from home team's perspective (positive = home winning)
        currentMargin = (homeScore - awayScore) + pickedSpread;
    }

    // Format the spread display
    const spreadDisplay = pickedSpread > 0 ? `+${pickedSpread}` : pickedSpread === 0 ? 'PK' : pickedSpread;

    // Determine status and message
    let status, message;
    if (currentMargin > 0) {
        status = 'covering';
        message = `+${currentMargin} ATS`;
    } else if (currentMargin < 0) {
        status = 'losing';
        message = `${currentMargin} ATS`;
    } else {
        status = 'push';
        message = 'Currently a push';
    }

    return {
        status,
        margin: currentMargin,
        message,
        pickedTeam,
        spreadDisplay
    };
}

/**
 * Render live pick status HTML for in-progress games
 */
function renderLivePickStatus(game, liveData, pick) {
    // Only show for in-progress games with a line pick
    if (!liveData || !pick || !pick.line) return '';

    const inProgressStatuses = ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD'];
    if (!inProgressStatuses.includes(liveData.status)) return '';

    const marginData = calculateLivePickMargin(game, liveData, pick);
    if (!marginData) return '';

    const { status, message, pickedTeam, spreadDisplay } = marginData;

    return `
        <div class="live-pick-status ${status}">
            <span class="live-pick-margin">${message}</span>
        </div>
    `;
}

/**
 * Render scoring summary table - Simple per-player summary
 */
function renderScoringSummary() {
    const scoringTable = document.getElementById('scoring-table');
    if (!scoringTable) return;

    const weekGames = getGamesForWeek(currentWeek);
    const weekResults = getResultsForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};
    const cachedWeek = weeklyPicksCache[currentWeek];

    // Update the summary header
    const summaryHeader = document.querySelector('.scoring-summary h3');
    if (summaryHeader) {
        const weekLabel = isPlayoffWeek(currentWeek) ? getWeekDisplayName(currentWeek) : `Week ${getWeekDisplayName(currentWeek)}`;
        summaryHeader.textContent = `${weekLabel} Scoring Summary`;
    }

    const isPlayoff = isPlayoffWeek(currentWeek);

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

            const atsWinner = calculateATSWinner(game, result);
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
                const ouLine = game.overUnder || gamePicks.totalLine || cachedGamePicks.totalLine;
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
 * Clear current picker's picks for the current week (only unlocked games)
 */
function clearCurrentPickerPicks() {
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

                // Preserve picks for locked games
                games.forEach(game => {
                    const gameIdStr = String(game.id);
                    const existingPick = allPicks[currentWeek][currentPicker][gameIdStr];

                    if (existingPick && isGameLocked(game)) {
                        preservedPicks[gameIdStr] = existingPick;
                    }
                });

                allPicks[currentWeek][currentPicker] = preservedPicks;
            }

            // Mark picks as intentionally cleared (prevents backup restore)
            if (!clearedPicks[currentWeek]) {
                clearedPicks[currentWeek] = {};
            }
            clearedPicks[currentWeek][currentPicker] = true;
            localStorage.setItem('clearedPicks', JSON.stringify(clearedPicks));

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
                    localStorage.setItem('clearedPicks', JSON.stringify(clearedPicks));
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
        localStorage.removeItem('nflPicks');
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
                const gameIdStr = String(game.id);
                const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
                const linePick = gamePicks.line;
                const winnerPick = gamePicks.winner;

                const lineTeam = linePick === 'away' ? game.away : linePick === 'home' ? game.home : null;
                const winnerTeam = winnerPick === 'away' ? game.away : winnerPick === 'home' ? game.home : null;

                // Calculate spread for display
                let spreadDisplay = '';
                if (linePick) {
                    const spread = linePick === 'away'
                        ? (game.favorite === 'away' ? -game.spread : game.spread)
                        : (game.favorite === 'home' ? -game.spread : game.spread);
                    spreadDisplay = spread > 0 ? `+${spread}` : spread;
                }

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
        const gameIdStr = String(game.id);
        const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};

        if (gamePicks.line || gamePicks.winner) {
            pickCount++;
            const awaySpread = game.favorite === 'away' ? -game.spread : game.spread;
            const homeSpread = game.favorite === 'home' ? -game.spread : game.spread;

            text += `${game.away} @ ${game.home}\n`;

            if (gamePicks.line) {
                const lineTeam = gamePicks.line === 'away' ? game.away : game.home;
                const spread = gamePicks.line === 'away' ? awaySpread : homeSpread;
                const spreadStr = spread > 0 ? `+${spread}` : spread;
                text += `  ATS: ${lineTeam} (${spreadStr})\n`;
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
            const gameIdStr = String(game.id);
            const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};

            // Only include if there's at least a line pick
            if (gamePicks.line) {
                const parts = [];

                // Line pick with spread
                const lineTeam = gamePicks.line === 'away' ? game.away : game.home;
                const awaySpread = game.favorite === 'away' ? -game.spread : game.spread;
                const homeSpread = game.favorite === 'home' ? -game.spread : game.spread;
                const spread = gamePicks.line === 'away' ? awaySpread : homeSpread;
                const spreadStr = spread > 0 ? `+${spread}` : spread;
                parts.push(`${lineTeam} (${spreadStr})`);

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
 * Randomize picks for the current picker
 * Rule: If picking the favorite on the line, also pick them to win straight up
 */
function randomizePicks() {
    if (!currentPicker) {
        showToast('Please select a picker first', 'warning');
        return;
    }

    const weekGames = getGamesForWeek(currentWeek);

    if (weekGames.length === 0) {
        alert('No games available for this week.');
        return;
    }

    // Ensure structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    // Randomize each game
    weekGames.forEach(game => {
        const gameIdStr = String(game.id);
        
        // Skip locked games
        if (isGameLocked(game)) return;

        // Random line pick (50/50 away or home)
        const linePick = Math.random() < 0.5 ? 'away' : 'home';
        
        // Winner pick logic:
        // If we picked the favorite on the line, they must also be our winner pick
        // Otherwise, random winner pick
        let winnerPick;
        if (linePick === game.favorite) {
            // Picked favorite to cover, so pick them to win
            winnerPick = linePick;
        } else {
            // Picked underdog to cover, winner can be random
            winnerPick = Math.random() < 0.5 ? 'away' : 'home';
        }

        allPicks[currentWeek][currentPicker][gameIdStr] = {
            line: linePick,
            winner: winnerPick
        };
    });

    // Save and re-render
    savePicksToStorage();
    renderGames();
    renderScoringSummary();
}

/**
 * Save picks to localStorage and optionally sync to Google Sheets
 * @param {boolean} showSyncToast - Whether to show a toast on successful sync
 * @param {boolean} skipSync - If true, skip syncing to Google Sheets (used when loading from backup)
 */
function savePicksToStorage(showSyncToast = false, skipSync = false) {
    localStorage.setItem('nflPicks', JSON.stringify(allPicks));

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
 * Sync current picker's picks for current week to Google Sheets
 */
async function syncPicksToGoogleSheets(displayToast = true) {
    if (!APPS_SCRIPT_URL) {
        return;
    }

    const weekPicks = allPicks[currentWeek]?.[currentPicker];
    if (!weekPicks || Object.keys(weekPicks).length === 0) {
        return;
    }

    // Convert picks to the format expected by Google Apps Script
    const weekGames = getGamesForWeek(currentWeek);
    const formattedPicks = [];

    for (const [gameId, pickData] of Object.entries(weekPicks)) {
        const game = weekGames.find(g => String(g.id) === String(gameId));
        if (!game) continue;

        const awaySpread = game.favorite === 'away' ? -game.spread : game.spread;
        const homeSpread = game.favorite === 'home' ? -game.spread : game.spread;

        // Convert 'away'/'home' to actual team names
        const lineTeam = pickData?.line ? (pickData.line === 'away' ? game.away : game.home) : '';
        const winnerTeam = pickData?.winner ? (pickData.winner === 'away' ? game.away : game.home) : '';

        formattedPicks.push({
            gameId: gameId,
            away: game.away,
            home: game.home,
            awaySpread: awaySpread,
            homeSpread: homeSpread,
            linePick: lineTeam,
            winnerPick: winnerTeam,
            blazin: pickData?.blazin || false,
            overUnder: pickData?.overUnder || '',
            totalLine: pickData?.totalLine || ''
        });
    }

    if (formattedPicks.length === 0) {
        return;
    }

    const payload = {
        week: currentWeek,
        picker: currentPicker,
        picks: formattedPicks,
        cleared: false  // Always reset cleared flag when syncing picks
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
        week: week,
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
            week: week,
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
 * Load spreads from Google Sheets backup
 * For current/past weeks: Google Sheets is authoritative (allows manual corrections)
 * For future weeks: localStorage takes priority (avoids unnecessary overwrites)
 * Returns { spreads, lastUpdated } or null if failed
 */
async function loadSpreadsFromGoogleSheets(week) {
    try {
        console.log(`[Spreads Load] Fetching spreads for week ${week} from Google Sheets...`);
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=spreads&week=${week}`);
        const result = await response.json();

        if (result.spreads && Object.keys(result.spreads).length > 0) {
            console.log(`[Spreads Load] Loaded ${result.count} spreads for week ${week} from Google Sheets (last updated: ${result.lastUpdated || 'unknown'})`);

            const saved = getSavedSpreads();
            if (!saved[week]) {
                saved[week] = {};
            }

            const weekNum = parseInt(week);
            const isCurrentOrPastWeek = weekNum <= CURRENT_NFL_WEEK;

            for (const [key, data] of Object.entries(result.spreads)) {
                if (isCurrentOrPastWeek) {
                    // Current/past weeks: Google Sheets is authoritative (allows manual corrections)
                    saved[week][key] = data;
                } else {
                    // Future weeks: only use Google Sheets if localStorage is missing or has spread=0
                    if (!saved[week][key] || !saved[week][key].spread || saved[week][key].spread === 0) {
                        saved[week][key] = data;
                    }
                }
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
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=picks&week=${week}&picker=${encodeURIComponent(picker)}`);
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
            localStorage.setItem('clearedPicks', JSON.stringify(clearedPicks));
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

            for (const [gameId, pickData] of Object.entries(result.picks)) {
                // Overwrite with backup data (backup is source of truth)
                allPicks[week][picker][gameId] = pickData;
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
        const response = await fetch(`${WORKER_PROXY_URL}/sync?action=allpicks`);
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
            for (const week in result.cleared) {
                if (!clearedPicks[week]) {
                    clearedPicks[week] = {};
                }
                for (const picker in result.cleared[week]) {
                    clearedPicks[week][picker] = true;
                    // Also clear local picks to match server state
                    const weekNum = parseInt(week);
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
        localStorage.setItem('clearedPicks', JSON.stringify(clearedPicks));
        console.log('[Picks Load] Synced clearedPicks from server:', clearedPicks);

        // Merge picks from backup into allPicks
        if (result.picks) {
            let totalPicks = 0;
            for (const week in result.picks) {
                const weekNum = parseInt(week);

                // Skip playoff weeks that have historical data - historical data is authoritative
                if (weekNum >= 19 && typeof HISTORICAL_PICKS !== 'undefined' && HISTORICAL_PICKS[week]) {
                    continue;
                }

                for (const picker in result.picks[week]) {
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

                    // Overwrite with backup data (backup is source of truth)
                    for (const gameId in result.picks[week][picker]) {
                        allPicks[weekNum][picker][gameId] = result.picks[week][picker][gameId];
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
            for (const week in result.results) {
                const weekNum = parseInt(week);

                // Skip if historical data already has complete results for this week
                if (typeof HISTORICAL_RESULTS !== 'undefined' && HISTORICAL_RESULTS[week] &&
                    Object.keys(HISTORICAL_RESULTS[week]).length > 0) {
                    // Still merge - backup results might have more recent data
                }

                if (!NFL_RESULTS_BY_WEEK[weekNum]) {
                    NFL_RESULTS_BY_WEEK[weekNum] = {};
                }

                for (const gameKey in result.results[week]) {
                    const resultData = result.results[week][gameKey];

                    // Find the game by matchup key to get the game ID
                    const games = getGamesForWeek(weekNum);
                    const matchingGame = games.find(g => {
                        const key = `${g.away.toLowerCase()}_${g.home.toLowerCase()}`;
                        return key === gameKey;
                    });

                    if (matchingGame) {
                        // Use game ID as the key (consistent with existing code)
                        NFL_RESULTS_BY_WEEK[weekNum][matchingGame.id] = {
                            winner: resultData.winner,
                            awayScore: resultData.awayScore,
                            homeScore: resultData.homeScore
                        };
                        totalResults++;
                    }
                }
            }
            console.log(`[Results Load] Loaded ${totalResults} results across ${result.weekCount} weeks from Google Sheets backup`);
        } else {
            console.log('[Results Load] No results in response');
        }
    } catch (error) {
        console.error('[Results Load] Failed to load results from Google Sheets backup:', error);
    }
}

/**
 * Sync game results to Google Sheets when games finish
 * @param {number} week - The week number
 * @param {string} source - Source of the results (e.g., 'ESPN')
 */
async function syncResultsToGoogleSheets(week, source = 'ESPN') {
    if (!APPS_SCRIPT_URL) {
        return;
    }

    const games = getGamesForWeek(week);
    if (!games || games.length === 0) {
        return;
    }

    const resultsToSync = {};
    let newResults = 0;

    for (const game of games) {
        // Get live status for the game
        const liveData = getLiveGameStatus(game);

        // Check if game is final
        const isFinal = (liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed)) ||
                        (game.status === 'STATUS_FINAL' || game.completed);

        if (!isFinal) continue;

        // Get the game key for tracking
        const gameKey = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
        const syncKey = `${week}_${gameKey}`;

        // Skip if already synced
        if (resultsSyncedGames[syncKey]) continue;

        // Get scores
        const awayScore = liveData?.awayScore ?? game.awayScore ?? 0;
        const homeScore = liveData?.homeScore ?? game.homeScore ?? 0;

        // Skip if no scores available
        if (awayScore === 0 && homeScore === 0) continue;

        resultsToSync[gameKey] = {
            awayScore: awayScore,
            homeScore: homeScore
        };

        // Mark as synced to prevent duplicate syncs
        resultsSyncedGames[syncKey] = true;
        newResults++;
    }

    if (newResults === 0) {
        return;
    }

    console.log(`[Results Sync] Syncing ${newResults} new results for week ${week}...`);

    const payload = {
        week: week,
        results: resultsToSync,
        source: source
    };

    try {
        const response = await fetch(`${WORKER_PROXY_URL}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (result.success) {
            console.log(`[Results Sync] Synced ${newResults} results for week ${week}:`, result.results?.results?.message);
        } else {
            console.error('[Results Sync] Sync failed:', result.error);
            // Reset synced status on failure so we can retry
            for (const gameKey in resultsToSync) {
                delete resultsSyncedGames[`${week}_${gameKey}`];
            }
        }
    } catch (error) {
        console.error('[Results Sync] Failed to sync results:', error);
        // Reset synced status on failure so we can retry
        for (const gameKey in resultsToSync) {
            delete resultsSyncedGames[`${week}_${gameKey}`];
        }
    }
}

/**
 * Load picks from localStorage
 */
function loadPicksFromStorage() {
    const saved = localStorage.getItem('nflPicks');
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
            localStorage.removeItem('nflPicks');
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

function showConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');

    if (modal && modalTitle && modalMessage) {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalConfirmCallback = onConfirm;
        modal.classList.add('show');
    }
}

function hideConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    modalConfirmCallback = null;
}

function setupConfirmModal() {
    document.getElementById('modal-cancel-btn')?.addEventListener('click', hideConfirmModal);
    document.getElementById('modal-confirm-btn')?.addEventListener('click', () => {
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
 * Setup back to top button
 */
function setupBackToTop() {
    const backToTopBtn = document.getElementById('back-to-top');
    if (!backToTopBtn) return;

    // Show/hide button based on scroll position
    window.addEventListener('scroll', () => {
        if (window.scrollY > 300) {
            backToTopBtn.classList.add('visible');
        } else {
            backToTopBtn.classList.remove('visible');
        }
    });

    // Scroll to top when clicked
    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
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

    // Save state to localStorage
    const collapsedSections = getCollapsedSections();
    if (isCollapsed) {
        collapsedSections[sectionId] = true;
    } else {
        delete collapsedSections[sectionId];
    }
    saveCollapsedSections(collapsedSections);
}

function initCollapsibleSections() {
    const collapsedSections = getCollapsedSections();

    // Apply saved collapsed states
    Object.keys(collapsedSections).forEach(sectionId => {
        const section = document.querySelector(`[data-section="${sectionId}"]`);
        if (section && collapsedSections[sectionId]) {
            section.classList.add('collapsed');
            // Update icon to +
            const icon = section.querySelector('.collapse-toggle-icon');
            if (icon) {
                icon.textContent = '+';
            }
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
 * Calculate weekly bankroll for a picker based on Blazin' 5 picks
 * Uses the same P&L calculation as the Standings section for consistency
 * $20 flat bet per pick, $100/week added to bankroll
 * @param {string} picker - Picker name
 * @returns {Array} Array of { week, bankroll, invested, returnPct } objects
 */
function calculatePickerWeeklyBankroll(picker) {
    const weeklyData = [];
    let totalInvested = 0;
    let bankroll = 0;
    let totalWins = 0, totalLosses = 0, totalPushes = 0;

    for (let week = 1; week <= CURRENT_NFL_WEEK; week++) {
        const games = NFL_GAMES_BY_WEEK[week];
        const results = NFL_RESULTS_BY_WEEK[week];

        // Add $100 investment for this week
        totalInvested += 100;
        bankroll += 100;

        if (!games || !results) {
            weeklyData.push({
                week,
                bankroll,
                invested: totalInvested,
                returnPct: ((bankroll - totalInvested) / totalInvested) * 100
            });
            continue;
        }

        // Count wins/losses for this week's Blazin' 5 picks
        // Uses same logic as calculateAllPickersPnL for consistency
        let weekWins = 0;
        let weekLosses = 0;
        let weekPushes = 0;

        games.forEach(game => {
            const gameId = game.id;
            const result = results[gameId] || results[String(gameId)];
            if (!result) return;

            const pickerPicks = allPicks[week]?.[picker] || {};
            const cachedPicks = weeklyPicksCache[week]?.picks?.[picker] || {};
            const pick = pickerPicks[gameId] || pickerPicks[String(gameId)] ||
                       cachedPicks[gameId] || cachedPicks[String(gameId)];

            if (!pick || !pick.line) return;

            // Only count Blazin' 5 picks
            if (!pick.blazin) return;

            const atsWinner = calculateATSWinner(game, result);
            const isPush = atsWinner === 'push';
            const isWin = pick.line === atsWinner;

            if (isPush) {
                weekPushes++;
            } else if (isWin) {
                weekWins++;
            } else {
                weekLosses++;
            }
        });

        totalWins += weekWins;
        totalLosses += weekLosses;
        totalPushes += weekPushes;

        // Calculate this week's betting P&L
        // Flat $20 bet per Blazin' 5 pick
        const betPerPick = 20;
        const winnings = weekWins * betPerPick * (100 / 110); // Win pays ~0.909x
        const losses = weekLosses * betPerPick;
        bankroll = bankroll + winnings - losses;

        weeklyData.push({
            week,
            bankroll,
            invested: totalInvested,
            returnPct: ((bankroll - totalInvested) / totalInvested) * 100
        });
    }

    // Compare with P&L calculation
    const pnlData = calculateAllPickersPnL(20);
    const pnlRecord = pnlData[picker]?.blazin;
    if (pnlRecord) {
        const pnlMatch = totalWins === pnlRecord.wins && totalLosses === pnlRecord.losses;
        console.log(`[VsMarket] ${picker}: ${totalWins}-${totalLosses}-${totalPushes} (P&L: ${pnlRecord.wins}-${pnlRecord.losses}-${pnlRecord.pushes}) ${pnlMatch ? 'OK' : 'MISMATCH'}`);
    } else {
        console.log(`[VsMarket] ${picker}: ${totalWins}-${totalLosses}-${totalPushes}`);
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
                spread: g.spread || 0,
                favorite: g.favorite || 'home'
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

        PICKERS.forEach(picker => {
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
    let jsCode = `// Historical NFL Picks Data - Weeks 1-18 (2024 Season)
// Auto-generated from Google Sheets data on ${new Date().toISOString().split('T')[0]}

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
