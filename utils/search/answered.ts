// How many search sources actually answered. Pure: no React, no IO.
import type { SourceStatus } from './types';

/**
 * A source answered when it returned a list (with or without hits). A source that is still searching,
 * timed out, failed, was blocked or sits behind a Cloudflare check has not answered.
 */
export function hasAnswered(s: SourceStatus): boolean {
  return s.state === 'done' || s.state === 'empty';
}

export interface SourceTally {
  total: number;
  answered: number;
  /** Sources that need the user to pass a Cloudflare check (they have not answered). */
  needsCheck: number;
  /** Sources that gave up: timeout, error or blocked. */
  failed: number;
}

export function tallySources(sources: SourceStatus[]): SourceTally {
  let answered = 0;
  let needsCheck = 0;
  let failed = 0;
  for (const s of sources) {
    if (hasAnswered(s)) answered++;
    else if (s.state === 'challenge') needsCheck++;
    else if (s.state === 'timeout' || s.state === 'error' || s.state === 'blocked') failed++;
  }
  return { total: sources.length, answered, needsCheck, failed };
}

/** "1 needs a quick check", "2 need a quick check · 1 didn't respond", or "" when everything answered. */
export function unansweredNote(t: SourceTally): string {
  const parts: string[] = [];
  if (t.needsCheck > 0) parts.push(t.needsCheck === 1 ? '1 needs a quick check' : `${t.needsCheck} need a quick check`);
  if (t.failed > 0) parts.push(t.failed === 1 ? "1 didn't respond" : `${t.failed} didn't respond`);
  return parts.join(' · ');
}

/** After the user closes the "needs a quick check" line, it stays away this long. */
export const FIX_HINT_QUIET_MS = 24 * 60 * 60 * 1000;

/** Show the fix line when a source needs a check and the user has not closed it in the last 24 hours. */
export function shouldShowFixHint(now: number, dismissedAt: number, needsCheck: number): boolean {
  if (needsCheck <= 0) return false;
  if (!dismissedAt || dismissedAt > now) return true;
  return now - dismissedAt >= FIX_HINT_QUIET_MS;
}

/** Providers that need a check after a search: the ones now behind a check, plus earlier ones that did not answer this time. */
export function nextNeedsCheck(previous: string[], sources: SourceStatus[]): string[] {
  const behind = sources.filter((s) => s.state === 'challenge').map((s) => s.providerId);
  const answered = new Set(sources.filter(hasAnswered).map((s) => s.providerId));
  return [...new Set([...previous.filter((id) => !answered.has(id)), ...behind])];
}
