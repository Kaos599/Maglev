/**
 * Telemetry arrives once a second (NATIVE_CONTRACT: `onTelemetry` once per second) as fresh objects.
 * These helpers keep the previous objects when nothing in them changed, so React state only updates
 * on a real change and memoized rows keep their identity. Pure: no React, no react-native.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameFlat(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k in a) if (a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a) && b[k] !== undefined) return false;
  return true;
}

/**
 * True when every field is equal. Plain-object fields (`error: {code, message}`) are compared one
 * level deep; a missing field and `undefined` count as equal.
 */
export function sameFields(a: object, b: object): boolean {
  if (a === b) return true;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    const u = x[k];
    const v = y[k];
    if (u === v) continue;
    if (isPlainObject(u) && isPlainObject(v) && sameFlat(u, v)) continue;
    return false;
  }
  return true;
}

/**
 * The next list with every unchanged row replaced by its previous object. Returns `prev` itself
 * when the lists hold the same rows in the same order, so callers can skip `setState`.
 */
export function shareRows<T extends { id: string }>(prev: readonly T[], next: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();
  for (const p of prev) byId.set(p.id, p);
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const p = byId.get(n.id);
    if (p && sameFields(p, n)) {
      if (prev[i] !== p) changed = true;
      return p;
    }
    changed = true;
    return n;
  });
  return changed ? out : prev;
}

/**
 * Seconds a magnet has looked for peers, in steps for the Transfers list: 5 s for the first minute,
 * 15 s up to ten minutes, then whole minutes. Rounded down, so the shown time is never more than the
 * real one. The row then changes every few seconds instead of every second (a per-second change keeps
 * Android from ever reaching an idle screen). Null stays null.
 */
export function steadyResolvingSecs(secs: number | null | undefined): number | null {
  if (secs == null) return null;
  if (!Number.isFinite(secs) || secs < 0) return 0;
  const step = secs < 60 ? 5 : secs < 600 ? 15 : 60;
  return Math.floor(secs / step) * step;
}
