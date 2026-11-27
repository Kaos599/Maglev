// One background pass over the watches: pure, with every outside call injected. A watch is checked only when it is due,
// and only on a network its settings allow.
import { evaluateWatch, isDue, networkAllows, notificationFor, notificationId, NO_RISK, type NetworkState, type Watch, type WatchSafety } from './logic.ts';
import type { MergedResult } from '../search/types.ts';

export interface WatchNotification {
  /** The watch id. Native turns it into a stable notification id so a new result replaces the old one. */
  id: string;
  title: string;
  text: string;
  openUrl: string;
  downloadUrl?: string;
}

export interface CycleDeps {
  now(): number;
  list(): Watch[];
  save(list: Watch[]): void;
  network(): Promise<NetworkState>;
  /** Runs the search. Throws when no source answered, so an outage is not taken for "nothing new". */
  search(query: string, category: Watch['category']): Promise<MergedResult[]>;
  /** True when the notification was posted. */
  notify(n: WatchNotification): Promise<boolean>;
  /**
   * Which copies Search would mark "Risky source", and the Watches setting that decides whether one gets Download.
   * Read once per run. The background job always passes it; without it nothing counts as risky.
   */
  safety?(): WatchSafety;
  /** Stop starting new checks after this long (default 8 minutes). */
  budgetMs?: number;
}

export interface CycleSummary {
  checked: number;
  notified: number;
  skipped: number;
  failed: number;
}

export { notificationId };

export async function runWatchCycle(deps: CycleDeps): Promise<CycleSummary> {
  const summary: CycleSummary = { checked: 0, notified: 0, skipped: 0, failed: 0 };
  const started = deps.now();
  const budget = deps.budgetMs ?? 8 * 60_000;
  const due = deps.list().filter((w) => isDue(w, started));
  if (due.length === 0) return summary;
  const net = await deps.network().catch((): NetworkState => ({ connected: false, unmetered: false, globalWifiOnly: false }));
  const safety = deps.safety?.() ?? NO_RISK;
  const isRisky = (r: MergedResult) => safety.riskyOf(r) !== null;

  for (const w of due) {
    if (deps.now() - started > budget) break;
    if (!networkAllows(w, net)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const results = await deps.search(w.query, w.category);
      const now = deps.now();
      const ev = evaluateWatch(w, results, now, isRisky);
      let next: Watch = { ...w, lastCheckedAt: now, seen: ev.nextSeen };
      if (ev.best) {
        // A copy only risky sources list gets no Download unless the user allowed it; see notificationFor.
        const note: WatchNotification = { id: w.id, ...notificationFor(w, ev.best, safety) };
        const posted = await deps.notify(note).catch(() => false);
        if (!posted) {
          // Not recorded: the next run finds it new again and tries once more.
          summary.failed += 1;
          continue;
        }
        next = { ...next, lastNewAt: now, lastNewName: ev.best.name };
        summary.notified += 1;
      }
      // Re-read the list so a change made in the app while this ran (pause, delete) is kept.
      const current = deps.list();
      if (current.some((x) => x.id === w.id)) deps.save(current.map((x) => (x.id === w.id ? { ...x, lastCheckedAt: next.lastCheckedAt, seen: next.seen, lastNewAt: next.lastNewAt, lastNewName: next.lastNewName } : x)));
      summary.checked += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
