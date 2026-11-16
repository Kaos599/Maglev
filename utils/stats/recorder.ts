/**
 * Turns engine snapshots into stats writes (docs/NATIVE_CONTRACT.md section 34.2). Pure logic plus a small coordinator whose
 * store, prefs and baseline storage are injected.
 *
 * The baseline is the counters seen at the last write, kept per item and saved between launches, so bytes moved while the app
 * was closed (the foreground service keeps going) are counted when it next looks. A counter that goes down (engine restart,
 * FILE_CHANGED restart) counts as a fresh start: the delta is the new value, never negative.
 */
import type { DownloadSnapshot, Snapshot } from '../../modules/maglev-engine/src/MaglevEngine.types.ts';
import { dayKey } from './time.ts';
import type { DayCounts, StatsKind, StatsRecord } from './types.ts';
import { zeroDay } from './types.ts';
import type { Origin } from './source.ts';
import type { StatsPrefs } from './prefs.ts';
import type { StatsStore } from './store.ts';

export { dayKey } from './time.ts';

/** The 0.26 engine fields (NATIVE_CONTRACT 34.1). Read as optional so this compiles and runs with or without them. */
type TimingFields = { activeSecs?: number; finishedAt?: number; sessionBytes?: number; bytesWifi?: number; bytesMobile?: number };

export const FLUSH_MS = 60_000;

