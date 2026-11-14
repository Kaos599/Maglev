/**
 * Star prompt decision (docs/NATIVE_CONTRACT.md section 33). Pure: no storage, no clock, no UI.
 */
export interface StarState {
  /** Epoch ms of the first run of this code, or null before it. */
  firstSeenAt: number | null;
  /** Finished transfers counted from completion events. */
  completedCount: number;
  /** Epoch ms of the last "Not now", or null. */
  lastDismissedAt: number | null;
  dismissCount: number;
  starred: boolean;
  never: boolean;
}

export interface StarContext {
  onboarding: boolean;
  /** Another sheet, modal or card is open. */
  overlayOpen: boolean;
  /** The browser screen is showing and a page is loading. */
  browserLoading: boolean;
  /** The card has already been shown in this app session. */
  shownThisSession: boolean;
  /** The app is in the foreground. */
  foreground: boolean;
}

export const STAR_MIN_COMPLETED = 3;
export const STAR_MIN_DAYS_SINCE_FIRST = 7;
export const STAR_MIN_DAYS_SINCE_DISMISS = 30;
export const STAR_MAX_DISMISSALS = 3;
export const STAR_DELAY_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultStarState(): StarState {
  return { firstSeenAt: null, completedCount: 0, lastDismissedAt: null, dismissCount: 0, starred: false, never: false };
}

/** True when every gate holds. Call it right after a transfer finished. */
export function shouldAskForStar(state: StarState, now: number, ctx: StarContext): boolean {
  if (state.starred || state.never) return false;
  if (!ctx.foreground || ctx.onboarding || ctx.overlayOpen || ctx.browserLoading || ctx.shownThisSession) return false;
  if (state.completedCount < STAR_MIN_COMPLETED) return false;
  if (state.firstSeenAt == null || now - state.firstSeenAt < STAR_MIN_DAYS_SINCE_FIRST * DAY_MS) return false;
  if (state.dismissCount >= STAR_MAX_DISMISSALS) return false;
  if (state.lastDismissedAt != null && now - state.lastDismissedAt < STAR_MIN_DAYS_SINCE_DISMISS * DAY_MS) return false;
  return true;
}

export function withFirstSeen(state: StarState, now: number): StarState {
  return state.firstSeenAt == null ? { ...state, firstSeenAt: now } : state;
}

export function afterCompleted(state: StarState): StarState {
  return { ...state, completedCount: state.completedCount + 1 };
}

/** "Not now", Back and the scrim. The third one becomes "never". */
export function afterNotNow(state: StarState, now: number): StarState {
  const dismissCount = state.dismissCount + 1;
  return { ...state, lastDismissedAt: now, dismissCount, never: state.never || dismissCount >= STAR_MAX_DISMISSALS };
}

export function afterNever(state: StarState): StarState {
  return { ...state, never: true };
}

export function afterStarred(state: StarState): StarState {
  return { ...state, starred: true };
}
