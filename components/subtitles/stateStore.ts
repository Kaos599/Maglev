/**
 * Writes the per-video subtitle state (kv `subtitles.state`, docs/NATIVE_CONTRACT.md 36.10) and tells listeners, so a
 * card's icon follows the sheet. Pure: no React.
 */
import { kvGet, kvSet } from '../../utils/prefs/kv.ts';
import type { SubtitleTarget } from './flow.ts';
import { clearSubtitleState, getSubtitleState, setSubtitleState, type SubtitleState } from '../../utils/subtitles/prefs.ts';

let version = 0;
const listeners = new Set<() => void>();

export const getStateVersion = (): number => version;
export function subscribeStates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function bump(): void {
  version++;
  listeners.forEach((l) => l());
}

const TARGETS_KEY = 'subtitles.targets';
const MAX_TARGETS = 100;
type StoredTarget = Pick<SubtitleTarget, 'videoPath' | 'fileName' | 'videoBytes'>;

function readTargets(): Record<string, StoredTarget> {
  try {
    const raw = kvGet(TARGETS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, StoredTarget>) : {};
  } catch {
    return {};
  }
}

/** Which video a card key stands for, so the card icon can reopen the sheet without a file list. */
function rememberTarget(t: SubtitleTarget): void {
  const all = readTargets();
  delete all[t.ownerKey];
  all[t.ownerKey] = { videoPath: t.videoPath, fileName: t.fileName, videoBytes: t.videoBytes };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TARGETS))) delete all[k];
  try {
    kvSet(TARGETS_KEY, JSON.stringify(all));
  } catch {
    // memory only
  }
}

/** The video behind a card key, or null. A card only shows the icon after a finished file was looked up. */
export function recallTarget(ownerKey: string): SubtitleTarget | null {
  const t = readTargets()[ownerKey];
  if (!t || typeof t.videoPath !== 'string' || typeof t.fileName !== 'string') return null;
  return { videoPath: t.videoPath, fileName: t.fileName, videoBytes: Number(t.videoBytes) || 0, complete: true, ownerKey };
}

/** Stores one entry under the video path and the card key (36.10), and remembers the video for the card. */
export function recordState(t: SubtitleTarget, entry: SubtitleState): void {
  setSubtitleState(t.videoPath, entry);
  setSubtitleState(t.ownerKey, entry);
  rememberTarget(t);
  bump();
}

export function forgetState(t: Pick<SubtitleTarget, 'videoPath' | 'ownerKey'>): void {
  clearSubtitleState(t.videoPath);
  clearSubtitleState(t.ownerKey);
  bump();
}

/** The stored entry for a card key (`t:<id>` or `d:<id>`). The 24 h rule is applied by `cardIconModel`. */
export function stateFor(ownerKey: string): SubtitleState | null {
  return getSubtitleState(ownerKey);
}
