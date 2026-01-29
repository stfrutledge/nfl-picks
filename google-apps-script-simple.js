/**
 * NFL Picks Backup - With Spreads, Results & Outcomes Support
 *
 * SETUP:
 * 1. Create a new Google Sheet (or use existing)
 * 2. Go to Extensions > Apps Script
 * 3. Paste this code and click Deploy > New deployment
 * 4. Type: Web app, Execute as: Me, Access: Anyone
 * 5. Copy the URL and add it as APPS_SCRIPT_URL in Cloudflare Worker env vars
 *
 * ENDPOINTS:
 * - GET ?action=spreads&week=19 - Get saved spreads for a week
 * - GET ?action=picks&week=19&picker=Steve - Get saved picks for a week and picker
 * - GET ?action=allpicks - Get all picks for all weeks and pickers
 * - GET ?action=results&week=19 - Get results for a week
 * - GET ?action=allresults - Get all results
 * - POST { week, picker, picks, spreads } - Save picks and/or spreads
 * - POST { week, results, source } - Save results and calculate outcomes
 */

function doGet(e) {
  try {
    const action = e.parameter.action;

    if (action === 'spreads') {
      const week = e.parameter.week;
      if (!week) {
        return jsonResponse({ error: 'Missing week parameter' });
      }
      return jsonResponse(getSpreadsForWeek(week));
    }

    if (action === 'picks') {
      const week = e.parameter.week;
      const picker = e.parameter.picker;
      if (!week) {
        return jsonResponse({ error: 'Missing week parameter' });
      }
      if (!picker) {
        return jsonResponse({ error: 'Missing picker parameter' });
      }
      return jsonResponse(getPicksForWeek(week, picker));
    }

    // Get ALL picks for all weeks and all pickers in one call
    if (action === 'allpicks') {
      return jsonResponse(getAllPicks());
    }

    // Get results for a specific week
    if (action === 'results') {
      const week = e.parameter.week;
      if (!week) {
        return jsonResponse({ error: 'Missing week parameter' });
      }
      return jsonResponse(getResultsForWeek(week));
    }

    // Get ALL results for all weeks
    if (action === 'allresults') {
      return jsonResponse(getAllResults());
    }

    // Default response
    return jsonResponse({
      status: 'ok',
      message: 'NFL Picks Backup API is running',
      endpoints: {
        'GET ?action=spreads&week=N': 'Get spreads for week N',
        'GET ?action=picks&week=N&picker=X': 'Get picks for week N and picker X',
        'GET ?action=allpicks': 'Get all picks for all weeks and pickers',
        'GET ?action=results&week=N': 'Get results for week N',
        'GET ?action=allresults': 'Get all results',
        'POST': 'Save picks, spreads, or results'
      }
    });
  } catch (error) {
    return jsonResponse({ error: error.toString() });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { week, picker, picks, spreads, cleared, results: gameResults, source } = data;

    const response = {};

    // Save cleared status if provided
    if (typeof cleared === 'boolean' && week && picker) {
      response.cleared = saveClearedStatus(week, picker, cleared);
    }

    // Save picks if provided
    if (picks && picks.length > 0 && picker) {
      response.picks = savePicks(week, picker, picks);
    }

    // Save spreads if provided
    if (spreads && Object.keys(spreads).length > 0) {
      response.spreads = saveSpreads(week, spreads);
    }

    // Save game results if provided (and calculate outcomes)
    if (gameResults && Object.keys(gameResults).length > 0 && week) {
      response.results = saveResults(week, gameResults, source || 'ESPN');
    }

    if (Object.keys(response).length === 0) {
      return jsonResponse({ error: 'No picks, spreads, results, or cleared status provided' });
    }

    return jsonResponse({
      success: true,
      results: response
    });

  } catch (error) {
    return jsonResponse({ error: error.toString() });
  }
}

/**
 * Save picks to the Backup sheet
 * Columns: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread,
 *          Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line, Line Outcome, Winner Outcome, O/U Outcome
 */
