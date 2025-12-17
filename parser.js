/**
 * NFL Picks CSV Parser
 * Extracts data from the Google Sheets CSV export
 */

const PICKERS = ['Stephen', 'Sean', 'Dylan', 'Jason', 'Daniel'];
const PICKERS_WITH_COWHERD = ['Stephen', 'Sean', 'Dylan', 'Jason', 'Daniel', 'Cowherd'];

const PICKER_COLORS = {
    'Stephen': '#3b82f6',
    'Sean': '#22c55e',
    'Dylan': '#a855f7',
    'Jason': '#f97316',
    'Daniel': '#06b6d4',
    'Cowherd': '#eab308'
};

/**
 * Parse the full CSV and extract all relevant data
 */
function parseNFLPicksCSV(csvText) {
    const result = Papa.parse(csvText, {
        skipEmptyLines: false
    });

    const rows = result.data;

    // Extract base stats
    const blazin5 = extractBlazin5Overall(rows);

    // Extract and merge gambling winnings into blazin5 stats
    const winnings = extractGamblingWinnings(rows);
    Object.keys(winnings).forEach(name => {
        if (blazin5[name]) {
            blazin5[name].winnings = winnings[name].winnings;
            blazin5[name].winningsRaw = winnings[name].winningsRaw;
        }
    });

    // Extract best/worst team data and merge into linePicks
    const teamRecords = extractBestWorstTeams(rows);
    const linePicks = extractLinePicksOverall(rows);
    Object.keys(teamRecords).forEach(name => {
        if (linePicks[name]) {
            linePicks[name].bestTeam = teamRecords[name].best;
            linePicks[name].worstTeam = teamRecords[name].worst;
        }
    });

    return {
        linePicks: linePicks,
        blazin5: blazin5,
        winnerPicks: extractWinnerPicksOverall(rows),
        weeklyLinePicks: extractWeeklyPercentages(rows, 'line'),
        weeklyBlazin5: extractWeeklyPercentages(rows, 'blazin5'),
        weeklyWinnerPicks: extractWeeklyPercentages(rows, 'winner'),
        favoritesVsUnderdogs: extractFavoritesVsUnderdogs(rows),
        loneWolf: extractLoneWolfPicks(rows),
        universalAgreement: extractUniversalAgreement(rows),
        groupOverall: extractGroupOverall(rows),
        currentWeek: detectCurrentWeek(rows)
    };
}

/**
 * Extract Group Overall stats (combined performance across all pickers)
 * Located in the "Group Overall" section of the CSV
 */
function extractGroupOverall(rows) {
    const data = {
        blazin5: { wins: 0, losses: 0, pushes: 0, percentage: null },
        linePicks: { wins: 0, losses: 0, pushes: 0, percentage: null },
        winnerPicks: { wins: 0, losses: 0, pushes: 0, percentage: null },
        weeklyData: []
    };

    // Find "Group Overall" section
    let startRow = -1;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].toString().includes('Group Overall')) {
            startRow = i;
            break;
        }
    }

    if (startRow === -1) return data;

    // The structure after "Group Overall" header:
    // Row +1: "Blazin' 5", "", "", "Line Picks", "", "", "Winner Picks"
    // Row +2: "Week", "Win", "Loss", "Push", "Win", "Loss", "Push", "Win", "Loss", "Push"
    // Rows +3 to +17: Weekly data (weeks 1-15)
    // Row after weekly: "Total", totals...
    // Row after Total: percentages

    // Find the Total row
    for (let i = startRow; i < Math.min(startRow + 25, rows.length); i++) {
        const row = rows[i];
        if (!row) continue;

        const firstCell = (row[0] || '').toString().trim();

        if (firstCell === 'Total') {
            // Parse totals: Blazin'5 (cols 1-3), Line Picks (cols 4-6), Winner (cols 7-9)
            data.blazin5.wins = parseInt(row[1]) || 0;
            data.blazin5.losses = parseInt(row[2]) || 0;
            data.blazin5.pushes = parseInt(row[3]) || 0;

            data.linePicks.wins = parseInt(row[4]) || 0;
            data.linePicks.losses = parseInt(row[5]) || 0;
            data.linePicks.pushes = parseInt(row[6]) || 0;

            data.winnerPicks.wins = parseInt(row[7]) || 0;
            data.winnerPicks.losses = parseInt(row[8]) || 0;
            data.winnerPicks.pushes = parseInt(row[9]) || 0;

            // Next row has percentages
            const pctRow = rows[i + 1];
            if (pctRow) {
                data.blazin5.percentage = parsePercentage(pctRow[0]) || parsePercentage(pctRow[1]);
                data.linePicks.percentage = parsePercentage(pctRow[3]) || parsePercentage(pctRow[4]);
                data.winnerPicks.percentage = parsePercentage(pctRow[6]) || parsePercentage(pctRow[7]);
            }

            break;
        }

        // Also collect weekly data
        const weekNum = parseInt(firstCell);
        if (weekNum >= 1 && weekNum <= 18) {
            data.weeklyData.push({
                week: weekNum,
                blazin5: { wins: parseInt(row[1]) || 0, losses: parseInt(row[2]) || 0, pushes: parseInt(row[3]) || 0 },
                linePicks: { wins: parseInt(row[4]) || 0, losses: parseInt(row[5]) || 0, pushes: parseInt(row[6]) || 0 },
                winnerPicks: { wins: parseInt(row[7]) || 0, losses: parseInt(row[8]) || 0, pushes: parseInt(row[9]) || 0 }
            });
        }
    }

    // Calculate percentages if not found
    if (data.blazin5.percentage === null) {
        const total = data.blazin5.wins + data.blazin5.losses;
        data.blazin5.percentage = total > 0 ? (data.blazin5.wins / total * 100) : 0;
    }
    if (data.linePicks.percentage === null) {
        const total = data.linePicks.wins + data.linePicks.losses;
        data.linePicks.percentage = total > 0 ? (data.linePicks.wins / total * 100) : 0;
    }
    if (data.winnerPicks.percentage === null) {
        const total = data.winnerPicks.wins + data.winnerPicks.losses;
        data.winnerPicks.percentage = total > 0 ? (data.winnerPicks.wins / total * 100) : 0;
    }

    return data;
}

