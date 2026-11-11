#!/usr/bin/env node
// Glossary contract (ASSISTANT_DESIGN §2.11, §10 row 2). Pure TS, no network.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
let passed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A jargon hit is a chip label used inside another entry's plain text without
// a parenthesised explanation right after it, e.g. "WEB-DL (taken as sent)".
function unexplainedLabels(plain, ownLabel, labels) {
  const hits = [];
  for (const label of labels) {
    if (label === ownLabel) continue;
    const re = new RegExp(`(?<![A-Za-z0-9.+-])${escapeRe(label)}(?![A-Za-z0-9+-])`, 'g');
    let m;
    while ((m = re.exec(plain)) !== null) {
      const after = plain.slice(m.index + label.length);
      if (!/^ \(/.test(after)) hits.push(label);
    }
  }
  return hits;
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// Expected chip labels, in order, for release-vectors.json names.
const CHIP_VECTORS = [
  { id: 1, labels: ['1080p', 'WEB-DL', 'DD+', 'Atmos', 'H.265'] },
  { id: 3, labels: ['2160p', 'BluRay', 'REMUX', 'HDR10', 'H.265', 'TrueHD', 'Atmos'] },
  { id: 4, labels: ['CAM', 'x264', 'AC3'] },
  { id: 14, labels: ['2160p', 'WEB-DL', 'Dolby Vision', 'H.265', 'DD+'] },
  { id: 17, labels: ['BluRay', '1080p', 'Hi10P', 'FLAC', 'Multi-audio'] },
  { id: 18, labels: ['720p', 'HDRip', 'Burned-in subs', 'x264', 'AAC'] },
  { id: 19, labels: ['Multi-audio', '1080p', 'WEB', 'x264'] },
  { id: 22, labels: ['1080p', 'HDTV', 'MPEG-2'] },
];

async function main() {
  const { GLOSSARY, explain, chipsFor } = await import('../utils/assistant/glossary.ts');
  const { TOKEN_KEYS, parseRelease } = await import('../utils/assistant/releaseName.ts');

  console.log('glossary: coverage');
  const entryKeys = Object.keys(GLOSSARY);
  const missing = TOKEN_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(GLOSSARY, k));
  check('every TOKEN_KEYS key has an entry', missing.length === 0, missing);
  const extra = entryKeys.filter((k) => !TOKEN_KEYS.includes(k));
  check('no entry without a TOKEN_KEYS key', extra.length === 0, extra);
  check('TOKEN_KEYS has no duplicates', new Set(TOKEN_KEYS).size === TOKEN_KEYS.length);

  console.log('glossary: entry shape');
  const badShape = entryKeys.filter((k) => {
    const e = GLOSSARY[k];
    return typeof e.label !== 'string' || e.label.length === 0 || typeof e.plain !== 'string' ||
      typeof e.chip !== 'boolean';
  });
  check('every entry has label, plain and chip', badShape.length === 0, badShape);

  console.log('glossary: plain text');
  for (const k of entryKeys) {
    const n = wordCount(GLOSSARY[k].plain);
    check(`${k}: plain is under 40 words (${n})`, n < 40, n);
  }

  const chipLabels = entryKeys.filter((k) => GLOSSARY[k].chip).map((k) => GLOSSARY[k].label);
  for (const k of entryKeys) {
    const e = GLOSSARY[k];
    const hits = unexplainedLabels(e.plain, e.label, chipLabels);
    check(`${k}: no unexplained jargon label in plain`, hits.length === 0, hits);
  }

  console.log('glossary: wording');
  const banned = /\b(safe|safer|safest|best|guarantee|guaranteed)\b/i;
  for (const k of entryKeys) {
    const e = GLOSSARY[k];
    const text = [e.label, e.plain, e.tradeoff ?? '', e.phoneNote ?? ''].join(' ');
    check(`${k}: no safe, best or guaranteed`, !banned.test(text), text.match(banned)?.[0]);
    check(`${k}: no exclamation mark`, !text.includes('!'));
  }

  console.log('glossary: explain and chipsFor');
  check('explain returns the entry', explain('x265')?.label === 'x265');
  check('explain returns undefined for an unknown key', explain('nope') === undefined);
  check('explain ignores prototype keys', explain('constructor') === undefined);
  const dup = chipsFor({ tokens: [{ key: 'cam' }, { key: 'cam' }, { key: 'year' }, { key: 'x265' }] });
  check('chipsFor dedupes and drops non-chip keys', dup.map((c) => c.label).join('|') === 'CAM|x265', dup);
  check('chipsFor on empty tokens returns []', chipsFor({ tokens: [] }).length === 0);

  const vectors = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'assistant', 'release-vectors.json'), 'utf8'),
  );
  for (const want of CHIP_VECTORS) {
    const v = vectors.find((x) => x.id === want.id);
    if (!v) {
      check(`vector ${want.id} exists`, false);
      continue;
    }
    const got = chipsFor(parseRelease(v.name)).map((c) => c.label);
    check(`vector ${want.id}: chips in order`, JSON.stringify(got) === JSON.stringify(want.labels), {
      got,
      want: want.labels,
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
