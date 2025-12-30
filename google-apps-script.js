/**
 * NFL Picks Dashboard - Google Apps Script
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this entire file
 * 4. Click "Deploy" > "New deployment"
 * 5. Select type: "Web app"
 * 6. Set "Execute as": "Me"
 * 7. Set "Who has access": "Anyone"
 * 8. Click "Deploy" and copy the Web App URL
 * 9. Update APPS_SCRIPT_URL in app.js with your URL
 */

// Picker column mapping (1-indexed for Sheets)
const PICKER_COLUMNS = {
  'Dylan': { line: 2, winner: 3, blazin: 4 },    // B, C, D
  'Sean': { line: 5, winner: 6, blazin: 7 },     // E, F, G
  'Daniel': { line: 8, winner: 9, blazin: 10 },  // H, I, J
  'Jason': { line: 11, winner: 12, blazin: 13 }, // K, L, M
  'Stephen': { line: 14, winner: 15, blazin: 16 } // N, O, P
};

// Score columns (1-indexed for Sheets)
const SCORE_COLUMNS = {
  away: 41,  // AO - Away team score
  home: 44   // AR - Home team score
};

// Game details columns (1-indexed for Sheets)
const GAME_COLUMNS = {
  awayTeam: 39,    // AM - Visiting team
  awaySpread: 40,  // AN - Visiting team spread
  homeTeam: 42,    // AP - Home team
  homeSpread: 43   // AQ - Home team spread
};

/**
 * Handle GET requests (for testing)
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'NFL Picks API is running. Use POST to submit picks.'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle POST requests to save picks
 *
 * Expected payload:
 * {
 *   week: 1,
 *   picker: 'Stephen',
 *   picks: {
 *     1: { line: 'away', winner: 'home', blazin: true },
 *     2: { line: 'home', winner: 'home', blazin: false },
 *     ...
 *   }
 * }
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { week, picker, picks, scores, games } = data;

    Logger.log('Received data: week=' + week + ', picker=' + picker);
    Logger.log('Games count: ' + (games ? Object.keys(games).length : 0));
    Logger.log('Picks count: ' + (picks ? Object.keys(picks).length : 0));
    Logger.log('Scores count: ' + (scores ? Object.keys(scores).length : 0));

    // Validate inputs
    if (!week || !picker) {
      Logger.log('ERROR: Missing week or picker');
      return jsonResponse({ error: 'Missing required fields: week, picker' }, 400);
    }

    if (!picks && !scores && !games) {
      Logger.log('ERROR: No picks, scores, or games provided');
      return jsonResponse({ error: 'Must provide picks, scores, or games' }, 400);
    }

    if (!PICKER_COLUMNS[picker]) {
      Logger.log('ERROR: Invalid picker: ' + picker);
      return jsonResponse({ error: `Invalid picker: ${picker}` }, 400);
    }

    // Get the weekly sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = `Week ${week}`;
    Logger.log('Looking for sheet: ' + sheetName);
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      Logger.log('ERROR: Sheet not found: ' + sheetName);
      return jsonResponse({ error: `Sheet not found: ${sheetName}` }, 404);
    }
    Logger.log('Found sheet: ' + sheetName);

    // Game rows start at row 3 (game 1 = row 3, game 2 = row 4, etc.)
    const FIRST_GAME_ROW = 3;

    // Build game rows array - assume up to 16 games per week
    const gameRows = [];
    for (let i = 0; i < 16; i++) {
      gameRows.push({
        rowIndex: FIRST_GAME_ROW + i,
        gameId: i + 1
      });
    }

    // Get column indices for this picker
    const cols = PICKER_COLUMNS[picker];

    // Update picks for each game
    let updatedCount = 0;
    let scoresUpdated = 0;

    // Process picks if provided
    Logger.log('Processing picks: ' + JSON.stringify(picks));
    for (const [gameIdStr, pickData] of Object.entries(picks || {})) {
      Logger.log('Pick entry - gameIdStr: ' + gameIdStr + ', pickData: ' + JSON.stringify(pickData));
      const gameId = parseInt(gameIdStr);
      Logger.log('Parsed gameId: ' + gameId);

      // gameId is 1-indexed, so gameId 1 = gameRows[0]
      if (gameId < 1 || gameId > gameRows.length) {
        Logger.log('SKIPPING - gameId out of range: ' + gameId);
        continue; // Skip invalid game IDs
      }

      const gameRow = gameRows[gameId - 1];
      const rowNum = gameRow.rowIndex;

      // Read team names and spreads from game columns (AM, AN, AP, AQ)
      const awayTeam = sheet.getRange(rowNum, GAME_COLUMNS.awayTeam).getValue() || '';
      const awaySpread = sheet.getRange(rowNum, GAME_COLUMNS.awaySpread).getValue();
      const homeTeam = sheet.getRange(rowNum, GAME_COLUMNS.homeTeam).getValue() || '';
      const homeSpread = sheet.getRange(rowNum, GAME_COLUMNS.homeSpread).getValue();

      // Determine the pick text based on 'away' or 'home'
      let linePick = '';
      let winnerPick = '';
      let blazinMark = '';

      if (pickData.line) {
        const team = pickData.line === 'away' ? awayTeam : homeTeam;
        const spread = pickData.line === 'away' ? awaySpread : homeSpread;
        linePick = spread !== '' ? `${team} (${spread})` : team;
      }

      if (pickData.winner) {
        winnerPick = pickData.winner === 'away' ? awayTeam : homeTeam;
      }

      if (pickData.blazin) {
        blazinMark = '*';
      }

      // Write to the sheet
      sheet.getRange(rowNum, cols.line).setValue(linePick);
      sheet.getRange(rowNum, cols.winner).setValue(winnerPick);
      sheet.getRange(rowNum, cols.blazin).setValue(blazinMark);

      updatedCount++;
    }

    // Process scores if provided
    for (const [gameIdStr, scoreData] of Object.entries(scores || {})) {
      const gameId = parseInt(gameIdStr);

      if (gameId < 1 || gameId > gameRows.length) {
        continue;
      }

      const gameRow = gameRows[gameId - 1];
      const rowNum = gameRow.rowIndex;

      // Write scores to columns AO (away) and AR (home)
      if (scoreData.awayScore !== undefined) {
        sheet.getRange(rowNum, SCORE_COLUMNS.away).setValue(scoreData.awayScore);
      }
      if (scoreData.homeScore !== undefined) {
        sheet.getRange(rowNum, SCORE_COLUMNS.home).setValue(scoreData.homeScore);
      }

      scoresUpdated++;
    }

    // Process game details if provided
    let gamesUpdated = 0;
    Logger.log('Processing games...');
    for (const [gameIdStr, gameData] of Object.entries(games || {})) {
      const gameId = parseInt(gameIdStr);
      Logger.log('Game ID: ' + gameId + ', awayTeam: ' + gameData.awayTeam + ', homeTeam: ' + gameData.homeTeam);

      if (gameId < 1 || gameId > gameRows.length) {
        Logger.log('Skipping game ID ' + gameId + ' (out of range)');
        continue;
      }

      const gameRow = gameRows[gameId - 1];
      const rowNum = gameRow.rowIndex;
      Logger.log('Writing to row ' + rowNum);

      // Write game details: AM (away team), AN (away spread), AP (home team), AQ (home spread)
      if (gameData.awayTeam !== undefined) {
        sheet.getRange(rowNum, GAME_COLUMNS.awayTeam).setValue(gameData.awayTeam);
        Logger.log('Wrote awayTeam to col ' + GAME_COLUMNS.awayTeam);
      }
      if (gameData.awaySpread !== undefined) {
        sheet.getRange(rowNum, GAME_COLUMNS.awaySpread).setValue(gameData.awaySpread);
      }
      if (gameData.homeTeam !== undefined) {
        sheet.getRange(rowNum, GAME_COLUMNS.homeTeam).setValue(gameData.homeTeam);
      }
      if (gameData.homeSpread !== undefined) {
        sheet.getRange(rowNum, GAME_COLUMNS.homeSpread).setValue(gameData.homeSpread);
      }

      gamesUpdated++;
    }
    Logger.log('Games updated: ' + gamesUpdated);

    return jsonResponse({
      success: true,
      message: `Updated ${updatedCount} picks, ${scoresUpdated} scores, and ${gamesUpdated} games for ${picker} in Week ${week}`,
      week: week,
      picker: picker,
      updatedCount: updatedCount,
      scoresUpdated: scoresUpdated,
      gamesUpdated: gamesUpdated
    });

  } catch (error) {
    return jsonResponse({ error: error.toString() }, 500);
  }
}

/**
 * Parse game text to extract team names and spreads
 * Input: "Cowboys (+8.5) @ Eagles (-8.5)"
 * Output: { away: 'Cowboys', awaySpread: '+8.5', home: 'Eagles', homeSpread: '-8.5' }
 */
