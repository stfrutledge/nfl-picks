/**
 * NFL Picks Dashboard - Main Application
 */

let dashboardData = null;
let currentCategory = 'blazin';
let currentPicker = 'Stephen';
let currentWeek = 15;
let allPicks = {}; // Store picks for all pickers: { week: { picker: { gameId: { line: 'away'|'home', winner: 'away'|'home' } } } }

// Available weeks (1-18 for regular season)
const TOTAL_WEEKS = 18;
const CURRENT_NFL_WEEK = 15;

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

// Helper to get team logo URL (handles aliases)
function getTeamLogo(teamName) {
    const normalized = TEAM_NAME_MAP[teamName] || teamName;
    return TEAM_LOGOS[normalized] || '';
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
    ]
    // Other weeks can be added here or loaded dynamically
};

/**
 * Check if a game is locked (kickoff time has passed)
 */
function isGameLocked(game) {
    if (!game.kickoff) return false;
    const kickoffTime = new Date(game.kickoff);
    const now = new Date();
    return now >= kickoffTime;
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
 * Start auto-refresh for live scores (every 30 seconds)
 */
function startLiveScoresRefresh() {
    // Clear any existing interval
    if (liveScoresRefreshInterval) {
        clearInterval(liveScoresRefreshInterval);
    }

    // Fetch immediately
    fetchLiveScores().then(() => {
        renderGames(); // Re-render games with new scores
    });

    // Then refresh every 30 seconds
    liveScoresRefreshInterval = setInterval(async () => {
        await fetchLiveScores();
        renderGames();
    }, 30000);
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

/**
 * Initialize the application
 */
function init() {
    setupTabs();
    setupWeekButtons();
    setupPickerButtons();
    setupPicksActions();
    loadPicksFromStorage();

    // Load data from Google Sheets
    loadFromGoogleSheets();
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

    // Show loading indicator
    const loadingIndicator = document.getElementById('week-loading');
    if (loadingIndicator) {
        loadingIndicator.classList.remove('hidden');
    }

    // Fetch week data if we have a GID for it and it's not cached
    if (WEEK_SHEET_GIDS[week] && !weeklyPicksCache[week]) {
        try {
            const url = `${GOOGLE_SHEETS_BASE_URL}&gid=${WEEK_SHEET_GIDS[week]}`;
            const response = await fetch(url);
            if (response.ok) {
                const csvText = await response.text();
                const weekData = parseWeeklyPicksCSV(csvText, week);
                weeklyPicksCache[week] = weekData;

                // Merge into allPicks
                if (weekData.picks) {
                    allPicks[week] = weekData.picks;
                }
                if (weekData.games) {
                    NFL_GAMES_BY_WEEK[week] = weekData.games;
                }
                if (weekData.results) {
                    NFL_RESULTS_BY_WEEK[week] = weekData.results;
                }
            }
        } catch (err) {
            console.error(`Failed to fetch week ${week} data:`, err);
        }
    }

    // Hide loading indicator
    if (loadingIndicator) {
        loadingIndicator.classList.add('hidden');
    }

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
}

/**
 * Setup picker selection buttons
 */
function setupPickerButtons() {
    const pickerButtons = document.querySelectorAll('.picker-btn');
    pickerButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            currentPicker = btn.dataset.picker;

            // Update active state
            pickerButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Re-render games with current picker's selections
            renderGames();
        });
    });
}

/**
 * Setup picks action buttons
 */
function setupPicksActions() {
    document.getElementById('clear-picks-btn')?.addEventListener('click', clearCurrentPickerPicks);
    document.getElementById('reset-all-picks-btn')?.addEventListener('click', resetAllPicks);
    document.getElementById('export-picks-btn')?.addEventListener('click', exportAllPicks);
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
        picksWeekNum.textContent = dashboardData.currentWeek + 1;
    }

    // Render initial view using setActiveCategory to ensure proper section visibility
    setActiveCategory(currentCategory);
}

// Google Sheets base URL and sheet IDs
// The main sheet (gid=0) has overall stats, each week has its own tab
const GOOGLE_SHEETS_BASE_URL = 'https://docs.google.com/spreadsheets/d/1JuftzmWWIlquN1oKrFqPNaGjMu9ysdnCHqCDj9lYzfE/export?format=csv';
const GOOGLE_SHEETS_CSV_URL = GOOGLE_SHEETS_BASE_URL + '&gid=0';

