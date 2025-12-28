/**
 * NFL Picks Dashboard - Main Application
 */

let dashboardData = null;
let currentCategory = 'make-picks';
let currentSubcategory = 'blazin'; // Default standings subcategory
let currentPicker = localStorage.getItem('selectedPicker') || 'Stephen';
let currentWeek = null; // Will be set to CURRENT_NFL_WEEK after it's calculated
let allPicks = {}; // Store picks for all pickers: { week: { picker: { gameId: { line: 'away'|'home', winner: 'away'|'home' } } } }
let initialLoadComplete = false; // Track whether initial data load is complete

// Available weeks (1-18 for regular season)
const TOTAL_WEEKS = 18;

/**
 * Calculate current NFL week based on date
 * 2025 NFL Season: Week 1 started September 4, 2025
 */
function calculateCurrentNFLWeek() {
    const SEASON_START = new Date('2025-09-02T00:00:00'); // Tuesday before Week 1
    const now = new Date();

    // If before season start, return week 1
    if (now < SEASON_START) return 1;

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
    // Week 18 games will be fetched dynamically from ESPN API
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
 */
function getLiveGameStatus(game) {
    // Try to match by team names
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
const SCHEDULE_CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

/**
 * Get cached schedule from localStorage
 */
function getCachedSchedule(week) {
    try {
        const cached = localStorage.getItem(`${SCHEDULE_CACHE_KEY}_week${week}`);
        if (!cached) return null;

        const { timestamp, data } = JSON.parse(cached);
        const age = Date.now() - timestamp;

        if (age < SCHEDULE_CACHE_DURATION) {
            const hoursAgo = (age / (1000 * 60 * 60)).toFixed(1);
            console.log(`[ESPN] Using cached schedule for week ${week} (${hoursAgo} hours old)`);
            // Sort cached data by kickoff time to ensure proper order
            if (data && data.length > 0) {
                data.sort((a, b) => {
                    const timeA = a.kickoff ? new Date(a.kickoff).getTime() : 0;
                    const timeB = b.kickoff ? new Date(b.kickoff).getTime() : 0;
                    return timeA - timeB;
                });
                // Reassign IDs after sorting
                data.forEach((game, index) => {
                    game.id = index + 1;
                });
            }
            return data;
        }

        console.log(`[ESPN] Schedule cache expired for week ${week}`);
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
    try {
        localStorage.setItem(`${SCHEDULE_CACHE_KEY}_week${week}`, JSON.stringify({
            timestamp: Date.now(),
            data: data
        }));
        console.log(`[ESPN] Schedule cached for week ${week}`);
    } catch (e) {
        console.warn('[ESPN] Error caching schedule:', e);
    }
}

/**
 * Format day name from date
 */
function getDayName(date) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[date.getDay()];
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
    if (!forceRefresh) {
        const cached = getCachedSchedule(week);
        if (cached) return cached;
    }

    try {
        console.log(`[ESPN] Fetching schedule for week ${week}...`);
        const response = await fetch(`${ESPN_SCHEDULE_URL}?week=${week}`);

        if (!response.ok) {
            throw new Error(`ESPN API error: ${response.status}`);
        }

        const data = await response.json();
        const games = [];

        if (data.events) {
            data.events.forEach((event, index) => {
                const competition = event.competitions[0];
                const competitors = competition.competitors;
                const homeTeam = competitors.find(c => c.homeAway === 'home');
                const awayTeam = competitors.find(c => c.homeAway === 'away');
                const venue = competition.venue;
                const gameDate = new Date(event.date);

                games.push({
                    id: index + 1,
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
                    broadcast: competition.broadcasts?.[0]?.names?.[0] || ''
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
    // For historical weeks, use stored data
    if (week < CURRENT_NFL_WEEK && HISTORICAL_GAMES && HISTORICAL_GAMES[week]) {
        console.log(`[Schedule] Using historical data for week ${week}`);
        NFL_GAMES_BY_WEEK[week] = HISTORICAL_GAMES[week];
        return NFL_GAMES_BY_WEEK[week];
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
        espnGames.forEach(game => {
            const key = `${game.away.toLowerCase()}_${game.home.toLowerCase()}`;
            if (existingSpreads[key]) {
                game.spread = existingSpreads[key].spread;
                game.favorite = existingSpreads[key].favorite;
                console.log(`[Schedule] Preserved spread for ${game.away} @ ${game.home}: ${game.spread}`);
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

    return NFL_GAMES_BY_WEEK[week];
}

/**
 * The Odds API configuration
 */
const ODDS_API_KEY = 'b6bb0ad3347ecbcc6922392025d33000';
const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/';
const ODDS_CACHE_KEY = 'nfl_odds_cache';
const ODDS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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
 * Fetch current NFL odds from The Odds API
 * Fetches spreads, moneyline (h2h), and totals (over/under)
 * Uses DraftKings as the primary source
 */
async function fetchNFLOdds(forceRefresh = false) {
    // Check cache first unless force refresh
    if (!forceRefresh) {
        const cached = getCachedOdds();
        if (cached) return cached;
    }

    const oddsUrl = `${ODDS_API_URL}?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,h2h,totals&oddsFormat=american&bookmakers=draftkings,fanduel`;

    // CORS proxies to try (same as Google Sheets)
    const CORS_PROXIES = [
        '', // Try direct first
        'https://corsproxy.io/?'
    ];

    for (const proxy of CORS_PROXIES) {
        try {
            const url = proxy ? proxy + encodeURIComponent(oddsUrl) : oddsUrl;
            console.log(`[Odds API] Fetching odds${proxy ? ' via proxy' : ' directly'}...`);

            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`Odds API error: ${response.status}`);
            }

            const games = await response.json();

            // Log remaining API requests from headers (only available on direct calls)
            if (!proxy) {
                const remaining = response.headers.get('x-requests-remaining');
                const used = response.headers.get('x-requests-used');
                console.log(`[Odds API] Requests used: ${used}, remaining: ${remaining}`);
            }

            console.log(`[Odds API] Fetched odds for ${games.length} games`);

            // Cache the results
            cacheOdds(games);

            return games;
        } catch (error) {
            console.warn(`[Odds API] Fetch failed${proxy ? ' with proxy' : ' (direct)'}:`, error.message);
        }
    }

    // All attempts failed - try stale cache
    console.error('[Odds API] All fetch attempts failed');
    const staleCache = localStorage.getItem(ODDS_CACHE_KEY);
    if (staleCache) {
        console.log('[Odds API] Using stale cache due to fetch error');
        return JSON.parse(staleCache).data;
    }
    return null;
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
 * - Game days: Fetch fresh odds from API (uses cache if valid)
 * - Non-game days with hardcoded spreads: Skip API call entirely
 * - Non-game days without hardcoded spreads: Fetch from API
 *
 * @param {boolean} forceRefresh - If true, bypass cache and fetch fresh data
 */
async function updateOddsFromAPI(forceRefresh = false) {
    const cached = getCachedOdds();
    const isGameDay = isNFLGameDay();
    const hasFallbackSpreads = hasHardcodedSpreads(currentWeek);

    // Hybrid logic: Skip API on non-game days if we have fallback spreads
    if (!forceRefresh && !isGameDay && hasFallbackSpreads) {
        console.log('[Odds API] Non-game day with fallback spreads - skipping API call');
        // If we have valid cache, apply it to update any stale hardcoded values
        if (cached) {
            console.log('[Odds API] Applying cached odds to games');
            return applyOddsData(cached);
        }
        // Otherwise use the hardcoded spreads as-is
        console.log('[Odds API] Using hardcoded fallback spreads');
        return true;
    }

    // Fetch odds from API (will use cache if valid)
    const oddsData = await fetchNFLOdds(forceRefresh);
    if (!oddsData) {
        console.warn('[Odds API] Could not fetch odds');
        // Fall back to hardcoded spreads if available
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
                    // Update game with all odds data
                    if (spread !== null) {
                        weekGame.spread = spread;
                        weekGame.favorite = favorite;
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

    // Debug: log what weeks have games loaded
    console.log('[Odds API] Weeks with games:', Object.keys(NFL_GAMES_BY_WEEK).filter(w => NFL_GAMES_BY_WEEK[w]?.length > 0));

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
    fetchLiveScores().then(() => {
        // Only render if initial load is complete (odds have been fetched)
        // During initial load, renderGames is called after updateOddsFromAPI
        if (initialLoadComplete) {
            renderGames();
            renderScoringSummary();
        }

        // Only start polling interval if games are scheduled or in progress
        if (shouldPollLiveScores()) {
            console.log('Games scheduled or in progress - starting live refresh');
            liveScoresRefreshInterval = setInterval(async () => {
                await fetchLiveScores();
                renderGames();
                renderScoringSummary();

                // Stop polling when all games are final
                if (!shouldPollLiveScores()) {
                    console.log('All games final - stopping live refresh');
                    stopLiveScoresRefresh();
                }
            }, 120000);
        } else {
            console.log('All games final or no games - skipping live refresh');
        }
    });
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
    return NFL_GAMES_BY_WEEK[week] || [];
}

// Helper function to get results for current week
function getResultsForWeek(week) {
    return NFL_RESULTS_BY_WEEK[week] || {};
}

// DOM Elements
const dashboard = document.getElementById('dashboard');
const leaderboard = document.getElementById('leaderboard');
const streaksGrid = document.getElementById('streaks-grid');
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

// Merge historical picks if available
if (typeof HISTORICAL_PICKS !== 'undefined') {
    for (const week in HISTORICAL_PICKS) {
        if (!allPicks[week]) {
            allPicks[week] = {};
        }
        for (const picker in HISTORICAL_PICKS[week]) {
            if (!allPicks[week][picker] || Object.keys(allPicks[week][picker]).length === 0) {
                allPicks[week][picker] = HISTORICAL_PICKS[week][picker];
            }
        }
    }
    console.log('Historical picks merged into allPicks');
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
    setupPnLSection();
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

    savePicksToStorage(false); // No toast for automated restore
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

    // Create options for weeks 1 through current NFL week
    let optionsHtml = '';
    for (let week = CURRENT_NFL_WEEK; week >= 1; week--) {
        const selected = week === currentWeek ? 'selected' : '';
        optionsHtml += `<option value="${week}" ${selected}>Week ${week}</option>`;
    }
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

    // Update header
    const picksWeekNum = document.getElementById('picks-week-num');
    if (picksWeekNum) {
        picksWeekNum.textContent = week;
    }
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (scoringWeekNum) {
        scoringWeekNum.textContent = week;
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

                // Merge into allPicks
                if (weekData.picks) {
                    allPicks[week] = weekData.picks;
                }
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

    // Load schedule from ESPN for current/future weeks
    // (historical weeks use data from weekly CSV or historical-data.js)
    if (week >= CURRENT_NFL_WEEK || !NFL_GAMES_BY_WEEK[week] || NFL_GAMES_BY_WEEK[week].length === 0) {
        await loadWeekSchedule(week);
        // Note: Odds are loaded once on page load and cached for 24 hours
        // No need to fetch on every week change
    }

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
function setActiveSubcategory(subcategory) {
    currentSubcategory = subcategory;

    // Update subtab styling
    subtabs.forEach(subtab => {
        subtab.classList.toggle('active', subtab.dataset.subcategory === subcategory);
    });

    // Re-render dashboard with new subcategory
    renderDashboard();
}

/**
 * Setup picker selection dropdown
 */
function setupPickerButtons() {
    const pickerDropdown = document.getElementById('picker-dropdown');
    if (!pickerDropdown) return;

    // Set initial value
    pickerDropdown.value = currentPicker;

    // Show/hide admin-only buttons based on picker
    updateAdminButtons();

    pickerDropdown.addEventListener('change', (e) => {
        currentPicker = e.target.value;
        localStorage.setItem('selectedPicker', currentPicker);
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
    const currentIndex = PICKERS.indexOf(currentPicker);

    if (prevBtn) prevBtn.disabled = currentIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentIndex >= PICKERS.length - 1;
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
            showToast('Spreads updated successfully!', 'success');
            renderGames(); // Re-render to show new spreads
        } else {
            showToast('Failed to update spreads. Check console for details.', 'error');
        }
    });

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
        picksWeekNum.textContent = currentWeek;
    }
    const scoringWeekNum = document.getElementById('scoring-week-num');
    if (scoringWeekNum) {
        scoringWeekNum.textContent = currentWeek;
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
 * Load data from published Google Sheet
 * Tries direct fetch first, falls back to CORS proxies if needed
 */
async function loadFromGoogleSheets() {
    const CORS_PROXIES = [
        '', // Try direct first
        'https://corsproxy.io/?',
        'https://api.allorigins.win/raw?url='
    ];

    console.log('Fetching from Google Sheets...');
    updateLoadingProgress(15, 'Connecting to data source...');

    for (let i = 0; i < CORS_PROXIES.length; i++) {
        const proxy = CORS_PROXIES[i];
        try {
            const url = proxy ? proxy + encodeURIComponent(GOOGLE_SHEETS_CSV_URL) : GOOGLE_SHEETS_CSV_URL;

            updateLoadingProgress(25, 'Fetching dashboard data...');

            // Add 10 second timeout to prevent hanging on slow proxies
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(url, { method: 'GET', signal: controller.signal });
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
            console.log('Loaded data from Google Sheets' + (proxy ? ' via proxy' : ' directly'));
            loadCSVData(csvText);

            // Also load weekly picks data from individual week tabs
            updateLoadingProgress(85, 'Loading weekly picks...');
            await loadAllWeeklyDataForBlazin();

            // Load schedule from ESPN for current week
            updateLoadingProgress(90, 'Loading game schedule...');
            await loadWeekSchedule(currentWeek);

            // Fetch current odds from The Odds API
            updateLoadingProgress(95, 'Loading betting odds...');
            await updateOddsFromAPI();

            // Mark initial load as complete before rendering
            initialLoadComplete = true;

            // Re-render games after schedule and odds are loaded
            renderGames();
            renderScoringSummary();

            // Now hide loading state after all data is loaded
            hideLoadingState();
            return;
        } catch (err) {
            console.warn(`Fetch attempt failed${proxy ? ' with ' + proxy : ' (direct)'}:`, err.message);
            // Update progress message on retry
            if (i < CORS_PROXIES.length - 1) {
                updateLoadingProgress(20, 'Retrying connection...');
            }
        }
    }

    // All attempts failed
    console.error('Failed to load data from Google Sheets after all attempts');
    showErrorState('Unable to load picks data. Please check your internet connection and try again.');
}

/**
 * Set active category and re-render
 */
function setActiveCategory(category) {
    currentCategory = category;

    // Update tabs
    tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.category === category);
    });

    // Show/hide sections based on category
    const makePicksSection = document.getElementById('make-picks-section');
    const performanceInsightsSection = document.getElementById('performance-insights-section');
    const recordsAnalysisSection = document.getElementById('records-analysis-section');

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
        makePicksSection?.classList.add('hidden');

        renderDashboard();
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
        default:
            return;
    }

    // PRIMARY: Render leaderboard
    renderLeaderboard(stats);

    // SECONDARY: Performance & Insights - render all panels
    renderStreaks(stats);
    renderTrendChart(weeklyData, currentSubcategory);
    renderInsights(dashboardData.loneWolf, dashboardData.universalAgreement);
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
        // Winner tab - hide both record tabs, show only P&L
        blazinRecordsTab?.classList.add('hidden');
        teamRecordsTab?.classList.add('hidden');
        // Activate P&L tab
        const pnlTab = document.querySelector('[data-panel="pnl-panel"]');
        if (pnlTab && !pnlTab.classList.contains('active')) {
            pnlTab.click();
        }
    }

    // Always render P&L
    renderPnL();
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
                <span class="insight-icon">🤝</span>
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
            icon: '📊',
            description: 'Combined against-the-spread picks'
        },
        'blazin': {
            key: 'blazin5',
            label: "Blazin' 5",
            icon: '🔥',
            description: 'Combined Blazin\' 5 picks performance'
        },
        'winner': {
            key: 'winnerPicks',
            label: 'Straight Up',
            icon: '🏆',
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
                    <span class="group-stat-icon">${cat.icon}</span>
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
 * Render the P&L section
 */
function renderPnL() {
    const grid = document.getElementById('pnl-grid');
    const betInput = document.getElementById('bet-amount');
    if (!grid || !betInput) return;

    const betAmount = parseFloat(betInput.value) || 20;
    const pnlData = calculateAllPickersPnL(betAmount);

    // Sort by total profit descending
    const sorted = PICKERS.map(name => ({ name, ...pnlData[name] }))
        .sort((a, b) => b.total - a.total);

    grid.innerHTML = sorted.map(picker => {
        const totalClass = picker.total > 0 ? 'positive' : picker.total < 0 ? 'negative' : 'neutral';
        const blazinRecord = `${picker.blazin.wins}-${picker.blazin.losses}${picker.blazin.pushes > 0 ? `-${picker.blazin.pushes}` : ''}`;
        const totalBets = picker.blazin.wins + picker.blazin.losses + picker.blazin.pushes;
        const totalWagered = totalBets * betAmount;

        return `
            <div class="pnl-card">
                <div class="pnl-picker-name">${picker.name}</div>
                <div class="pnl-total ${totalClass}">${formatCurrency(picker.total)}</div>
                <div class="pnl-details">
                    <span>${blazinRecord}</span>
                    <span>$${totalWagered.toLocaleString()} wagered</span>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Setup P&L section event listeners
 */
function setupPnLSection() {
    const betInput = document.getElementById('bet-amount');
    if (betInput) {
        betInput.addEventListener('change', renderPnL);
        betInput.addEventListener('input', debounce(renderPnL, 300));
    }
}

/**
 * Simple debounce function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
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

        // Merge blazin picks into allPicks
        if (weekData.picks) {
            if (!allPicks[week]) allPicks[week] = {};
            for (const picker in weekData.picks) {
                if (!allPicks[week][picker]) allPicks[week][picker] = {};
                for (const gameId in weekData.picks[picker]) {
                    const pick = weekData.picks[picker][gameId];
                    if (!allPicks[week][picker][gameId]) {
                        allPicks[week][picker][gameId] = {};
                    }
                    // Merge blazin marker
                    if (pick.blazin) {
                        allPicks[week][picker][gameId].blazin = true;
                        allPicks[week][picker][gameId].blazinTeam = pick.blazinTeam;
                    }
                    // Also merge line/winner if not present
                    if (pick.line && !allPicks[week][picker][gameId].line) {
                        allPicks[week][picker][gameId].line = pick.line;
                    }
                    if (pick.winner && !allPicks[week][picker][gameId].winner) {
                        allPicks[week][picker][gameId].winner = pick.winner;
                    }
                }
            }
        }

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

    // Save merged picks to localStorage so they persist
    if (loadedWeeks > 0) {
        savePicksToStorage();
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
                    </div>
                    ${picker.winnings !== undefined ? `
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
        <div class="picker-card ${rankClass}">
            <div class="picker-name">
                <span class="picker-color ${colorClass}"></span>
                ${picker.name}
            </div>
            <div class="win-pct ${pctClass}">${picker.percentage?.toFixed(2) || 0}%</div>
            <div class="record">${picker.wins}-${picker.losses}-${picker.pushes || picker.draws || 0}</div>
            <div class="picker-stats">
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
            </div>
            ${picker.bestTeam && picker.worstTeam ? `
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
        </div>
    `;
}

/**
 * Render leaderboard cards
 */
function renderLeaderboard(stats) {
    const sorted = getSortedPickers(stats);

    // Use podium layout for 6 pickers (Blazin' 5 with Cowherd)
    if (sorted.length === 6) {
        const podium = sorted.slice(0, 3);
        const runnersUp = sorted.slice(3);

        // Podium order: 2nd, 1st, 3rd (visual podium arrangement)
        const podiumOrder = [podium[1], podium[0], podium[2]];

        leaderboard.innerHTML = `
            <div class="podium-section">
                <div class="podium-row">
                    ${podiumOrder.map((picker, i) => {
                        const originalIndex = i === 1 ? 0 : (i === 0 ? 1 : 2);
                        return renderPickerCard(picker, originalIndex, false);
                    }).join('')}
                </div>
            </div>
            <div class="runners-up-section">
                <div class="runners-up-row">
                    ${runnersUp.map((picker, i) => renderPickerCard(picker, i + 3, true)).join('')}
                </div>
            </div>
        `;
        return;
    }

    // Standard grid layout for 5 pickers
    leaderboard.innerHTML = sorted.map((picker, index) => renderPickerCard(picker, index, false)).join('');
}

/**
 * Render streaks section
 */
function renderStreaks(stats) {
    const sorted = getSortedPickers(stats);

    streaksGrid.innerHTML = sorted.map(picker => {
        const last3 = picker.last3WeekPct || 0;
        let streakClass = 'neutral';
        if (last3 >= 55) streakClass = 'hot';
        else if (last3 < 45) streakClass = 'cold';

        return `
            <div class="streak-card">
                <div class="picker-name">
                    <span class="picker-color color-${picker.name.toLowerCase()}"></span>
                    ${picker.name}
                </div>
                <div class="streak-info">
                    <div>
                        <span class="streak-label">Last 3 Weeks</span>
                        <div class="streak-value ${streakClass}">${last3?.toFixed ? last3.toFixed(2) : last3}%</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Render the games list for picks
 */
function renderGames() {
    const gamesList = document.getElementById('games-list');
    if (!gamesList) return;

    let weekGames = getGamesForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};
    const pickerPicks = weekPicks[currentPicker] || {};
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
        gamesList.innerHTML = `
            <div class="no-games-message">
                <p>No games${filterMessage} for Week ${currentWeek}.</p>
                <p class="no-games-subtitle">${currentGameFilter !== 'all' ? 'Try changing the filter above.' : 'Game data can be added to NFL_GAMES_BY_WEEK in app.js'}</p>
            </div>
        `;
        return;
    }

    // Count current blazin picks for the week
    const blazinCount = weekGames.reduce((count, g) => {
        const gPicks = pickerPicks[String(g.id)] || pickerPicks[g.id] || {};
        return count + (gPicks.blazin ? 1 : 0);
    }, 0);

    gamesList.innerHTML = weekGames.map(game => {
        const gameIdStr = String(game.id);
        const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
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

                <div class="game-footer">
                    <div class="game-location">
                        <span class="location-city">${game.location}</span>
                        <span class="location-stadium">${game.stadium}</span>
                    </div>
                    <button class="blazin-star ${isBlazin ? 'active' : ''}"
                            data-game-id="${game.id}"
                            ${blazinDisabled ? 'disabled' : ''}
                            title="${blazinTitle}">
                        <span class="blazin-label">B5</span>${isBlazin ? '★' : '☆'}
                    </button>
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

    const btn = e.currentTarget;
    const gameId = btn.dataset.gameId; // Keep as string for consistent object keys
    const pickType = btn.dataset.pickType; // 'line' or 'winner'
    const team = btn.dataset.team; // 'away' or 'home'

    // Ensure week and picker structure exists
    if (!allPicks[currentWeek]) {
        allPicks[currentWeek] = {};
    }
    if (!allPicks[currentWeek][currentPicker]) {
        allPicks[currentWeek][currentPicker] = {};
    }

    // Initialize game picks object if needed
    if (!allPicks[currentWeek][currentPicker][gameId]) {
        allPicks[currentWeek][currentPicker][gameId] = {};
    }

    // Get current selection state
    const currentSelection = allPicks[currentWeek][currentPicker][gameId][pickType];
    const isDeselecting = currentSelection === team;
    const otherTeam = team === 'home' ? 'away' : 'home';
    let autoSelectWinner = false;

    // Toggle selection
    if (isDeselecting) {
        delete allPicks[currentWeek][currentPicker][gameId][pickType];
        // Clean up empty game object
        if (Object.keys(allPicks[currentWeek][currentPicker][gameId]).length === 0) {
            delete allPicks[currentWeek][currentPicker][gameId];
        }
    } else {
        allPicks[currentWeek][currentPicker][gameId][pickType] = team;

        // If picking a favorite on the line, automatically pick them to win
        if (pickType === 'line') {
            const weekGames = getGamesForWeek(currentWeek);
            const game = weekGames.find(g => String(g.id) === gameId);
            if (game && game.favorite === team) {
                // Picked the favorite to cover, auto-select them as winner
                allPicks[currentWeek][currentPicker][gameId].winner = team;
                autoSelectWinner = true;
            }
        }
    }

    // Save to localStorage
    savePicksToStorage();

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

/**
 * Handle Blazin' 5 star toggle
 */
function handleBlazinToggle(e) {
    e.preventDefault();
    e.stopPropagation();

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
        summaryHeader.textContent = `Week ${currentWeek} Scoring Summary`;
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
            blazinWins: 0, blazinLosses: 0, blazinPushes: 0
        };

        const pickerPicks = weekPicks[picker] || {};
        const cachedPicks = cachedWeek?.picks?.[picker] || {};

        weekGames.forEach(game => {
            const gameIdStr = String(game.id);
            const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
            const cachedGamePicks = cachedPicks[gameIdStr] || cachedPicks[game.id] || {};

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
                <th>Blazin' 5</th>
            </tr>
        </thead>
    `;

    let bodyHtml = '<tbody>';
    PICKERS.forEach(picker => {
        const s = stats[picker];
        const linePush = s.linePushes > 0 ? `-${s.linePushes}` : '';
        const blazinPush = s.blazinPushes > 0 ? `-${s.blazinPushes}` : '';
        const blazinTotal = s.blazinWins + s.blazinLosses + s.blazinPushes;

        bodyHtml += `
            <tr>
                <td class="picker-name-cell">
                    <span class="picker-color color-${picker.toLowerCase()}"></span>
                    ${picker}
                </td>
                <td class="stat-cell">${hasResults ? `${s.lineWins}-${s.lineLosses}${linePush}` : '-'}</td>
                <td class="stat-cell">${hasResults ? `${s.suWins}-${s.suLosses}` : '-'}</td>
                <td class="stat-cell">${hasResults && blazinTotal > 0 ? `${s.blazinWins}-${s.blazinLosses}${blazinPush}` : '-'}</td>
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
 * Show a toast notification
 */
function showToast(message) {
    // Remove existing toast if any
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
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
 * Save picks to localStorage
 */
function savePicksToStorage() {
    localStorage.setItem('nflPicks', JSON.stringify(allPicks));
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
                // Save migrated data (no toast for migration)
                savePicksToStorage(false);
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
        if (currentWeek < CURRENT_NFL_WEEK) {
            setCurrentWeek(currentWeek + 1);
        }
    });

    updateWeekNavButtons();
}

/**
 * Update week navigation button states
 */
function updateWeekNavButtons() {
    const prevBtn = document.getElementById('prev-week-btn');
    const nextBtn = document.getElementById('next-week-btn');

    if (prevBtn) prevBtn.disabled = currentWeek <= 1;
    if (nextBtn) nextBtn.disabled = currentWeek >= CURRENT_NFL_WEEK;
}

/**
 * Update week UI after navigation
 */
function updateWeekUI() {
    const weekDropdown = document.getElementById('week-dropdown');
    if (weekDropdown) weekDropdown.value = currentWeek;

    document.getElementById('picks-week-num').textContent = currentWeek;
    document.getElementById('scoring-week-num').textContent = currentWeek;

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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