function savePicks(week, picker, picks) {
  if (!week || !picker) {
    return { error: 'Missing week or picker' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Backup');
  if (!sheet) {
    sheet = ss.insertSheet('Backup');
    sheet.appendRow(['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team', 'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin', 'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome']);
    sheet.getRange(1, 1, 1, 16).setFontWeight('bold');
  } else {
    // Check if sheet needs migration (add outcome columns if missing)
    const headers = sheet.getRange(1, 1, 1, 16).getValues()[0];
    if (headers[13] !== 'Line Outcome') {
      // Add the three new outcome columns
      sheet.getRange(1, 14).setValue('Line Outcome');
      sheet.getRange(1, 15).setValue('Winner Outcome');
      sheet.getRange(1, 16).setValue('O/U Outcome');
      sheet.getRange(1, 14, 1, 3).setFontWeight('bold');
    }
  }

  const timestamp = new Date().toISOString();
  let rowsAdded = 0;

  for (const pick of picks) {
    sheet.appendRow([
      timestamp,
      week,
      picker,
      pick.gameId,
      pick.away || '',
      pick.home || '',
      pick.awaySpread || '',
      pick.homeSpread || '',
      pick.linePick || '',
      pick.winnerPick || '',
      pick.blazin ? 'Yes' : '',
      pick.overUnder || '',
      pick.totalLine || '',
      '', // Line Outcome - populated when results come in
      '', // Winner Outcome - populated when results come in
      ''  // O/U Outcome - populated when results come in
    ]);
    rowsAdded++;
  }

  return {
    message: `Backed up ${rowsAdded} picks for ${picker} Week ${week}`,
    rowsAdded: rowsAdded
  };
}

/**
 * Save spreads to the Spreads sheet
 * spreads format: { 'away_home': { spread, favorite, overUnder } }
 *
 * Updates existing spreads if they've changed (client controls when updates are allowed)
 */
function saveSpreads(week, spreads) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Spreads');
  if (!sheet) {
    sheet = ss.insertSheet('Spreads');
    sheet.appendRow(['Week', 'Game Key', 'Spread', 'Favorite', 'Over/Under', 'Timestamp']);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }

  const timestamp = new Date().toISOString();
  let addedCount = 0;
  let updatedCount = 0;

  // Get existing data to find rows to update
  const existingData = sheet.getDataRange().getValues();
  const existingRows = {}; // Map of uniqueKey -> row number (1-indexed)
  for (let i = 1; i < existingData.length; i++) {
    const rowWeek = String(existingData[i][0]);
    const rowKey = existingData[i][1];
    existingRows[`${rowWeek}_${rowKey}`] = i + 1; // 1-indexed row number
  }

  for (const [gameKey, data] of Object.entries(spreads)) {
    const uniqueKey = `${week}_${gameKey}`;
    const existingRow = existingRows[uniqueKey];

    if (existingRow) {
      // Update existing row
      sheet.getRange(existingRow, 3, 1, 4).setValues([[
        data.spread || 0,
        data.favorite || '',
        data.overUnder || '',
        timestamp
      ]]);
      updatedCount++;
    } else {
      // Add new row
      sheet.appendRow([
        week,
        gameKey,
        data.spread || 0,
        data.favorite || '',
        data.overUnder || '',
        timestamp
      ]);
      addedCount++;
    }
  }

  return {
    message: `Week ${week}: ${addedCount} new, ${updatedCount} updated`,
    addedCount: addedCount,
    updatedCount: updatedCount
  };
}

/**
 * Save cleared status for a picker's week
 * cleared=true means picks were intentionally cleared and shouldn't be restored from backup
 */
function saveClearedStatus(week, picker, cleared) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('ClearedPicks');
  if (!sheet) {
    sheet = ss.insertSheet('ClearedPicks');
    sheet.appendRow(['Week', 'Picker', 'Cleared', 'Timestamp']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }

  const timestamp = new Date().toISOString();

  // Find existing row for this week/picker
  const data = sheet.getDataRange().getValues();
  let existingRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(week) && String(data[i][1]) === picker) {
      existingRow = i + 1; // 1-indexed
      break;
    }
  }

  if (existingRow > 0) {
    // Update existing row
    sheet.getRange(existingRow, 3, 1, 2).setValues([[cleared ? 'Yes' : 'No', timestamp]]);
  } else {
    // Add new row
    sheet.appendRow([week, picker, cleared ? 'Yes' : 'No', timestamp]);
  }

  return {
    message: `Cleared status for ${picker} Week ${week} set to ${cleared}`,
    cleared: cleared
  };
}

/**
 * Check if picks were cleared for a specific week/picker
 */
function isClearedForWeek(week, picker) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('ClearedPicks');

  if (!sheet) {
    return false;
  }

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(week) && String(data[i][1]) === picker) {
      return data[i][2] === 'Yes';
    }
  }

  return false;
}

