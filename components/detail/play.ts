/**
 * Play while downloading (docs/contracts-0.19/play-and-storage.md section 1). Pure: no React, no react-native.
 */
import { fileKind } from '../../utils/fileKind.ts';

export interface PlayCandidate {
  index: number;
  path: string;
  length: number;
  included: boolean;
}

/** The largest included video; with no video, the largest included audio file; else null. Ties go to the lower index. */
export function pickPlayFile<T extends PlayCandidate>(files: readonly T[]): T | null {
  const usable = files.filter((f) => f.included && f.length > 0);
  const bySize = (a: T, b: T) => b.length - a.length || a.index - b.index;
  const videos = usable.filter((f) => fileKind(f.path) === 'video').sort(bySize);
  if (videos.length) return videos[0];
  const audio = usable.filter((f) => fileKind(f.path) === 'audio').sort(bySize);
  return audio[0] ?? null;
}

const PLAY_STATES: readonly string[] = ['DOWNLOADING', 'PAUSED', 'COMPLETED', 'SEEDING'];
/** Tags that mean the files are not where the engine expects them. */
const NO_PLAY_HEALTH: readonly string[] = ['files_missing', 'files_changed', 'storage_unavailable'];

interface PlayState {
  state: string;
  pausedBy?: string | null;
  health?: string | null;
}

/** True when a playable file exists and the torrent is downloading, paused, seeding or done. */
export function playVisible(t: PlayState, file: unknown): boolean {
  if (!file || !PLAY_STATES.includes(t.state)) return false;
  if (t.health && NO_PLAY_HEALTH.includes(t.health)) return false;
  if (t.pausedBy && NO_PLAY_HEALTH.includes(t.pausedBy)) return false;
  return true;
}

/** The transfer card has no file list: Play shows only when the torrent's own name is a video or audio file. */
export function cardCanPlay(t: PlayState & { name: string }): boolean {
  const k = fileKind(t.name);
  return playVisible(t, k === 'video' || k === 'audio' ? t.name : null);
}

export type PlayPlan =
  | { kind: 'open' }
  | { kind: 'stream'; resumeFirst: boolean }
  | { kind: 'blocked'; reason: 'needsResume' | 'storageFull' };

/**
 * What pressing Play does. A fully downloaded file opens normally. Otherwise it streams (a stream read already
 * makes the engine fetch the start of that file first). A torrent the user paused is resumed first; one a rule
 * paused is not, because the stream server needs the engine to be running.
 */
export function playPlan(
  file: { length: number; progressBytes: number },
  t: { state: string; pausedBy?: string | null },
): PlayPlan {
  if (file.length > 0 && file.progressBytes >= file.length) return { kind: 'open' };
  if (t.state === 'PAUSED') {
    if (t.pausedBy === 'user') return { kind: 'stream', resumeFirst: true };
    // Resuming cannot work until space is freed, so say that instead of "resume first".
    if (t.pausedBy === 'storage_full') return { kind: 'blocked', reason: 'storageFull' };
    return { kind: 'blocked', reason: 'needsResume' };
  }
  return { kind: 'stream', resumeFirst: false };
}
