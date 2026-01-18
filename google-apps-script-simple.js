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
 * - GET ?action=picks&week=19&picker=Steve - Get saved picks for a week and picker
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

    // Default response
    return jsonResponse({
      status: 'ok',
      message: 'NFL Picks Backup API is running',
      endpoints: {
        'GET ?action=spreads&week=N': 'Get spreads for week N',
        'GET ?action=picks&week=N&picker=X': 'Get picks for week N and picker X',
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
  // Header: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread, Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line
  // Index:  0          1     2       3     4          5          6            7            8          9            10      11        12

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
          totalLine: data[i][12]
        };
      }
    }
  }

  // Convert to the format app.js expects: { gameId: { line, winner, blazin, overUnder, totalLine } }
  const picks = {};
  for (const [gameId, pickData] of Object.entries(picksWithTimestamp)) {
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

    picks[gameId] = {
      line: linePick || '',
      winner: winnerPick || '',
      blazin: pickData.blazin || false,
      overUnder: pickData.overUnder || '',
      totalLine: pickData.totalLine || ''
    };
  }

  return {
    week: week,
    picker: picker,
    picks: picks,
    count: Object.keys(picks).length
  };
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
