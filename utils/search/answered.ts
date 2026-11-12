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

export interface FoldedSummary {
  text: string;
  /** True when a finished search had sources that did not answer, so the line should stand out. */
  attention: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The one plain line shown above the results: "23 results from 5 sources". The per-source chips and
 * the "x/y sources answered" detail sit behind it. A source that did not answer is said briefly
 * ("23 results from 4 of 5 sources") so it stays discoverable while the details are folded.
 */
export function foldedSummary(i: {
  tally: SourceTally;
  results: number;
  searching: boolean;
  stopped: boolean;
  /** Sources the search will ask, used until the first update names them. */
  eligible?: number;
}): FoldedSummary {
  const { tally, results, searching, stopped } = i;
  const total = tally.total || i.eligible || 0;
  if (searching) {
    return {
      text: results > 0 ? `${plural(results, 'result', 'results')} so far from ${tally.answered} of ${total} sources` : `Searching ${plural(total, 'source', 'sources')}`,
      attention: false,
    };
  }
  const missed = tally.answered < tally.total;
  const from = missed ? `${tally.answered} of ${tally.total} sources` : plural(tally.total, 'source', 'sources');
  return { text: `${stopped ? 'Stopped. ' : ''}${plural(results, 'result', 'results')} from ${from}`, attention: missed && !stopped };
}
