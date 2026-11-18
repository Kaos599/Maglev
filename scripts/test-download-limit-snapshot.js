#!/usr/bin/env node
// A link download reports its own speed limit (0 = no limit), so the sheet never invents "No limit" after a restart.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const snap = (types.match(/export interface DownloadSnapshot \{[\s\S]*?\n\}/) || [''])[0];
check('DownloadSnapshot declares downLimitBps: number', /\n\s+downLimitBps: number;/.test(snap));

const mock = read('modules/maglev-engine/src/MaglevMockDownloads.ts');
const mockSnap = (mock.match(/snapshots\(\): DownloadSnapshot\[\] \{[\s\S]*?\n  \}/) || [''])[0];
check('mock snapshot fills downLimitBps from its own limit', /downLimitBps: i\.limit/.test(mockSnap));

const sheet = read('app/download/[id].tsx');
check('download page reads the typed field', /d\.downLimitBps/.test(sheet));
check('download page no longer casts to read the limit', !/as \{ downLimitBps\?: number \}/.test(sheet));
check('download page does not fall back to a session-only value', !/downLimitBps \?\? chosen/.test(sheet));

const rs = read('native/maglev-core/src/http_dl/driver.rs');
const fn = (rs.match(/pub fn snapshots\(&self\)[\s\S]*?\n    \}\n/) || [''])[0];
check('Rust snapshot serialises down_limit_bps', /"down_limit_bps": r\.down_limit_bps/.test(fn));
check('Rust test covers the snapshot field', /snapshot_carries_the_download_limit_and_it_survives_a_restart/.test(rs));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall download-limit snapshot checks passed');
