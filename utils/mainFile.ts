import { fileKind } from './fileKind.ts';

export interface MainFileCandidate {
  index: number;
  path: string;
  length: number;
  included: boolean;
}

export interface MainFilePick {
  /** The file Open should use when there is only one good choice, else null. */
  main: MainFileCandidate | null;
  /** Included videos, largest first. More than one means a season pack: ask which. */
  videos: MainFileCandidate[];
}

const bySize = (a: MainFileCandidate, b: MainFileCandidate) => b.length - a.length || a.index - b.index;

/**
 * Picks what "Open" should play for a finished torrent. Skipped files are ignored.
 * One video: that video. Several videos: `main` is null so the screen asks. No video: the largest file.
 */
export function pickMainFile(files: readonly MainFileCandidate[]): MainFilePick {
  const included = files.filter((f) => f.included && f.length > 0);
  const videos = included.filter((f) => fileKind(f.path) === 'video').sort(bySize);
  if (videos.length === 1) return { main: videos[0], videos };
  if (videos.length > 1) return { main: null, videos };
  const largest = [...included].sort(bySize)[0] ?? null;
  return { main: largest, videos: [] };
}
