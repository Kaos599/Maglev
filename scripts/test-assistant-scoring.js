#!/usr/bin/env node
// Scoring, size bands and shortlist (docs/ASSISTANT_DESIGN.md §3.3, §3.5, §3.6). No network.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 10, 12);

const PROVIDERS = new Map([
  ['knaben', { name: 'Knaben' }],
  ['ia', { name: 'Internet Archive' }],
  ['tpb', { name: 'The Pirate Bay', unsafeReason: 'Many fake uploads' }],
]);

let hashN = 0;
function row(name, sizeBytes, seeders, sources = ['knaben'], extra = {}) {
  hashN++;
  return {
    providerId: sources[0], name, infoHash: String(hashN).padStart(40, '0'), magnet: `magnet:?xt=urn:btih:${hashN}`,
    sizeBytes, seeders, sources, category: 'movies', ...extra,
  };
}

function baseCtx(over = {}) {
  return {
    profile: 'phone', freeBytes: 20 * GB, pendingNeed: 0, stagingFactor: 1, warnUnsafe: true,
    providers: PROVIDERS, query: { title: 'The Last Harbor', year: 2023 }, now: NOW, ...over,
  };
}

const LABELS = ['best-fit', 'smaller', 'best-quality'];
const REASON_RE = new RegExp(
  '^(WEB-DL|WEBRip|WEB|BluRay|Remux|HDTV|HDRip|DVDRip|CAM|TS|TC|SCR|Unknown)( \\d+p)?( [\\w.\\-]+)?( 10-bit)?, '
  + '(\\d+(\\.\\d)? [KMGT]?B|size unknown), (\\d+ seeders?|no seeder count), '
  + "(fits with .+ to spare|fits, leaves .+ free|doesn't fit by .+|fit unknown)$",
);

