/**
 * The "Added" message after an add from Search (docs/NATIVE_CONTRACT.md section 44.3). Pure: no React, no IO.
 * Merging adds, counts, the words, the timer deadline and which action shows all live here so they can be tested.
 * The component and the hook that use it are components/search/AddedTray.tsx.
 */
import { formatBytes } from '../constants/format.ts';
import { SOURCE_PATTERNS, parseName, parseRelease, stripName } from './subtitles/parseName.ts';
import type { RequestPhase, SubtitleAsk } from './subtitles/requests.ts';

/** The message stays this long after the latest add. */
export const TRAY_MS = 6000;

/** What happened to a video's subtitles in this message. */
export type TraySub = 'none' | 'asked' | 'skipped';

export interface TrayItem {
  /** Lowercase info hash. */
  hash: string;
  /** The parsed name: "Casino Royale (2006)". */
  display: string;
  /** Just the title: "Casino Royale". */
  short: string;
  /** The add has a subtitle ask: a video, with subtitles available. Never true for music, apps and the like. */
  ask: SubtitleAsk | null;
  sub: TraySub;
  /** 44.15 D1: who asked. Only items the tray asked for in automatic mode are skipped by the tray's Skip. */
  via?: 'auto' | 'manual';
  /** A short note on the add itself ("Leaves 2 GB free"). Shown only when the message has this one add. */
  note?: string;
  /** 45.3: what tells this add apart from another with the same name: "2160p", "BDRip", a release group or a size. */
  tell?: string;
}

export interface TrayState {
  /** Adds that count, in order. */
  items: TrayItem[];
  /** Adds whose torrent was already in Transfers. They are not counted. */
  already: { hash: string; display: string; short: string }[];
  /** The latest add was made with automatic subtitles on. */
  auto: boolean;
  /** Epoch ms when the message goes away. */
  deadline: number;
  /** Epoch ms of the first add in this message (44.15 F9: under TalkBack it stops merging after 60 s). */
  startedAt?: number;
}

export interface TrayAdd {
  hash: string;
  name: string;
  /** Has a subtitle ask (a video, subtitles on, at least one source on). */
  ask: SubtitleAsk | null;
  /** True when the add found the torrent already in Transfers. */
  alreadyThere?: boolean;
  auto: boolean;
  note?: string;
  /** Size in bytes, when known. The last thing 45.3 uses to tell two adds with the same name apart. */
  sizeBytes?: number;
  /** 44.15 F9: the phase of a request already held for this key, if any. A skipped or saved one never says "Getting". */
  phase?: RequestPhase;
}

// ---------------------------------------------------------------- names

const SEASON_TAIL = /[\s._-]+(?:s(\d{1,2})|season[\s._-]*(\d{1,2}))(?:[\s._-]+(?:complete|pack|full))?$/i;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** What the user sees for a result name. `short` is the title alone. */
export function readName(name: string): { display: string; short: string } {
  const p = parseName(name);
  let title = p.title;
  let season = p.season;
  const tail = SEASON_TAIL.exec(title);
  if (tail && p.episode === undefined) {
    season = Number(tail[1] ?? tail[2]);
    title = title.slice(0, tail.index).trim();
  }
  if (!title) {
    const raw = stripName(name).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { display: raw || name, short: raw || name };
  }
  const parts = [title];
  if (p.year !== undefined) parts.push(`(${p.year})`);
  if (season !== undefined) parts.push(`S${pad2(season)}${p.episode !== undefined ? `E${pad2(p.episode)}` : ''}`);
  else if (p.absoluteEpisode !== undefined) parts.push(`- ${p.absoluteEpisode}`);
  return { display: parts.join(' '), short: title };
}

/** True when the name is a season with no episode (a pack). */
export function isSeasonPack(name: string): boolean {
  const p = parseName(name);
  if (p.episode !== undefined || p.season !== undefined) return false;
  return SEASON_TAIL.test(p.title);
}

