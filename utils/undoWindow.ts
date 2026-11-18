/**
 * How long "Removed X · Undo" stays. Android can ask for longer through its accessibility timeout setting
 * (`AccessibilityInfo.getRecommendedTimeoutMillis`, Android only, async). Never shorter than the base. Pure.
 */
export const UNDO_BASE_MS = 5000;

/** The window for a recommended timeout: the larger of it and the base; a missing or unreadable value gives the base. */
export function undoWindowMs(recommended: number | null | undefined, base: number = UNDO_BASE_MS): number {
  return typeof recommended === 'number' && Number.isFinite(recommended) ? Math.max(base, Math.round(recommended)) : base;
}
