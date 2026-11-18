/** Which file-type glyph a Transfers card shows on its left. Pure: no React, no IO. */
import type { PixelIconName } from '../components/PixelIcon';
import { fileGlyph, fileKind, type FileKind } from './fileKind.ts';
import { mediaKind, type MediaKind } from './search/mediaType.ts';

const FROM_MEDIA: Record<MediaKind, FileKind> = {
  video: 'video',
  audio: 'audio',
  book: 'doc',
  app: 'app',
  game: 'app',
  archive: 'archive',
  image: 'image',
  unknown: 'other',
};

const GLYPH_OF_KIND: Record<FileKind, PixelIconName> = {
  video: 'file-video',
  audio: 'file-audio',
  image: 'file-image',
  archive: 'file-archive',
  doc: 'file-doc',
  app: 'file-app',
  disc: 'file-disc',
  other: 'file',
};

/** A link download or stream: from the file name. A stream with a name that says nothing is video. */
export function downloadCardGlyph(name: string, isStream: boolean): PixelIconName {
  const g = fileGlyph(name);
  return g === 'file' && isStream ? 'file-video' : g;
}

/**
 * A torrent: the kind of its largest file when a file list is known, else the name's extension,
 * else what the name looks like (a folder called "Show.S01.1080p"), else the plain file glyph.
 */
export function torrentCardGlyph(name: string, files?: readonly { path: string; length: number }[] | null): PixelIconName {
  if (files && files.length) {
    let big = files[0];
    for (const f of files) if (f.length > big.length) big = f;
    const g = fileGlyph(big.path);
    if (g !== 'file') return g;
  }
  const byExt = fileKind(name);
  if (byExt !== 'other') return GLYPH_OF_KIND[byExt];
  return GLYPH_OF_KIND[FROM_MEDIA[mediaKind({ name })]];
}
