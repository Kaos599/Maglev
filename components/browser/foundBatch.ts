/**
 * Batch download from the found-files tray. Pure: no React, no native modules.
 * Select all never takes a stream (it needs its quality sheet) or an installer (it needs a warning). The user
 * can still tick an installer by hand; the batch sheet then shows the installer warning. A stream cannot be ticked.
 */
import type { FoundItem } from '../../modules/maglev-engine/src/MaglevBrowser';
import { isInstaller } from './foundFilter.ts';

/** The most files one batch starts. Keeps the admission check and the notifications sane. */
export const BATCH_CAP = 25;
const CONCURRENCY = 3;

/** True for a plain file: not a stream and not an installer. Only these are picked by Select all. */
export function isBatchable(item: Pick<FoundItem, 'stream' | 'ext' | 'name'>): boolean {
  return !item.stream && !isInstaller(item);
}

/** True when a row can be ticked. Streams cannot: they are saved one at a time from their own sheet. */
export function canSelect(item: Pick<FoundItem, 'stream'>): boolean {
  return !item.stream;
}

/** Ids for Select all: the batchable rows in list order, up to the cap. */
export function selectAllIds(items: readonly FoundItem[], cap: number = BATCH_CAP): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (ids.length >= cap) break;
    if (isBatchable(item)) ids.push(item.id);
  }
  return ids;
}

/** True when every batchable row (up to the cap) is ticked. */
export function allSelected(selected: ReadonlySet<string>, items: readonly FoundItem[]): boolean {
  const want = selectAllIds(items);
  return want.length > 0 && want.every((id) => selected.has(id));
}

/** Ticks or unticks one id. Ticking past the cap changes nothing. Returns a new set when it changes. */
export function toggleSelected(selected: ReadonlySet<string>, id: string, cap: number = BATCH_CAP): ReadonlySet<string> {
  if (selected.has(id)) {
    const next = new Set(selected);
    next.delete(id);
    return next;
  }
  if (selected.size >= cap) return selected;
  return new Set(selected).add(id);
}

export interface BatchTotals {
  knownBytes: number;
  knownCount: number;
  unknownCount: number;
}

/** Sums the sizes that are known. An unknown size is counted as unknown and adds nothing. */
export function batchTotals(items: readonly FoundItem[], sizeOf: (item: FoundItem) => number | null | undefined): BatchTotals {
  let knownBytes = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const item of items) {
    const n = sizeOf(item);
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      knownBytes += n;
      knownCount++;
    } else unknownCount++;
  }
  return { knownBytes, knownCount, unknownCount };
}

export type StartOutcome = { ok: true } | { ok: false; code?: string; message?: string };

export interface BatchResult {
  added: number;
  /** Already in Transfers (the engine said DUPLICATE). Not a failure. */
  duplicate: number;
  /** In list order, for Retry. */
  failed: FoundItem[];
}

/**
 * Starts each item through `startOne` (the single-download path), a few at a time. One failing item, or a throw,
 * never stops the others. Only the first BATCH_CAP items run.
 */
export async function runBatch(items: readonly FoundItem[], startOne: (item: FoundItem) => Promise<StartOutcome>): Promise<BatchResult> {
  const list = items.slice(0, BATCH_CAP);
  const outcomes: ('added' | 'duplicate' | 'failed')[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        const res = await startOne(list[i]);
        outcomes[i] = res.ok ? 'added' : res.code === 'DUPLICATE' ? 'duplicate' : 'failed';
      } catch {
        outcomes[i] = 'failed';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return {
    added: outcomes.filter((o) => o === 'added').length,
    duplicate: outcomes.filter((o) => o === 'duplicate').length,
    failed: list.filter((_, i) => outcomes[i] === 'failed'),
  };
}
