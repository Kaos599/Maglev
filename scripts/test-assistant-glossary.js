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

// A bracketed re-definition is a chip label of another entry followed by an
// opening bracket, e.g. "HDR10 (the most common format)". The UI links other
// terms as chips, so a plain label needs no bracket; a bracket after one is flagged.
function bracketedLabels(text, ownLabel, labels) {
  const hits = [];
  for (const label of labels) {
    if (label === ownLabel) continue;
    const re = new RegExp(`(?<![A-Za-z0-9.+-])${escapeRe(label)}(?![A-Za-z0-9+-])\\s*\\(`, 'g');
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

const allText = (e) => [e.label, e.plain, e.tradeoff ?? '', e.phoneNote ?? ''].join(' ');

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
  console.log('glossary: no bracketed re-definitions');
  for (const k of entryKeys) {
    const e = GLOSSARY[k];
    const hits = bracketedLabels(allText(e), e.label, chipLabels);
    check(`${k}: no bracket explaining another term`, hits.length === 0, hits);
    check(`${k}: no brackets in plain`, !e.plain.includes('('), e.plain);
  }

  console.log('glossary: aka fields');
  const akaKeys = entryKeys.filter((k) => GLOSSARY[k].aka !== undefined);
  check('some entries carry aka', akaKeys.length >= 8, akaKeys.length);
  for (const k of akaKeys) {
    const { aka, label } = GLOSSARY[k];
    const ok = Array.isArray(aka) && aka.every((a) => typeof a === 'string' && a.trim().length > 0) &&
      new Set(aka).size === aka.length && !aka.includes(label);
    check(`${k}: aka is a list of distinct non-empty names other than the label`, ok, aka);
  }
  const hasAka = (k, want) => (GLOSSARY[k].aka ?? []).includes(want);
  check('hevc aka is HEVC (x265 is an encoder with its own entry)', hasAka('hevc', 'HEVC') && !hasAka('hevc', 'x265'));
  check('avc aka has AVC', hasAka('avc', 'AVC'));
  check('dv aka has DoVi and DV', hasAka('dv', 'DoVi') && hasAka('dv', 'DV'));

  console.log('glossary: labels');
  const pinned = { remux: 'REMUX', mpeg2: 'MPEG-2', vc1: 'VC-1', avc: 'H.264', hevc: 'H.265', webdl: 'WEB-DL', webrip: 'WEBRip', bluray: 'BluRay' };
  for (const [k, label] of Object.entries(pinned)) {
    check(`${k}: label is ${label}`, GLOSSARY[k].label === label, GLOSSARY[k].label);
  }

  console.log('glossary: rewrite rules');
  for (const k of entryKeys) {
    const e = GLOSSARY[k];
    check(`${k}: no lossy`, !/lossy/i.test(allText(e)));
    check(`${k}: no seeder wording (use sharing)`, !/seeder/i.test(allText(e)));
    check(`${k}: no hardware or software decoding phrasing`, !/(hardware|software) decod/i.test(allText(e)));
    check(`${k}: no first person`, !/\b(i|i'm|i'd|we|we're|me|my|mine|our|ours|us|let's)\b/i.test(allText(e)));
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
