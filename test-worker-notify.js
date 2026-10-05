// Tests for the worker's /notify endpoint: the Android app's "Message the
// group" box POSTs here, and the worker sends it to every phone through
// Firebase Cloud Messaging.
//
// The worker is public, so the checks that matter most are the refusals: no
// message goes anywhere without the admin secret. The happy path is run
// against a fake Google: a real RSA key is generated here, so the JWT the
// worker signs is verified exactly as Google would verify it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SOURCE = fs.readFileSync(
    path.join(__dirname, 'cloudflare-worker', 'nfl-picks-proxy.js'), 'utf8');
const tmp = path.join(os.tmpdir(), `nfl-picks-notify-${process.pid}.mjs`);
fs.writeFileSync(tmp, SOURCE);

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const ACCOUNT = {
    type: 'service_account',
    project_id: 'nfl-picks-test',
    client_email: 'sender@nfl-picks-test.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token'
};
const SECRET = 'correct horse battery staple';
const ENV = { NOTIFY_SECRET: SECRET, FCM_SERVICE_ACCOUNT: JSON.stringify(ACCOUNT) };
const ORIGIN = 'https://nfl-picks-proxy.example.workers.dev';

// --- fake Google ------------------------------------------------------------

const requests = [];
let fcmStatus = 200;
globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? String(init.body) : '';
    requests.push({ url: String(url), headers: init.headers || {}, body });
    if (String(url) === ACCOUNT.token_uri) {
        return new Response(JSON.stringify({ access_token: 'google-token', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).startsWith('https://fcm.googleapis.com/')) {
        return fcmStatus === 200
            ? new Response(JSON.stringify({ name: 'projects/nfl-picks-test/messages/1' }), { status: 200 })
            : new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: fcmStatus });
    }
    throw new Error('unexpected fetch ' + url);
};
const fcmCalls = () => requests.filter(r => r.url.startsWith('https://fcm.googleapis.com/'));
const tokenCalls = () => requests.filter(r => r.url === ACCOUNT.token_uri);

let worker;
function notify({ method = 'POST', auth = `Bearer ${SECRET}`, body = { title: 'Picks', body: 'Get your picks in' }, env = ENV } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = auth;
    const init = { method, headers };
    if (method !== 'GET' && body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    return worker.fetch(new Request(ORIGIN + '/notify', init), env, { waitUntil() {} });
}

let failures = 0, total = 0;
async function check(name, fn) {
    total++;
    requests.length = 0;
    fcmStatus = 200;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(name) { console.log(`\n${name}`); }

(async () => {
    worker = (await import(pathToFileURL(tmp).href)).default;

    section('Nothing is sent without the admin secret');

    await check('no Authorization header is refused', async () => {
        const r = await notify({ auth: null });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(requests.length, 0, 'nothing reached Google');
    });

    await check('a wrong secret is refused', async () => {
        const r = await notify({ auth: 'Bearer nope' });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(requests.length, 0);
    });

    await check('the secret without "Bearer" is refused', async () => {
        const r = await notify({ auth: SECRET });
        assert.strictEqual(r.status, 401);
    });

    await check('GET is refused', async () => {
        const r = await notify({ method: 'GET' });
        assert.strictEqual(r.status, 405);
        assert.strictEqual(requests.length, 0);
    });

    await check('an unconfigured worker says so and sends nothing', async () => {
        const r = await notify({ env: { NOTIFY_SECRET: SECRET } });
        assert.strictEqual(r.status, 500);
        assert.match((await r.json()).error, /not configured/);
        const r2 = await notify({ env: { FCM_SERVICE_ACCOUNT: ENV.FCM_SERVICE_ACCOUNT } });
        assert.strictEqual(r2.status, 500, 'no secret configured is not an open door');
        assert.strictEqual(requests.length, 0);
    });

    section('The message is checked');

    await check('an empty message is refused', async () => {
        const r = await notify({ body: { title: 'x', body: '   ' } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(fcmCalls().length, 0);
    });

    await check('a body that is not JSON is refused', async () => {
        const r = await notify({ body: 'not json' });
        assert.strictEqual(r.status, 400);
    });

    await check('an over-long message is refused', async () => {
        const r = await notify({ body: { body: 'x'.repeat(1001) } });
        assert.strictEqual(r.status, 400);
    });

    section('A good request goes to the group topic');

    await check('it is sent to the topic, data-only and high priority, as a message', async () => {
        const r = await notify({ body: { title: 'Week 5', body: 'Picks lock at 8:15' } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(await r.json(), { ok: true, name: 'projects/nfl-picks-test/messages/1' });

        const [send] = fcmCalls();
        assert.strictEqual(send.url, 'https://fcm.googleapis.com/v1/projects/nfl-picks-test/messages:send');
        assert.strictEqual(send.headers.Authorization, 'Bearer google-token');
        const { message } = JSON.parse(send.body);
        assert.strictEqual(message.topic, 'group');
        assert.deepStrictEqual(message.android, { priority: 'HIGH' });
        assert.strictEqual(message.data.category, 'messages');
        assert.strictEqual(message.data.title, 'Week 5');
        assert.strictEqual(message.data.body, 'Picks lock at 8:15');
        assert.match(message.data.id, /^msg-\d+$/);
    });

    await check('no notification payload: the system must not draw it before the phone decides', async () => {
        // A notification payload is drawn the moment it lands, 4am in Ireland
        // included, and ignores the person's switches.
        await notify();
        const { message } = JSON.parse(fcmCalls()[0].body);
        assert.strictEqual(message.notification, undefined);
        Object.values(message.data).forEach(v => assert.strictEqual(typeof v, 'string', 'FCM data must be strings'));
    });

    await check('a blank title becomes "NFL Picks"', async () => {
        await notify({ body: { title: '  ', body: 'hello' } });
        const { message } = JSON.parse(fcmCalls()[0].body);
        assert.strictEqual(message.data.title, 'NFL Picks');
    });

    await check('the JWT is signed by the service account and verifies', async () => {
        // A fresh worker instance, so the token cache from the checks above
        // does not skip the exchange.
        const fresh = (await import(pathToFileURL(tmp).href + '?fresh=1')).default;
        await fresh.fetch(new Request(ORIGIN + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
            body: JSON.stringify({ body: 'hi' })
        }), ENV, { waitUntil() {} });

        const [exchange] = tokenCalls();
        assert.ok(exchange, 'the token was requested');
        const form = new URLSearchParams(exchange.body);
        assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

        const [h, c, sig] = form.get('assertion').split('.');
        const verified = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`),
            publicKey, Buffer.from(sig, 'base64url'));
        assert.ok(verified, 'the signature verifies against the account key');

        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        assert.strictEqual(claims.iss, ACCOUNT.client_email);
        assert.strictEqual(claims.aud, ACCOUNT.token_uri);
        assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
        assert.strictEqual(claims.exp - claims.iat, 3600);
    });

    await check('the Google token is reused between messages', async () => {
        await notify();
        await notify();
        assert.strictEqual(fcmCalls().length, 2);
        assert.strictEqual(tokenCalls().length, 0, 'still inside the hour from the first send');
    });

    await check('an FCM refusal is reported, not swallowed', async () => {
        fcmStatus = 403;
        const r = await notify();
        assert.strictEqual(r.status, 502);
        assert.match((await r.json()).error, /403/);
    });

    fs.unlinkSync(tmp);
    if (failures > 0) {
        console.log(`\n${failures} of ${total} CHECKS FAILED\n`);
        process.exit(1);
    }
    console.log(`\nALL ${total} CHECKS PASSED\n`);
})();