/**
 * Extract Lone Wolf Picks data (when only one picker chose a line)
 */
function extractLoneWolfPicks(rows) {
    const data = {};

    // Find "Lone Wolf Picks" section
    let startRow = -1;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].toString().includes('Lone Wolf Picks')) {
            startRow = i + 2; // Skip header row
            break;
        }
    }

    if (startRow === -1) return data;

    for (let i = startRow; i < startRow + 5 && i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS.includes(name)) {
            data[name] = {
                wins: parseInt(row[1]) || 0,
                losses: parseInt(row[2]) || 0,
                pushes: parseInt(row[3]) || 0,
                percentage: parsePercentage(row[4]),
                totalPicks: parseInt(row[5]) || 0
            };
        }
    }

    return data;
}

/**
 * Extract Universal Agreement data (when all pickers chose the same line)
 */
function extractUniversalAgreement(rows) {
    // Find "Universal Agreement" section
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].toString().includes('Universal Agreement')) {
            // Data is 2 rows down
            const dataRow = rows[i + 2];
            if (dataRow && dataRow[0] === 'Group') {
                return {
                    wins: parseInt(dataRow[1]) || 0,
                    losses: parseInt(dataRow[2]) || 0,
                    pushes: parseInt(dataRow[3]) || 0,
                    percentage: parsePercentage(dataRow[4]),
                    totalPicks: parseInt(dataRow[5]) || 0
                };
            }
        }
    }

    return null;
}

/**
 * Extract Best/Worst Team records for each picker
 */
function extractBestWorstTeams(rows) {
    const data = {};

    // Find "Record by Team (Line Picks)" section
    let startRow = -1;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].toString().includes('Record by Team')) {
            startRow = i + 3; // Skip header rows to get to data
            break;
        }
    }

    if (startRow === -1) return data;

    // Parse each picker's best/worst team (rows after headers)
    for (let i = startRow; i < startRow + 5 && i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS.includes(name)) {
            data[name] = {
                best: {
                    team: (row[1] || '').trim(),
                    percentage: parsePercentage(row[2]),
                    record: (row[3] || '').trim()
                },
                worst: {
                    team: (row[4] || '').trim(),
                    percentage: parsePercentage(row[5]),
                    record: (row[6] || '').trim()
                }
            };
        }
    }

    return data;
}

/**
 * Extract Favorites vs Underdogs performance data
 */
