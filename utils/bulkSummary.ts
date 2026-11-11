export type BulkVerb = 'Paused' | 'Resumed' | 'Deleted';

/**
 * One line after a multi-select action, for example `Paused 4 · 1 couldn't`.
 * Returns null when nothing failed (the rows changing is the feedback) or nothing was attempted.
 */
export function bulkSummary(verb: BulkVerb, results: readonly boolean[]): string | null {
  const failed = results.filter((ok) => !ok).length;
  if (failed === 0) return null;
  const done = results.length - failed;
  return done > 0 ? `${verb} ${done} · ${failed} couldn't` : `${failed} couldn't be ${verb.toLowerCase()}`;
}
