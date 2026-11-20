#!/usr/bin/env node
// Feed rule contract tests (docs/NATIVE_CONTRACT.md section 11.6).
// Runs every vector in scripts/fixtures/feeds/rule-vectors.json against utils/feedRules.ts.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feeds', 'rule-vectors.json'), 'utf8'));
const { matchItem, showName } = require('../utils/feedRules.ts');

let passed = 0;
let failed = 0;
for (const v of vectors) {
  const got = matchItem(v.rule, v.title, v.seenEpisodes);
  const ok = got.match === v.expect.match && got.episode === v.expect.episode &&
    (v.expect.key === undefined || got.key === v.expect.key);
  if (ok) {
    passed++;
    console.log(`  ok   ${v.note}`);
  } else {
    failed++;
    console.error(`  FAIL ${v.note}: expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}`);
  }
}
const names = [
  ['The.Show.2019.S01E02.1080p.WEB-DL.x264', 'the show'],
  ['The Show S01E02 720p', 'the show'],
  ['1080p.WEB-DL.Show.S01E02', 'show'],
  ['[SubsPlease] Frieren - 12v2 (1080p) [ABCD1234].mkv', 'frieren'],
  ['ubuntu-26.04-desktop-amd64.iso', ''],
  ['1923 S01E01', '1923'],
  ['Show 2024 S01E01', 'show'],
  ['2024 S01E01', '2024'],
  ['1080p.S01E02', '1080p'],
];
for (const [title, want] of names) {
  if (showName(title) === want) passed++;
  else {
    failed++;
    console.error(`  FAIL showName(${title}): expected ${JSON.stringify(want)}, got ${JSON.stringify(showName(title))}`);
  }
}
console.log(`\nfeeds: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
