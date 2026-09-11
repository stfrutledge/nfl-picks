/**
 * Cloudflare Worker - NFL Picks Dashboard Proxy with Server-Side Caching
 *
 * Handles all external API calls to avoid CORS issues:
 * - /odds - Proxy The Odds API (hides API key) with caching
 * - /sheets - Proxy Google Sheets CSV exports
 * - /sync - Proxy Google Apps Script for picks backup
 *
 * Deployment:
 * 1. Go to https://dash.cloudflare.com
 * 2. Workers & Pages → Create Application → Create Worker
 * 3. Name it "nfl-picks-proxy" (or update existing odds-proxy)
 * 4. Replace the default code with this file's contents
 * 5. Go to Settings → Variables → Add Environment Variables:
 *    - ODDS_API_KEY: your Odds API key (encrypt)
 *    - APPS_SCRIPT_URL: your Google Apps Script deployment URL
 * 6. Deploy and note the URL (e.g., nfl-picks-proxy.yourname.workers.dev)
 *
 * Cache behavior for /odds:
 * - Game days (Thu/Fri/Sat/Sun/Mon): 4 hour cache
 * - Non-game days (Tue/Wed): 12 hour cache
 * - All users share the same cache, minimizing API calls
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Fallback cache windows, used only when the Odds API does not tell us how much
// quota is left. Normally the pacer below decides.
const GAME_DAY_CACHE_HOURS = 4;      // Fresher odds on game days
const NON_GAME_DAY_CACHE_HOURS = 12; // Longer cache when no games

// Bounds on the paced window. The floor stops it hammering the API just because
// there is budget spare; the ceiling stops odds going stale for more than a day
// even when budget is nearly gone.
const MIN_CACHE_HOURS = 2;
const MAX_CACHE_HOURS = 24;

// Non-game days get a longer window, so spare budget is spent on Sunday rather
// than Tuesday.
const QUIET_DAY_MULTIPLIER = 2;

function isGameDay(now = new Date()) {
  const day = now.getUTCDay();
  // 0=Sun, 1=Mon, 4=Thu, 5=Fri, 6=Sat
  return day === 0 || day === 1 || day === 4 || day === 5 || day === 6;
}

/** Whole days left in the current UTC month, including today. Never below 1. */
function daysLeftInMonth(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.max(1, daysInMonth - now.getUTCDate() + 1);
}

/**
 * How long to cache the odds, paced against the quota that is actually left.
 *
 * The Odds API bills per market per region, and returns the remaining balance on
 * every response - so at the moment we cache a result we know both what it cost
 * and what is left. Spreading the remainder evenly over the days left in the
 * month gives a daily budget, and dividing that by the per-fetch cost gives how
 * many refreshes a day we can afford. The cache window is simply the gap between
 * them.
 *
 * Self-correcting, and needs no storage: flush early in the month it refreshes
 * often, nearly out it stretches to the reset, and when the quota resets on the
 * 1st the next fetch sees the new balance and speeds up again.
 *
 * @param {string|null} remainingHeader x-requests-remaining from the API
 * @param {number} creditsPerFetch markets x regions for the request we make
 * @param {Date} [now] injectable clock, for tests
 * @returns {{ms: number, reason: string}}
 */
