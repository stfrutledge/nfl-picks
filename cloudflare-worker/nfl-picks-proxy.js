/**
 * Cloudflare Worker - NFL Picks Dashboard Proxy with Server-Side Caching
 *
 * Handles all external API calls to avoid CORS issues:
 * - /odds - Proxy The Odds API (hides API key) with caching
 * - /sheets - Proxy Google Sheets CSV exports
 * - /sync - Proxy Google Apps Script for picks backup
 * - /espn - ESPN's NFL scoreboard, cached, with CORS (browsers stopped getting it)
 * - /notify - Push a message to every phone with the Android app (admin only)
 * - scheduled (cron, every 15 min) - automatic Blazin' 5 results and pick reminders
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

// A cross-origin page can only read the CORS-safelisted response headers unless
// the rest are named here. Without it the quota headers reach the browser but
// `response.headers.get()` returns null, so the admin credits readout stays empty.
const ODDS_EXPOSE_HEADERS =
  'x-requests-remaining, x-requests-used, x-credits-per-fetch, X-Cache, X-Cache-Duration';

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

/**
 * The one cache key every odds request shares.
 *
 * The client only ever asks for a bare `/odds`, so nothing about the incoming
 * URL may reach the key. It used to be the full request URL, which meant any
 * made-up query string (`/odds?x=1`, `?x=2`, ...) was a fresh cache miss - three
 * real credits each, for anyone who could read the worker's address out of
 * app.js. The same went for `?refresh=true`, which skipped the cache outright
 * and has been removed: nothing in the client sends it.
 */
function oddsCacheKey(requestUrl) {
  return new Request(`${new URL(requestUrl).origin}/odds`);
}

/**
 * Is this a Google Sheets address, by its actual host?
 *
 * The old test was `includes('docs.google.com/spreadsheets')`, which any URL can
 * satisfy by carrying the phrase in its path or query - so
 * `https://anything.example/?docs.google.com/spreadsheets` made this worker an
 * open proxy, handing back whatever it fetched with `Access-Control-Allow-Origin: *`.
 */
function isGoogleSheetsUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && parsed.hostname === 'docs.google.com'
    && parsed.pathname.startsWith('/spreadsheets/');
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
      if (path === '/odds') {
        return await handleOdds(request, env, ctx);
      } else if (path === '/sheets') {
        return await handleSheets(request, url);
      } else if (path === '/sync') {
        return await handleSync(request, env, ctx);
      } else if (path === '/espn') {
        return await handleEspn(request, url, ctx);
      } else if (path === '/splits') {
        return await handleSplits(request, url, ctx);
      } else if (path === '/lines') {
        return await handleLines(request, url, env);
      } else if (path === '/espn-summary') {
        return await handleEspnSummary(request, url, ctx);
      } else if (path === '/notify') {
        return await handleNotify(request, env);
      } else if (path === '/reminder-check') {
        return await handleReminderCheck(url, env);
      } else if (path.startsWith('/admin/picks/')) {
        return await handleAdminPicks(request, url, env);
      } else {
        return jsonResponse({ error: 'Unknown endpoint', path }, 404);
      }
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },

  // The cron trigger: automatic notifications. See runAutomations().
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomations(env).then(
      result => {
        console.log('[automations]', JSON.stringify(result));
        return trackHealth(env, result.espnError ? `ESPN: ${result.espnError} (ran on the saved schedule)` : null);
      },
      error => {
        console.error('[automations] failed:', error.message);
        return trackHealth(env, error.message);
      }).catch(error => console.error('[health] failed:', error.message)));
    // The picks database's queues, checks and warnings. Its own chain: a D1
    // problem is not a notifications problem.
    ctx.waitUntil(runPicksDbMaintenance(env).then(
      result => console.log('[d1]', JSON.stringify(result)),
      error => console.error('[d1] maintenance failed:', error.message)));
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

  // Try to get cached response from Cloudflare Cache API
  const cache = caches.default;
  const cacheKey = oddsCacheKey(request.url);

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    // Add header to indicate cache hit. X-Cache-Duration is left as stored:
    // it records the window this entry was actually given, which is what the
    // pacer decided at fetch time. Recomputing it here would report a window
    // that never applied.
    const headers = new Headers(cachedResponse.headers);
    headers.set('X-Cache', 'HIT');
    // Set here as well as on the miss: entries cached before this header
    // existed are still served until they expire.
    headers.set('Access-Control-Expose-Headers', ODDS_EXPOSE_HEADERS);
    return new Response(cachedResponse.body, {
      status: cachedResponse.status,
      headers,
    });
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
    'Access-Control-Expose-Headers': ODDS_EXPOSE_HEADERS,
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

  if (!isGoogleSheetsUrl(sheetsUrl)) {
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
 * A /sync POST with any line for a game that has kicked off taken out. The
 * sheet's line for a started game is the one its riding picks are graded at,
 * and a page left open since before a line move sends its stale copy with the
 * next refresh: Bengals -6.5 at kickoff became -7 at 2:43pm (October 2026).
 * The site stopped sending them, but a page still running the old script does
 * not know that. Regular-season weeks only ("2026_5"); anything else, or no
 * answer from ESPN, goes through as it came.
 *
 * Returns { body } to forward, or { skip } - the reply to send instead -
 * when nothing is left to write.
 */
async function withoutKickedOffLines(body) {
  let data;
  try { data = JSON.parse(body); } catch { return { body }; }
  const spreads = data?.spreads;
  const week = String(data?.week || '').match(/^(\d{4})_(\d+)$/);
  if (!spreads || typeof spreads !== 'object' || !week || Number(week[2]) > 18) return { body };

  let board;
  try {
    board = await fetchScoreboard({ season: week[1], week: week[2] });
  } catch {
    return { body };
  }
  const started = new Set(board.games.filter(g => g.state !== 'pre').map(g => g.key));
  const open = Object.fromEntries(
    Object.entries(spreads).filter(([key]) => !started.has(normalizeKey(key))));
  if (Object.keys(open).length === Object.keys(spreads).length) return { body };

  const rest = { ...data };
  if (Object.keys(open).length) rest.spreads = open;
  else delete rest.spreads;
  const left = ['picks', 'results', 'cleared'].some(k => rest[k] !== undefined);
  if (!rest.spreads && !left) {
    return { skip: { success: true, results: { spreads: { message: 'Every game has kicked off; lines kept' } } } };
  }
  return { body: JSON.stringify(rest) };
}

/**
 * Proxy Google Apps Script for picks/spreads sync
 * GET: Fetch spreads or picks from Google Sheets
 * POST: Save picks and/or spreads to Google Sheets
 */
async function handleSync(request, env, ctx) {
  const appsScriptUrl = env.APPS_SCRIPT_URL;
  if (!appsScriptUrl) {
    return jsonResponse({ error: 'APPS_SCRIPT_URL not configured' }, 500);
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    // The raw Backup log (every pick change, with its time) is for the admin
    // import alone, which reads it server-side: not through the public route.
    if (url.searchParams.get('action') === 'backuprows') {
      return jsonResponse({ error: 'Not available here' }, 404);
    }
    // Picks from D1 once the switch is on; anything else, or D1 refusing,
    // goes to the sheet as before.
    const fromD1 = await syncGetFromD1(env, url.searchParams);
    if (fromD1) return fromD1;

    // Forward GET request with query params to Apps Script
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
    // The write is finished even if the page that sent it has gone. A page
    // sends its last picks as it is hidden, and an app swiped away drops the
    // connection a moment later - while the Apps Script is still taking its
    // 2-8s. Cloudflare cancels a request's work when its client disconnects;
    // waitUntil keeps this running to the end. A page that is still there
    // waits for the real reply as before, so a failure is still retried.
    //
    // With D1 bound, a save of picks lands there first and is answered in
    // milliseconds; the sheet gets its copy in the background (syncPostWithD1).
    // The site sends text/plain to skip the CORS preflight; the body is JSON
    // either way, and the Apps Script is always told it is.
    const body = await request.text();
    const work = syncPostWithD1(env, ctx, body).then(viaD1 => viaD1 || forwardSyncPost(env, body));
    ctx?.waitUntil?.(work.catch(() => {}));
    return await work;
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

/** Forward a /sync POST body to the Apps Script and pass its reply back. */
async function forwardSyncPost(env, rawBody) {
  const appsScriptUrl = env.APPS_SCRIPT_URL;
  let body = rawBody;
  const guarded = await withoutKickedOffLines(body);
  if (guarded.skip) return jsonResponse(guarded.skip);
  body = guarded.body;

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
// ---------------------------------------------------------------------------
// /notify - a message from the admin to every phone with the Android app.
// ---------------------------------------------------------------------------

/** The FCM topic every copy of the app subscribes to. */
const GROUP_TOPIC = 'group';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_TITLE = 100;
const MAX_BODY = 1000;
/** The kinds of notification the app knows (its Category ids). */
const NOTIFY_CATEGORIES = ['blazin_results', 'pick_reminders', 'messages'];

/**
 * POST { title, body } with `Authorization: Bearer <NOTIFY_SECRET>`, and it is
 * sent to the group topic through Firebase Cloud Messaging.
 *
 * The secret is the only thing between the public internet and a push to
 * everybody's phone, so it is checked before anything else is read, and the
 * Firebase credentials (FCM_SERVICE_ACCOUNT, the service account's whole JSON
 * key) never leave the worker. The secret lives on the admin's phone only,
 * typed into the app's Settings - it is not in the APK, which goes to everyone.
 */
async function handleNotify(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!env.NOTIFY_SECRET || !env.FCM_SERVICE_ACCOUNT) {
    return jsonResponse({ error: 'Notifications are not configured' }, 500);
  }

  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await secretsMatch(given, env.NOTIFY_SECRET))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  // A preview: the real Blazin' 5 result or pick reminder for this week, built
  // from the real picks, lines and scores by the same code the schedule uses,
  // sent to the asking phone only.
  if (typeof payload?.token === 'string' && payload.token.trim() && PREVIEWS.includes(payload?.preview)) {
    return handlePreview(env, payload.token.trim(), payload.preview);
  }

  const title = String(payload?.title ?? '').trim().slice(0, MAX_TITLE) || 'NFL Picks';
  const body = String(payload?.body ?? '').trim();
  if (!body && !(payload?.personal && payload?.token)) return jsonResponse({ error: 'Message is empty' }, 400);
  if (body.length > MAX_BODY) return jsonResponse({ error: `Message is over ${MAX_BODY} characters` }, 400);

  // A test from Admin Settings goes to the admin's own phone (its FCM token)
  // rather than the group, and may be any category, with the extra fields a
  // real one carries - so spoilers, reminders and quiet hours can be tried on
  // demand. The secret is still required: a token alone sends nothing.
  const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
  if (token.length > 4096) return jsonResponse({ error: 'Bad token' }, 400);
  const category = token && NOTIFY_CATEGORIES.includes(payload?.category) ? payload.category : 'messages';
  const extra = {};
  if (token) {
    for (const field of ['spoilerTitle', 'spoilerBody']) {
      if (typeof payload?.[field] === 'string') extra[field] = payload[field].slice(0, MAX_BODY);
    }
    if (payload?.personal && typeof payload.personal === 'object') {
      extra.personal = Object.fromEntries(Object.entries(payload.personal)
        .filter(([, v]) => typeof v === 'string').map(([k, v]) => [String(k).slice(0, 40), v.slice(0, MAX_BODY)]));
    }
  }

  const sent = await sendToGroup(env, {
    category,
    title,
    body,
    id: `${token ? 'test' : 'msg'}-${Date.now()}`,
    ...extra,
  }, { token: token || null });
  if (!sent.ok) return jsonResponse({ error: sent.error, detail: sent.detail }, sent.status || 502);
  return jsonResponse({ ok: true, name: sent.name });
}

/**
 * Send to every phone on the group topic, as a data-only message.
 *
 * Data-only on purpose: the system never draws it, so each phone decides for
 * itself (the app's Delivery.decide) whether that category is switched on,
 * whether it is meant for its picker, whether to hide scores, and whether to
 * hold it until that person's quiet hours end, in their own time zone. A
 * notification payload would be drawn by the system the moment it landed,
 * 4am in Ireland included.
 *
 * `data`: { category, title, body, id, spoilerTitle?, spoilerBody?,
 * personal? (object), expiresAt? (ms) } - all sent as strings, as FCM requires.
 *
 * `token` sends to that one phone instead (Admin Settings' tests).
 *
 * Returns { ok, name } or { ok: false, status, error, detail }.
 */
async function sendToGroup(env, data, { token = null } = {}) {
  let account;
  try {
    account = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  } catch (e) {
    return { ok: false, status: 500, error: 'FCM_SERVICE_ACCOUNT is not valid JSON' };
  }

  const strings = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    strings[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  const accessToken = await googleAccessToken(account);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          // One phone for a test, the whole group otherwise.
          ...(token ? { token } : { topic: GROUP_TOPIC }),
          data: strings,
          // High priority wakes the app at once to decide, even in Doze.
          android: { priority: 'HIGH' },
        },
      }),
    });

  if (!response.ok) {
    const detail = await response.text();
    return { ok: false, status: 502, error: `FCM answered ${response.status}`, detail: detail.slice(0, 500) };
  }
  const sent = await response.json();
  return { ok: true, name: sent.name };
}

/**
 * Compare two secrets without the time taken saying how much of a guess was
 * right: both are hashed, and the fixed-length digests compared in full.
 */