export interface StatsItem {
  id: string;
  kind: StatsKind;
  name: string;
  size: number;
  /** For link origin lookups. Empty for a torrent. */
  urlDisplay: string;
  errored: boolean;
  activeSecs: number;
  finishedAt: number;
  sessionBytes: number;
  uploaded: number;
  bytesWifi: number;
  bytesMobile: number;
  addedAt: number;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function toItems(torrents: readonly Snapshot[], downloads: readonly DownloadSnapshot[]): StatsItem[] {
  const out: StatsItem[] = [];
  for (const t of torrents) {
    const x = t as Snapshot & TimingFields;
    out.push({
      id: t.id, kind: 'torrent', name: t.name, size: n(t.includedBytes) || n(t.totalBytes), urlDisplay: '',
      errored: t.state === 'ERROR' || t.error != null,
      activeSecs: n(x.activeSecs), finishedAt: n(x.finishedAt), sessionBytes: n(x.sessionBytes), uploaded: n(t.uploadedBytes),
      bytesWifi: n(x.bytesWifi), bytesMobile: n(x.bytesMobile), addedAt: n(t.addedAt),
    });
  }
  for (const d of downloads) {
    const x = d as DownloadSnapshot & TimingFields;
    out.push({
      id: d.id, kind: d.stream ? 'stream' : 'link', name: d.name, size: n(d.size) || n(d.downloaded), urlDisplay: d.urlDisplay,
      errored: d.state === 'error' || d.error != null,
      activeSecs: n(x.activeSecs), finishedAt: n(x.finishedAt), sessionBytes: n(x.sessionBytes), uploaded: 0,
      bytesWifi: n(x.bytesWifi), bytesMobile: n(x.bytesMobile), addedAt: n(d.addedAt),
    });
  }
  return out;
}

/**
 * What was seen for one item at the last write. d/u/w/m: downloaded, uploaded, wifi, mobile. fin: finished_at. err: 0/1. r: retries.
 * cd/cw/cm: how many of its downloaded, Wi-Fi and mobile bytes are already in stats_daily. Bytes an item already had when stats
 * first looked are not counted then; they are counted on the day it finishes, so a finished item's bytes are always in the
 * day totals (the Stats page's totals then agree with its records). An entry without them (older app) is fully counted.
 */
export interface BaselineEntry {
  d: number;
  u: number;
  w: number;
  m: number;
  fin: number;
  err: 0 | 1;
  r: number;
  cd?: number;
  cw?: number;
  cm?: number;
}
export type Baseline = Record<string, BaselineEntry>;

export interface PlanContext {
  now: number;
  /** Minutes east of UTC. Omitted: the phone's zone. */
  tz?: number;
  origin: (kind: StatsKind, id: string, urlDisplay: string) => Origin;
  /** Ids the user removed since the last write. Only these count as cancelled; any other missing item is kept as it was. */
  removed?: ReadonlySet<string>;
}

export interface WritePlan {
  baseline: Baseline;
  finished: StatsRecord[];
  /** Counter movement since the baseline, for the day of `now`. */
  delta: DayCounts;
  /** True when something happened that should be written now: a finish, a failure or a cancel. */
  hasEvents: boolean;
}

const step = (prev: number, next: number): number => (next >= prev ? next - prev : next);

/**
 * Compares the baseline with the current items. `baseline` null means this is the first look (or stats were off):
 * counters are noted and nothing is written, so old items and old bytes are never counted as new.
 */
export function planWrites(baseline: Baseline | null, items: readonly StatsItem[], ctx: PlanContext): WritePlan {
  const next: Baseline = {};
  const delta = zeroDay();
  const finished: StatsRecord[] = [];
  const entryOf = (i: StatsItem, r: number, c: { d: number; w: number; m: number }): BaselineEntry => ({
    d: i.sessionBytes, u: i.uploaded, w: i.bytesWifi, m: i.bytesMobile, fin: i.finishedAt, err: i.errored ? 1 : 0, r, cd: c.d, cw: c.w, cm: c.m,
  });

  if (baseline === null) {
    // Nothing is counted at the first look. An unfinished item's bytes so far wait for its finish; a finished one never counts.
    for (const i of items) next[i.id] = entryOf(i, 0, i.finishedAt > 0 ? { d: i.sessionBytes, w: i.bytesWifi, m: i.bytesMobile } : { d: 0, w: 0, m: 0 });
    return { baseline: next, finished, delta, hasEvents: false };
  }

  for (const i of items) {
    const prev = baseline[i.id];
    const p: BaselineEntry = prev ?? { d: 0, u: 0, w: 0, m: 0, fin: 0, err: 0, r: 0, cd: 0, cw: 0, cm: 0 };
    const sd = step(p.d, i.sessionBytes);
    const sw = step(p.w, i.bytesWifi);
    const sm = step(p.m, i.bytesMobile);
    const c = { d: (p.cd ?? p.d) + sd, w: (p.cw ?? p.w) + sw, m: (p.cm ?? p.m) + sm };
    delta.downloaded += sd;
    delta.uploaded += step(p.u, i.uploaded);
    delta.wifi += sw;
    delta.mobile += sm;
    if (p.fin === 0 && i.finishedAt > 0) {
      // Finished: count whatever of its bytes is not in the day totals yet.
      const xd = Math.max(0, i.sessionBytes - c.d);
      const xw = Math.max(0, i.bytesWifi - c.w);
      const xm = Math.max(0, i.bytesMobile - c.m);
      delta.downloaded += xd;
      delta.wifi += xw;
      delta.mobile += xm;
      c.d += xd;
      c.w += xw;
      c.m += xm;
    }
    let retries = p.r;
    if (!p.err && i.errored) delta.failed += 1;
    if (p.err && !i.errored && i.finishedAt === 0) retries += 1;
    if (p.fin === 0 && i.finishedAt > 0) {
      const o = ctx.origin(i.kind, i.id, i.urlDisplay);
      finished.push({
        id: i.id, kind: i.kind, name: i.name, size: i.size, category: o.category, source: o.source,
        activeSecs: i.activeSecs, sessionBytes: i.sessionBytes, uploaded: i.uploaded, bytesWifi: i.bytesWifi, bytesMobile: i.bytesMobile,
        addedAt: i.addedAt, finishedAt: i.finishedAt, retries,
      });
    }
    next[i.id] = entryOf(i, retries, c);
  }
  const present = new Set(items.map((i) => i.id));
  for (const id of Object.keys(baseline)) {
    if (present.has(id) || baseline[id].fin !== 0) continue;
    if (ctx.removed?.has(id)) delta.cancelled += 1;
    // Missing from this list without a removal (a partial list, a restart): keep it, so it is neither cancelled nor new.
    else next[id] = baseline[id];
  }
  const hasEvents = finished.length > 0 || delta.failed > 0 || delta.cancelled > 0;
  return { baseline: next, finished, delta, hasEvents };
}

/** One write a minute, but a finish, a failure or a cancel is written at once. */
export function shouldFlush(lastFlushAt: number, now: number, hasEvents: boolean): boolean {
  return hasEvents || lastFlushAt === 0 || now - lastFlushAt >= FLUSH_MS;
}

export interface RecorderDeps {
  store: Pick<StatsStore, 'addDaily' | 'recordFinished'> & Partial<Pick<StatsStore, 'foldOld'>>;
  prefs: () => StatsPrefs;
  baselineIO: { load: () => Baseline | null; save: (b: Baseline | null) => void };
  origin: PlanContext['origin'];
  now: () => number;
  tz?: () => number | undefined;
  /** Ids the user removed; read at each plan and cleared once a write has counted them. */
  removed?: Set<string>;
}

const isZero = (d: DayCounts) => Object.values(d).every((v) => v === 0);

/**
 * Feed it every telemetry snapshot with the engine's full lists. With keepStats off it writes nothing and forgets the
 * baseline, so turning stats on later starts clean. Never throws: stats must not break the transfer list.
 */
export function createRecorder(deps: RecorderDeps) {
  let baseline: Baseline | null | undefined;
  let lastFlushAt = 0;
  let busy: Promise<void> = Promise.resolve();

  async function run(torrents: readonly Snapshot[], downloads: readonly DownloadSnapshot[]): Promise<void> {
    if (!deps.prefs().keepStats) {
      if (baseline !== null) {
        baseline = null;
        deps.baselineIO.save(null);
      }
      return;
    }
    if (baseline === undefined) baseline = deps.baselineIO.load();
    const now = deps.now();
    const tz = deps.tz?.();
    const plan = planWrites(baseline, toItems(torrents, downloads), { now, tz, origin: deps.origin, removed: deps.removed });
    if (baseline === null) {
      baseline = plan.baseline;
      deps.baselineIO.save(baseline);
      lastFlushAt = now;
      return;
    }
    if (!shouldFlush(lastFlushAt, now, plan.hasEvents)) return;
    for (const rec of plan.finished) await deps.store.recordFinished(rec, tz);
    if (!isZero(plan.delta)) await deps.store.addDaily(dayKey(now, tz), plan.delta);
    baseline = plan.baseline;
    deps.baselineIO.save(baseline);
    lastFlushAt = now;
    deps.removed?.clear();
  }

  return {
    /** Calls are queued so two snapshots never write at the same time. */
    onSnapshot(torrents: readonly Snapshot[], downloads: readonly DownloadSnapshot[]): Promise<void> {
      busy = busy.then(() => run(torrents, downloads)).catch(() => {});
      return busy;
    },
  };
}
