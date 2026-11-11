// Hosts the user has passed a Cloudflare check on, with the User-Agent the WebView used.
// Contract: docs/SEARCH_CONTRACT.md section 8. Memory only here; utils/prefs/search.ts persists and hydrates it.

import { hostOf } from './challenge.ts';

export interface Clearance {
  host: string;
  userAgent: string;
  at: number;
}

const table = new Map<string, Clearance>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function onClearancesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Replaces the whole table without notifying (used when prefs load). */
export function hydrateClearances(list: Clearance[]): void {
  table.clear();
  for (const c of list) if (c.host && c.userAgent) table.set(c.host.toLowerCase(), c);
}

export function listClearances(): Clearance[] {
  return Array.from(table.values());
}

export function setClearance(host: string, userAgent: string, at: number = Date.now()): void {
  const h = host.toLowerCase();
  if (!h || !userAgent) return;
  table.set(h, { host: h, userAgent, at });
  emit();
}

/** The user's solved check for the host of `url`, if any. */
export function clearanceFor(url: string): Clearance | undefined {
  return table.get(hostOf(url));
}

/** A cleared host answered with a challenge again: forget it so the chip returns. */
export function dropClearance(host: string): void {
  if (table.delete(host.toLowerCase())) emit();
}

/** Forgets every cleared host and returns what was there (to remove their cookies). */
export function clearAllClearances(): Clearance[] {
  const old = listClearances();
  table.clear();
  if (old.length) emit();
  return old;
}