function pacedCacheDuration(remainingHeader, creditsPerFetch, now = new Date()) {
  const remaining = Number(remainingHeader);

  // No usable reading: fall back to the fixed windows rather than guess.
  if (!remainingHeader || !isFinite(remaining) || remaining < 0) {
    const hours = isGameDay(now) ? GAME_DAY_CACHE_HOURS : NON_GAME_DAY_CACHE_HOURS;
    return { ms: hours * 3600 * 1000, reason: `${hours}h (fixed - no quota header)` };
  }

  const days = daysLeftInMonth(now);
  const cost = Math.max(1, creditsPerFetch);
  const fetchesPerDay = (remaining / days) / cost;

  // Out of budget entirely - sit on what we have until the reset.
  if (fetchesPerDay <= 0) {
    return { ms: MAX_CACHE_HOURS * 3600 * 1000, reason: `${MAX_CACHE_HOURS}h (quota exhausted)` };
  }

  let hours = 24 / fetchesPerDay;
  if (!isGameDay(now)) hours *= QUIET_DAY_MULTIPLIER;
  hours = Math.min(MAX_CACHE_HOURS, Math.max(MIN_CACHE_HOURS, hours));

  const rounded = Math.round(hours * 10) / 10;
  return {
    ms: hours * 3600 * 1000,
    reason: `${rounded}h (paced: ${remaining} credits over ${days}d at ${cost}/fetch)`
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // Route based on path
      if (path === '/odds' || path === '/') {
        return await handleOdds(request, env, ctx);
      } else if (path === '/sheets') {
        return await handleSheets(request, url);
      } else if (path === '/sync') {
        return await handleSync(request, env);
      } else {
        return jsonResponse({ error: 'Unknown endpoint', path }, 404);
      }
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};

/**
 * Proxy The Odds API - keeps API key secret, with server-side caching
 */
async function handleOdds(request, env, ctx) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'ODDS_API_KEY not configured' }, 500);
  }

  // Check URL for force refresh parameter
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  // Try to get cached response from Cloudflare Cache API
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.delete('refresh'); // Normalize cache key
  const cacheKey = new Request(cacheUrl.toString(), request);

  if (!forceRefresh) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // Add header to indicate cache hit. X-Cache-Duration is left as stored:
      // it records the window this entry was actually given, which is what the
      // pacer decided at fetch time. Recomputing it here would report a window
      // that never applied.
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  const oddsApiUrl = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/');
  oddsApiUrl.searchParams.set('apiKey', apiKey);
  // The Odds API bills per market per region, so the cost of a call is simply
  // how many of each we ask for. Derived rather than hardcoded, so the pacer
  // stays correct if these ever change.
  const regions = 'us';
  const markets = 'spreads,h2h,totals';
  const creditsPerFetch = markets.split(',').length * regions.split(',').length;

  oddsApiUrl.searchParams.set('regions', regions);
  oddsApiUrl.searchParams.set('markets', markets);
  oddsApiUrl.searchParams.set('oddsFormat', 'american');
  oddsApiUrl.searchParams.set('bookmakers', 'draftkings,fanduel');

  const response = await fetch(oddsApiUrl.toString());
  const data = await response.text();

  // Pass through the quota headers, and use them to decide how long this result
  // should live. This is the one moment we know both the balance and the cost.
  const remaining = response.headers.get('x-requests-remaining');
  const used = response.headers.get('x-requests-used');
  const paced = pacedCacheDuration(remaining, creditsPerFetch);

  const headers = new Headers({
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
    'X-Cache': 'MISS',
    'X-Cache-Duration': paced.reason,
  });

  if (remaining) headers.set('x-requests-remaining', remaining);
  if (used) headers.set('x-requests-used', used);
  headers.set('x-credits-per-fetch', String(creditsPerFetch));

  // Create the response
  const newResponse = new Response(data, { status: response.status, headers });

  // Cache the response (only cache successful responses)
  if (response.status === 200) {
    const cacheSeconds = Math.round(paced.ms / 1000);
    const responseToCache = new Response(data, {
      status: response.status,
      headers: {
        ...Object.fromEntries(headers),
        'Cache-Control': `public, max-age=${cacheSeconds}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, responseToCache));
  }

  return newResponse;
}

/**
 * Proxy Google Sheets CSV exports - avoids CORS issues
 */
async function handleSheets(request, url) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const sheetsUrl = url.searchParams.get('url');
  if (!sheetsUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400);
  }

  // Validate it's a Google Sheets URL
  if (!sheetsUrl.includes('docs.google.com/spreadsheets')) {
    return jsonResponse({ error: 'Invalid Google Sheets URL' }, 400);
  }

  const response = await fetch(sheetsUrl);
  const data = await response.text();

  return new Response(data, {
    status: response.status,
    headers: {
      'Content-Type': 'text/csv',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Proxy Google Apps Script for picks/spreads sync
 * GET: Fetch spreads or picks from Google Sheets
 * POST: Save picks and/or spreads to Google Sheets
 */
async function handleSync(request, env) {
  const appsScriptUrl = env.APPS_SCRIPT_URL;
  if (!appsScriptUrl) {
    return jsonResponse({ error: 'APPS_SCRIPT_URL not configured' }, 500);
  }

  if (request.method === 'GET') {
    // Forward GET request with query params to Apps Script
    const url = new URL(request.url);
    const targetUrl = new URL(appsScriptUrl);

    // Copy all query parameters
    for (const [key, value] of url.searchParams) {
      targetUrl.searchParams.set(key, value);
    }

    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
    });

    const data = await response.text();

    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    });
  }

  if (request.method === 'POST') {
    // Forward the request body to Apps Script
    const body = await request.text();

    const response = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });

    const data = await response.text();

    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