function extractFavoritesVsUnderdogs(rows) {
    const data = {
        favorites: {},
        underdogs: {}
    };

    // Find "When Picking Favorites" section
    let favStartRow = -1;
    let undStartRow = -1;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;
        const cell = row[0].toString().trim();

        if (cell === 'When Picking Favorites') {
            favStartRow = i + 2; // Skip header row
        }
        if (cell === 'When Picking Underdogs') {
            undStartRow = i + 2; // Skip header row
        }
    }

    // Parse favorites data
    if (favStartRow !== -1) {
        for (let i = favStartRow; i < favStartRow + 5 && i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;
            const name = row[0].trim();
            if (PICKERS.includes(name)) {
                data.favorites[name] = {
                    wins: parseInt(row[1]) || 0,
                    losses: parseInt(row[2]) || 0,
                    pushes: parseInt(row[3]) || 0,
                    percentage: parsePercentage(row[4]),
                    totalPicks: parseInt(row[5]) || 0
                };
            }
        }
    }

    // Parse underdogs data
    if (undStartRow !== -1) {
        for (let i = undStartRow; i < undStartRow + 5 && i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;
            const name = row[0].trim();
            if (PICKERS.includes(name)) {
                data.underdogs[name] = {
                    wins: parseInt(row[1]) || 0,
                    losses: parseInt(row[2]) || 0,
                    pushes: parseInt(row[3]) || 0,
                    percentage: parsePercentage(row[4]),
                    totalPicks: parseInt(row[5]) || 0
                };
            }
        }
    }

    return data;
}

/**
 * Extract Gambling Winnings from "Potential Blazin' 5 Gambling Winnings" section
 * Located around rows 119-125 (0-indexed: 118-124)
 */
function extractGamblingWinnings(rows) {
    const winnings = {};

    // Find the "Potential Blazin' 5 Gambling Winnings" section
    let startRow = -1;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0] && row[0].toString().includes('Potential Blazin')) {
            startRow = i + 2; // Skip header row to get to data
            break;
        }
    }

    if (startRow === -1) return winnings;

    // Parse winnings for each picker (rows after the header)
    for (let i = startRow; i < startRow + 6 && i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS_WITH_COWHERD.includes(name)) {
            // Winnings is in column 4 (e.g., "$26.00" or "-$70.00")
            const winningsStr = (row[4] || '').toString().trim();
            const winningsNum = parseFloat(winningsStr.replace(/[$,]/g, ''));

            winnings[name] = {
                winnings: winningsStr,
                winningsRaw: isNaN(winningsNum) ? 0 : winningsNum
            };
        }
    }

    return winnings;
}

/**
 * Extract Line Picks Overall stats (rows 5-9 in spreadsheet, 0-indexed: 4-8)
 */
function extractLinePicksOverall(rows) {
    const stats = {};

    // Line Picks Overall is in rows 5-9 (index 4-8)
    for (let i = 4; i <= 8; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS.includes(name)) {
            stats[name] = {
                name: name,
                wins: parseInt(row[1]) || 0,
                losses: parseInt(row[2]) || 0,
                pushes: parseInt(row[3]) || 0,
                percentage: parsePercentage(row[4]),
                totalPicks: parseInt(row[5]) || 0,
                last3WeekPct: parsePercentage(row[6]),
                bestWeek: row[7] || '',
                highestPct: parsePercentage(row[8]),
                lowestPct: parsePercentage(row[9]),
                yearChange: row[10] || ''
            };
        }
    }

    return stats;
}

/**
 * Extract Blazin' 5 Overall stats (rows 13-18 in spreadsheet, 0-indexed: 12-17)
 */
function extractBlazin5Overall(rows) {
    const stats = {};

    // Blazin' 5 is in rows 13-18 (index 12-17)
    for (let i = 12; i <= 17; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS_WITH_COWHERD.includes(name)) {
            stats[name] = {
                name: name,
                wins: parseInt(row[1]) || 0,
                losses: parseInt(row[2]) || 0,
                pushes: parseInt(row[3]) || 0,
                percentage: parsePercentage(row[4]),
                totalPicks: parseInt(row[5]) || 0,
                last3WeekPct: parsePercentage(row[6]),
                bestWeek: row[7] || '',
                highestPct: parsePercentage(row[8]),
                lowestPct: parsePercentage(row[9]),
                yearChange: row[10] || ''
            };
        }
    }

    return stats;
}

/**
 * Extract Winner Picks Overall stats (rows 22-26 in spreadsheet, 0-indexed: 21-25)
 */
