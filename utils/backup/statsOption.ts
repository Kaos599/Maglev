/**
 * The "Include stats" choice on the Backup screen, and which parts a restore asks for.
 * A UI-only preference in the kv store: it never reaches the engine settings or toNativeConfig.
 */
import { kvGet, kvSet } from '../prefs/kv.ts';
import type { Backup, BackupPart, RestorePart } from './format.ts';

const INCLUDE_STATS_KEY = 'maglev.backup.includeStats.v1';

/** Off unless the user switched it on. */
export function getIncludeStats(): boolean {
  return kvGet(INCLUDE_STATS_KEY) === '1';
}

export function setIncludeStats(on: boolean): void {
  kvSet(INCLUDE_STATS_KEY, on ? '1' : '0');
}

/** Options for exportBackup: stats only when the user ticked them. */
export function exportOptions(includeStats: boolean): { includeStats: boolean } {
  return { includeStats };
}

/** Whether the picked file carries a stats section worth offering. */
export function hasStats(b: Backup): boolean {
  return b.stats !== undefined && b.stats !== null;
}

/** The parts to restore: the ticked ones, plus stats only when the file has them and they are ticked. */
export function restoreParts(b: Backup, ticked: readonly BackupPart[], statsTicked: boolean): RestorePart[] {
  const parts: RestorePart[] = [...ticked];
  if (statsTicked && hasStats(b)) parts.push('stats');
  return parts;
}
