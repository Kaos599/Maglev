#!/usr/bin/env node
// Jargon scan contract (ASSISTANT_DESIGN section 9, C-ASSIST-8). Pure TS, no network.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}

async function main() {
  const { scanJargon } = await import('../utils/assistant/jargonScan.ts');
  const keys = (t) => scanJargon(t).filter((s) => s.key).map((s) => s.key);
  const terms = (t) => scanJargon(t).filter((s) => s.key).map((s) => s.text);
  const joined = (t) => scanJargon(t).map((s) => s.text).join('');

  console.log('jargon: purity');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils/assistant/jargonScan.ts'), 'utf8');
  check('no react or expo imports', !/from\s+['"](react|react-native|expo)/.test(src));

  console.log('jargon: segmentation');
  check('empty text gives no segments', scanJargon('').length === 0);
  check('plain text is one plain segment', JSON.stringify(scanJargon('Nothing to see here.')) === JSON.stringify([{ text: 'Nothing to see here.' }]));
  const s = scanJargon('Pick the x265 copy, it is smaller.');
  check('x265 split out', s.length === 3 && s[1].text === 'x265' && s[1].key === 'x265', s);
  for (const t of ['Pick the x265 copy.', 'WEB-DL 1080p HDR10+ x265', 'The camera was a CAM.', '', 'x265', 'DD+ and DD+5.1']) {
    check(`segments rejoin: ${JSON.stringify(t)}`, joined(t) === t);
  }

  console.log('jargon: longest match first');
  check('WEB-DL is one term, not WEB', JSON.stringify(keys('A WEB-DL copy')) === '["webdl"]', keys('A WEB-DL copy'));
  check('HDR10+ beats HDR10', JSON.stringify(keys('HDR10+ looks good')) === '["hdr10plus"]', keys('HDR10+ looks good'));
  check('DTS-HD beats DTS', JSON.stringify(keys('DTS-HD audio')) === '["dtshd"]', keys('DTS-HD audio'));
  check('Dolby Atmos beats Atmos', JSON.stringify(terms('Dolby Atmos sound')) === '["Dolby Atmos"]', terms('Dolby Atmos sound'));

  console.log('jargon: word boundaries');
  check('x265 inside a word is ignored', keys('boxx2655').length === 0 && keys('ax265b').length === 0);
  check('1080p inside a longer number is ignored', keys('x21080p').length === 0);
  check('term next to punctuation matches', JSON.stringify(keys('(x265), 1080p.')) === '["x265","1080p"]', keys('(x265), 1080p.'));
  check('x265 before a group name hyphen matches', JSON.stringify(keys('Movie.x265-GROUP')) === '["x265"]', keys('Movie.x265-GROUP'));

  console.log('jargon: case');
  check('REMUX matches in any casing', keys('a remux file').length === 1 && keys('A Remux file').length === 1);
  check('lower-case x265 and Blu-ray match', keys('X265 and blu-ray').length === 2, keys('X265 and blu-ray'));
  check('"cam" the word is not CAM', keys('my cam is broken').length === 0);
  check('CAM exact matches', JSON.stringify(keys('That is a CAM copy')) === '["cam"]');
  check('"web" the word is not WEB', keys('search the web for it').length === 0);
  check('"ts" and "tc" lower-case are ignored', keys('the ts and tc files').length === 0);
  check('"multi" the word is ignored, MULTi matches', keys('a multi step plan').length === 0 && keys('MULTi release').length === 1);
  check('aka names match (HEVC, 4K)', JSON.stringify(keys('HEVC at 4K')) === '["hevc","2160p"]', keys('HEVC at 4K'));

  console.log('jargon: several terms in one text');
  check('order and keys', JSON.stringify(keys('1080p WEB-DL x265 10-bit AAC')) === '["1080p","webdl","x265","10bit","aac"]', keys('1080p WEB-DL x265 10-bit AAC'));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall jargon checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