function extractWinnerPicksOverall(rows) {
    const stats = {};

    // Winner Picks is in rows 22-26 (index 21-25)
    for (let i = 21; i <= 25; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;

        const name = row[0].trim();
        if (PICKERS.includes(name)) {
            stats[name] = {
                name: name,
                wins: parseInt(row[1]) || 0,
                losses: parseInt(row[2]) || 0,
                draws: parseInt(row[3]) || 0,
                percentage: parsePercentage(row[4]),
                totalPicks: parseInt(row[5]) || 0,
                last3WeekPct: parsePercentage(row[6]),
                bestWeek: row[7] || '',
                highestPct: parsePercentage(row[8]),
                lowestPct: parsePercentage(row[9]),
                yearChange: row[10] || ''
            };
        }
    }

    return stats;
}

/**
 * Extract weekly percentages for trend charts
 * The weekly % data is in the right side of the CSV
 */
function extractWeeklyPercentages(rows, type) {
    const weeklyData = {};

    // Initialize for all pickers
    const pickers = type === 'blazin5' ? PICKERS_WITH_COWHERD : PICKERS;
    pickers.forEach(p => weeklyData[p] = []);

    // Find the "% Per Week" section columns
    // For Line Picks: "% Per Week (Line Picks)" around column BK onwards
    // For Blazin' 5: "% Per Week (Blazin' 5)" around column AU onwards
    // For Winner: "% Per Week (Winner Picks)"

    // Looking at the header row (row 4, index 3) to find column positions
    const headerRow = rows[3];
    if (!headerRow) return weeklyData;

    let startCol = -1;
    let weekCol = -1;

    // Search for the appropriate section
    for (let col = 0; col < headerRow.length; col++) {
        const cell = (headerRow[col] || '').toString();

        if (type === 'line' && cell.includes('% Per Week (Line Picks)')) {
            startCol = col;
        } else if (type === 'blazin5' && cell.includes('% Per Week (Blazin\' 5)')) {
            startCol = col;
        } else if (type === 'winner' && cell.includes('% Per Week (Winner Picks)')) {
            startCol = col;
        }
    }

    if (startCol === -1) {
        // Fallback: try to find by looking at row structure
        // The weekly % for Line Picks starts around column 62 (index)
        // based on the CSV structure
        if (type === 'line') startCol = 62;
        else if (type === 'blazin5') startCol = 46;
        else if (type === 'winner') startCol = 62; // Actually in different location
    }

    // Extract weekly data from rows 5-9 (or 5-10 for blazin5 with Cowherd)
    // The structure shows Week number, then each picker's %

    // For the % Per Week sections, let's parse the data rows directly
    // Row 5 (index 4) onwards contains the weekly data

    // Actually, looking at the CSV more carefully:
    // The weekly % columns are: Week, Stephen, Sean, Dylan, Jason, Daniel, [Cowherd], Range

    if (type === 'line') {
        // % Per Week (Line Picks) section
        // Find the correct column by searching for header
        let weekCol = -1;
        const headerRow3 = rows[2]; // Row 3 (0-indexed: 2)

        if (headerRow3) {
            for (let col = 0; col < headerRow3.length; col++) {
                const cell = (headerRow3[col] || '').toString();
                if (cell.includes('% Per Week (Line Picks)')) {
                    weekCol = col;
                    break;
                }
            }
        }

        // Fallback if not found
        if (weekCol === -1) weekCol = 54;

        for (let rowIdx = 4; rowIdx <= 21; rowIdx++) {
            const row = rows[rowIdx];
            if (!row) continue;

            const weekNum = parseInt(row[weekCol]);

            if (weekNum >= 1 && weekNum <= 18) {
                // Columns after week: Stephen, Sean, Dylan, Jason, Daniel
                const colOffset = weekCol + 1;
                PICKERS.forEach((picker, idx) => {
                    const pct = parsePercentage(row[colOffset + idx]);
                    if (pct !== null && !isNaN(pct)) {
                        weeklyData[picker].push({ week: weekNum, pct: pct });
                    }
                });
            }
        }
    } else if (type === 'blazin5') {
        // % Per Week (Blazin' 5) section
        // First, find the correct column by searching for "% Per Week (Blazin' 5)" header
        let weekCol = -1;
        const headerRow3 = rows[2]; // Row 3 (0-indexed: 2)

        if (headerRow3) {
            for (let col = 0; col < headerRow3.length; col++) {
                const cell = (headerRow3[col] || '').toString();
                if (cell.includes('% Per Week (Blazin') || cell.includes('Per Week (Blazin')) {
                    weekCol = col;
                    break;
                }
            }
        }

        // Fallback if not found
        if (weekCol === -1) weekCol = 46;

        for (let rowIdx = 4; rowIdx <= 21; rowIdx++) {
            const row = rows[rowIdx];
            if (!row) continue;

            const weekNum = parseInt(row[weekCol]);

            if (weekNum >= 1 && weekNum <= 18) {
                // Columns after week: Stephen, Sean, Dylan, Jason, Daniel, Cowherd
                const colOffset = weekCol + 1;
                PICKERS_WITH_COWHERD.forEach((picker, idx) => {
                    const pct = parsePercentage(row[colOffset + idx]);
                    if (pct !== null && !isNaN(pct)) {
                        weeklyData[picker].push({ week: weekNum, pct: pct });
                    }
                });
            }
        }
    } else if (type === 'winner') {
        // % Per Week (Winner Picks) - find the header in the lower section
        let weekCol = -1;
        const headerRow24 = rows[23]; // Row 24 (0-indexed: 23)

        if (headerRow24) {
            for (let col = 0; col < headerRow24.length; col++) {
                const cell = (headerRow24[col] || '').toString();
                if (cell.includes('% Per Week (Winner Picks)')) {
                    weekCol = col;
                    break;
                }
            }
        }

        // Fallback if not found
        if (weekCol === -1) weekCol = 54;

        for (let rowIdx = 25; rowIdx <= 45; rowIdx++) {
            const row = rows[rowIdx];
            if (!row) continue;

            const weekNum = parseInt(row[weekCol]);

            if (weekNum >= 1 && weekNum <= 18) {
                const colOffset = weekCol + 1;
                PICKERS.forEach((picker, idx) => {
                    const pct = parsePercentage(row[colOffset + idx]);
                    if (pct !== null && !isNaN(pct)) {
                        weeklyData[picker].push({ week: weekNum, pct: pct });
                    }
                });
            }
        }
    }

    // Sort by week
    Object.keys(weeklyData).forEach(picker => {
        weeklyData[picker].sort((a, b) => a.week - b.week);
    });

    return weeklyData;
}

