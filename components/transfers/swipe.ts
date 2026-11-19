/**
 * Which swipe actions a Transfers row gets. Pure, so scripts/test-swipe.js can check every state.
 *
 *   Swipe right: Pause or Resume. It is the card's own button when that button is Pause or Resume
 *   (Retry on a failed torrent counts as Resume). Buttons that open a screen or override a rule
 *   (Open, Keep trying, Resume anyway, Free up space, Change in Settings) never come from a swipe.
 *   Swipe left: Remove from the list, files kept, through the same "Removed . Undo" path as bulk remove.
 *   A row waiting on the engine (pending tap, saved list) or moving its files gets nothing.
 */
export type SwipeRightKind = 'pause' | 'resume';

export interface SwipeRight {
  kind: SwipeRightKind;
  label: string;
}

export interface SwipeInput {
  /** The card's one button (torrentCardAction / downloadAction), or null. */
  action: { kind: string; label: string } | null | undefined;
  /** An optimistic action is in flight, or the row is the saved list before the engine answers. */
  busy: boolean;
  /** Files are being moved: removing now would race the move. */
  moving?: boolean;
  /** Long-press multi-select is active. */
  selectionMode: boolean;
  /** The "Swipe to pause or remove" setting. */
  enabled: boolean;
}

export interface SwipePlan {
  right: SwipeRight | null;
  left: boolean;
}

const NONE: SwipePlan = { right: null, left: false };

/**
 * How visible a swipe panel is, from how far its own side is revealed (drag distance in px, positive toward
 * that panel). The panels sit under the card with the same rounded corners, so a panel drawn at rest shows a
 * 1-2 px red or lime line through the card's anti-aliased corners. Hidden at rest and while the other side is
 * revealed; dimmed while dragging; full past the trigger. Half a pixel of slack covers a spring that settles
 * a hair off zero.
 */
export function panelOpacity(reveal: number, trigger: number): number {
  'worklet';
  if (reveal <= 0.5) return 0;
  return reveal >= trigger ? 1 : 0.85;
}

export function swipePlan({ action, busy, moving = false, selectionMode, enabled }: SwipeInput): SwipePlan {
  if (!enabled || selectionMode || busy) return NONE;
  const right: SwipeRight | null =
    action && (action.kind === 'pause' || action.kind === 'resume') ? { kind: action.kind, label: action.label } : null;
  return { right, left: !moving };
}
