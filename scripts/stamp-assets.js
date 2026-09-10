#!/usr/bin/env node
//
// Stamps index.html's local <script>/<link> tags with a content hash:
//
//     <script src="app.js">   ->   <script src="app.js?v=6f3a9c21">
//
// Why: GitHub Pages serves app.js under one unchanging URL, so a browser that
// has it cached keeps running the old copy after a deploy. Every fix then needs
// "hard-refresh first" to actually reach anyone. A hash in the query string
// makes the URL change whenever the file does, so browsers fetch the new one on
// their own - and keep caching it for as long as it has not changed.
//
// The hash is of file CONTENT, so re-running this changes nothing unless an
// asset really changed. That makes it safe in a pre-commit hook.
//
// Usage:
//   node scripts/stamp-assets.js           rewrite index.html in place
//   node scripts/stamp-assets.js --check   exit 1 if any stamp is stale
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const checkOnly = process.argv.includes('--check');

// src="..." or href="..." pointing at a local .js/.css, with an optional
// existing ?v= stamp to replace. Absolute URLs (//, http:, https:) are skipped
// by requiring the path to start with something other than / or a scheme.
const ASSET = /(\s(?:src|href)=")(?!https?:|\/\/)([^"?]+\.(?:js|css))(?:\?v=[a-f0-9]+)?(")/g;

function hashOf(file) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex')
        .slice(0, 8);
}

function main() {
    const before = fs.readFileSync(HTML, 'utf8');
    const missing = [];
    const stamped = [];

    const after = before.replace(ASSET, (match, pre, assetPath, post) => {
        const file = path.join(ROOT, assetPath);
        if (!fs.existsSync(file)) {
            // A referenced file that is not there is a real problem, but not
            // this script's to fix - leave the tag alone and report it.
            missing.push(assetPath);
            return match;
        }
        const hash = hashOf(file);
        stamped.push(`${assetPath}?v=${hash}`);
        return `${pre}${assetPath}?v=${hash}${post}`;
    });

    if (missing.length > 0) {
        console.error(`referenced but not found: ${missing.join(', ')}`);
    }

    if (stamped.length === 0) {
        console.error('no local assets found in index.html - has the markup changed?');
        process.exit(1);
    }

    if (after === before) {
        console.log(`index.html already current (${stamped.length} assets)`);
        return;
    }

    if (checkOnly) {
        console.error('index.html asset stamps are stale. Run: node scripts/stamp-assets.js');
        process.exit(1);
    }

    fs.writeFileSync(HTML, after);
    console.log(`stamped ${stamped.length} assets:`);
    stamped.forEach(s => console.log(`  ${s}`));
}

main();