/**
 * Detect current week from the data
 */
function detectCurrentWeek(rows) {
    // Look at row 2 (index 1) which shows "Week, 14"
    const row2 = rows[1];
    if (row2) {
        for (let i = 0; i < row2.length; i++) {
            if (row2[i] === 'Week' && row2[i + 1]) {
                return parseInt(row2[i + 1]) || 14;
            }
        }
    }
    return 14;
}

/**
 * Parse percentage string to number
 */
function parsePercentage(value) {
    if (!value) return null;
    const str = value.toString().replace('%', '').trim();
    const num = parseFloat(str);
    return isNaN(num) ? null : num;
}

/**
 * Get pickers sorted by percentage (descending)
 */
function getSortedPickers(stats) {
    return Object.values(stats)
        .sort((a, b) => (b.percentage || 0) - (a.percentage || 0));
}

/**
 * Parse a weekly picks sheet CSV
 * This function should be customized based on your actual sheet structure
 *
 * Expected structure (adjust based on your actual format):
 * - Row headers with game info (Away Team, Home Team, Spread, etc.)
 * - Columns for each picker's line pick and winner pick
 * - Results columns (if games have been played)
 */
function parseWeeklyPicksCSV(csvText, weekNum) {
    const result = Papa.parse(csvText, {
        skipEmptyLines: false
    });

    const rows = result.data;

    // Initialize return structure
    const weekData = {
        picks: {},      // { picker: { gameId: { line: 'away'|'home', winner: 'away'|'home' } } }
        games: [],      // Array of game objects
        results: {}     // { gameId: { winner: 'away'|'home', awayScore: X, homeScore: Y } }
    };

    // Initialize picks for all pickers
    PICKERS.forEach(picker => {
        weekData.picks[picker] = {};
    });

    // Try to detect column positions by searching headers
    // This is a flexible approach that can adapt to different layouts

    let headerRowIdx = -1;
    let awayTeamCol = -1;
    let homeTeamCol = -1;
    let spreadCol = -1;
    let awayScoreCol = -1;
    let homeScoreCol = -1;
    const pickerLineCols = {};  // { picker: colIndex }
    const pickerWinnerCols = {}; // { picker: colIndex }

    // Search for header row (look for "Away" or team-related headers)
    for (let rowIdx = 0; rowIdx < Math.min(10, rows.length); rowIdx++) {
        const row = rows[rowIdx];
        if (!row) continue;

        for (let colIdx = 0; colIdx < row.length; colIdx++) {
            const cell = (row[colIdx] || '').toString().trim().toLowerCase();

            if (cell === 'away' || cell === 'away team') {
                headerRowIdx = rowIdx;
                awayTeamCol = colIdx;
            }
            if (cell === 'home' || cell === 'home team') {
                homeTeamCol = colIdx;
            }
            if (cell === 'spread' || cell === 'line') {
                spreadCol = colIdx;
            }
            if (cell === 'away score' || cell === 'away pts') {
                awayScoreCol = colIdx;
            }
            if (cell === 'home score' || cell === 'home pts') {
                homeScoreCol = colIdx;
            }

            // Look for picker columns
            PICKERS.forEach(picker => {
                const pickerLower = picker.toLowerCase();
                if (cell === pickerLower || cell === `${pickerLower} line` || cell === `${pickerLower} ats`) {
                    pickerLineCols[picker] = colIdx;
                }
                if (cell === `${pickerLower} winner` || cell === `${pickerLower} su` || cell === `${pickerLower} straight`) {
                    pickerWinnerCols[picker] = colIdx;
                }
            });
        }

        if (headerRowIdx !== -1) break;
    }

    // If we found headers, parse the games
    if (headerRowIdx !== -1 && awayTeamCol !== -1 && homeTeamCol !== -1) {
        let gameId = 1;

        for (let rowIdx = headerRowIdx + 1; rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx];
            if (!row) continue;

            const awayTeam = (row[awayTeamCol] || '').toString().trim();
            const homeTeam = (row[homeTeamCol] || '').toString().trim();

            // Skip empty rows or non-game rows
            if (!awayTeam || !homeTeam) continue;

            // Parse spread
            let spread = 0;
            let favorite = 'home';
            if (spreadCol !== -1 && row[spreadCol]) {
                const spreadStr = row[spreadCol].toString().trim();
                const spreadNum = parseFloat(spreadStr.replace(/[^-\d.]/g, ''));
                if (!isNaN(spreadNum)) {
                    spread = Math.abs(spreadNum);
                    // Negative spread means home is favorite, positive means away
                    favorite = spreadNum < 0 ? 'home' : 'away';
                }
            }

            // Create game object
            const game = {
                id: gameId,
                away: awayTeam,
                home: homeTeam,
                spread: spread,
                favorite: favorite,
                day: '',
                time: '',
                location: '',
                stadium: ''
            };
            weekData.games.push(game);

            // Parse results if available
            if (awayScoreCol !== -1 && homeScoreCol !== -1) {
                const awayScore = parseInt(row[awayScoreCol]);
                const homeScore = parseInt(row[homeScoreCol]);
                if (!isNaN(awayScore) && !isNaN(homeScore)) {
                    weekData.results[gameId] = {
                        awayScore: awayScore,
                        homeScore: homeScore,
                        winner: awayScore > homeScore ? 'away' : 'home'
                    };
                }
            }

            // Parse picker picks
            PICKERS.forEach(picker => {
                const lineCol = pickerLineCols[picker];
                const winnerCol = pickerWinnerCols[picker];

                if (lineCol !== undefined && row[lineCol]) {
                    const linePick = (row[lineCol] || '').toString().trim().toLowerCase();
                    if (linePick) {
                        // Try to match to away or home team
                        if (!weekData.picks[picker][gameId]) {
                            weekData.picks[picker][gameId] = {};
                        }
                        if (linePick.includes(awayTeam.toLowerCase()) || awayTeam.toLowerCase().includes(linePick)) {
                            weekData.picks[picker][gameId].line = 'away';
                        } else if (linePick.includes(homeTeam.toLowerCase()) || homeTeam.toLowerCase().includes(linePick)) {
                            weekData.picks[picker][gameId].line = 'home';
                        }
                    }
                }

                if (winnerCol !== undefined && row[winnerCol]) {
                    const winnerPick = (row[winnerCol] || '').toString().trim().toLowerCase();
                    if (winnerPick) {
                        if (!weekData.picks[picker][gameId]) {
                            weekData.picks[picker][gameId] = {};
                        }
                        if (winnerPick.includes(awayTeam.toLowerCase()) || awayTeam.toLowerCase().includes(winnerPick)) {
                            weekData.picks[picker][gameId].winner = 'away';
                        } else if (winnerPick.includes(homeTeam.toLowerCase()) || homeTeam.toLowerCase().includes(winnerPick)) {
                            weekData.picks[picker][gameId].winner = 'home';
                        }
                    }
                }
            });

            gameId++;
        }
    }

    return weekData;
}
