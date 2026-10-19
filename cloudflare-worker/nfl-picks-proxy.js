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
      } else if (path === '/notify') {
        return await handleNotify(request, env);
      } else if (path === '/reminder-check') {
        return await handleReminderCheck(url, env);
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
    // The write is finished even if the page that sent it has gone. A page
    // sends its last picks as it is hidden, and an app swiped away drops the
    // connection a moment later - while the Apps Script is still taking its
    // 2-8s. Cloudflare cancels a request's work when its client disconnects;
    // waitUntil keeps this running to the end. A page that is still there
    // waits for the real reply as before, so a failure is still retried.
    const work = forwardSyncPost(request, appsScriptUrl);
    ctx?.waitUntil?.(work.catch(() => {}));
    return await work;
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

/** Forward a /sync POST body to the Apps Script and pass its reply back. */
async function forwardSyncPost(request, appsScriptUrl) {
  // The site sends text/plain to skip the CORS preflight; the body is JSON
  // either way, and the Apps Script is always told it is.
  let body = await request.text();
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
  const data = await appsScriptGet(env, { action: 'allpicks', season: String(season) });
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
  const data = await appsScriptGet(env, { action: 'picks', week: `${season}_${week}`, picker });
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

  if (!blazinCandidate && dueSlates.length === 0) return { season, week, done, splits, ...degraded };

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

  return { season, week, done, splits, ...degraded };
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
// /splits - public betting splits on the spread: DraftKings and Circa.
//
// Neither has an API. DraftKings publishes its own splits as a page on DK
// Network; Circa's are republished by VSiN. Both are plain HTML, read here
// and cached for five minutes (VSiN's own update cycle). DraftKings is the
// public's book, Circa the sharps': where the money and the tickets disagree
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
 * Both books, merged per game: { updatedAt, errors, games: { key: { away,
 * home, dk, circa } } }, each book being { away: {line, handle, bets}, home }
 * or absent. One book failing still returns the other.
 */
async function buildSplits(now = Date.now()) {
  const [dk, circa] = await Promise.allSettled([fetchDkSplits(), fetchCircaSplits()]);
  const games = {};
  const errors = {};
  const add = (book, result) => {
    if (result.status !== 'fulfilled') { errors[book] = result.reason?.message || String(result.reason); return; }
    for (const g of result.value) {
      games[g.key] ||= { away: g.away, home: g.home };
      games[g.key][book] = g.sides;
    }
  };
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
      if (!s || (!s.dk && !s.circa)) continue;
      pending[g.key] = {
        key: g.key, season: board.season, week, away: g.away, home: g.home,
        kickoff: g.kickoff, takenAt: splits.updatedAt, dk: s.dk || null, circa: s.circa || null,
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
