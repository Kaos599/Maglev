#!/usr/bin/env node
// C-ASSIST-1: release-name vectors and property tests (docs/ASSISTANT_DESIGN.md section 2.12).
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

let failed = 0;
let passed = 0;
function check(name, cond, extra) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const show = (v) => JSON.stringify(v);
const same = (a, b) => show(a) === show(b);

// Fields compared only when listed in `expect`. These are compared with a default when unlisted.
const DEFAULTS = { warnings: [], hdr: [], multiAudio: false, hardcodedSubs: false, interlaced: undefined };

function checkVector(v, parseRelease) {
  const r = parseRelease(v.name);
  const label = `#${v.id} ${v.name || '(empty)'}`;
  const e = v.expect;
  for (const [k, want] of Object.entries(e)) {
    if (k === 'warnings') {
      check(`${label} warnings`, same([...r.warnings].sort(), [...want].sort()), `got ${show(r.warnings)}`);
    } else if (k === 'audio') {
      const ok = r.audio.length === want.length && want.every((w, i) =>
        Object.entries(w).every(([wk, wv]) => r.audio[i][wk] === wv));
      check(`${label} audio`, ok, `got ${show(r.audio)}`);
    } else if (k === 'flags') {
      const got = Object.keys(r.flags).filter((f) => r.flags[f]).sort();
      check(`${label} flags`, same(got, Object.keys(want).sort()), `got ${show(got)}`);
    } else {
      check(`${label} ${k}`, same(r[k], want), `got ${show(r[k])}, want ${show(want)}`);
    }
  }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (k in e) continue;
    check(`${label} unlisted ${k} stays default`, same(r[k], def), `got ${show(r[k])}`);
  }
  if (!('flags' in e)) {
    check(`${label} unlisted flags stay off`, !Object.values(r.flags).some(Boolean), show(r.flags));
  }
  checkTokens(label, r);
}

function checkTokens(label, r) {
  let prevEnd = 0;
  for (const t of r.tokens) {
    check(`${label} token ${t.key} slice`, r.raw.slice(t.start, t.end) === t.text, show(t));
    check(`${label} token ${t.key} bounds`, t.start >= 0 && t.end <= r.raw.length && t.start < t.end, show(t));
    check(`${label} token ${t.key} order`, t.start >= prevEnd, `${t.start} < ${prevEnd}`);
    prevEnd = Math.max(prevEnd, t.end);
  }
}

