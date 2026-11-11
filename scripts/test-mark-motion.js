#!/usr/bin/env node
// The Maglev mark's motion: generated frame sets (scripts/build-logo.py -> markPaths.ts) and the
// pure helpers in components/brand/markMotion.ts (boost travel, stepped ranges, tap and arrival gates).
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

async function main() {
  const P = await import('../components/brand/markPaths.ts');
  const M = await import('../components/brand/markMotion.ts');

  // The still logo's speed lines, as [left x, width] per line.
  const still = P.MARK_LINES.split('Z').filter((s) => s.trim()).map((s) => {
    const [, x, y, x2] = s.match(/M([\d.]+) ([\d.]+) H([\d.]+)/).map(Number);
    return { x, y, w: x2 - x };
  });

  for (const [name, fx] of [['MARK_FX', P.MARK_FX], ['MARK_FX_COMPACT', P.MARK_FX_COMPACT], ['MARK_BOOST', P.MARK_BOOST], ['MARK_BOOST_COMPACT', P.MARK_BOOST_COMPACT]]) {
    const n = fx.group.length;
    check(`${name}: every element has ${n} frames`, fx.sprites.every((s) => s.frames.length === n) && fx.after.every((a) => a.length === n));
    check(`${name}: sprites have a width and an opacity in 0..1`, fx.sprites.every((s) => s.frames.every(([, w, o]) => w > 0 && o >= 0 && o <= 1)));
    check(`${name}: the train never bobs vertically`, fx.group.every(([, dy]) => dy === 0));
    check(`${name}: 20 fps`, fx.ms === n * 50, String(fx.ms));
  }

  // Compact set: built for the header, where anything thinner than a speed line is under a pixel.
  check('compact: nothing thinner than a speed line', P.MARK_FX_COMPACT.sprites.every((s) => s.h >= 1.5));
  check('compact: fewer sprites than the full set', P.MARK_FX_COMPACT.sprites.length < P.MARK_FX.sprites.length, `${P.MARK_FX_COMPACT.sprites.length} vs ${P.MARK_FX.sprites.length}`);
  check('compact: every push step is a whole dp at 22 dp', P.MARK_FX_COMPACT.group.every(([dx]) => Number.isInteger(dx * (22 / 44))));
  const pushDp = P.MARK_FX_COMPACT.group.map(([dx]) => dx / 2);
  const peak = pushDp.indexOf(Math.max(...pushDp));
  check('compact: the push snaps to 4 dp', Math.max(...pushDp) === 4);
  check('compact: the push settles without bouncing', pushDp.slice(peak, -2).every((v, i, a) => v >= 0 && (i === 0 || v <= a[i - 1])), pushDp.join(','));
  check('compact: the loop ends on a 1 dp crouch', pushDp.slice(-2).every((v) => v === -1));
  // 16 dp of header margin is 32 units left of the viewBox (x = 10): cruising trails must fit inside it.
  const cruiseLeft = Math.min(...P.MARK_FX_COMPACT.sprites.filter((s) => s.frames.every(([, , o]) => o > 0)).map((s) => s.frames[12][0]));
  check('compact: pinned trails stay inside the header margin while cruising', cruiseLeft >= 10 - 32, String(cruiseLeft));

  // Boost: frame counts agree with the renderer, and it lands exactly on the still logo.
  check('boost: frame count matches markMotion', P.MARK_BOOST.group.length === M.BOOST_FRAMES && P.MARK_BOOST_COMPACT.group.length === M.BOOST_FRAMES);
  check('boost: arrival start matches markMotion', P.MARK_BOOST_ENTER_AT === M.BOOST_ENTER_AT);
  for (const [name, fx] of [['MARK_BOOST', P.MARK_BOOST], ['MARK_BOOST_COMPACT', P.MARK_BOOST_COMPACT]]) {
    const last = fx.group.length - 1;
    const cores = fx.sprites.filter((s) => !s.ghost);
    check(`${name}: ends on the still speed lines`, cores.length === still.length && cores.every((s, i) => s.y === still[i].y && s.frames[last][0] === still[i].x && s.frames[last][1] === still[i].w && s.frames[last][2] === 1));
    check(`${name}: ends with no tails or afterimages`, fx.sprites.filter((s) => s.ghost).every((s) => s.frames[last][2] === 0) && fx.after.every((a) => a[last][1] === 0));
  }

  // Travel: crouch back, accelerate off the right edge, come in from off the left edge, land on 0.
  const t = M.boostTravel(90, 384, 22);
  check('travel: one value per boost frame, whole dp', t.length === M.BOOST_FRAMES && t.every(Number.isInteger), t.join(','));
  check('travel: crouches back first', t[0] === -1 && t[1] === -2);
  const exit = t.slice(2, M.BOOST_ENTER_AT);
  check('travel: launch accelerates', exit.every((v, i) => i === 0 || v - exit[i - 1] > (i === 1 ? 0 : exit[i - 1] - exit[i - 2])), exit.join(','));
  check('travel: launch ends off the right edge', exit[exit.length - 1] === 384);
  const enter = t.slice(M.BOOST_ENTER_AT);
  check('travel: re-entry starts off the left edge', enter[0] === -90);
  check('travel: re-entry only moves forward and never overshoots', enter.every((v, i) => v <= 0 && (i === 0 || v > enter[i - 1])), enter.join(','));
  check('travel: re-entry decelerates', enter.every((v, i) => i < 2 || v - enter[i - 1] < enter[i - 1] - enter[i - 2]), enter.join(','));
  check('travel: lands at rest', t[t.length - 1] === 0);
  check('travel: crouch scales with the mark', M.boostTravel(280, 280, 64)[1] === -6);
  check('travel: tiny distances still move', M.boostTravel(3, 3, 10).slice(M.BOOST_ENTER_AT, -1).every((v) => v < 0));

  // Stepped ranges: strictly increasing inputs; a loop wraps, a one-shot holds its last frame.
  const loop = M.steppedRanges([5, 6, 7], true);
  const shot = M.steppedRanges([5, 6, 7], false);
  check('stepped: inputs strictly increase from 0 to 1', loop.inputRange[0] === 0 && loop.inputRange.at(-1) === 1 && loop.inputRange.every((v, i, a) => i === 0 || v > a[i - 1]));
  check('stepped: frames are held', loop.outputRange.slice(0, 6).join() === '5,5,6,6,7,7');
  check('stepped: a loop ends on its first frame', loop.outputRange.at(-1) === 5);
  check('stepped: a one-shot holds its last frame', shot.outputRange.at(-1) === 7);

  // Tap gate: taps during a boost are ignored.
  const gate = M.createTapGate();
  check('gate: first tap starts', gate.tryStart() === true && gate.busy === true);
  check('gate: taps while busy are ignored', gate.tryStart() === false && gate.tryStart() === false);
  gate.finish();
  check('gate: free again after the boost', gate.busy === false && gate.tryStart() === true);
  check('gate: gates are independent', M.createTapGate().tryStart() === true);

  // Arrival: once per process.
  check('arrival: claimed once', M.claimArrival() === true && M.claimArrival() === false && M.claimArrival() === false);

  // Touch target: 22 dp tall header mark reaches 44.
  const slop = M.hitSlopFor(53.5, 22);
  check('hit slop: header mark reaches 44 dp tall', 22 + slop.top + slop.bottom >= 44 && slop.left === 0 && slop.right === 0, JSON.stringify(slop));
  check('hit slop: a big mark needs none', Object.values(M.hitSlopFor(155, 64)).every((v) => v === 0));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nmark motion tests passed');
}
main();
