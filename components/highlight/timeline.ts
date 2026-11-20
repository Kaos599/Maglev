import { CQ_PER_U, HIGHLIGHT_MOTION as M, IMPACT_MS, RAIL, type Curve } from './timing.ts';
import type { Particle } from './burst.ts';

/*
 * The highlight's timeline as pure functions of the clock (ms). Every function is a worklet, so the animated styles
 * can call it on the UI thread, and a plain function in Node, so the tests can too. A property is a list of keyframes
 * [at, value, ease]: `at` is a share (0 to 1) of the element's own length, `ease` shapes the stretch that starts
 * there, as in CSS (a mid-keyframe curve change is just another row). Before the first key an element holds its first
 * value and after the last its last, like CSS `animation-fill-mode: both`.
 */

/** An easing: a cubic bezier (4 numbers), `steps(n)` (`[n, 0]` jumps at the end of each step, `[n, 1]` at the start), or linear (`[]`). */
export type Ease = Curve;
export type Row = readonly [at: number, value: number, ease: Ease];

const LINEAR: Ease = [];
const steps = (n: number, atStart = false): Ease => [n, atStart ? 1 : 0];

const clamp01 = (v: number) => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/** CSS cubic-bezier: the y for time fraction `t` (solves x(s) = t by bisection). */
export function bezierAt(c: Ease, t: number): number {
  'worklet';
  const p = clamp01(t);
  if (p === 0) return 0;
  if (p === 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 22; k++) {
    const s = (lo + hi) / 2;
    const x = 3 * c[0] * s * (1 - s) * (1 - s) + 3 * c[2] * s * s * (1 - s) + s * s * s;
    if (x < p) lo = s;
    else hi = s;
  }
  const s = (lo + hi) / 2;
  return 3 * c[1] * s * (1 - s) * (1 - s) + 3 * c[3] * s * s * (1 - s) + s * s * s;
}

/** CSS `steps(n, end | start)` for progress `p`: whole steps only. */
export function stepsAt(p: number, n: number, atStart: boolean): number {
  'worklet';
  const q = clamp01(p);
  return atStart ? Math.ceil(q * n) / n : Math.floor(q * n) / n;
}

/** Eased progress for any `Ease`. */
function easeAt(e: Ease, p: number): number {
  'worklet';
  if (e.length === 4) return bezierAt(e, p);
  if (e.length === 2) return stepsAt(p, e[0], e[1] === 1);
  return clamp01(p);
}

/** The value of a keyframed property at share `p` of its length. */
export function keyed(p: number, rows: readonly Row[]): number {
  'worklet';
  if (p <= rows[0][0]) return rows[0][1];
  const last = rows.length - 1;
  if (p >= rows[last][0]) return rows[last][1];
  let i = 0;
  while (i < last - 1 && p >= rows[i + 1][0]) i++;
  const a = rows[i];
  const b = rows[i + 1];
  const f = easeAt(a[2], (p - a[0]) / (b[0] - a[0]));
  return a[1] + (b[1] - a[1]) * f;
}

/** Share of an element's length at clock `t`, for an element that starts at `start` and runs `ms`. */
const share = (t: number, start: number, ms: number) => {
  'worklet';
  return (t - start) / ms;
};

// ---- scrim and card ---------------------------------------------------------------------------------------------

/** The scrim's opacity (0 to 1). */
export function scrimAt(t: number): number {
  'worklet';
  return bezierAt(M.easeOut, share(t, 0, M.scrimMs));
}

const E_CARD = M.easeCard;
const CARD_OPACITY: readonly Row[] = [[0, 0, E_CARD], [0.4, 1, E_CARD], [1, 1, LINEAR]];
const CARD_RISE: readonly Row[] = [[0, M.cardRiseCq, E_CARD], [0.7, 0, E_CARD], [1, 0, LINEAR]];
const CARD_SCALE: readonly Row[] = [[0, M.cardFromScale, E_CARD], [0.7, M.cardOvershoot, E_CARD], [1, 1, LINEAR]];

