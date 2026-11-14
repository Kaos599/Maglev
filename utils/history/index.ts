/**
 * Browser history, public API (docs/NATIVE_CONTRACT.md section 24.9).
 * If the database can't open, history is unavailable for the session: recording does nothing, suggestions are empty
 * and listing or editing throws so the screen can show Retry. The browser keeps working.
 */
import { useSyncExternalStore } from 'react';
import { setHistoryWipeOnClose } from 'maglev-engine';
import { getBrowserPrefs, subscribeBrowserPrefs } from '../prefs/browser';
import { openHistoryDb } from './db';
import { createHistoryStore, type HistoryEntry, type HistoryRange, type HistoryStore, type RecordResult, type TabRow } from './store';

export type { HistoryEntry, HistoryRange, RecordResult, TabRow };

let store: HistoryStore | null = null;
let opening: Promise<HistoryStore> | null = null;
let ready = false;
let prefsWired = false;
let sentWipe: boolean | null = null;
const listeners = new Set<() => void>();
let unavailableVersion = 0;

function pushWipeFlag(): void {
  const on = getBrowserPrefs().clearHistoryOnClose;
  if (sentWipe === on) return;
  sentWipe = on;
  setHistoryWipeOnClose(on).catch(() => {
    sentWipe = null; // try again on the next change
  });
}

function wirePrefs(): void {
  if (prefsWired) return;
  prefsWired = true;
  subscribeBrowserPrefs(pushWipeFlag);
}

/** Opens, creates and prunes (and empties, when "clear on close" is on). Never throws; safe to call again as Retry. */
export async function initHistory(now?: number): Promise<void> {
  wirePrefs();
  pushWipeFlag();
  try {
    await ensure(now);
  } catch {
    // Unavailable: every call degrades as the spec says.
  }
}

async function ensure(now?: number): Promise<HistoryStore> {
  if (store && ready) return store;
  if (!opening) {
    opening = (async () => {
      const s = createHistoryStore(await openHistoryDb(), () => getBrowserPrefs());
      await s.init(now);
      s.subscribe(() => listeners.forEach((l) => l()));
      store = s;
      ready = true;
      unavailableVersion++;
      return s;
    })();
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

/** 'skipped' when history is off, unavailable, or the address isn't http(s). */
export async function recordVisit(input: { url: string; title: string }, now?: number): Promise<RecordResult> {
  try {
    return await (await ensure(now)).recordVisit(input, now);
  } catch {
    return 'skipped';
  }
}

export async function listHistory(opts: { query?: string; limit?: number; before?: number | HistoryEntry } = {}): Promise<HistoryEntry[]> {
  return (await ensure()).list(opts);
}

export async function suggestHistory(text: string, limit = 6): Promise<HistoryEntry[]> {
  try {
    return await (await ensure()).suggest(text, limit);
  } catch {
    return [];
  }
}

export async function removePages(urls: string[]): Promise<HistoryEntry[]> {
  return (await ensure()).removePages(urls);
}

export async function removeHost(host: string): Promise<HistoryEntry[]> {
  return (await ensure()).removeHost(host);
}

export async function restorePages(rows: HistoryEntry[]): Promise<void> {
  return (await ensure()).restorePages(rows);
}

export async function clearHistoryRange(range: HistoryRange, now?: number): Promise<number> {
  return (await ensure(now)).clearRange(range, now);
}

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const snapshot = () => (store ? store.version() : 0) + unavailableVersion;

/** Changes after every write, so a screen can reload its list. */
export function useHistoryVersion(): number {
  return useSyncExternalStore(subscribeHistory, snapshot, snapshot);
}

// ---- tabs (24.10) ----

const TABS_DELAY_MS = 500;
let pendingTabs: { rows: TabRow[]; activeId: string | null } | null = null;
let tabsTimer: ReturnType<typeof setTimeout> | null = null;

/** The saved tabs, or none when the table is missing or history can't open. Never throws. */
export async function loadTabs(): Promise<{ tabs: TabRow[]; activeId: string | null }> {
  try {
    return await (await ensure()).loadTabs();
  } catch {
    return { tabs: [], activeId: null };
  }
}

/** Saves now. Resolves false when it couldn't. Never throws. */
export async function saveTabs(rows: TabRow[], activeId: string | null): Promise<boolean> {
  try {
    return await (await ensure()).saveTabs(rows, activeId);
  } catch {
    return false;
  }
}

/** Saves 500 ms after the last call. Only the latest rows are written. */
export function scheduleSaveTabs(rows: TabRow[], activeId: string | null): void {
  pendingTabs = { rows, activeId };
  if (tabsTimer) clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => {
    tabsTimer = null;
    void flushTabs();
  }, TABS_DELAY_MS);
}

/** Writes the pending tabs right away (screen blur). Does nothing when nothing is pending. */
export async function flushTabs(): Promise<void> {
  if (tabsTimer) {
    clearTimeout(tabsTimer);
    tabsTimer = null;
  }
  const p = pendingTabs;
  pendingTabs = null;
  if (p) await saveTabs(p.rows, p.activeId);
}