/**
 * Get spreads for a specific week
 * Returns spreads and the latest timestamp for cache validation
 */
function getSpreadsForWeek(week) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Spreads');

  if (!sheet) {
    return { week: week, spreads: {}, lastUpdated: null };
  }

  const data = sheet.getDataRange().getValues();
  const spreads = {};
  let latestTimestamp = null;

  // Skip header row
  // Columns: Week, Game Key, Spread, Favorite, Over/Under, Timestamp
  for (let i = 1; i < data.length; i++) {
    const rowWeek = String(data[i][0]);
    if (rowWeek === String(week)) {
      const gameKey = data[i][1];
      const timestamp = data[i][5]; // Timestamp column

      spreads[gameKey] = {
        spread: data[i][2],
        favorite: data[i][3],
        overUnder: data[i][4]
      };

      // Track the latest timestamp
      if (timestamp && (!latestTimestamp || new Date(timestamp) > new Date(latestTimestamp))) {
        latestTimestamp = timestamp;
      }
    }
  }

  return {
    week: week,
    lastUpdated: latestTimestamp,
    spreads: spreads,
    count: Object.keys(spreads).length
  };
}

/**
 * Get picks for a specific week and picker
 * Returns the latest picks for each game (most recent timestamp wins)
 */
function getPicksForWeek(week, picker) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Backup');

  if (!sheet) {
    return { week: week, picker: picker, picks: {} };
  }

  const data = sheet.getDataRange().getValues();
  // Header: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread,
  //         Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line, Line Outcome, Winner Outcome, O/U Outcome
  // Index:  0          1     2       3     4          5          6            7
  //         8          9            10      11        12         13            14              15

  // Collect all picks for this week/picker, keyed by gameId with timestamp
  const picksWithTimestamp = {};

  for (let i = 1; i < data.length; i++) {
    const rowWeek = String(data[i][1]);
    const rowPicker = String(data[i][2]);

    if (rowWeek === String(week) && rowPicker === picker) {
      const timestamp = new Date(data[i][0]).getTime();
      const gameId = data[i][3];

      // Only keep if this is a newer timestamp than what we have
      if (!picksWithTimestamp[gameId] || timestamp > picksWithTimestamp[gameId].timestamp) {
        picksWithTimestamp[gameId] = {
          timestamp: timestamp,
          away: data[i][4],
          home: data[i][5],
          awaySpread: data[i][6],
          homeSpread: data[i][7],
          linePick: data[i][8],
          winnerPick: data[i][9],
          blazin: data[i][10] === 'Yes',
          overUnder: data[i][11],
          totalLine: data[i][12],
          lineOutcome: data[i][13] || '',
          winnerOutcome: data[i][14] || '',
          ouOutcome: data[i][15] || ''
        };
      }
    }
  }

  // Convert to the format app.js expects, keyed by matchup (away_home) instead of gameId
  // This ensures picks are applied to the correct game regardless of game order
  const picks = {};
  for (const [gameId, pickData] of Object.entries(picksWithTimestamp)) {
    // Create matchup key from team names
    const matchupKey = `${pickData.away.toLowerCase()}_${pickData.home.toLowerCase()}`;

    // Convert team names back to 'home'/'away' format
    let linePick = pickData.linePick;
    if (linePick === pickData.away) {
      linePick = 'away';
    } else if (linePick === pickData.home) {
      linePick = 'home';
    }

    let winnerPick = pickData.winnerPick;
    if (winnerPick === pickData.away) {
      winnerPick = 'away';
    } else if (winnerPick === pickData.home) {
      winnerPick = 'home';
    }

    picks[matchupKey] = {
      line: linePick || '',
      winner: winnerPick || '',
      blazin: pickData.blazin || false,
      overUnder: pickData.overUnder || '',
      totalLine: pickData.totalLine || '',
      lineOutcome: pickData.lineOutcome || '',
      winnerOutcome: pickData.winnerOutcome || '',
      ouOutcome: pickData.ouOutcome || ''
    };
  }

  // Check if picks were intentionally cleared
  const cleared = isClearedForWeek(week, picker);

  return {
    week: week,
    picker: picker,
    picks: picks,
    count: Object.keys(picks).length,
    cleared: cleared
  };
}

