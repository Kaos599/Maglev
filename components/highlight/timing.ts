/**
 * Every number in the new-feature highlight's entrance, in one place. Times are ms on one clock that starts when the
 * card opens. This is the approved motion design (maglev-highlight.html) with each CSS custom property carried over
 * by name. Lengths are in two units: `u` is one pixel of the train mark (the station, rail, burst and dust sit on
 * that grid) and `cq` is 1% of the phone width in the design (the card is 86 cq wide), so both scale with the card.
 * Pure data: no imports, so Node tests can load it.
 */
export type Curve = readonly number[];

/** One CSS-style cubic bezier, four numbers. */
const bez = (a: number, b: number, c: number, d: number): Curve => [a, b, c, d];

/** One train pixel in cq: the mark is 107 units wide and 46 cq wide. */
export const CQ_PER_U = 46 / 107;
/** The design's card is 86% of its phone's width. */
const CARD_CQ = 86;

export const HIGHLIGHT_MOTION = {
  scrimMs: 200,
  /** CSS `ease-out`. */
  easeOut: bez(0, 0, 0.58, 1),

  cardMs: 280,
  easeCard: bez(0.2, 0.9, 0.3, 1),
  cardFromScale: 0.92,
  /** The card grows to 1% past full size at 70% of its time, then settles. */
  cardOvershoot: 1.01,
  cardRiseCq: 2.5,

  trainStart: 80,
  trainMs: 520,
  /** Share of `trainMs` spent approaching; the rest is the settle. */
  trainBrake: 0.55,
  /** Start offset (u): 110 cq to the left of the mark. */
  trainFromU: -110 / CQ_PER_U,
  /** The brake carries the train this many train pixels past the mark. */
  trainOverU: 2,
  easeApproach: bez(0.22, 0.75, 0.3, 1),
  easeSettle: bez(0.45, 0, 0.55, 1),
  /** The one-pixel dip during the settle, and where in the settle it is held (share of the settle). */
  dipU: 1,
  dipFrom: 0.3,
  dipTo: 0.7,
  /** Where the nose of the parked train is, in mark units. */
  noseX: 115,
  /** Centre of the mark, in mark units (the rail is centred on it). */
  markCenterX: 63.5,

  railLitMs: 300,
  railDim: 0.45,

  burstStart: 380,
  burstLife: 480,
  burstStagger: 15,
  burstWaves: 4,
  burstCount: 14,
  burstSizes: [2, 3, 2, 4, 3, 2, 3, 2, 4, 2, 3, 2, 3, 2],

  badgeStart: 520,
  badgeMs: 340,
  /** Share of the badge's time at which it hits the card's edge (the haptic, flash and dust start here). */
  badgeImpact: 0.45,
  flashMs: 120,
  dustMs: 220,
  /** Dust pixels: start x, drift x, drift y, all in u. Two each side of the badge. */
  dust: [
    [-48, -7, -2],
    [-45, -4, -5],
    [46, 7, -2],
    [43, 4, -5],
  ],

  sparkStart: 700,
  sparkGap: 30,
  sparkMs: 180,
  sparkCount: 3,

  riseStart: 600,
  riseGap: 40,
  riseMs: 340,
  riseCq: 3,
  easeRise: bez(0.16, 1, 0.3, 1),
  /** Icon, title, body, primary, Not now, All release notes. */
  riseCount: 6,

  /** The clock runs 0 to this and stops. Nothing loops after it. */
  totalMs: 1140,
} as const;

/** Time the badge hits the card's edge: when the haptic fires. */
export const IMPACT_MS = HIGHLIGHT_MOTION.badgeStart + HIGHLIGHT_MOTION.badgeMs * HIGHLIGHT_MOTION.badgeImpact;

/** The station at the top of the card, in cq. */
export const STATION_CQ = { height: 26, railBottom: 4, below: 5 } as const;

/** The rail's two rows under the train, in mark units. Top row y, and the piece's full height. */
export const RAIL = { y: 79.5, h: 3.75 } as const;

/** Card box limits, so the highlight can size itself before the card has laid out. */
export function cardUnit(windowWidth: number, maxWidth: number, gutter: number): number {
  return Math.min(maxWidth, windowWidth - 2 * gutter) / CARD_CQ;
}

/** The Silkscreen badge: corner step and padding per segment, in cq. */
export const BADGE = {
  fontCq: 3.5,
  spacing: 0.06,
  step: 0.9,
  verStep: 0.6,
  newPad: [1.1, 1.5, 1.1, 1.4],
  verPad: [1.1, 1.5, 1.1, 2],
  restDeg: -4,
} as const;
