// One background pass over the watches: pure, with every outside call injected (contract section 5 and 6).
import { evaluateWatch, isDue, networkAllows, notificationId, openUrl, downloadUrl, watchNotificationText, type NetworkState, type Watch } from './logic.ts';
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

  for (const w of due) {
    if (deps.now() - started > budget) break;
    if (!networkAllows(w, net)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const results = await deps.search(w.query, w.category);
      const now = deps.now();
      const ev = evaluateWatch(w, results, now);
      let next: Watch = { ...w, lastCheckedAt: now, seen: ev.nextSeen };
      if (ev.best) {
        const { title, text } = watchNotificationText(w, ev.best);
        const note: WatchNotification = { id: w.id, title, text, openUrl: openUrl(w) };
        const dl = downloadUrl(ev.best);
        if (dl) note.downloadUrl = dl;
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
