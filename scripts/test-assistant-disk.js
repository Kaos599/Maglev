#!/usr/bin/env node
// Disk-space advice rules R1-R12 and boundary tests (docs/ASSISTANT_DESIGN.md §6). No network.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

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
const RESERVE = 200 * MB;

const L1080 = 'The.Last.Harbor.2023.1080p.BluRay.x264-GRP';
const X265_1080 = 'The.Last.Harbor.2023.1080p.BluRay.x265-GRP';
const X265_2160 = 'The.Last.Harbor.2023.2160p.WEB-DL.HEVC.x265-GRP';
const L720 = 'The.Last.Harbor.2023.720p.BluRay.x264-GRP';
const L480 = 'The.Last.Harbor.2023.480p.DVDRip.x264-GRP';
const AV1_1080 = 'The.Last.Harbor.2023.1080p.BluRay.AV1-GRP';
const AV1_720 = 'The.Last.Harbor.2023.720p.BluRay.AV1-GRP';
const LOSSLESS_1080 = 'The.Last.Harbor.2023.1080p.BluRay.DTS-HD.MA.TrueHD.7.1.Atmos.x264-GRP';
const AAC_1080 = 'The.Last.Harbor.2023.1080p.WEB-DL.AAC2.0.x264-GRP';
const PACK = 'The.Show.S01.1080p.WEB-DL.x264-GRP';

/** Budget for a 10 GB device with nothing pending: free - pending - 200 MB. */
const B10 = 10 * GB - RESERVE;

const cand = (id, name, sizeBytes, episodes) => ({ id, name, sizeBytes, episodes });
const base = (over = {}) => ({ profile: 'phone', freeBytes: 10 * GB, pendingNeed: 0, stagingFactor: 1, ...over });
const rulesOf = (advice) => advice.map((a) => a.rule);
const find = (advice, rule) => advice.find((a) => a.rule === rule);
const has = (advice, rule) => advice.some((a) => a.rule === rule);

