// Per-session handle registry (SM-31, ASSISTANT_DESIGN §4.1). The model only ever sees short handles:
// r1.. search results, t1.. transfers, f1.. files, c1.. cards. The real ids (info-hashes, engine ids,
// file indices) stay in this map and never reach the model. A handle is built from a prefix and a counter,
// so it can never contain a hash, magnet or device path.
// Clearing the chat (SM-31 `CLEAR`) calls clear(), which drops every handle but keeps the counters going, so a handle is never reused
// within the app's lifetime (a slow card prepared before Clear can never match a card made after it).
// Pure TypeScript: no React, no React Native, no engine imports.

export type HandleKind = 'result' | 'transfer' | 'file' | 'card';

/** The real id behind a handle. Engine ids are numbers or strings; file handles may store a composite string. */
export type HandleValue = string | number;

const PREFIX: Record<HandleKind, string> = {
  result: 'r',
  transfer: 't',
  file: 'f',
  card: 'c',
};

const KIND_BY_PREFIX: Record<string, HandleKind> = {
  r: 'result',
  t: 'transfer',
  f: 'file',
  c: 'card',
};

const HANDLE_RE = /^([rtfc])([1-9][0-9]{0,8})$/;

export class HandleRegistry {
  private readonly byHandle = new Map<string, { kind: HandleKind; value: HandleValue }>();
  private readonly byReal = new Map<string, string>();
  private readonly counters: Record<HandleKind, number> = { result: 0, transfer: 0, file: 0, card: 0 };

  /**
   * Return the handle for a real id, creating one on first use. The same (kind, id) always gives the same handle
   * within a session, so the model can refer back to a result it saw earlier.
   *
   * Result handles are keyed by info hash: `issue('result', infoHash)` is idempotent, so the same torrent
   * found by two searches, or by two sources, keeps one handle. Scoring (scoring.ts) assigns no ids; the
   * search tool issues handles here, after ranking, in the order it shows the rows.
   */
  issue(kind: HandleKind, value: HandleValue): string {
    const key = realKey(kind, value);
    const existing = this.byReal.get(key);
    if (existing) return existing;
    this.counters[kind] += 1;
    const handle = `${PREFIX[kind]}${this.counters[kind]}`;
    this.byHandle.set(handle, { kind, value });
    this.byReal.set(key, handle);
    return handle;
  }

  /**
   * Resolve a handle the model sent back. Returns null for malformed, unknown or wrong-kind handles.
   * Pass `kind` to make sure, for example, a `propose_add` never accepts a transfer handle.
   */
  resolve(handle: unknown, kind?: HandleKind): HandleValue | null {
    if (typeof handle !== 'string') return null;
    const entry = this.byHandle.get(handle);
    if (!entry) return null;
    if (kind !== undefined && entry.kind !== kind) return null;
    return entry.value;
  }

  /** Reverse lookup: the handle for a real id issued in this session, or null. */
  handleFor(kind: HandleKind, value: HandleValue): string | null {
    return this.byReal.get(realKey(kind, value)) ?? null;
  }

  /** True when the string is a well-formed handle, whether or not it is currently issued. */
  static isHandle(text: unknown): boolean {
    return typeof text === 'string' && HANDLE_RE.test(text);
  }

  /** Kind encoded in a well-formed handle prefix, or null. */
  static kindOf(handle: unknown): HandleKind | null {
    if (typeof handle !== 'string') return null;
    const m = HANDLE_RE.exec(handle);
    return m ? KIND_BY_PREFIX[m[1]] : null;
  }

  /**
   * Drop every handle of one kind and restart that kind's counter. Other kinds keep their handles.
   * Use it to reset `result` handles for a fresh search. Not needed when earlier results should stay
   * addressable ("add #1" after a second search still means the first list), so the search tool decides.
   */
  clearKind(kind: HandleKind): void {
    for (const [handle, entry] of [...this.byHandle]) {
      if (entry.kind !== kind) continue;
      this.byHandle.delete(handle);
      this.byReal.delete(realKey(kind, entry.value));
    }
    this.counters[kind] = 0;
  }

  /** Drop all handles; counters keep counting. Called on chat clear and when the API key is removed (ASSISTANT_DESIGN §5, `CLEAR` / `KEY_REMOVED`). */
  clear(): void {
    this.byHandle.clear();
    this.byReal.clear();
  }

  get size(): number {
    return this.byHandle.size;
  }
}

function realKey(kind: HandleKind, value: HandleValue): string {
  return `${kind}\u0000${typeof value}\u0000${String(value)}`;
}
