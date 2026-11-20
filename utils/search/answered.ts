// How many search sources actually answered. Pure: no React, no IO.
import type { SourceStatus } from './types';

/**
 * A source answered when it returned a list (with or without hits). A source that is still searching,
 * timed out, failed, was blocked or sits behind a Cloudflare check has not answered.
 */
function hasAnswered(s: SourceStatus): boolean {
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

/**
 * The short line under the result count: "12 of 14 sources" when some did not answer, "No source answered" (bad)
 * when none did, null when all did. A source behind a quick check counts as not answered; the fix hint offers it.
 */
export function sourcesLine(t: SourceTally): { text: string; bad: boolean } | null {
  if (t.total === 0 || t.answered >= t.total) return null;
  if (t.answered === 0) return { text: 'No source answered', bad: true };
  return { text: `${t.answered} of ${t.total} sources`, bad: false };
}

/** True when no source answered at all (and there was at least one). */
export function allFailed(t: SourceTally): boolean {
  return t.total > 0 && t.answered === 0 && t.needsCheck + t.failed === t.total;
}

/** "84 results · 1 didn't respond"; "Stopped · " leads when the user stopped the search. */
export function resultsSummary(count: number, t: SourceTally, stopped: boolean): string {
  const base = `${stopped ? 'Stopped · ' : ''}${count} ${count === 1 ? 'result' : 'results'}`;
  const note = unansweredNote(t);
  return note ? `${base} · ${note}` : base;
}

/** A plain reason a source did not answer. Built from the state and the message the search already keeps. */
export function unansweredReason(s: SourceStatus): string {
  if (s.state === 'timeout') return "Didn't answer in time";
  if (s.state === 'blocked') return 'Blocked by a bot check';
  if (s.state === 'challenge') return 'Needs a quick check';
  const m = s.message ?? '';
  if (m === 'Down for maintenance' || m === 'Not answering right now') return m;
  if (/^HTTP 5\d\d$/.test(m)) return 'Not answering right now';
  if (/network|failed to fetch|offline|connection|dns|resolve|timed? ?out/i.test(m)) return 'No connection';
  return "Didn't respond";
}

export interface UnansweredSource {
  providerId: string;
  name: string;
  reason: string;
}

/** The sources that did not answer, with their names and reasons, for the sheet behind the note. */
export function unansweredSources(sources: SourceStatus[], nameOf: (id: string) => string): UnansweredSource[] {
  return sources
    .filter((s) => s.state !== 'searching' && !hasAnswered(s))
    .map((s) => ({ providerId: s.providerId, name: nameOf(s.providerId), reason: unansweredReason(s) }));
}

/** After the user closes the "needs a quick check" line, it stays away this long. */
const FIX_HINT_QUIET_MS = 24 * 60 * 60 * 1000;

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