/** The card: opacity, scale, and how far below its place it is (in cq). */
export function cardAt(t: number): { opacity: number; scale: number; rise: number } {
  'worklet';
  const p = share(t, 0, M.cardMs);
  return { opacity: keyed(p, CARD_OPACITY), scale: keyed(p, CARD_SCALE), rise: keyed(p, CARD_RISE) };
}

// ---- the train --------------------------------------------------------------------------------------------------

const APPROACH_MS = M.trainMs * M.trainBrake;
const SETTLE_START = M.trainStart + APPROACH_MS;
const SETTLE_MS = M.trainMs * (1 - M.trainBrake);

/** The train's offset from its parked place (u): in from the left, brake two pixels past, settle back. */
export function trainX(t: number): number {
  'worklet';
  if (t < SETTLE_START) {
    const f = bezierAt(M.easeApproach, share(t, M.trainStart, APPROACH_MS));
    return M.trainFromU + (M.trainOverU - M.trainFromU) * f;
  }
  return M.trainOverU * (1 - bezierAt(M.easeSettle, share(t, SETTLE_START, SETTLE_MS)));
}

const E_DIP = steps(1);
const DIP: readonly Row[] = [[0, 0, E_DIP], [M.dipFrom, M.dipU, E_DIP], [M.dipTo, 0, LINEAR], [1, 0, LINEAR]];

/** The train's one-pixel dip into its float while it settles (u, down is positive). */
export function trainDip(t: number): number {
  'worklet';
  return keyed(share(t, SETTLE_START, SETTLE_MS), DIP);
}

const E_SPEED = steps(3);
const SPEED_OPACITY: readonly Row[] = [[0, 1, LINEAR], [0.4, 1, LINEAR], [0.55, 1, E_SPEED], [0.85, 0, LINEAR], [1, 0, LINEAR]];
const SPEED_STRETCH: readonly Row[] = [[0, 1.8, LINEAR], [0.4, 1.5, LINEAR], [0.55, 1, E_SPEED], [0.85, 0, LINEAR], [1, 0, LINEAR]];

/** Speed lines: opacity and horizontal stretch about their right end. Long while it runs, three steps back as it brakes. */
export function speedAt(t: number): { opacity: number; stretch: number } {
  'worklet';
  const p = share(t, M.trainStart, M.trainMs);
  return { opacity: keyed(p, SPEED_OPACITY), stretch: keyed(p, SPEED_STRETCH) };
}

// ---- the rail ---------------------------------------------------------------------------------------------------

/** One piece of the track, in mark units. `d` is its outline; the mark's own three pieces come first. */
export interface RailPiece {
  d: string;
  a: number;
  b: number;
}

/** A piece shaped like the mark's right-hand rail: a top row from a to b, then two narrower rows. */
function railPiece(a: number, b: number): RailPiece {
  const y = RAIL.y;
  return { d: `M${a} ${y} H${b} V${y + 1.25} H${b - 1.5} V${y + 2.5} H${b - 4} V${y + 3.75} H${a + 3.5} V${y + 2.5} H${a + 2} V${y + 1.25} H${a} Z`, a, b };
}

/** The mark's three rail pieces plus pieces of the same shape continuing both ways. The three in the middle sit under the parked train. */
export const TRACK: readonly RailPiece[] = [
  railPiece(-55, -22),
  railPiece(-18, 15),
  { d: 'M20 79.5 H29 V80.75 H20 Z', a: 20, b: 29 },
  { d: 'M34 79.5 H67 V80.75 H68.5 V82 H70 V83.25 H40.5 V82 H36 V80.75 H34 Z', a: 34, b: 70 },
  { d: 'M71 79.5 H112.5 V80.75 H111 V82 H108.5 V83.25 H74.5 V82 H72.5 V80.75 H71 Z', a: 71, b: 112.5 },
  railPiece(116.5, 149.5),
  railPiece(153.5, 186.5),
];

