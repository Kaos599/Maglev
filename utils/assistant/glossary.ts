// Plain-English glossary for the release-name tokens (docs/ASSISTANT_DESIGN.md section 2.11).
// Pure TypeScript: no React, no engine, no network.
// Every key the parser can emit (TOKEN_KEYS in releaseName.ts) has one entry here.
// Quality tokens set chip: true and show as chips. Other keys set chip: false so the UI hides them.
// Copy never explains one term inside brackets of another: the UI links other terms as chips.

import { TOKEN_KEYS, type ParsedRelease } from './releaseName.ts';

export type TokenKey = (typeof TOKEN_KEYS)[number];

export interface GlossaryEntry {
  label: string;      // short chip text, e.g. "x265"
  plain: string;      // under 40 words, everyday English
  tradeoff?: string;  // one sentence: what you gain and what you lose
  phoneNote?: string; // one sentence about playback on a phone
  aka?: string[];     // other names people search for, e.g. "HEVC" for H.265
  chip: boolean;      // false hides the key from the UI
}

export type Chip = GlossaryEntry & { key: TokenKey };

export const GLOSSARY: Record<TokenKey, GlossaryEntry> = {
  // Sources: where the picture came from.
  cam: {
    label: 'CAM',
    plain: 'Filmed by someone in a cinema with a camera. The picture is often shaky or blocked by heads, and the sound is the room microphone with audience noise.',
    tradeoff: 'Usually the first copy online, but picture and sound are poor.',
    phoneNote: 'Poor on any screen.',
    chip: true,
  },
  ts: {
    label: 'TS',
    plain: 'Filmed in a cinema like a CAM, but the sound is taken straight from the cinema\'s system. Picture is still poor.',
    tradeoff: 'Better sound than a CAM, but the picture is still poor.',
    phoneNote: 'Poor on any screen.',
    aka: ['TELESYNC'],
    chip: true,
  },
  tc: {
    label: 'TC',
    plain: 'Copied from a film reel used in cinemas. It is rare now, and the copy quality varies.',
    tradeoff: 'Can be sharp, but it is rare and the quality varies.',
    phoneNote: 'Not worth choosing over a streaming copy.',
    aka: ['TELECINE'],
    chip: true,
  },
  scr: {
    label: 'SCR',
    plain: 'A review copy sent to critics and award voters, often with a watermark. The picture is usually lower quality than a retail copy.',
    tradeoff: 'Early access, but the picture is usually lower quality.',
    phoneNote: 'Prefer a streaming or disc copy.',
    aka: ['SCREENER'],
    chip: true,
  },
  hdtv: {
    label: 'HDTV',
    plain: 'Recorded from a television broadcast. The quality is fair, but channel logos and adverts can appear in the picture.',
    tradeoff: 'Often smaller than a disc copy, with logos and adverts.',
    phoneNote: 'Fine on a phone when space is tight.',
    chip: true,
  },
  webdl: {
    label: 'WEB-DL',
    plain: 'Taken from a streaming service exactly as the service sent it, with no re-encoding. Usually clean, with no logos.',
    tradeoff: 'A clean copy at a moderate size. It is only as sharp as the stream the service sent.',
    phoneNote: 'A good choice for a phone.',
    aka: ['WEBDL'],
    chip: true,
  },
  webrip: {
    label: 'WEBRip',
    plain: 'Captured from a streaming service while it played, then re-encoded. Usually a little softer than WEB-DL, which is taken exactly as sent.',
    tradeoff: 'Usually a bit softer than WEB-DL, often at a smaller size.',
    phoneNote: 'Fine on a phone.',
    chip: true,
  },
  web: {
    label: 'WEB',
    plain: 'A streaming copy, but the name does not say whether it was captured or taken as sent. Treat it like WEBRip until the name says more.',
    tradeoff: 'Unclear source, so assume the quality is a little lower.',
    phoneNote: 'Fine on a phone.',
    chip: true,
  },
  bluray: {
    label: 'BluRay',
    plain: 'Re-encoded from a Blu-ray disc. The picture is very good for its size, but a poor re-encode can look worse than a WEB-DL copy.',
    tradeoff: 'Often sharper than a streaming copy, but usually larger.',
    phoneNote: 'Good on a phone if the file size fits.',
    aka: ['Blu-ray'],
    chip: true,
  },
  remux: {
    label: 'REMUX',
    plain: 'The disc video and audio copied untouched into a new file. It has the highest picture quality available, but it is often 20 GB or more.',
    tradeoff: 'The highest picture quality, but overkill for a phone and very large.',
    phoneNote: 'Too large for most phones.',
    chip: true,
  },
  dvdrip: {
    label: 'DVDRip',
    plain: 'Copied from a DVD, which is standard definition. The picture is softer than HD, but the file is usually small.',
    tradeoff: 'Small, but noticeably softer than HD.',
    phoneNote: 'Fine on a small screen if space is very tight.',
    chip: true,
  },
  hdrip: {
    label: 'HDRip',
    plain: 'Re-encoded from another copy, often a streaming one. Despite the name, HDRip does not mean HDR. The picture is usually fair.',
    tradeoff: 'Usually fair quality, with no HDR colour.',
    phoneNote: 'Fine on a phone.',
    chip: true,
  },

  // Resolutions: the number of lines of picture.
  '480p': {
    label: '480p',
    plain: 'Standard definition. The file is small and the picture is soft, but it is fine on a small phone screen when space is tight.',
    tradeoff: 'The smallest file, but clearly softer than 720p.',
    phoneNote: 'Only if space is very tight.',
    aka: ['SD'],
    chip: true,
  },
  '576p': {
    label: '576p',
    plain: 'Standard definition with a little more detail than 480p. Common for European television.',
    tradeoff: 'A little sharper than 480p, with a larger file.',
    phoneNote: 'Fine on a small screen.',
    aka: ['SD'],
    chip: true,
  },
  '720p': {
    label: '720p',
    plain: 'HD, with 720 lines of picture. A cheap way to get a clear picture that still looks good on a phone.',
    tradeoff: 'Roughly a third smaller than 1080p, with less detail on a large screen.',
    phoneNote: 'A good choice for a phone.',
    aka: ['HD'],
    chip: true,
  },
  '1080p': {
    label: '1080p',
    plain: 'Full HD, with 1080 lines of picture. This is the usual sweet spot for a phone: sharp, with a file size that stays reasonable.',
    tradeoff: 'Sharper than 720p on a large screen. On a phone the gain is smaller and the file is bigger.',
    phoneNote: 'The usual pick for a phone.',
    aka: ['FHD', 'Full HD'],
    chip: true,
  },
  '2160p': {
    label: '2160p',
    plain: '4K Ultra HD, with four times the pixels of 1080p. It often comes with HDR, and the file is large.',
    tradeoff: 'The most detail, but the file is large and few phones can show the difference.',
    phoneNote: 'Few phone screens show the extra detail.',
    aka: ['4K', 'UHD'],
    chip: true,
  },
  '4320p': {
    label: '4320p',
    plain: '8K Ultra HD, four times the pixels of 4K. It is very rare and very large, and almost no phone screen can show that detail.',
    tradeoff: 'Extra detail that a phone cannot show, at a huge file size.',
    phoneNote: 'Not useful on a phone.',
    aka: ['8K'],
    chip: true,
  },

  // Video codecs and encoders.
  avc: {
    label: 'H.264',
    plain: 'The older and most widely supported video format. Every Android phone plays it.',
    tradeoff: 'Plays everywhere, but the file is larger than H.265 for the same picture.',
    phoneNote: 'Plays smoothly on any phone.',
    aka: ['AVC'],
    chip: true,
  },
  hevc: {
    label: 'H.265',
    plain: 'A newer format. Files are about 25 to 40 percent smaller than H.264 at the same quality.',
    tradeoff: 'Smaller files for the same picture, but some older phones and TVs cannot play it smoothly.',
    phoneNote: 'Plays smoothly on most phones made in the last several years.',
    aka: ['HEVC'],
    chip: true,
  },
  av1: {
    label: 'AV1',
    plain: 'A newer format that makes small files and has no licence fees. Newer phones play it with their video chip. Older ones use the main processor, which is slower and drains the battery.',
    tradeoff: 'Small files, but smooth playback only on newer phones.',
    phoneNote: 'Smooth only on newer phone chips.',
    chip: true,
  },
  xvid: {
    label: 'XviD',
    plain: 'An old video format. It plays almost anywhere, but it gives less picture per megabyte than newer formats.',
    tradeoff: 'Plays almost anywhere, but at a poor quality for the file size.',
    phoneNote: 'Prefer a newer format.',
    chip: true,
  },
  vp9: {
    label: 'VP9',
    plain: 'A video format from Google, used by YouTube and some other sites. Most phones can play it.',
    tradeoff: 'Good size for its quality, but less common in downloads than H.265.',
    phoneNote: 'Most phones can play it.',
    chip: true,
  },
  mpeg2: {
    label: 'MPEG-2',
    plain: 'An old disc and TV format, used on DVDs and broadcast television. Most phones play it through software, which is slower and drains the battery.',
    tradeoff: 'Common on old discs, but large for its quality.',
    phoneNote: 'Often slow on a phone.',
    aka: ['MPEG2', 'H.262'],
    chip: true,
  },
  vc1: {
    label: 'VC-1',
    plain: 'An old Microsoft disc and TV format, found on some discs and recordings. Most phones play it through software, which is slower and drains the battery.',
    tradeoff: 'Usable on old discs, but slow to decode on many phones.',
    phoneNote: 'Often slow on a phone.',
    aka: ['VC1', 'WMV9'],
    chip: true,
  },
  x264: {
    label: 'x264',
    plain: 'The name of a free encoder for H.264. A file tagged x264 was re-encoded by someone, so it is not the original stream.',
    tradeoff: 'Works everywhere, but a re-encode can lose a little detail compared with the original stream.',
    phoneNote: 'Plays smoothly on any phone.',
    chip: true,
  },
  x265: {
    label: 'x265',
    plain: 'The name of a free encoder for H.265. A file tagged x265 was re-encoded by someone, so its detail depends on their settings.',
    tradeoff: 'Smaller files for the same picture, but the detail depends on the settings the uploader used.',
    phoneNote: 'Plays smoothly on most phones made in the last several years.',
    chip: true,
  },

  // Bit depth.
  '8bit': {
    label: '8-bit',
    plain: 'Each colour uses 8 bits, the standard depth for most video. Almost every player and screen handles it.',
    tradeoff: 'Universal, but can show banding in smooth dark areas.',
    phoneNote: 'Plays on any phone.',
    chip: true,
  },
  '10bit': {
    label: '10-bit',
    plain: 'More shades of each colour, so skies and shadows look smoother.',
    tradeoff: 'Smoother picture, though older phones and TVs may not decode 10-bit H.264.',
    phoneNote: 'Fine on most phones, especially with H.265.',
    chip: true,
  },
  hi10p: {
    label: 'Hi10P',
    plain: 'An H.264 file encoded at 10-bit, common in anime. Many phone video chips cannot play it, so the main processor does the work, which is slower and drains the battery.',
    tradeoff: 'Smoother colour, but many phones will play it slowly.',
    phoneNote: 'Often slow on phones. Prefer an 8-bit or H.265 copy.',
    aka: ['Hi10'],
    chip: true,
  },

  // HDR formats.
  hdr: {
    label: 'HDR',
    plain: 'Brighter highlights and wider colours. On a screen without HDR, the player converts the picture, which usually looks fine.',
    tradeoff: 'A richer picture, usually with a larger file.',
    phoneNote: 'Phone screens that support HDR show it fully.',
    chip: true,
  },
  hdr10: {
    label: 'HDR10',
    plain: 'The most common HDR format, with one set of brightness settings for the whole film. Android requires phones that advertise high dynamic range to support it.',
    tradeoff: 'The most widely supported HDR format.',
    phoneNote: 'Works on phones with HDR.',
    chip: true,
  },
  hdr10plus: {
    label: 'HDR10+',
    plain: 'HDR10 with brightness settings that change scene by scene. It is optional on Android, and players fall back to basic HDR10 when it is not supported.',
    tradeoff: 'Slightly better picture on supported screens, with no loss elsewhere.',
    phoneNote: 'Falls back to HDR10 on most phones.',
    aka: ['HDR10 Plus'],
    chip: true,
  },
  hlg: {
    label: 'HLG',
    plain: 'A broadcast HDR format, used mainly for live television. Android requires phones that support HDR10 to support this one too.',
    tradeoff: 'Used mainly for live television.',
    phoneNote: 'Supported on phones with HDR.',
    aka: ['Hybrid Log-Gamma'],
    chip: true,
  },
  sdr: {
    label: 'SDR',
    plain: 'Standard dynamic range, the normal brightness and colour range. It works on every screen and player.',
    tradeoff: 'The most compatible choice, with a less vivid picture than HDR.',
    phoneNote: 'Works on every phone.',
    chip: true,
  },
  dv: {
    label: 'Dolby Vision',
    plain: 'Dolby\'s own HDR format, in several versions. Not every phone supports it, and some files have no backup picture, so players without support show green or purple colours.',
    tradeoff: 'A rich picture on supported screens, but some phones and players cannot show it.',
    phoneNote: 'Needs a phone and player that support Dolby Vision. Otherwise pick a copy with HDR10.',
    aka: ['DoVi', 'DV'],
    chip: true,
  },

  // Audio codecs and layouts.
  aac: {
    label: 'AAC',
    plain: 'A common, efficient audio format. It works on every phone and player.',
    tradeoff: 'Small and universal, with less detail than lossless audio.',
    phoneNote: 'Works on every phone.',
    chip: true,
  },
  ac3: {
    label: 'AC3',
    plain: 'Dolby Digital surround sound. Compressed to stay small. VLC and mpv play it; MX Player needs an add-on.',
    tradeoff: 'Compact surround sound, with less detail than newer formats.',
    phoneNote: 'Plays in VLC and mpv.',
    aka: ['Dolby Digital'],
    chip: true,
  },
  eac3: {
    label: 'DD+',
    plain: 'Dolby Digital Plus, a newer and more efficient surround format. Streaming services often use it for Atmos.',
    tradeoff: 'Better than standard Dolby Digital at the same size, but some older players need an extra codec pack.',
    phoneNote: 'Plays in VLC and mpv.',
    aka: ['E-AC-3', 'DDP'],
    chip: true,
  },
  dts: {
    label: 'DTS',
    plain: 'DTS surround sound, used on many discs. Compressed to stay small. Most players handle it, though some need an add-on.',
    tradeoff: 'Richer surround than stereo, but compressed.',
    phoneNote: 'Plays in VLC and mpv.',
    chip: true,
  },
  dtshd: {
    label: 'DTS-HD',
    plain: 'High-quality disc audio, a version of DTS surround sound. It is very large, and phones usually mix it down, so much of the extra data is wasted.',
    tradeoff: 'The richest sound on a home system, but mostly wasted on a phone.',
    phoneNote: 'Usually mixed down, so the size is not worth it on a phone.',
    chip: true,
  },
  truehd: {
    label: 'TrueHD',
    plain: 'Lossless disc audio from Dolby, often carrying Atmos. It is very large, and phones usually mix it down, so the extra size is mostly wasted.',
    tradeoff: 'Full quality on a home cinema system, but wasted size on a phone.',
    phoneNote: 'Usually mixed down, so not worth the size on a phone.',
    aka: ['Dolby TrueHD'],
    chip: true,
  },
  flac: {
    label: 'FLAC',
    plain: 'Lossless audio, which keeps the full original sound in a smaller file than raw audio. It plays on almost every phone.',
    tradeoff: 'Full quality, but a larger file than compressed formats.',
    phoneNote: 'Plays on almost every phone.',
    chip: true,
  },
  opus: {
    label: 'Opus',
    plain: 'A modern, efficient audio format that keeps good quality at small sizes. It plays on recent Android phones.',
    tradeoff: 'Small and clear, but some older players do not know it.',
    phoneNote: 'Plays on recent Android phones.',
    chip: true,
  },
  mp3: {
    label: 'MP3',
    plain: 'An old, widely supported audio format. It is fine for most listening, but it loses a little detail.',
    tradeoff: 'Universal, but less detail per megabyte than newer formats.',
    phoneNote: 'Plays on any phone.',
    aka: ['MPEG-1 Layer 3'],
    chip: true,
  },
  atmos: {
    label: 'Atmos',
    plain: 'Surround sound with height. On a phone it plays as normal stereo.',
    tradeoff: 'Full 3D sound on a home system, but ordinary sound on a phone.',
    phoneNote: 'Plays as ordinary stereo or surround on a phone.',
    aka: ['Dolby Atmos'],
    chip: true,
  },
  channels: {
    label: 'Channels',
    plain: 'How many speaker channels the sound has, such as 5.1 for five main speakers and a subwoofer, or 2.0 for stereo.',
    phoneNote: 'Phones mix surround down to stereo, so 2.0 is enough.',
    chip: false,
  },

  // Languages and subtitles.
  multi: {
    label: 'Multi-audio',
    plain: 'The file has more than one audio language, such as English and French. Pick the one you want in your player.',
    tradeoff: 'More language choice, usually with a slightly larger file.',
    aka: ['MULTi'],
    chip: true,
  },
  hardsub: {
    label: 'Burned-in subs',
    plain: 'The subtitles are drawn into the picture, so they cannot be turned off or restyled. Fine if you need them; otherwise a copy with separate subtitle files is better.',
    tradeoff: 'Subtitles always show, but you lose the choice to turn them off.',
    aka: ['HC'],
    chip: true,
  },

  // Release flags and editions: not quality chips.
  proper: {
    label: 'PROPER',
    plain: 'A new release by another group that fixes a fault in an earlier copy. Usually the better of the two.',
    chip: false,
  },
  repack: {
    label: 'REPACK',
    plain: 'The same group releasing the copy again to fix a fault in its first version.',
    chip: false,
  },
  rerip: {
    label: 'RERIP',
    plain: 'A new capture made to replace an earlier one, usually to fix a fault.',
    chip: false,
  },
  internal: {
    label: 'iNTERNAL',
    plain: 'A copy shared first inside one release group, or tagged so it is not treated as a duplicate. It is not a warning.',
    chip: false,
  },
  extended: {
    label: 'EXTENDED',
    plain: 'A longer cut of the film, with scenes that the cinema release left out.',
    chip: false,
  },
  remastered: {
    label: 'REMASTERED',
    plain: 'Cleaned up from the original film. Colours may look different from older copies.',
    chip: false,
  },
  hybrid: {
    label: 'HYBRID',
    plain: 'Built from more than one source, so parts may come from different releases.',
    chip: false,
  },
  '3d': {
    label: '3D',
    plain: 'A version with depth for 3D screens. It is rarely useful on a phone.',
    chip: false,
  },

  // Non-quality name parts: hidden from the UI.
  service: {
    label: 'Service',
    plain: 'The streaming service the copy was taken from, such as Amazon or Netflix.',
    chip: false,
  },
  year: {
    label: 'Year',
    plain: 'The year the film or show was released. It helps tell apart remakes and sequels.',
    chip: false,
  },
  season: {
    label: 'Season',
    plain: 'The season number of a TV show, shown as S02 in the name.',
    chip: false,
  },
  episode: {
    label: 'Episode',
    plain: 'The episode number inside a season, shown as E05 in the name.',
    chip: false,
  },
  complete: {
    label: 'Complete pack',
    plain: 'The whole season is in one download, not a single episode.',
    chip: false,
  },
  group: {
    label: 'Group',
    plain: 'The name of the team that made the release. It does not say how good the copy is.',
    chip: false,
  },
  extension: {
    label: 'File type',
    plain: 'The last part of the file name, such as mkv for video or exe for programs.',
    chip: false,
  },
};

/** The glossary entry for one token key, or undefined for a key it does not know. */
export function explain(key: string): GlossaryEntry | undefined {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, key) ? GLOSSARY[key as TokenKey] : undefined;
}

/**
 * Ordered chips for a parsed release: quality tokens only, in the order they
 * appear in the name, one chip per key. Never throws.
 */
export function chipsFor(parsed: Pick<ParsedRelease, 'tokens'>): Chip[] {
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const token of parsed.tokens ?? []) {
    if (seen.has(token.key)) continue;
    const entry = explain(token.key);
    if (!entry || !entry.chip) continue;
    seen.add(token.key);
    out.push({ ...entry, key: token.key as TokenKey });
  }
  return out;
}
