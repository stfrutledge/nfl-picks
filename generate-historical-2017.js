// Script to generate historical-2017.js from ESPN data and Google Sheets picks
// Run with: node generate-historical-2017.js

const https = require('https');
const http = require('http');

const SHEET_ID = '1dak52xz0I18E9lzG0wJSmhe4VaaXVFY80Ormi04YtyQ';
const PICKERS = ['Stephen', 'Sean', 'Dylan'];

// GIDs for each picker's weekly tabs
const PICKER_GIDS = {
    Stephen: {
        1: 0, 2: 284640373, 3: 13666648, 4: 1532842064,
        5: 1213104293, 6: 1845014448, 7: 1074555091, 8: 148219265,
        9: 1239013342, 10: 1018989538, 11: 1733013974, 12: 824457699,
        13: 1705798952, 14: 929034203, 15: 6292879, 16: 2122485338,
        17: 459864458
    },
    Sean: {
        1: 1226620602, 2: 718693311, 3: 1397694050, 4: 313898872,
        5: 1621955346, 6: 1699956247, 7: 438757237, 8: 197856158,
        9: 1833247295, 10: 379359905, 11: 2060702474, 12: 1777701070,
        13: 666412993, 14: 396124917, 15: 1391054734, 16: 1960707280,
        17: 117127322
    },
    Dylan: {
        1: 1953221743, 2: 1101596580, 3: 292954109, 4: 1353867912,
        5: 113736592, 6: 2085992655, 7: 1351639148, 8: 1652926626,
        9: 547095584, 10: 2117677729, 11: 57503664, 12: 1186999255,
        13: 1660045895, 14: 911536083, 15: 1268750562, 16: 358081555,
        17: 192772462
    }
};

// Team name normalization
const TEAM_NAME_MAP = {
    'ARI': 'Cardinals', 'Arizona': 'Cardinals', 'Arizona Cardinals': 'Cardinals',
    'ATL': 'Falcons', 'Atlanta': 'Falcons', 'Atlanta Falcons': 'Falcons',
    'BAL': 'Ravens', 'Baltimore': 'Ravens', 'Baltimore Ravens': 'Ravens',
    'BUF': 'Bills', 'Buffalo': 'Bills', 'Buffalo Bills': 'Bills',
    'CAR': 'Panthers', 'Carolina': 'Panthers', 'Carolina Panthers': 'Panthers',
    'CHI': 'Bears', 'Chicago': 'Bears', 'Chicago Bears': 'Bears',
    'CIN': 'Bengals', 'Cincinnati': 'Bengals', 'Cincinnati Bengals': 'Bengals',
    'CLE': 'Browns', 'Cleveland': 'Browns', 'Cleveland Browns': 'Browns',
    'DAL': 'Cowboys', 'Dallas': 'Cowboys', 'Dallas Cowboys': 'Cowboys',
    'DEN': 'Broncos', 'Denver': 'Broncos', 'Denver Broncos': 'Broncos',
    'DET': 'Lions', 'Detroit': 'Lions', 'Detroit Lions': 'Lions',
    'GB': 'Packers', 'Green Bay': 'Packers', 'Green Bay Packers': 'Packers',
    'HOU': 'Texans', 'Houston': 'Texans', 'Houston Texans': 'Texans',
    'IND': 'Colts', 'Indianapolis': 'Colts', 'Indianapolis Colts': 'Colts',
    'JAX': 'Jaguars', 'Jacksonville': 'Jaguars', 'Jacksonville Jaguars': 'Jaguars', 'Jags': 'Jaguars',
    'KC': 'Chiefs', 'Kansas City': 'Chiefs', 'Kansas City Chiefs': 'Chiefs',
    'LAC': 'Chargers', 'Los Angeles Chargers': 'Chargers', 'LA Chargers': 'Chargers', 'San Diego': 'Chargers',
    'LAR': 'Rams', 'Los Angeles Rams': 'Rams', 'LA Rams': 'Rams', 'Los Angeles': 'Rams',
    'LV': 'Raiders', 'Las Vegas': 'Raiders', 'Las Vegas Raiders': 'Raiders', 'Oakland': 'Raiders', 'OAK': 'Raiders', 'Oakland Raiders': 'Raiders',
    'MIA': 'Dolphins', 'Miami': 'Dolphins', 'Miami Dolphins': 'Dolphins',
    'MIN': 'Vikings', 'Minnesota': 'Vikings', 'Minnesota Vikings': 'Vikings',
    'NE': 'Patriots', 'New England': 'Patriots', 'New England Patriots': 'Patriots',
    'NO': 'Saints', 'New Orleans': 'Saints', 'New Orleans Saints': 'Saints',
    'NYG': 'Giants', 'New York Giants': 'Giants', 'NY Giants': 'Giants',
    'NYJ': 'Jets', 'New York Jets': 'Jets', 'NY Jets': 'Jets',
    'PHI': 'Eagles', 'Philadelphia': 'Eagles', 'Philadelphia Eagles': 'Eagles',
    'PIT': 'Steelers', 'Pittsburgh': 'Steelers', 'Pittsburgh Steelers': 'Steelers',
    'SEA': 'Seahawks', 'Seattle': 'Seahawks', 'Seattle Seahawks': 'Seahawks',
    'SF': '49ers', 'San Francisco': '49ers', 'San Francisco 49ers': '49ers',
    'TB': 'Buccaneers', 'Tampa Bay': 'Buccaneers', 'Tampa Bay Buccaneers': 'Buccaneers', 'Buccs': 'Buccaneers', 'Buccanee,rs': 'Buccaneers',
    'TEN': 'Titans', 'Tennessee': 'Titans', 'Tennessee Titans': 'Titans',
    'WAS': 'Commanders', 'Washington': 'Commanders', 'Washington Commanders': 'Commanders',
    'Washington Redskins': 'Commanders', 'Redskins': 'Commanders', 'Washington Football Team': 'Commanders'
};