/**
 * The ask handed to `askSubtitles` (section 44.1). `title` is the parsed name; a season pack adds its video count
 * when known ("Severance S01 · 10 episodes"). `detail` is "1080p · YTS · 2.1 GB" with unknown parts left out.
 */
export function buildAsk(i: { infoHash: string; name: string; sizeBytes?: number; sourceName?: string; videoCount?: number; key?: string }): SubtitleAsk {
  const { display } = readName(i.name);
  const pack = isSeasonPack(i.name);
  const title = pack && i.videoCount && i.videoCount > 1 ? `${display} · ${i.videoCount} episodes` : display;
  const resolution = parseRelease(i.name).resolution;
  const detail = [resolution, i.sourceName, i.sizeBytes && i.sizeBytes > 0 ? formatBytes(i.sizeBytes) : null].filter(Boolean).join(' · ');
  return { key: i.key ?? `t:${i.infoHash.toLowerCase()}`, title, detail };
}

/** 45.3: the source as written in the name ("BDRip", "WEB-DL"), or null. */
function sourceToken(name: string): string | null {
  const n = stripName(name);
  for (const [, re] of SOURCE_PATTERNS) {
    const m = re.exec(n);
    if (m) return m[0].replace(/^[^a-z0-9]/i, '');
  }
  return null;
}

/**
 * 45.3: the part that tells an add apart from another with the same name. The resolution if there is one, otherwise
 * the source or release group, otherwise the size. Empty when the name and size say nothing.
 */
export function tellApart(name: string, sizeBytes?: number): string {
  const info = parseRelease(name);
  if (info.resolution) return info.resolution;
  const source = sourceToken(name);
  if (source) return source;
  if (info.group) return info.group;
  return sizeBytes && sizeBytes > 0 ? formatBytes(sizeBytes) : '';
}

// ---------------------------------------------------------------- merging

export function mergeAdd(prev: TrayState | null, add: TrayAdd, now: number): TrayState {
  const hash = add.hash.toLowerCase();
  const { display, short } = readName(add.name);
  const base: TrayState = prev ?? { items: [], already: [], auto: add.auto, deadline: now + TRAY_MS, startedAt: now };
  const known = add.alreadyThere || base.items.some((x) => x.hash === hash);
  const next: TrayState = { ...base, auto: add.auto, deadline: now + TRAY_MS };
  if (known) {
    if (!next.already.some((x) => x.hash === hash)) next.already = [...next.already, { hash, display, short }];
    return next;
  }
  // 44.15 F9: a key that is already skipped, saved or has its subtitles is not "Getting" and offers no ask.
  const settled = add.phase === 'skipped' || add.phase === 'saved' || add.phase === 'has-already';
  const item: TrayItem = {
    hash,
    display,
    short,
    ask: add.ask,
    sub: settled ? 'skipped' : add.ask && add.auto ? 'asked' : 'none',
    ...(!settled && add.ask && add.auto ? { via: 'auto' as const } : {}),
    ...(add.note ? { note: add.note } : {}),
    ...(tellApart(add.name, add.sizeBytes) ? { tell: tellApart(add.name, add.sizeBytes) } : {}),
  };
  next.items = [...next.items, item];
  return next;
}

/** After the user asked for subtitles on these keys. */
export function markAsked(s: TrayState, keys: readonly string[]): TrayState {
  const set = new Set(keys);
  return { ...s, items: s.items.map((x) => (x.ask && set.has(x.ask.key) && x.sub === 'none' ? { ...x, sub: 'asked' as const, via: 'manual' as const } : x)) };
}

/**
 * Skip (44.15 D1): only the videos the tray asked for in automatic mode become skipped. A video asked for with
 * "Get subtitles" is never touched. Returns the keys to hand to `skipSubtitles`.
 */
