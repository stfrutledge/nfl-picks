/**
 * Cloudflare Worker - NFL Picks Dashboard Proxy
 *
 * Handles all external API calls to avoid CORS issues:
 * - /odds - Proxy The Odds API (hides API key)
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
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

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
        return await handleOdds(request, env);
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
 * Proxy The Odds API - keeps API key secret
 */
async function handleOdds(request, env) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'ODDS_API_KEY not configured' }, 500);
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
  });

  // Pass through rate limit headers
  const remaining = response.headers.get('x-requests-remaining');
  const used = response.headers.get('x-requests-used');
  if (remaining) headers.set('x-requests-remaining', remaining);
  if (used) headers.set('x-requests-used', used);

  return new Response(data, { status: response.status, headers });
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
 */
async function handleSync(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const appsScriptUrl = env.APPS_SCRIPT_URL;
  if (!appsScriptUrl) {
    return jsonResponse({ error: 'APPS_SCRIPT_URL not configured' }, 500);
  }

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
