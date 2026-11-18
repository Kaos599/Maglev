/**
 * NATIVE_CONTRACT 43.1: the flow clock. One record per transfer id, shared by the card and the page so both say the
 * same thing about whether data is arriving. Pure functions take (prev, telemetry, now); the time is always passed in.
 * The module-level store at the bottom is the only state, in memory only.
 */
import { SPEED_HOLD_MS } from './speedHold.ts';

/** A run of 0 speed this long, while downloading, means the transfer is waiting, not working. Same 5 s as the speed hold. */
export const QUIET_MS = SPEED_HOLD_MS;

/** A record not fed for this long (screen off, app in the background) says nothing about how long data has been missing. */
export const STALE_MS = 30_000;

export interface FlowRecord {
  /** The last tick (ms) whose download speed was above 0, or null if none was seen this session. */
  lastFlowAt: number | null;
  /** The first tick (ms) of the current run of 0 speed while downloading, or null. */
  quietSince: number | null;
  /** The last tick that fed this record (ms). */
  seenAt: number | null;
}

export const EMPTY_FLOW: FlowRecord = { lastFlowAt: null, quietSince: null, seenAt: null };

export interface FlowTelemetry {
  downloading: boolean;
  speedBytes: number;
}

/** Next record for one tick of telemetry. */
export function advanceFlow(prev: FlowRecord | undefined, t: FlowTelemetry, now: number): FlowRecord {
  const p = prev ?? EMPTY_FLOW;
  const flowing = t.downloading && Number.isFinite(t.speedBytes) && t.speedBytes > 0;
  if (flowing) return { lastFlowAt: now, quietSince: null, seenAt: now };
  if (!t.downloading) return { lastFlowAt: p.lastFlowAt, quietSince: null, seenAt: now };
  const stale = p.seenAt != null && now - p.seenAt > STALE_MS;
  const quietSince = p.quietSince == null || stale ? now : p.quietSince;
  return { lastFlowAt: p.lastFlowAt, quietSince, seenAt: now };
}

/** How long the current run of 0 speed has lasted (ms). 0 when data flows or the state is not downloading. */
export function quietMs(rec: FlowRecord | undefined, now: number): number {
  if (!rec || rec.quietSince == null) return 0;
  return Math.max(0, now - rec.quietSince);
}

/** True while data flowed less than QUIET_MS ago: the speed slot keeps its place (the 5 s hold). */
export function flowHold(rec: FlowRecord | undefined, now: number): boolean {
  return !!rec && rec.lastFlowAt != null && now - rec.lastFlowAt < QUIET_MS;
}

/** Ms since data last arrived, or null when none was seen this session. */
export function lastDataAgoMs(rec: FlowRecord | undefined, now: number): number | null {
  if (!rec || rec.lastFlowAt == null) return null;
  return Math.max(0, now - rec.lastFlowAt);
}

// ---- Store ----

const records = new Map<string, FlowRecord>();

/** Feeds one tick for a transfer and returns its record. */
export function feedFlow(id: string, t: FlowTelemetry, now: number): FlowRecord {
  const next = advanceFlow(records.get(id), t, now);
  records.set(id, next);
  return next;
}

export function peekFlow(id: string): FlowRecord | undefined {
  return records.get(id);
}

export function forgetFlow(id: string): void {
  records.delete(id);
}

/** For tests. */
export function resetFlow(): void {
  records.clear();
}
