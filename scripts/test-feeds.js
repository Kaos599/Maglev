#!/usr/bin/env node
// Feed rule contract tests (docs/NATIVE_CONTRACT.md section 11.6).
// Runs every vector in scripts/fixtures/feeds/rule-vectors.json against utils/feedRules.ts.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feeds', 'rule-vectors.json'), 'utf8'));
const { matchItem } = require('../utils/feedRules.ts');

let passed = 0;
let failed = 0;
for (const v of vectors) {
  const got = matchItem(v.rule, v.title, v.seenEpisodes);
  const ok = got.match === v.expect.match && got.episode === v.expect.episode;
  if (ok) {
    passed++;
    console.log(`  ok   ${v.note}`);
  } else {
    failed++;
    console.error(`  FAIL ${v.note}: expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}`);
  }
}
console.log(`\nfeeds: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
