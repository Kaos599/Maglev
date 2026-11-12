/**
 * Optimistic pause, resume and remove for the Transfers list. Pure: no React, no engine.
 *
 * A tap records a pending entry. Rows are shown with the entry applied on top of the engine's
 * latest telemetry until one of these happens:
 * - telemetry agrees (paused row is PAUSED, resumed row left PAUSED, removed row is gone),
 * - the engine call fails (the caller drops the group: the row is the engine row again),
 * - the entry is older than the timeout (telemetry is trusted again).
 * Telemetry that arrives in between cannot flip the row back.
 *
 * No numbers are invented: a pause shows zero speed (the user asked for it), a resume keeps the
 * engine's state and only sets `pending`, a remove hides the row.
 */
import type { TorrentState, PausedBy } from 'maglev-engine';

export type PendingKind = 'pause' | 'resume' | 'remove';

export interface PendingEntry {
  kind: PendingKind;
  /** When the tap happened (ms). */
  since: number;
  /** One tap or one bulk action; failure rolls back the whole group. */
  group: number;
  /** The engine call returned ok. The hold stays until telemetry agrees or the timeout. */
  confirmed: boolean;
}

export type PendingMap = Readonly<Record<string, PendingEntry>>;

export const EMPTY_PENDING: PendingMap = Object.freeze({});

/** The fields this module reads or writes. Every Transfers row has them. */
export interface OptimisticRow {
  id: string;
  state: TorrentState;
  pausedBy?: PausedBy | null;
  downloadSpeedBytes: number;
  uploadSpeedBytes: number;
  rawDownBps?: number;
  rawUpBps?: number;
  etaSeconds: number;
  pending?: boolean;
  pendingAction?: PendingKind;
}

/** Records `kind` for every id (a newer tap on the same id replaces the older entry). */
export function beginPending(map: PendingMap, ids: readonly string[], kind: PendingKind, group: number, now: number): PendingMap {
  if (ids.length === 0) return map;
  const next: Record<string, PendingEntry> = { ...map };
  for (const id of ids) next[id] = { kind, since: now, group, confirmed: false };
  return next;
}

/** The engine call for `group` returned ok. */
export function confirmGroup(map: PendingMap, group: number): PendingMap {
  let next: Record<string, PendingEntry> | null = null;
  for (const id of Object.keys(map)) {
    const e = map[id];
    if (e.group !== group || e.confirmed) continue;
    next ??= { ...map };
    next[id] = { ...e, confirmed: true };
  }
  return next ?? map;
}

/** The engine call for `group` failed: drop its entries so the rows show the engine's snapshot again. */
export function failGroup(map: PendingMap, group: number): PendingMap {
  let next: Record<string, PendingEntry> | null = null;
  for (const id of Object.keys(map)) {
    if (map[id].group !== group) continue;
    next ??= { ...map };
    delete next[id];
  }
  return next ?? map;
}

/** True when the engine row already shows what the tap asked for. `row` undefined = not in the engine list. */
export function isSettled(row: Pick<OptimisticRow, 'state'> | undefined, entry: Pick<PendingEntry, 'kind'>): boolean {
  if (entry.kind === 'remove') return row === undefined;
  if (row === undefined) return true; // the torrent is gone: nothing left to hold
  // Any state but PAUSED means the engine acted on a resume (ERROR and "waiting" states included).
  return entry.kind === 'pause' ? row.state === 'PAUSED' : row.state !== 'PAUSED';
}

/** Drops entries that telemetry confirmed or that timed out. Returns the same map when nothing changed. */
export function settlePending(map: PendingMap, rows: readonly Pick<OptimisticRow, 'id' | 'state'>[], now: number, timeoutMs: number): PendingMap {
  const ids = Object.keys(map);
  if (ids.length === 0) return map;
  const byId = new Map<string, Pick<OptimisticRow, 'id' | 'state'>>();
  for (const r of rows) byId.set(r.id, r);
  let next: Record<string, PendingEntry> | null = null;
  for (const id of ids) {
    const e = map[id];
    if (now - e.since < timeoutMs && !isSettled(byId.get(id), e)) continue;
    next ??= { ...map };
    delete next[id];
  }
  return next ?? map;
}

/** When the oldest entry times out (ms), or null when nothing is pending. */
export function nextExpiry(map: PendingMap, timeoutMs: number): number | null {
  let at: number | null = null;
  for (const id of Object.keys(map)) {
    const t = map[id].since + timeoutMs;
    if (at === null || t < at) at = t;
  }
  return at;
}

function overlay<T extends OptimisticRow>(row: T, entry: PendingEntry): T {
  if (entry.kind === 'pause') {
    return {
      ...row,
      state: 'PAUSED',
      pausedBy: 'user',
      downloadSpeedBytes: 0,
      uploadSpeedBytes: 0,
      rawDownBps: 0,
      rawUpBps: 0,
      etaSeconds: -1,
      pending: true,
      pendingAction: 'pause',
    };
  }
  // Resume: the engine decides what comes next (downloading, seeding, queued, waiting for Wi-Fi).
  return { ...row, pending: true, pendingAction: 'resume' };
}

/**
 * Rows as the user should see them: pending entries applied, removed and `hidden` rows left out.
 * Rows without an entry keep their object, and the input array is returned when nothing applies.
 */
export function applyPending<T extends OptimisticRow>(rows: readonly T[], map: PendingMap, hidden?: ReadonlySet<string>): T[] {
  const noHidden = !hidden || hidden.size === 0;
  if (noHidden && Object.keys(map).length === 0) return rows as T[];
  const out: T[] = [];
  let changed = false;
  for (const r of rows) {
    const e = map[r.id];
    if ((hidden && hidden.has(r.id)) || e?.kind === 'remove') {
      changed = true;
      continue;
    }
    if (e && !isSettled(r, e)) {
      out.push(overlay(r, e));
      changed = true;
    } else {
      out.push(r);
    }
  }
  return changed ? out : (rows as T[]);
}