// Sheet GIDs for each week tab (you'll need to get these from the Google Sheet URL)
// When you click a tab, the URL shows gid=XXXXX
const WEEK_SHEET_GIDS = {
    // These need to be populated with actual GIDs from your Google Sheet
    // Example: 1: '123456789', 2: '987654321', etc.
};

// Cache for loaded week data
const weeklyPicksCache = {};

/**
 * Load data from published Google Sheet
 */
function loadFromGoogleSheets() {
    console.log('Fetching from Google Sheets...');
    fetch(GOOGLE_SHEETS_CSV_URL, {
        method: 'GET',
        redirect: 'follow'
    })
        .then(response => {
            if (!response.ok) throw new Error('Failed to fetch from Google Sheets');
            return response.text();
        })
        .then(csvText => {
            console.log('Loaded data from Google Sheets');
            loadCSVData(csvText);
        })
        .catch(err => {
            console.error('Failed to load data from Google Sheets:', err);
            dashboard.innerHTML = '<div class="error-message">Failed to load data. Please refresh the page to try again.</div>';
        });
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
    const chartsSection = document.querySelector('.charts-grid');
    const streaksSection = document.querySelector('.streaks-section');

    if (category === 'make-picks') {
        // Show picks section, hide others
        leaderboard.classList.add('hidden');
        chartsSection?.classList.add('hidden');
        streaksSection?.classList.add('hidden');
        makePicksSection?.classList.remove('hidden');

        // Start live scores refresh and render the picks interface
        startLiveScoresRefresh();
        renderScoringSummary();
    } else {
        // Stop live scores refresh when leaving picks tab
        stopLiveScoresRefresh();

        // Show dashboard sections, hide picks
        leaderboard.classList.remove('hidden');
        chartsSection?.classList.remove('hidden');
        streaksSection?.classList.remove('hidden');
        makePicksSection?.classList.add('hidden');

        renderDashboard();
    }
}

/**
 * Render the full dashboard
 */
