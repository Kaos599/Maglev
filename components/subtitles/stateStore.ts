/**
 * Writes the per-video subtitle state (kv `subtitles.state`, docs/NATIVE_CONTRACT.md 36.10) and tells listeners, so a
 * card's icon follows the sheet. Pure: no React.
 */
import { kvGet, kvSet } from '../../utils/prefs/kv.ts';
import type { SubtitleTarget } from './flow.ts';
import { clearStaleStates, clearSubtitleState, getSubtitleState, setSubtitleState, type SubtitleState } from '../../utils/subtitles/prefs.ts';

// Loading this module is app start: a "getting" state left by a killed process is cleared (NATIVE_CONTRACT 39.1 S3).
try {
  clearStaleStates(Date.now());
} catch {
  // nothing stored yet
}

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

/** 44.15 F8: torrent keys are lowercase everywhere (card state, requests, targets). The one place that normalises. */
export const normKey = (k: string): string => (k.startsWith('t:') ? k.toLowerCase() : k);

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
  const ok = normKey(t.ownerKey);
  delete all[ok];
  all[ok] = { videoPath: t.videoPath, fileName: t.fileName, videoBytes: t.videoBytes };
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
  const t = readTargets()[normKey(ownerKey)];
  if (!t || typeof t.videoPath !== 'string' || typeof t.fileName !== 'string') return null;
  return { videoPath: t.videoPath, fileName: t.fileName, videoBytes: Number(t.videoBytes) || 0, complete: true, ownerKey: normKey(ownerKey) };
}

/** Stores one entry under the video path and the card key (36.10), and remembers the video for the card. */
export function recordState(t: SubtitleTarget, entry: SubtitleState): void {
  setSubtitleState(t.videoPath, entry);
  setSubtitleState(normKey(t.ownerKey), entry);
  rememberTarget(t);
  bump();
}

/** 44.15 D7: one episode of a pack: stored under its video path only, so the card's own state is the pack's roll-up. */
export function recordVideoState(t: Pick<SubtitleTarget, 'videoPath'>, entry: SubtitleState): void {
  setSubtitleState(t.videoPath, entry);
  bump();
}

/** 44.15 D7: the card state of a pack (under the card key). */
export function recordOwnerState(t: SubtitleTarget, entry: SubtitleState): void {
  setSubtitleState(normKey(t.ownerKey), entry);
  rememberTarget(t);
  bump();
}

export function forgetState(t: Pick<SubtitleTarget, 'videoPath' | 'ownerKey'>): void {
  if (t.videoPath) clearSubtitleState(t.videoPath);
  clearSubtitleState(normKey(t.ownerKey));
  bump();
}

/** 44.15 D7: clears one episode's stored state without touching the card's own. */
export function forgetVideoState(videoPath: string): void {
  if (videoPath) clearSubtitleState(videoPath);
  bump();
}

/** 44.15 D7: clears the card's own state (a pack whose roll-up shows nothing). */
export function forgetOwnerState(ownerKey: string): void {
  clearSubtitleState(normKey(ownerKey));
  bump();
}

/** 44.15 F6: clears the stored state of every given video path and the card key at once. */
export function forgetAll(ownerKey: string, videoPaths: readonly string[]): void {
  for (const p of videoPaths) if (p) clearSubtitleState(p);
  clearSubtitleState(normKey(ownerKey));
  bump();
}

/** The stored entry for a card key (`t:<id>` or `d:<id>`). The 24 h rule is applied by `cardIconModel`. */
export function stateFor(ownerKey: string): SubtitleState | null {
  return getSubtitleState(normKey(ownerKey));
}
