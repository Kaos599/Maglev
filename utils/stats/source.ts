/**
 * Where an add came from (docs/NATIVE_CONTRACT.md section 34.2). The engine does not store an origin, so call sites that know
 * it note it here, keyed by what the engine later reports: a torrent's info hash, or a link's address without query.
 * A small capped map in the kv store. An add that nobody noted has source null: unknown stays unknown.
 */
import { normalizeInfoHash } from '../../modules/maglev-engine/src/magnet.ts';
import type { StatsKind } from './types.ts';

export interface Origin {
  source: string | null;
  category: string | null;
}

const ORIGIN_KEY = 'maglev.stats.origins.v1';
const MAX_ORIGINS = 500;

const NONE: Origin = { source: null, category: null };

/** `h:<info hash>` for a magnet or a bare hash, `u:<scheme://host/path>` for a link, null for anything else. */
export function originKey(input: string): string | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  const m = /xt=urn:btih:([^&]+)/i.exec(text);
  if (m) {
    const h = normalizeInfoHash(m[1]);
    return h ? `h:${h.toLowerCase()}` : null;
  }
  const u = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(text);
  if (u) {
    const host = u[2].includes('@') ? u[2].slice(u[2].lastIndexOf('@') + 1) : u[2];
    return `u:${u[1].toLowerCase()}://${host.toLowerCase()}${u[3].replace(/\/+$/, '')}`;
  }
  const bare = normalizeInfoHash(text);
  return bare ? `h:${bare.toLowerCase()}` : null;
}

export interface OriginStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function createOriginTags(storage: OriginStorage, max: number = MAX_ORIGINS) {
  let map: Map<string, Origin> | null = null;

  const load = (): Map<string, Origin> => {
    if (map) return map;
    map = new Map();
    try {
      const raw = storage.get(ORIGIN_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object') {
            map.set(e[0], { source: typeof e[1].source === 'string' ? e[1].source : null, category: typeof e[1].category === 'string' ? e[1].category : null });
          }
        }
      }
    } catch {
      // Unreadable: start empty.
    }
    return map;
  };

  return {
    /** Remember where `sourceOrUrl` (a magnet, a hash or a link) came from. A later note for the same key wins. */
    note(sourceOrUrl: string, origin: { source: string | null; category?: string | null }): void {
      const key = originKey(sourceOrUrl);
      if (!key) return;
      const m = load();
      m.delete(key);
      m.set(key, { source: origin.source ?? null, category: origin.category ?? null });
      while (m.size > max) m.delete(m.keys().next().value as string);
      try {
        storage.set(ORIGIN_KEY, JSON.stringify([...m.entries()]));
      } catch {
        // Kept in memory only.
      }
    },
    /** The noted origin for an engine item, or nulls. Torrents match by id (their info hash); links by address. */
    lookup(kind: StatsKind, id: string, urlDisplay: string): Origin {
      const m = load();
      const key = kind === 'torrent' ? `h:${id.toLowerCase()}` : originKey(urlDisplay);
      return (key && m.get(key)) || NONE;
    },
  };
}