function parseGameText(gameText) {
  const match = gameText.match(/^(.+?)\s*\(([+-]?\d+\.?\d*)\)\s*@\s*(.+?)\s*\(([+-]?\d+\.?\d*)\)$/);
  if (!match) return null;

  return {
    away: match[1].trim(),
    awaySpread: match[2].startsWith('+') || match[2].startsWith('-') ? match[2] : '+' + match[2],
    home: match[3].trim(),
    homeSpread: match[4].startsWith('+') || match[4].startsWith('-') ? match[4] : '+' + match[4]
  };
}

/**
 * Helper to return JSON response
 */
function jsonResponse(data, statusCode = 200) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Clear all picks for a specific picker in a week
 * Called when user clicks "Clear My Picks"
 */
function clearPicks(week, picker) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = `Week ${week}`;
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) return { error: `Sheet not found: ${sheetName}` };

  const cols = PICKER_COLUMNS[picker];
  if (!cols) return { error: `Invalid picker: ${picker}` };

  // Game rows start at row 3, up to 16 games
  const FIRST_GAME_ROW = 3;
  const MAX_GAMES = 16;

  // Clear game rows
  let clearedCount = 0;
  for (let i = 0; i < MAX_GAMES; i++) {
    const rowNum = FIRST_GAME_ROW + i;
    sheet.getRange(rowNum, cols.line).setValue('');
    sheet.getRange(rowNum, cols.winner).setValue('');
    sheet.getRange(rowNum, cols.blazin).setValue('');
    clearedCount++;
  }

  return { success: true, clearedCount: clearedCount };
}