// Small deterministic PRNG so failures reproduce.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const { parseRelease, TOKEN_KEYS } = await import('../utils/assistant/releaseName.ts');
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/assistant/release-vectors.json'), 'utf8'));

  check('spec vectors 1..23 all present', [...Array(23)].every((_, i) => vectors.some((v) => v.id === i + 1)));
  check('at least 20 extra vectors', vectors.length >= 43, `have ${vectors.length}`);
  for (const v of vectors) checkVector(v, parseRelease);

  // (a) garbage
  const g = parseRelease('asdf qwer');
  check('garbage is low confidence', g.confidence === 'low' && g.source === 'unknown' && g.codec === 'unknown');
  for (const bad of [undefined, null, 42, {}, [], NaN]) {
    let r;
    try { r = parseRelease(bad); } catch { r = null; }
    check(`non-string ${String(bad)} does not throw`, r !== null && r.confidence === 'low');
  }
  // (c) the spec's 1917 example
  const n = parseRelease('1917.2019.1080p.BluRay.x264-VOLT');
  check('1917 title and 2019 year', n.title === '1917' && n.year === 2019);
  // title that is only a year-like number
  const only = parseRelease('2012.1080p.BluRay.x264-VOLT');
  check('lone 2012 is the title, not a year', only.title === '2012' && only.year === undefined, show([only.title, only.year]));
  // future year is not a year
  const fut = parseRelease('Blade.Runner.2049.1080p.BluRay.x264-VOLT');
  check('2049 stays in the title', fut.title === 'Blade Runner 2049' && fut.year === undefined, show([fut.title, fut.year]));
  // traps
  check('HDRip is not HDR', same(parseRelease('Movie.2020.HDRip.x264-A').hdr, []));
  check('DVDRip is not DV', !parseRelease('Movie.2020.DVDRip.x264-A').hdr.includes('dv'));
  check('.TS with HDTV is a container', parseRelease('Show.S01E01.HDTV.x264-A.ts').source === 'hdtv');
  check('DoVi is Dolby Vision', parseRelease('Movie.2020.2160p.WEB-DL.DoVi.H.265-A').hdr.includes('dv'));
  check('Dolby.Vision is Dolby Vision', parseRelease('Movie.2020.2160p.WEB-DL.Dolby.Vision.H.265-A').hdr.includes('dv'));

  // token keys the parser emits are all declared (the glossary test in step 2 relies on this)
  const declared = new Set(TOKEN_KEYS);
  const seen = new Set();
  for (const v of vectors) for (const t of parseRelease(v.name).tokens) seen.add(t.key);
  for (const k of seen) check(`token key ${k} is declared in TOKEN_KEYS`, declared.has(k));

  // property tests
  const rnd = mulberry32(20240607);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const alphabet = 'abcXYZ019 ._-[]()+/\\é中😀HDVSEx';
  const vocab = ['WEB-DL', 'WEBRip', 'HDTV', 'BluRay', 'REMUX', 'x264', 'x265', 'H.264', 'HEVC', 'DV', 'HDR', 'HDR10+',
    'S01E02', 'S01', '1080p', '720p', '2160p', '2019', '1917', 'TS', 'CAM', 'DDP5.1', 'DTS-HD.MA', 'Atmos', '5.1', 'AAC',
    'PROPER', 'iNTERNAL', 'MULTi', 'HC', '-GRP', '[GrpX]', '[A1B2C3D4]', '.mkv', '.ts', '.rar', 'Title', 'The', ' - 07', '1x04',
    'Season 2', 'COMPLETE', 'NF', 'Hi10P', '10bit', '/', 'Folder/', '\\'];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    if (i % 2 === 0) {
      const len = Math.floor(rnd() * 60);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    } else {
      const len = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < len; j++) s += pick(vocab) + pick(['.', ' ', '_', '-', '', '.']);
    }
    let r;
    try { r = parseRelease(s); } catch (err) { check(`random ${show(s)} threw`, false, String(err)); continue; }
    check(`random ${show(s)} raw preserved`, r.raw === s);
    checkTokens(`random ${show(s)}`, r);
    check(`random ${show(s)} shape`, Array.isArray(r.warnings) && Array.isArray(r.hdr) && Array.isArray(r.audio)
      && ['high', 'medium', 'low'].includes(r.confidence), '');
    for (const t of r.tokens) check(`random ${show(s)} key ${t.key} declared`, declared.has(t.key), t.key);
  }
  // huge input stays bounded and valid
  const big = 'A.'.repeat(50000) + '1080p.x264-GRP';
  let br;
  try { br = parseRelease(big); } catch { br = null; }
  check('huge input does not throw', br !== null);
  if (br) checkTokens('huge', br);

  // ---------------------------------------------------------------- non-Latin titles and season ranges
  {
    const t = (name) => parseRelease(name);
    check('jp title kept', t('進撃の巨人 S02 1080p WEB-DL').title === '進撃の巨人');
    check('jp title with year', t('鬼滅の刃 2019 1080p BluRay x264-GRP').title === '鬼滅の刃' && t('鬼滅の刃 2019 1080p BluRay x264-GRP').year === 2019);
    check('anime group + jp title', t('[SubsPlease] 鬼滅の刃 - 07 (1080p)').title === '鬼滅の刃');
    check('hindi title kept', t('हम आपके हैं कौन 1994 1080p BluRay').title === 'हम आपके हैं कौन' && t('हम आपके हैं कौन 1994 1080p BluRay').year === 1994);
    check('cyrillic title kept', t('Игра престолов S02 1080p').title === 'Игра престолов');
    check('arabic title kept', t('مسلسل الحفرة S01 720p').title === 'مسلسل الحفرة');
    const mixed = t('Attack on Titan / 進撃の巨人 2013 1080p BluRay x264-GRP');
    check('mixed title keeps both halves', mixed.title === 'Attack on Titan / 進撃の巨人' && mixed.year === 2013, JSON.stringify(mixed.title));
    check('real path still splits', t('Show.S01.1080p/Show.S01E02.1080p.mkv').episodes?.[0] === 2);
    const range = (name) => { const r = t(name); return [r.season, JSON.stringify(r.seasons), r.seasonPack, r.completeSeries === true]; };
    check('S01-S05', JSON.stringify(range('Show S01-S05 1080p')) === JSON.stringify([1, '[1,2,3,4,5]', true, false]), JSON.stringify(range('Show S01-S05 1080p')));
    check('S01-05', t('Show S01-05 1080p').seasons?.join() === '1,2,3,4,5');
    check('Season 1-3', t('Show Season 1-3 720p').seasons?.join() === '1,2,3' && t('Show Season 1-3 720p').title === 'Show');
    check('Seasons 1 to 3', t('Show Seasons 1 to 3 720p').seasons?.join() === '1,2,3');
    check('S01-S03 Complete', t('Show S01-S03 Complete 1080p').seasons?.join() === '1,2,3' && t('Show S01-S03 Complete 1080p').seasonPack);
    check('S01.S02.S03', t('Show.S01.S02.S03.1080p').seasons?.join() === '1,2,3');
    const cs = t('Show Complete Series 1080p BluRay');
    check('Complete Series is a pack with a clean title', cs.title === 'Show' && cs.completeSeries === true && cs.seasonPack && cs.seasons === undefined, JSON.stringify(cs.title));
    check('single season has no seasons list', t('Show S02 1080p').seasons === undefined && t('Show S02 1080p').season === 2);
    check('S01E02 unchanged', t('Show S01E02 1080p').season === 1 && t('Show S01E02 1080p').seasons === undefined);
  }

  console.log(`${passed} checks passed, ${vectors.length} vectors`);
  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant release-name tests passed');
}
main();