function normalizeTeamName(name) {
    if (!name) return null;
    const cleaned = name.trim();
    return TEAM_NAME_MAP[cleaned] || cleaned;
}

function fetch(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (maxRedirects <= 0) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                let redirectUrl = res.headers.location;
                // Handle relative URLs
                if (redirectUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    redirectUrl = urlObj.origin + redirectUrl;
                }
                resolve(fetch(redirectUrl, maxRedirects - 1));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchESPNWeek(week) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=2017`;
    try {
        const data = await fetch(url);
        return JSON.parse(data);
    } catch (e) {
        console.error(`Error fetching ESPN week ${week}:`, e.message);
        return null;
    }
}

async function fetchSheetTab(gid) {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
    try {
        const data = await fetch(url);
        return data;
    } catch (e) {
        console.error(`Error fetching sheet GID ${gid}:`, e.message);
        return null;
    }
}

function parseCSV(csv) {
    if (!csv) return [];
    const lines = csv.split('\n');
    return lines.map(line => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    });
}

function parsePicksFromSheet(csv, games, sheetSpreads = {}) {
    const rows = parseCSV(csv);
    const picks = {};

    // Find header row and determine column indices
    // Format: Game, Line Pick, Winner Pick, Result, Line Outcome, Winner Outcome, Blazin' 5 / Bet, Blazin' 5 Result
    let headerRowIndex = -1;
    let gameCol = -1, linePickCol = -1, winnerPickCol = -1, blazinCol = -1;

    for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const row = rows[i].map(c => c.toLowerCase());

        // Look for columns
        for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell === 'game') gameCol = j;
            if (cell === 'line pick' || cell === 'linepick') linePickCol = j;
            if (cell === 'winner pick' || cell === 'winnerpick') winnerPickCol = j;
            // Look for "blazin' 5 / bet" column specifically, not "blazin' 5 result"
            if (cell.includes('blazin') && (cell.includes('bet') || cell.includes('5 /'))) blazinCol = j;
        }

        if (gameCol >= 0 && linePickCol >= 0) {
            headerRowIndex = i;
            break;
        }
    }

    if (headerRowIndex < 0) {
        console.log('  Could not find header row in sheet');
        return picks;
    }

    // Parse data rows
    for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) continue;

        const gameCell = row[gameCol];
        if (!gameCell || !gameCell.includes('@')) continue;

        // Parse game cell: "Packers (+3) @ Bears (-3)" or "Bengals @ Rams (-12.5)" or with "(London)" suffix
        // Format: Away Team (spread) @ Home Team (spread) - spread may be missing from one side
        // Strip location suffixes like "(London)", "(Mexico City)"
        let cleanGameCell = gameCell.replace(/\s*\((London|Mexico City|Mexico|UK)\)\s*$/i, '').trim();

        // Extract spread from the game cell - look for home team's spread like "Bears (-3)"
        let sheetSpread = 0;
        let sheetFavorite = 'home';
        const homeSpreadMatch = cleanGameCell.match(/@\s*[^(]+\s*\(([+-]?\d+\.?\d*)\)/);
        const awaySpreadMatch = cleanGameCell.match(/^[^@]+\s*\(([+-]?\d+\.?\d*)\)\s*@/);

        if (homeSpreadMatch) {
            const homeSpreadVal = parseFloat(homeSpreadMatch[1]);
            sheetSpread = Math.abs(homeSpreadVal);
            sheetFavorite = homeSpreadVal < 0 ? 'home' : 'away';
        } else if (awaySpreadMatch) {
            const awaySpreadVal = parseFloat(awaySpreadMatch[1]);
            sheetSpread = Math.abs(awaySpreadVal);
            sheetFavorite = awaySpreadVal < 0 ? 'away' : 'home';
        }

        let gameMatch = cleanGameCell.match(/^(.+?)\s*\([^)]+\)\s*@\s*(.+?)\s*\([^)]+\)$/);
        if (!gameMatch) {
            // Try without away spread: "Bengals @ Rams (-12.5)"
            gameMatch = cleanGameCell.match(/^(.+?)\s*@\s*(.+?)\s*\([^)]+\)$/);
        }
        if (!gameMatch) {
            // Try without home spread: "Packers (+3) @ Bears"
            gameMatch = cleanGameCell.match(/^(.+?)\s*\([^)]+\)\s*@\s*(.+?)$/);
        }
        if (!gameMatch) {
            // Try without any spreads: "Packers @ Bears"
            gameMatch = cleanGameCell.match(/^(.+?)\s*@\s*(.+?)$/);
        }
        if (!gameMatch) continue;

        const awayTeam = normalizeTeamName(gameMatch[1].trim());
        const homeTeam = normalizeTeamName(gameMatch[2].trim());

        // Store the spread info for later use
        const gameKey = `${awayTeam}@${homeTeam}`;
        if (sheetSpread > 0 && !sheetSpreads[gameKey]) {
            sheetSpreads[gameKey] = { spread: sheetSpread, favorite: sheetFavorite };
        }

        if (!awayTeam || !homeTeam) continue;

        // Find matching game
        const game = games.find(g => g.away === awayTeam && g.home === homeTeam);
        if (!game) {
            // Try reverse match (in case ESPN has different home/away)
            const reverseGame = games.find(g => g.away === homeTeam && g.home === awayTeam);
            if (reverseGame) {
                console.log(`  Note: Swapped home/away for ${awayTeam} @ ${homeTeam}`);
            } else {
                console.log(`  Could not match game: ${awayTeam} @ ${homeTeam}`);
            }
            continue;
        }

        // Parse line pick: "Bears (-3)" or "Packers (+3)"
        let linePick = null;
        let winnerPick = null;

        if (linePickCol >= 0 && row[linePickCol]) {
            const linePickCell = row[linePickCol];
            // Extract team name from "Bears (-3)"
            const pickMatch = linePickCell.match(/^(.+?)\s*\(/);
            if (pickMatch) {
                const pickTeam = normalizeTeamName(pickMatch[1].trim());
                if (pickTeam === awayTeam) {
                    linePick = 'away';
                } else if (pickTeam === homeTeam) {
                    linePick = 'home';
                }
            }
        }

        if (winnerPickCol >= 0 && row[winnerPickCol]) {
            const winnerTeam = normalizeTeamName(row[winnerPickCol]);
            if (winnerTeam === awayTeam) {
                winnerPick = 'away';
            } else if (winnerTeam === homeTeam) {
                winnerPick = 'home';
            }
        }

        // Check for blazin pick - marked with *
        let isBlazin = false;
        let blazinTeam = null;
        if (blazinCol >= 0 && row[blazinCol]) {
            const blazinValue = row[blazinCol].trim();
            if (blazinValue === '*' || blazinValue.toLowerCase() === 'x' || blazinValue.toLowerCase() === 'yes') {
                isBlazin = true;
                blazinTeam = linePick === 'away' ? awayTeam : homeTeam;
            }
        }

        if (!linePick && !winnerPick) continue;

        const pick = {
            line: linePick || winnerPick,
            winner: winnerPick || linePick
        };
        if (isBlazin) {
            pick.blazin = true;
            pick.blazinTeam = blazinTeam;
        }

        picks[game.id] = pick;
    }

    return picks;
}

async function main() {
    const output = {
        games: {},
        results: {},
        picks: {}
    };

    // Process weeks 1-17
    for (let week = 1; week <= 17; week++) {
        console.log(`Processing week ${week}...`);

        // Fetch ESPN data
        const espnData = await fetchESPNWeek(week);
        if (!espnData || !espnData.events) {
            console.log(`  No ESPN data for week ${week}`);
            continue;
        }

        const games = [];
        const results = {};
        let gameId = 1;

        for (const event of espnData.events) {
            const competition = event.competitions?.[0];
            if (!competition) continue;

            const homeTeamData = competition.competitors?.find(c => c.homeAway === 'home');
            const awayTeamData = competition.competitors?.find(c => c.homeAway === 'away');

            if (!homeTeamData || !awayTeamData) continue;

            const homeTeam = normalizeTeamName(homeTeamData.team?.displayName || homeTeamData.team?.name);
            const awayTeam = normalizeTeamName(awayTeamData.team?.displayName || awayTeamData.team?.name);

            // Get spread from odds if available
            let spread = 0;
            let favorite = 'home';
            const odds = competition.odds?.[0];
            if (odds?.details) {
                const match = odds.details.match(/([A-Z]+)\s*(-?\d+\.?\d*)/);
                if (match) {
                    spread = Math.abs(parseFloat(match[2]));
                    const favAbbr = match[1];
                    // Determine if home or away is favorite
                    if (homeTeamData.team?.abbreviation === favAbbr) {
                        favorite = 'home';
                    } else {
                        favorite = 'away';
                    }
                }
            }

            const game = {
                id: gameId,
                away: awayTeam,
                home: homeTeam,
                spread: spread,
                favorite: favorite
            };
            games.push(game);

            // Get results
            const homeScore = parseInt(homeTeamData.score) || 0;
            const awayScore = parseInt(awayTeamData.score) || 0;

            results[gameId] = {
                awayScore: awayScore,
                homeScore: homeScore,
                winner: homeScore > awayScore ? 'home' : 'away'
            };

            gameId++;
        }

        output.games[week] = games;
        output.results[week] = results;
        output.picks[week] = {};

        console.log(`  Week ${week}: ${games.length} games from ESPN`);

        // Collect spreads from sheets
        const sheetSpreads = {};

        // Fetch picks for each picker
        for (const picker of PICKERS) {
            const gid = PICKER_GIDS[picker][week];
            if (gid === undefined || gid === null) {
                console.log(`  No GID for ${picker} week ${week}`);
                continue;
            }

            const csv = await fetchSheetTab(gid);
            if (!csv) {
                console.log(`  Could not fetch sheet for ${picker} week ${week}`);
                continue;
            }

            const picks = parsePicksFromSheet(csv, games, sheetSpreads);
            output.picks[week][picker] = picks;
            console.log(`  ${picker}: ${Object.keys(picks).length} picks parsed`);
        }

        // Apply collected spreads to games
        games.forEach(game => {
            const gameKey = `${game.away}@${game.home}`;
            if (sheetSpreads[gameKey]) {
                game.spread = sheetSpreads[gameKey].spread;
                game.favorite = sheetSpreads[gameKey].favorite;
            }
        });
    }

    // Generate output file
    const fileContent = `// NFL Picks 2017 Season Historical Data
// Generated from Google Sheets data
// Pickers: ${PICKERS.join(', ')}

window.SEASON_2017_DATA = ${JSON.stringify(output, null, 2)};
`;

    require('fs').writeFileSync('historical-2017.js', fileContent);
    console.log('\nGenerated historical-2017.js');
}

main().catch(console.error);