/**
 * Get ALL picks for all weeks and all pickers in one call
 * Returns: { picks: { week: { picker: { gameId: pickData } } }, cleared: { week: { picker: true } } }
 */
function getAllPicks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Backup');

  const allPicks = {};
  const allCleared = {};

  if (sheet) {
    const data = sheet.getDataRange().getValues();
    // Header: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread,
    //         Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line, Line Outcome, Winner Outcome, O/U Outcome

    // Collect all picks with timestamps to get the latest for each game
    const picksWithTimestamp = {};

    for (let i = 1; i < data.length; i++) {
      const timestamp = new Date(data[i][0]).getTime();
      const week = String(data[i][1]);
      const picker = String(data[i][2]);
      const gameId = String(data[i][3]);

      if (!picksWithTimestamp[week]) {
        picksWithTimestamp[week] = {};
      }
      if (!picksWithTimestamp[week][picker]) {
        picksWithTimestamp[week][picker] = {};
      }

      // Only keep if this is a newer timestamp than what we have
      if (!picksWithTimestamp[week][picker][gameId] || timestamp > picksWithTimestamp[week][picker][gameId].timestamp) {
        picksWithTimestamp[week][picker][gameId] = {
          timestamp: timestamp,
          away: data[i][4],
          home: data[i][5],
          linePick: data[i][8],
          winnerPick: data[i][9],
          blazin: data[i][10] === 'Yes',
          overUnder: data[i][11],
          totalLine: data[i][12],
          lineOutcome: data[i][13] || '',
          winnerOutcome: data[i][14] || '',
          ouOutcome: data[i][15] || ''
        };
      }
    }

    // Convert to final format, keyed by matchup (away_home) instead of gameId
    // This ensures picks are applied to the correct game regardless of game order
    for (const week in picksWithTimestamp) {
      allPicks[week] = {};
      for (const picker in picksWithTimestamp[week]) {
        allPicks[week][picker] = {};
        for (const gameId in picksWithTimestamp[week][picker]) {
          const pickData = picksWithTimestamp[week][picker][gameId];

          // Create matchup key from team names
          const matchupKey = `${pickData.away.toLowerCase()}_${pickData.home.toLowerCase()}`;

          // Convert team names back to 'home'/'away' format
          let linePick = pickData.linePick;
          if (linePick === pickData.away) {
            linePick = 'away';
          } else if (linePick === pickData.home) {
            linePick = 'home';
          }

          let winnerPick = pickData.winnerPick;
          if (winnerPick === pickData.away) {
            winnerPick = 'away';
          } else if (winnerPick === pickData.home) {
            winnerPick = 'home';
          }

          allPicks[week][picker][matchupKey] = {
            line: linePick || '',
            winner: winnerPick || '',
            blazin: pickData.blazin || false,
            overUnder: pickData.overUnder || '',
            totalLine: pickData.totalLine || '',
            lineOutcome: pickData.lineOutcome || '',
            winnerOutcome: pickData.winnerOutcome || '',
            ouOutcome: pickData.ouOutcome || ''
          };
        }
      }
    }
  }

  // Get all cleared statuses
  const clearedSheet = ss.getSheetByName('ClearedPicks');
  if (clearedSheet) {
    const clearedData = clearedSheet.getDataRange().getValues();
    for (let i = 1; i < clearedData.length; i++) {
      const week = String(clearedData[i][0]);
      const picker = String(clearedData[i][1]);
      const cleared = clearedData[i][2] === 'Yes';

      if (cleared) {
        if (!allCleared[week]) {
          allCleared[week] = {};
        }
        allCleared[week][picker] = true;
      }
    }
  }

  return {
    picks: allPicks,
    cleared: allCleared,
    weekCount: Object.keys(allPicks).length
  };
}

/**
 * Save game results to the Results sheet
 * Results format: { 'gameKey': { awayScore, homeScore, winner } }
 * Also triggers outcome calculation for all picks on these games
 */
