#!/usr/bin/env node
// Motion tokens and pure helpers in constants/theme.ts: durations, the press scale, mono slot widths,
// the progress fill, sheet drag-to-dismiss thresholds and the finish-moment trigger.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const T = await import('../constants/theme.ts');
  const { motion } = T;

  // ---- tokens
  check('tokens: fast is 150 ms', motion.duration.fast === 150);
  check('tokens: base is 220 ms', motion.duration.base === 220);
  check('tokens: press is at most 120 ms', motion.duration.press <= 120);
  const durations = Object.entries(motion.duration).filter(([k]) => k !== 'max');
  check('tokens: every duration is within the 250 ms ceiling', durations.every(([, v]) => v > 0 && v <= motion.duration.max), JSON.stringify(motion.duration));
  check('tokens: the ceiling is 250 ms', motion.duration.max === 250);
  check('tokens: press scale is 0.97', motion.pressScale === 0.97);
  check('tokens: the curve is ease-out cubic', JSON.stringify(motion.easeOutBezier) === '[0.33,1,0.68,1]');

  // ---- easeOutCubic
  check('easeOutCubic: starts at 0', T.easeOutCubic(0) === 0);
  check('easeOutCubic: ends at 1', T.easeOutCubic(1) === 1);
  check('easeOutCubic: front-loaded (ease-out)', T.easeOutCubic(0.5) > 0.5, String(T.easeOutCubic(0.5)));
  check('easeOutCubic: clamps outside 0..1', T.easeOutCubic(-1) === 0 && T.easeOutCubic(2) === 1);
  let mono = true;
  for (let i = 1; i <= 20; i++) if (T.easeOutCubic(i / 20) < T.easeOutCubic((i - 1) / 20)) mono = false;
  check('easeOutCubic: never goes backwards (no bounce)', mono);

  // ---- monoSlotWidth
  check('monoSlotWidth: Space Mono advance is 0.612 em', T.MONO_ADVANCE === 0.612);
  check('monoSlotWidth: 11 glyphs at 12 px', T.monoSlotWidth(11, 12) === Math.ceil(11 * 12 * 0.612), String(T.monoSlotWidth(11, 12)));
  check('monoSlotWidth: the widest speed fits its slot', T.monoSlotWidth('1023.9 KB/s'.length, 12) >= '1023.9 KB/s'.length * 12 * 0.612);
  check('monoSlotWidth: grows with the system font size', T.monoSlotWidth(11, 12, 1.5) > T.monoSlotWidth(11, 12, 1));
  check('monoSlotWidth: a bad font scale falls back to 1', T.monoSlotWidth(11, 12, NaN) === T.monoSlotWidth(11, 12) && T.monoSlotWidth(11, 12, 0) === T.monoSlotWidth(11, 12));
  check('monoSlotWidth: whole dp', Number.isInteger(T.monoSlotWidth(13, 12, 1.15)));
  check('monoSlotWidth: never negative', T.monoSlotWidth(-3, 12) === 0);

  // ---- fillTranslateX
  check('fillTranslateX: full bar sits at 0', Object.is(T.fillTranslateX(1, 200), -0) || T.fillTranslateX(1, 200) === 0);
  check('fillTranslateX: empty bar is fully off the left edge', T.fillTranslateX(0, 200) === -200);
  check('fillTranslateX: half', T.fillTranslateX(0.5, 200) === -100);
  check('fillTranslateX: clamps over 1 and under 0', T.fillTranslateX(1.4, 200) === 0 && T.fillTranslateX(-1, 200) === -200);
  check('fillTranslateX: NaN reads as empty', T.fillTranslateX(NaN, 200) === -200);
  check('fillTranslateX: no width, no travel', Math.abs(T.fillTranslateX(0.3, 0)) === 0);

  // ---- sheetDragOffset
  check('sheetDragOffset: follows the finger down', T.sheetDragOffset(120) === 120);
  check('sheetDragOffset: resists upward drags', T.sheetDragOffset(-40) === -8, String(T.sheetDragOffset(-40)));
  check('sheetDragOffset: upward overdrag is capped', T.sheetDragOffset(-1000) === -motion.sheet.overdrag);
  check('sheetDragOffset: NaN stays put', T.sheetDragOffset(NaN) === 0);

  // ---- shouldDismissSheet
  const H = 400;
  check('dismiss: a fast downward fling closes, even when short', T.shouldDismissSheet(20, 1200, H));
  check('dismiss: a slow short drag springs back', !T.shouldDismissSheet(60, 100, H));
  check('dismiss: a slow long drag closes (30% of the height)', T.shouldDismissSheet(121, 0, H));
  check('dismiss: just under the distance springs back', !T.shouldDismissSheet(119, 0, H));
  check('dismiss: a tall sheet needs at most 160 points', T.shouldDismissSheet(160, 0, 2000) && !T.shouldDismissSheet(159, 0, 2000));
  check('dismiss: a long drag flicked back up stays open', !T.shouldDismissSheet(300, -600, H));
  check('dismiss: dragged above rest never closes', !T.shouldDismissSheet(-10, 2000, H));
  check('dismiss: unknown height uses the 160 point cap', T.shouldDismissSheet(160, 0, 0) && !T.shouldDismissSheet(100, 0, 0));
  check('dismiss: NaN offset stays open', !T.shouldDismissSheet(NaN, 2000, H));

  // ---- backdropOpacity
  check('backdrop: opaque at rest', T.backdropOpacity(0, H) === 1);
  check('backdrop: clear when the sheet is gone', T.backdropOpacity(H, H) === 0);
  check('backdrop: half way is half', T.backdropOpacity(200, H) === 0.5);
  check('backdrop: overdrag up stays at 1', T.backdropOpacity(-16, H) === 1);
  check('backdrop: no height yet, rest is opaque and anything else clear', T.backdropOpacity(0, 0) === 1 && T.backdropOpacity(5, 0) === 0);

  // ---- finish moment
  const dl = { id: 'a', state: 'DOWNLOADING', pausedBy: null };
  check('finish: downloading to done plays', T.isFinishTransition(dl, { id: 'a', state: 'COMPLETED' }));
  check('finish: downloading to seeding plays', T.isFinishTransition(dl, { id: 'a', state: 'SEEDING' }));
  check('finish: downloading to seed-limit pause plays', T.isFinishTransition(dl, { id: 'a', state: 'PAUSED', pausedBy: 'seed_limit' }));
  check('finish: downloading to a user pause does not', !T.isFinishTransition(dl, { id: 'a', state: 'PAUSED', pausedBy: 'user' }));
  check('finish: first render does not', !T.isFinishTransition(null, { id: 'a', state: 'COMPLETED' }));
  check('finish: a recycled row (other id) does not', !T.isFinishTransition(dl, { id: 'b', state: 'COMPLETED' }));
  check('finish: already done stays quiet', !T.isFinishTransition({ id: 'a', state: 'SEEDING' }, { id: 'a', state: 'COMPLETED' }));
  check('finish: checking to done stays quiet (a recheck, not a download)', !T.isFinishTransition({ id: 'a', state: 'CHECKING' }, { id: 'a', state: 'SEEDING' }));
  check('finish: done states', T.isFinishedState({ id: 'a', state: 'COMPLETED' }) && !T.isFinishedState({ id: 'a', state: 'ERROR' }));
  check('finish: the hold is not motion but stays short', motion.finishHold > 0 && motion.finishHold <= 1200);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