/** Time (as a share of the approach) at which the approach curve first reaches `progress` of its distance. */
function timeAtProgress(curve: Ease, progress: number): number {
  'worklet';
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    const y = 3 * curve[1] * m * (1 - m) * (1 - m) + 3 * curve[3] * m * m * (1 - m) + m * m * m;
    if (y < progress) lo = m;
    else hi = m;
  }
  return 3 * curve[0] * lo * (1 - lo) * (1 - lo) + 3 * curve[2] * lo * lo * (1 - lo) + lo * lo * lo;
}

/**
 * When each rail piece lights: the moment the train's nose reaches the middle of the piece, read off the approach
 * curve. `null` for a piece the nose never reaches (the ones beyond where the train parks).
 */
export function railStarts(): (number | null)[] {
  return TRACK.map((piece) => {
    const need = (piece.a + piece.b) / 2 - M.noseX; // train offset at which the nose is over the piece
    if (need > M.trainOverU) return null;
    const t = timeAtProgress(M.easeApproach, (need - M.trainFromU) / (M.trainOverU - M.trainFromU));
    return Math.round(M.trainStart + t * APPROACH_MS);
  });
}

const E_LIT_UP = steps(1, true);
const E_LIT_DOWN = steps(3);
const RAIL_LIT: readonly Row[] = [[0, M.railDim, E_LIT_UP], [0.35, 1, E_LIT_DOWN], [1, M.railDim, LINEAR]];

/** A rail piece's opacity: full the moment the nose arrives at `start`, then back to dim in three steps. */
export function railLitAt(t: number, start: number): number {
  'worklet';
  return keyed(share(t, start, M.railLitMs), RAIL_LIT);
}

// ---- the burst and the dust -------------------------------------------------------------------------------------

/** Visible at once, held, then gone in three steps (`blink` in the design). Share `p` of the element's length. */
export function blinkAt(p: number): number {
  'worklet';
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.55) return 1;
  return 1 - stepsAt((p - 0.55) / 0.45, 3, false);
}

const E_BURST_X = [0.15, 0.6, 0.35, 1] as const;
const E_BURST_UP = [0.25, 0.65, 0.45, 1] as const;
const E_BURST_DOWN = [0.55, 0, 0.8, 0.45] as const;
const BURST_PEAK = 0.38;

/** A burst pixel at clock `t`: where it is (u from its start) and its opacity. Sideways drift, a rise, then a gravity fall. */
export function burstAt(t: number, v: Particle): { x: number; y: number; opacity: number } {
  'worklet';
  const p = share(t, M.burstStart + v.wave * M.burstStagger, M.burstLife);
  const q = clamp01(p);
  const x = v.x * bezierAt(E_BURST_X, q);
  const y = q < BURST_PEAK ? v.y * bezierAt(E_BURST_UP, q / BURST_PEAK) : v.y + v.fall * bezierAt(E_BURST_DOWN, (q - BURST_PEAK) / (1 - BURST_PEAK));
  return { x, y, opacity: blinkAt(p) };
}

/** Where a burst pixel ends, in u from its start: the target the x and y channels reach. */
export function burstTarget(v: Particle): { x: number; y: number } {
  return { x: v.x, y: v.y + v.fall };
}

/** The 1 px lime flash on the card's edge: on for the first beat, then off in two steps while it widens. */
export function flashAt(t: number): { opacity: number; stretch: number } {
  'worklet';
  const p = share(t, IMPACT_MS, M.flashMs);
  if (p <= 0) return { opacity: 0, stretch: 0.6 };
  if (p >= 1) return { opacity: 0, stretch: 1 };
  if (p < 0.01) return { opacity: 1, stretch: 0.6 };
  const k = stepsAt((p - 0.01) / 0.99, 2, false);
  return { opacity: 1 - k, stretch: 0.6 + 0.4 * k };
}

const E_DUST = [0.2, 0.8, 0.3, 1] as const;

/** A dust pixel kicked out along the card's edge: offset (u) from its start and opacity. */
export function dustAt(t: number, dx: number, dy: number): { x: number; y: number; opacity: number } {
  'worklet';
  const p = share(t, IMPACT_MS, M.dustMs);
  const f = bezierAt(E_DUST, p);
  return { x: dx * f, y: dy * f, opacity: blinkAt(p) };
}