export function skipAsked(s: TrayState): { state: TrayState; keys: string[] } {
  const mine = (x: TrayItem) => !!x.ask && x.sub === 'asked' && x.via === 'auto';
  const keys = s.items.filter(mine).map((x) => x.ask!.key);
  return { state: { ...s, items: s.items.map((x) => (mine(x) ? { ...x, sub: 'skipped' as const } : x)) }, keys };
}

/** 44.15 F9: under TalkBack the message stops merging new adds after this long, so it never grows for hours. */
const SCREEN_READER_MERGE_MS = 60_000;

/** Whether a new add may join the message on screen. */
export function trayMayMerge(s: TrayState | null, o: { now: number; screenReader: boolean; focused: boolean }): boolean {
  if (!s || !o.focused) return false;
  if (o.screenReader && s.startedAt !== undefined && o.now - s.startedAt > SCREEN_READER_MERGE_MS) return false;
  return true;
}

/** 44.15 F7: a banner waits for an open sheet; it never closes it. */
export const bannerPlan = (o: { sheetOpen: boolean }): 'now' | 'wait' => (o.sheetOpen ? 'wait' : 'now');

// ---------------------------------------------------------------- counts

export interface TrayCounts {
  /** Adds counted in the title. */
  n: number;
  /** Videos whose subtitles have not been asked for. */
  v: number;
  /** Videos whose subtitles were asked for (and not skipped). */
  asked: number;
  alreadyCount: number;
}

export function trayCounts(s: TrayState): TrayCounts {
  return {
    n: s.items.length,
    v: s.items.filter((x) => x.ask && x.sub === 'none').length,
    asked: s.items.filter((x) => x.ask && x.sub === 'asked').length,
    alreadyCount: s.already.length,
  };
}

/** Asks not made yet (for the choose sheet), and asks made (for the status sheet). */
export const pendingAsks = (s: TrayState): SubtitleAsk[] => s.items.filter((x) => x.ask && x.sub === 'none').map((x) => x.ask!);
export const askedAsks = (s: TrayState): SubtitleAsk[] => s.items.filter((x) => x.ask && x.sub === 'asked').map((x) => x.ask!);

// ---------------------------------------------------------------- words

/** "{A}", "{A}, {B}", "{A}, {B} and {k} more". */
function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * 45.3: the names the message shows. Two adds that would read the same each get their distinguishing part in
 * parentheses: "Big Buck Bunny (2160p), Big Buck Bunny (BDRip)". Names that already differ are left alone.
 */
function itemNames(items: readonly TrayItem[]): string[] {
  const count = new Map<string, number>();
  for (const x of items) count.set(x.display, (count.get(x.display) ?? 0) + 1);
  return items.map((x) => ((count.get(x.display) ?? 0) > 1 && x.tell ? `${x.display} (${x.tell})` : x.display));
}

/** True when the message is only about adds that were already in Transfers. */
const isAlreadyOnly = (s: TrayState): boolean => s.items.length === 0 && s.already.length > 0;

/** Automatic mode shows its own title while any video in the message is getting subtitles. */
function autoTitle(s: TrayState, c: TrayCounts): boolean {
  return s.auto && c.asked > 0;
}

export function trayTitle(s: TrayState): string {
  const c = trayCounts(s);
  if (isAlreadyOnly(s)) return 'Already in Transfers';
  if (autoTitle(s, c)) return c.n === 1 ? 'Added · Getting subtitles' : `Added ${c.n} · Getting subtitles for ${c.asked}`;
  return c.n === 1 ? 'Added to Transfers' : `Added ${c.n} to Transfers`;
}

export function trayLine(s: TrayState): string {
  if (isAlreadyOnly(s)) return nameList(s.already.map((x) => x.display));
  let line = nameList(itemNames(s.items));
  if (s.items.length === 1 && s.items[0].note) line = `${line} · ${s.items[0].note}`;
  if (s.already.length === 1) line = `${line} · ${s.already[0].short} was already there`;
  else if (s.already.length > 1) line = `${line} · ${s.already.length} were already there`;
  return line;
}

