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

export type SelectionKind = 't' | 'd';

/** Selection keys carry the kind, so a torrent and a link download can never share an id. */
export const selectionKey = (kind: SelectionKind, id: string): string => `${kind}:${id}`;

export function parseSelectionKey(key: string): { kind: SelectionKind; id: string } {
  return key.startsWith('d:') ? { kind: 'd', id: key.slice(2) } : { kind: 't', id: key.startsWith('t:') ? key.slice(2) : key };
}

/** The selected ids, split into torrents and link downloads. */
export function splitSelection(keys: Iterable<string>): { torrents: string[]; downloads: string[] } {
  const out = { torrents: [] as string[], downloads: [] as string[] };
  for (const k of keys) {
    const { kind, id } = parseSelectionKey(k);
    (kind === 'd' ? out.downloads : out.torrents).push(id);
  }
  return out;
}
