// Which kind of file a search result is, for the row's icon tile. Pure: no React, no IO.

export type MediaKind = 'video' | 'audio' | 'book' | 'app' | 'game' | 'archive' | 'image' | 'unknown';

const BY_CATEGORY: Record<string, MediaKind> = {
  movies: 'video',
  tv: 'video',
  anime: 'video',
  porn: 'video',
  adult: 'video',
  music: 'audio',
  books: 'book',
  apps: 'app',
  games: 'game',
};

// Order matters: the first rule that matches wins. Games and distro images go before archives and video.
const RULES: { kind: MediaKind; re: RegExp }[] = [
  { kind: 'game', re: /\b(repack|fitgirl|dodi|gog|codex|elamigos)\b/i },
  { kind: 'app', re: /\b(ubuntu|debian|fedora|arch|mint|kali|manjaro|opensuse)\b.*\.iso\b|\.(apk|exe|msi|dmg|appimage)\b|\bappimage\b/i },
  { kind: 'video', re: /\b(2160p|1080p|720p|480p|4k|x264|x265|h\.?264|h\.?265|hevc|web-?dl|webrip|blu-?ray|bdrip|hdtv|s\d{1,2}e\d{1,3})\b|\.(mkv|mp4|avi)\b/i },
  { kind: 'audio', re: /\b(flac|mp3|aac|m4a|ogg|opus|discography|album)\b/i },
  { kind: 'book', re: /\b(epub|pdf|mobi|azw3|cbz|cbr|audiobook)\b/i },
  { kind: 'app', re: /\.iso\b/i },
  { kind: 'archive', re: /\b(zip|rar|7z|tar)\b|\.(tar\.gz|tgz)\b/i },
  { kind: 'image', re: /\b(jpg|jpeg|png|wallpapers?)\b/i },
];

export function mediaKind(result: { category?: string; name: string }): MediaKind {
  const fromCategory = result.category ? BY_CATEGORY[result.category] : undefined;
  if (fromCategory) return fromCategory;
  const name = result.name ?? '';
  for (const { kind, re } of RULES) if (re.test(name)) return kind;
  return 'unknown';
}

/** Plain-English word for the row's accessibility label. */
export const MEDIA_WORD: Record<MediaKind, string> = {
  video: 'Video',
  audio: 'Audio',
  book: 'Book',
  app: 'App',
  game: 'Game',
  archive: 'Archive',
  image: 'Image',
  unknown: 'File',
};
