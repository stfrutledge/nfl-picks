/**
 * Cloudflare Worker - NFL Picks Dashboard Proxy with Server-Side Caching
 *
 * Handles all external API calls to avoid CORS issues:
 * - /odds - Proxy The Odds API (hides API key) with caching
 * - /sheets - Proxy Google Sheets CSV exports
 * - /sync - Proxy Google Apps Script for picks backup
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
        return await handleSync(request, env);
      } else if (path === '/notify') {
        return await handleNotify(request, env);
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
      result => console.log('[automations]', JSON.stringify(result)),
      error => console.error('[automations] failed:', error.message)));
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
//   pick_reminders   3 hours before the week's first kickoff and before the
//                    first weekend kickoff, to whoever still has picks to make
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
const SENT_TTL_SECONDS = 60 * 60 * 24 * 60;   // forget a week's flags after 60 days

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

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
async function fetchScoreboard() {
  const response = await fetch(ESPN_SCOREBOARD);
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

async function appsScriptGet(env, params) {
  const url = new URL(env.APPS_SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Apps Script answered ${response.status}`);
  return response.json();
}

/** One week's picks per picker, keyed like the site's. */
async function fetchWeekPicks(env, season, week) {
  const data = await appsScriptGet(env, { action: 'allpicks', season: String(season) });
  const raw = data.picks?.[`${season}_${week}`] || {};
  const picks = {};
  for (const [picker, games] of Object.entries(raw)) {
    picks[picker] = {};
    for (const [key, pick] of Object.entries(games)) picks[picker][normalizeKey(key)] = pick;
  }
  return picks;
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

function blazinMessage(season, week, records) {
  const ranked = NFL_PICKERS
    .filter(p => records[p].starred > 0)
    .sort((a, b) => (records[b].wins - records[b].losses) - (records[a].wins - records[a].losses)
      || records[b].wins - records[a].wins || a.localeCompare(b));
  const cowherd = records[COWHERD_PICKER];
  const line = ranked.map(p => `${p} ${formatBlazinRecord(records[p])}`).join(', ')
    + (cowherd?.starred ? `. Cowherd ${formatBlazinRecord(cowherd)}.` : '.');
  return {
    category: 'blazin_results',
    id: `blazin-${season}-${week}`,
    title: `Week ${week} Blazin’ 5`,
    body: line,
    spoilerTitle: `Week ${week} Blazin’ 5`,
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
 * games, Saturday's late in the season.
 */
function reminderSlates(games) {
  const upcoming = [...games].sort((a, b) => a.kickoff - b.kickoff);
  if (upcoming.length === 0) return [];
  const isWeekend = g => ['Fri', 'Sat', 'Sun'].includes(easternWeekday(g.kickoff));
  const slates = [];
  // A week that opens before the weekend (Thursday night) gets a reminder
  // for that game alone; then the weekend's first kickoff gets the full one.
  const first = upcoming[0];
  if (!isWeekend(first)) {
    slates.push({ kind: 'first', kickoff: first.kickoff, day: easternWeekday(first.kickoff) });
  }
  const weekend = upcoming.find(isWeekend);
  if (weekend) slates.push({ kind: 'weekend', kickoff: weekend.kickoff, day: easternWeekday(weekend.kickoff) });
  return slates;
}

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A reminder before [slate]: for each picker with picks still to make on games
 * not yet started, their own sentence. Null when everyone is done.
 */
function reminderMessage(season, week, slate, games, picks, regularSeason) {
  // Before the opener, only its own day's games are about to lock; before the
  // weekend, everything left - and the Blazin' stars, which need placing
  // before the games they go on.
  const open = games.filter(g => g.state === 'pre' && g.kickoff >= slate.kickoff
    && (slate.kind === 'weekend' || easternWeekday(g.kickoff) === slate.day));
  const personal = {};
  for (const picker of NFL_PICKERS) {
    const mine = picks[picker] || {};
    const unpicked = open.filter(g => !(mine[g.key]?.line && mine[g.key]?.winner));
    const stars = Object.values(mine).filter(p => p.blazin && p.line).length;
    const starsLeft = regularSeason && slate.kind === 'weekend' && open.length > 0
      ? Math.max(0, BLAZIN_PER_WEEK - stars) : 0;
    if (unpicked.length === 0 && starsLeft === 0) continue;

    const todo = [];
    if (unpicked.length) todo.push(plural(unpicked.length, 'game'));
    if (starsLeft) todo.push(plural(starsLeft, 'Blazin’ star'));
    personal[picker] = `You still have ${todo.join(' and ')} to pick.`;
  }
  if (Object.keys(personal).length === 0) return null;

  const day = WEEKDAY_NAMES[slate.day] || 'the first';
  return {
    category: 'pick_reminders',
    id: `reminder-${season}-${week}-${slate.kind}`,
    title: `${day} kickoff in 3 hours`,
    body: '',
    personal,
    expiresAt: slate.kickoff,
  };
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
  const board = await fetchScoreboard();
  const { season, week, games } = board;
  if (!season || !week || games.length === 0) return { skipped: 'no games' };
  const regularSeason = board.seasonType === 2;
  const done = [];

  // What could be due on this run, before paying for the sheet.
  const blazinId = `blazin-${season}-${week}`;
  // A non-starred game still being played (Monday night) must not hold up
  // results that are already settled, so this only waits for a final game.
  const blazinCandidate = regularSeason && games.some(g => g.final)
    && !(await alreadySent(env, blazinId));

  const dueSlates = [];
  for (const slate of reminderSlates(games)) {
    if (now < slate.kickoff - REMINDER_LEAD_MS || now >= slate.kickoff) continue;
    if (!(await alreadySent(env, `reminder-${season}-${week}-${slate.kind}`))) dueSlates.push(slate);
  }

  if (!blazinCandidate && dueSlates.length === 0) return { season, week, done };

  const picks = await fetchWeekPicks(env, season, week);

  if (blazinCandidate && blazinSettled(games, picks)) {
    const spreads = await fetchWeekSpreads(env, season, week);
    const message = blazinMessage(season, week, gradeBlazin(games, picks, spreads));
    const sent = await sendToGroup(env, message);
    if (sent.ok) { await markSent(env, blazinId); done.push(blazinId); }
  }

  for (const slate of dueSlates) {
    const id = `reminder-${season}-${week}-${slate.kind}`;
    const message = reminderMessage(season, week, slate, games, picks, regularSeason);
    // Nobody to remind is still "done": the moment has passed for this slate.
    if (!message) { await markSent(env, id); done.push(`${id} (nobody to remind)`); continue; }
    const sent = await sendToGroup(env, message);
    if (sent.ok) { await markSent(env, id); done.push(id); }
  }

  return { season, week, done };
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
