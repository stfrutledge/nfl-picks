/**
 * Cloudflare Worker - Odds API Proxy
 *
 * This worker proxies requests to The Odds API, keeping the API key secret.
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
 */

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Get the API key from environment variable
    const apiKey = env.ODDS_API_KEY;
    if (!apiKey) {
      return new Response('API key not configured', { status: 500 });
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

      // Get the response body
      const data = await response.text();

      // Forward relevant headers
      const headers = new Headers({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });

      // Pass through rate limit headers if available
      const remaining = response.headers.get('x-requests-remaining');
      const used = response.headers.get('x-requests-used');
      if (remaining) headers.set('x-requests-remaining', remaining);
      if (used) headers.set('x-requests-used', used);

      return new Response(data, {
        status: response.status,
        headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
