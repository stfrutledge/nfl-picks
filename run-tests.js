// Runs every test-*.js file and reports which failed.
//
// Run with: node run-tests.js            (all of them)
//           node run-tests.js live dates (only files whose names contain these)
//
// Each file runs in its own Node process, as it would on its own, so one that
// throws or leaves timers running cannot take the others down with it. Exits
// non-zero if any file did.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filters = process.argv.slice(2);
const files = fs.readdirSync(__dirname)
    .filter(f => /^test-.+\.js$/.test(f))
    .filter(f => filters.length === 0 || filters.some(x => f.includes(x)))
    .sort();

if (files.length === 0) {
    console.log(`No test files match: ${filters.join(' ')}`);
    process.exit(1);
}

const failed = [];
const started = Date.now();
for (const file of files) {
    const t0 = Date.now();
    const run = spawnSync(process.execPath, [path.join(__dirname, file)], {
        cwd: __dirname, encoding: 'utf8', timeout: 120000
    });
    const ms = Date.now() - t0;
    const ok = run.status === 0;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${file} (${ms}ms)`);
    if (!ok) {
        failed.push(file);
        // Only the failures' output, so a green run stays one screen.
        const out = `${run.stdout || ''}${run.stderr || ''}`.trim();
        const lines = out.split('\n').filter(l => /FAIL|Error|assert|expected|actual/i.test(l));
        console.log((lines.length ? lines : out.split('\n').slice(-15))
            .map(l => `         ${l}`).join('\n'));
        if (run.error) console.log(`         ${run.error.message}`);
    }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed.length
    ? `\n${failed.length} of ${files.length} test files FAILED (${secs}s): ${failed.join(', ')}`
    : `\nAll ${files.length} test files passed (${secs}s)`);
process.exit(failed.length ? 1 : 0);
