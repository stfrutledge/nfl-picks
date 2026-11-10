// Serves the site from this folder on http://localhost:8000, for testing a
// change before it goes live: in a browser here, or in the Android app with
// Admin Settings > Load the site from this PC (phone plugged in by USB, then
// `adb reverse tcp:8000 tcp:8000`).
//
// Run with: node scripts/serve.js
//
// localhost never writes picks (LOCAL_READ_ONLY in app.js), so testing here
// can't change anyone's picks. Guesses and everything the worker does are real.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8000;
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p.endsWith('.html')) console.log(new Date().toLocaleTimeString(), req.method, req.url, req.headers['user-agent']?.includes('wv') ? '(app)' : '');
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        // Never cached: a reload always shows the latest edit.
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
