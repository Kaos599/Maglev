/** kv `highlights.lastSeenVersion`. */
import { kvGet, kvSet } from './kv.ts';

const KEY = 'highlights.lastSeenVersion';

export function getLastSeenVersion(): string | null {
  const v = kvGet(KEY);
  return v && v.trim() !== '' ? v : null;
}

export function setLastSeenVersion(version: string): void {
  kvSet(KEY, version);
}
