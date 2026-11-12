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
  '^([A-Za-z0-9.\\- ]+, )?'
  + '(\\d+(\\.\\d)? [KMGT]?B|size unknown), (\\d+ sharing|no sharing count), '
  + "(fits with .+ to spare|fits, leaves .+ free|doesn't fit by .+|fit unknown)$",
);

async function main() {
  const { sizeBand, lowGbPerHour, TOO_SMALL_FRACTION, SMALL_FRACTION } = await import('../utils/assistant/sizeBands.ts');
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
  check('too-small fraction is 0.25 and small fraction 0.5 (R1-13)', TOO_SMALL_FRACTION === 0.25 && SMALL_FRACTION === 0.5);

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
  const idOf = (key) => rows[key].infoHash; // rows are keyed by info hash (R1-10)
  const rankedIds = out.ranked.map((r) => r.id);
  const wantOrder = ['webdl265', 'bluray264', 'small720', 'tpbOnly', 'noSize', 'uhd', 'fake', 'remux'].map(idOf);
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
  check('example: WEB-DL 1080p x265 row text', out.ranked[0].reasons[0].startsWith('WEB-DL 1080p x265, 2.1 GB, 340 sharing, fits with '), out.ranked[0].reasons[0]);
  const ns = out.ranked.find((r) => r.id === idOf('noSize'));
  check('no sharing count wording', /no sharing count/.test(ns.reasons[0]), ns.reasons[0]);
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
  check('breakdown: webdl 1080p x265 phone', w.breakdown.quality === 37 && w.breakdown.playability === 11 && w.breakdown.health === 20
    && w.breakdown.sanity === 10 && w.breakdown.fit === 10, JSON.stringify(w.breakdown));
  check('score is the sum of parts', w.score === 88, String(w.score));
  const remuxRow = row('The.Last.Harbor.2023.1080p.BluRay.REMUX.AVC-GRP', 22 * GB, 50);
  const rm = (profile, free) => scoreResults([remuxRow], baseCtx({ profile, freeBytes: free })).ranked[0];
  check('remux scores lower on phone than on archive (source 16 vs 24)', rm('archive', 50 * GB).breakdown.quality - rm('phone', 50 * GB).breakdown.quality === 8);
  const uhdRow = row('The.Last.Harbor.2023.2160p.WEB-DL.x265-GRP', 10 * GB, 50);
  const q = (profile) => scoreResults([uhdRow], baseCtx({ profile, freeBytes: 50 * GB })).ranked[0].breakdown.quality;
  check('2160p resolution points: 10 on phone, 12 on tv', q('tv') - q('phone') === 2, `${q('phone')} ${q('tv')}`);
  const hc = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265.HC-GRP', 2 * GB, 50)], baseCtx()).ranked[0];
  check('hardcoded subs: -2 and flagged', hc.breakdown.playability === 9 && hc.flags.includes('hardcoded_subs'), JSON.stringify(hc.breakdown));
  // Playback is the real PlaybackSupport shape and goes through playbackVerdict (R1 item 7).
  const PROBE = { avc: 'hardware', hevc: 'hardware', hevc10: 'hardware', av1: 'none', av1_10: 'none', vp9: 'hardware', dolbyVision: 'hardware', hdr10: true, hdr10plus: false, hlg: true };
  const hwHevc = scoreResults([rows.webdl265], baseCtx({ playback: PROBE })).ranked[0];
  check('probe says hardware HEVC: playability 18', hwHevc.breakdown.playability === 18 && !hwHevc.flags.includes('playback_unknown'), String(hwHevc.breakdown.playability));
  const noProbe = scoreResults([rows.webdl265], baseCtx()).ranked[0];
  check('no probe: unknown never scores as playable (below 18) and is flagged', noProbe.breakdown.playability < 18 && noProbe.flags.includes('playback_unknown'), String(noProbe.breakdown.playability));
  const nullProbe = scoreResults([rows.webdl265], baseCtx({ playback: null })).ranked[0];
  check('null probe scores like no probe', nullProbe.breakdown.playability === noProbe.breakdown.playability);
  const unknownProbe = scoreResults([rows.webdl265], baseCtx({ playback: { ...PROBE, hevc: 'unknown' } })).ranked[0];
  check('probe field "unknown" is not playable either', unknownProbe.breakdown.playability < 18 && unknownProbe.flags.includes('playback_unknown'));
  const softHevc = scoreResults([rows.webdl265], baseCtx({ playback: { ...PROBE, hevc: 'software' } })).ranked[0];
  check('software HEVC: may stutter, playability capped at 10', softHevc.breakdown.playability === 10, String(softHevc.breakdown.playability));
  const noHevc = scoreResults([rows.webdl265], baseCtx({ playback: { ...PROBE, hevc: 'none', hevc10: 'none' } })).ranked[0];
  check('probe says no HEVC: needs another player, playability 4', noHevc.breakdown.playability === 4, String(noHevc.breakdown.playability));
  const hi10 = scoreResults([row('The.Last.Harbor.2023.1080p.BluRay.Hi10P-GRP', 5 * GB, 50)], baseCtx({ playback: PROBE })).ranked[0];
  check('avc 10-bit: playability 8', hi10.breakdown.playability === 8, String(hi10.breakdown.playability));
  const dv = scoreResults([row('The.Last.Harbor.2023.2160p.WEB-DL.DV.x265-GRP', 10 * GB, 50)], baseCtx({ playback: { ...PROBE, dolbyVision: 'none' } })).ranked[0];
  check('dv without fallback and no DV decode: -8 and flagged', dv.breakdown.playability === 10 && dv.flags.includes('dv_no_fallback'), JSON.stringify(dv.breakdown));
  const old = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP', 2 * GB, 3, ['knaben'], { publishedAt: NOW - 3 * 365 * 86400000 })], baseCtx()).ranked[0];
  check('old and few seeders: health 4 - 3 = 1', old.breakdown.health === 1, String(old.breakdown.health));
  const big = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 12 * GB, 50)], baseCtx({ freeBytes: 50 * GB })).ranked[0];
  check('above the band: bigger_than_needed, sanity 6', big.flags.includes('bigger_than_needed') && big.breakdown.sanity === 6);
  // R1-13: amber only below 0.5x the floor (1080p avc floor 1.5 GB/h x 1.83 h = 2.75 GB), red below 0.25x.
  const slim = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 1.2 * GB, 50)], baseCtx()).ranked[0];
  check('below 0.5x the floor: small_for_quality, sanity 5', slim.flags.includes('small_for_quality') && slim.breakdown.sanity === 5, JSON.stringify(slim.breakdown));
  const slimOk = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 2.5 * GB, 50)], baseCtx()).ranked[0];
  check('between 0.5x and 1x the floor: no warning flag', !slimOk.flags.includes('small_for_quality') && !slimOk.flags.includes('too_small_for_claim') && slimOk.breakdown.sanity === 8, JSON.stringify(slimOk.breakdown));
  const tiny = scoreResults([row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 0.6 * GB, 50)], baseCtx()).ranked[0];
  check('below 0.25x the floor: too_small_for_claim, avoid', tiny.flags.includes('too_small_for_claim') && tiny.tier === 'avoid');
  const animeEp = (name, bytes) => scoreResults(
    [row(name, bytes, 50, ['knaben'], { category: 'anime' })], baseCtx({ query: { title: 'Show' } }),
  ).ranked[0];
  const a1 = animeEp('[Grp] Show - 05 [1080p HEVC]', 360 * MB);
  check('anime episode is 24 minutes: 360 MB 1080p HEVC has no size warning', !a1.flags.includes('small_for_quality') && !a1.flags.includes('too_small_for_claim') && a1.breakdown.sanity >= 8, JSON.stringify([a1.flags, a1.breakdown]));
  const film16 = scoreResults([row('The.Last.Harbor.2023.1080p.BluRay.x264-GRP', 1.6 * GB, 50)], baseCtx()).ranked[0];
  check('1.6 GB 1080p BluRay x264 film has no size warning', !film16.flags.includes('small_for_quality') && !film16.flags.includes('too_small_for_claim'), film16.flags.join(','));

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

  // ---------------------------------------------------------------- R1-9: title matching
  const { parseQuery, canPropose, SEEDER_NOTE } = await import('../utils/assistant/scoring.ts');
  const one = (title, name, extra = {}) => scoreResults([row(name, 2 * GB, 50)], baseCtx({ query: { title, ...extra } }));
  const kept = (o) => o.ranked.length === 1 && o.excluded.length === 0;
  check("Schindler's List matches Schindlers.List.1993", kept(one("Schindler's List", 'Schindlers.List.1993.1080p.BluRay.x264-GRP')));
  check('curly apostrophe: Ocean’s Eleven matches Oceans.Eleven', kept(one('Ocean’s Eleven', 'Oceans.Eleven.2001.1080p.BluRay.x264-GRP')));
  check('Ocean’s Eleven matches Ocean.s.Eleven', kept(one('Ocean’s Eleven', 'Ocean.s.Eleven.2001.1080p.BluRay.x264-GRP')));
  check("Ocean's Eleven matches the straight-apostrophe name", kept(one("Ocean's Eleven", "Ocean's.Eleven.2001.1080p.BluRay.x264-GRP")));
  check('a year inside the query title is read as the year', kept(one('Schindlers List 1993', 'Schindlers.List.1993.1080p.BluRay.x264-GRP')));
  check('a year inside the query title still excludes a wrong year', one('Schindlers List 1993', 'Schindlers.List.2005.1080p.BluRay.x264-GRP').excluded.length === 1);
  check('S01 inside the query title is read as the season', kept(one('Harbor Light S01', 'Harbor.Light.S01.1080p.WEB-DL.x265-GRP')));
  check('S01 inside the query title excludes another season', one('Harbor Light S01', 'Harbor.Light.S02.1080p.WEB-DL.x265-GRP').excluded.length === 1);
  check('S01E02 inside the query title excludes another episode', one('Harbor Light S01E02', 'Harbor.Light.S01E03.1080p.WEB-DL.x265-GRP').excluded.length === 1);
  check('a title that is a number survives', kept(one('Blade Runner 2049', 'Blade.Runner.2049.2017.1080p.BluRay.x264-GRP')));
  const partial = one('The Last Harbor Light', 'Last.Harbor.2023.1080p.WEB-DL.x265-GRP', { year: 2023 });
  check('one missing title token: kept with title_partial, tier ok', kept(partial) && partial.ranked[0].flags.includes('title_partial') && partial.ranked[0].tier === 'ok', JSON.stringify(partial.ranked[0] && partial.ranked[0].flags));
  check('title_partial is never recommended', partial.ranked.every((r) => r.tier !== 'recommended') && partial.shortlist.every((r) => r.tier !== 'recommended'));
  check('title_partial explains itself', partial.ranked[0].reasons.some((x) => /one word you searched for is missing/.test(x)));
  check('most tokens missing: excluded', one('Alpha Beta Gamma', 'Alpha.2023.1080p.WEB-DL.x265-GRP').excluded.length === 1);
  check('two missing of four: excluded', one('Alpha Beta Gamma Delta', 'Alpha.Beta.2023.1080p.WEB-DL.x265-GRP').excluded.length === 1);
  check('a one-word title that is missing: excluded', one('Alpha', 'Beta.2023.1080p.WEB-DL.x265-GRP').excluded.length === 1);
  check('exact match carries no title_partial flag', !one('The Last Harbor', 'The.Last.Harbor.2023.1080p.WEB-DL.x265-GRP').ranked[0].flags.includes('title_partial'));
  const pq = (t) => JSON.stringify(parseQuery(t));
  check('parseQuery: plain title', pq('The Last Harbor') === JSON.stringify({ title: 'The Last Harbor' }), pq('The Last Harbor'));
  check('parseQuery: title and year', (() => { const q = parseQuery("Schindler's List 1993"); return q.title === "Schindler's List" && q.year === 1993 && q.season === undefined; })());
  check('parseQuery: season', (() => { const q = parseQuery('Harbor Light S01'); return q.title === 'Harbor Light' && q.season === 1 && q.episode === undefined; })());
  check('parseQuery: season and episode', (() => { const q = parseQuery('Harbor Light S02E05'); return q.title === 'Harbor Light' && q.season === 2 && q.episode === 5; })());
  check('parseQuery: curly apostrophe kept in the title text', parseQuery('Ocean’s Eleven 2001').title === 'Ocean’s Eleven');
  check('parseQuery: a number-only title is a title', parseQuery('1917').title === '1917');
  check('parseQuery: empty text', parseQuery('').title === '');

  // ---------------------------------------------------------------- R1-10: keys are info hashes, no r1 ids
  check('every ranked id is the info hash', out.ranked.every((r) => r.id === r.result.infoHash));
  check('no handle-style ids anywhere', [...out.ranked, ...out.shortlist, ...out.excluded].every((r) => !/^r\d+$/.test(r.id)));
  check('excluded rows are keyed by info hash too', out.excluded.every((e) => e.id === e.result.infoHash));
  const twice = scoreResults([rows.webdl265, rows.webdl265, rows.bluray264], baseCtx());
  check('the same info hash given twice is one row', twice.ranked.length === 2);

  // ---------------------------------------------------------------- dead torrents and fakes
  const dead = row('The.Last.Harbor.2023.1080p.WEB-DL.x265-DEAD', 2.1 * GB, 0);
  const deadOnly = scoreResults([dead], baseCtx());
  check('0 sharing: never recommended', deadOnly.ranked[0].tier !== 'recommended' && deadOnly.ranked[0].tier === 'avoid');
  check('0 sharing: flagged and explained', deadOnly.ranked[0].flags.includes('no_sharing') && deadOnly.ranked[0].reasons.some((x) => /Nobody is sharing/.test(x)));
  check('0 sharing: never best-fit or on the shortlist', deadOnly.shortlist.length === 0 && deadOnly.ranked[0].labels.length === 0);
  const liveAndDead = scoreResults([dead, rows.bluray264], baseCtx());
  check('0 sharing never takes best-fit from a live copy', liveAndDead.shortlist.length === 1 && liveAndDead.shortlist[0].result === rows.bluray264);
  const real = row('The.Last.Harbor.2023.1080p.WEB-DL.x265-REAL', 2.1 * GB, 40);
  const real2 = row('The.Last.Harbor.2023.1080p.WEB-DL.x265-REAL', 2.2 * GB, 30);
  const deadSame = { ...row('The.Last.Harbor.2023.1080p.WEB-DL.x265-REAL', 2.1 * GB, 0) };
  const grp = scoreResults([deadSame, real, real2], baseCtx());
  check('same release, three info hashes: ranked as a group, one shortlist row, never the dead one', grp.ranked.length === 3 && grp.shortlist.length === 1 && grp.shortlist[0].result !== deadSame);
  const fakeBig = row('The.Last.Harbor.2023.1080p.WEB-DL.x265-REAL', 0.9 * GB, 9000);
  const grp2 = scoreResults([fakeBig, real, real2], baseCtx());
  check('a far smaller copy with inflated sharing does not replace the real copies', grp2.shortlist.length >= 1 && grp2.shortlist[0].result !== fakeBig, grp2.shortlist.map((r) => r.result.sizeBytes).join(','));
  const unsafeCtx = baseCtx({ safety: new Map([[rows.webdl265.infoHash, { level: 'red', findings: [{ code: 'program_in_media', level: 'red' }], category: 'video' }]]) });
  const unsafe = scoreResults([rows.webdl265, rows.bluray264], unsafeCtx);
  const unsafeRow = unsafe.ranked.find((r) => r.result === rows.webdl265);
  check('red file-list safety: avoid, flagged, not shortlisted', unsafeRow.tier === 'avoid' && unsafeRow.flags.includes('unsafe_files') && !unsafe.shortlist.includes(unsafeRow));
  check('the red row keeps its safety result for the runner', unsafeRow.safety && unsafeRow.safety.level === 'red');

  // ---------------------------------------------------------------- R1-8: canPropose
  check('canPropose: red safety is refused with a reason', (() => { const c = canPropose(unsafeRow); return c.ok === false && typeof c.reason === 'string' && c.reason.length > 0; })());
  check('canPropose: a stored level of red is refused', canPropose({ level: 'red' }).ok === false && canPropose({ safety: { level: 'red' } }).ok === false);
  check('canPropose: green and amber are allowed', canPropose({ safety: { level: 'green' } }).ok === true && canPropose({ safety: { level: 'amber' } }).ok === true);
  check('canPropose: no stored safety (unchecked) is allowed', canPropose({}).ok === true && canPropose({ safety: null }).ok === true);
  check('canPropose: a file far smaller than the name claims is refused', canPropose(fake).ok === false);
  check('canPropose: an ordinary ranked row is allowed', canPropose(out.ranked[0]).ok === true);
  check('canPropose: nothing at all is allowed (no data, nothing red)', canPropose(undefined).ok === true);

  // ---------------------------------------------------------------- R1-15: copy
  const allReasons = [...out.ranked, tight].flatMap((r) => r.reasons);
  check('reasons say "sharing", never seeders or seeds', allReasons.every((x) => !/seed/i.test(x)), allReasons.find((x) => /seed/i.test(x)));
  check('the out-of-date note is list-level and appears once', out.notes.length === 1 && out.notes[0] === SEEDER_NOTE && !/seed/i.test(SEEDER_NOTE));
  check('the note is not repeated on any row', out.ranked.every((r) => !r.reasons.some((x) => /out of date/.test(x))));
  check('no sharing counts: no list note', scoreResults([rows.noSize], baseCtx()).notes.length === 0);
  check('REMUX label', out.ranked.find((r) => r.id === idOf('remux')).reasons[0].startsWith('REMUX 1080p H.264, '), out.ranked.find((r) => r.id === idOf('remux')).reasons[0]);
  const mp2 = scoreResults([row('The.Last.Harbor.2023.DVDRip.MPEG2-GRP', 1.2 * GB, 40), row('The.Last.Harbor.2023.1080p.BluRay.VC1-GRP', 6 * GB, 40)], baseCtx());
  const heads = mp2.ranked.map((r) => r.reasons[0]).join(' | ');
  check('glossary labels MPEG-2 and VC-1', /MPEG-2/.test(heads) && /VC-1/.test(heads) && !/MPEG2|VC1/.test(heads), heads);
  const noSource = scoreResults([row('The.Last.Harbor.2023.1080p.x265-GRP', 2 * GB, 40)], baseCtx()).ranked[0];
  check('unknown source is left out of the headline', !/unknown/i.test(noSource.reasons[0]) && noSource.reasons[0].startsWith('1080p x265, '), noSource.reasons[0]);
  const copyRows = scoreResults([
    row('The.Last.Harbor.2023.1080p.WEB-DL.x264-GRP', 12 * GB, 50, ['knaben'], {}),
    row('The.Last.Harbor.2023.2160p.WEB-DL.DV.x265-GRP', 10 * GB, 50),
    row('The.Last.Harbor.2023.1080p.BluRay.REMUX.AVC.TrueHD.7.1-GRP', 22 * GB, 50),
    row('The.Last.Harbor.2023.1080p.WEBRip.x265-GRP', 1.8 * GB, 50, ['tpb']),
  ], baseCtx({ freeBytes: 80 * GB })).ranked.flatMap((r) => r.reasons);
  const has = (re) => copyRows.some((x) => re.test(x));
  check('bigger-than-needed copy', has(/would likely look the same on a phone/));
  check('lossless-only audio copy', has(/^The sound track is disc-quality and adds gigabytes a phone can't use\.$/));
  check('Dolby Vision copy', has(/^Dolby Vision only\. On phones without it, colours can look green or purple\.$/));
  check('risky source names Maglev', has(/^Maglev flags The Pirate Bay as unsafe, and only The Pirate Bay lists this one\.$/), copyRows.filter((x) => /Maglev|unsafe/.test(x)).join('|'));

  // ---------------------------------------------------------------- non-Latin titles
  {
    const run = (title, names, extra = {}) => scoreResults(
      names.map((n) => row(n, 2 * GB, 100)), baseCtx({ query: { title, ...extra }, freeBytes: 80 * GB }),
    );
    const keeps = (label, title, name, extra) => {
      const o = run(title, [name], extra);
      check(label, o.ranked.length === 1 && o.excluded.length === 0, JSON.stringify(o.excluded.map((e) => e.detail)));
    };
    const drops = (label, title, name, extra) => {
      const o = run(title, [name], extra);
      check(label, o.ranked.length === 0 && o.excluded[0]?.reason === 'wrong_title');
    };
    keeps('jp kana+kanji kept', '進撃の巨人', '進撃の巨人 S02 1080p WEB-DL x265-GRP', { season: 2 });
    keeps('jp katakana kept', 'ワンピース', '[Group] ワンピース - 1071 (1080p) [ABCD1234].mkv');
    keeps('jp query in mixed release name', '日本語タイトル', 'Title / 日本語タイトル 2023 1080p BluRay x264-GRP');
    keeps('latin query in mixed release name', 'Title', 'Title / 日本語タイトル 2023 1080p BluRay x264-GRP', { year: 2023 });
    keeps('jp substring match (extra words after)', '鬼滅の刃', '鬼滅の刃 無限列車編 2020 1080p BluRay x264-GRP');
    drops('different jp title dropped', '進撃の巨人', '呪術廻戦 S02 1080p WEB-DL x265-GRP', { season: 2 });
    drops('jp title with different year dropped', '鬼滅の刃', '鬼滅の刃 2010 1080p BluRay x264-GRP', { year: 2019 });
    keeps('hindi kept', 'हम आपके हैं कौन', 'हम आपके हैं कौन 1994 1080p BluRay x264-GRP', { year: 1994 });
    drops('different hindi dropped', 'हम आपके हैं कौन', 'दिलवाले दुल्हनिया ले जाएंगे 1995 1080p BluRay x264-GRP');
    keeps('cyrillic kept', 'Игра престолов', 'Игра престолов S02 1080p WEB-DL x265-GRP', { season: 2 });
    keeps('cyrillic case-insensitive', 'игра престолов', 'ИГРА ПРЕСТОЛОВ S02 1080p WEB-DL x265-GRP', { season: 2 });
    drops('different cyrillic dropped', 'Игра престолов', 'Во все тяжкие S02 1080p WEB-DL x265-GRP', { season: 2 });
    keeps('arabic kept', 'مسلسل الحفرة', 'مسلسل الحفرة S01 720p WEB-DL x264-GRP', { season: 1 });
    drops('different arabic dropped', 'مسلسل الحفرة', 'باب الحارة S01 720p WEB-DL x264-GRP', { season: 1 });
    keeps('NFKC full-width latin', 'Ｓｈｏｗ', 'Show 2023 1080p WEB-DL x265-GRP');
    keeps('accents still fold', 'Amelie', 'Amélie 2001 1080p BluRay x264-GRP');
  }

  // ---------------------------------------------------------------- multi-season packs
  {
    const S = (n, size) => row(n, size, 100, ['knaben'], { category: 'tv' });
    const ctx = (season) => baseCtx({ query: { title: 'Harbor Light', season }, freeBytes: 500 * GB });
    const exact = S('Harbor.Light.S02.1080p.WEB-DL.x265-GRP', 10 * GB);
    const packs = {
      s1to5: S('Harbor.Light.S01-S05.1080p.WEB-DL.x265-GRP', 50 * GB),
      season13: S('Harbor Light Season 1-3 1080p WEB-DL x265-GRP', 30 * GB),
      s1s3c: S('Harbor.Light.S01-S03.COMPLETE.1080p.WEB-DL.x265-GRP', 30 * GB),
      series: S('Harbor Light Complete Series 1080p WEB-DL x265-GRP', 80 * GB),
      outside: S('Harbor.Light.S03-S05.1080p.WEB-DL.x265-GRP', 30 * GB),
      other: S('Harbor.Light.S01.1080p.WEB-DL.x265-GRP', 10 * GB),
    };
    const o = scoreResults([...Object.values(packs), exact], ctx(2));
    const ids = o.ranked.map((r) => r.id);
    for (const k of ['s1to5', 'season13', 's1s3c', 'series']) check(`pack kept for S02: ${k}`, ids.includes(packs[k].infoHash));
    check('pack not containing S02 excluded', o.excluded.some((e) => e.id === packs.outside.infoHash && e.reason === 'wrong_title'));
    check('single other season still excluded', o.excluded.some((e) => e.id === packs.other.infoHash && e.reason === 'wrong_title'));
    check('exact single season ranks first', o.ranked[0].id === exact.infoHash);
    const lastExact = ids.indexOf(exact.infoHash);
    check('all packs rank below the exact match', ['s1to5', 'season13', 's1s3c', 'series'].every((k) => ids.indexOf(packs[k].infoHash) > lastExact));
    const reasonsOf = (k) => o.ranked.find((r) => r.id === packs[k].infoHash).reasons;
    check('range pack reason', reasonsOf('s1to5').includes('Pack: seasons 1\u20135 (bigger download)'), reasonsOf('s1to5').join('|'));
    check('season 1-3 reason', reasonsOf('season13').includes('Pack: seasons 1\u20133 (bigger download)'));
    check('complete series reason', reasonsOf('series').includes('Pack: complete series (bigger download)'), reasonsOf('series').join('|'));
    check('pack flagged', o.ranked.find((r) => r.id === packs.s1to5.infoHash).flags.includes('multi_season_pack'));
    check('exact match has no pack reason', !o.ranked[0].reasons.some((x) => /^Pack:/.test(x)));
    // an even-better-scoring pack still sits under a weaker exact match
    const weakExact = S('Harbor.Light.S02.480p.WEBRip.x264-GRP', 3 * GB);
    const o2 = scoreResults([packs.s1to5, weakExact], ctx(2));
    check('weak exact match beats a stronger pack', o2.ranked[0].id === weakExact.infoHash);
    // asking for season 1 keeps the S01 single and an S01-S05 pack
    const o3 = scoreResults([packs.other, packs.s1to5], ctx(1));
    check('season 1 ask: single first, pack kept', o3.ranked[0].id === packs.other.infoHash && o3.ranked.length === 2);
    // no season asked: nothing changes
    const o4 = scoreResults([packs.s1to5, exact], baseCtx({ query: { title: 'Harbor Light' }, freeBytes: 500 * GB }));
    check('no season asked: pack kept, no pack reason', o4.ranked.length === 2 && !o4.ranked.some((r) => r.reasons.some((x) => /^Pack:/.test(x))));
    check('no season asked: no multi_season_pack flag', !o4.ranked.some((r) => r.flags.includes('multi_season_pack')));
  }

  // ---------------------------------------------------------------- purity
  for (const file of ['scoring.ts', 'sizeBands.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'assistant', file), 'utf8');
    const imports = [...src.matchAll(/^\s*import(?!\s+type)[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
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
