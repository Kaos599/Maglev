/**
 * Swiping the address bar to change tabs. Pure decisions only, so they can be tested without a device.
 * Positions are in dp, velocities in dp per second. Indexes are positions in the tab strip (TabSwitcher order).
 */

/** A touch that starts this close to a screen edge belongs to the system back gesture. */
const SWIPE_EDGE_DP = 24;
/** Horizontal distance that switches tabs on release. */
const SWIPE_DISTANCE_DP = 56;
/** A quick flick switches tabs from this speed, once the finger has moved at least SWIPE_MIN_FLICK_DP. */
const SWIPE_VELOCITY = 600;
const SWIPE_MIN_FLICK_DP = 16;
/** Downward distance and speed that open the tab switcher. */
const SWIPE_DOWN_DISTANCE_DP = 40;
const SWIPE_DOWN_VELOCITY = 500;
/** How far the bar may follow the finger at most. */
export const SWIPE_MAX_DRAG_DP = 72;

export type SwipeDecision = 'prev' | 'next' | 'none';

/** True when a swipe that began at `startX` (screen coordinates) must be ignored. */
export function swipeStartsAtEdge(startX: number, screenWidth: number, edge: number = SWIPE_EDGE_DP): boolean {
  if (!Number.isFinite(startX) || !Number.isFinite(screenWidth)) return true;
  return startX < edge || startX > screenWidth - edge;
}

/** Swipe left (negative dx) goes to the next tab in the strip, swipe right to the previous one. Never wraps. */
export function decideSwipe(dx: number, vx: number, index: number, count: number): SwipeDecision {
  if (!Number.isFinite(dx) || !Number.isFinite(vx) || count < 2 || index < 0 || index >= count) return 'none';
  const far = Math.abs(dx) >= SWIPE_DISTANCE_DP;
  const flick = Math.abs(dx) >= SWIPE_MIN_FLICK_DP && Math.abs(vx) >= SWIPE_VELOCITY && Math.sign(vx) === Math.sign(dx);
  if (!far && !flick) return 'none';
  if (dx < 0) return index + 1 < count ? 'next' : 'none';
  return index - 1 >= 0 ? 'prev' : 'none';
}

/** The index a drag in direction `dx` would move to, or null at an end of the strip. */
export function neighbourIndex(dx: number, index: number, count: number): number | null {
  if (count < 2 || dx === 0) return null;
  const i = dx < 0 ? index + 1 : index - 1;
  return i >= 0 && i < count ? i : null;
}

/** Vertical swipe on the bar. The bar is at the top of the screen, so only a downward swipe counts. */
export function decideVertical(dy: number, vy: number): 'switcher' | 'none' {
  if (!Number.isFinite(dy) || !Number.isFinite(vy)) return 'none';
  return dy >= SWIPE_DOWN_DISTANCE_DP || (dy >= SWIPE_MIN_FLICK_DP && vy >= SWIPE_DOWN_VELOCITY) ? 'switcher' : 'none';
}

/**
 * How far the bar follows the finger. With a neighbour it follows 1:1 up to `max`; at an end (no neighbour) it gives
 * a third of the pull, capped lower, so it feels held back.
 */
export function dragOffset(dx: number, hasNeighbour: boolean, max: number = SWIPE_MAX_DRAG_DP): number {
  if (!Number.isFinite(dx)) return 0;
  const limit = hasNeighbour ? max : max / 4;
  const v = hasNeighbour ? dx : dx / 3;
  return Math.max(-limit, Math.min(limit, v));
}
