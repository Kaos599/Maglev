import Storage from 'expo-sqlite/kv-store';

const KEY = 'maglev.search.recents.v1';
const MAX_RECENTS = 8;

let memory: string[] | null = null;

function read(): string[] {
  try {
    const raw = Storage.getItemSync(KEY);
    if (!raw) return memory ?? [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_RECENTS);
  } catch {
    // Storage unavailable: use the in-memory copy for this session.
  }
  return memory ?? [];
}

function write(list: string[]): void {
  memory = list;
  try {
    Storage.setItemSync(KEY, JSON.stringify(list));
  } catch {
    // Kept in memory only.
  }
}

/** Last searches, newest first (max 8). */
export function getRecentSearches(): string[] {
  return read();
}

/** Adds a query to the front, de-duplicating case-insensitively. Returns the new list. */
export function addRecentSearch(query: string): string[] {
  const q = query.trim();
  if (!q) return read();
  const next = [q, ...read().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
  write(next);
  return next;
}

export function clearRecentSearches(): string[] {
  write([]);
  return [];
}