async function main() {
  const { diskAdvice, candidateFromRanked } = await import('../utils/assistant/diskAdvice.ts');
  const { formatBytes: f } = await import('../constants/format.ts');

  // ---------------------------------------------------------------- unknown input says so
  console.log('unknown input');
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ freeBytes: undefined }));
    check('unknown free space gives U1 and nothing that needs admission', JSON.stringify(rulesOf(out)) === '["U1"]', JSON.stringify(rulesOf(out)));
    check('U1 text says free space is unknown', /don't know how much space is free/.test(find(out, 'U1')?.text ?? ''));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ pendingNeed: undefined }));
    check('unknown pending need gives U1', has(out, 'U1') && !has(out, 'R1'));
    check('U1 text says other downloads are unknown', /what your other downloads still need/.test(find(out, 'U1')?.text ?? ''));
  }
  {
    const out = diskAdvice([cand('a', L1080, undefined)], base());
    check('unknown candidate size gives U2 with the title', has(out, 'U2') && find(out, 'U2').text.includes('The Last Harbor'));
    check('unknown candidate size never gives R1 or R7', !has(out, 'R1') && !has(out, 'R7'));
  }
  {
    const out = diskAdvice([cand('a', L1080, NaN)], base());
    check('non-finite size is treated as unknown', has(out, 'U2') && !has(out, 'R1'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ freeBytes: undefined, pendingNeed: undefined }));
    check('both unknown: U1 is emitted once', rulesOf(out).filter((r) => r === 'U1').length === 1);
  }

  // ---------------------------------------------------------------- §6.2 boundaries (Fits / Tight / DoesntFit)
  console.log('admission boundaries');
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB)], base());
    check('need == budget - 1 GB is Fits: no R1 and no R7', out.length === 0, JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB + 1)], base());
    check('need == budget - 1 GB + 1 is Tight: R7 only', has(out, 'R7') && !has(out, 'R1'), JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10)], base());
    check('need == budget is Tight: R7, not R1', has(out, 'R7') && !has(out, 'R1'), JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 + 1)], base());
    check('need == budget + 1 is DoesntFit: R1, not R7', has(out, 'R1') && !has(out, 'R7'), JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 / 2)], base({ stagingFactor: 2 }));
    check('staging 2: need == budget is Tight, not DoesntFit', has(out, 'R7') && !has(out, 'R1'), JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 / 2 + 1)], base({ stagingFactor: 2 }));
    check('staging 2: need == budget + 2 is DoesntFit', has(out, 'R1'), JSON.stringify(rulesOf(out)));
  }
  {
    // Pending 1 GB moves the line: budget = 10 GB - 1 GB - 200 MB.
    const budget = 10 * GB - GB - RESERVE;
    const fitsAtLine = diskAdvice([cand('a', L1080, budget - GB)], base({ pendingNeed: GB }));
    check('pending need: need == budget - 1 GB is Fits', fitsAtLine.length === 0, JSON.stringify(rulesOf(fitsAtLine)));
    const tightJustOver = diskAdvice([cand('a', L1080, budget - GB + 1)], base({ pendingNeed: GB }));
    check('pending need: one byte over the Fits line is Tight', has(tightJustOver, 'R7') && !has(tightJustOver, 'R1'), JSON.stringify(rulesOf(tightJustOver)));
  }

  // ---------------------------------------------------------------- R1
  console.log('R1');
  {
    const size = 12 * GB;
    const out = diskAdvice([cand('a', L1080, size)], base());
    const r1 = find(out, 'R1');
    check('R1 is emitted for DoesntFit', !!r1);
    check('R1 states the need in formatBytes', r1 && r1.text.includes(`needs ${f(size)}`), r1?.text);
    check('R1 states the budget in formatBytes', r1 && r1.text.includes(`only ${f(B10)} is free`), r1?.text);
    check('R1 has no action (never "add anyway")', r1 && r1.action === undefined);
  }

  // ---------------------------------------------------------------- R2
  console.log('R2');
  {
    const out = diskAdvice([cand('p', PACK, 10 * GB, 10)], base({ freeBytes: 6 * GB + RESERVE }));
    // budget = 6 GB, Fits needs k GB <= 5 GB: k = 5 exactly (boundary).
    const r2 = find(out, 'R2');
    check('R2 picks the largest count that is Fits (boundary at budget - 1 GB)', r2 && r2.action?.count === 5, JSON.stringify(r2));
    check('R2 action selects episodes, not sequential', r2 && r2.action.kind === 'select_episodes' && r2.action.sequential === false);
    check('R2 text says the episodes fit with formatBytes', r2 && r2.text.includes(`These 5 episodes fit (${f(5 * GB)})`), r2?.text);
  }
  {
    const out = diskAdvice([cand('p', PACK, 10 * GB, 10)], base({ freeBytes: 6 * GB }));
    check('R2 stops one short of the Fits boundary', find(out, 'R2')?.action?.count === 4, JSON.stringify(find(out, 'R2')));
  }
  {
    const out = diskAdvice([cand('p', PACK, 10 * GB, 10)], base({ freeBytes: 1.5 * GB + RESERVE }));
    check('R2 gives no count when no episode fits', !has(out, 'R2'), JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base());
    check('R2 needs a pack', !has(out, 'R2'));
  }
  {
    const out = diskAdvice([cand('p', PACK, 12 * GB, 1)], base());
    check('R2 ignores a pack of one episode', !has(out, 'R2'));
  }

  // ---------------------------------------------------------------- R3
  console.log('R3');
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', X265_1080, 6 * GB)], base());
    const r3 = find(out, 'R3');
    check('R3 prefers a same-title x265 copy that fits', r3 && r3.action?.candidateId === 'b', JSON.stringify(r3));
    check('R3 text states the saving from real sizes (50%)', r3 && r3.text.includes('x265') && r3.text.includes('50% smaller'), r3?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', X265_1080, 12.5 * GB)], base());
    check('R3 skips an x265 copy that does not fit', !has(out, 'R3'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', 'Other.Film.2023.1080p.BluRay.x265-GRP', 6 * GB)], base());
    check('R3 needs the same title', !has(out, 'R3'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', AV1_1080, 6 * GB)], base());
    check('R3 skips AV1 at 1080p without hardware decode', !has(out, 'R3'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', AV1_1080, 6 * GB)], base({ av1Hardware: true }));
    check('R3 takes AV1 at 1080p with hardware decode', find(out, 'R3')?.action?.candidateId === 'b' && /AV1/.test(find(out, 'R3').text));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', AV1_720, 4 * GB)], base());
    check('R3 takes AV1 at 720p or smaller without hardware decode', find(out, 'R3')?.action?.candidateId === 'b');
  }
  {
    const out = diskAdvice([cand('a', X265_2160, 14 * GB), cand('b', X265_1080, 6 * GB)], base());
    check('R3 does not fire when the candidate is already x265', !has(out, 'R3'));
  }

  // ---------------------------------------------------------------- R4
  console.log('R4');
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', L720, 4 * GB)], base());
    const r4 = find(out, 'R4');
    check('R4 steps down to a fitting 720p copy', r4 && r4.action?.candidateId === 'b', JSON.stringify(r4));
    check('R4 text names 720p with real saving (67%)', r4 && r4.text.includes('720p') && r4.text.includes('67% smaller'), r4?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB), cand('b', L720, 9.5 * GB)], base());
    check('R4 skips a 720p copy that does not fit', !has(out, 'R4'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base());
    check('R4 with no 720p copy gives nothing (no invented fit)', !has(out, 'R4'));
  }
  {
    const out = diskAdvice([cand('a', L720, 11 * GB), cand('b', L480, 1 * GB)], base());
    check('R4 steps 720p down to 480p', find(out, 'R4')?.action?.candidateId === 'b');
  }

  // ---------------------------------------------------------------- R5
  console.log('R5');
  {
    const finished = [
      { id: 'small', name: 'Old.Show.S01E01', sizeBytes: 1 * GB, ageDays: 40 },
      { id: 'big', name: 'Old.Film.2019', sizeBytes: 3 * GB, ageDays: 5 },
    ];
    const size = 12 * GB;
    const out = diskAdvice([cand('a', L1080, size)], base({ finished }));
    const r5 = find(out, 'R5');
    const shortfall = size - B10;
    check('R5 states the amount to free as -leftAfter', r5 && r5.text.includes(`free up ${f(shortfall)}`), r5?.text);
    check('R5 lists the biggest finished download first', r5?.action?.items[0]?.id === 'big', JSON.stringify(r5?.action));
    check('R5 marks the item that covers the shortfall', r5?.action?.items[0]?.coversShortfall === true && r5.action.items[1].coversShortfall === false);
    check('R5 action carries age in days', r5?.action?.items[0]?.ageDays === 5);
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ finished: [{ id: 'x', name: 'Mystery' }] }));
    const r5 = find(out, 'R5');
    check('R5 says size and age are unknown when they are', r5 && r5.text.includes('size unknown') && r5.text.includes('age unknown'), r5?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base());
    check('R5 needs finished downloads', !has(out, 'R5'));
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB / 2)], base({ finished: [{ id: 'x', name: 'Done', sizeBytes: GB, ageDays: 2 }] }));
    const r5 = find(out, 'R5');
    check('R5 also applies to Tight, with a softer line', r5 && r5.text.startsWith('You could remove') && !r5.text.includes('free up'), r5?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 5 * GB)], base({ finished: [{ id: 'x', name: 'Done', sizeBytes: GB, ageDays: 2 }] }));
    check('R5 does not apply when the candidate fits', !has(out, 'R5'));
  }

  // ---------------------------------------------------------------- R6
  console.log('R6');
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ storage: { onSdCard: true } }));
    check('R6 offers Move for an SD card folder', find(out, 'R6')?.action?.kind === 'move_storage' && /SD card/.test(find(out, 'R6').text));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ storage: { hasRoomElsewhere: true } }));
    check('R6 offers Move when another storage has room', find(out, 'R6')?.action?.kind === 'move_storage');
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB / 2)], base({ storage: { onSdCard: true } }));
    check('R6 does not apply to Tight', !has(out, 'R6'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base());
    check('R6 needs a storage hint', !has(out, 'R6'));
  }

  // ---------------------------------------------------------------- R7
  console.log('R7');
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB / 2)], base());
    const r7 = find(out, 'R7');
    check('R7 uses the add-sheet warning', r7 && r7.text.startsWith('This leaves under 1 GB free'), r7?.text);
    check('R7 states leftAfter with formatBytes', r7 && r7.text.includes(`(${f(GB / 2)} left)`), r7?.text);
    check('R7 has no action without a smaller fitting option', r7 && r7.action === undefined);
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB / 2), cand('b', L720, 4 * GB)], base());
    check('R7 offers a smaller fitting option first', find(out, 'R7')?.action?.candidateId === 'b');
  }
  {
    const out = diskAdvice([cand('a', L1080, B10 - GB / 2), cand('b', L720, B10 - GB / 2 - 0.1 * GB)], base());
    check('R7 does not offer a smaller option that is itself Tight', find(out, 'R7')?.action === undefined);
  }

  // ---------------------------------------------------------------- R8
  console.log('R8');
  {
    const out = diskAdvice([cand('a', L1080, 6 * GB)], base({ stagingFactor: 2 }));
    const r8 = find(out, 'R8');
    check('R8 fires when doubling the need makes the fit worse', !!r8);
    check('R8 states both needs with formatBytes', r8 && r8.text.includes(`needs ${f(12 * GB)} here and ${f(6 * GB)} in the default folder`), r8?.text);
    check('R8 action is the folder change as advice', r8 && r8.action?.kind === 'change_folder' && r8.action.to === 'default');
  }
  {
    const out = diskAdvice([cand('a', L1080, 6 * GB)], base({ stagingFactor: 1 }));
    check('R8 does not fire without staging', !has(out, 'R8'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 1 * GB)], base({ stagingFactor: 2 }));
    check('R8 does not fire when the fit does not change', !has(out, 'R8'));
  }

  // ---------------------------------------------------------------- R9
  console.log('R9');
  {
    const out = diskAdvice([cand('a', L1080, 5 * GB)], base({ pendingNeed: Math.round(4.2 * GB), unfinishedCount: 2 }));
    const r9 = find(out, 'R9');
    check('R9 says the other downloads still need their space', r9 && r9.text === `Your other 2 downloads still need ${f(Math.round(4.2 * GB))}.`, r9?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 5 * GB)], base({ pendingNeed: Math.round(4.2 * GB), unfinishedCount: 1 }));
    check('R9 uses the singular for one download', find(out, 'R9')?.text.startsWith('Your other download still needs'), find(out, 'R9')?.text);
  }
  {
    const out = diskAdvice([cand('a', L1080, 1 * GB)], base({ pendingNeed: Math.round(4.2 * GB), unfinishedCount: 2 }));
    check('R9 does not fire when every candidate fits', !has(out, 'R9'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 5 * GB)], base({ pendingNeed: 0, unfinishedCount: 0 }));
    check('R9 does not fire with nothing pending', !has(out, 'R9'));
  }

  // ---------------------------------------------------------------- R10
  console.log('R10');
  {
    const out = diskAdvice([cand('p', PACK, 20 * GB, 20)], base({ wantedSeasons: 3 }));
    const r10 = find(out, 'R10');
    check('R10 starts with the episodes that fit now', r10 && r10.action?.count === 8, JSON.stringify(r10));
    check('R10 is not sequential unless the user wants to watch while downloading', r10 && r10.action.sequential === false);
  }
  {
    const out = diskAdvice([cand('p', PACK, 20 * GB, 20)], base({ wantedSeasons: 3, wantsWatchWhileDownloading: true }));
    check('R10 is sequential when the user wants to watch while it downloads', find(out, 'R10')?.action?.sequential === true);
  }
  {
    const out = diskAdvice([cand('p', PACK, 20 * GB, 20)], base({ wantedSeasons: 2 }));
    check('R10 needs three or more seasons', !has(out, 'R10'));
  }
  {
    const out = diskAdvice([cand('p', PACK, 5 * GB, 5)], base({ wantedSeasons: 3 }));
    check('R10 does nothing when the whole pack fits', !has(out, 'R10'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 12 * GB)], base({ wantedSeasons: 4 }));
    check('R10 needs a pack', !has(out, 'R10'));
  }

  // ---------------------------------------------------------------- R11
  console.log('R11');
  {
    const out = diskAdvice([cand('a', X265_2160, 14 * GB), cand('b', L1080, 6 * GB)], base());
    const r11 = find(out, 'R11');
    check('R11 offers 1080p on a phone when the best result is 4K', r11 && r11.action?.candidateId === 'b', JSON.stringify(r11));
    check('R11 states both sizes with formatBytes', r11 && r11.text.includes(`${f(6 * GB)}, against ${f(14 * GB)} for 4K`), r11?.text);
  }
  {
    const out = diskAdvice([cand('a', X265_2160, 14 * GB), cand('b', L1080, 6 * GB)], base({ profile: 'tv' }));
    check('R11 does not apply on TV', !has(out, 'R11'));
  }
  {
    const out = diskAdvice([cand('a', L1080, 6 * GB), cand('b', X265_2160, 14 * GB)], base());
    check('R11 needs 4K to be the best result', !has(out, 'R11'));
  }
  {
    const out = diskAdvice([cand('a', X265_2160, 14 * GB)], base());
    check('R11 needs a 1080p copy to show', !has(out, 'R11'));
  }

  // ---------------------------------------------------------------- R12
  console.log('R12');
  {
    const out = diskAdvice([cand('a', LOSSLESS_1080, 4 * GB), cand('b', AAC_1080, 3 * GB)], base());
    const r12 = find(out, 'R12');
    check('R12 says the lossless audio adds bytes a phone cannot use', r12 && r12.text.includes('lossless') && r12.text.includes("phone can't use"), r12?.text);
    check('R12 prefers a copy with AAC or Dolby Digital Plus', r12 && r12.action?.candidateId === 'b', JSON.stringify(r12));
  }
  {
    const out = diskAdvice([cand('a', LOSSLESS_1080, 4 * GB)], base());
    const r12 = find(out, 'R12');
    check('R12 gives no action when there is no AAC or DD+ copy', r12 && r12.action === undefined);
  }
  {
    const out = diskAdvice([cand('a', LOSSLESS_1080, 4 * GB)], base({ profile: 'tv' }));
    check('R12 does not apply on TV', !has(out, 'R12'));
  }
  {
    const out = diskAdvice([cand('a', AAC_1080, 3 * GB)], base());
    check('R12 does not apply to a non-lossless copy', !has(out, 'R12'));
  }

  // ---------------------------------------------------------------- ordering, wording, adapter
  console.log('ordering and wording');
  const mixed = diskAdvice(
    [cand('a', L1080, 6 * GB), cand('b', L720, 2 * GB), cand('c', X265_1080, 3 * GB)],
    base({
      pendingNeed: Math.round(0.5 * GB),
      unfinishedCount: 1,
      stagingFactor: 2,
      storage: { onSdCard: true },
      finished: [{ id: 'z', name: 'Done', sizeBytes: 2 * GB, ageDays: 9 }],
    }),
  );
  {
    const order = rulesOf(mixed);
    const nums = order.map((r) => (r[0] === 'U' ? 0 : Number(r.slice(1))));
    check('output is in rule order', nums.every((n, i) => i === 0 || nums[i - 1] <= n), order.join(','));
    check('mixed case emits R1, R3, R4, R5, R6, R8, R9', ['R1', 'R3', 'R4', 'R5', 'R6', 'R8', 'R9'].every((r) => order.includes(r)), order.join(','));
  }
  {
    const scenarios = [
      mixed,
      diskAdvice([cand('p', PACK, 20 * GB, 20)], base({ wantedSeasons: 3, wantsWatchWhileDownloading: true })),
      diskAdvice([cand('a', LOSSLESS_1080, 4 * GB)], base()),
      diskAdvice([cand('a', L1080, 12 * GB)], base({ freeBytes: undefined })),
    ];
    const texts = scenarios.flat().map((a) => a.text);
    check('no message says "safe" or "add anyway"', texts.every((t) => !/safe|anyway/i.test(t)), texts.find((t) => /safe|anyway/i.test(t)));
    check('every message is one line', texts.every((t) => !t.includes('\n')));
  }
  {
    const out = diskAdvice([cand('a', L1080, 4 * GB)], base());
    check('a Fits candidate with no context gives no advice', out.length === 0, JSON.stringify(rulesOf(out)));
  }
  {
    const out = diskAdvice([], base());
    check('no candidates gives no advice', out.length === 0);
  }
  {
    const r = candidateFromRanked({ id: 'h1', parsed: { raw: L1080 }, result: { sizeBytes: 12 * GB } }, 0);
    check('candidateFromRanked maps id, release name and size', r.id === 'h1' && r.name === L1080 && r.sizeBytes === 12 * GB && r.episodes === 0);
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant disk advice tests passed');
}

main();
