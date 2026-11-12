// Deterministic release-name parser (docs/ASSISTANT_DESIGN.md section 2.10).
// Pure TypeScript: no React, no engine, no network. Never throws.
// Every fact is read from the name; anything the name does not say stays unknown.

export type SourceKind =
  | 'cam' | 'ts' | 'tc' | 'scr' | 'hdtv' | 'webdl' | 'webrip' | 'web'
  | 'bluray' | 'remux' | 'dvdrip' | 'hdrip' | 'unknown';
export type VideoCodec = 'avc' | 'hevc' | 'av1' | 'xvid' | 'vp9' | 'mpeg2' | 'vc1' | 'unknown';
export type HdrKind = 'sdr' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dv' | 'unknown';
// 'unknown' is used when the name gives a channel layout (5.1) but no audio codec.
export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'dts' | 'dtshd' | 'truehd' | 'flac' | 'opus' | 'mp3' | 'unknown';

export interface ParsedToken { key: string; text: string; start: number; end: number }

export interface ParsedRelease {
  raw: string;
  title?: string;
  year?: number;
  season?: number;
  /** Every season a multi-season pack covers ("S01-S05" gives 1..5). `season` is the first of them. */
  seasons?: number[];
  /** "Complete Series" or "Complete Collection". */
  completeSeries?: boolean;
  episodes?: number[];
  seasonPack: boolean;
  source: SourceKind;
  untouchedStream?: boolean;
  service?: string;
  resolution?: 480 | 576 | 720 | 1080 | 2160 | 4320;
  interlaced?: boolean;
  codec: VideoCodec;
  encoder?: 'x264' | 'x265';
  bitDepth?: 8 | 10;
  hdr: HdrKind[];
  dvFallback?: boolean | 'unknown';
  audio: { codec: AudioCodec; channels?: string; atmos?: boolean }[];
  multiAudio: boolean;
  hardcodedSubs: boolean;
  flags: {
    proper?: boolean; repack?: boolean; rerip?: boolean; internal?: boolean;
    extended?: boolean; remastered?: boolean; hybrid?: boolean; threeD?: boolean;
  };
  group?: string;
  extension?: string;
  tokens: ParsedToken[];
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

/** Every token key `parseRelease` can emit. The glossary (step 2) needs one entry per key. */
export const TOKEN_KEYS = [
  'cam', 'ts', 'tc', 'scr', 'hdtv', 'webdl', 'webrip', 'web', 'bluray', 'remux', 'dvdrip', 'hdrip',
  '480p', '576p', '720p', '1080p', '2160p', '4320p',
  'avc', 'hevc', 'av1', 'xvid', 'vp9', 'mpeg2', 'vc1', 'x264', 'x265',
  '8bit', '10bit', 'hi10p',
  'hdr', 'hdr10', 'hdr10plus', 'hlg', 'sdr', 'dv',
  'aac', 'ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'flac', 'opus', 'mp3', 'atmos', 'channels',
  'multi', 'hardsub',
  'proper', 'repack', 'rerip', 'internal', 'extended', 'remastered', 'hybrid', '3d',
  'service', 'year', 'season', 'episode', 'complete', 'group', 'extension',
] as const;

interface Draft {
  sources: SourceKind[];
  resolution?: ParsedRelease['resolution'];
  interlaced: boolean;
  codec?: VideoCodec;
  encoder?: 'x264' | 'x265';
  bitDepth?: 8 | 10;
  hi10: boolean;
  hdr: HdrKind[];
  audio: ParsedRelease['audio'];
  pendingAtmos: boolean;
  lastAudioEnd: number;
  service?: string;
  multi: boolean;
  hc: boolean;
  flags: ParsedRelease['flags'];
  season?: number;
  seasons?: number[];
  completeSeries?: boolean;
  episodes: number[];
  complete: boolean;
}

interface Ctx { scan: string; start: number; end: number }
interface Def {
  key: string;
  src: string;
  cs?: boolean;          // case-sensitive (short all-caps tokens that collide with words)
  weak?: boolean;        // only counts after the title has ended
  apply?: (d: Draft, text: string, ctx: Ctx) => void;
}
interface Cand { start: number; end: number; key: string; weak: boolean; apply?: Def['apply'] }

const CH = '(?:[. _-]?[1-9]\\.[01])?';

function chan(text: string): string | undefined {
  const m = /([1-9])\.([01])$/.exec(text);
  return m ? `${m[1]}.${m[2]}` : undefined;
}
const src = (kind: SourceKind) => (d: Draft) => { d.sources.push(kind); };
const res = (n: NonNullable<ParsedRelease['resolution']>) => (d: Draft, text: string) => {
  d.resolution ??= n;
  if (/^\d+i$/i.test(text)) d.interlaced = true;
};
const vid = (c: VideoCodec, enc?: 'x264' | 'x265') => (d: Draft) => {
  d.codec ??= c;
  if (enc) d.encoder ??= enc;
};
const aud = (c: AudioCodec) => (d: Draft, text: string, ctx: Ctx) => {
  const entry: ParsedRelease['audio'][number] = { codec: c };
  const ch = chan(text);
  if (ch) entry.channels = ch;
  if (d.pendingAtmos) { entry.atmos = true; d.pendingAtmos = false; }
  d.audio.push(entry);
  d.lastAudioEnd = ctx.end;
};
const flag = (k: keyof ParsedRelease['flags']) => (d: Draft) => { d.flags[k] = true; };
const hdr = (k: HdrKind) => (d: Draft) => { if (!d.hdr.includes(k)) d.hdr.push(k); };

const DEFS: Def[] = [
  // sources
  { key: 'cam', src: 'HD[-._ ]?CAM|CAM[-._ ]?Rip', apply: src('cam') },
  { key: 'cam', src: 'CAM', weak: true, apply: src('cam') },
  { key: 'ts', src: 'HD[-._ ]?TS|TELE[-._ ]?SYNC|PDVD', apply: src('ts') },
  { key: 'ts', src: 'TS', cs: true, weak: true, apply: src('ts') },
  { key: 'tc', src: 'TELECINE|HD[-._ ]?TC', apply: src('tc') },
  { key: 'tc', src: 'TC', cs: true, weak: true, apply: src('tc') },
  { key: 'scr', src: 'DVD[-._ ]?SCR|SCREENER|BDSCR', apply: src('scr') },
  { key: 'scr', src: 'SCR', cs: true, weak: true, apply: src('scr') },
  { key: 'hdtv', src: 'HD[-._ ]?TV|PDTV|TV[-._ ]?Rip', apply: src('hdtv') },
  { key: 'webdl', src: 'WEB[-._ ]?DL', apply: src('webdl') },
  { key: 'webrip', src: 'WEB[-._ ]?Rip', apply: src('webrip') },
  { key: 'web', src: 'WEB', weak: true, apply: src('web') },
  { key: 'bluray', src: 'Blu[-._ ]?Ray|BD[-._ ]?Rip|BR[-._ ]?Rip|BDMV', apply: src('bluray') },
  { key: 'bluray', src: 'BD', cs: true, weak: true, apply: src('bluray') },
  { key: 'remux', src: 'REMUX', apply: src('remux') },
  { key: 'dvdrip', src: 'DVD[-._ ]?Rip|DVDR|DVD[59]', apply: src('dvdrip') },
  { key: 'dvdrip', src: 'DVD', weak: true, apply: src('dvdrip') },
  { key: 'hdrip', src: 'HD[-._ ]?Rip', apply: src('hdrip') },
  // resolution
  { key: '480p', src: '480[pi]', apply: res(480) },
  { key: '576p', src: '576[pi]', apply: res(576) },
  { key: '720p', src: '720[pi]', apply: res(720) },
  { key: '1080p', src: '1080[pi]|FHD', apply: res(1080) },
  { key: '2160p', src: '2160[pi]|4K|UHD', apply: res(2160) },
  { key: '4320p', src: '4320[pi]|8K', apply: res(4320) },
  // video codecs and encoders
  { key: 'x264', src: 'x264', apply: vid('avc', 'x264') },
  { key: 'avc', src: 'H[. ]?264|AVC', apply: vid('avc') },
  { key: 'x265', src: 'x265', apply: vid('hevc', 'x265') },
  { key: 'hevc', src: 'H[. ]?265|HEVC', apply: vid('hevc') },
  { key: 'av1', src: 'AV1', apply: vid('av1') },
  { key: 'xvid', src: 'XviD|DivX', apply: vid('xvid') },
  { key: 'vp9', src: 'VP9', apply: vid('vp9') },
  { key: 'mpeg2', src: 'MPEG[- ]?2', apply: vid('mpeg2') },
  { key: 'vc1', src: 'VC[- ]?1', apply: vid('vc1') },
  // bit depth
  { key: '10bit', src: '10[- ]?bit', apply: (d) => { d.bitDepth ??= 10; } },
  { key: '8bit', src: '8[- ]?bit', apply: (d) => { d.bitDepth ??= 8; } },
  { key: 'hi10p', src: 'Hi10P?', apply: (d) => { d.bitDepth = 10; d.hi10 = true; } },
  // HDR
  { key: 'hdr10plus', src: 'HDR10(?:\\+|[. ]?Plus)', apply: hdr('hdr10plus') },
  { key: 'hdr10', src: 'HDR10', apply: hdr('hdr10') },
  { key: 'hdr', src: 'HDR', apply: hdr('hdr10') },
  { key: 'hlg', src: 'HLG', apply: hdr('hlg') },
  { key: 'sdr', src: 'SDR', weak: true, apply: hdr('sdr') },
  { key: 'dv', src: 'DV', cs: true, apply: hdr('dv') },
  { key: 'dv', src: 'DoVi|Dolby[ ._-]?Vision', apply: hdr('dv') },
  // audio
  { key: 'aac', src: `AAC(?:[-._ ]?LC)?${CH}`, weak: true, apply: aud('aac') },
  { key: 'ac3', src: `AC[-._ ]?3${CH}|DD${CH}`, apply: aud('ac3') },
  { key: 'eac3', src: `E[-._ ]?AC[-._ ]?3${CH}|DDP${CH}|DD\\+${CH}`, apply: aud('eac3') },
  { key: 'dtshd', src: `DTS[-._ ]?HD(?:[-._ ]?(?:MA|HRA|ES))?${CH}`, apply: aud('dtshd') },
  { key: 'dts', src: `DTS(?:[-._ ]?X)?${CH}`, apply: aud('dts') },
  { key: 'truehd', src: `TrueHD${CH}`, apply: aud('truehd') },
  { key: 'flac', src: `FLAC${CH}`, weak: true, apply: aud('flac') },
  { key: 'opus', src: `Opus${CH}`, weak: true, apply: aud('opus') },
  { key: 'mp3', src: `MP3${CH}`, weak: true, apply: aud('mp3') },
  {
    key: 'atmos', src: 'Atmos', weak: true,
    apply: (d, _t, ctx) => {
      if (d.audio.length) { d.audio[d.audio.length - 1].atmos = true; d.lastAudioEnd = ctx.end; }
      else d.pendingAtmos = true;
    },
  },
  {
    key: 'channels', src: '[1-9]\\.[01]', weak: true,
    apply: (d, text, ctx) => {
      const last = d.audio[d.audio.length - 1];
      const between = ctx.scan.slice(d.lastAudioEnd, ctx.start);
      if (last && d.lastAudioEnd > 0 && /^[ ._-]*$/.test(between) && !last.channels) last.channels = text;
      else d.audio.push({ codec: 'unknown', channels: text });
      d.lastAudioEnd = ctx.end;
    },
  },
  // languages and subtitles
  { key: 'multi', src: 'MULTi|DUAL[ ._-]?Audio|DUAL', weak: true, apply: (d) => { d.multi = true; } },
  { key: 'hardsub', src: 'HC', cs: true, weak: true, apply: (d) => { d.hc = true; } },
  { key: 'hardsub', src: 'HARDSUBS?|HARDCODED', weak: true, apply: (d) => { d.hc = true; } },
  // release flags
  { key: 'proper', src: 'REAL[. _-]?PROPER|PROPER', weak: true, apply: flag('proper') },
  { key: 'repack', src: 'REPACK\\d?', weak: true, apply: flag('repack') },
  { key: 'rerip', src: 'RERIP', weak: true, apply: flag('rerip') },
  { key: 'internal', src: 'iNTERNAL', weak: true, apply: flag('internal') },
  { key: 'extended', src: 'EXTENDED(?:[. _-]?(?:CUT|EDITION))?|UNRATED|DIRECTORS?[. _-]?CUT', weak: true, apply: flag('extended') },
  { key: 'extended', src: 'DC', cs: true, weak: true, apply: flag('extended') },
  { key: 'remastered', src: 'REMASTERED', weak: true, apply: flag('remastered') },
  { key: 'hybrid', src: 'HYBRID', weak: true, apply: flag('hybrid') },
  { key: '3d', src: '3D|H?SBS', weak: true, apply: flag('threeD') },
  // streaming service
  {
    key: 'service', src: 'AMZN|NF|DSNP|HMAX|ATVP|HULU|MUBI|VIMEO|PCOK|PMTP|STAN|CRAV', cs: true, weak: true,
    apply: (d, text) => { d.service ??= text; },
  },
  // season and episode
  {
    key: 'episode', src: 'S\\d{1,3}E\\d{1,4}(?:-?E\\d{1,4})*(?:-\\d{1,4})?',
    apply: (d, text) => {
      const m = /^S(\d+)E(\d+)(.*)$/i.exec(text);
      if (!m) return;
      d.season ??= Number(m[1]);
      const eps = [Number(m[2])];
      const re = /(-?)E(\d+)|-(\d+)/gi;
      let r: RegExpExecArray | null;
      while ((r = re.exec(m[3])) !== null) {
        const dash = r[1] === '-' || r[3] !== undefined;
        const n = Number(r[2] ?? r[3]);
        const last = eps[eps.length - 1];
        if (dash && n > last && n - last <= 300) { for (let i = last + 1; i <= n; i++) eps.push(i); }
        else if (!eps.includes(n)) eps.push(n);
      }
      for (const e of eps) if (!d.episodes.includes(e)) d.episodes.push(e);
    },
  },
  {
    key: 'episode', src: '\\d{1,2}x\\d{2,3}',
    apply: (d, text) => {
      const m = /^(\d+)x(\d+)$/.exec(text);
      if (!m) return;
      d.season ??= Number(m[1]);
      if (!d.episodes.includes(Number(m[2]))) d.episodes.push(Number(m[2]));
    },
  },
  {
    key: 'episode', src: 'Episode[ ._-]?\\d{1,4}',
    apply: (d, text) => {
      const n = Number(/(\d+)$/.exec(text)?.[1]);
      if (Number.isFinite(n) && !d.episodes.includes(n)) d.episodes.push(n);
    },
  },
  {
    // "S01-S05", "S01-05", "S01.S02.S03", "Season 1-3", "Seasons 1 to 3": a pack that covers several seasons.
    key: 'season',
    src: 'S\\d{1,3}(?:(?:-|~)S?\\d{1,3}|[ ._]?to[ ._]?S?\\d{1,3}|[ ._+&]S\\d{1,3}|S\\d{1,3})+'
      + '|Seasons?[ ._]?\\d{1,3}(?:[ ._]*(?:-|~|to|thru|through|&|\\+|,|and)[ ._]*\\d{1,3})+',
    apply: (d, text) => {
      const seasons = expandSeasons(text);
      if (seasons.length === 0) return;
      d.season ??= seasons[0];
      d.seasons = [...new Set([...(d.seasons ?? []), ...seasons])].sort((a, b) => a - b);
    },
  },
  {
    key: 'complete', src: 'COMPLETE[ ._-]?(?:SERIES|COLLECTION|SEASONS|SAGA|BOX[ ._-]?SET)',
    apply: (d) => { d.complete = true; d.completeSeries = true; },
  },
  { key: 'season', src: 'S\\d{1,3}|Season[ ._-]?\\d{1,3}', apply: (d, text) => { d.season ??= Number(/(\d+)$/.exec(text)?.[1]); } },
  { key: 'complete', src: 'COMPLETE', weak: true, apply: (d) => { d.complete = true; } },
];

const SOURCE_ORDER: SourceKind[] = ['cam', 'ts', 'tc', 'scr', 'remux', 'bluray', 'webdl', 'webrip', 'web', 'hdtv', 'dvdrip', 'hdrip'];
// Extensions that are also words or codec names: only a lowercase suffix counts.
const AMBIGUOUS_EXT = new Set(['ts', 'mp3', 'flac', 'aac', 'opus', 'sub', 'com', 'js', 'sh', 'img', 'iso']);
const KNOWN_EXT = new Set([
  'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'ts', 'm2ts', 'vob', 'iso', 'img',
  'srt', 'ass', 'ssa', 'sub', 'idx', 'vtt', 'mp3', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wav',
  'rar', 'zip', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  'exe', 'msi', 'bat', 'cmd', 'scr', 'lnk', 'jar', 'apk', 'dmg', 'com', 'vbs', 'ps1', 'sh', 'js',
  'nfo', 'txt', 'jpg', 'jpeg', 'png', 'pdf', 'torrent',
]);
const ARCHIVE_EXT = new Set(['rar', 'zip', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const EXEC_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'scr', 'lnk', 'jar', 'apk', 'dmg', 'com', 'vbs', 'ps1', 'sh', 'js']);

/** "S01-S05" -> [1..5]; "S01.S02" -> [1, 2]; "Season 1 to 3" -> [1, 2, 3]. Ranges are capped at 100 seasons. */
function expandSeasons(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+)([^\d]*)/g;
  let prev: number | undefined;
  let sep = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (prev !== undefined && /-|~|to|thru|through/i.test(sep) && n > prev && n - prev <= 100) {
      for (let i = prev + 1; i <= n; i++) out.push(i);
    } else {
      out.push(n);
    }
    prev = n;
    sep = m[2];
  }
  return out;
}

