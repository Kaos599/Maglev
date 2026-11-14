/**
 * The applied source list, in memory (docs/NATIVE_CONTRACT.md section 31.1 "Applying"). Pure: no React Native
 * imports, so search code and Node tests read it. `utils/lists/index.ts` fills it at start and after an update.
 */
import type { SourceEntry, SourcesFile } from './schema.ts';

let current: SourcesFile | null = null;
let version = 0;
const listeners = new Set<() => void>();
const cache = new WeakMap<object, { v: number; out: object }>();

/** Sets the applied file (null: built-in defaults, serial 0). */
export function setAppliedFile(file: SourcesFile | null): void {
  current = file;
  version++;
  listeners.forEach((l) => l());
}

export function getAppliedFile(): SourcesFile | null {
  return current;
}

/** Changes every time the applied file changes, for `useSyncExternalStore`. */
export function getListsVersion(): number {
  return version;
}

export function subscribeLists(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function sourceEntry(id: string): SourceEntry | undefined {
  return current?.sources[id];
}

/** Mirrors from the file for this provider, or null. */
export function listMirrors(id: string): string[] | null {
  return sourceEntry(id)?.mirrors ?? null;
}

/** Set when the file turned this source off (`enabled: false`); `note` is what Search providers shows. */
export function listDisabled(id: string): { note: string | null } | null {
  const e = sourceEntry(id);
  return e && e.enabled === false ? { note: e.note ?? null } : null;
}

/** Trackers from the file, or null for the built-in list. */
export function listTrackers(): string[] | null {
  return current?.trackers ?? null;
}

interface Overridable {
  id: string;
  mirrors: string[];
  unsafeReason?: string;
}

/**
 * The provider with the file's mirrors and warning applied (a user's own mirror override still wins later, in
 * aggregate.ts, because it replaces `mirrors` altogether). Returns the same object when the file says nothing
 * about it, and the same copy for the same file, so React keys and memo stay stable.
 */
export function applyListOverrides<P extends Overridable>(p: P): P {
  const e = current?.sources[p.id];
  if (!e || (e.mirrors === undefined && e.unsafeReason === undefined)) return p;
  const hit = cache.get(p);
  if (hit && hit.v === version) return hit.out as P;
  const out = { ...p } as P;
  if (e.mirrors) out.mirrors = e.mirrors;
  if (e.unsafeReason === null) delete out.unsafeReason;
  else if (typeof e.unsafeReason === 'string') out.unsafeReason = e.unsafeReason;
  cache.set(p, { v: version, out });
  return out;
}
