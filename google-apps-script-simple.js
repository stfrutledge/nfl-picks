/**
 * NFL Picks Backup - Clean Column Format
 *
 * SETUP:
 * 1. Create a new Google Sheet (or use existing)
 * 2. Go to Extensions > Apps Script
 * 3. Paste this code and click Deploy > New deployment
 * 4. Type: Web app, Execute as: Me, Access: Anyone
 * 5. Copy the URL and update APPS_SCRIPT_URL in app.js
 */

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'NFL Picks Backup API is running'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { week, picker, picks } = data;

    // Validate
    if (!week || !picker) {
      return jsonResponse({ error: 'Missing week or picker' });
    }

    if (!picks || picks.length === 0) {
      return jsonResponse({ error: 'No picks to backup' });
    }

    // Get or create Backup sheet with headers
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Backup');
    if (!sheet) {
      sheet = ss.insertSheet('Backup');
      sheet.appendRow(['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team', 'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin']);
      // Format header row
      sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    }

    // Append one row per pick
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
        pick.blazin ? 'Yes' : ''
      ]);
      rowsAdded++;
    }

    return jsonResponse({
      success: true,
      message: `Backed up ${rowsAdded} picks for ${picker} Week ${week}`,
      timestamp: timestamp,
      rowsAdded: rowsAdded
    });

  } catch (error) {
    return jsonResponse({ error: error.toString() });
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