/** The message read out in one go, for screen readers. */
export const trayAnnouncement = (s: TrayState): string => `${trayTitle(s)}. ${trayLine(s)}`;

// ---------------------------------------------------------------- actions

export type TrayMain =
  /** v = 1: asks straight away. v >= 2: opens the choose sheet. */
  | { kind: 'ask'; label: string; count: number }
  /** After asking: the state row, with "{k} more" when videos joined later. */
  | { kind: 'getting'; label: string; more: { label: string; a11y: string; count: number } | null; opensStatus: boolean };

export interface TrayAction {
  main: TrayMain | null;
  /** Automatic mode: "See which" (two or more videos) and "Skip". */
  see: boolean;
  skip: boolean;
}

const gettingLabel = (asked: number) => (asked === 1 ? 'Getting subtitles' : `Getting subtitles for ${asked}`);

/** 44.15 F9: the action row's words for the videos asked for, from their live phases. */
export function liveLabel(askedKeys: readonly string[], phases: Record<string, RequestPhase | undefined>): string {
  const ps = askedKeys.map((k) => phases[k]);
  const n = ps.length;
  const count = (f: (p: RequestPhase | undefined) => boolean) => ps.filter(f).length;
  const waiting = count((p) => p === undefined || p === 'queued' || p === 'searching' || p === 'offline' || p === 'limited');
  if (waiting > 0) return gettingLabel(n);
  const needYou = count((p) => p === 'needs-pick');
  if (needYou > 0) return `${needYou} ${needYou === 1 ? 'needs' : 'need'} you`;
  const saved = count((p) => p === 'saved');
  if (saved === n) return 'Subtitles saved';
  if (saved > 0) return `${saved} saved`;
  if (count((p) => p === 'failed') > 0) return "Sources didn't answer";
  if (count((p) => p === 'unavailable') > 0) return "Can't save here";
  if (count((p) => p === 'has-already') === n) return 'Already has subtitles';
  if (count((p) => p === 'skipped') === n) return 'Skipped';
  return 'No subtitles found';
}

export function trayAction(s: TrayState, phases?: Record<string, RequestPhase | undefined>): TrayAction {
  const c = trayCounts(s);
  if (isAlreadyOnly(s)) return { main: null, see: false, skip: false };
  if (autoTitle(s, c) && c.v === 0) return { main: null, see: c.asked >= 2, skip: s.items.some((x) => x.sub === 'asked' && x.via === 'auto') };
  if (c.asked === 0) {
    if (c.v === 0) return { main: null, see: false, skip: false };
    return { main: { kind: 'ask', label: c.v === 1 ? 'Get subtitles' : `Get subtitles for ${c.v}`, count: c.v }, see: false, skip: false };
  }
  const askedKeys = s.items.filter((x) => x.ask && x.sub === 'asked').map((x) => x.ask!.key);
  return {
    main: {
      kind: 'getting',
      label: phases ? liveLabel(askedKeys, phases) : gettingLabel(c.asked),
      more: c.v > 0 ? { label: `${c.v} more`, a11y: `Get subtitles for ${c.v} more`, count: c.v } : null,
      opensStatus: c.asked >= 2,
    },
    see: false,
    skip: false,
  };
}

/** Whether the tile is the lime check (added) or the muted one (already there). */
export const trayTileMuted = (s: TrayState): boolean => isAlreadyOnly(s);

// ---------------------------------------------------------------- timer

/** Milliseconds left on the timer (never below 0). */
export const remainingMs = (deadline: number, now: number): number => Math.max(0, deadline - now);

/** A hold (a finger on the message, or the sheet open) of `heldMs` moves the deadline out by that long. */
export const shiftDeadline = (deadline: number, heldMs: number): number => deadline + Math.max(0, heldMs);

/** The timer runs only while nothing holds it and no screen reader is on (TalkBack: stays until dismissed). */
export const timerRuns = (o: { screenReader: boolean; held: boolean }): boolean => !o.screenReader && !o.held;
