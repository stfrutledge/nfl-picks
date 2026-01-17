/**
 * Cloudflare Worker - Odds API Proxy with Server-Side Caching
 *
 * This worker proxies requests to The Odds API, keeping the API key secret.
 * It caches responses so multiple users share the same cached data.
 *
 * Deployment:
 * 1. Go to https://dash.cloudflare.com
 * 2. Workers & Pages → Create Application → Create Worker
 * 3. Name it "odds-proxy" (or similar)
 * 4. Replace the default code with this file's contents
 * 5. Go to Settings → Variables → Add Environment Variable:
 *    - Name: ODDS_API_KEY
 *    - Value: your API key
 *    - Check "Encrypt"
 * 6. Deploy and note the URL (e.g., odds-proxy.yourname.workers.dev)
 *
 * Cache behavior:
 * - Game days (Thu/Fri/Sat/Sun/Mon): 4 hour cache
 * - Non-game days (Tue/Wed): 12 hour cache
 * - All users share the same cache, minimizing API calls
 */

const CACHE_KEY = 'nfl-odds-cache';
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
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // Get the API key from environment variable
    const apiKey = env.ODDS_API_KEY;
    if (!apiKey) {
      return new Response('API key not configured', { status: 500, headers: corsHeaders });
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

    // Build the Odds API URL
    const oddsApiUrl = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/');
    oddsApiUrl.searchParams.set('apiKey', apiKey);
    oddsApiUrl.searchParams.set('regions', 'us');
    oddsApiUrl.searchParams.set('markets', 'spreads,h2h,totals');
    oddsApiUrl.searchParams.set('oddsFormat', 'american');
    oddsApiUrl.searchParams.set('bookmakers', 'draftkings,fanduel');

    try {
      // Fetch from The Odds API
      const response = await fetch(oddsApiUrl.toString());
      const data = await response.text();

      // Build response headers
      const headers = new Headers({
        'Content-Type': 'application/json',
        ...corsHeaders,
        'X-Cache': 'MISS',
        'X-Cache-Duration': isGameDay() ? `${GAME_DAY_CACHE_HOURS}h (game day)` : `${NON_GAME_DAY_CACHE_HOURS}h (non-game day)`,
      });

      // Pass through rate limit headers if available
      const remaining = response.headers.get('x-requests-remaining');
      const used = response.headers.get('x-requests-used');
      if (remaining) headers.set('x-requests-remaining', remaining);
      if (used) headers.set('x-requests-used', used);

      // Create the response
      const newResponse = new Response(data, {
        status: response.status,
        headers,
      });

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
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};