async function secretsMatch(given, expected) {
  if (!given) return false;
  const digest = async s => new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// An OAuth token lasts an hour; one isolate can reuse it for every message
// sent in that time rather than signing a new one each send.
let cachedGoogleToken = null;

/**
 * An OAuth access token for the service account, from a JWT signed with its
 * private key (the service-account flow; there is no Google SDK in a worker).
 */
async function googleAccessToken(account, now = Date.now()) {
  if (cachedGoogleToken && cachedGoogleToken.account === account.client_email
      && cachedGoogleToken.expires > now + 60_000) {
    return cachedGoogleToken.token;
  }

  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const jwt = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    { iss: account.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 },
    account.private_key);

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const data = await response.json();
  cachedGoogleToken = {
    account: account.client_email,
    token: data.access_token,
    expires: now + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

function base64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(header, claims, privateKeyPem) {
  const encode = obj => base64Url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${encode(header)}.${encode(claims)}`;

  const der = Uint8Array.from(
    atob(privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')),
    c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Automatic notifications - run every 15 minutes by a Cloudflare cron trigger.
// ---------------------------------------------------------------------------
//
// Two kinds, both sent to the whole group through sendToGroup():
//
//   blazin_results   when every starred game of the week is final
//   pick_reminders   to whoever still has picks to make: noon (Irish time) on
//                    the day of a midweek opener, naming the game and its line;
//                    3 hours before the weekend's first kickoff; and a "Last
//                    chance" 30 minutes before it
//
// Each phone then decides whether to show it (categories, quiet hours,
// spoilers - the app's Delivery.decide). Each is sent once: the NOTIFY_STATE
// KV namespace records what has gone out.
//
// The worker grades Blazin' 5 picks itself, because nothing else is running
// when the last game ends. It is a copy of the site's rule (atsWinnerForPick ->
// calculateATSWinnerFrom), kept small on purpose; test-worker-automations.js
// fails if it ever disagrees with the site's engine.

const NFL_PICKERS = ['Daniel', 'Dylan', 'Jason', 'Sean', 'Stephen'];
const COWHERD_PICKER = 'Cowherd';
const BLAZIN_PER_WEEK = 5;
const REMINDER_LEAD_MS = 3 * 60 * 60 * 1000;
const LAST_CHANCE_LEAD_MS = 30 * 60 * 1000;
const SENT_TTL_SECONDS = 60 * 60 * 24 * 60;   // forget a week's flags after 60 days

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
// The same scoreboard on ESPN's other host, tried when the first refuses.
const ESPN_SCOREBOARD_FALLBACK = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
// A bare fetch sends no User-Agent. From October 2026 ESPN answered the cron's
// requests 403 (cron runs land in other data centres than a visitor's
// requests, which kept working), and the Thursday reminder never went out.
const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * The scoreboard for [search] ("?week=6..." or ""), from either ESPN host.
 * Returns the last response, ok or not, so callers keep their own handling.
 */
async function fetchEspn(search = '') {
  let response;
  for (const base of [ESPN_SCOREBOARD, ESPN_SCOREBOARD_FALLBACK]) {
    response = await fetch(base + search, { headers: ESPN_HEADERS });
    if (response.ok) return response;
    console.warn(`[espn] ${new URL(base).host} answered ${response.status}`);
  }
  return response;
}

// The site's alias map (TEAM_NAME_MAP), so keys built here match the picks'.
const TEAM_ALIASES = {
  buccs: 'buccaneers', bucs: 'buccaneers', tb: 'buccaneers', nyj: 'jets', jax: 'jaguars',
  cle: 'browns', chi: 'bears', buf: 'bills', ne: 'patriots', bal: 'ravens', cin: 'bengals',
  ari: 'cardinals', hou: 'texans', lv: 'raiders', phi: 'eagles', lac: 'chargers', kc: 'chiefs',
  wsh: 'commanders', nyg: 'giants', ind: 'colts', sea: 'seahawks', ten: 'titans', sf: '49ers',
  gb: 'packers', den: 'broncos', det: 'lions', lar: 'rams', car: 'panthers', no: 'saints',
  min: 'vikings', dal: 'cowboys', mia: 'dolphins', pit: 'steelers', atl: 'falcons'
};

/** "Kansas City Chiefs" -> "Chiefs": the nickname the site keys games by. */
function teamNickname(displayName) {
  const name = String(displayName || '').trim();
  const parts = name.split(' ');
  return parts[parts.length - 1];
}

function normalizeTeam(name) {
  const lower = String(name || '').trim().toLowerCase();
  return TEAM_ALIASES[lower] || lower;
}

/** "away_home", as the site's pickKey() builds it. */
function matchupKey(away, home) {
  return `${normalizeTeam(away)}_${normalizeTeam(home)}`;
}

function normalizeKey(rawKey) {
  const parts = String(rawKey).split('_');
  return parts.length === 2 ? matchupKey(parts[0], parts[1]) : String(rawKey);
}

/** The current week's games from ESPN's scoreboard. */
/** The current week, or with `week` a past regular-season week of `season`. */
async function fetchScoreboard({ season, week } = {}) {
  const url = new URL(ESPN_SCOREBOARD);
  if (week) {
    url.searchParams.set('dates', season);
    url.searchParams.set('seasontype', '2');
    url.searchParams.set('week', week);
  }
  const response = await fetchEspn(url.search);
  if (!response.ok) throw new Error(`ESPN answered ${response.status}`);
  const data = await response.json();
  const games = (data.events || []).map(event => {
    const comp = event.competitions?.[0] || {};
    const side = homeAway => comp.competitors?.find(c => c.homeAway === homeAway) || {};
    const away = teamNickname(side('away').team?.displayName);
    const home = teamNickname(side('home').team?.displayName);
    const status = event.status?.type || {};
    return {
      key: matchupKey(away, home),
      away, home,
      kickoff: Date.parse(event.date),
      state: status.state || (status.completed ? 'post' : 'pre'),   // pre | in | post
      final: Boolean(status.completed),
      awayScore: Number(side('away').score) || 0,
      homeScore: Number(side('home').score) || 0,
      odds: espnOdds(comp),
    };
  });
  return {
    season: data.season?.year,
    seasonType: data.season?.type,      // 2 = regular season
    week: data.week?.number,
    games,
  };
}

/**
 * A read from the Apps Script. Its doGet answers its own failures with HTTP 200
 * and an {error} body, so an ok status is not enough: read as picks, that body
 * is nobody having picked anything, which would remind everyone of every game
 * and mark the reminder sent. Throwing instead leaves the cron to try again on
 * its next run, and /reminder-check to answer 500 (the phone then shows the
 * reminder as it was).
 */
async function appsScriptGet(env, params) {
  const url = new URL(env.APPS_SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Apps Script answered ${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error(`Apps Script error: ${data.error}`);
  return data;
}

/** Every week's picks this season, per week number then picker, keyed like the site's. */
async function fetchSeasonPicks(env, season) {
  const data = await readSeasonPicks(env, season);
  const byWeek = {};
  for (const [sheetWeek, raw] of Object.entries(data.picks || {})) {
    const match = String(sheetWeek).match(/^(\d{4})_(\d+)$/);
    if (!match || Number(match[1]) !== Number(season)) continue;
    const picks = {};
    for (const [picker, games] of Object.entries(raw || {})) {
      picks[picker] = {};
      for (const [key, pick] of Object.entries(games)) picks[picker][normalizeKey(key)] = pick;
    }
    byWeek[Number(match[2])] = picks;
  }
  return byWeek;
}

/**
 * Each picker's Blazin' 5 record for the season through [week]: the earlier
 * weeks graded from the Results and Spreads tabs, this one from [current]
 * (already graded off ESPN). The Results tab is what the site scores from, so
 * the percentage matches the Standings tab's Blazin' 5 column.
 *
 * One allresults call, plus one spreads call per earlier week that has a star
 * in it, in parallel. Null when the sheet cannot be read - the notification
 * then goes out with the week's record alone rather than not at all.
 */
async function seasonBlazinRecords(env, season, week, seasonPicks, current) {
  try {
    const earlier = Object.keys(seasonPicks).map(Number)
      .filter(w => w < week && Object.values(seasonPicks[w]).some(mine =>
        Object.values(mine || {}).some(p => p.blazin && p.line)));
    const totals = {};
    for (const picker of [...NFL_PICKERS, COWHERD_PICKER]) {
      const r = current[picker] || {};
      totals[picker] = { wins: r.wins || 0, losses: r.losses || 0, pushes: r.pushes || 0 };
    }
    if (earlier.length === 0) return totals;

    const [results, ...spreads] = await Promise.all([
      appsScriptGet(env, { action: 'allresults' }),
      ...earlier.map(w => fetchWeekSpreads(env, season, w)),
    ]);
    earlier.forEach((w, i) => {
      const games = Object.entries(results.results?.[`${season}_${w}`] || {}).map(([key, r]) => ({
        key: normalizeKey(key), final: true,
        awayScore: Number(r.awayScore) || 0, homeScore: Number(r.homeScore) || 0,
      }));
      const graded = gradeBlazin(games, seasonPicks[w], spreads[i]);
      for (const [picker, r] of Object.entries(graded)) {
        totals[picker].wins += r.wins;
        totals[picker].losses += r.losses;
        totals[picker].pushes += r.pushes;
      }
    });
    return totals;
  } catch (error) {
    console.error('[automations] season Blazin record failed:', error.message);
    return null;
  }
}

/** One week's lines from the Spreads tab, keyed like the site's. */
async function fetchWeekSpreads(env, season, week) {
  const data = await appsScriptGet(env, { action: 'spreads', week: `${season}_${week}` });
  const spreads = {};
  for (const [key, line] of Object.entries(data.spreads || {})) spreads[normalizeKey(key)] = line;
  return spreads;
}

function hasUsableLine(raw) {
  if (raw === null || raw === undefined || raw === '') return false;
  return Number.isFinite(Number(raw));
}

/** The line a pick is graded at: its own frozen one, or the week's. */
function lineForPick(pick, weekLine) {
  if (pick.frozenAt) return { spread: pick.frozenSpread, favorite: pick.frozenFavorite };
  return weekLine ? { spread: weekLine.spread, favorite: weekLine.favorite } : null;
}

/** calculateATSWinnerFrom: the underdog gets the points. */
function atsWinner(spread, favorite, awayScore, homeScore) {
  const away = awayScore + (favorite === 'away' ? 0 : spread);
  const home = homeScore + (favorite === 'home' ? 0 : spread);
  return away > home ? 'away' : home > away ? 'home' : 'push';
}

/** Each picker's Blazin' 5 record on the week's final games. */
function gradeBlazin(games, picks, spreads) {
  const byKey = Object.fromEntries(games.map(g => [g.key, g]));
  const records = {};
  for (const picker of [...NFL_PICKERS, COWHERD_PICKER]) {
    const record = { wins: 0, losses: 0, pushes: 0, starred: 0 };
    for (const [key, pick] of Object.entries(picks[picker] || {})) {
      if (!pick.blazin || !pick.line) continue;
      record.starred++;
      const game = byKey[key];
      const line = lineForPick(pick, spreads[key]);
      if (!game?.final || !line || !hasUsableLine(line.spread)) continue;
      const ats = atsWinner(Number(line.spread), line.favorite, game.awayScore, game.homeScore);
      if (ats === 'push') record.pushes++;
      else if (ats === pick.line) record.wins++;
      else record.losses++;
    }
    records[picker] = record;
  }
  return records;
}

/**
 * Whether the week's Blazin' 5 is settled: at least one star, every starred
 * game final, and nobody still able to add a star - five placed, or no game
 * left to kick off.
 */
function blazinSettled(games, picks) {
  const starredKeys = new Set();
  for (const picker of [...NFL_PICKERS, COWHERD_PICKER]) {
    for (const [key, pick] of Object.entries(picks[picker] || {})) {
      if (pick.blazin && pick.line) starredKeys.add(key);
    }
  }
  if (starredKeys.size === 0) return false;
  const byKey = Object.fromEntries(games.map(g => [g.key, g]));
  if ([...starredKeys].some(key => !byKey[key]?.final)) return false;
  const gamesLeft = games.some(g => g.state === 'pre');
  if (!gamesLeft) return true;
  return NFL_PICKERS.every(picker =>
    Object.values(picks[picker] || {}).filter(p => p.blazin && p.line).length >= BLAZIN_PER_WEEK);
}

function formatBlazinRecord({ wins, losses, pushes }) {
  return `${wins}-${losses}${pushes ? `-${pushes}` : ''}`;
}

/** The site's Blazin' 5 %: wins over decided picks, pushes left out. Null with none decided. */
function blazinPercent({ wins, losses }) {
  return wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(1)}%` : null;
}

/**
 * One picker's own result: their week and their season so far, and a pointer
 * to the site for everyone else's. [season] is null when the season record
 * could not be read, and the line is then left out.
 */
function personalBlazinLine(week, season) {
  const parts = [week.starred > 0
    ? `You went ${formatBlazinRecord(week)} this week.`
    : 'You had no Blazin’ 5 picks this week.'];
  if (season && season.wins + season.losses + season.pushes > 0) {
    const pct = blazinPercent(season);
    parts.push(`Season: ${formatBlazinRecord(season)}${pct ? ` (${pct})` : ''}.`);
  }
  parts.push('See the site for everyone’s results.');
  return parts.join(' ');
}

/**
 * The week's results. Each phone shows only its own picker's line (personal);
 * body keeps the whole group's, best first: what a phone with no picker chosen
 * shows, and what the tests check the worker grades as the site does with.
 * `week` tells the app where a tap should land.
 */
function blazinMessage(season, week, records, seasonRecords = null) {
  const ranked = NFL_PICKERS
    .filter(p => records[p].starred > 0)
    .sort((a, b) => (records[b].wins - records[b].losses) - (records[a].wins - records[a].losses)
      || records[b].wins - records[a].wins || a.localeCompare(b));
  const cowherd = records[COWHERD_PICKER];
  const line = ranked.map(p => `${p} ${formatBlazinRecord(records[p])}`).join(', ')
    + (cowherd?.starred ? `. Cowherd ${formatBlazinRecord(cowherd)}.` : '.');
  const personal = Object.fromEntries(NFL_PICKERS.map(p =>
    [p, personalBlazinLine(records[p], seasonRecords?.[p] || null)]));
  return {
    category: 'blazin_results',
    id: `blazin-${season}-${week}`,
    week,
    title: `Blazin’ 5 Results - Week ${week}`,
    body: line,
    personal,
    spoilerTitle: `Blazin’ 5 Results - Week ${week}`,
    spoilerBody: 'Results are in. Open the app to see how everyone did.',
  };
}

/** The weekday a kickoff falls on in New York: 'Thu', 'Sun'... */
function easternWeekday(ms) {
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
}

const WEEKDAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/**
 * The week's reminder moments: its first kickoff (usually Thursday night), and
 * the first kickoff of the weekend slate after that - usually Sunday's early
 * games, Saturday's late in the season - twice: 3 hours before, and a last
 * chance 30 minutes before.
 */
function reminderSlates(games) {
  const upcoming = [...games].sort((a, b) => a.kickoff - b.kickoff);
  if (upcoming.length === 0) return [];
  const isWeekend = g => ['Fri', 'Sat', 'Sun'].includes(easternWeekday(g.kickoff));
  const slates = [];
  // A week that opens before the weekend (Thursday night) gets a reminder for
  // that game alone at noon, Irish time, on the day - well ahead of an 8:15pm
  // ET kickoff, which is past 1am in Ireland. Then the weekend's first kickoff
  // gets the one full reminder, 3 hours before.
  const first = upcoming[0];
  if (!isWeekend(first)) {
    const day = easternWeekday(first.kickoff);
    let sendAt = noonInIreland(first.kickoff);
    // An opener that kicks off before (or near) Irish noon - none do today -
    // falls back to the usual 3 hours before.
    if (sendAt > first.kickoff - 60 * 60 * 1000) sendAt = first.kickoff - REMINDER_LEAD_MS;
    slates.push({ kind: 'first', kickoff: first.kickoff, day, sendAt });
  }
  const weekend = upcoming.find(isWeekend);
  if (weekend) {
    const day = easternWeekday(weekend.kickoff);
    slates.push({ kind: 'weekend', kickoff: weekend.kickoff, day, sendAt: weekend.kickoff - REMINDER_LEAD_MS });
    slates.push({ kind: 'last', kickoff: weekend.kickoff, day, sendAt: weekend.kickoff - LAST_CHANCE_LEAD_MS });
  }
  return slates;
}

/** Where most of the group is; the opener's reminder goes out at noon here. */
const GROUP_TIME_ZONE = 'Europe/Dublin';

/**
 * Noon in Ireland on the US calendar day of [kickoffMs] - Thursday for
 * Thursday Night Football, though it is past midnight in Ireland by kickoff.
 * Worked out through Intl, so Irish and US clock changes are both handled.
 */
function noonInIreland(kickoffMs) {
  const [y, m, d] = new Date(kickoffMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    .split('-').map(Number);
  return wallClockToUtc(y, m, d, 12, 0, GROUP_TIME_ZONE);
}

/** The instant a wall clock in [timeZone] reads y-m-d h:min. */
function wallClockToUtc(y, m, d, h, min, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute));
  return guess - (shown - guess);
}

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Bills @ Chiefs (Chiefs -3.5)", or without the line when the sheet has none. */
function describeMatchup(game, line) {
  const matchup = `${game.away} @ ${game.home}`;
  if (!line || !hasUsableLine(line.spread)) return matchup;
  const spread = Math.abs(Number(line.spread));
  if (spread === 0) return `${matchup} (Pick’em)`;
  return `${matchup} (${line.favorite === 'away' ? game.away : game.home} -${spread})`;
}

/** The hour on a New York clock: a kickoff from 5pm ET is "tonight". */
function easternHour(ms) {
  return Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
}

/**
 * The opener's title: "Game tonight: Bills @ Chiefs (Chiefs -3)". A day with
 * more than one game (Thanksgiving) lists them all.
 */
function openerTitle(dayGames, spreads) {
  const described = dayGames.map(g => describeMatchup(g, spreads[g.key])).join(' · ');
  if (dayGames.length > 1) return `Games today: ${described}`;
  return `Game ${easternHour(dayGames[0].kickoff) >= 17 ? 'tonight' : 'today'}: ${described}`;
}

/**
 * A reminder before [slate]: for each picker with picks still to make on games
 * not yet started, their own sentence. Null when everyone is done.
 */
function reminderMessage(season, week, slate, games, picks, regularSeason, spreads = {}) {
  // Before the opener, only its own day's games are about to lock; before the
  // weekend (both of its reminders), everything left - and the Blazin' stars,
  // which need placing before the games they go on.
  const opener = slate.kind === 'first';
  const open = games.filter(g => g.state === 'pre' && g.kickoff >= slate.kickoff
    && (!opener || easternWeekday(g.kickoff) === slate.day));
  const personal = {};
  for (const picker of NFL_PICKERS) {
    const mine = picks[picker] || {};
    const unpicked = open.filter(g => !(mine[g.key]?.line && mine[g.key]?.winner));
    const stars = Object.values(mine).filter(p => p.blazin && p.line).length;
    const starsLeft = regularSeason && !opener && open.length > 0
      ? Math.max(0, BLAZIN_PER_WEEK - stars) : 0;
    if (unpicked.length === 0 && starsLeft === 0) continue;

    if (opener) {
      personal[picker] = unpicked.length === 1 ? 'Make your pick now.' : 'Make your picks now.';
      continue;
    }
    const todo = [];
    if (unpicked.length) todo.push(`${plural(unpicked.length, 'game')} to pick`);
    if (starsLeft) todo.push(`${plural(starsLeft, 'Blazin’ 5 pick')} to make`);
    personal[picker] = `You still have ${todo.join(' and ')}.`;
  }
  if (Object.keys(personal).length === 0) return null;

  const day = WEEKDAY_NAMES[slate.day] || 'the first';
  const title = opener ? openerTitle(open, spreads)
    : slate.kind === 'last' ? `Last chance: ${day} kickoff in 30 minutes`
    : `${day} kickoff in 3 hours`;
  return {
    category: 'pick_reminders',
    id: `reminder-${season}-${week}-${slate.kind}`,
    week,
    title,
    // For a phone with no picker chosen: who still has picks to make.
    body: `Still to pick: ${Object.keys(personal).join(', ')}.`,
    personal,
    expiresAt: slate.kickoff,
  };
}

/**
 * GET /reminder-check?id=reminder-2026-5-weekend&picker=Stephen
 *
 * A pick reminder held through a phone's quiet hours is shown hours after it
 * was written, by which time the picks may well be in - October 2026: picks
 * made before 8am, then "you still have picks to make" at 8am. The app asks
 * this as it releases one: the same reminder rebuilt for that picker from the
 * sheet as it stands now.
 *
 * { remind: true, body } - still something to do, worded for now.
 * { remind: false }      - nothing left, or the slate has kicked off.
 *
 * Read-only and unauthenticated: it says no more than the site already shows
 * anyone. Any failure is an error status, and the app then shows the reminder
 * as it was rather than losing it.
 */
async function handleReminderCheck(url, env) {
  const match = String(url.searchParams.get('id') || '').match(/^reminder-(\d{4})-(\d+)-(first|weekend|last)$/);
  const picker = url.searchParams.get('picker') || '';
  if (!match || !NFL_PICKERS.includes(picker)) return jsonResponse({ error: 'Bad request' }, 400);
  if (!env.APPS_SCRIPT_URL) return jsonResponse({ error: 'Not configured' }, 503);
  const [season, week, kind] = [Number(match[1]), Number(match[2]), match[3]];

  // The reminder's own week is the current one until well after its kickoff,
  // which is when the phone drops it anyway (expiresAt).
  const board = await fetchScoreboard();
  if (board.season !== season || board.week !== week) return jsonResponse({ remind: false });
  const slate = reminderSlates(board.games).find(s => s.kind === kind);
  if (!slate || Date.now() >= slate.kickoff) return jsonResponse({ remind: false });

  // One picker's week, not the season: this runs on a phone's clock.
  const data = await readWeekPicks(env, `${season}_${week}`, picker);
  const mine = {};
  for (const [key, pick] of Object.entries(data.picks || {})) mine[normalizeKey(key)] = pick;

  const message = reminderMessage(season, week, slate, board.games, { [picker]: mine }, board.seasonType === 2);
  const body = message?.personal?.[picker];
  return jsonResponse(body ? { remind: true, body } : { remind: false });
}

// The week's schedule as of the last run that reached ESPN, for a run it refuses.
const BOARD_KEY = 'board:current';
const BOARD_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const BOARD_REFRESH_MS = 24 * 60 * 60 * 1000;
// Failing runs are recorded here; the admin hears about it after an hour.
const HEALTH_KEY = 'automations:failing';
const ALERT_AFTER_MS = 60 * 60 * 1000;
const ADMIN_PICKER = 'Stephen';

/** The parts of a board that say when the games are, which is all a saved one is trusted for. */
function scheduleSignature({ season, seasonType, week, games }) {
  return JSON.stringify([season, seasonType, week, games.map(g => [g.key, g.kickoff])]);
}

/**
 * The scoreboard for a cron run. A run that reaches ESPN saves the week's
 * schedule (only when it changes, or once a day); a run ESPN refuses carries
 * on with that schedule, as `espnError` says. October 2026: ESPN answered the
 * cron 403 all Thursday morning and the opener's reminder never went out.
 *
 * A saved schedule has no scores and stale states, so a game counts as under
 * way once its kickoff has passed and none is final: reminders go on time,
 * and Blazin' 5 results wait for ESPN.
 */
async function scoreboardForAutomations(env, now) {
  const saved = JSON.parse(await env.NOTIFY_STATE.get(BOARD_KEY) || 'null');
  let board;
  try {
    board = await fetchScoreboard();
  } catch (error) {
    if (!saved || now - saved.savedAt > BOARD_MAX_AGE_MS) throw error;
    return {
      ...saved,
      games: saved.games.map(g => ({
        ...g, state: g.kickoff <= now ? 'in' : 'pre', final: false, awayScore: 0, homeScore: 0,
      })),
      espnError: error.message,
    };
  }
  const usable = board.season && board.week && board.games.length > 0;
  if (usable && (!saved || now - saved.savedAt > BOARD_REFRESH_MS
      || scheduleSignature(saved) !== scheduleSignature(board))) {
    const { season, seasonType, week } = board;
    const games = board.games.map(({ key, away, home, kickoff }) => ({ key, away, home, kickoff }));
    await env.NOTIFY_STATE.put(BOARD_KEY, JSON.stringify({ savedAt: now, season, seasonType, week, games }));
  }
  return board;
}

/**
 * After each cron run: [problem] is why it failed (or ran on the saved
 * schedule), null for a clean run. An hour of problems sends the admin one
 * alert, and the first clean run after that says so. Nobody else sees
 * either: only the admin's picker has a line, and the empty group text means
 * a phone with no picker drops it (Delivery.decide).
 */
async function trackHealth(env, problem, now = Date.now()) {
  if (!env.NOTIFY_STATE || !env.FCM_SERVICE_ACCOUNT) return;
  const state = JSON.parse(await env.NOTIFY_STATE.get(HEALTH_KEY) || 'null');
  const minutes = state ? Math.round((now - state.since) / 60000) : 0;
  if (!problem) {
    if (!state) return;
    await env.NOTIFY_STATE.delete(HEALTH_KEY);
    if (state.alerted) await alertAdmin(env, now, 'Notifications working again', `Back to normal after ${minutes} minutes.`);
    return;
  }
  const next = { since: state?.since ?? now, lastError: problem, alerted: Boolean(state?.alerted) };
  if (!next.alerted && now - next.since >= ALERT_AFTER_MS) {
    const sent = await alertAdmin(env, now, 'Notifications failing',
      `Every run for ${minutes} minutes: ${problem}. Check the worker's Observability tab.`);
    next.alerted = sent.ok;
  }
  await env.NOTIFY_STATE.put(HEALTH_KEY, JSON.stringify(next));
}

function alertAdmin(env, now, title, text) {
  return sendToGroup(env, { category: 'messages', id: `health-${now}`, title, body: '', personal: { [ADMIN_PICKER]: text } });
}

async function alreadySent(env, id) {
  return Boolean(await env.NOTIFY_STATE.get(`sent:${id}`));
}

async function markSent(env, id) {
  await env.NOTIFY_STATE.put(`sent:${id}`, new Date().toISOString(), { expirationTtl: SENT_TTL_SECONDS });
}

/**
 * One run of the schedule. Fetches the picks only when something could be
 * due, so a quiet Tuesday costs one ESPN call and a couple of KV reads.
 * Returns what it did, for the logs and the tests.
 */
async function runAutomations(env, now = Date.now()) {
  if (!env.NOTIFY_STATE || !env.FCM_SERVICE_ACCOUNT || !env.APPS_SCRIPT_URL) {
    return { skipped: 'not configured' };
  }
  const board = await scoreboardForAutomations(env, now);
  const { season, week, games } = board;
  if (!season || !week || games.length === 0) return { skipped: 'no games' };
  const regularSeason = board.seasonType === 2;
  const done = [];
  // Betting splits to the sheet. Its own errors, reported in the result and
  // kept out of trackHealth: a splits problem is not a notifications problem.
  const splits = await recordFinalSplits(env, board, now).catch(error => ({ error: error.message }));
  // The spread and total through the week: the same terms as the splits.
  const lines = await recordLineMoves(env, board, now).catch(error => ({ error: error.message }));
  // Said in every result, so the logs and trackHealth know ESPN refused.
  const degraded = board.espnError ? { espnError: board.espnError } : {};

  // What could be due on this run, before paying for the sheet.
  const blazinId = `blazin-${season}-${week}`;
  // A non-starred game still being played (Monday night) must not hold up
  // results that are already settled, so this only waits for a final game.
  const blazinCandidate = regularSeason && games.some(g => g.final)
    && !(await alreadySent(env, blazinId));

  const dueSlates = [];
  for (const slate of reminderSlates(games)) {
    if (now < slate.sendAt || now >= slate.kickoff) continue;
    if (!(await alreadySent(env, `reminder-${season}-${week}-${slate.kind}`))) dueSlates.push(slate);
  }
  // The 3-hour reminder missed (the worker down) and the last chance due: one
  // reminder half an hour out, not two in the same minute.
  if (dueSlates.some(s => s.kind === 'last')) {
    const missed = dueSlates.findIndex(s => s.kind === 'weekend');
    if (missed >= 0) dueSlates.splice(missed, 1);
  }

  if (!blazinCandidate && dueSlates.length === 0) return { season, week, done, splits, lines, ...degraded };

  const seasonPicks = await fetchSeasonPicks(env, season);
  const picks = seasonPicks[week] || {};

  if (blazinCandidate && blazinSettled(games, picks)) {
    const spreads = await fetchWeekSpreads(env, season, week);
    const records = gradeBlazin(games, picks, spreads);
    const seasonRecords = await seasonBlazinRecords(env, season, week, seasonPicks, records);
    const message = blazinMessage(season, week, records, seasonRecords);
    const sent = await sendToGroup(env, message);
    if (sent.ok) { await markSent(env, blazinId); done.push(blazinId); }
  }

  // The opener's reminder names its line. No line on the sheet yet, or the
  // sheet not answering, still sends it, without the number.
  const spreads = dueSlates.some(s => s.kind === 'first')
    ? await fetchWeekSpreads(env, season, week).catch(() => ({})) : {};

  for (const slate of dueSlates) {
    const id = `reminder-${season}-${week}-${slate.kind}`;
    const message = reminderMessage(season, week, slate, games, picks, regularSeason, spreads);
    // Nobody to remind is still "done": the moment has passed for this slate.
    if (!message) { await markSent(env, id); done.push(`${id} (nobody to remind)`); continue; }
    const sent = await sendToGroup(env, message);
    if (sent.ok) { await markSent(env, id); done.push(id); }
  }

  return { season, week, done, splits, lines, ...degraded };
}

/**
 * ESPN's NFL scoreboard, passed through with CORS.
 *
 * The site used to fetch it straight from the browser. From early October
 * 2026 ESPN's edge stopped sending Access-Control-Allow-Origin to browsers
 * (it still does to anything else), so every schedule and live-score fetch
 * failed and the standings stopped at the weeks a phone had already cached.
 * The worker is not a browser, so it gets the data; it adds the header.
 *
 * Only the scoreboard, and only its seasontype / week / dates parameters, so
 * this cannot be used as an open proxy. Cached at the edge: 20 seconds for the
 * current scoreboard (live scores, polled every 30s by every open page) and
 * 5 minutes for a given week's schedule.
 */
const ESPN_PARAMS = ['seasontype', 'week', 'dates'];

async function handleEspn(request, url, ctx) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const upstream = new URL(ESPN_SCOREBOARD);
  for (const name of ESPN_PARAMS) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    if (!/^\d{1,4}$/.test(value)) return jsonResponse({ error: `Bad ${name}` }, 400);
    upstream.searchParams.set(name, value);
  }

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/espn${upstream.search}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await fetchEspn(upstream.search);
  if (!response.ok) return jsonResponse({ error: `ESPN answered ${response.status}` }, 502);
  const body = await response.text();
  const seconds = upstream.searchParams.has('week') ? 300 : 20;
  const out = new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${seconds}`,
      ...CORS_HEADERS,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// ---------------------------------------------------------------------------
// /splits - public betting splits on the spread: Action Network, DraftKings
// and Circa.
//
// None has an official API. Action Network's site reads a JSON scoreboard
// with its consensus splits (an aggregate across books it does not name);
// DraftKings publishes its own splits as a page on DK Network; Circa's are
// republished by VSiN. DK and VSiN are plain HTML. All are read here and
// cached for five minutes (VSiN's own update cycle). Action Network's terms
// forbid automated access; this is a private group's site, and that was a
// deliberate choice (October 2026). DraftKings alone is thin early in the
// week - one big bet can be 90% of its handle - which is why the consensus
// is there. Circa is the sharps' book: where its money and tickets disagree
// is the thing worth seeing.
//
// The site shows them on the pick cards. The cron keeps each game's last
// numbers before kickoff and writes them to the Splits tab, so a later
// feature can ask how teams carrying 70% of the money did against the spread.
// ---------------------------------------------------------------------------

const DK_SPLITS_URL = 'https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/';
const DK_NFL_EVENT_GROUP = '88808';
const DK_MAX_PAGES = 5;
const DK_PAGE_SIZE = 10;
const CIRCA_SPLITS_URL = 'https://data.vsin.com/betting-splits/?source=CIRCA&sport=NFL';
// The consensus is the same whichever book is asked for; one keeps the reply small.
const AN_SCOREBOARD_URL = 'https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=15&periods=event';
const SPLITS_CACHE_SECONDS = 300;
const SPLITS_HEADERS = {
  'User-Agent': ESPN_HEADERS['User-Agent'],
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Markup to text, one space between everything. Comments go first: DK leaves markup in them. */
function htmlText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/−/g, '-')          // DK prints odds with a real minus sign
    .replace(/\s+/g, ' ');
}

/**
 * The part of a page the splits are in: from `margin` before the first
 * `first` to `margin` after the last `last`, found with indexOf. The pages
 * are 200-350 KB of navigation and scripts around the tables, and the free
 * plan gives a request 10 ms of CPU: regexes over the whole page used most
 * of that. A page without the markers is returned whole, to parse as before.
 */
function splitsRegion(html, first, last, margin) {
  const start = html.indexOf(first);
  const end = html.lastIndexOf(last);
  if (start < 0 || end < 0) return html;
  return html.slice(Math.max(0, start - margin), Math.min(html.length, end + margin));
}

/** "-7.5" -> -7.5, "+3" -> 3, "PK" / "EVEN" -> 0; anything else null. */
function splitLine(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === 'PK' || text === 'EVEN' || text === 'PICK') return 0;
  const n = Number(text.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

const DK_GAME = /([A-Z]{2,3}) ([A-Za-z0-9]+) @ ([A-Z]{2,3}) ([A-Za-z0-9]+) (\d{1,2}\/\d{1,2}), (\d{1,2}:\d{2}[AP]M)/g;
const DK_SPREAD_SIDE = /[A-Z]{2,3} ([A-Za-z0-9]+) ([+-]?\d+(?:\.\d+)?|PK|pk|EVEN) [+-]?\d+ (\d{1,3})% (\d{1,3})%/g;

/**
 * One DK Network splits page: each game's spread, both sides, as
 * { key, away, home, sides: { away: {line, handle, bets}, home } }.
 * A game is a header ("WAS Commanders @ SF 49ers 10/19, 08:15PM") followed by
 * Moneyline, Spread and Total blocks; only the Spread block is read.
 */
function parseDkSplits(html) {
  const text = htmlText(splitsRegion(String(html), '% Handle', '% Bets', 8000));
  const heads = [...text.matchAll(DK_GAME)];
  const games = [];
  heads.forEach((head, i) => {
    const away = head[2], home = head[4];
    const block = text.slice(head.index + head[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const at = block.search(/Spread Odds % Handle % Bets/);
    if (at < 0) return;
    const spread = block.slice(at).split(/Total Odds % Handle % Bets/)[0];
    const sides = {};
    for (const m of spread.matchAll(DK_SPREAD_SIDE)) {
      const team = normalizeTeam(m[1]);
      const side = team === normalizeTeam(away) ? 'away' : team === normalizeTeam(home) ? 'home' : null;
      if (side && !sides[side]) {
        sides[side] = { line: splitLine(m[2]), handle: Number(m[3]), bets: Number(m[4]) };
      }
    }
    if (sides.away && sides.home) games.push({ key: matchupKey(away, home), away, home, sides });
  });
  return games;
}

/**
 * VSiN's splits table: rows in pairs, road team then home, each holding
 * spread line, handle, bets, then the total's and the moneyline's.
 */
function parseVsinSplits(html) {
  const table = splitsRegion(String(html), 'class="sp-row"', 'class="sp-row"', 4000);
  const rows = [...table.matchAll(/<tr class="sp-row">([\s\S]*?)<\/tr>/g)].map(m => {
    const team = (m[1].match(/class="sp-team-link"[^>]*>([^<]+)</) || [])[1];
    const badges = [...m[1].matchAll(/<span class="sp-badge[^"]*">([^<]*)</g)].map(b => b[1].trim());
    return { team: teamNickname(htmlText(team || '').trim()), badges };
  });
  const games = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const [road, home] = [rows[i], rows[i + 1]];
    if (!road.team || !home.team || road.badges.length < 3 || home.badges.length < 3) continue;
    const side = row => ({
      line: splitLine(row.badges[0]),
      handle: parseInt(row.badges[1], 10),
      bets: parseInt(row.badges[2], 10),
    });
    const sides = { away: side(road), home: side(home) };
    if ([sides.away, sides.home].some(s => !Number.isFinite(s.handle) || !Number.isFinite(s.bets))) continue;
    games.push({ key: matchupKey(road.team, home.team), away: road.team, home: home.team, sides });
  }
  return games;
}

/**
 * Action Network's scoreboard JSON: each game's spread outcomes carry a side
 * ("home"/"away"), the line, and bet_info.tickets / bet_info.money percents.
 */
function parseActionNetworkSplits(data) {
  return (data?.games || []).flatMap(g => {
    const team = id => g.teams?.find(t => t.id === id)?.display_name;
    const away = team(g.away_team_id), home = team(g.home_team_id);
    const spread = Object.values(g.markets || {})[0]?.event?.spread || [];
    const sides = {};
    for (const o of spread) {
      const bets = o.bet_info?.tickets?.percent, handle = o.bet_info?.money?.percent;
      if ((o.side === 'away' || o.side === 'home') && Number.isFinite(bets) && Number.isFinite(handle)) {
        sides[o.side] = { line: splitLine(o.value), handle, bets };
      }
    }
    // How many bets the percentages are drawn from: low early in the week,
    // which is when they swing. Shown beside them on the card.
    if (Number.isFinite(Number(g.num_bets)) && Number(g.num_bets) > 0) sides.count = Number(g.num_bets);
    return away && home && sides.away && sides.home ? [{ key: matchupKey(away, home), away, home, sides }] : [];
  });
}

async function fetchActionNetworkSplits() {
  const response = await fetch(AN_SCOREBOARD_URL, { headers: { ...SPLITS_HEADERS, 'Accept': 'application/json' } });
  if (!response.ok) throw new Error(`api.actionnetwork.com answered ${response.status}`);
  return parseActionNetworkSplits(await response.json());
}

async function fetchSplitsPage(url) {
  const response = await fetch(url, { headers: SPLITS_HEADERS });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.text();
}

/** Every NFL game on DK's pages for the next seven days. A page past the end repeats the last one. */
async function fetchDkSplits() {
  const byKey = new Map();
  for (let page = 1; page <= DK_MAX_PAGES; page++) {
    const url = new URL(DK_SPLITS_URL);
    url.searchParams.set('tb_eg', DK_NFL_EVENT_GROUP);
    url.searchParams.set('tb_edate', 'n7days');
    url.searchParams.set('tb_emt', '0');
    url.searchParams.set('tb_page', String(page));
    const games = parseDkSplits(await fetchSplitsPage(url.toString()));
    const fresh = games.filter(g => !byKey.has(g.key));
    fresh.forEach(g => byKey.set(g.key, g));
    // A short page is the last one; a repeat means the last was already read.
    if (fresh.length === 0 || games.length < DK_PAGE_SIZE) break;
  }
  return [...byKey.values()];
}

async function fetchCircaSplits() {
  return parseVsinSplits(await fetchSplitsPage(CIRCA_SPLITS_URL));
}

/**
 * Every book, merged per game: { updatedAt, errors, games: { key: { away,
 * home, an, dk, circa } } }, each book being { away: {line, handle, bets},
 * home } or absent. A book failing still returns the others.
 */
async function buildSplits(now = Date.now()) {
  const [an, dk, circa] = await Promise.allSettled([fetchActionNetworkSplits(), fetchDkSplits(), fetchCircaSplits()]);
  const games = {};
  const errors = {};
  const add = (book, result) => {
    if (result.status !== 'fulfilled') { errors[book] = result.reason?.message || String(result.reason); return; }
    for (const g of result.value) {
      games[g.key] ||= { away: g.away, home: g.home };
      games[g.key][book] = g.sides;
    }
  };
  add('an', an);
  add('dk', dk);
  add('circa', circa);
  return { updatedAt: new Date(now).toISOString(), errors, games };
}

/** The splits, from the edge cache when it is fresh: the site's requests and the cron share it. */
async function cachedSplits(origin, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/splits`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const splits = await buildSplits();
  // Nothing from either book is not worth five minutes of nothing.
  if (Object.keys(splits.games).length > 0) {
    const stored = new Response(JSON.stringify(splits), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${SPLITS_CACHE_SECONDS}` },
    });
    const put = cache.put(cacheKey, stored);
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return splits;
}

async function handleSplits(request, url, ctx) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
  const splits = await cachedSplits(url.origin, ctx);
  return new Response(JSON.stringify(splits), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${SPLITS_CACHE_SECONDS}`,
      ...CORS_HEADERS,
    },
  });
}