const BOUND = (body: string) => `(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`;
const COMPILED = DEFS.map((d) => ({ def: d, re: new RegExp(BOUND(d.src), d.cs ? 'g' : 'gi') }));
const YEAR_RE = new RegExp(BOUND('(?:19|20)\\d\\d'), 'g');
const MAX_SCAN = 4096;

function blank(chars: string[], from: number, to: number): void {
  for (let i = Math.max(0, from); i < Math.min(chars.length, to); i++) chars[i] = ' ';
}

function cleanTitle(s: string): string | undefined {
  const t = s
    .replace(/[._]+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/^[\s\-_.()[\]]+|[\s\-_.()[\]]+$/g, '')
    .replace(/\s+/g, ' ');
  return /[\p{L}\p{N}]/u.test(t) ? t : undefined;
}

interface Leaf {
  d: Draft;
  tokens: ParsedToken[];
  title?: string;
  year?: number;
  group?: string;
  extension?: string;
}

function parseLeaf(text: string, base: number): Leaf {
  const full = text.slice(0, MAX_SCAN);
  const chars = full.split('');
  const d: Draft = {
    sources: [], interlaced: false, hi10: false, hdr: [], audio: [], pendingAtmos: false,
    lastAudioEnd: 0, multi: false, hc: false, flags: {}, episodes: [], complete: false,
  };
  const tokens: ParsedToken[] = [];
  const push = (key: string, s: number, e: number) => tokens.push({ key, text: '', start: base + s, end: base + e });

  // 1. extension
  let bodyEnd = full.length;
  let extension: string | undefined;
  const em = /\.([A-Za-z0-9]{2,5})$/.exec(full);
  if (em && em.index > 0) {
    const ext = em[1];
    const low = ext.toLowerCase();
    if (KNOWN_EXT.has(low) && (!AMBIGUOUS_EXT.has(low) || ext === low)) {
      extension = low;
      bodyEnd = em.index;
      push('extension', em.index + 1, full.length);
      blank(chars, em.index, full.length);
    }
  }
  // 2. trailing CRC32 in brackets
  const crc = /\s*[[(][0-9A-Fa-f]{8}[\])]\s*$/.exec(full.slice(0, bodyEnd));
  if (crc) { blank(chars, crc.index, bodyEnd); bodyEnd = crc.index; }
  // 3. leading [Group]
  let group: string | undefined;
  let groupSpan: [number, number] | undefined;
  let anime = false;
  const lg = /^\s*\[([^\]]+)\]/.exec(full);
  if (lg && lg[0].length <= bodyEnd && !/^(?:\d{3,4}[pi]|[0-9A-Fa-f]{8}|\d{4})$/.test(lg[1].trim())) {
    const s = lg[0].indexOf('[') + 1;
    groupSpan = [s, s + lg[1].length];
    group = lg[1];
    anime = true;
    blank(chars, 0, lg[0].length);
  }
  const scan = chars.join('');

  // 4. candidates
  const cands: Cand[] = [];
  for (const { def, re } of COMPILED) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      cands.push({ start: m.index, end: m.index + m[0].length, key: def.key, weak: !!def.weak, apply: def.apply });
    }
  }
  const maxYear = new Date().getFullYear() + 1;
  const yearCands: Cand[] = [];
  YEAR_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = YEAR_RE.exec(scan)) !== null) {
      if (Number(m[0]) <= maxYear) yearCands.push({ start: m.index, end: m.index + 4, key: 'year', weak: false });
    }
  }
  // anime episode marker: " - 07", " - 07v2"
  let markerStart: number | undefined;
  const hasSxxEyy = cands.some((c) => c.key === 'episode' || c.key === 'season');
  if (anime && !hasSxxEyy) {
    const am = /(?<=\s)-\s+(\d{1,4})(?:v\d+)?(?![A-Za-z0-9])/.exec(scan);
    if (am) {
      const numStart = am.index + am[0].indexOf(am[1]);
      markerStart = am.index;
      const ep = Number(am[1]);
      cands.push({
        start: numStart, end: am.index + am[0].length, key: 'episode', weak: false,
        apply: (dd) => { if (!dd.episodes.includes(ep)) dd.episodes.push(ep); },
      });
    }
  }

  // 5. overlap resolution: earliest start wins, then the longest match
  const all = [...cands, ...yearCands].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Cand[] = [];
  let lastEnd = -1;
  for (const c of all) {
    if (c.start >= lastEnd) { kept.push(c); lastEnd = c.end; }
  }

  // 6. year and where the title ends
  const firstStrong = Math.min(
    ...kept.filter((c) => c.key !== 'year' && !c.weak).map((c) => c.start),
    markerStart ?? Infinity,
  );
  let yearCand: Cand | undefined;
  for (const c of kept) {
    if (c.key !== 'year' || c.start >= firstStrong) continue;
    if (cleanTitle(scan.slice(0, c.start)) === undefined) continue; // a year with no title before it is the title
    yearCand = c; // the last valid year before the quality tokens wins
  }
  const anchor = Math.min(firstStrong, yearCand ? yearCand.start : Infinity);
  let keptTokens: Cand[];
  let titleEnd: number | undefined;
  if (Number.isFinite(anchor)) {
    keptTokens = kept.filter((c) => (c.key === 'year' ? c === yearCand : !c.weak || c.start >= anchor));
    titleEnd = anchor;
  } else {
    // No strong token at all: a weak token counts only when it is written in a flat case, not "Web" or "Cam".
    keptTokens = kept.filter((c) => {
      if (c.key === 'year') return false;
      const t = scan.slice(c.start, c.end);
      return t === t.toUpperCase() || t === t.toLowerCase();
    });
    titleEnd = keptTokens.length ? keptTokens[0].start : undefined;
  }

  // 7. group: leading [Group], text after the last free '-', or a trailing [Group]
  if (!group) {
    const body = scan.slice(0, bodyEnd);
    const trail = /(?:\s*\[[^\]]*\])+\s*$/.exec(body);
    const end2 = trail ? trail.index : body.replace(/\s+$/, '').length;
    if (titleEnd !== undefined) {
      let dash = -1;
      for (let i = end2 - 1; i >= titleEnd; i--) {
        if (body[i] === '-' && !keptTokens.some((c) => i >= c.start && i < c.end)) { dash = i; break; }
      }
      if (dash >= 0) {
        const tail = body.slice(dash + 1, end2);
        if (/^[A-Za-z0-9_.]+$/.test(tail)) {
          const inTail = keptTokens.filter((c) => c.end > dash + 1 && c.start < end2);
          // "x264-TS": a token that fills the whole tail is the group name, not a token.
          const exact = inTail.length === 1 && inTail[0].start === dash + 1 && inTail[0].end === end2
            && inTail[0].key !== 'episode' && inTail[0].key !== 'season' && inTail[0].key !== 'year';
          if (inTail.length === 0 || exact) {
            if (exact) keptTokens = keptTokens.filter((c) => c !== inTail[0]);
            group = tail;
            groupSpan = [dash + 1, end2];
          }
        }
      }
    }
    if (!group && trail) {
      const re = /\[([^\]]+)\]/g;
      const tailText = body.slice(trail.index);
      let m: RegExpExecArray | null;
      let lastB: RegExpExecArray | undefined;
      while ((m = re.exec(tailText)) !== null) lastB = m;
      if (lastB) {
        const s = trail.index + lastB.index + 1;
        const e = s + lastB[1].length;
        const overlaps = keptTokens.some((c) => c.end > s && c.start < e);
        const content = lastB[1];
        if (!overlaps && /^[\w. -]+$/.test(content) && !/pass(?:word|wd)?|pwd/i.test(content)) {
          group = content;
          groupSpan = [s, e];
        }
      }
    }
  }

  // 8. apply tokens in order
  keptTokens.sort((a, b) => a.start - b.start);
  let year: number | undefined;
  for (const c of keptTokens) {
    const t = full.slice(c.start, c.end);
    if (c.key === 'year') { year = Number(t); push('year', c.start, c.end); continue; }
    c.apply?.(d, t, { scan, start: c.start, end: c.end });
    push(c.key, c.start, c.end);
  }
  if (group && groupSpan) push('group', groupSpan[0], groupSpan[1]);

  return {
    d, tokens, year, extension,
    title: cleanTitle(scan.slice(0, titleEnd ?? bodyEnd)),
    group: group?.trim() || undefined,
  };
}

