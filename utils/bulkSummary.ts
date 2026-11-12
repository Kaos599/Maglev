import { notices } from '../constants/copy.ts';

export type BulkVerb = 'Paused' | 'Resumed' | 'Deleted';

const INFINITIVE: Record<BulkVerb, string> = { Paused: 'pause', Resumed: 'resume', Deleted: 'delete' };

/**
 * One line after a multi-select action, for example `Paused 4. Couldn't finish 1.`.
 * Returns null when nothing failed (the rows changing is the feedback) or nothing was attempted.
 */
export function bulkSummary(verb: BulkVerb, results: readonly boolean[]): string | null {
  const failed = results.filter((ok) => !ok).length;
  if (failed === 0) return null;
  const done = results.length - failed;
  return done > 0 ? notices.bulk.someFailed(done, failed, verb) : notices.bulk.allFailed(failed, INFINITIVE[verb]);
}