// The cron's half: the last numbers before kickoff, to the Splits tab.
const SPLITS_PENDING_KEY = 'splits:pending';
const SPLITS_WATCH_MS = 30 * 60 * 1000;          // start keeping a game's numbers this far out
const SPLITS_LAST_RUN_MS = 15 * 60 * 1000;       // the cron period: the run this close to kickoff is the last before it
const SPLITS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;  // an unwritten final waits this long (an Apps Script not redeployed yet)
const SPLITS_ORIGIN = 'https://nfl-picks-proxy.stfrutledge.workers.dev';

/** The site's week number for a board: 1-18 regular season, 19-22 playoffs. */
function siteWeekFor(board) {
  if (board.seasonType !== 3) return board.week;
  return Math.min(18 + board.week, 22);   // ESPN: 1 wild card ... 5 Super Bowl (4 is the Pro Bowl)
}

function splitsRow(entry) {
  const side = (book, s) => {
    const v = entry[book]?.[s];
    return v ? [v.line ?? '', v.handle, v.bets] : ['', '', ''];
  };
  return {
    week: `${entry.season}_${entry.week}`,
    gameKey: entry.key,
    away: entry.away,
    home: entry.home,
    kickoff: new Date(entry.kickoff).toISOString(),
    takenAt: entry.takenAt,
    dk: [...side('dk', 'away'), ...side('dk', 'home')],
    circa: [...side('circa', 'away'), ...side('circa', 'home')],
    an: [...side('an', 'away'), ...side('an', 'home')],
  };
}