function renderDashboard() {
    if (!dashboardData) return;

    let stats, weeklyData;

    switch (currentCategory) {
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

    renderLeaderboard(stats);
    renderStreaks(stats);
    renderTrendChart(weeklyData, currentCategory);

    // Only show Favorites vs Underdogs chart on Line Picks tab
    const standingsChartContainer = document.getElementById('standings-chart')?.closest('.chart-container');
    if (standingsChartContainer) {
        if (currentCategory === 'line') {
            standingsChartContainer.classList.remove('hidden');
            renderFavUnderdogChart(dashboardData.favoritesVsUnderdogs);
        } else {
            standingsChartContainer.classList.add('hidden');
        }
    }

    // Only show insights on Blazin' 5 tab
    const insightsSection = document.querySelector('.insights-section');
    if (insightsSection) {
        if (currentCategory === 'blazin') {
            insightsSection.classList.remove('hidden');
            renderInsights(dashboardData.loneWolf, dashboardData.universalAgreement);
        } else {
            insightsSection.classList.add('hidden');
        }
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

    // Render Lone Wolf card
    const loneWolfCard = document.getElementById('lone-wolf-card');
    if (loneWolfCard && loneWolf && Object.keys(loneWolf).length > 0) {
        // Sort by percentage
        const sorted = Object.entries(loneWolf)
            .map(([name, data]) => ({ name, ...data }))
            .sort((a, b) => (b.percentage || 0) - (a.percentage || 0));

        const rows = sorted.map((picker, idx) => `
            <div class="lone-wolf-row ${idx === 0 ? 'leader' : ''}">
                <span class="lone-wolf-rank">${idx + 1}</span>
                <span class="lone-wolf-name">${picker.name}</span>
                <span class="lone-wolf-pct ${picker.percentage >= 50 ? 'positive' : 'negative'}">${picker.percentage?.toFixed(1)}%</span>
                <span class="lone-wolf-record">${picker.wins}-${picker.losses}-${picker.pushes}</span>
            </div>
        `).join('');

        loneWolfCard.innerHTML = `
            <div class="insight-header lone-wolf-header">
                <img src="https://pbs.twimg.com/media/Crt1l8jWAAAmNyH.jpg" alt="Lone Wolf" class="lone-wolf-image">
                <div>
                    <span class="insight-title">Lone Wolf Picks</span>
                    <p class="insight-subtitle">Success rate when only one picker takes a line</p>
                </div>
            </div>
            <div class="lone-wolf-leaderboard">
                ${rows}
            </div>
        `;
    }
}

/**
 * Render leaderboard cards
 */
function renderLeaderboard(stats) {
    const sorted = getSortedPickers(stats);

    leaderboard.innerHTML = sorted.map((picker, index) => {
        const rankClass = index < 3 ? `rank-${index + 1}` : '';
        const colorClass = `color-${picker.name.toLowerCase()}`;
        const yearChangeClass = picker.yearChange?.includes('▲') ? 'up' : 'down';
        const pctClass = picker.percentage >= 50 ? 'positive' : 'negative';

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
                        <img src="${getTeamLogo(picker.bestTeam.team)}" alt="${picker.bestTeam.team}" class="team-badge-logo">
                        <span class="team-badge-name">${picker.bestTeam.team}</span>
                        <span class="team-badge-stats">${picker.bestTeam.record} (${picker.bestTeam.percentage?.toFixed(0)}%)</span>
                    </div>
                    <div class="team-record worst">
                        <img src="${getTeamLogo(picker.worstTeam.team)}" alt="${picker.worstTeam.team}" class="team-badge-logo">
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
    }).join('');
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

        const highest = picker.highestPct || 0;
        const lowest = picker.lowestPct || 0;

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
                    <div>
                        <span class="streak-label">Season High</span>
                        <div class="streak-value">${highest?.toFixed ? highest.toFixed(2) : highest}%</div>
                    </div>
                    <div>
                        <span class="streak-label">Season Low</span>
                        <div class="streak-value">${lowest?.toFixed ? lowest.toFixed(2) : lowest}%</div>
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

    const weekGames = getGamesForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};
    const pickerPicks = weekPicks[currentPicker] || {};

    if (weekGames.length === 0) {
        gamesList.innerHTML = `
            <div class="no-games-message">
                <p>No games data available for Week ${currentWeek}.</p>
                <p class="no-games-subtitle">Game data can be added to NFL_GAMES_BY_WEEK in app.js</p>
            </div>
        `;
        return;
    }

    gamesList.innerHTML = weekGames.map(game => {
        const gameIdStr = String(game.id);
        const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
        const linePick = gamePicks.line;
        const winnerPick = gamePicks.winner;
        const hasLinePick = linePick !== undefined;
        const hasWinnerPick = winnerPick !== undefined;
        const hasBothPicks = hasLinePick && hasWinnerPick;
        const locked = isGameLocked(game);

        // Get live score data if available
        const liveData = getLiveGameStatus(game);
        const isInProgress = liveData && liveData.status === 'STATUS_IN_PROGRESS';
        const isFinal = liveData && (liveData.status === 'STATUS_FINAL' || liveData.completed);

        const awaySpread = game.favorite === 'away' ? -game.spread : game.spread;
        const homeSpread = game.favorite === 'home' ? -game.spread : game.spread;

        const awaySpreadDisplay = awaySpread > 0 ? `+${awaySpread}` : awaySpread;
        const homeSpreadDisplay = homeSpread > 0 ? `+${homeSpread}` : homeSpread;

        const cardClasses = [
            'game-card',
            hasBothPicks ? 'has-pick' : (hasLinePick || hasWinnerPick ? 'has-partial-pick' : ''),
            locked ? 'game-locked' : '',
            isFinal ? 'game-final' : '',
            isInProgress ? 'game-in-progress' : ''
        ].filter(Boolean).join(' ');

        // Build status badge
        let statusBadge = '';
        if (isFinal) {
            statusBadge = `<span class="status-badge final">FINAL</span>`;
        } else if (isInProgress) {
            const clockDisplay = liveData.clock ? `${liveData.clock} Q${liveData.period}` : 'Live';
            statusBadge = `<span class="status-badge in-progress">${liveData.awayScore} - ${liveData.homeScore} (${clockDisplay})</span>`;
        } else if (locked) {
            statusBadge = '<span class="locked-badge">LOCKED</span>';
        }

        return `
            <div class="${cardClasses}" data-game-id="${game.id}">
                <div class="game-header">
                    <span class="game-time">${game.time}</span>
                    ${statusBadge}
                    <span class="game-day">${game.day}</span>
                </div>

                <div class="game-matchup-line">
                    <span class="away-team">
                        <img src="${TEAM_LOGOS[game.away]}" alt="${game.away}" class="team-logo">
                        ${game.away} ${isFinal || isInProgress ? `<strong>${liveData?.awayScore || ''}</strong>` : `(${awaySpreadDisplay})`}
                    </span>
                    <span class="at-symbol">@</span>
                    <span class="home-team">
                        <img src="${TEAM_LOGOS[game.home]}" alt="${game.home}" class="team-logo">
                        ${game.home} ${isFinal || isInProgress ? `<strong>${liveData?.homeScore || ''}</strong>` : `(${homeSpreadDisplay})`}
                    </span>
                </div>

                <div class="picks-row">
                    <div class="pick-type">
                        <span class="pick-label">Line Pick (ATS)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${linePick === 'away' ? 'selected' : ''}"
                                    data-game-id="${game.id}" data-pick-type="line" data-team="away"
                                    ${locked ? 'disabled' : ''}>
                                ${game.away} ${awaySpreadDisplay}
                            </button>
                            <button class="pick-btn ${linePick === 'home' ? 'selected' : ''}"
                                    data-game-id="${game.id}" data-pick-type="line" data-team="home"
                                    ${locked ? 'disabled' : ''}>
                                ${game.home} ${homeSpreadDisplay}
                            </button>
                        </div>
                    </div>
                    <div class="pick-type">
                        <span class="pick-label">Straight Up (Winner)</span>
                        <div class="pick-options">
                            <button class="pick-btn ${winnerPick === 'away' ? 'selected' : ''}"
                                    data-game-id="${game.id}" data-pick-type="winner" data-team="away"
                                    ${locked ? 'disabled' : ''}>
                                ${game.away}
                            </button>
                            <button class="pick-btn ${winnerPick === 'home' ? 'selected' : ''}"
                                    data-game-id="${game.id}" data-pick-type="winner" data-team="home"
                                    ${locked ? 'disabled' : ''}>
                                ${game.home}
                            </button>
                        </div>
                    </div>
                </div>

                <div class="game-location">
                    <span class="location-city">${game.location}</span>
                    <span class="location-stadium">${game.stadium}</span>
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers for pick buttons
    document.querySelectorAll('.pick-btn').forEach(btn => {
        btn.addEventListener('click', handlePickSelect);
    });
}

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

    // Toggle selection
    if (allPicks[currentWeek][currentPicker][gameId][pickType] === team) {
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
            }
        }
    }

    // Save to localStorage
    savePicksToStorage();

    // Re-render
    renderGames();
    renderScoringSummary();
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
 * Render scoring summary table
 */
function renderScoringSummary() {
    const scoringTable = document.getElementById('scoring-table');
    if (!scoringTable) return;

    const weekGames = getGamesForWeek(currentWeek);
    const weekResults = getResultsForWeek(currentWeek);
    const weekPicks = allPicks[currentWeek] || {};

    // Update the summary header
    const summaryHeader = document.querySelector('.scoring-summary h3');
    if (summaryHeader) {
        summaryHeader.textContent = `Week ${currentWeek} Scoring Summary`;
    }

    if (weekGames.length === 0) {
        scoringTable.innerHTML = '<tbody><tr><td colspan="7" class="no-games-message">No games data available for this week.</td></tr></tbody>';
        return;
    }

    // Build header row
    let headerHtml = `
        <thead>
            <tr>
                <th class="game-col">Game</th>
                <th class="result-col">Result</th>
                ${PICKERS.map(picker => `<th class="picker-col">${picker}</th>`).join('')}
            </tr>
        </thead>
    `;

    // Track totals for each picker
    const totals = {};
    PICKERS.forEach(picker => {
        totals[picker] = { lineWins: 0, lineLosses: 0, winnerWins: 0, winnerLosses: 0 };
    });

    // Build body rows
    let bodyHtml = '<tbody>';

    weekGames.forEach(game => {
        const gameIdStr = String(game.id);
        const result = weekResults[game.id];
        const atsWinner = result ? calculateATSWinner(game, result) : null;

        // Format result display
        let resultDisplay = '<span class="pending">Pending</span>';
        if (result) {
            resultDisplay = `
                <div class="result-score">
                    <span>${game.away} ${result.awayScore}</span>
                    <span>${game.home} ${result.homeScore}</span>
                </div>
            `;
        }

        // Build picker columns
        const pickerCells = PICKERS.map(picker => {
            const pickerPicks = weekPicks[picker] || {};
            const gamePicks = pickerPicks[gameIdStr] || pickerPicks[game.id] || {};
            const linePick = gamePicks.line;
            const winnerPick = gamePicks.winner;

            if (!linePick && !winnerPick) {
                return '<td class="picker-cell no-pick">-</td>';
            }

            let lineResult = '';
            let winnerResult = '';

            if (result) {
                // Check line pick
                if (linePick) {
                    if (atsWinner === 'push') {
                        lineResult = 'push';
                    } else if (linePick === atsWinner) {
                        lineResult = 'win';
                        totals[picker].lineWins++;
                    } else {
                        lineResult = 'loss';
                        totals[picker].lineLosses++;
                    }
                }

                // Check winner pick
                if (winnerPick) {
                    if (winnerPick === result.winner) {
                        winnerResult = 'win';
                        totals[picker].winnerWins++;
                    } else {
                        winnerResult = 'loss';
                        totals[picker].winnerLosses++;
                    }
                }
            }

            const lineTeam = linePick === 'away' ? game.away : linePick === 'home' ? game.home : '-';
            const winnerTeam = winnerPick === 'away' ? game.away : winnerPick === 'home' ? game.home : '-';

            return `
                <td class="picker-cell">
                    <div class="pick-result ${lineResult}">
                        <span class="pick-type-label">ATS:</span> ${lineTeam}
                        ${lineResult ? `<span class="result-icon ${lineResult}">${lineResult === 'win' ? '✓' : lineResult === 'loss' ? '✗' : '—'}</span>` : ''}
                    </div>
                    <div class="pick-result ${winnerResult}">
                        <span class="pick-type-label">SU:</span> ${winnerTeam}
                        ${winnerResult ? `<span class="result-icon ${winnerResult}">${winnerResult === 'win' ? '✓' : '✗'}</span>` : ''}
                    </div>
                </td>
            `;
        }).join('');

        bodyHtml += `
            <tr>
                <td class="game-col">
                    <img src="${TEAM_LOGOS[game.away]}" alt="${game.away}" class="table-team-logo">
                    ${game.away} @
                    <img src="${TEAM_LOGOS[game.home]}" alt="${game.home}" class="table-team-logo">
                    ${game.home}
                </td>
                <td class="result-col">${resultDisplay}</td>
                ${pickerCells}
            </tr>
        `;
    });

    bodyHtml += '</tbody>';

    // Build totals row
    const hasResults = Object.keys(weekResults).length > 0;
    let footerHtml = '';
    if (hasResults) {
        footerHtml = `
            <tfoot>
                <tr class="totals-row">
                    <td class="game-col"><strong>Totals</strong></td>
                    <td class="result-col"></td>
                    ${PICKERS.map(picker => `
                        <td class="picker-col totals-cell">
                            <div>ATS: ${totals[picker].lineWins}-${totals[picker].lineLosses}</div>
                            <div>SU: ${totals[picker].winnerWins}-${totals[picker].winnerLosses}</div>
                        </td>
                    `).join('')}
                </tr>
            </tfoot>
        `;
    }

    scoringTable.innerHTML = headerHtml + bodyHtml + footerHtml;
}

/**
 * Clear current picker's picks for the current week
 */
function clearCurrentPickerPicks() {
    if (confirm(`Clear all Week ${currentWeek} picks for ${currentPicker}?`)) {
        if (allPicks[currentWeek]) {
            allPicks[currentWeek][currentPicker] = {};
        }
        savePicksToStorage();
        renderGames();
        renderScoringSummary();
    }
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
                // Save migrated data
                savePicksToStorage();
            }
        } catch (e) {
            console.error('Failed to load picks from storage, clearing...', e);
            localStorage.removeItem('nflPicks');
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
