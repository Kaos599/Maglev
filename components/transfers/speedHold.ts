/** The right side of a status line may fall back from speed to amount only after the speed stayed at 0 this long. */
export const SPEED_HOLD_MS = 5000;

/** From this font scale up, the amount on the right shortens to what is downloaded ("1.23 GB"). */
const COMPACT_FONT_SCALE = 1.3;

export interface SpeedHoldState {
  /** When data last flowed (ms), or null if it has not since the card appeared. */
  lastFlowAt: number | null;
}

/**
 * Speed flicker guard. Returns the next state and `hold`: true while data flows, or flowed less than `holdMs` ago.
 * While `hold` is true the right side keeps the speed slot (a dash when the speed is 0); it goes back to the amount
 * only after a full `holdMs` of 0 or unknown speed, and returns to speed as soon as data flows.
 */
export function holdSpeed(
  prev: SpeedHoldState,
  speedBytes: number,
  now: number,
  holdMs: number = SPEED_HOLD_MS,
): { state: SpeedHoldState; hold: boolean; msLeft: number } {
  const flowing = Number.isFinite(speedBytes) && speedBytes > 0;
  const lastFlowAt = flowing ? now : prev.lastFlowAt;
  if (flowing) return { state: { lastFlowAt }, hold: true, msLeft: 0 };
  if (lastFlowAt == null) return { state: { lastFlowAt }, hold: false, msLeft: 0 };
  const msLeft = Math.max(0, holdMs - (now - lastFlowAt));
  return { state: { lastFlowAt }, hold: msLeft > 0, msLeft };
}

/** True when the font is large enough that the amount shortens. */
export function useCompactAmount(fontScale: number): boolean {
  return Number.isFinite(fontScale) && fontScale >= COMPACT_FONT_SCALE;
}

/** The phrase on the left keeps at least this much room (dp) before the amount shortens. */
export const MIN_PHRASE_DP = 80; // owner pick 2026-11-18 (option 2): full amount on most phones

export interface LineLayout {
  windowWidth: number;
  fontScale: number;
  /** The file-type icon or selection box on the left. */
  hasRail: boolean;
  /** The Play button (torrent cards), which sits left of the action button. */
  hasPlay: boolean;
  hasAction: boolean;
}

/**
 * Width (dp) of the status line inside a card: the window, minus the list margins (16 + 16), the border,
 * the left padding (16), the rail (24 + 12 gap) and the right padding for the action button (44 + 8),
 * which grows by 44 when Play sits beside it. Mirrors the card styles.
 */
export function statusLineWidth(l: Pick<LineLayout, 'windowWidth' | 'hasRail' | 'hasPlay' | 'hasAction'>): number {
  const right = 44 + 8 + (l.hasPlay && l.hasAction ? 44 : 0);
  return Math.max(0, l.windowWidth - 32 - 2 - 16 - (l.hasRail ? 36 : 0) - right);
}

/** Space-Mono-like glyph advance at the 12 sp status size, in dp at font scale 1. */
const GLYPH_DP = 12 * 0.612;
const GAP_DP = 8;
/** " · 34%" and a little more for "99%". */
const PCT_CHARS = 7;

/**
 * Whether the amount on the right shortens to the downloaded bytes ("1.23 GB"): always at font scale 1.3 and up,
 * and on a narrow card, when the full amount (`amountChars` glyphs) would leave the phrase under MIN_PHRASE_DP.
 */
export function shouldShortenAmount(l: LineLayout, amountChars: number): boolean {
  if (useCompactAmount(l.fontScale)) return true;
  const scale = Number.isFinite(l.fontScale) && l.fontScale > 0 ? l.fontScale : 1;
  const used = (amountChars + PCT_CHARS) * GLYPH_DP * scale + GAP_DP;
  return statusLineWidth(l) - used < MIN_PHRASE_DP;
}