async function appsScriptPost(env, payload) {
  const response = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Apps Script answered ${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error(`Apps Script error: ${data.error}`);
  return data;
}

/**
 * Each run: keep the latest splits for every game kicking off in the next
 * half hour, and write a game's to the sheet on the last run before its
 * kickoff - or on the first one after, if that run was missed. Its own
 * try/catch in the caller: a splits problem is not a notifications problem.
 */
async function recordFinalSplits(env, board, now = Date.now()) {
  if (!env.NOTIFY_STATE || !env.APPS_SCRIPT_URL) return { skipped: 'not configured' };
  const pending = JSON.parse(await env.NOTIFY_STATE.get(SPLITS_PENDING_KEY) || '{}');
  const before = JSON.stringify(pending);
  const week = siteWeekFor(board);

  const approaching = board.games.filter(g => g.kickoff > now && g.kickoff - now <= SPLITS_WATCH_MS);
  if (approaching.length > 0) {
    const splits = await cachedSplits(SPLITS_ORIGIN, null);
    for (const g of approaching) {
      const s = splits.games[g.key];
      if (!s || (!s.an && !s.dk && !s.circa)) continue;
      pending[g.key] = {
        key: g.key, season: board.season, week, away: g.away, home: g.home,
        kickoff: g.kickoff, takenAt: splits.updatedAt, an: s.an || null, dk: s.dk || null, circa: s.circa || null,
      };
    }
  }

  for (const [key, entry] of Object.entries(pending)) {
    if (now - entry.kickoff > SPLITS_KEEP_MS) delete pending[key];
  }

  const due = Object.values(pending).filter(e => e.kickoff - now <= SPLITS_LAST_RUN_MS);
  const written = [];
  let error = null;
  if (due.length > 0) {
    try {
      await appsScriptPost(env, { splits: due.map(splitsRow) });
      due.forEach(e => { delete pending[e.key]; written.push(e.key); });
    } catch (e) {
      error = e.message;   // kept in pending: the next run tries again
    }
  }

  if (JSON.stringify(pending) !== before) {
    await env.NOTIFY_STATE.put(SPLITS_PENDING_KEY, JSON.stringify(pending));
  }
  return { watching: Object.keys(pending).length, written, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// /lines - each game's spread and total through the week, as they moved.
//
// The cron reads the scoreboard every 15 minutes anyway, and ESPN's carries
// DraftKings' current spread and total, so a change is noticed within a run
// of it and costs no Odds API credit. A point is kept only when the spread or
// the total has moved, so a week is a few dozen points in one KV entry.
//
// **A week opens on Sunday night, by the group's rule**: its first point is
// the line on the first run after the previous week's last Sunday game has
// gone final - not ESPN's "open", a number with no time from whenever
// DraftKings first posted it (a lookahead line, often the week before).
// Nothing is kept for a week before then. A week whose Sunday night was
// missed - tracking began on a Tuesday, or the worker was down - starts with
// a "first seen" point instead, labelled as such, never as the open.
// ---------------------------------------------------------------------------

const LINES_TTL_SECONDS = 60 * 24 * 60 * 60;   // forget a week's history after 60 days
// The Sunday night game ends about 3.5 hours after kickoff; an open taken
// later than this after the last Sunday kickoff was not Sunday night's.
const OPEN_LATE_AFTER_MS = 6 * 60 * 60 * 1000;
// Weeks whose open the group agreed to take late, as "season:week": the line
// when tracking first saw it counts as the open. Only 2026 week 7, the week
// tracking began - on its Tuesday, which the owner judged close enough.
// Every other week opens on Sunday night or reads "first seen".
const OPENS_TAKEN_LATE = new Set(['2026:7']);

/**
 * DraftKings' current spread and total off a scoreboard competition, the
 * spread as ESPN prints it ("-3.5", "+3.5"); null with no spread.
 */
function espnOdds(comp) {
  const odds = comp?.odds?.[0];
  const ps = odds?.pointSpread;
  const away = ps?.away?.close?.line, home = ps?.home?.close?.line;
  if (!away || !home) return null;
  const total = parseFloat(String(odds?.total?.over?.close?.line || '').replace(/^[ou]/i, ''));
  return { away: String(away), home: String(home), total: Number.isFinite(total) ? total : null };
}

function linesKey(season, week) {
  return `lines:${season}:${week}`;
}

/** "Sun" for a kickoff in ET, the day the group's week turns on. */
function easternDay(ms) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/New_York' }).format(new Date(ms));
}

/**
 * The regular-season week after the board's, by number. ESPN's current
 * scoreboard stays on a finished week until midweek - on the Tuesday after
 * week 6's Monday game it was still week 6, every game over and its odds
 * gone - while next week's lines move most on Monday and Tuesday. Null after
 * week 18 and in the playoffs.
 */
async function nextWeekBoard(board) {
  if (board.seasonType !== 2 || !(board.week < 18)) return null;
  try {
    return await fetchScoreboard({ season: board.season, week: board.week + 1 });
  } catch {
    return null;
  }
}

/**
 * When a week opens, given the week before it: the first run once every
 * Sunday game of that week is final. Null until then. `late` when that run
 * is too long after the last Sunday kickoff to be Sunday night's.
 */
function weekOpening(previous, now) {
  const sundays = (previous?.games || []).filter(g => g.kickoff && easternDay(g.kickoff) === 'Sun');
  if (sundays.length === 0 || !sundays.every(g => g.state === 'post')) return null;
  const lastKickoff = Math.max(...sundays.map(g => g.kickoff));
  return { at: now, late: now - lastKickoff > OPEN_LATE_AFTER_MS };
}

/**
 * Each run: open the next week when its time has come, and add a point for
 * every game still to kick off whose spread or total differs from its last
 * one, on the current scoreboard and the next week's. Not on a run ESPN
 * refused - the saved schedule it falls back on carries no odds. Its own
 * try/catch in the caller, as the splits have.
 *
 * A KV entry is { open: { at, late }, games: { key: [points] } }; a point is
 * { at, away, home, total } with `kind: 'open' | 'first'` on a game's first.
 */
async function recordLineMoves(env, board, now = Date.now(), loadNext = nextWeekBoard) {
  if (!env.NOTIFY_STATE || board.espnError) return { skipped: board.espnError ? 'no ESPN' : 'not configured' };
  const next = await loadNext(board);
  // Each board with the week before it, which decides when it opens. The
  // current board has none to hand: by the time ESPN shows a week, its
  // Sunday night has passed, so an entry first made from it is "first seen".
  const weeks = [{ board, previous: null }];
  if (next?.games?.length) weeks.push({ board: next, previous: board });

  const moved = [];
  for (const { board: b, previous } of weeks) {
    const key = linesKey(b.season, siteWeekFor(b));
    const stored = JSON.parse(await env.NOTIFY_STATE.get(key) || 'null');
    const entry = stored?.games ? stored : { open: null, games: {} };
    let changed = false;
    if (!entry.open) {
      entry.open = previous ? weekOpening(previous, now) : { at: now, late: true };
      if (!entry.open) continue;   // not open yet: lookahead lines are not kept
      if (entry.open.late && OPENS_TAKEN_LATE.has(`${b.season}:${siteWeekFor(b)}`)) {
        entry.open = { at: now, late: false, agreed: true };
      }
      changed = true;
    }
    for (const game of b.games) {
      if (game.state !== 'pre' || !game.odds) continue;
      const points = entry.games[game.key] ||= [];
      const o = game.odds;
      const last = points[points.length - 1];
      if (!last || last.away !== o.away || last.home !== o.home || last.total !== o.total) {
        const point = { at: now, away: o.away, home: o.home, total: o.total };
        // A game's first point is the open only on the run that opened the week.
        if (!last) point.kind = !entry.open.late && entry.open.at === now ? 'open' : 'first';
        points.push(point);
        moved.push(game.key);
        changed = true;
      }
    }
    if (changed) {
      await env.NOTIFY_STATE.put(key, JSON.stringify(entry), { expirationTtl: LINES_TTL_SECONDS });
    }
  }
  // The site's lines, from the same read: its own errors, so a sheet that
  // will not take them does not stop the history being kept.
  const sheet = await syncSheetLines(env, weeks.map(w => w.board), now).catch(error => ({ error: error.message }));
  return { moved, sheet };
}

// ---------------------------------------------------------------------------
// The site's lines, written by the worker. The pick buttons read the sheet's
// Spreads tab; until October 2026 a phone filled it, the first visitor after
// it went stale (3 hours on a game day, a day otherwise) spending Odds API
// credits. DraftKings' line is already read here every 15 minutes for the
// history, so it is written straight to the sheet - the same number the
// charts show, at most a run behind, and no credits.
//
// The tab is rewritten at least every SHEET_LINES_REFRESH_MS even when
// nothing moved: a phone checks the tab's newest timestamp, and so long as
// it is fresh never asks the Odds API. If the worker stops - ESPN refusing,
// a broken deploy - the timestamp ages, and the phones' own refresh takes
// over exactly as it used to. That is the fallback; there is no other.
// ---------------------------------------------------------------------------

const SHEET_LINES_REFRESH_MS = 2 * 60 * 60 * 1000;   // under the phones' 3-hour game-day window

/** "-3.5" for the away side -> the sheet's { spread: 3.5, favorite: 'away' }. */
function sheetLine(odds) {
  const away = odds.away === 'PK' || odds.away === 'EVEN' ? 0 : parseFloat(odds.away);
  if (!Number.isFinite(away)) return null;
  return {
    spread: Math.abs(away),
    favorite: away < 0 ? 'away' : 'home',   // a pick'em keeps a side, as the site's own lines do
    overUnder: odds.total ?? '',
  };
}

/**
 * Write each board's lines - games still to kick off, with DraftKings odds -
 * to the Spreads tab, when they differ from what was last written or the
 * last write is SHEET_LINES_REFRESH_MS old. A game that has kicked off is
 * never written: its line is the one its riding picks are graded at.
 */
async function syncSheetLines(env, boards, now = Date.now()) {
  if (!env.NOTIFY_STATE || !env.APPS_SCRIPT_URL) return { skipped: 'not configured' };
  const written = [];
  for (const b of boards) {
    const week = `${b.season}_${siteWeekFor(b)}`;
    const spreads = {};
    for (const game of b.games) {
      if (game.state !== 'pre' || !game.odds || !(game.kickoff > now)) continue;
      const line = sheetLine(game.odds);
      if (line) spreads[game.key] = line;
    }
    if (Object.keys(spreads).length === 0) continue;
    const stateKey = `sheetLines:${week}`;
    const last = JSON.parse(await env.NOTIFY_STATE.get(stateKey) || 'null');
    const signature = JSON.stringify(spreads);
    if (last && last.signature === signature && now - last.at < SHEET_LINES_REFRESH_MS) continue;
    await appsScriptPost(env, { week, spreads });
    await env.NOTIFY_STATE.put(stateKey, JSON.stringify({ signature, at: now }), { expirationTtl: LINES_TTL_SECONDS });
    written.push(week);
  }
  return { written };
}

/** GET /lines?season=2026&week=7 - that week's history: when it opened, and each game's points. */
async function handleLines(request, url, env) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
  const season = url.searchParams.get('season'), week = url.searchParams.get('week');
  if (!/^\d{4}$/.test(season || '') || !/^\d{1,2}$/.test(week || '')) {
    return jsonResponse({ error: 'Give season=YYYY and week=N' }, 400);
  }
  if (!env.NOTIFY_STATE) return jsonResponse({ error: 'Not configured' }, 500);
  const stored = JSON.parse(await env.NOTIFY_STATE.get(linesKey(season, Number(week))) || 'null');
  return new Response(JSON.stringify({
    season: Number(season), week: Number(week), open: stored?.open || null, games: stored?.games || {},
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// /espn-summary?event=ID - one game's injuries, last five games and team
// leaders, for the site's Game Details (Players and Matchup tabs). ESPN's
// summary is ~110 KB of box score, news and more; only those three parts go
// to the phone. Cached 15 minutes: injury reports change through the week.
// ---------------------------------------------------------------------------

const ESPN_SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const ESPN_SUMMARY_FALLBACK = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const ESPN_TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';
const ESPN_TEAMS_FALLBACK = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams';
const SUMMARY_CACHE_SECONDS = 15 * 60;
const SUMMARY_LEADERS = ['passingYards', 'rushingYards', 'receivingYards'];

/** A headshot URL, only when it is ESPN's own image host; '' otherwise. */
function espnImage(href) {
  return typeof href === 'string' && href.startsWith('https://a.espncdn.com/') ? href : '';
}

/**
 * A team's whole injury list off its roster, for the popup's "Show all":
 * every player whose latest injury entry is not "Active", newest first. The
 * summary's own list (shown first) stops at five, which leaves long-term IR
 * players out (the 49ers had 25 listed, the summary 5). The roster gives no
 * injury type, so `detail` is taken from the summary where it names the player.
 */
function rosterInjuries(roster, detailByName) {
  return (roster?.athletes || []).flatMap(g => g.items || [])
    .map(a => ({ a, injury: (a.injuries || [])[0] }))
    .filter(({ injury }) => injury?.status && injury.status !== 'Active')
    .sort((x, y) => String(y.injury.date || '').localeCompare(String(x.injury.date || '')))
    .map(({ a, injury }) => ({
      name: a.displayName || '',
      pos: a.position?.abbreviation || '',
      status: injury.status,
      detail: detailByName.get(a.displayName) || '',
      headshot: espnImage(a.headshot?.href),
    }))
    .filter(p => p.name);
}

/**
 * The three parts the popup shows, each by team nickname (as the site keys
 * teams). `rosters` maps a team's display name to its ESPN roster; a team whose
 * roster could not be read keeps the summary's short list.
 */
function trimEspnSummary(data, rosters = {}) {
  const team = t => teamNickname(t?.displayName);
  const fromSummary = t => (t.injuries || []).map(i => ({
    name: i.athlete?.displayName || '',
    pos: i.athlete?.position?.abbreviation || '',
    status: i.status || '',
    detail: i.details?.type || '',
    headshot: espnImage(i.athlete?.headshot?.href),
  })).filter(p => p.name);
  const summaryTeams = (data?.injuries || []).map(t => ({ name: t.team?.displayName, players: fromSummary(t) }));
  const injuryTeams = [...new Set([...summaryTeams.map(t => t.name), ...Object.keys(rosters)])].filter(Boolean);
  return {
    injuries: injuryTeams.map(name => {
      const summary = summaryTeams.find(t => t.name === name)?.players || [];
      const details = new Map(summary.filter(p => p.detail).map(p => [p.name, p.detail]));
      // `players` is ESPN's own five, what the popup shows first (the
      // owner's choice); `all` the roster's whole list, behind "Show all".
      return {
        team: teamNickname(name),
        players: summary,
        all: rosters[name] ? rosterInjuries(rosters[name], details) : summary,
      };
    }),
    lastFive: (data?.lastFiveGames || []).map(t => ({
      team: team(t.team),
      games: (t.events || []).slice(0, 5).map(e => ({
        result: e.gameResult || '', atVs: e.atVs || '', opp: e.opponent?.abbreviation || '',
        score: e.score || '', date: e.gameDate || '', week: Number(e.week) || null,
      })),
    })),
    leaders: (data?.leaders || []).map(t => ({
      team: team(t.team),
      items: (t.leaders || []).filter(l => SUMMARY_LEADERS.includes(l.name)).map(l => ({
        label: l.displayName || '',
        name: l.leaders?.[0]?.athlete?.shortName || l.leaders?.[0]?.athlete?.displayName || '',
        pos: l.leaders?.[0]?.athlete?.position?.abbreviation || '',
        value: l.leaders?.[0]?.displayValue || '',
        headshot: espnImage(l.leaders?.[0]?.athlete?.headshot?.href),
      })).filter(x => x.name),
    })),
  };
}

async function handleEspnSummary(request, url, ctx) {
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
  const event = url.searchParams.get('event') || '';
  if (!/^\d{4,12}$/.test(event)) return jsonResponse({ error: 'Give event=<ESPN event id>' }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/espn-summary?event=${event}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let response;
  for (const base of [ESPN_SUMMARY, ESPN_SUMMARY_FALLBACK]) {
    response = await fetch(`${base}?event=${event}`, { headers: ESPN_HEADERS });
    if (response.ok) break;
    console.warn(`[espn-summary] ${new URL(base).host} answered ${response.status}`);
  }
  if (!response.ok) return jsonResponse({ error: `ESPN answered ${response.status}` }, 502);
  const data = await response.json();

  // Both teams' rosters, for the full injury list. One failing leaves that
  // team on the summary's five.
  const rosters = {};
  await Promise.all((data?.header?.competitions?.[0]?.competitors || []).map(async c => {
    const id = c?.team?.id, name = c?.team?.displayName;
    if (!/^\d{1,3}$/.test(String(id || '')) || !name) return;
    for (const base of [ESPN_TEAMS, ESPN_TEAMS_FALLBACK]) {
      try {
        const r = await fetch(`${base}/${id}/roster`, { headers: ESPN_HEADERS });
        if (r.ok) { rosters[name] = await r.json(); return; }
        console.warn(`[espn-summary] roster ${id}: ${new URL(base).host} answered ${r.status}`);
      } catch (error) {
        console.warn(`[espn-summary] roster ${id}: ${error.message}`);
      }
    }
  }));

  const out = new Response(JSON.stringify(trimEspnSummary(data, rosters)), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${SUMMARY_CACHE_SECONDS}`,
      ...CORS_HEADERS,
    },
  });
  if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// ---------------------------------------------------------------------------
// Picks in D1 (D1-PICKS-PLAN.md).
//
// The Backup sheet's append-only log, kept in Cloudflare's database beside
// the worker: one row per pick per sync, folded on read by the same rules as
// the Apps Script's reader (foldPickRow). A save lands in D1 and the phone is
// answered at once; the sheet still gets every row, in the background, and a
// copy that fails is queued (mirror:pending) for the cron. Reads come from D1
// only once PICKS_READ is 'd1' - the cut-over switch and the rollback.
//
// D1 refusing anything (a used-up free-plan limit included: the free plan is
// never billed, it refuses) sends that request the old way, through the
// sheet, and queues the write (d1:pending) for D1 once it answers again. The
// admin hears about a refusal at most once an hour, and about a day passing
// half of a free limit once a day.
// ---------------------------------------------------------------------------

// Free-plan limits as understood in October 2026 (Cloudflare's pricing page
// is the authority), and the share that earns the admin a warning.
const D1_FREE_ROWS_READ = 5000000;
const D1_FREE_ROWS_WRITTEN = 100000;
const D1_WARN_SHARE = 0.5;

const D1_FAILING_KEY = 'd1:failing';
const D1_PENDING_KEY = 'd1:pending';          // saves that reached only the sheet
const MIRROR_PENDING_KEY = 'mirror:pending';  // saves that reached only D1
const PENDING_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const PENDING_MAX = 300;
const D1_ALERT_EVERY_MS = 60 * 60 * 1000;
const PICKS_COMPARED_KEY = 'd1:compared';
const D1_INSERT_CHUNK = 50;

// Value columns have no declared type, so a number stays a number and a
// string a string, as they were in the sheet's cells.
const PICK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pick_rows (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL, season INTEGER NOT NULL, week TEXT NOT NULL, picker TEXT NOT NULL,
     game_key TEXT NOT NULL, game_id TEXT NOT NULL,
     away, home, away_spread, home_spread, line_pick, winner_pick,
     blazin INTEGER NOT NULL DEFAULT 0, over_under, total_line, frozen_at)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS pick_rows_once ON pick_rows (ts, week, picker, game_id)',
  'CREATE INDEX IF NOT EXISTS pick_rows_season ON pick_rows (season, week, picker)',
  `CREATE TABLE IF NOT EXISTS pick_cleared (
     week TEXT NOT NULL, picker TEXT NOT NULL, cleared INTEGER NOT NULL, ts TEXT NOT NULL,
     PRIMARY KEY (week, picker))`,
  'CREATE TABLE IF NOT EXISTS pick_usage (day TEXT PRIMARY KEY, rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS pick_meta (k TEXT PRIMARY KEY, v TEXT)',
];

const PICK_INSERT = `INSERT OR IGNORE INTO pick_rows
  (ts, season, week, picker, game_key, game_id, away, home, away_spread, home_spread,
   line_pick, winner_pick, blazin, over_under, total_line, frozen_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`;

const tablesReady = new WeakMap();

function picksDb(env) {
  return env?.PICKS_DB || null;
}

/** Reads come from D1: the cut-over switch, set in the worker's variables. */
function readsFromD1(env) {
  return Boolean(picksDb(env)) && env.PICKS_READ === 'd1';
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The season a sheet-form week belongs to: '2026_7' -> 2026, a bare number -> 2025. */
function seasonOfPickWeek(week) {
  const match = String(week).match(/^(\d{4})_/);
  return match ? Number(match[1]) : 2025;
}

/**
 * One request's use of D1. Every query's rows read and written are added up
 * and recorded once, in pick_usage, by close(): that is what the 50% warning
 * reads. D1 rather than KV, whose free tier allows 1,000 writes a day.
 */
function d1Session(env, now = Date.now()) {
  const db = picksDb(env);
  const usage = { read: 0, written: 0 };
  const tally = result => {
    for (const r of [].concat(result || [])) {
      usage.read += Number(r?.meta?.rows_read) || 0;
      usage.written += Number(r?.meta?.rows_written) || 0;
    }
    return result;
  };
  return {
    usage,
    async ready() {
      if (!tablesReady.has(db)) {
        tablesReady.set(db, db.batch(PICK_SCHEMA.map(sql => db.prepare(sql)))
          .catch(error => { tablesReady.delete(db); throw error; }));
      }
      await tablesReady.get(db);
    },
    async all(sql, ...args) {
      return (tally(await db.prepare(sql).bind(...args).all())?.results) || [];
    },
    async first(sql, ...args) {
      return (await this.all(sql, ...args))[0] || null;
    },
    async run(sql, ...args) {
      return tally(await db.prepare(sql).bind(...args).run());
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      return tally(await db.batch(statements.map(([sql, args]) => db.prepare(sql).bind(...args))));
    },
    async close() {
      if (!usage.read && !usage.written) return;
      await db.prepare(`INSERT INTO pick_usage (day, rows_read, rows_written) VALUES (?1, ?2, ?3)
          ON CONFLICT(day) DO UPDATE SET rows_read = rows_read + excluded.rows_read,
                                         rows_written = rows_written + excluded.rows_written`)
        .bind(utcDay(now), usage.read, usage.written).run()
        .catch(error => console.error('[d1] usage not recorded:', error.message));
    },
  };
}

/** One synced pick as a pick_rows row: the same cells savePicks() appends. */
function pickRowArgs(ts, week, picker, pick) {
  const away = pick.away || '';
  const home = pick.home || '';
  return [
    ts, seasonOfPickWeek(week), String(week), String(picker),
    `${String(away).toLowerCase()}_${String(home).toLowerCase()}`,
    String(pick.gameId ?? ''), away, home,
    pick.awaySpread || '', pick.homeSpread || '',
    pick.linePick || '', pick.winnerPick || '',
    pick.blazin ? 1 : 0,
    pick.overUnder || '', pick.totalLine || '',
    pick.frozenAt || '',
  ];
}

/**
 * Write one /sync payload ({week, picker, picks, cleared}) to D1, stamped
 * [ts] - one timestamp for the batch, as savePicks() stamps one. Returns what
 * was written, in the shape the Apps Script's reply carries it.
 */
async function d1WriteSync(session, data, ts) {
  const { week, picker } = data;
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const statements = picks.map(pick => [PICK_INSERT, pickRowArgs(ts, week, picker, pick)]);
  if (typeof data.cleared === 'boolean') {
    statements.push([`INSERT INTO pick_cleared (week, picker, cleared, ts) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(week, picker) DO UPDATE SET cleared = excluded.cleared, ts = excluded.ts`,
      [String(week), String(picker), data.cleared ? 1 : 0, ts]]);
  }
  // When live writes began: the copy from the sheet stops there, so the same
  // save is never in D1 twice under the sheet's timestamp and the worker's.
  statements.push(['INSERT OR IGNORE INTO pick_meta (k, v) VALUES (?1, ?2)', ['liveSince', ts]]);
  await session.ready();
  await session.batch(statements);
  const results = {};
  if (typeof data.cleared === 'boolean') {
    results.cleared = { message: `Cleared status for ${picker} Week ${week} set to ${data.cleared}`, cleared: data.cleared };
  }
  if (picks.length > 0) {
    results.picks = { message: `Backed up ${picks.length} picks for ${picker} Week ${week}`, rowsAdded: picks.length };
  }
  return results;
}

// --- The reader: google-apps-script-simple.js's, line for line --------------
// Keep these in step with foldPickRow / pickPayload there. Until the switch the
// sheet's copy is what the site reads; the daily comparison checks they agree.

const PICK_UNLOCK_MARKER = 'unlocked ';

function pickBlank(value) {
  return value === '' || value === null || value === undefined;
}

function pickUnlockCell(value) {
  return typeof value === 'string' && value.indexOf(PICK_UNLOCK_MARKER) === 0;
}

function foldPickRowD1(existing, row) {
  if (pickUnlockCell(row.frozenAt)) {
    if (existing && row.timestamp < existing.timestamp) return existing;
    row.frozenAt = '';
    return row;
  }
  if (!existing) return row;
  const existingFrozen = !pickBlank(existing.frozenAt);
  const rowFrozen = !pickBlank(row.frozenAt);
  if (existingFrozen && !rowFrozen) return existing;
  if (rowFrozen && !existingFrozen) return row;
  if (row.timestamp > existing.timestamp) return row;
  if (row.timestamp < existing.timestamp) return existing;
  const merged = existing;
  for (const field of ['linePick', 'winnerPick', 'overUnder', 'totalLine', 'lineOutcome', 'winnerOutcome', 'ouOutcome', 'frozenAt']) {
    if (pickBlank(merged[field])) merged[field] = row[field];
  }
  merged.blazin = merged.blazin || row.blazin;
  return merged;
}

/** A pick_rows row as the sheet reader's row object. */
function pickRowFromD1(r) {
  return {
    timestamp: new Date(r.ts).getTime(),
    week: String(r.week), picker: String(r.picker), gameId: String(r.game_id),
    away: r.away, home: r.home, awaySpread: r.away_spread, homeSpread: r.home_spread,
    linePick: r.line_pick, winnerPick: r.winner_pick, blazin: Boolean(r.blazin),
    overUnder: r.over_under, totalLine: r.total_line,
    lineOutcome: '', winnerOutcome: '', ouOutcome: '',
    frozenAt: r.frozen_at || '',
  };
}

function pickSide(value, away, home) {
  if (value === away) return 'away';
  if (value === home) return 'home';
  return value || '';
}

function pickPayloadD1(row) {
  const payload = {
    line: pickSide(row.linePick, row.away, row.home),
    winner: pickSide(row.winnerPick, row.away, row.home),
    blazin: row.blazin || false,
    overUnder: row.overUnder || '',
    totalLine: row.totalLine || '',
    lineOutcome: row.lineOutcome || '',
    winnerOutcome: row.winnerOutcome || '',
    ouOutcome: row.ouOutcome || '',
  };
  if (!pickBlank(row.frozenAt)) {
    payload.frozenAt = row.frozenAt;
    const away = Number(row.awaySpread);
    const home = Number(row.homeSpread);
    if (isFinite(away) && isFinite(home)) {
      payload.frozenSpread = Math.abs(home <= away ? home : away);
      payload.frozenFavorite = home <= away ? 'home' : 'away';
    }
  }
  return payload;
}

/** Rows (ordered by ts) folded to { week: { picker: { key: payload } } }. */
function foldPickRows(rows) {
  const collapsed = {};
  for (const r of rows) {
    const row = pickRowFromD1(r);
    const key = `${String(row.away).toLowerCase()}_${String(row.home).toLowerCase()}`;
    const bucket = ((collapsed[row.week] ||= {})[row.picker] ||= {});
    bucket[key] = foldPickRowD1(bucket[key], row);
  }
  const picks = {};
  for (const week in collapsed) {
    picks[week] = {};
    for (const picker in collapsed[week]) {
      picks[week][picker] = {};
      for (const key in collapsed[week][picker]) picks[week][picker][key] = pickPayloadD1(collapsed[week][picker][key]);
    }
  }
  return picks;
}

/** The Apps Script's getAllPicks(season), from D1. */
async function d1AllPicks(session, season) {
  await session.ready();
  const rows = season
    ? await session.all('SELECT * FROM pick_rows WHERE season = ?1 ORDER BY ts, id', season)
    : await session.all('SELECT * FROM pick_rows ORDER BY ts, id');
  const picks = foldPickRows(rows);
  const cleared = {};
  for (const c of await session.all('SELECT week, picker FROM pick_cleared WHERE cleared = 1')) {
    if (season && seasonOfPickWeek(c.week) !== season) continue;
    (cleared[c.week] ||= {})[c.picker] = true;
  }
  return {
    picks, cleared, weekCount: Object.keys(picks).length,
    season: season || 'all', rowsScanned: rows.length, rowsUsed: rows.length, source: 'd1',
  };
}

/** The Apps Script's getPicksForWeek(week, picker), from D1. */
async function d1WeekPicks(session, week, picker) {
  await session.ready();
  const rows = await session.all('SELECT * FROM pick_rows WHERE week = ?1 AND picker = ?2 ORDER BY ts, id', String(week), String(picker));
  const picks = foldPickRows(rows)[String(week)]?.[String(picker)] || {};
  const cleared = await session.first('SELECT cleared FROM pick_cleared WHERE week = ?1 AND picker = ?2', String(week), String(picker));
  return { week, picker, picks, count: Object.keys(picks).length, cleared: Boolean(cleared?.cleared), source: 'd1' };
}

/**
 * A season's picks for the worker's own use (reminders, Blazin' 5 results):
 * D1 once the switch is on, the sheet otherwise - and the sheet whenever D1
 * refuses.
 */
async function readSeasonPicks(env, season) {
  if (readsFromD1(env)) {
    const session = d1Session(env);
    try {
      return await d1AllPicks(session, Number(season));
    } catch (error) {
      await noteD1Failure(env, error);
    } finally {
      await session.close();
    }
  }
  return appsScriptGet(env, { action: 'allpicks', season: String(season) });
}

async function readWeekPicks(env, week, picker) {
  if (readsFromD1(env)) {
    const session = d1Session(env);
    try {
      return await d1WeekPicks(session, week, picker);
    } catch (error) {
      await noteD1Failure(env, error);
    } finally {
      await session.close();
    }
  }
  return appsScriptGet(env, { action: 'picks', week, picker });
}

// --- Queues and alerts -----------------------------------------------------

async function enqueue(env, key, item, now = Date.now()) {
  if (!env.NOTIFY_STATE) return;
  const list = JSON.parse(await env.NOTIFY_STATE.get(key) || '[]')
    .filter(entry => now - (entry.at || 0) < PENDING_KEEP_MS);
  list.push({ ...item, at: now });
  await env.NOTIFY_STATE.put(key, JSON.stringify(list.slice(-PENDING_MAX)));
}

/**
 * D1 refused something. Logged every time; the admin is told at most once an
 * hour (each alert is one KV write, so a bad hour costs one write, not one per
 * request).
 */
async function noteD1Failure(env, error, now = Date.now()) {
  console.error('[d1] failed, using the sheet:', error?.message || error);
  if (!env.NOTIFY_STATE) return;
  const state = JSON.parse(await env.NOTIFY_STATE.get(D1_FAILING_KEY) || 'null');
  if (state && now - (state.alertedAt || state.since) < D1_ALERT_EVERY_MS) return;
  let alertedAt = state?.alertedAt || null;
  if (env.FCM_SERVICE_ACCOUNT) {
    const sent = await alertAdmin(env, now, 'Picks database refusing',
      `D1 refused a request (${String(error?.message || error).slice(0, 160)}). Picks are going through the Google Sheet meanwhile; nothing is lost.`)
      .catch(() => ({ ok: false }));
    if (sent.ok) alertedAt = now;
  }
  await env.NOTIFY_STATE.put(D1_FAILING_KEY, JSON.stringify({ since: state?.since ?? now, lastError: String(error?.message || error), alertedAt: alertedAt ?? now }));
}

/** Send a saved /sync body to the Apps Script. Throws unless it really landed. */
async function postToSheet(env, body) {
  const response = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!response.ok) throw new Error(`Apps Script answered ${response.status}`);
  const data = await response.json();
  if (data?.error || data?.results?.picks?.error) throw new Error(`Apps Script error: ${data.error || data.results.picks.error}`);
  return data;
}

/** The background copy of a D1-stored save to the sheet; a failure is queued for the cron. */
async function mirrorToSheet(env, body, now = Date.now()) {
  try {
    await postToSheet(env, body);
  } catch (error) {
    console.error('[d1] sheet copy failed, queued:', error.message);
    await enqueue(env, MIRROR_PENDING_KEY, { body }, now);
  }
}

// --- /sync with D1 ----------------------------------------------------------

/** A body that is only a picker's picks and cleared flag (no spreads or results). */
function syncIsPicksOnly(data) {
  return Object.keys(data).every(k => ['week', 'picker', 'picks', 'cleared'].includes(k));
}

/**
 * POST /sync when the worker has D1. Null when D1 is not involved (no
 * database, or a body with no picks or cleared flag), and the caller forwards
 * to the sheet as before.
 */
async function syncPostWithD1(env, ctx, body, now = Date.now()) {
  if (!picksDb(env)) return null;
  let data;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || !data.week || !data.picker) return null;
  const hasPicks = Array.isArray(data.picks) && data.picks.length > 0;
  if (!hasPicks && typeof data.cleared !== 'boolean') return null;

  const ts = new Date(now).toISOString();
  const writeD1 = async () => {
    const session = d1Session(env, now);
    try {
      return await d1WriteSync(session, data, ts);
    } catch (error) {
      await noteD1Failure(env, error, now);
      return null;
    } finally {
      await session.close();
    }
  };

  // Before the switch the sheet is what every phone reads, so it stays the
  // store the phone waits on, exactly as today, and D1 is written beside it.
  // Answering from D1 here would let a sheet copy that failed leave other
  // phones - and this one, on its next load - reading the pick's absence.
  if (!readsFromD1(env)) {
    const [results, response] = await Promise.all([writeD1(), forwardSyncPost(env, body)]);
    if (!results) await oweD1(env, response, data, ts, now);
    return response;
  }

  // After the switch D1 is what everyone reads: stored there, the phone is
  // answered now, and the sheet gets its copy after.
  const results = await writeD1();
  if (results && syncIsPicksOnly(data)) {
    ctx?.waitUntil?.(mirrorToSheet(env, body, now));
    return jsonResponse({ success: true, results, store: 'd1' });
  }

  // D1 refused (or the body carries more than picks): the sheet, as before.
  const response = await forwardSyncPost(env, body);
  if (!results) await oweD1(env, response, data, ts, now);
  return response;
}

/** A save the sheet took and D1 did not: queued for the cron to copy into D1. */
async function oweD1(env, response, data, ts, now) {
  const reply = await response.clone().json().catch(() => null);
  // Only a save the sheet took is owed to D1; a failed one the phone retries.
  if (response.ok && reply?.success && !reply?.results?.picks?.error) {
    await enqueue(env, D1_PENDING_KEY, { data, ts }, now).catch(() => {});
  }
}

/** GET /sync?action=allpicks|picks from D1, or null to ask the sheet. */
async function syncGetFromD1(env, params) {
  const action = params.get('action');
  if (!readsFromD1(env) || (action !== 'allpicks' && action !== 'picks')) return null;
  const session = d1Session(env);
  try {
    if (action === 'allpicks') {
      return jsonResponse(await d1AllPicks(session, params.get('season') ? Number(params.get('season')) : null));
    }
    const week = params.get('week');
    const picker = params.get('picker');
    if (!week || !picker) return null;
    return jsonResponse(await d1WeekPicks(session, week, picker));
  } catch (error) {
    await noteD1Failure(env, error);
    return null;
  } finally {
    await session.close();
  }
}

// --- The copy in, and the comparison ----------------------------------------

/**
 * Copy a season's Backup rows into D1 (option A: the raw rows, so the history
 * and the fold come out the same). Stops at liveSince, where the worker's own
 * writes begin, and INSERT OR IGNORE makes a second run harmless.
 */
async function importPicksFromSheet(env, season, now = Date.now()) {
  const data = await appsScriptGet(env, { action: 'backuprows', season: String(season) });
  const session = d1Session(env, now);
  try {
    await session.ready();
    const live = await session.first('SELECT v FROM pick_meta WHERE k = ?1', 'liveSince');
    const liveSince = live ? Date.parse(live.v) : Infinity;
    const rows = (data.rows || []).filter(row => {
      const t = new Date(row[0]).getTime();
      return isFinite(t) && t < liveSince && seasonOfPickWeek(row[1]) === Number(season);
    });
    let inserted = 0;
    for (let i = 0; i < rows.length; i += D1_INSERT_CHUNK) {
      const chunk = rows.slice(i, i + D1_INSERT_CHUNK).map(row => [PICK_INSERT, pickRowArgs(
        new Date(row[0]).toISOString(), row[1], row[2], {
          gameId: row[3], away: row[4], home: row[5], awaySpread: row[6], homeSpread: row[7],
          linePick: row[8], winnerPick: row[9], blazin: row[10] === 'Yes',
          overUnder: row[11], totalLine: row[12], frozenAt: row[16] || '',
        })]);
      const results = await session.batch(chunk);
      inserted += results.reduce((n, r) => n + (Number(r?.meta?.changes) || 0), 0);
    }
    // The cleared flags come from the folded read, as the sheet holds them.
    const all = await appsScriptGet(env, { action: 'allpicks', season: String(season) });
    const cleared = [];
    for (const [week, pickers] of Object.entries(all.cleared || {})) {
      for (const picker of Object.keys(pickers)) {
        cleared.push([`INSERT INTO pick_cleared (week, picker, cleared, ts) VALUES (?1, ?2, 1, ?3)
            ON CONFLICT(week, picker) DO NOTHING`, [String(week), String(picker), new Date(now).toISOString()]]);
      }
    }
    await session.batch(cleared);
    await session.run(`INSERT INTO pick_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      `imported:${season}`, new Date(now).toISOString());
    return { season: Number(season), sheetRows: (data.rows || []).length, copied: rows.length, inserted, cleared: cleared.length, liveSince: live?.v || null };
  } finally {
    await session.close();
  }
}

/** A pick as the comparison sees it: only what the site uses. */
function comparablePick(p) {
  const total = pickBlank(p?.totalLine) ? '' : String(Number(p.totalLine));
  const out = {
    line: p?.line || '', winner: p?.winner || '', blazin: Boolean(p?.blazin),
    overUnder: p?.overUnder || '', totalLine: total, frozen: !pickBlank(p?.frozenAt),
  };
  if (out.frozen) { out.frozenSpread = p.frozenSpread ?? null; out.frozenFavorite = p.frozenFavorite ?? null; }
  return out;
}

function pickIsEmpty(c) {
  return !c.line && !c.winner && !c.blazin && !c.overUnder && !c.frozen;
}

/**
 * D1's fold against the sheet's, game by game. A pick missing on one side
 * and empty on the other (a deselection) is the same pick.
 */
async function comparePicks(env, season) {
  const sheet = await appsScriptGet(env, { action: 'allpicks', season: String(season) });
  const session = d1Session(env);
  let d1;
  try {
    d1 = await d1AllPicks(session, Number(season));
  } finally {
    await session.close();
  }
  const differences = [];
  const weeks = new Set([...Object.keys(sheet.picks || {}), ...Object.keys(d1.picks)]);
  for (const week of weeks) {
    const a = sheet.picks?.[week] || {};
    const b = d1.picks[week] || {};
    for (const picker of new Set([...Object.keys(a), ...Object.keys(b)])) {
      for (const key of new Set([...Object.keys(a[picker] || {}), ...Object.keys(b[picker] || {})])) {
        const inSheet = comparablePick(a[picker]?.[key]);
        const inD1 = comparablePick(b[picker]?.[key]);
        if (JSON.stringify(inSheet) === JSON.stringify(inD1)) continue;
        if (pickIsEmpty(inSheet) && pickIsEmpty(inD1)) continue;
        differences.push({ week, picker, game: key, sheet: inSheet, d1: inD1 });
      }
    }
    const ca = Object.keys(sheet.cleared?.[week] || {}).sort().join(',');
    const cb = Object.keys(d1.cleared[week] || {}).sort().join(',');
    if (ca !== cb) differences.push({ week, cleared: { sheet: ca, d1: cb } });
  }
  return { season: Number(season), differences: differences.length, sample: differences.slice(0, 40), sheetRows: sheet.rowsUsed, d1Rows: d1.rowsUsed };
}

/** The season by the calendar, as the site's (rolls over on July 1st). */
function seasonFor(now) {
  const d = new Date(now);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * The cron's D1 work: replay both queues, check D1 is answering (and say so
 * after a refusal), warn at half of a free limit, and once a day compare D1
 * with the sheet for a season that has been copied in.
 */
async function runPicksDbMaintenance(env, now = Date.now()) {
  if (!picksDb(env)) return { skipped: 'no PICKS_DB' };
  const out = {};
  const session = d1Session(env, now);
  try {
    await session.ready();
    await session.first('SELECT COUNT(*) AS n FROM pick_meta');

    // Saves that reached only the sheet, into D1 under their original times.
    if (env.NOTIFY_STATE) {
      const owed = JSON.parse(await env.NOTIFY_STATE.get(D1_PENDING_KEY) || '[]');
      for (const item of owed) await d1WriteSync(session, item.data, item.ts);
      if (owed.length) { await env.NOTIFY_STATE.delete(D1_PENDING_KEY); out.replayedToD1 = owed.length; }

      // Saves that reached only D1, to the sheet.
      const copies = JSON.parse(await env.NOTIFY_STATE.get(MIRROR_PENDING_KEY) || '[]');
      if (copies.length && env.APPS_SCRIPT_URL) {
        const left = [];
        for (const item of copies) {
          try { await postToSheet(env, item.body); } catch { left.push(item); }
        }
        if (left.length) await env.NOTIFY_STATE.put(MIRROR_PENDING_KEY, JSON.stringify(left));
        else await env.NOTIFY_STATE.delete(MIRROR_PENDING_KEY);
        out.copiedToSheet = copies.length - left.length;
        if (left.length) out.sheetCopiesWaiting = left.length;
      }

      // D1 answered: a refusal earlier is over.
      const failing = JSON.parse(await env.NOTIFY_STATE.get(D1_FAILING_KEY) || 'null');
      if (failing) {
        await env.NOTIFY_STATE.delete(D1_FAILING_KEY);
        if (failing.alertedAt && env.FCM_SERVICE_ACCOUNT) {
          await alertAdmin(env, now, 'Picks database back to normal', 'D1 is answering again; anything saved meanwhile has been copied in.').catch(() => {});
        }
        out.recovered = true;
      }
    }

    // Half of a free limit, once a day.
    const today = await session.first('SELECT rows_read, rows_written FROM pick_usage WHERE day = ?1', utcDay(now));
    if (today) out.usage = { rowsRead: today.rows_read, rowsWritten: today.rows_written };
    const overRead = (today?.rows_read || 0) >= D1_FREE_ROWS_READ * D1_WARN_SHARE;
    const overWritten = (today?.rows_written || 0) >= D1_FREE_ROWS_WRITTEN * D1_WARN_SHARE;
    const warnId = `d1-usage-${utcDay(now)}`;
    if ((overRead || overWritten) && env.NOTIFY_STATE && env.FCM_SERVICE_ACCOUNT && !(await alreadySent(env, warnId))) {
      const what = overRead
        ? `${today.rows_read.toLocaleString('en-US')} of ${D1_FREE_ROWS_READ.toLocaleString('en-US')} rows read`
        : `${today.rows_written.toLocaleString('en-US')} of ${D1_FREE_ROWS_WRITTEN.toLocaleString('en-US')} rows written`;
      const sent = await alertAdmin(env, now, 'Picks database past half its free limit',
        `Today: ${what}. Nothing is billed: past the limit D1 refuses and picks go through the sheet. See D1-PICKS-PLAN.md.`);
      if (sent.ok) { await markSent(env, warnId); out.warned = true; }
    }

    // The daily comparison, for a season already copied in.
    const season = seasonFor(now);
    const imported = await session.first('SELECT v FROM pick_meta WHERE k = ?1', `imported:${season}`);
    if (imported && env.NOTIFY_STATE && env.APPS_SCRIPT_URL) {
      const last = JSON.parse(await env.NOTIFY_STATE.get(PICKS_COMPARED_KEY) || 'null');
      if (last?.day !== utcDay(now)) {
        const result = await comparePicks(env, season);
        await env.NOTIFY_STATE.put(PICKS_COMPARED_KEY, JSON.stringify({ day: utcDay(now), at: now, differences: result.differences }));
        out.compared = result.differences;
        if (result.differences > 0 && env.FCM_SERVICE_ACCOUNT) {
          const first = result.sample[0];
          await alertAdmin(env, now, 'Picks database and sheet disagree',
            `${plural(result.differences, 'difference')} today${first?.game ? `, e.g. ${first.picker} ${first.week} ${first.game}` : ''}. GET /admin/picks/compare for the list.`).catch(() => {});
        }
      }
    }
  } catch (error) {
    await noteD1Failure(env, error, now);
    out.error = error.message;
  } finally {
    await session.close();
  }
  return out;
}

// --- /admin/picks/* ---------------------------------------------------------

/**
 * The admin's D1 tools, behind the same secret as /notify:
 *   POST /admin/picks/import?season=YYYY   copy the sheet's rows in
 *   GET  /admin/picks/compare?season=YYYY  D1 against the sheet
 *   GET  /admin/picks/status               switch, queues, today's usage
 */
async function handleAdminPicks(request, url, env) {
  if (!env.NOTIFY_SECRET) return jsonResponse({ error: 'Not configured' }, 500);
  const auth = request.headers.get('Authorization') || '';
  if (!(await secretsMatch(auth.startsWith('Bearer ') ? auth.slice(7) : '', env.NOTIFY_SECRET))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!picksDb(env)) return jsonResponse({ error: 'PICKS_DB is not bound to this worker' }, 500);
  const season = Number(url.searchParams.get('season')) || seasonFor(Date.now());
  const action = url.pathname.slice('/admin/picks/'.length);

  if (action === 'import' && request.method === 'POST') return jsonResponse(await importPicksFromSheet(env, season));
  if (action === 'compare' && request.method === 'GET') return jsonResponse(await comparePicks(env, season));
  if (action === 'status' && request.method === 'GET') {
    const session = d1Session(env);
    try {
      await session.ready();
      const meta = Object.fromEntries((await session.all('SELECT k, v FROM pick_meta')).map(r => [r.k, r.v]));
      const rows = await session.first('SELECT COUNT(*) AS n FROM pick_rows');
      const usage = await session.all('SELECT * FROM pick_usage ORDER BY day DESC LIMIT 7');
      const kv = async key => (env.NOTIFY_STATE ? JSON.parse(await env.NOTIFY_STATE.get(key) || 'null') : null);
      return jsonResponse({
        readsFrom: readsFromD1(env) ? 'd1' : 'sheet', rows: rows?.n || 0, meta, usage,
        failing: await kv(D1_FAILING_KEY),
        waitingForD1: (await kv(D1_PENDING_KEY) || []).length,
        waitingForSheet: (await kv(MIRROR_PENDING_KEY) || []).length,
        lastCompare: await kv(PICKS_COMPARED_KEY),
      });
    } finally {
      await session.close();
    }
  }
  return jsonResponse({ error: 'Unknown admin action' }, 404);
}

const PREVIEWS = ['blazin_results', 'pick_reminders'];

/**
 * Admin Settings' real-data tests. Results: the current week graded as it
 * stands - exactly what the schedule would send, plus a note of starred games
 * still to finish - or last week's, while nobody has starred one yet. Reminder: who still has picks to make this week, all of
 * them listed (a real reminder shows each phone only its own line, which
 * tells the admin nothing about the rest). Nothing is sent when there is
 * nothing to show; the answer says why.
 */
async function handlePreview(env, token, kind) {
  if (!env.APPS_SCRIPT_URL) return jsonResponse({ error: 'APPS_SCRIPT_URL is not configured' }, 500);
  const board = await fetchScoreboard();
  const { season, week, games } = board;
  if (!season || !week || games.length === 0) return jsonResponse({ error: 'ESPN has no games this week' }, 502);
  const seasonPicks = await fetchSeasonPicks(env, season);
  const picks = seasonPicks[week] || {};

  let message;
  let shownWeek = week;
  if (kind === 'blazin_results') {
    // Early in a week nobody has starred anything yet, so the test shows last
    // week instead: a real result to look at rather than nothing at all.
    let weekGames = games, weekPicks = picks;
    let records = gradeBlazin(weekGames, weekPicks, await fetchWeekSpreads(env, season, week));
    let starred = Object.values(records).reduce((n, r) => n + r.starred, 0);
    if (starred === 0 && week > 1 && board.seasonType === 2) {
      shownWeek = week - 1;
      weekGames = (await fetchScoreboard({ season, week: shownWeek })).games;
      weekPicks = seasonPicks[shownWeek] || {};
      records = gradeBlazin(weekGames, weekPicks, await fetchWeekSpreads(env, season, shownWeek));
      starred = Object.values(records).reduce((n, r) => n + r.starred, 0);
    }
    if (starred === 0) return jsonResponse({ ok: true, sent: false, note: `Nobody has starred a Week ${week} game yet.` });
    const seasonRecords = await seasonBlazinRecords(env, season, shownWeek, seasonPicks, records);
    message = blazinMessage(season, shownWeek, records, seasonRecords);
    // The admin's phone shows the admin's own line, as the real one will.
    const pending = pendingStarredGames(weekGames, weekPicks);
    if (pending > 0) {
      const note = ` As it stands: ${plural(pending, 'starred game')} still to finish.`;
      message.body += note;
      for (const picker of Object.keys(message.personal)) message.personal[picker] += note;
    }
  } else {
    const slate = { kind: 'weekend', kickoff: 0, day: '' };
    const reminder = reminderMessage(season, week, slate, games, picks, board.seasonType === 2);
    if (!reminder) return jsonResponse({ ok: true, sent: false, note: `Everyone's Week ${week} picks are in.` });
    const lines = Object.entries(reminder.personal)
      .map(([picker, text]) => `${picker}: ${text.replace(/^You still have /, '').replace(/\.$/, '')}`);
    message = {
      category: 'pick_reminders',
      week,
      title: `Still to pick - Week ${week}`,
      body: lines.join(' · '),
    };
  }

  const sent = await sendToGroup(env, { ...message, id: `preview-${kind}-${Date.now()}` }, { token });
  if (!sent.ok) return jsonResponse({ error: sent.error, detail: sent.detail }, sent.status || 502);
  return jsonResponse({ ok: true, sent: true, week: shownWeek });
}

/** Starred games not yet final, across everyone. */
function pendingStarredGames(games, picks) {
  const byKey = Object.fromEntries(games.map(g => [g.key, g]));
  const keys = new Set();
  for (const picker of [...NFL_PICKERS, COWHERD_PICKER]) {
    for (const [key, pick] of Object.entries(picks[picker] || {})) {
      if (pick.blazin && pick.line && !byKey[key]?.final) keys.add(key);
    }
  }
  return keys.size;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