function emptyResult(raw: string): ParsedRelease {
  return {
    raw, seasonPack: false, source: 'unknown', codec: 'unknown', hdr: [], audio: [],
    multiAudio: false, hardcodedSubs: false, flags: {}, tokens: [], confidence: 'low', warnings: [],
  };
}

/** Parse a release name, torrent name or file path. Never throws. */
export function parseRelease(name: string): ParsedRelease {
  const raw = typeof name === 'string' ? name : '';
  try {
    return parseInner(raw);
  } catch {
    return emptyResult(raw);
  }
}

/** Last `/` that separates folders. A slash with a space on both sides ("Title / 日本語") splits a bilingual title, not a path. */
function lastPathSep(raw: string, ch: string, from: number): number {
  let i = from < 0 ? -1 : raw.lastIndexOf(ch, from);
  while (i > 0 && /\s/.test(raw[i - 1]) && /\s/.test(raw[i + 1] ?? '')) i = raw.lastIndexOf(ch, i - 1);
  return i;
}

function parseInner(raw: string): ParsedRelease {
  const out = emptyResult(raw);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === '/' || raw[end - 1] === '\\')) end--;
  const sep = end > 0 ? Math.max(lastPathSep(raw, '/', end - 1), raw.lastIndexOf('\\', end - 1)) : -1;
  const base = sep + 1;
  const leaf = parseLeaf(raw.slice(base, end), base);
  const d = leaf.d;

  let season = d.season;
  let title = leaf.title;
  if (sep > 0) {
    // File paths: the folder supplies the season (and a missing title) when the file does not.
    const prev = Math.max(lastPathSep(raw, '/', sep - 1), raw.lastIndexOf('\\', sep - 1));
    const folder = raw.slice(prev + 1, sep);
    if (folder) {
      const f = parseLeaf(folder, prev + 1);
      if (season === undefined && f.d.season !== undefined) season = f.d.season;
      if (!title && f.title) title = f.title;
    }
  }

  const source = SOURCE_ORDER.find((s) => d.sources.includes(s)) ?? 'unknown';
  const codec: VideoCodec = d.codec ?? (d.hi10 ? 'avc' : 'unknown');
  let bitDepth = d.bitDepth;
  if (bitDepth === undefined && codec === 'hevc'
    && d.hdr.some((h) => h === 'hdr10' || h === 'hdr10plus' || h === 'dv' || h === 'hlg')) bitDepth = 10;

  out.tokens = leaf.tokens
    .map((t) => ({ ...t, text: raw.slice(t.start, t.end) }))
    .sort((a, b) => a.start - b.start);
  if (title) out.title = title;
  if (leaf.year !== undefined) out.year = leaf.year;
  if (season !== undefined) out.season = season;
  if (d.seasons && d.seasons.length > 1) out.seasons = d.seasons;
  if (d.completeSeries) out.completeSeries = true;
  if (d.episodes.length) out.episodes = [...d.episodes].sort((a, b) => a - b);
  out.seasonPack = d.episodes.length === 0 && (d.season !== undefined || d.complete);
  out.source = source;
  if (source === 'webdl' && (codec === 'avc' || codec === 'hevc')) out.untouchedStream = !d.encoder;
  if (d.service) out.service = d.service;
  if (d.resolution) out.resolution = d.resolution;
  if (d.interlaced) out.interlaced = true;
  out.codec = codec;
  if (d.encoder) out.encoder = d.encoder;
  if (bitDepth) out.bitDepth = bitDepth;
  out.hdr = d.hdr;
  if (d.hdr.includes('dv')) {
    out.dvFallback = d.hdr.some((h) => h === 'hdr10' || h === 'hdr10plus' || h === 'hlg') ? true : 'unknown';
  }
  out.audio = d.audio;
  out.multiAudio = d.multi;
  out.hardcodedSubs = d.hc;
  out.flags = d.flags;
  if (leaf.group) out.group = leaf.group;
  if (leaf.extension) out.extension = leaf.extension;

  const known = (source !== 'unknown' ? 1 : 0) + (out.resolution ? 1 : 0) + (codec !== 'unknown' ? 1 : 0);
  out.confidence = known === 0 ? 'low' : known === 3 ? 'high' : 'medium';

  const w = out.warnings;
  if (source === 'cam' || source === 'ts' || source === 'tc') w.push('cam_source');
  if (source === 'hdrip') w.push('hdrip_not_hdr');
  if (codec === 'avc' && bitDepth === 10) w.push('avc_10bit_software_decode');
  if (out.dvFallback === 'unknown') w.push('dv_no_hdr10_fallback_unknown');
  if (leaf.extension === 'ts') w.push('ts_extension_not_telesync');
  if (leaf.extension && ARCHIVE_EXT.has(leaf.extension)) w.push('archive_extension');
  if (leaf.extension && EXEC_EXT.has(leaf.extension)) w.push('executable_extension');
  if (/(?<![A-Za-z])(?:password|passwd|pwd|pass)(?![A-Za-z])/i.test(raw)) w.push('password_hint');
  return out;
}