function saveResults(week, results, source) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Results');
  if (!sheet) {
    sheet = ss.insertSheet('Results');
    sheet.appendRow(['Week', 'Game Key', 'Away Team', 'Home Team', 'Away Score', 'Home Score', 'Winner', 'Timestamp', 'Source']);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
  }

  const timestamp = new Date().toISOString();
  let addedCount = 0;
  let updatedCount = 0;

  // Get existing data to find rows to update
  const existingData = sheet.getDataRange().getValues();
  const existingRows = {}; // Map of uniqueKey -> row number (1-indexed)
  for (let i = 1; i < existingData.length; i++) {
    const rowWeek = String(existingData[i][0]);
    const rowKey = existingData[i][1];
    existingRows[`${rowWeek}_${rowKey}`] = i + 1;
  }

  for (const [gameKey, data] of Object.entries(results)) {
    const uniqueKey = `${week}_${gameKey}`;
    const existingRow = existingRows[uniqueKey];

    // Determine winner from scores
    const winner = data.awayScore > data.homeScore ? 'away' :
                   data.homeScore > data.awayScore ? 'home' : 'tie';

    // Parse team names from gameKey (format: "away_home")
    const [awayTeam, homeTeam] = gameKey.split('_').map(t =>
      t.charAt(0).toUpperCase() + t.slice(1)
    );

    if (existingRow) {
      // Update existing row
      sheet.getRange(existingRow, 3, 1, 7).setValues([[
        awayTeam,
        homeTeam,
        data.awayScore,
        data.homeScore,
        winner,
        timestamp,
        source
      ]]);
      updatedCount++;
    } else {
      // Add new row
      sheet.appendRow([
        week,
        gameKey,
        awayTeam,
        homeTeam,
        data.awayScore,
        data.homeScore,
        winner,
        timestamp,
        source
      ]);
      addedCount++;
    }

    // Calculate and save outcomes for all picks on this game
    calculateAndSaveOutcomes(week, gameKey, {
      awayScore: data.awayScore,
      homeScore: data.homeScore,
      winner: winner
    });
  }

  return {
    message: `Week ${week}: ${addedCount} new results, ${updatedCount} updated`,
    addedCount: addedCount,
    updatedCount: updatedCount
  };
}

/**
 * Get results for a specific week
 */
