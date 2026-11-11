/*
 * The pure parts of the Maglev mark's motion: frame timing, how far the boost travels, and the
 * gates that stop it replaying. No React Native imports, so scripts/test-mark-motion.js runs it.
 * The frame counts here must match the boost frames scripts/build-logo.py writes to markPaths.ts.
 */

/** Crouch before the launch, as a fraction of the mark's height (two frames, moving back). */
const CROUCH = [0.05, 0.1];
/** Launch: share of the distance to the right screen edge covered by each frame. Accelerates. */
const EXIT = [0.03, 0.12, 0.32, 0.62, 1];
/** Re-entry: share of the distance from the left screen edge still to go. Decelerates to rest. */
const ENTER = [1, 0.55, 0.25, 0.09, 0.02, 0];

export const BOOST_FRAMES = CROUCH.length + EXIT.length + ENTER.length;
/** The arrival (cold start) is the boost from this frame on: the re-entry alone. */
export const BOOST_ENTER_AT = CROUCH.length + EXIT.length;

/**
 * The train's x offset, in whole dp, for every frame of a boost.
 * `left` is how far it must move left to be fully off screen, `right` the same to the right.
 */
export function boostTravel(left: number, right: number, height: number): number[] {
  const crouch = CROUCH.map((f) => -Math.max(1, Math.round(height * f)));
  const exit = EXIT.map((f) => Math.round(right * f));
  const enter = ENTER.map((f) => (f === 0 ? 0 : -Math.max(1, Math.round(left * f))));
  return [...crouch, ...exit, ...enter];
}

const EPS = 1e-4;

/**
 * Sprite-style interpolation ranges: hold each frame's value for its slice of the clock, then jump.
 * A loop ends back on the first frame; a one-shot holds its last frame.
 */
export function steppedRanges(values: number[], loop: boolean): { inputRange: number[]; outputRange: number[] } {
  const n = values.length;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  values.forEach((v, k) => {
    inputRange.push(k / n, (k + 1) / n - EPS);
    outputRange.push(v, v);
  });
  inputRange.push(1);
  outputRange.push(loop ? values[0] : values[n - 1]);
  return { inputRange, outputRange };
}

/** One boost at a time: a tap while one is playing is ignored. */
export function createTapGate() {
  let busy = false;
  return {
    /** True if the caller may start a boost; it then owns the gate until `finish`. */
    tryStart(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    finish(): void {
      busy = false;
    },
    get busy(): boolean {
      return busy;
    },
  };
}

let arrivalClaimed = false;

/** True the first time it is called in this process: the arrival plays once per cold start. */
export function claimArrival(): boolean {
  if (arrivalClaimed) return false;
  arrivalClaimed = true;
  return true;
}

/** Extra touch area so a mark smaller than the minimum target still gets one. */
export function hitSlopFor(width: number, height: number, min = 44) {
  const v = Math.max(0, Math.ceil((min - height) / 2));
  const h = Math.max(0, Math.ceil((min - width) / 2));
  return { top: v, bottom: v, left: h, right: h };
}
