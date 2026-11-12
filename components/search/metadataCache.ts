// The session's one background file-list reader, bound to the real engine.
// Search starts reads (top result only); the Add screen takes them by source string.
import { maglevEngine, parseSource } from 'maglev-engine';
import { MetadataPrefetcher, type MetadataResult } from './prefetch';

export const metadataPrefetch = new MetadataPrefetcher({
  resolveMetadata: (source, timeoutMs) => maglevEngine.resolveMetadata(source, timeoutMs),
  cancelResolve: (infoHash) => maglevEngine.cancelResolve(infoHash),
});

/** The info hash the engine uses for a magnet, or null for anything else. */
export function magnetHash(source: string): string | null {
  const parsed = parseSource(source);
  return parsed?.kind === 'magnet' ? parsed.infoHash : null;
}

/**
 * For the Add screen: the background read for this magnet, finished or still running, or null when
 * Search never read it. The caller treats the answer exactly like its own resolveMetadata call.
 */
export function takePrefetchedMetadata(source: string): Promise<MetadataResult> | null {
  const hash = magnetHash(source);
  return hash ? metadataPrefetch.take(hash) : null;
}
