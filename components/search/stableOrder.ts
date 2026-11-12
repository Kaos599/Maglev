// Keeps search rows still while sources are still answering.
//
// Each source that answers re-ranks the whole merged list. Shown as-is, rows the user is reading
// jump down whenever a later source brings a better match. Instead, every row the user has had on
// screen keeps its slot (the "seen" prefix), and everything after it is ranked fresh. New rows
// therefore land in rank order below the fold, where nobody sees them move.

/** The shortest a result row can be: ResultRow minHeight 72 plus its 8 px bottom margin. */
export const MIN_ROW_PX = 80;

/**
 * How many rows from the top the user may have seen, from the furthest bottom edge of the screen
 * so far (scroll offset + list height). Rounded up and measured with the shortest row height, so it
 * errs on pinning one row too many, never one too few.
 */
export function seenRowCount(highWaterPx: number, minRowPx: number = MIN_ROW_PX): number {
  if (!Number.isFinite(highWaterPx) || highWaterPx <= 0 || minRowPx <= 0) return 0;
  return Math.ceil(highWaterPx / minRowPx);
}

/**
 * Orders `ranked` (already filtered and sorted) for display.
 * - The first `pinned` keys of `previous` (what was on screen last time) keep their order, with
 *   their fresh objects from `ranked`. Keys no longer in `ranked` drop out.
 * - Every other row follows in `ranked` order.
 * With `pinned` 0 or an empty `previous`, this is `ranked` itself (same array).
 */
export function stableOrder<T>(previous: readonly string[], ranked: readonly T[], pinned: number, keyOf: (item: T) => string): readonly T[] {
  const count = Math.min(Math.max(0, Math.floor(pinned)), previous.length);
  if (count === 0 || ranked.length === 0) return ranked;
  const byKey = new Map<string, T>();
  for (const item of ranked) byKey.set(keyOf(item), item);
  const head: T[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = previous[i];
    const item = byKey.get(key);
    if (item !== undefined && !taken.has(key)) {
      head.push(item);
      taken.add(key);
    }
  }
  if (head.length === 0) return ranked;
  // Nothing moved: hand back the ranked array so memoized consumers see no change in order.
  let same = true;
  for (let i = 0; i < head.length; i++) {
    if (keyOf(ranked[i]) !== keyOf(head[i])) {
      same = false;
      break;
    }
  }
  if (same) return ranked;
  const tail = ranked.filter((item) => !taken.has(keyOf(item)));
  return head.concat(tail);
}
