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

const GAME_DAY_CACHE_HOURS = 4;      // Fresher odds on game days
const NON_GAME_DAY_CACHE_HOURS = 12; // Longer cache when no games

function isGameDay() {
  const day = new Date().getUTCDay();
  // 0=Sun, 1=Mon, 4=Thu, 5=Fri, 6=Sat
  return day === 0 || day === 1 || day === 4 || day === 5 || day === 6;
}

function getCacheDurationMs() {
  const hours = isGameDay() ? GAME_DAY_CACHE_HOURS : NON_GAME_DAY_CACHE_HOURS;
  return hours * 60 * 60 * 1000;
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
      // Add header to indicate cache hit
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Cache', 'HIT');
      headers.set('X-Cache-Duration', isGameDay() ? `${GAME_DAY_CACHE_HOURS}h (game day)` : `${NON_GAME_DAY_CACHE_HOURS}h (non-game day)`);
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  const oddsApiUrl = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/');
  oddsApiUrl.searchParams.set('apiKey', apiKey);
  oddsApiUrl.searchParams.set('regions', 'us');
  oddsApiUrl.searchParams.set('markets', 'spreads,h2h,totals');
  oddsApiUrl.searchParams.set('oddsFormat', 'american');
  oddsApiUrl.searchParams.set('bookmakers', 'draftkings,fanduel');

  const response = await fetch(oddsApiUrl.toString());
  const data = await response.text();

  const headers = new Headers({
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
    'X-Cache': 'MISS',
    'X-Cache-Duration': isGameDay() ? `${GAME_DAY_CACHE_HOURS}h (game day)` : `${NON_GAME_DAY_CACHE_HOURS}h (non-game day)`,
  });

  // Pass through rate limit headers
  const remaining = response.headers.get('x-requests-remaining');
  const used = response.headers.get('x-requests-used');
  if (remaining) headers.set('x-requests-remaining', remaining);
  if (used) headers.set('x-requests-used', used);

  // Create the response
  const newResponse = new Response(data, { status: response.status, headers });

  // Cache the response (only cache successful responses)
  if (response.status === 200) {
    const cacheSeconds = getCacheDurationMs() / 1000;
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