// ---- the badge --------------------------------------------------------------------------------------------------

const E_DROP = [0.2, 0.7, 0.4, 1] as const;
const E_WIND = [0.6, 0, 0.9, 0.5] as const;
const E_SQUASH = [0.3, 0.6, 0.4, 1] as const;
const E_REBOUND = [0.42, 0, 0.58, 1] as const;

/** Keyframes of the badge: [at, ease after, opacity, rise (cq), scale x, scale y, tilt (deg)]. */
const STAMP_ROWS = [
  [0, E_DROP, 0, -4, 1.38, 1.38, -9],
  [0.18, E_WIND, 1, -5.5, 1.42, 1.42, -11],
  [0.45, E_DROP, 1, 0, 1, 1, -3],
  [0.56, E_SQUASH, 1, 0.4, 1.1, 0.84, -3.5],
  [0.74, E_REBOUND, 1, -0.2, 0.97, 1.05, -4.3],
  [0.88, LINEAR, 1, 0, 1.01, 0.99, -4],
  [1, LINEAR, 1, 0, 1, 1, -4],
] as const;

const stampRows = (col: number): Row[] => STAMP_ROWS.map((r) => [r[0], r[col] as number, r[1]] as Row);
const STAMP_OPACITY = stampRows(2);
const STAMP_RISE = stampRows(3);
const STAMP_SX = stampRows(4);
const STAMP_SY = stampRows(5);
const STAMP_TILT = stampRows(6);

/** The badge at clock `t`: opacity, rise (cq), scale x and y, tilt (deg). It slams onto the card's edge at 45%. */
export function stampAt(t: number): { opacity: number; rise: number; sx: number; sy: number; tilt: number } {
  'worklet';
  const p = share(t, M.badgeStart, M.badgeMs);
  return { opacity: keyed(p, STAMP_OPACITY), rise: keyed(p, STAMP_RISE), sx: keyed(p, STAMP_SX), sy: keyed(p, STAMP_SY), tilt: keyed(p, STAMP_TILT) };
}

const E_SPARK = steps(3);
const SPARK_OPACITY: readonly Row[] = [[0, 0, E_SPARK], [0.6, 1, E_SPARK], [1, 1, LINEAR]];
const SPARK_SCALE: readonly Row[] = [[0, 0.3, E_SPARK], [0.6, 1.25, E_SPARK], [1, 1, LINEAR]];

/** The nth pixel spark: pops up in three steps, overshoots, settles. */
export function sparkAt(t: number, i: number): { opacity: number; scale: number } {
  'worklet';
  const p = share(t, M.sparkStart + M.sparkGap * i, M.sparkMs);
  return { opacity: keyed(p, SPARK_OPACITY), scale: keyed(p, SPARK_SCALE) };
}

// ---- the words --------------------------------------------------------------------------------------------------

const RISE_OPACITY: readonly Row[] = [[0, 0, M.easeRise], [0.4, 1, M.easeRise], [1, 1, LINEAR]];
const RISE_Y: readonly Row[] = [[0, M.riseCq, M.easeRise], [1, 0, LINEAR]];

/** The nth item of the content (0 icon, 1 title, 2 body, 3 primary, 4 Not now, 5 All release notes): opacity and rise in cq. */
export function riseAt(t: number, i: number): { opacity: number; rise: number } {
  'worklet';
  const p = share(t, M.riseStart + M.riseGap * i, M.riseMs);
  return { opacity: keyed(p, RISE_OPACITY), rise: keyed(p, RISE_Y) };
}

/** Where the last thing in the timeline ends. */
export function lastEnd(): number {
  return Math.max(
    M.scrimMs,
    M.cardMs,
    M.trainStart + M.trainMs,
    M.burstStart + (M.burstWaves - 1) * M.burstStagger + M.burstLife,
    M.badgeStart + M.badgeMs,
    IMPACT_MS + M.dustMs,
    M.sparkStart + (M.sparkCount - 1) * M.sparkGap + M.sparkMs,
    M.riseStart + (M.riseCount - 1) * M.riseGap + M.riseMs,
  );
}

export { CQ_PER_U };
