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
 * - GET ?action=allpicks&season=2026 - Only that season's rows (much smaller)
 * - GET ?action=diagnose - Row counts + split-key rows, for troubleshooting
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

    // Get ALL picks for all weeks and all pickers in one call.
    // Pass season=YYYY to get only that season's rows - the client discards
    // other seasons anyway, and the sheet is never pruned, so without this the
    // payload grows by a whole season every year.
    if (action === 'allpicks') {
      const season = e.parameter.season ? Number(e.parameter.season) : null;
      return jsonResponse(getAllPicks(season));
    }

    // Raw-row diagnostics: how big the Backup sheet actually is, and whether
    // any legacy split-key rows are still in it. See diagnoseBackup().
    if (action === 'diagnose') {
      return jsonResponse(diagnoseBackup());
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
        'GET ?action=allpicks&season=YYYY': 'Only that season\'s rows',
        'GET ?action=diagnose': 'Backup sheet row counts and split-key rows',
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

// ---------------------------------------------------------------------------
// Reading the Backup sheet
//
// The sheet is an append-only log: savePicks() never updates or deletes, so a
// game accumulates one row per sync, and reading means collapsing those rows
// back down to one pick per game.
//
// Two rows can collapse onto the same game even within a single sync. Before
// the client stored every field under one matchup key, a game's line pick and
// its Blazin' 5 star were held under different keys and synced as two rows:
//
//   Game "1"              Rams Seahawks   Line Pick ""          Blazin "Yes"
//   Game "rams_seahawks"  Rams Seahawks   Line Pick "Seahawks"  Blazin ""
//
// Both rebuild to the key "rams_seahawks". Collapsing by overwrite silently
// dropped whichever half lost, and since savePicks() stamps ONE timestamp per
// sync, a newest-wins rule cannot separate them either - they are the same age.
// So rows are grouped into sync batches by timestamp: within a batch the rows
// are complementary halves and merge, and a later batch supersedes an earlier
// one wholesale (a blank in the newest batch is a real deselection, not a gap).
// ---------------------------------------------------------------------------

// Rows written before the 2026 season-prefix convention are bare week numbers
// and all belong to this season. Must match fromSheetWeek() in app.js.
const SHEET_LEGACY_SEASON = 2025;

/**
 * Which season a value in the Week column belongs to.
 * "2026_1" -> 2026, "18" -> SHEET_LEGACY_SEASON.
 */
function seasonOfSheetWeek(sheetWeek) {
  const match = String(sheetWeek).match(/^(\d{4})_/);
  return match ? Number(match[1]) : SHEET_LEGACY_SEASON;
}

/** A cell that carries no pick. */
function isBlankCell(value) {
  return value === '' || value === null || value === undefined;
}

/**
 * Fold one Backup row into the accumulating pick for its game.
 *
 * Same batch  -> merge: a non-blank cell fills a blank one, Blazin sticks.
 * Newer batch -> replace: the newest sync is the client's full state.
 */
function foldPickRow(existing, row) {
  if (!existing) return row;

  // A freeze is final. Once a row records one, a later row that does not carry
  // it cannot undo it - which is what stops a second device or a stale tab
  // re-syncing an unfrozen snapshot over a frozen pick.
  const existingFrozen = !isBlankCell(existing.frozenAt);
  const rowFrozen = !isBlankCell(row.frozenAt);
  if (existingFrozen && !rowFrozen) return existing;
  if (rowFrozen && !existingFrozen) return row;

  if (row.timestamp > existing.timestamp) {
    return row;
  }
  if (row.timestamp < existing.timestamp) {
    return existing;
  }
  // Same sync batch: complementary halves of one game.
  const merged = existing;
  if (isBlankCell(merged.linePick)) merged.linePick = row.linePick;
  if (isBlankCell(merged.winnerPick)) merged.winnerPick = row.winnerPick;
  if (isBlankCell(merged.overUnder)) merged.overUnder = row.overUnder;
  if (isBlankCell(merged.totalLine)) merged.totalLine = row.totalLine;
  if (isBlankCell(merged.lineOutcome)) merged.lineOutcome = row.lineOutcome;
  if (isBlankCell(merged.winnerOutcome)) merged.winnerOutcome = row.winnerOutcome;
  if (isBlankCell(merged.ouOutcome)) merged.ouOutcome = row.ouOutcome;
  merged.blazin = merged.blazin || row.blazin;
  if (isBlankCell(merged.frozenAt)) merged.frozenAt = row.frozenAt;
  return merged;
}

/** Read one Backup row into a plain object. Column order is the header row. */
function readPickRow(row) {
  return {
    timestamp: new Date(row[0]).getTime(),
    week: String(row[1]),
    picker: String(row[2]),
    gameId: String(row[3]),
    away: row[4],
    home: row[5],
    awaySpread: row[6],
    homeSpread: row[7],
    linePick: row[8],
    winnerPick: row[9],
    blazin: row[10] === 'Yes',
    overUnder: row[11],
    totalLine: row[12],
    lineOutcome: row[13] || '',
    winnerOutcome: row[14] || '',
    ouOutcome: row[15] || '',
    frozenAt: row[16] || ''
  };
}

/**
 * The line a row was graded against, recovered from its signed spread columns:
 * the favourite is whichever side is laying the points.
 */
function lineFromRow(row) {
  const away = Number(row.awaySpread);
  const home = Number(row.homeSpread);
  if (!isFinite(away) || !isFinite(home)) return null;
  return home <= away
    ? { spread: Math.abs(home), favorite: 'home' }
    : { spread: Math.abs(away), favorite: 'away' };
}

/**
 * The key a row's pick is stored under: built from the team-name columns, so
 * it is stable no matter what the Game column happens to hold.
 */
function matchupKeyForRow(row) {
  return String(row.away).toLowerCase() + '_' + String(row.home).toLowerCase();
}

/** Convert a stored team name back to the 'away'/'home' the client expects. */
function sideOf(pickValue, away, home) {
  if (pickValue === away) return 'away';
  if (pickValue === home) return 'home';
  return pickValue || '';
}

/** The client-facing shape of one collapsed pick. */
function pickPayload(row) {
  const payload = {
    line: sideOf(row.linePick, row.away, row.home),
    winner: sideOf(row.winnerPick, row.away, row.home),
    blazin: row.blazin || false,
    overUnder: row.overUnder || '',
    totalLine: row.totalLine || '',
    lineOutcome: row.lineOutcome || '',
    winnerOutcome: row.winnerOutcome || '',
    ouOutcome: row.ouOutcome || ''
  };

  // A frozen pick carries the line it was frozen at, rebuilt from the spread
  // columns, so the client keeps grading it at that number after a reload.
  if (!isBlankCell(row.frozenAt)) {
    const line = lineFromRow(row);
    payload.frozenAt = row.frozenAt;
    if (line) {
      payload.frozenSpread = line.spread;
      payload.frozenFavorite = line.favorite;
    }
  }

  return payload;
}

/**
 * Save picks to the Backup sheet
 * Columns: Timestamp, Week, Picker, Game, Away Team, Home Team, Away Spread, Home Spread,
 *          Line Pick, Winner Pick, Blazin, O/U Pick, O/U Line, Line Outcome, Winner Outcome, O/U Outcome
 */
/**
 * Append one row per pick.
 *
 * This is deliberately an append-only log, not an upsert. It was briefly
 * changed to upsert on week/picker/game to stop the sheet growing, then
 * reverted once the cost was actually measured: a 32-row read and a
 * 2,172-row read are indistinguishable through this API, because Google-side
 * variance (2.5s to 32s on the identical request) swamps anything the row
 * count contributes, on top of a ~2s fixed floor. Row count is not the
 * bottleneck at any size this sheet will reach for years.
 *
 * What the history buys, and the reason to keep paying for it: recovery from
 * a bad client write, visibility of two devices fighting over one week, and
 * forensics on pick-storage bugs - it is how three failed Blazin' attempts
 * were traced in September 2026.
 *
 * Growth is controlled on the client instead: an unchanged slate is not
 * re-sent, and the sync debounce collapses a burst of clicking into one
 * write. See CLAUDE.md.
 */
function savePicks(week, picker, picks) {
  if (!week || !picker) {
    return { error: 'Missing week or picker' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Backup');
  if (!sheet) {
    sheet = ss.insertSheet('Backup');
    sheet.appendRow(['Timestamp', 'Week', 'Picker', 'Game', 'Away Team', 'Home Team', 'Away Spread', 'Home Spread', 'Line Pick', 'Winner Pick', 'Blazin', 'O/U Pick', 'O/U Line', 'Line Outcome', 'Winner Outcome', 'O/U Outcome', 'Frozen At']);
    sheet.getRange(1, 1, 1, 17).setFontWeight('bold');
  } else {
    // Check if sheet needs migration (add columns if missing)
    const headers = sheet.getRange(1, 1, 1, 17).getValues()[0];
    if (headers[16] !== 'Frozen At') {
      // Column 17: the timestamp at which the picker froze this game's line.
      // Blank means the pick rides the line, which is the default.
      sheet.getRange(1, 17).setValue('Frozen At');
      sheet.getRange(1, 17).setFontWeight('bold');
    }
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
      '', // O/U Outcome - populated when results come in
      pick.frozenAt || ''
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
  const collapsed = {};

  for (let i = 1; i < data.length; i++) {
    const row = readPickRow(data[i]);
    if (row.week !== String(week) || row.picker !== picker) continue;
    const key = matchupKeyForRow(row);
    collapsed[key] = foldPickRow(collapsed[key], row);
  }

  const picks = {};
  for (const key in collapsed) {
    picks[key] = pickPayload(collapsed[key]);
  }

  return {
    week: week,
    picker: picker,
    picks: picks,
    count: Object.keys(picks).length,
    cleared: isClearedForWeek(week, picker)
  };
}

/**
 * Get ALL picks for all weeks and all pickers in one call
 * Returns: { picks: { week: { picker: { gameId: pickData } } }, cleared: { week: { picker: true } } }
 */
function getAllPicks(season) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Backup');

  const allPicks = {};
  const allCleared = {};
  let rowsScanned = 0;
  let rowsUsed = 0;

  if (sheet) {
    const data = sheet.getDataRange().getValues();
    const collapsed = {};

    for (let i = 1; i < data.length; i++) {
      rowsScanned++;
      const row = readPickRow(data[i]);
      if (season && seasonOfSheetWeek(row.week) !== season) continue;
      rowsUsed++;

      if (!collapsed[row.week]) collapsed[row.week] = {};
      if (!collapsed[row.week][row.picker]) collapsed[row.week][row.picker] = {};

      const key = matchupKeyForRow(row);
      const bucket = collapsed[row.week][row.picker];
      bucket[key] = foldPickRow(bucket[key], row);
    }

    for (const week in collapsed) {
      allPicks[week] = {};
      for (const picker in collapsed[week]) {
        allPicks[week][picker] = {};
        for (const key in collapsed[week][picker]) {
          allPicks[week][picker][key] = pickPayload(collapsed[week][picker][key]);
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
      if (season && seasonOfSheetWeek(week) !== season) continue;
      if (cleared) {
        if (!allCleared[week]) allCleared[week] = {};
        allCleared[week][picker] = true;
      }
    }
  }

  return {
    picks: allPicks,
    cleared: allCleared,
    weekCount: Object.keys(allPicks).length,
    season: season || 'all',
    rowsScanned: rowsScanned,
    rowsUsed: rowsUsed
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

      // A frozen row was graded at its own line, not the game's current one, so
      // score it against the spread stored on the row itself.
      let rowSpread = spread;
      let rowFavorite = favorite;
      if (!isBlankCell(backupData[i][16])) {
        const frozenLine = lineFromRow(readPickRow(backupData[i]));
        if (frozenLine) {
          rowSpread = frozenLine.spread;
          rowFavorite = frozenLine.favorite;
        }
      }

      let lineOutcome = '';
      let winnerOutcome = '';
      let ouOutcome = '';

      // Calculate Line (ATS) outcome
      if (linePick && rowSpread) {
        const atsWinner = calculateATSWinner(rowSpread, rowFavorite, result, awayTeam, homeTeam);
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

/**
 * Backup sheet diagnostics. Read-only - changes nothing.
 *
 * Answers two questions the collapsed read cannot:
 *   1. How big is the sheet really? getDataRange() pulls all of it on every
 *      read, so this is the number that decides when to split by season.
 *   2. Are there legacy split-key rows - a numeric Game value carrying a
 *      Blazin' flag, whose partner row holds the line pick? Those are the
 *      rows whose stars used to be dropped on read.
 */
function diagnoseBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Backup');
  if (!sheet) return { error: 'No Backup sheet' };

  const data = sheet.getDataRange().getValues();
  const bySeason = {};
  const splitKeyBlazin = [];
  let numericGameRows = 0;

  for (let i = 1; i < data.length; i++) {
    const row = readPickRow(data[i]);
    const season = seasonOfSheetWeek(row.week);
    bySeason[season] = (bySeason[season] || 0) + 1;

    // A Game column holding a bare number is a pre-matchup-key row.
    if (/^\d+$/.test(row.gameId)) {
      numericGameRows++;
      if (row.blazin) {
        splitKeyBlazin.push({
          week: row.week,
          picker: row.picker,
          game: row.gameId,
          matchup: matchupKeyForRow(row),
          hadLinePick: !isBlankCell(row.linePick),
          timestamp: data[i][0]
        });
      }
    }
  }

  return {
    totalRows: data.length - 1,
    columns: data[0] ? data[0].length : 0,
    cellsUsed: (data.length - 1) * (data[0] ? data[0].length : 0),
    rowsBySeason: bySeason,
    numericGameRows: numericGameRows,
    // Rows whose Blazin flag was being dropped: a numeric Game value, a star,
    // and no line pick of their own (the partner row has it).
    orphanedBlazinRows: splitKeyBlazin.filter(function (r) { return !r.hadLinePick; }),
    orphanedBlazinCount: splitKeyBlazin.filter(function (r) { return !r.hadLinePick; }).length
  };
}
