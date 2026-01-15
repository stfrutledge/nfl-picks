/**
 * NFL Picks Backup - With Spreads Support
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
 * - POST { week, picker, picks, spreads } - Save picks and/or spreads
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

    // Default response
    return jsonResponse({
      status: 'ok',
      message: 'NFL Picks Backup API is running',
      endpoints: {
        'GET ?action=spreads&week=N': 'Get spreads for week N',
        'POST': 'Save picks and/or spreads'
      }
    });
  } catch (error) {
    return jsonResponse({ error: error.toString() });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { week, picker, picks, spreads } = data;

    const results = {};

    // Save picks if provided
    if (picks && picks.length > 0 && picker) {
      results.picks = savePicks(week, picker, picks);
    }

    // Save spreads if provided
    if (spreads && Object.keys(spreads).length > 0) {
      results.spreads = saveSpreads(week, spreads);
    }

    if (Object.keys(results).length === 0) {
      return jsonResponse({ error: 'No picks or spreads provided' });
    }

    return jsonResponse({
      success: true,
      results: results
    });

  } catch (error) {
    return jsonResponse({ error: error.toString() });
  }
}

/**
 * Save picks to the Backup sheet
 */
function savePicks(week, picker, picks) {
  if (!week || !picker) {
    return { error: 'Missing week or picker' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Backup');
  if (!sheet) {
    sheet = ss.insertSheet('Backup');
    sheet.appendRow(['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team', 'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin', 'O/U Pick', 'O/U Line']);
    sheet.getRange(1, 1, 1, 13).setFontWeight('bold');
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
      pick.totalLine || ''
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
  let savedCount = 0;

  // Get existing data to check for duplicates
  const existingData = sheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < existingData.length; i++) {
    const rowWeek = existingData[i][0];
    const rowKey = existingData[i][1];
    existingKeys.add(`${rowWeek}_${rowKey}`);
  }

  for (const [gameKey, data] of Object.entries(spreads)) {
    const uniqueKey = `${week}_${gameKey}`;

    // Skip if we already have this spread saved
    if (existingKeys.has(uniqueKey)) {
      continue;
    }

    sheet.appendRow([
      week,
      gameKey,
      data.spread || 0,
      data.favorite || '',
      data.overUnder || '',
      timestamp
    ]);
    savedCount++;
  }

  return {
    message: `Saved ${savedCount} new spreads for Week ${week}`,
    savedCount: savedCount
  };
}

/**
 * Get spreads for a specific week
 */
function getSpreadsForWeek(week) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Spreads');

  if (!sheet) {
    return { week: week, spreads: {} };
  }

  const data = sheet.getDataRange().getValues();
  const spreads = {};

  // Skip header row
  for (let i = 1; i < data.length; i++) {
    const rowWeek = String(data[i][0]);
    if (rowWeek === String(week)) {
      const gameKey = data[i][1];
      spreads[gameKey] = {
        spread: data[i][2],
        favorite: data[i][3],
        overUnder: data[i][4]
      };
    }
  }

  return {
    week: week,
    spreads: spreads,
    count: Object.keys(spreads).length
  };
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