function getResultsForWeek(week) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Results');

  if (!sheet) {
    return { week: week, results: {}, count: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const results = {};

  // Skip header row
  // Columns: Week, Game Key, Away Team, Home Team, Away Score, Home Score, Winner, Timestamp, Source
  for (let i = 1; i < data.length; i++) {
    const rowWeek = String(data[i][0]);
    if (rowWeek === String(week)) {
      const gameKey = data[i][1];
      results[gameKey] = {
        awayTeam: data[i][2],
        homeTeam: data[i][3],
        awayScore: data[i][4],
        homeScore: data[i][5],
        winner: data[i][6],
        timestamp: data[i][7],
        source: data[i][8]
      };
    }
  }

  return {
    week: week,
    results: results,
    count: Object.keys(results).length
  };
}

/**
 * Get ALL results for all weeks
 */
function getAllResults() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Results');

  if (!sheet) {
    return { results: {}, weekCount: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const allResults = {};

  // Skip header row
  for (let i = 1; i < data.length; i++) {
    const week = String(data[i][0]);
    const gameKey = data[i][1];

    if (!allResults[week]) {
      allResults[week] = {};
    }

    allResults[week][gameKey] = {
      awayTeam: data[i][2],
      homeTeam: data[i][3],
      awayScore: data[i][4],
      homeScore: data[i][5],
      winner: data[i][6],
      timestamp: data[i][7],
      source: data[i][8]
    };
  }

  return {
    results: allResults,
    weekCount: Object.keys(allResults).length
  };
}

/**
 * Calculate and save outcomes for all picks on a specific game
 * Called when a result is saved
 */
function calculateAndSaveOutcomes(week, gameKey, result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const backupSheet = ss.getSheetByName('Backup');
  const spreadsSheet = ss.getSheetByName('Spreads');

  if (!backupSheet) {
    return { message: 'Backup sheet not found', updated: 0 };
  }

  // Get spread data for this game
  let spread = null;
  let favorite = null;
  let overUnder = null;

  if (spreadsSheet) {
    const spreadsData = spreadsSheet.getDataRange().getValues();
    for (let i = 1; i < spreadsData.length; i++) {
      if (String(spreadsData[i][0]) === String(week) && spreadsData[i][1] === gameKey) {
        spread = spreadsData[i][2];
        favorite = spreadsData[i][3];
        overUnder = spreadsData[i][4];
        break;
      }
    }
  }

  // Find all picks for this game in Backup sheet
  const backupData = backupSheet.getDataRange().getValues();
  // Header: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread,
  //         Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line, Line Outcome, Winner Outcome, O/U Outcome
  // Index:  0          1     2       3     4          5          6            7
  //         8          9            10      11        12         13            14              15

  let updatedCount = 0;

  for (let i = 1; i < backupData.length; i++) {
    const rowWeek = String(backupData[i][1]);
    const awayTeam = String(backupData[i][4]).toLowerCase();
    const homeTeam = String(backupData[i][5]).toLowerCase();
    const rowGameKey = `${awayTeam}_${homeTeam}`;

    if (rowWeek === String(week) && rowGameKey === gameKey) {
      const linePick = backupData[i][8]; // Team name or 'away'/'home'
      const winnerPick = backupData[i][9];
      const ouPick = backupData[i][11];
      const pickOULine = backupData[i][12] || overUnder;

      let lineOutcome = '';
      let winnerOutcome = '';
      let ouOutcome = '';

      // Calculate Line (ATS) outcome
      if (linePick && spread) {
        const atsWinner = calculateATSWinner(spread, favorite, result, awayTeam, homeTeam);
        if (atsWinner === 'push') {
          lineOutcome = 'push';
        } else {
          // linePick could be team name or 'away'/'home'
          const pickSide = getPickSide(linePick, awayTeam, homeTeam);
          lineOutcome = (pickSide === atsWinner) ? 'win' : 'loss';
        }
      }

      // Calculate Winner (straight up) outcome
      if (winnerPick) {
        const pickSide = getPickSide(winnerPick, awayTeam, homeTeam);
        if (result.winner === 'tie') {
          winnerOutcome = 'push';
        } else {
          winnerOutcome = (pickSide === result.winner) ? 'win' : 'loss';
        }
      }

      // Calculate O/U outcome
      if (ouPick && pickOULine) {
        const total = result.awayScore + result.homeScore;
        if (total === pickOULine) {
          ouOutcome = 'push';
        } else if ((ouPick.toLowerCase() === 'over' && total > pickOULine) ||
                   (ouPick.toLowerCase() === 'under' && total < pickOULine)) {
          ouOutcome = 'win';
        } else {
          ouOutcome = 'loss';
        }
      }

      // Update the row with outcomes (columns N, O, P = indices 14, 15, 16)
      if (lineOutcome || winnerOutcome || ouOutcome) {
        backupSheet.getRange(i + 1, 14, 1, 3).setValues([[lineOutcome, winnerOutcome, ouOutcome]]);
        updatedCount++;
      }
    }
  }

  return { message: `Updated ${updatedCount} pick outcomes for ${gameKey}`, updated: updatedCount };
}

/**
 * Calculate ATS (against the spread) winner
 * Returns 'away', 'home', or 'push'
 */
function calculateATSWinner(spread, favorite, result, awayTeam, homeTeam) {
  // Spread is always positive, favorite tells us who it applies to
  // Calculate margin: positive means home won by that margin
  const margin = result.homeScore - result.awayScore;

  // Normalize favorite to 'home' or 'away'
  let favSide = 'home';
  if (favorite) {
    const favLower = String(favorite).toLowerCase();
    if (favLower === 'away' || favLower === awayTeam) {
      favSide = 'away';
    }
  }

  // Calculate adjusted margin (positive = home covers)
  // If home is favorite, they need to win by more than spread
  // If away is favorite, home covers if they win or lose by less than spread
  let adjustedMargin;
  if (favSide === 'home') {
    adjustedMargin = margin - spread;
  } else {
    adjustedMargin = margin + spread;
  }

  if (adjustedMargin === 0) {
    return 'push';
  }
  return adjustedMargin > 0 ? 'home' : 'away';
}

/**
 * Get the side ('away' or 'home') from a pick value
 * Pick could be team name or 'away'/'home'
 */
function getPickSide(pick, awayTeam, homeTeam) {
  const pickLower = String(pick).toLowerCase();
  if (pickLower === 'away' || pickLower === awayTeam) {
    return 'away';
  }
  if (pickLower === 'home' || pickLower === homeTeam) {
    return 'home';
  }
  // Try partial match (e.g., "Chiefs" matches "kansas city chiefs")
  if (awayTeam.includes(pickLower) || pickLower.includes(awayTeam.split(' ').pop())) {
    return 'away';
  }
  if (homeTeam.includes(pickLower) || pickLower.includes(homeTeam.split(' ').pop())) {
    return 'home';
  }
  return null;
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