async function main() {
  const { sizeBand, lowGbPerHour, TOO_SMALL_FRACTION } = await import('../utils/assistant/sizeBands.ts');
  const { scoreResults } = await import('../utils/assistant/scoring.ts');
  const { checkFileSafety } = await import('../utils/assistant/fileSafety.ts');

  // ---------------------------------------------------------------- size bands (§3.3 table)
  const table = [
    [480, 'avc', 0.4, 1.5], [720, 'avc', 0.8, 2.5], [720, 'hevc', 0.4, 1.6], [1080, 'avc', 1.5, 5],
    [1080, 'hevc', 0.9, 3.5], [2160, 'hevc', 4, 15], [1080, 'remux', 15, 40], [2160, 'remux', 25, 80],
  ];
  for (const [res, codec, low, high] of table) {
    const b = sizeBand(res, codec);
    check(`band ${res}p ${codec}: ${low}-${high}`, b && b.low === low && b.high === high, JSON.stringify(b));
  }
  check('band: 2160 avc falls back to the hevc row', sizeBand(2160, 'avc').low === 4);
  check('band: 480 hevc falls back to the avc row', sizeBand(480, 'hevc').low === 0.4);
  check('band: 576 uses the 480 row', sizeBand(576, 'avc').low === 0.4);
  check('band: 720 remux has no row', sizeBand(720, 'remux') === undefined);
  check('band: unknown resolution has no row', sizeBand(undefined, 'avc') === undefined);
  check('lowGbPerHour matches', lowGbPerHour(1080, 'avc') === 1.5);
  check('too-small fraction is 0.6', TOO_SMALL_FRACTION === 0.6);

  // ---------------------------------------------------------------- §3.6 item 1: 12-row fixture
  const rows = {
    webdl265: row('The.Last.Harbor.2023.1080p.WEB-DL.DDP5.1.x265-GRP', 2.1 * GB, 340),
    bluray264: row('The.Last.Harbor.2023.1080p.BluRay.x264-GRP', 7 * GB, 8),
    uhd: row('The.Last.Harbor.2023.2160p.WEB-DL.DDP5.1.HDR.HEVC-GRP', 25 * GB, 120),
    remux: row('The.Last.Harbor.2023.1080p.BluRay.REMUX.AVC.TrueHD.7.1-GRP', 30 * GB, 60),
    small720: row('The.Last.Harbor.2023.720p.WEBRip.x264-YTS', 1.0 * GB, 50),
    cam: row('The.Last.Harbor.2023.HDCAM.x264.AC3-LUMEN', 1.4 * GB, 900),
    ts: row('The.Last.Harbor.2023.HDTS.x264-NOGRP', 1.6 * GB, 400),
    fake: row('The.Last.Harbor.2023.1080p.WEB-DL.x264-FAKE', 38 * MB, 12),
    tpbOnly: row('The.Last.Harbor.2023.1080p.WEBRip.x265-GRP', 1.8 * GB, 800, ['tpb']),
    sequel: row('The.Last.Harbor.2.2025.1080p.WEB-DL.x265-GRP', 2 * GB, 200),
    oldYear: row('The.Last.Harbor.2019.1080p.WEB-DL.x265-GRP', 2 * GB, 200),
    noSize: row('The.Last.Harbor.2023.1080p.WEB-DL.x265-NOSIZE', undefined, undefined, ['ia']),
  };
  const list = Object.values(rows);
  check('fixture has 12 rows', list.length === 12);
  const out = scoreResults(list, baseCtx());
  const idOf = (key) => `r${list.indexOf(rows[key]) + 1}`;
  const rankedIds = out.ranked.map((r) => r.id);
  const wantOrder = ['webdl265', 'bluray264', 'tpbOnly', 'small720', 'noSize', 'uhd', 'fake', 'remux'].map(idOf);
  check('ranking is as expected', JSON.stringify(rankedIds) === JSON.stringify(wantOrder), rankedIds.join(','));
  const shortIds = out.shortlist.map((r) => `${r.id}:${r.label}`);
  const wantShort = [`${idOf('webdl265')}:best-fit`, `${idOf('small720')}:smaller`, `${idOf('bluray264')}:best-quality`];
  check('shortlist labels are as expected', JSON.stringify(shortIds) === JSON.stringify(wantShort), shortIds.join(','));
  check('shortlist has at most 3 rows', out.shortlist.length <= 3);
  check('labels come from the fixed set', out.ranked.every((r) => r.labels.every((l) => LABELS.includes(l))));
  check('every score is 0..100', out.ranked.every((r) => Number.isInteger(r.score) && r.score >= 0 && r.score <= 100));
  const top = out.ranked[0];
  check('top row is recommended', top.tier === 'recommended', top.tier);

  // ---------------------------------------------------------------- item 2: CAM/TS never shortlisted
  const exIds = out.excluded.map((e) => e.id);
  check('CAM row is in excluded as cam_source', out.excluded.some((e) => e.id === idOf('cam') && e.reason === 'cam_source'));
  check('TS row is in excluded as cam_source', out.excluded.some((e) => e.id === idOf('ts') && e.reason === 'cam_source'));
  check('CAM/TS are not in ranked or shortlist', ![idOf('cam'), idOf('ts')].some((id) => rankedIds.includes(id) || out.shortlist.some((s) => s.id === id)));
  check('sequel and wrong-year rows are excluded as wrong_title',
    [idOf('sequel'), idOf('oldYear')].every((id) => out.excluded.some((e) => e.id === id && e.reason === 'wrong_title')), exIds.join(','));
  check('every excluded row has a plain detail', out.excluded.every((e) => e.detail.length > 0 && !/undefined|NaN/.test(e.detail)));
  const early = scoreResults([rows.cam, rows.ts], baseCtx({ allowEarlySources: true }));
  check('"earliest possible" keeps CAM and TS', early.excluded.length === 0 && early.ranked.length === 2);
  const tc = scoreResults([row('The.Last.Harbor.2023.TC.x264-GRP', 1.4 * GB, 10), row('The.Last.Harbor.2023.DVDSCR.x264-GRP', 1.4 * GB, 10)], baseCtx());
  check('TC and SCR are excluded too', tc.excluded.length === 2 && tc.ranked.length === 0);

  // ---------------------------------------------------------------- item 3: 38 MB "1080p"
  const fake = out.ranked.find((r) => r.id === idOf('fake'));
  check('38 MB 1080p gets too_small_for_claim', fake.flags.includes('too_small_for_claim'), fake.flags.join(','));
  check('38 MB 1080p is "avoid" and never shortlisted', fake.tier === 'avoid' && !out.shortlist.includes(fake));

  // ---------------------------------------------------------------- item 4: risky sources
  const hash = '9'.repeat(40);
  const both = { ...row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 2.1 * GB, 500, ['knaben', 'tpb']), infoHash: hash };
  const onlyTpb = row('The.Last.Harbor.2023.1080p.WEB-DL.x265-TPB', 2.1 * GB, 500, ['tpb']);
  const cleanLess = row('The.Last.Harbor.2023.720p.HDTV.x264-GRP', 1.2 * GB, 30, ['knaben']);
  const r4 = scoreResults([onlyTpb, both, cleanLess], baseCtx());
  const rBoth = r4.ranked.find((r) => r.result === both);
  const rTpb = r4.ranked.find((r) => r.result === onlyTpb);
  check('same hash from Knaben and TPB is not risky', !rBoth.flags.includes('risky_source'));
  check('TPB-only is risky', rTpb.flags.includes('risky_source'));
  check('risky row loses 15 points', rTpb.breakdown.penalties === 15 && rBoth.breakdown.penalties === 0);
  check('risky row is never first when a clean row exists', r4.ranked[0].id !== rTpb.id);
  const r4b = scoreResults([onlyTpb, cleanLess], baseCtx());
  check('risky row stays below a weaker clean row', r4b.ranked[0].result === cleanLess, r4b.ranked.map((r) => r.id).join(','));
  check('risky row is never best-fit when a clean one fits', !r4b.shortlist.some((r) => r.result === onlyTpb && r.label === 'best-fit'));
  check('risky row carries a plain reason', rTpb.reasons.some((x) => /unsafe/.test(x) && /Pirate Bay/.test(x)), rTpb.reasons.join(' | '));
  const r4c = scoreResults([onlyTpb], baseCtx({ warnUnsafe: false }));
  check('warnUnsafe off: no risk flag', !r4c.ranked[0].flags.includes('risky_source'));
  const r4d = scoreResults([onlyTpb], baseCtx());
  check('only risky rows: still listed, never recommended', r4d.ranked.length === 1 && r4d.ranked[0].tier !== 'recommended');

  // ---------------------------------------------------------------- item 5: DoesntFit and partial packs
  for (const k of ['uhd', 'remux']) {
    const r = out.ranked.find((x) => x.id === idOf(k));
    check(`${k}: DoesntFit and tier avoid`, r.admission.result === 'DoesntFit' && r.tier === 'avoid', `${r.admission.result}/${r.tier}`);
    check(`${k}: not in shortlist`, !out.shortlist.includes(r));
  }
  check('avoid rows rank last', out.ranked.slice(-3).every((r) => r.tier === 'avoid') && out.ranked.slice(0, -3).every((r) => r.tier !== 'avoid'), rankedIds.join(','));
  const pack = row('Harbor.Light.S01.1080p.WEB-DL.x265-GRP', 40 * GB, 100);
  const pctx = baseCtx({ query: { title: 'Harbor Light', season: 1 }, packEpisodeCounts: new Map([[pack.infoHash, 10]]) });
  const rp = scoreResults([pack], pctx).ranked[0];
  check('pack: whole does not fit', rp.admission.result === 'DoesntFit');
  check('pack: flagged partial_fits', rp.flags.includes('partial_fits'), rp.flags.join(','));
  check('pack: 4 of 10 episodes fit', rp.partialEpisodes === 4, String(rp.partialEpisodes));
  check('pack: still not recommended', rp.tier === 'avoid');
  check('pack: reason says how many fit', rp.reasons.some((x) => /4 episodes would/.test(x)), rp.reasons.join(' | '));
  const small = scoreResults([pack], baseCtx({ ...pctx, freeBytes: 2 * GB })).ranked[0];
  check('pack: no partial flag when not even one episode fits', !small.flags.includes('partial_fits'));
  const noCount = scoreResults([pack], baseCtx({ query: { title: 'Harbor Light', season: 1 } })).ranked[0];
  check('pack: no partial flag when the episode count is unknown', !noCount.flags.includes('partial_fits'));
  check('pack: sanity is neutral when the episode count is unknown', noCount.breakdown.sanity === 5);
  const fitsPack = scoreResults([row('Harbor.Light.S01.1080p.WEB-DL.x265-GRP', 12 * GB, 100)], pctx).ranked[0];
  check('pack: a fitting pack has no partial flag', !fitsPack.flags.includes('partial_fits'));

  // ---------------------------------------------------------------- item 6: reasons[0] template
  for (const r of out.ranked) {
    check(`reasons[0] matches template (${r.id})`, REASON_RE.test(r.reasons[0]), r.reasons[0]);
  }
  check('example: WEB-DL 1080p x265 row text', out.ranked[0].reasons[0].startsWith('WEB-DL 1080p x265, 2.1 GB, 340 seeders, fits with '), out.ranked[0].reasons[0]);
  const ns = out.ranked.find((r) => r.id === idOf('noSize'));
  check('no seeder count wording', /no seeder count/.test(ns.reasons[0]), ns.reasons[0]);
  const doesnt = out.ranked.find((r) => r.id === idOf('uhd'));
  check("doesn't fit wording", /, doesn't fit by [\d.]+ GB$/.test(doesnt.reasons[0]), doesnt.reasons[0]);
  const tight = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 19 * GB, 50)], baseCtx()).ranked[0];
  check('tight wording', tight.admission.result === 'Tight' && /fits, leaves [\d.]+ [MG]B free$/.test(tight.reasons[0]), tight.reasons[0]);
  const ten = scoreResults([row('The.Last.Harbor.2023.1080p.BluRay.10bit.x265-GRP', 3 * GB, 50)], baseCtx()).ranked[0];
  check('10-bit wording', /^BluRay 1080p x265 10-bit, /.test(ten.reasons[0]), ten.reasons[0]);

  // ---------------------------------------------------------------- unknown size
  check('size_unknown flagged', ns.flags.includes('size_unknown') && ns.admission === null);
  check('size_unknown sanity is 5 of 10', ns.breakdown.sanity === 5);
  check('size_unknown is never recommended or labelled', ns.tier !== 'recommended' && ns.labels.length === 0, ns.tier);

  // ---------------------------------------------------------------- score components
  const w = out.ranked.find((r) => r.id === idOf('webdl265'));
  check('breakdown: webdl 1080p x265 phone', w.breakdown.quality === 37 && w.breakdown.playability === 18 && w.breakdown.health === 20
    && w.breakdown.sanity === 10 && w.breakdown.fit === 10, JSON.stringify(w.breakdown));
  check('score is the sum of parts', w.score === 95, String(w.score));
  const remuxRow = row('The.Last.Harbor.2023.1080p.BluRay.REMUX.AVC-GRP', 22 * GB, 50);
  const rm = (profile, free) => scoreResults([remuxRow], baseCtx({ profile, freeBytes: free })).ranked[0];
  check('remux scores lower on phone than on archive (source 16 vs 24)', rm('archive', 50 * GB).breakdown.quality - rm('phone', 50 * GB).breakdown.quality === 8);
  const uhdRow = row('The.Last.Harbor.2023.2160p.WEB-DL.x265-GRP', 10 * GB, 50);
  const q = (profile) => scoreResults([uhdRow], baseCtx({ profile, freeBytes: 50 * GB })).ranked[0].breakdown.quality;
  check('2160p resolution points: 10 on phone, 12 on tv', q('tv') - q('phone') === 2, `${q('phone')} ${q('tv')}`);
  const hc = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265.HC-GRP', 2 * GB, 50)], baseCtx()).ranked[0];
  check('hardcoded subs: -2 and flagged', hc.breakdown.playability === 16 && hc.flags.includes('hardcoded_subs'), JSON.stringify(hc.breakdown));
  const noHevc = scoreResults([rows.webdl265], baseCtx({ playback: { hevc: false, hevc10: false, av1: 'software', dv: false } })).ranked[0];
  check('probe says no HEVC: playability 10', noHevc.breakdown.playability === 10, String(noHevc.breakdown.playability));
  const hi10 = scoreResults([row('The.Last.Harbor.2023.1080p.BluRay.Hi10P-GRP', 5 * GB, 50)], baseCtx()).ranked[0];
  check('avc 10-bit: playability 8', hi10.breakdown.playability === 8, String(hi10.breakdown.playability));
  const dv = scoreResults([row('The.Last.Harbor.2023.2160p.WEB-DL.DV.x265-GRP', 10 * GB, 50)], baseCtx({ playback: { hevc: true, hevc10: true, av1: 'hardware', dv: false } })).ranked[0];
  check('dv without fallback and no DV decode: -8 and flagged', dv.breakdown.playability === 10 && dv.flags.includes('dv_no_fallback'), JSON.stringify(dv.breakdown));
  const old = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 2 * GB, 3, ['knaben'], { publishedAt: NOW - 3 * 365 * 86400000 })], baseCtx()).ranked[0];
  check('old and few seeders: health 4 - 3 = 1', old.breakdown.health === 1, String(old.breakdown.health));
  const big = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 12 * GB, 50)], baseCtx({ freeBytes: 50 * GB })).ranked[0];
  check('above the band: bigger_than_needed, sanity 6', big.flags.includes('bigger_than_needed') && big.breakdown.sanity === 6);
  const slim = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 2.5 * GB, 50)], baseCtx()).ranked[0];
  check('below the band but over 0.6x: small_for_quality, sanity 5', slim.flags.includes('small_for_quality') && slim.breakdown.sanity === 5, JSON.stringify(slim.breakdown));

  // ---------------------------------------------------------------- other hard rules and inputs
  const adult = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 2 * GB, 50, ['knaben'], { category: 'adult' })], baseCtx());
  check('adult category is always excluded', adult.ranked.length === 0 && adult.excluded[0].reason === 'adult');
  const adultCam = scoreResults([row('The.Last.Harbor.2023.HDCAM.x264-GRP', 2 * GB, 50, ['knaben'], { category: 'adult' })], baseCtx({ allowEarlySources: true }));
  check('adult stays excluded even with allowEarlySources', adultCam.ranked.length === 0);
  const cap = scoreResults([rows.bluray264, rows.webdl265], baseCtx({ maxBytes: 5 * GB })).ranked;
  check('maxBytes: bigger row is flagged and avoided', cap.find((r) => r.result === rows.bluray264).tier === 'avoid'
    && cap.find((r) => r.result === rows.bluray264).flags.includes('over_size_cap'));
  const part2 = scoreResults(
    [row('Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP', 2 * GB, 50), row('Dune.2021.1080p.WEB-DL.x265-GRP', 2 * GB, 50)],
    baseCtx({ query: { title: 'Dune Part Two', year: 2024 } }),
  );
  check('sequel query needs every title token', part2.ranked.length === 1 && part2.excluded.length === 1 && /Part\.Two/.test(part2.ranked[0].result.name));
  const dune = scoreResults(
    [row('Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP', 2 * GB, 50), row('Dune.2021.1080p.WEB-DL.x265-GRP', 2 * GB, 50)],
    baseCtx({ query: { title: 'Dune' } }),
  );
  check('"Dune" does not match "Dune Part Two"', dune.ranked.length === 1 && /Dune\.2021/.test(dune.ranked[0].result.name));
  const article = scoreResults([row('Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 2 * GB, 50)], baseCtx());
  check('a leading "The" does not change the match', article.ranked.length === 1);
  const eps = scoreResults(
    [row('Harbor.Light.S01E02.1080p.WEB-DL.x265-GRP', 1 * GB, 50), row('Harbor.Light.S01E03.1080p.WEB-DL.x265-GRP', 1 * GB, 50)],
    baseCtx({ query: { title: 'Harbor Light', season: 1, episode: 2 } }),
  );
  check('episode query drops other episodes', eps.ranked.length === 1 && eps.excluded.length === 1);
  const dup = scoreResults(
    [row('The.Last.Harbor.2023.1080p.WEB-DL.x265-AAA', 2 * GB, 50), row('The.Last.Harbor.2023.1080p.WEB-DL.x265-BBB', 2 * GB, 500)],
    baseCtx(),
  );
  check('same release from two groups: one shortlist row', dup.ranked.length === 2 && dup.shortlist.length === 1);
  check('no results: empty output', (() => { const e = scoreResults([], baseCtx()); return !e.ranked.length && !e.shortlist.length && !e.excluded.length; })());
  check('no Fits at all: shortlist can still hold a Tight best-quality row',
    (() => { const t = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 19 * GB, 50)], baseCtx()); return t.shortlist.length === 1 && t.shortlist[0].label === 'best-quality'; })());

  // ---------------------------------------------------------------- item 7: fake-file fixtures
  const movie = (files, name = 'The.Last.Harbor.2023.1080p.WEB-DL.x265') => checkFileSafety({ name, category: 'movie', files });
  const mkv = { path: 'Harbor/Harbor.2023.1080p.mkv', sizeBytes: 2.1 * GB };
  check('fake files: exe is red', movie([mkv, { path: 'Harbor/Setup.exe', sizeBytes: MB }]).level === 'red');
  check('fake files: lnk plus subtitle is red', movie([mkv, { path: 'Harbor/CD.lnk', sizeBytes: 1024 }, { path: 'Harbor/Harbor.srt', sizeBytes: 50000 }]).level === 'red');
  check('fake files: rar plus password.txt is amber or red',
    ['amber', 'red'].includes(movie([{ path: 'Harbor/Harbor.part1.rar', sizeBytes: 2 * GB }, { path: 'Harbor/password.txt', sizeBytes: 100 }]).level));
  check('fake files: apk in a movie is red', movie([mkv, { path: 'Harbor/player.apk', sizeBytes: 8 * MB }]).level === 'red');
  check('fake files: clean mkv plus srt is green', movie([mkv, { path: 'Harbor/Harbor.srt', sizeBytes: 50000 }]).level === 'green');

  // ---------------------------------------------------------------- purity
  for (const file of ['scoring.ts', 'sizeBands.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'assistant', file), 'utf8');
    const imports = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const forbidden = imports.filter((p) => /react|engine|maglev|modules\//i.test(p));
    check(`${file} imports no React or engine modules`, forbidden.length === 0, forbidden.join(', '));
  }
  const fsSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'assistant', 'fileSafety.ts'), 'utf8');
  check('fileSafety.ts imports the bands from sizeBands.ts', /from '\.\/sizeBands\.ts'/.test(fsSrc) && !/LOW_GB_PER_HOUR/.test(fsSrc));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant scoring tests passed');
}
main();
