import type { PixelIconName } from '../components/PixelIcon';

export type FileKind = 'video' | 'audio' | 'image' | 'archive' | 'doc' | 'app' | 'disc' | 'other';

const KINDS: Record<Exclude<FileKind, 'other'>, readonly string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'],
  audio: ['mp3', 'flac', 'ogg', 'opus', 'wav', 'm4a', 'aac', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
  doc: ['pdf', 'txt', 'nfo', 'md', 'doc', 'docx', 'epub', 'mobi', 'azw3', 'cbz', 'cbr', 'srt', 'sub'],
  app: ['apk', 'xapk', 'aab'],
  disc: ['iso', 'img', 'bin', 'cue'],
};

const BY_EXT = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) BY_EXT.set(e, kind as FileKind);

/** Maps a file path to a coarse kind by its extension. Unknown extensions are 'other'. */
export function fileKind(path: string): FileKind {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && BY_EXT.get(m[1].toLowerCase())) || 'other';
}

const GLYPH: Record<FileKind, PixelIconName> = {
  video: 'file-video',
  audio: 'file-audio',
  image: 'file-image',
  archive: 'file-archive',
  doc: 'file-doc',
  app: 'file-app',
  disc: 'file-disc',
  other: 'file',
};

/** Pixel glyph name for a file path (S9.4). */
export function fileGlyph(path: string): PixelIconName {
  return GLYPH[fileKind(path)];
}
