/**
 * The assistant's tool runner (docs/ASSISTANT_DESIGN.md §3.5, §4, §5.4, §6, §7.3 and review round 1).
 *
 * Runs the seven read tools against search and the engine, builds the proposal cards, re-checks them on Confirm
 * and runs the confirmed action. Contract: utils/assistant/runtime.ts (`ToolRunner`).
 *
 * Pure: no React, no react-native, no expo, no engine import. Everything impure comes in through
 * `ToolRunnerDeps`; utils/assistantApp/appToolRunner.ts binds the real modules. Node tests import this file.
 *
 * Rules kept here:
 * - Card facts and fit verdicts are computed by the app from fresh engine and search data (§4.5).
 * - Ids in tool content are handles only (r1, t1). No info hashes, magnets or device paths (§4.1).
 * - Every string from the outside world is sanitised and sits in a `*_untrusted` field (§7.3).
 * - run() never throws. Failures become `{ok:false,error:{code,message}}` content.
 */
import { formatBytes } from '../../constants/format.ts';
import type {
  Detail, DetailFile, DownloadSnapshot, EngineResult, FilePriorityEntry, FreeSpace, MaglevEngineApi, Metadata,
  MetadataFile, PlaybackSupport, Snapshot,
} from '../../modules/maglev-engine/src/MaglevEngine.types.ts';
import { ADMISSION_RESERVE_BYTES, admit, pendingNeedOf } from '../admission.ts';
import type { AdmissionOutcome } from '../admission.ts';
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from '../search/magnet.ts';
import { riskySources } from '../search/safety.ts';
import type { Category, MergedResult, SearchUpdate } from '../search/types.ts';
import { MAX_TOOL_RESULT_TOKENS, estimateTokens } from './context.ts';
import { candidateFromRanked, diskAdvice } from './diskAdvice.ts';
import type { DiskAdvice, DiskCandidate, FinishedDownload } from './diskAdvice.ts';
import { GREEN_TEXT, checkFileSafety, describeFinding } from './fileSafety.ts';
import type { SafetyCategory, SafetyResult } from './fileSafety.ts';
import { chipsFor } from './glossary.ts';
import { HandleRegistry } from './handles.ts';
import { MAX_PLAN_STEPS, planSizeOk } from './planMachine.ts';
import { playbackVerdict } from './playback.ts';
import { parseRelease } from './releaseName.ts';
import type { ParsedRelease } from './releaseName.ts';
import type {
  ExecuteResult, FileKind, FileRowView, ProposalCardView, ResultCardView, ResultDetailsView, RevalidateResult, ScreenTarget, ToolRunContext,
  ToolRunOutput, ToolRunner,
} from './runtime.ts';
import { canPropose, parseQuery, scoreResults } from './scoring.ts';
import type { Label, ParsedQuery, Profile, Ranked, ScoreContext } from './scoring.ts';
import { MESSAGE_MAX, NAME_MAX, QUERY_MAX, filterModelOutput, sanitizeText, toToolJson, truncate, untrustedField } from './sanitize.ts';

// ---------------------------------------------------------------- dependencies

/** The engine calls the runner uses. A subset of `MaglevEngineApi`, with the same signatures. */
export type RunnerEngine = Pick<
  MaglevEngineApi,
  | 'listTorrents' | 'getDetail' | 'resolveMetadata' | 'cancelResolve' | 'addTorrent' | 'setFilePriorities'
  | 'pause' | 'resume' | 'removeFiles' | 'delete' | 'getFreeSpace'
  | 'pauseDownload' | 'resumeDownload' | 'removeDownload'
>;

export interface ToolRunnerDeps {
  /**
   * Run a search with the user's prefs applied (enabled sources, mirrors, hide-dead, extra indexers).
   * Adult content must never be switched on here (D2). Same shape as `searchAll` in utils/search/aggregate.ts.
   */
  search(query: string, category: Category, opts: { signal: AbortSignal; onUpdate?: (u: SearchUpdate) => void }): Promise<SearchUpdate>;
  /** The user's search prefs the runner needs: the risky-source warning switch and the provider table. */
  searchPrefs(): { warnUnsafe: boolean; providers: ReadonlyMap<string, { name: string; unsafeReason?: string }> };
  /** Gives a result its real magnet and info hash (`resolveResult` in utils/search/aggregate.ts). May throw. */
  resolveResult(result: MergedResult, signal: AbortSignal): Promise<MergedResult>;
  engine: RunnerEngine;
  /** What this phone can decode (`getPlaybackSupport`). null when unknown. */
  playbackSupport(): Promise<PlaybackSupport | null>;
  /** Epoch ms. */
  now(): number;
}

// ---------------------------------------------------------------- constants and copy

const DAY_MS = 24 * 60 * 60 * 1000;
// Below the controller's 60 s tool timeout, so a dead torrent gets this tool's own plain answer.
const DETAIL_TIMEOUT_MS = 45_000;
/** Free space used for ranking only when it could not be read. Fit verdicts are then reported as unknown. */
const UNKNOWN_FREE = Number.MAX_SAFE_INTEGER / 4;
const MAX_FILES_IN_RESULT = 40;
const MAX_REASON_CHARS = 200;
const DL_PREFIX = 'dl:';

const NO_SPACE_READ = "Couldn't check free space, so Maglev can't add this right now.";
const GONE = 'That download is gone.';

/** Plain English for engine error codes (SM-36 copy). Never the raw engine message. */
function plainEngineError(code: string): string {
  switch (code) {
    case 'DUPLICATE': return 'Already in your downloads.';
    case 'INVALID_SOURCE': return "That link doesn't work, or it would leave no files to download.";
    case 'INVALID_ARGUMENT': return 'That would leave no files to download.';
    case 'METADATA_TIMEOUT': return "Couldn't find anyone sharing this yet. Try again later.";
    case 'CANCELLED': return 'Stopped.';
    case 'NETWORK':
    case 'TRACKER': return "Can't reach anyone right now.";
    case 'NOT_FOUND': return GONE;
    case 'DISK_FULL': return 'Storage full.';
    case 'PERMISSION': return "Maglev can't write to this folder.";
    case 'FILES_MISSING': return 'Some files are missing.';
    case 'NOT_INITIALIZED':
    case 'ENGINE_UNAVAILABLE':
    case 'NOT_READY': return "The download engine isn't ready yet. Try again in a moment.";
    case 'UNSUPPORTED':
    case 'INVALID_STATE': return "Can't do that while it is moving or checking. Try again when it finishes.";
    case 'LINK_EXPIRED': return 'The link has expired. Paste a fresh link.';
    case 'AUTH_REQUIRED': return 'The site wants you to sign in first.';
    case 'FILE_CHANGED': return 'The file on the server changed, so it has to start over.';
    case 'HTTP_STATUS': return 'The server refused the download.';
    case 'NOT_A_FILE': return 'That link is a web page, not a file.';
    case 'CHECKSUM_MISMATCH': return "The file didn't match its checksum.";
    default: return 'Something went wrong.';
  }
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

// ---------------------------------------------------------------- small helpers

const clean = (s: unknown, max = NAME_MAX): string => sanitizeText(s, max);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function fileName(path: string): string {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function folderLabel(path: string): string {
  const parts = String(path).split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function pct(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function safeCategory(c: Category | undefined): SafetyCategory | undefined {
  switch (c) {
    case 'movies': return 'movie';
    case 'tv': return 'tv';
    case 'anime': return 'anime';
    case 'music': return 'music';
    case undefined: return undefined;
    default: return 'other';
  }
}

/** Run `p`, but reject with CancelledError as soon as the signal aborts. `onAbort` runs first. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      try {
        onAbort?.();
      } catch {
        // Cancelling is best effort.
      }
      reject(new CancelledError());
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

async function callEngine<T>(fn: () => Promise<EngineResult<T>>): Promise<EngineResult<T>> {
  try {
    return await fn();
  } catch {
    return { ok: false, code: 'INTERNAL', message: '' };
  }
}

// ---------------------------------------------------------------- tool output

type Data = Record<string, unknown>;

function fail(code: string, message: string): ToolRunOutput {
  return { content: toToolJson({ ok: false, error: { code, message } }, MESSAGE_MAX) };
}

/** Keys whose arrays may be shortened when a result is over the token cap. */
const SHRINKABLE = ['results', 'transfers', 'files', 'episodes', 'advice', 'items'];

/** Serialise `{ok:true,data}` and keep it within MAX_TOOL_RESULT_TOKENS by shortening the longest list. */
function succeed(data: Data, extra: Pick<ToolRunOutput, 'results' | 'detail'> = {}): ToolRunOutput {
  let json = toToolJson({ ok: true, data }, MESSAGE_MAX);
  let guard = 0;
  while (estimateTokens(json) > MAX_TOOL_RESULT_TOKENS && guard++ < 500) {
    let best: string | null = null;
    let bestLen = 0;
    for (const k of SHRINKABLE) {
      const v = data[k];
      if (Array.isArray(v) && v.length > 1) {
        const len = JSON.stringify(v).length;
        if (len > bestLen) {
          best = k;
          bestLen = len;
        }
      }
    }
    if (best === null) {
      // Nothing left to shorten: keep only the scalar facts.
      const slim: Data = {};
      for (const [k, v] of Object.entries(data)) if (typeof v !== 'object' || v === null) slim[k] = v;
      slim.truncated = true;
      data = slim;
      json = toToolJson({ ok: true, data }, MESSAGE_MAX);
      break;
    }
    (data[best] as unknown[]).pop();
    data.truncated = true;
    json = toToolJson({ ok: true, data }, MESSAGE_MAX);
  }
  return { content: json, ...extra };
}

// ---------------------------------------------------------------- upload age and file kinds


/** "today", "2 days ago", "3 weeks ago", "5 months ago", "1 year ago". Undefined when the source gave no date. */
export function ageText(publishedAt: number | undefined, now: number): string | undefined {
  if (publishedAt === undefined || !Number.isFinite(publishedAt) || publishedAt <= 0) return undefined;
  const days = Math.floor((now - publishedAt) / DAY_MS);
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (days < 1) return 'today';
  if (days < 7) return unit(days, 'day');
  if (days < 30) return unit(Math.floor(days / 7), 'week');
  if (days < 365) return unit(Math.floor(days / 30), 'month');
  return unit(Math.floor(days / 365), 'year');
}

const KIND_EXT: Record<Exclude<FileKind, 'other'>, readonly string[]> = {
  video: ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'flv', 'iso', 'vob'],
  audio: ['mp3', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wav', 'wma', 'ac3', 'dts', 'mka'],
  subtitle: ['srt', 'ass', 'ssa', 'sub', 'idx', 'vtt', 'sup'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
  app: ['exe', 'msi', 'apk', 'bat', 'cmd', 'com', 'scr', 'lnk', 'sh', 'dmg', 'pkg', 'jar', 'vbs', 'ps1'],
  book: ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'djvu', 'cbz', 'cbr', 'fb2'],
  text: ['txt', 'nfo', 'md', 'log', 'diz', 'url', 'html', 'htm', 'rtf', 'csv', 'json', 'xml'],
};
const KIND_BY_EXT: ReadonlyMap<string, FileKind> = new Map(
  (Object.entries(KIND_EXT) as Array<[FileKind, readonly string[]]>).flatMap(([kind, exts]) => exts.map((e): [string, FileKind] => [e, kind])),
);

/** What a file is, by its extension. */
export function fileKindOf(path: string): FileKind {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'other';
  return KIND_BY_EXT.get(base.slice(dot + 1).toLowerCase()) ?? 'other';
}

const DETAIL_FILES_SHOWN = 8;

// ---------------------------------------------------------------- internal state

const STALE_CARD = 'This card is no longer valid. Ask me again.';
const LINK_MISMATCH = "The source's link doesn't match this result, so Maglev won't use it.";

interface Stored {
  hash: string;
  merged: MergedResult;
  /** Real magnet. Empty until the result was resolved. */
  magnet: string;
  parsed: ParsedRelease;
  query: ParsedQuery;
  profile: Profile;
  runtimeMin?: number;
  ranked?: Ranked;
  files?: MetadataFile[];
  totalBytes?: number;
  safety?: SafetyResult;
  /** The info hash the link was verified against (listing hash, or the resolved hash). Used for cancelResolve and for rebuilding the magnet. */
  realHash?: string;
  episodeCount?: number;
  /** The label the last search put on this row's card, or null when it had none. Absent: use ranked.label. */
  cardLabel?: Label | null;
}

interface Space {
  /** Free space and the download list were both read. */
  known: boolean;
  /** The download list was read. */
  listOk: boolean;
  freeBytes: number;
  pendingNeed: number;
  stagingFactor: 1 | 2;
  mode: 'direct' | 'staging' | 'unknown';
  path: string;
  unfinished: number;
  torrents: Snapshot[];
  downloads: DownloadSnapshot[];
}

type TransferRef = { kind: 'torrent' | 'link'; id: string };

type Action =
  | { kind: 'add'; hash: string; indices: number[]; firsts: number[]; sequential: boolean; selectedBytes: number; fileCount: number }
  | { kind: 'select'; ref: TransferRef; entries: FilePriorityEntry[]; fileCount: number }
  | { kind: 'pause' | 'resume'; ref: TransferRef }
  | { kind: 'remove_files'; ref: TransferRef; indices: number[] }
  | { kind: 'delete'; ref: TransferRef; deleteFiles: boolean };

interface Built {
  action: Action;
  title: string;
  confirmLabel: string;
  facts: string[];
  /** Name as the source gave it. Goes to `view.sourceName`, never into `facts`. */
  sourceName?: string;
  /** One line for a plan step. */
  line: string;
  danger: boolean;
  risky: boolean;
  /** Handle of the result or transfer the action acts on. */
  target: string | undefined;
  /** Key used to refuse two plan steps that act on the same thing. */
  key: string;
  /** Bytes an add step takes from free space, for plan totals. */
  addBytes: number;
}

interface CardRecord {
  cardId: string;
  tool: string;
  actions: Action[];
  target: string | undefined;
  /** Every handle the card acts on (a plan has one per step). */
  targets?: string[];
  /** Per action: the success summary once it ran. A step that ran is never run again. */
  done: (string | null)[];
}

interface Row {
  ref: TransferRef;
  name: string;
  state: string;
  bucket: 'active' | 'paused' | 'error' | 'finished';
  done: number;
  total: number;
  downBps: number;
  etaSecs: number;
  pausedBy: string | null;
  health: string | null;
  errorCode: string | null;
  kind: 'torrent' | 'link';
}

/**
 * Id of one step of a plan card, for the step-by-step plan machine (SM-39): `c3:0` is the first step of c3.
 * `revalidate` and `execute` accept it; the plain card id runs every step in order.
 */
export function planStepId(cardId: string, index: number): string {
  return `${cardId}:${index}`;
}

// ---------------------------------------------------------------- the runner

export function createToolRunner(deps: ToolRunnerDeps): ToolRunner {
  const registry = new HandleRegistry();
  const results = new Map<string, Stored>();
  const cards = new Map<string, CardRecord>();
  /** Engine calls of confirmed actions that have not returned yet, by card and step. */
  const inflight = new Map<string, Promise<ExecuteResult>>();
  /** Bumped by reset(). Work that started in an older epoch must not write cards or act. */
  let epoch = 0;

  // ------------------------------------------------------------ shared reads

  async function readSpace(): Promise<Space> {
    const [fsRes, listRes] = await Promise.all([
      callEngine<FreeSpace>(() => deps.engine.getFreeSpace()),
      callEngine<{ torrents: Snapshot[]; downloads?: DownloadSnapshot[] }>(() => deps.engine.listTorrents()),
    ]);
    const torrents = listRes.ok ? listRes.torrents : [];
    const downloads = listRes.ok ? (listRes.downloads ?? []) : [];
    const pendingNeed = pendingNeedOf(
      torrents.map((t) => ({ finished: t.finished, includedBytes: t.includedBytes, downloadedBytes: t.progressBytes })),
    );
    const unfinished = torrents.filter((t) => !t.finished).length;
    if (!fsRes.ok || !listRes.ok) {
      return {
        known: false, listOk: listRes.ok, freeBytes: UNKNOWN_FREE, pendingNeed, stagingFactor: 1, mode: 'unknown', path: '',
        unfinished, torrents, downloads,
      };
    }
    return {
      known: true,
      listOk: true,
      freeBytes: Math.min(fsRes.freeBytes, fsRes.targetFreeBytes ?? fsRes.freeBytes),
      pendingNeed,
      stagingFactor: fsRes.mode === 'staging' ? 2 : 1,
      mode: fsRes.mode,
      path: fsRes.path,
      unfinished,
      torrents,
      downloads,
    };
  }

  const admitFor = (s: Space, bytes: number, extraPending = 0): AdmissionOutcome =>
    admit({ freeBytes: s.freeBytes, pendingNeed: s.pendingNeed + extraPending, stagingFactor: s.stagingFactor, selectionBytes: bytes });

  const fitOf = (o: { result: AdmissionOutcome['result'] } | null, known: boolean): ResultCardView['fit'] =>
    !o || !known ? 'unknown' : o.result === 'Fits' ? 'fits' : o.result === 'Tight' ? 'tight' : 'too_big';

  const leftText = (leftAfter: number): string =>
    leftAfter < 0 ? `short by ${formatBytes(-leftAfter)}` : formatBytes(leftAfter);

  const savesTo = (s: Space): string =>
    s.mode === 'staging' ? 'Saves to your chosen folder'
      : /(^|[\\/])Download[\\/]Maglev[\\/]?$/.test(s.path) ? 'Saves to Download/Maglev'
        : 'Saves to your download folder';

  function finishedList(s: Space): FinishedDownload[] {
    const out: FinishedDownload[] = [];
    for (const t of s.torrents) {
      if (!t.finished) continue;
      const handle = registry.issue('transfer', t.id);
      const ms = t.addedAt > 1e12 ? t.addedAt : t.addedAt * 1000;
      out.push({
        id: handle,
        // The handle stands in for the name so a stranger's text never lands inside advice prose.
        name: handle,
        sizeBytes: t.includedBytes > 0 ? t.includedBytes : t.totalBytes,
        ageDays: t.addedAt > 0 ? Math.max(0, Math.floor((deps.now() - ms) / DAY_MS)) : undefined,
      });
    }
    return out;
  }

  function adviceData(candidates: DiskCandidate[], profile: Profile, s: Space, playback: PlaybackSupport | null): Data[] {
    if (!s.known || candidates.length === 0) return [];
    let advice: DiskAdvice[];
    try {
      advice = diskAdvice(candidates, {
        profile,
        freeBytes: s.freeBytes,
        pendingNeed: s.pendingNeed,
        stagingFactor: s.stagingFactor,
        unfinishedCount: s.unfinished,
        finished: finishedList(s),
        av1Hardware: playback?.av1 === 'hardware',
      });
    } catch {
      return [];
    }
    return advice.slice(0, 6).map((a) => {
      const row: Data = { rule: a.rule, text: a.text };
      const act = a.action;
      if (act?.kind === 'select_episodes') {
        row.action = { kind: act.kind, result_id: registry.handleFor('result', act.candidateId) ?? undefined, count: act.count, sequential: act.sequential };
      } else if (act?.kind === 'choose_candidate') {
        row.action = { kind: act.kind, result_id: registry.handleFor('result', act.candidateId) ?? undefined };
      } else if (act?.kind === 'ask_which_to_remove') {
        row.action = {
          kind: act.kind,
          items: act.items.slice(0, 5).map((i) => ({
            transfer_id: i.id, size_text: i.sizeBytes !== undefined ? formatBytes(i.sizeBytes) : undefined, covers_shortfall: i.coversShortfall,
          })),
        };
      } else if (act) {
        row.action = { kind: act.kind };
      }
      return row;
    });
  }

  // ------------------------------------------------------------ handles and refs

  function storedFor(value: unknown): Stored | null {
    if (typeof value !== 'string') return null;
    if (HandleRegistry.isHandle(value)) {
      const real = registry.resolve(value, 'result');
      return typeof real === 'string' ? (results.get(real) ?? null) : null;
    }
    return results.get(value) ?? null;
  }

  function refFor(value: unknown): TransferRef | null {
    let v: unknown = value;
    if (typeof v === 'string' && HandleRegistry.isHandle(v)) v = registry.resolve(v, 'transfer');
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string' || v.length === 0) return null;
    return v.startsWith(DL_PREFIX) ? { kind: 'link', id: v.slice(DL_PREFIX.length) } : { kind: 'torrent', id: v };
  }

  const refValue = (r: TransferRef): string => (r.kind === 'link' ? `${DL_PREFIX}${r.id}` : r.id);
  const refHandle = (r: TransferRef): string => registry.issue('transfer', refValue(r));

  // ------------------------------------------------------------ result cards

  /** One plain line for the worst finding, or the fixed green wording. Never names. */
  function safetyText(s: SafetyResult): string {
    if (s.level === 'green') return GREEN_TEXT;
    const order = { red: 2, amber: 1, green: 0 } as const;
    const worst = s.findings.slice().sort((a, b) => order[b.level] - order[a.level])[0];
    return worst ? describeFinding(worst) : 'Something about this file list looks off.';
  }

  function cardFor(stored: Stored, space: Space): ResultCardView {
    const r = stored.merged;
    const ranked = stored.ranked;
    const parsed = stored.parsed;
    const prefs = deps.searchPrefs();
    const handle = registry.issue('result', stored.hash);

    let title = clean(parsed.title ?? r.name, NAME_MAX);
    if (parsed.year !== undefined) title += ` (${parsed.year})`;
    if (parsed.season !== undefined) {
      const ep = parsed.episodes && parsed.episodes.length > 0 ? `E${String(parsed.episodes[0]).padStart(2, '0')}` : '';
      title += ` S${String(parsed.season).padStart(2, '0')}${ep}`;
    }
    const adm = ranked?.admission ?? null;
    const view: ResultCardView = {
      handle,
      title,
      chips: chipsFor(parsed),
      sizeText: r.sizeBytes !== undefined && r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : 'Size unknown',
      sharingText: r.seeders === undefined ? 'Sharing unknown' : `${r.seeders} sharing`,
      sourcesText: r.sources.map((id) => clean(prefs.providers.get(id)?.name ?? id, 40)).join(', '),
      fit: fitOf(adm, space.known),
      fitText: adm && space.known ? (adm.result === 'DoesntFit' ? `Needs ${formatBytes(-adm.leftAfter)} more space` : `${formatBytes(adm.leftAfter)} left after`) : '',
      reasons: (ranked?.reasons ?? []).slice(0, 3).map((x) => clean(x, MAX_REASON_CHARS)),
      tier: ranked?.tier ?? 'ok',
    };
    const label = stored.cardLabel !== undefined ? stored.cardLabel : ranked?.label;
    if (label) view.label = label;
    const risky = riskySources(r, prefs.providers, prefs.warnUnsafe);
    if (risky) {
      const why = r.sources.map((id) => prefs.providers.get(id)?.unsafeReason).find((x): x is string => !!x);
      view.riskyWarning = `${risky.map((n) => clean(n, 40)).join(' and ')} ${risky.length > 1 ? 'are' : 'is'} flagged for fake or harmful uploads.${why ? ` ${clean(why, 160)}` : ''}`;
    }
    if (stored.safety) view.safety = { level: stored.safety.level, text: safetyText(stored.safety) };
    const details = detailsFor(stored);
    if (details) view.details = details;
    return view;
  }

  /** What is inside, computed from the torrent's own file list. Never the size of the .torrent file. */
  function detailsFor(stored: Stored): ResultDetailsView | undefined {
    const files = stored.files;
    if (!files || files.length === 0) return undefined;
    const flags = new Map<string, 'danger' | 'warn'>();
    for (const f of stored.safety?.findings ?? []) {
      if (!f.name_untrusted || f.level === 'green') continue;
      const flag = f.level === 'red' ? 'danger' : 'warn';
      if (flags.get(f.name_untrusted) !== 'danger') flags.set(f.name_untrusted, flag);
    }
    const kinds: Partial<Record<FileKind, number>> = {};
    let total = 0;
    for (const f of files) {
      const kind = fileKindOf(f.path);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      total += f.length;
    }
    const rows: FileRowView[] = files
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(0, DETAIL_FILES_SHOWN)
      .map((f) => {
        const base = fileName(f.path);
        const row: FileRowView = { name: clean(base, NAME_MAX), sizeText: formatBytes(f.length), kind: fileKindOf(f.path) };
        const flag = flags.get(base);
        if (flag) row.flag = flag;
        return row;
      });
    const more = files.length - rows.length;
    return {
      fileCount: files.length,
      totalText: formatBytes(total),
      files: rows,
      moreText: more > 0 ? `and ${more} more ${more === 1 ? 'file' : 'files'}` : '',
      kinds,
    };
  }

  // ------------------------------------------------------------ read tools

  async function searchTorrents(args: Data, ctx: ToolRunContext): Promise<ToolRunOutput> {
    const queryText = clean(args.query, QUERY_MAX);
    if (queryText.length < 2) return fail('bad_args', 'The search needs a title.');
    const category = (typeof args.category === 'string' ? args.category : 'all') as Category;
    const profile = (typeof args.profile === 'string' ? args.profile : 'phone') as Profile;
    const sort = typeof args.sort === 'string' ? args.sort : 'best';
    const limit = Math.max(1, Math.min(8, typeof args.limit === 'number' ? args.limit : 6));
    const minSharing = typeof args.min_seeders === 'number' ? args.min_seeders : 1;
    const minRes = typeof args.min_resolution === 'number' ? args.min_resolution : undefined;
    const maxRes = typeof args.max_resolution === 'number' ? args.max_resolution : undefined;
    const maxBytes = typeof args.max_size_gb === 'number' ? Math.round(args.max_size_gb * 1024 * 1024 * 1024) : undefined;
    const runtimeMin = typeof args.runtime_min === 'number' ? args.runtime_min : undefined;

    const prefs = deps.searchPrefs();
    const names = (id: string): string => clean(prefs.providers.get(id)?.name ?? id, 40);
    const progressText = `Searching: ${queryText}`;
    ctx.progress(progressText, 'running');
    const failedSeen = new Set<string>();
    const isDown = (state: string): boolean => state === 'timeout' || state === 'error' || state === 'blocked' || state === 'challenge';
    const onUpdate = (u: SearchUpdate): void => {
      for (const s of u.sources) {
        if (isDown(s.state) && !failedSeen.has(s.providerId)) {
          failedSeen.add(s.providerId);
          ctx.progress(`${names(s.providerId)} didn't answer`, 'failed');
        }
      }
    };

    let update: SearchUpdate;
    try {
      update = await raceAbort(deps.search(queryText, category, { signal: ctx.signal, onUpdate }), ctx.signal);
    } catch (e) {
      if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
      ctx.progress(progressText, 'failed');
      return fail('search_failed', "Search didn't work. Check the connection and try again.");
    }
    ctx.progress(progressText, 'done');

    // R1-9: the model's free text becomes title, year, season and episode here, not in the model.
    const parsedQuery = parseQuery(queryText);
    const space = await readSpace();
    const support = await deps.playbackSupport().catch(() => null);

    // Names are cleaned before they are parsed or stored: invisible and bidi characters and links are gone first.
    let rows = update.results
      .filter((r) => r.seeders === undefined || r.seeders >= minSharing)
      .map((r) => ({ ...r, name: clean(r.name, MESSAGE_MAX) }));
    if (minRes !== undefined || maxRes !== undefined) {
      rows = rows.filter((r) => {
        const res = parseRelease(r.name).resolution;
        if (res === undefined) return true;
        if (minRes !== undefined && res < minRes) return false;
        if (maxRes !== undefined && res > maxRes) return false;
        return true;
      });
    }

    const safety = new Map<string, SafetyResult | null>();
    const packCounts = new Map<string, number>();
    for (const r of rows) {
      const st = results.get(r.infoHash);
      if (st?.safety) safety.set(r.infoHash, st.safety);
      if (st?.episodeCount !== undefined) packCounts.set(r.infoHash, st.episodeCount);
    }
    const scoreCtx: ScoreContext = {
      profile,
      runtimeMin,
      freeBytes: space.freeBytes,
      pendingNeed: space.pendingNeed,
      stagingFactor: space.stagingFactor,
      maxBytes,
      playback: support,
      warnUnsafe: prefs.warnUnsafe,
      providers: prefs.providers,
      query: { ...parsedQuery, raw: queryText },
      category,
      allowEarlySources: args.include_cam === true,
      packEpisodeCounts: packCounts,
      safety,
      now: deps.now(),
    };
    const out = scoreResults(rows, scoreCtx);

    // Sort best: the quality shortlist leads, or when nothing qualified the best rows that are not "avoid".
    const shortlist: Ranked[] = out.shortlist.length > 0 ? out.shortlist : out.ranked.filter((r) => r.tier !== 'avoid').slice(0, 3);
    const picked: Ranked[] = [...shortlist];
    for (const r of out.ranked) if (!picked.includes(r)) picked.push(r);
    // A sort other than "best" applies to the whole list, not to the few rows quality picked, so "newest" finds
    // the newest rows. Rows that cannot be recommended ("avoid") stay last.
    let shown: Ranked[];
    let cardRows: Ranked[];
    if (sort === 'best') {
      shown = picked.slice(0, Math.max(limit, shortlist.length));
      cardRows = shortlist;
    } else {
      const usable = sortShown(picked.filter((r) => r.tier !== 'avoid'), sort);
      const rest = picked.filter((r) => r.tier === 'avoid');
      shown = [...usable, ...rest].slice(0, limit);
      // The cards are the first rows the model sees, in the same order, so "the second one" means one thing.
      cardRows = shown.filter((r) => r.tier !== 'avoid').slice(0, 3);
    }
    const onCard = new Set<Ranked>(cardRows);
    // Labels stay only where they still hold: on a card, and "smaller" only next to the best-fit card it is smaller than.
    const bestFitOnCard = cardRows.some((r) => r.labels.includes('best-fit'));
    const labelOf = (r: Ranked): Label | null => {
      if (!onCard.has(r) || !r.label) return null;
      if (r.label === 'smaller' && !bestFitOnCard) return r.labels.find((l) => l === 'best-quality') ?? null;
      return r.label;
    };

    // Handles are issued here, after ranking, in the order the rows are shown (R1-10).
    for (const r of shown) {
      const prev = results.get(r.id);
      results.set(r.id, {
        hash: r.id,
        merged: r.result,
        magnet: prev?.magnet || r.result.magnet || '',
        parsed: r.parsed,
        query: parsedQuery,
        profile,
        runtimeMin,
        ranked: r,
        files: prev?.files,
        totalBytes: prev?.totalBytes,
        safety: prev?.safety,
        realHash: prev?.realHash,
        episodeCount: prev?.episodeCount,
        cardLabel: labelOf(r),
      });
      registry.issue('result', r.id);
    }

    const rowsData: Data[] = shown.map((r) => {
      const stored = results.get(r.id) as Stored;
      const row: Data = {
        id: registry.handleFor('result', r.id),
        ...untrustedField('name', r.result.name),
        size_text: r.result.sizeBytes ? formatBytes(r.result.sizeBytes) : 'unknown',
        sharing: r.result.seeders ?? null,
        sources: r.result.sources.map(names),
        tier: r.tier,
        fit: fitOf(r.admission, space.known),
        reasons: r.reasons.slice(0, 3),
        flags: r.flags,
      };
      const uploaded = ageText(r.result.publishedAt, deps.now());
      if (uploaded) row.uploaded = uploaded;
      const label = labelOf(r);
      if (label) row.label = label;
      if (onCard.has(r)) row.on_card = true;
      if (space.known && r.admission) row.left_after_text = leftText(r.admission.leftAfter);
      if (r.partialEpisodes !== undefined) row.partial_episodes = r.partialEpisodes;
      const play = playbackVerdict(r.parsed, support);
      if (play.label) row.plays = play.label;
      if (stored.safety) row.safety = stored.safety.level;
      return row;
    });

    const cardViews = cardRows.map((r) => cardFor(results.get(r.id) as Stored, space));

    const hidden: Record<string, number> = {};
    for (const x of out.excluded) hidden[x.reason] = (hidden[x.reason] ?? 0) + 1;

    const notes = [...out.notes];
    if (!space.known) notes.push("Free space couldn't be read, so fit is unknown.");
    if (shown.length > 0 && !shown.some((r) => r.result.publishedAt !== undefined)) {
      notes.push("These sources gave no upload dates, so I can't tell how new they are.");
    }
    const hiddenCam = hidden.cam_source ?? 0;
    if (args.include_cam !== true && hiddenCam > 0 && rowsData.length === 0) {
      notes.push(`Only cinema recordings found (${hiddenCam} hidden). Their quality is poor.`);
    }
    const unanswered = update.sources.filter((s) => isDown(s.state));
    if (unanswered.length > 0) notes.push(`${unanswered.map((s) => names(s.providerId)).join(', ')} didn't answer.`);

    const data: Data = {
      query: { title: clean(parsedQuery.title, QUERY_MAX), year: parsedQuery.year, season: parsedQuery.season, episode: parsedQuery.episode },
      count: rowsData.length,
      results: rowsData,
      hidden,
      notes,
    };
    if (space.known) data.free_text = formatBytes(Math.max(0, space.freeBytes - space.pendingNeed - ADMISSION_RESERVE_BYTES));
    // Nothing fits: say how much more space the closest one needs.
    if (shown.length > 0 && shown.every((r) => fitOf(r.admission, space.known) === 'too_big')) {
      const shortfall = Math.min(...shown.map((r) => -(r.admission as NonNullable<Ranked['admission']>).leftAfter));
      data.all_too_big = true;
      data.shortfall_text = `about ${formatBytes(shortfall)} more space needed`;
    }
    if (shown.some((r) => r.admission && r.admission.result !== 'Fits')) {
      const advice = adviceData(shown.slice(0, 8).map((r) => candidateFromRanked(r, packCounts.get(r.id))), profile, space, support);
      if (advice.length > 0) data.advice = advice;
    }
    const answered = update.sources.filter((x) => x.state === 'done' || (x.state !== 'searching' && x.count > 0)).length;
    const SORT_TEXT: Record<string, string> = { newest: ', newest first', seeders: ', most sharing first', size: ', biggest first', name: ', by name' };
    const detail = update.results.length === 0
      ? 'No results'
      : `${plural(update.results.length, 'result')} from ${plural(Math.max(answered, 1), 'source')}${SORT_TEXT[sort] ?? ''}`;
    return succeed(data, { results: cardViews, detail });
  }

  function sortShown(list: Ranked[], sort: string): Ranked[] {
    const num = (a: number | undefined, b: number | undefined): number => (b ?? -1) - (a ?? -1);
    const copy = list.slice();
    switch (sort) {
      case 'seeders': return copy.sort((a, b) => num(a.result.seeders, b.result.seeders));
      case 'newest': return copy.sort((a, b) => num(a.result.publishedAt, b.result.publishedAt));
      case 'size': return copy.sort((a, b) => num(a.result.sizeBytes, b.result.sizeBytes));
      case 'name': return copy.sort((a, b) => a.result.name.localeCompare(b.result.name));
      default: return copy;
    }
  }

  async function getResultDetails(args: Data, ctx: ToolRunContext): Promise<ToolRunOutput> {
    const stored = storedFor(args.result_id);
    if (!stored) return fail('bad_args', 'That result is not in this chat. Search again.');
    const handle = registry.issue('result', stored.hash);
    const resolveFiles = args.resolve_files !== false;
    const lookText = `Looking inside ${handle}`;
    ctx.progress(lookText, 'running');

    if (!stored.magnet && stored.merged.magnet) stored.magnet = stored.merged.magnet;
    if (stored.magnet && !stored.realHash) {
      // A magnet from the result list must name the hash the result is keyed by.
      const claimed = infoHashFromMagnet(stored.magnet);
      if (!claimed || claimed !== normalizeInfoHash(stored.hash)) {
        stored.magnet = '';
        ctx.progress(lookText, 'failed');
        return fail('source_error', LINK_MISMATCH);
      }
      stored.realHash = claimed;
    }
    if (!stored.magnet) {
      try {
        const resolved = await raceAbort(deps.resolveResult(stored.merged, ctx.signal), ctx.signal);
        // A resolved magnet must name the hash the source says it resolved to.
        const claimed = infoHashFromMagnet(resolved.magnet);
        if (!claimed || claimed !== normalizeInfoHash(resolved.infoHash)) {
          ctx.progress(lookText, 'failed');
          return fail('source_error', LINK_MISMATCH);
        }
        stored.magnet = resolved.magnet;
        stored.realHash = claimed;
        stored.merged = { ...stored.merged, magnet: resolved.magnet };
      } catch (e) {
        if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
        ctx.progress(lookText, 'failed');
        return fail('source_error', "The site didn't give a link for this result. Try another one.");
      }
    }
    if (!stored.magnet) return fail('source_error', "This result has no link, so it can't be opened.");

    if (resolveFiles && !stored.files) {
      const cancelHash = stored.realHash ?? stored.merged.infoHash;
      const expected = stored.realHash;
      let res: EngineResult<Metadata>;
      try {
        res = await raceAbort(
          callEngine(() => deps.engine.resolveMetadata(stored.magnet, DETAIL_TIMEOUT_MS)),
          ctx.signal,
          () => { void callEngine(() => deps.engine.cancelResolve(cancelHash)); },
        );
      } catch (e) {
        if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
        return fail('engine_error', plainEngineError('INTERNAL'));
      }
      if (!res.ok) {
        ctx.progress(lookText, 'failed');
        if (res.code === 'CANCELLED') throw new CancelledError();
        return fail(res.code === 'METADATA_TIMEOUT' ? 'timeout' : 'engine_error', plainEngineError(res.code));
      }
      const metaHash = res.infoHash ? normalizeInfoHash(res.infoHash) : null;
      if (res.infoHash && (!metaHash || metaHash !== expected)) {
        // The torrent's own metadata disagrees with the link the source gave.
        stored.magnet = '';
        stored.realHash = undefined;
        ctx.progress(lookText, 'failed');
        return fail('source_error', LINK_MISMATCH);
      }
      stored.files = res.files.map((f) => ({ index: f.index, path: f.path, length: f.length }));
      stored.totalBytes = res.totalBytes;
      const eps = new Set<number>();
      for (const f of stored.files) for (const e of parseRelease(fileName(f.path)).episodes ?? []) eps.add(e);
      stored.episodeCount = eps.size > 0 ? eps.size : undefined;
      stored.safety = checkFileSafety({
        name: stored.merged.name,
        category: safeCategory(stored.merged.category),
        files: stored.files.map((f) => ({ path: f.path, sizeBytes: f.length })),
        claimedSizeBytes: stored.merged.sizeBytes,
        queryTitle: stored.query.title,
        queryYear: stored.query.year,
        runtimeMin: stored.runtimeMin,
        parserWarnings: stored.parsed.warnings,
      });
    }
    ctx.progress(lookText, 'done');
    ctx.progress('Checking space', 'running');
    const space = await readSpace();
    const support = await deps.playbackSupport().catch(() => null);
    ctx.progress('Checking space', 'done');

    const files = stored.files;
    const total = stored.totalBytes ?? stored.merged.sizeBytes ?? 0;
    const data: Data = {
      id: handle,
      ...untrustedField('name', stored.merged.name),
      total_size_text: total > 0 ? formatBytes(total) : 'unknown',
      file_count: files ? files.length : null,
      files_resolved: Boolean(files),
    };
    const whole = total > 0 ? admitFor(space, total) : null;
    if (whole && space.known) {
      data.fit = fitOf(whole, true);
      data.left_after_text = leftText(whole.leftAfter);
    } else {
      data.fit = 'unknown';
    }
    if (space.stagingFactor === 2) data.needs_double_space = true;

    if (files && stored.safety) {
      data.files = files.slice(0, MAX_FILES_IN_RESULT).map((f) => ({
        index: f.index, ...untrustedField('path', f.path), size_text: formatBytes(f.length), size_bytes: f.length,
      }));
      if (files.length > MAX_FILES_IN_RESULT) data.files_truncated = true;
      const eps: Data[] = [];
      for (const f of files) {
        const p = parseRelease(fileName(f.path));
        for (const e of p.episodes ?? []) eps.push({ season: p.season ?? stored.parsed.season ?? null, episode: e, file_index: f.index });
      }
      if (eps.length > 0) data.episodes = eps;
      // A preset the model may propose, with a fit the app verified.
      const presets: Data[] = [];
      if (files.length > 1) {
        const biggest = files.reduce((a, b) => (b.length > a.length ? b : a));
        presets.push({
          name: 'biggest_file_only', file_indices: [biggest.index], size_text: formatBytes(biggest.length),
          fit: fitOf(admitFor(space, biggest.length), space.known),
        });
      }
      data.presets = presets;
      const s = stored.safety;
      data.safety = {
        level: s.level,
        summary: safetyText(s),
        findings: s.findings.map((f) => ({
          code: f.code,
          level: f.level,
          ...(f.name_untrusted ? untrustedField('name', f.name_untrusted) : {}),
          ...(f.detail ? { detail: f.detail } : {}),
          text: describeFinding(f),
        })),
      };
      const can = canPropose({ safety: stored.safety, flags: stored.ranked?.flags });
      data.can_propose = can.ok;
      if (!can.ok) data.blocked_reason = can.reason;
    } else {
      data.can_propose = false;
      data.blocked_reason = 'The files were not opened. Call this again with resolve_files true before proposing.';
    }

    const play = playbackVerdict(stored.parsed, support);
    if (play.label) data.plays = { label: play.label, reason: play.reason };
    const prefs = deps.searchPrefs();
    if (riskySources(stored.merged, prefs.providers, prefs.warnUnsafe)) data.risky_source = true;

    if (whole && whole.result !== 'Fits' && space.known) {
      const adv = adviceData(
        [{ id: stored.hash, name: stored.merged.name, sizeBytes: total, episodes: stored.episodeCount }],
        stored.profile, space, support,
      );
      if (adv.length > 0) data.advice = adv;
    }
    // The card is returned too, so the chat can show the safety line now that the files were checked.
    const card = cardFor(stored, space);
    let detail = 'Opened, but the files were not listed';
    if (card.details && stored.safety) {
      const s = stored.safety;
      const verdict = s.level === 'green' ? 'Nothing suspicious in the file list' : s.level === 'red' ? 'Serious warning sign in the file list' : 'Something in the file list looks off';
      detail = `${plural(card.details.fileCount, 'file')}, ${card.details.totalText}. ${verdict}`;
    }
    return succeed(data, { results: [card], detail });
  }

  function parseReleaseNames(args: Data, support: PlaybackSupport | null): ToolRunOutput {
    const list = Array.isArray(args.names) ? args.names.slice(0, 10) : [];
    const items: Data[] = list.map((n) => {
      const text = clean(n, 200);
      const p = parseRelease(text);
      const row: Data = {
        ...untrustedField('name', text),
        ...(p.title ? untrustedField('title', p.title) : {}),
        year: p.year ?? null,
        season: p.season ?? null,
        episodes: p.episodes ?? [],
        season_pack: p.seasonPack,
        source: p.source,
        resolution: p.resolution ?? null,
        codec: p.codec,
        bit_depth: p.bitDepth ?? null,
        hdr: p.hdr,
        audio: p.audio.map((a) => `${a.codec}${a.channels ? ` ${a.channels}` : ''}${a.atmos ? ' Atmos' : ''}`),
        multi_audio: p.multiAudio,
        hardcoded_subs: p.hardcodedSubs,
        flags: Object.entries(p.flags).filter(([, v]) => v).map(([k]) => k),
        confidence: p.confidence,
        warnings: p.warnings,
        tokens: chipsFor(p).map((c) => ({ key: c.key, label: c.label, plain: c.plain })),
      };
      const play = playbackVerdict(p, support);
      if (play.label) row.plays = { label: play.label, reason: play.reason };
      return row;
    });
    return succeed({ items });
  }

  async function getFreeSpaceTool(): Promise<ToolRunOutput> {
    const s = await readSpace();
    if (!s.known) return fail('engine_error', "Couldn't read free space right now.");
    const o = admitFor(s, 0);
    return succeed({
      free_text: formatBytes(s.freeBytes),
      promised_text: formatBytes(s.pendingNeed),
      budget_text: formatBytes(Math.max(0, o.budget)),
      kept_spare_text: formatBytes(ADMISSION_RESERVE_BYTES),
      unfinished_downloads: s.unfinished,
      needs_double_space: s.stagingFactor === 2,
    });
  }

  function rowsOf(s: Space): Row[] {
    const rows: Row[] = [];
    for (const t of s.torrents) {
      const bucket: Row['bucket'] = t.state === 'ERROR' || t.error ? 'error'
        : t.finished || t.state === 'COMPLETED' ? 'finished'
          : t.state === 'PAUSED' ? 'paused' : 'active';
      rows.push({
        ref: { kind: 'torrent', id: t.id }, name: t.name, state: t.state, bucket, done: t.progressBytes, total: t.totalBytes,
        downBps: t.downBps, etaSecs: t.etaSecs, pausedBy: t.pausedBy, health: t.health, errorCode: t.error?.code ?? null, kind: 'torrent',
      });
    }
    for (const d of s.downloads) {
      const bucket: Row['bucket'] = d.state === 'error' || d.state === 'needs_link' ? 'error'
        : d.state === 'finished' ? 'finished' : d.state === 'paused' ? 'paused' : 'active';
      rows.push({
        ref: { kind: 'link', id: d.id }, name: d.name, state: d.state, bucket, done: d.downloaded, total: d.size ?? 0,
        downBps: d.downBps, etaSecs: d.eta, pausedBy: d.pausedBy, health: null, errorCode: d.error?.code ?? null, kind: 'link',
      });
    }
    return rows;
  }

  /** Plain status and the first fix for one row, from the same copy explain_error uses. */
  function statusOf(r: Row): { text: string; hint?: string } | null {
    if (r.errorCode) {
      const fixes = r.errorCode === 'DISK_FULL' ? ['Free up space'] : r.errorCode === 'PERMISSION' ? ['Pick the folder again']
        : r.errorCode === 'FILES_MISSING' ? ['Restore the files, or stop downloading the missing ones'] : ['Retry'];
      return { text: plainEngineError(r.errorCode), hint: fixes[0] };
    }
    const tag = r.health && r.health !== 'no_peers' ? r.health : r.pausedBy ?? (r.health === 'no_peers' ? 'no_peers' : null);
    if (!tag) return null;
    const c = pauseCopy(tag);
    return { text: c.plain, ...(c.fixes[0] ? { hint: c.fixes[0] } : {}) };
  }

  async function listTransfers(args: Data): Promise<ToolRunOutput> {
    if (args.transfer_id !== undefined) return transferOne(args);
    const filter = typeof args.filter === 'string' ? args.filter : 'all';
    const s = await readSpace();
    if (!s.listOk) return fail('engine_error', plainEngineError('NOT_READY'));
    const all = rowsOf(s);
    const rows = filter === 'all' ? all : all.filter((r) => r.bucket === filter);
    const items = rows.map((r) => {
      const row: Data = {
        id: refHandle(r.ref),
        kind: r.kind,
        ...untrustedField('name', r.name),
        state: r.state,
        group: r.bucket,
        size_text: r.total > 0 ? formatBytes(r.total) : 'unknown',
        progress_pct: pct(r.done, r.total),
      };
      if (r.bucket === 'active' && r.downBps > 0) row.speed_text = `${formatBytes(r.downBps)}/s`;
      if (r.bucket === 'active' && r.downBps > 0 && r.etaSecs >= 0) row.eta_secs = r.etaSecs;
      if (r.pausedBy) row.paused_by = r.pausedBy;
      if (r.health) row.health = r.health;
      if (r.errorCode) row.error_code = r.errorCode;
      const status = statusOf(r);
      if (status) {
        row.status_text = status.text;
        if (status.hint) row.action_hint = status.hint;
      }
      return row;
    });
    const data: Data = { count: items.length, filter, transfers: items };
    if (s.known) {
      data.free_text = formatBytes(s.freeBytes);
      data.free_after_promised_text = formatBytes(Math.max(0, admitFor(s, 0).budget));
    }
    return succeed(data, { detail: items.length === 0 ? 'No downloads' : plural(items.length, 'download') });
  }

  /** One download: its details and files, plus the plain status and fix that explain_error gives. */
  async function transferOne(args: Data): Promise<ToolRunOutput> {
    const detail = await getTransferDetails({ transfer_id: args.transfer_id, include_files: true });
    const d = JSON.parse(detail.content) as { ok: boolean; data?: Data };
    if (!d.ok || !d.data) return detail;
    const why = JSON.parse((await explainError({ transfer_id: args.transfer_id })).content) as { ok: boolean; data?: Data };
    const data: Data = { ...d.data };
    if (why.ok && why.data) {
      data.status_text = why.data.plain as string;
      const fixes = (why.data.fixes as string[] | undefined) ?? [];
      if (fixes.length > 0) data.action_hint = fixes[0];
    }
    const s = await readSpace();
    if (s.known) data.free_text = formatBytes(s.freeBytes);
    return succeed(data, { detail: typeof data.status_text === 'string' ? (data.status_text as string) : 'Looked at this download' });
  }

  function askUser(args: Data): ToolRunOutput {
    const question = clean(args.question, 160);
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => clean(o, 40))
      .filter((o, i, all) => o.length > 0 && all.indexOf(o) === i)
      .slice(0, 5);
    if (question.length < 3 || options.length < 2) return fail('bad_args', 'Give a question and 2 to 5 different short options.');
    const out = succeed({
      status: 'asked',
      note: 'The question is on screen with buttons. Stop here. Do not repeat it or answer it. Wait for the reply.',
    }, { detail: 'Asked you to choose' });
    return { ...out, question: { question, options } };
  }

  const SETTINGS_SECTION: Record<string, string> = {
    storage: 'Storage', network: 'Network', assistant: 'Assistant', search_providers: 'Search sources', schedule: 'Schedule',
  };

  function openScreen(args: Data): ToolRunOutput {
    let link: { label: string; target: ScreenTarget };
    switch (args.screen) {
      case 'transfers': {
        const f = args.filter as 'all' | 'downloading' | 'paused' | 'done' | 'errors' | undefined;
        link = { label: 'Open Transfers', target: f ? { screen: 'transfers', filter: f } : { screen: 'transfers' } };
        break;
      }
      case 'transfer': {
        const ref = refFor(args.transfer_id);
        if (!ref) return fail('bad_args', 'That download is not in this chat. Look at list_transfers.');
        link = { label: 'Open this download', target: { screen: 'transfer', id: ref.id } };
        break;
      }
      case 'search': {
        const q = typeof args.query === 'string' ? clean(args.query, QUERY_MAX) : '';
        link = { label: 'Open Search', target: q ? { screen: 'search', query: q } : { screen: 'search' } };
        break;
      }
      case 'add_download':
        link = { label: 'Add a download', target: { screen: 'add_download' } };
        break;
      case 'settings': {
        const section = args.section as keyof typeof SETTINGS_SECTION | undefined;
        link = {
          label: section ? `Open Settings → ${SETTINGS_SECTION[section]}` : 'Open Settings',
          target: section ? { screen: 'settings', section: section as 'storage' } : { screen: 'settings' },
        };
        break;
      }
      default:
        return fail('bad_args', 'screen must be transfers, transfer, search, add_download or settings.');
    }
    const out = succeed({ status: 'shown', label: link.label, note: 'A button is on screen. The user taps it. Say what it opens in one short line.' }, { detail: link.label });
    return { ...out, link };
  }

  async function getTransferDetails(args: Data): Promise<ToolRunOutput> {
    const ref = refFor(args.transfer_id);
    if (!ref) return fail('bad_args', 'That download is not in this chat. Check list_transfers.');
    const handle = refHandle(ref);
    if (ref.kind === 'link') {
      const s = await readSpace();
      const d = s.downloads.find((x) => x.id === ref.id);
      if (!d) return fail('gone', GONE);
      return succeed({
        id: handle, kind: 'link', ...untrustedField('name', d.name), state: d.state,
        size_text: d.size !== null ? formatBytes(d.size) : 'unknown', progress_pct: pct(d.downloaded, d.size ?? 0),
        resumable: d.resumable, paused_by: d.pausedBy, ...(d.error ? { error_code: d.error.code } : {}),
        ...(d.notice ? untrustedField('notice', d.notice) : {}),
      });
    }
    const res = await callEngine(() => deps.engine.getDetail(ref.id));
    if (!res.ok) return fail(res.code === 'NOT_FOUND' ? 'gone' : 'engine_error', plainEngineError(res.code));
    const snap = res.snapshot;
    const data: Data = {
      id: handle, kind: 'torrent', ...untrustedField('name', snap.name), state: snap.state,
      size_text: snap.totalBytes > 0 ? formatBytes(snap.totalBytes) : 'unknown',
      progress_pct: pct(snap.progressBytes, snap.totalBytes),
      finished: snap.finished,
      peers_connected: snap.peersLive, peers_seen: snap.peersSeen, web_seeds: snap.webSeeds,
      paused_by: snap.pausedBy, health: snap.health,
      trackers_working: res.trackers.filter((t) => t.status === 'working').length,
      trackers_failing: res.trackers.filter((t) => t.status === 'error').length,
      ratio: Math.round(snap.ratio * 100) / 100,
    };
    if (snap.downBps > 0) data.speed_text = `${formatBytes(snap.downBps)}/s`;
    if (snap.etaSecs >= 0) data.eta_secs = snap.etaSecs;
    if (snap.resolvingSecs !== null) data.looking_for_files_secs = snap.resolvingSecs;
    // The engine's message can name device paths, so only the code and the app's plain text go out (§4.1).
    if (snap.error) data.error = { code: snap.error.code, plain: plainEngineError(snap.error.code) };
    if (args.include_files === true) {
      data.files = res.files.slice(0, 60).map((f: DetailFile) => ({
        index: f.index, ...untrustedField('path', f.path), size_text: formatBytes(f.length), progress_pct: pct(f.progressBytes, f.length),
        priority: f.priority, included: f.included,
      }));
      data.file_count = res.files.length;
    }
    return succeed(data);
  }

  /** §5.4 table: plain meaning and what the app offers. */
  function pauseCopy(tag: string): { plain: string; fixes: string[] } {
    switch (tag) {
      case 'user': return { plain: 'You paused it.', fixes: ['Resume'] };
      case 'wifi_only': return { plain: 'Waiting for Wi-Fi.', fixes: ['Change the Wi-Fi setting', 'Wait for Wi-Fi'] };
      case 'battery': return { plain: 'Battery is low.', fixes: ['Charge the phone', 'Change the battery cutoff'] };
      case 'charging_only': return { plain: 'Waiting for the charger.', fixes: ['Plug in the charger'] };
      case 'schedule': return { plain: 'Paused by your schedule.', fixes: ['Change the schedule'] };
      case 'seed_limit': return { plain: 'Finished sharing to your limit.', fixes: [] };
      case 'fgs_timeout': return { plain: 'Android stopped the background service.', fixes: ['Resume'] };
      case 'network_unvalidated': return { plain: 'Connected, but the network has no internet. A sign-in page may be blocking it.', fixes: ['Sign in to the network'] };
      case 'vpn_required': return { plain: 'VPN-only is on and no VPN is connected.', fixes: ['Connect the VPN', 'Turn off VPN-only'] };
      case 'storage_full': return { plain: 'Storage full.', fixes: ['Free up space', 'Move the download to another folder'] };
      case 'storage_unavailable': return { plain: "The SD card isn't there.", fixes: ['Put the SD card back', 'Move the download'] };
      case 'files_missing':
      case 'files_changed': return { plain: 'Files were deleted or changed outside Maglev.', fixes: ['Restore the files', 'Stop downloading the missing ones', 'Recheck'] };
      case 'no_peers': return { plain: 'No one is sharing this yet.', fixes: ['Keep trying', 'Remove it'] };
      default: return { plain: 'It is paused.', fixes: ['Resume'] };
    }
  }

  async function explainError(args: Data): Promise<ToolRunOutput> {
    const ref = refFor(args.transfer_id);
    if (!ref) return fail('bad_args', 'That download is not in this chat. Check list_transfers.');
    const handle = refHandle(ref);
    const s = await readSpace();
    if (ref.kind === 'link') {
      const d = s.downloads.find((x) => x.id === ref.id);
      if (!d) return fail('gone', GONE);
      if (d.error) {
        const fixes = d.error.code === 'LINK_EXPIRED' ? ['Paste a fresh link']
          : d.error.code === 'AUTH_REQUIRED' ? ['Sign in on the site, then retry'] : ['Retry'];
        return succeed({ id: handle, cause: d.error.code, plain: plainEngineError(d.error.code), fixes, facts: { state: d.state } });
      }
      if (d.state === 'needs_link') return succeed({ id: handle, cause: 'needs_link', plain: 'The link stopped working.', fixes: ['Paste a fresh link'], facts: { state: d.state } });
      if (d.state === 'paused') return succeed({ id: handle, cause: d.pausedBy ?? 'user', ...pauseCopy(d.pausedBy ?? 'user'), facts: { state: d.state } });
      return succeed({ id: handle, cause: 'none', plain: 'Nothing looks wrong with this download.', fixes: [], facts: { state: d.state } });
    }
    let snap: Snapshot | null = s.torrents.find((x) => x.id === ref.id) ?? null;
    if (!snap) {
      const res = await callEngine(() => deps.engine.getDetail(ref.id));
      if (!res.ok) return fail(res.code === 'NOT_FOUND' ? 'gone' : 'engine_error', plainEngineError(res.code));
      snap = res.snapshot;
    }
    const facts: Data = { state: snap.state, progress_pct: pct(snap.progressBytes, snap.totalBytes), peers_connected: snap.peersLive };
    if (snap.error) {
      const code = snap.error.code;
      const fixes = code === 'DISK_FULL' ? ['Free up space', 'Move the download to another folder']
        : code === 'PERMISSION' ? ['Pick the folder again']
          : code === 'FILES_MISSING' ? ['Restore the files, or stop downloading the missing ones']
            : code === 'TRACKER' ? ['Retry'] : ['Retry', 'Recheck the files'];
      return succeed({ id: handle, cause: code, plain: plainEngineError(code), fixes, facts });
    }
    if (snap.health && snap.health !== 'no_peers') return succeed({ id: handle, cause: snap.health, ...pauseCopy(snap.health), facts });
    if (snap.pausedBy) return succeed({ id: handle, cause: snap.pausedBy, ...pauseCopy(snap.pausedBy), facts });
    if (snap.health === 'no_peers' || (snap.state === 'DOWNLOADING' && snap.peersLive === 0 && snap.downBps === 0 && !snap.finished)) {
      return succeed({ id: handle, cause: 'no_peers', ...pauseCopy('no_peers'), facts });
    }
    if (snap.resolvingSecs !== null && snap.resolvingSecs > 0) {
      return succeed({
        id: handle, cause: 'looking_for_files',
        plain: `Still looking for the file list. It has been trying for ${snap.resolvingSecs} seconds.`,
        fixes: ['Wait a little longer'], facts,
      });
    }
    return succeed({ id: handle, cause: 'none', plain: 'Nothing looks wrong with this download.', fixes: [], facts });
  }

  // ------------------------------------------------------------ proposals

  /** Build the card parts and the action for one proposal tool. */
  async function build(tool: string, args: Data, space: Space, pendingAdds: number): Promise<Built | { error: string }> {
    switch (tool) {
      case 'propose_add': return buildAdd(args, space, pendingAdds);
      case 'propose_select_files': return buildSelect(args, space);
      case 'propose_pause_resume': return buildPause(args, space);
      case 'propose_remove_files': return buildRemoveFiles(args);
      case 'propose_delete': return buildDelete(args, space);
      case 'propose_change': return buildChange(args, space);
      default: return { error: 'That is not something a card can do.' };
    }
  }

  async function buildAdd(args: Data, space: Space, pendingAdds: number): Promise<Built | { error: string }> {
    const stored = storedFor(args.result_id);
    if (!stored) return { error: 'That result is not in this chat. Search again.' };
    const handle = registry.issue('result', stored.hash);
    const files = stored.files;
    if (!files || !stored.magnet) return { error: `Look inside ${handle} first with get_result_details, then propose it.` };
    const can = canPropose({ safety: stored.safety, flags: stored.ranked?.flags }); // R1-8: red is enforced here, not in the prompt.
    if (!can.ok) return { error: can.reason ?? "Maglev won't add this." };
    if (!space.known) return { error: NO_SPACE_READ };

    const requested = Array.isArray(args.file_indices) ? (args.file_indices as number[]) : null;
    const valid = new Set(files.map((f) => f.index));
    const indices = requested ? [...new Set(requested)].sort((a, b) => a - b) : files.map((f) => f.index);
    if (indices.length === 0) return { error: 'No files were chosen.' };
    if (indices.some((i) => !valid.has(i))) return { error: 'One of those file numbers is not in this torrent. Check get_result_details.' };
    const firsts = Array.isArray(args.first_indices) ? [...new Set(args.first_indices as number[])].sort((a, b) => a - b) : [];
    if (firsts.some((i) => !indices.includes(i))) return { error: 'The files to fetch first must be among the chosen files.' };
    const lengths = new Map(files.map((f) => [f.index, f.length] as const));
    const selectedBytes = indices.reduce((sum, i) => sum + (lengths.get(i) ?? 0), 0);

    const o = admitFor(space, selectedBytes, pendingAdds);
    if (o.result === 'DoesntFit') {
      return {
        error: `It does not fit: it needs ${formatBytes(o.need)} and ${formatBytes(Math.max(0, o.budget))} is free. Offer a smaller choice or ask which downloads to remove.`,
      };
    }
    const name = clean(stored.merged.name);
    const all = indices.length === files.length;
    const facts = [
      all ? `${plural(files.length, 'file')} · ${formatBytes(selectedBytes)}` : `${indices.length} of ${plural(files.length, 'file')} · ${formatBytes(selectedBytes)}`,
      `Needs ${formatBytes(o.need)} · ${formatBytes(Math.max(0, o.leftAfter))} left after`,
    ];
    if (o.result === 'Tight') facts.push('This leaves under 1 GB free. Your phone may slow down.');
    if (space.stagingFactor === 2) facts.push('Your folder needs double space while downloading.');
    if (args.sequential === true) facts.push('Downloads in order, so you can watch while it downloads.');
    if (firsts.length > 0) facts.push(`${plural(firsts.length, 'file')} first`);
    facts.push(savesTo(space));
    const prefs = deps.searchPrefs();
    return {
      action: { kind: 'add', hash: stored.hash, indices, firsts, sequential: args.sequential === true, selectedBytes, fileCount: files.length },
      title: 'Add torrent?',
      confirmLabel: `Add · ${formatBytes(selectedBytes)}`,
      facts,
      sourceName: name,
      line: `Add ${name} · ${formatBytes(selectedBytes)}`,
      danger: false,
      risky: riskySources(stored.merged, prefs.providers, prefs.warnUnsafe) !== null,
      target: handle,
      key: `add:${stored.hash}`,
      addBytes: selectedBytes,
    };
  }

  async function detailOf(ref: TransferRef): Promise<Detail | { error: string }> {
    if (ref.kind === 'link') return { error: 'A link download is one file, so it has no files to choose.' };
    const res = await callEngine(() => deps.engine.getDetail(ref.id));
    if (!res.ok) return { error: plainEngineError(res.code) };
    return res;
  }

  async function buildSelect(args: Data, space: Space): Promise<Built | { error: string }> {
    const ref = refFor(args.transfer_id);
    if (!ref) return { error: 'That download is not in this chat. Check list_transfers.' };
    const d = await detailOf(ref);
    if ('error' in d) return d;
    const include = new Set((args.include as number[] | undefined) ?? []);
    const skip = new Set((args.skip as number[] | undefined) ?? []);
    const first = new Set((args.first as number[] | undefined) ?? []);
    const valid = new Map(d.files.map((f) => [f.index, f] as const));
    for (const i of [...include, ...skip, ...first]) {
      if (!valid.has(i)) return { error: 'One of those file numbers is not in this download. Look at list_transfers with transfer_id.' };
    }
    const entries = selectEntries(d.files, include, skip, first);
    const kept = entries.filter((e) => e.priority !== 'skip');
    if (kept.length === 0) return { error: 'That would leave no files to download.' };
    let growBytes = 0;
    let skippedNow = 0;
    let skippedBytes = 0;
    for (const e of entries) {
      const f = valid.get(e.index) as DetailFile;
      if (e.priority !== 'skip' && !f.included) growBytes += Math.max(0, f.length - f.progressBytes);
      if (e.priority === 'skip' && f.included) {
        skippedNow += 1;
        skippedBytes += f.length;
      }
    }
    if (growBytes > 0) {
      if (!space.known) return { error: NO_SPACE_READ };
      const o = admitFor(space, growBytes);
      if (o.result === 'DoesntFit') {
        return { error: `It does not fit: the extra files need ${formatBytes(o.need)} and ${formatBytes(Math.max(0, o.budget))} is free.` };
      }
    }
    const name = clean(d.snapshot.name);
    const facts = [`Keeps ${plural(kept.length, 'file')} · ${formatBytes(kept.reduce((s, e) => s + (valid.get(e.index)?.length ?? 0), 0))}`];
    if (skippedNow > 0) facts.push(`Stops downloading ${plural(skippedNow, 'file')} · ${formatBytes(skippedBytes)}. They are not deleted.`);
    if (growBytes > 0) facts.push(`Adds ${formatBytes(growBytes)} still to download`);
    return {
      action: { kind: 'select', ref, entries, fileCount: d.files.length },
      title: 'Change which files download?',
      confirmLabel: 'Update files',
      facts,
      sourceName: name,
      line: `Change files of ${name}`,
      danger: false,
      risky: false,
      target: refHandle(ref),
      key: `t:${refValue(ref)}`,
      addBytes: 0,
    };
  }

  /** Priorities for every file: skip wins over include, a file named in `first` is fetched first, the rest keep theirs. */
  function selectEntries(files: DetailFile[], include: Set<number>, skip: Set<number>, first: Set<number>): FilePriorityEntry[] {
    return files.map((f) => {
      let priority: FilePriorityEntry['priority'] = f.priority;
      if (skip.has(f.index)) priority = 'skip';
      else if (include.has(f.index) && priority === 'skip') priority = 'normal';
      if (first.has(f.index) && priority !== 'skip') priority = 'first';
      return { index: f.index, priority };
    });
  }

  function rowFor(s: Space, ref: TransferRef): Row | null {
    return rowsOf(s).find((r) => r.ref.kind === ref.kind && r.ref.id === ref.id) ?? null;
  }

  function pauseStateError(row: Row, pause: boolean): string | null {
    if (pause) {
      if (row.bucket === 'paused') return 'It is already paused.';
      if (row.bucket === 'finished' && row.kind === 'link') return 'It has already finished.';
      if (row.bucket === 'error') return 'It stopped because of an error, so pausing does nothing.';
      return null;
    }
    if (row.bucket !== 'paused') return row.bucket === 'error' ? 'It stopped because of an error, so resuming does nothing.' : 'It is not paused.';
    if (row.state === 'needs_link') return 'The link stopped working, so it needs a fresh link.';
    return null;
  }

  /** propose_change: one tool for the four things a card can do to a download. Each action reuses its own builder. */
  async function buildChange(args: Data, space: Space): Promise<Built | { error: string }> {
    const files = (args.file_indices as number[] | undefined) ?? [];
    switch (args.action) {
      case 'pause':
      case 'resume':
        return buildPause({ transfer_id: args.transfer_id, action: args.action, reason: args.reason }, space);
      case 'select_files': {
        // "Keep only these files": every other file is skipped, so the card shows exactly what stops.
        const ref = refFor(args.transfer_id);
        if (!ref) return { error: 'That download is not in this chat. Look at list_transfers.' };
        const d = await detailOf(ref);
        if ('error' in d) return d;
        const keep = new Set(files);
        const skip = d.files.map((f) => f.index).filter((i) => !keep.has(i));
        return buildSelect({ transfer_id: args.transfer_id, include: files, skip, reason: args.reason }, space);
      }
      case 'remove_files':
        return buildRemoveFiles({ transfer_id: args.transfer_id, file_indices: files, reason: args.reason });
      case 'delete':
        return buildDelete({ transfer_id: args.transfer_id, delete_files: args.delete_files === true, reason: args.reason }, space);
      default:
        return { error: 'action must be pause, resume, select_files, remove_files or delete.' };
    }
  }

  async function buildPause(args: Data, space: Space): Promise<Built | { error: string }> {
    const ref = refFor(args.transfer_id);
    if (!ref) return { error: 'That download is not in this chat. Check list_transfers.' };
    const row = rowFor(space, ref);
    if (!row) return { error: GONE };
    const pause = args.action === 'pause';
    const err = pauseStateError(row, pause);
    if (err) return { error: err };
    const name = clean(row.name);
    const facts = [`${pct(row.done, row.total)}% done`];
    if (!pause && row.pausedBy && row.pausedBy !== 'user') facts.push(`It was stopped by: ${pauseCopy(row.pausedBy).plain}`);
    return {
      action: { kind: pause ? 'pause' : 'resume', ref },
      title: pause ? 'Pause this download?' : 'Resume this download?',
      confirmLabel: pause ? 'Pause' : 'Resume',
      facts,
      sourceName: name,
      line: `${pause ? 'Pause' : 'Resume'} ${name}`,
      danger: false,
      risky: false,
      target: refHandle(ref),
      key: `t:${refValue(ref)}`,
      addBytes: 0,
    };
  }

  async function buildRemoveFiles(args: Data): Promise<Built | { error: string }> {
    const ref = refFor(args.transfer_id);
    if (!ref) return { error: 'That download is not in this chat. Check list_transfers.' };
    const d = await detailOf(ref);
    if ('error' in d) return d;
    const indices = [...new Set((args.file_indices as number[]) ?? [])].sort((a, b) => a - b);
    const byIndex = new Map(d.files.map((f) => [f.index, f] as const));
    if (indices.length === 0) return { error: 'No files were chosen.' };
    if (indices.some((i) => !byIndex.has(i))) return { error: 'One of those file numbers is not in this download. Look at list_transfers with transfer_id.' };
    if (d.files.filter((f) => f.included && !indices.includes(f.index)).length === 0) {
      return { error: 'That would remove every file. To remove the whole download, propose removing the download instead.' };
    }
    if (d.snapshot.state === 'MOVING' || d.snapshot.state === 'CHECKING') return { error: plainEngineError('INVALID_STATE') };
    const bytes = indices.reduce((s, i) => {
      const f = byIndex.get(i) as DetailFile;
      return s + (f.included ? f.progressBytes : (f.onDiskBytes ?? 0));
    }, 0);
    const names = indices.slice(0, 3).map((i) => clean(fileName((byIndex.get(i) as DetailFile).path), 60));
    const more = indices.length - names.length;
    const n = indices.length;
    return {
      action: { kind: 'remove_files', ref, indices },
      title: `Remove ${plural(n, 'file')}?`,
      confirmLabel: `Remove ${plural(n, 'file')}`,
      sourceName: `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
      facts: [
        // NATIVE_CONTRACT §14 confirm copy.
        `Deletes ${formatBytes(bytes)} from your phone and stops downloading ${n === 1 ? 'it' : 'them'}. Other files keep going.`,
        'There is no undo.',
      ],
      line: `Remove ${plural(n, 'file')} from ${clean(d.snapshot.name, 60)}`,
      danger: true,
      risky: false,
      target: refHandle(ref),
      key: `t:${refValue(ref)}`,
      addBytes: 0,
    };
  }

  async function buildDelete(args: Data, space: Space): Promise<Built | { error: string }> {
    const ref = refFor(args.transfer_id);
    if (!ref) return { error: 'That download is not in this chat. Check list_transfers.' };
    const row = rowFor(space, ref);
    if (!row) return { error: GONE };
    const deleteFiles = args.delete_files === true;
    const name = clean(row.name);
    const facts: string[] = [];
    if (deleteFiles) {
      const folderPath = ref.kind === 'torrent'
        ? space.torrents.find((t) => t.id === ref.id)?.outputFolder
        : space.downloads.find((t) => t.id === ref.id)?.folder;
      const size = row.done > 0 ? row.done : row.total;
      facts.push(size > 0 ? `This permanently deletes ${formatBytes(size)} from your device.` : 'This permanently deletes the downloaded files.');
      const folder = folderLabel(folderPath ?? '');
      if (folder) facts.push(`Folder: ${clean(folder, 60)}`);
    } else {
      facts.push('The files stay on your phone.');
    }
    return {
      action: { kind: 'delete', ref, deleteFiles },
      title: 'Remove download?',
      confirmLabel: deleteFiles ? 'Remove and delete files' : 'Remove download',
      facts,
      sourceName: name,
      line: `${deleteFiles ? 'Remove and delete files of' : 'Remove'} ${name}`,
      danger: true,
      risky: false,
      target: refHandle(ref),
      key: `t:${refValue(ref)}`,
      addBytes: 0,
    };
  }

  /** The model's reason, with links removed. Shown under "Assistant says". */
  function reasonOf(args: Data): string | undefined {
    if (typeof args.reason !== 'string') return undefined;
    const r = truncate(filterModelOutput(args.reason).replace(/\s+/g, ' ').trim(), MAX_REASON_CHARS);
    return r.length > 0 ? r : undefined;
  }

  async function prepareCard(cardId: string, tool: string, args: Record<string, unknown>): Promise<ProposalCardView | { error: string }> {
    const startEpoch = epoch;
    try {
      const space = await readSpace();
      if (startEpoch !== epoch) return { error: STALE_CARD };
      if (tool === 'propose_plan') return await preparePlan(cardId, args, space, startEpoch);
      const built = await build(tool, args, space, 0);
      if (startEpoch !== epoch) return { error: STALE_CARD };
      if ('error' in built) return built;
      cards.set(cardId, { cardId, tool, actions: [built.action], target: built.target, done: [null] });
      const view: ProposalCardView = {
        cardId, tool, title: built.title, facts: built.facts, confirmLabel: built.confirmLabel, dismissLabel: 'Not now',
        danger: built.danger, risky: built.risky,
      };
      if (built.sourceName) view.sourceName = built.sourceName;
      const reason = reasonOf(args);
      if (reason) view.reason = reason;
      return view;
    } catch {
      return { error: "Couldn't prepare that. Try again." };
    }
  }

  async function preparePlan(cardId: string, args: Data, space: Space, startEpoch: number): Promise<ProposalCardView | { error: string }> {
    const steps = Array.isArray(args.steps) ? (args.steps as Array<{ tool: string; args: Data }>) : [];
    if (!planSizeOk(steps.length)) return { error: `A plan needs between 1 and ${MAX_PLAN_STEPS} steps.` };
    const built: Built[] = [];
    const seen = new Set<string>();
    let pendingAdds = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // R1-2: no destructive step and no plan inside a plan.
      if (step.tool !== 'propose_add' && step.tool !== 'propose_select_files' && step.tool !== 'propose_pause_resume') {
        return { error: `Step ${i + 1}: a plan can only add, select files or pause/resume. Removing gets its own card.` };
      }
      const b = await build(step.tool, step.args ?? {}, space, pendingAdds);
      if ('error' in b) return { error: `Step ${i + 1}: ${b.error}` };
      if (seen.has(b.key)) return { error: `Step ${i + 1} acts on the same thing as an earlier step. Steps must be independent.` };
      seen.add(b.key);
      pendingAdds += b.addBytes;
      built.push(b);
    }
    if (startEpoch !== epoch) return { error: STALE_CARD };
    const n = built.length;
    const addTotal = built.reduce((s, b) => s + b.addBytes, 0);
    const facts = [plural(n, 'step')];
    if (addTotal > 0) facts.push(`Adds ${formatBytes(addTotal)} in total`);
    const targets = built.map((b) => b.target).filter((t): t is string => t !== undefined);
    cards.set(cardId, { cardId, tool: 'propose_plan', actions: built.map((b) => b.action), target: targets[0], targets, done: built.map(() => null) });
    const view: ProposalCardView = {
      cardId, tool: 'propose_plan', title: `Run these ${n} steps?`, facts, confirmLabel: `Run ${n} steps`, dismissLabel: 'Not now',
      danger: false, risky: built.some((b) => b.risky), steps: built.map((b) => b.line),
    };
    const reason = reasonOf(args);
    if (reason) view.reason = reason;
    return view;
  }

  // ------------------------------------------------------------ confirm

  function lookup(cardId: string): { rec: CardRecord; indices: number[] } | null {
    const direct = cards.get(cardId);
    if (direct) return { rec: direct, indices: direct.actions.map((_, i) => i) };
    const m = /^(.+):(\d+)$/.exec(cardId);
    if (!m) return null;
    const rec = cards.get(m[1]);
    const i = Number(m[2]);
    return rec && i < rec.actions.length ? { rec, indices: [i] } : null;
  }

  async function revalidateAction(a: Action, space: Space, pendingAdds: number): Promise<string | null> {
    switch (a.kind) {
      case 'add': {
        const stored = results.get(a.hash);
        if (!stored || !stored.files || !stored.magnet) return 'That result is no longer available. Ask me to search again.';
        if (!verifiedMagnet(stored)) return LINK_MISMATCH;
        const can = canPropose({ safety: stored.safety, flags: stored.ranked?.flags });
        if (!can.ok) return can.reason ?? "Maglev won't add this.";
        const valid = new Set(stored.files.map((f) => f.index));
        if (a.indices.some((i) => !valid.has(i))) return 'The file list changed. Ask me for a fresh card.';
        if (!space.known) return "Couldn't check free space. Try again.";
        const o = admitFor(space, a.selectedBytes, pendingAdds);
        if (o.result === 'DoesntFit') return `It no longer fits: it needs ${formatBytes(o.need)} and ${formatBytes(Math.max(0, o.budget))} is free.`;
        return null;
      }
      case 'select': {
        const d = await detailOf(a.ref);
        if ('error' in d) return d.error;
        const valid = new Set(d.files.map((f) => f.index));
        if (a.entries.some((e) => !valid.has(e.index)) || d.files.length !== a.fileCount) return 'The file list changed. Ask me for a fresh card.';
        const grow = d.files.reduce((s, f) => {
          const e = a.entries.find((x) => x.index === f.index);
          return s + (e && e.priority !== 'skip' && !f.included ? Math.max(0, f.length - f.progressBytes) : 0);
        }, 0);
        if (grow > 0) {
          if (!space.known) return "Couldn't check free space. Try again.";
          const o = admitFor(space, grow);
          if (o.result === 'DoesntFit') return `It no longer fits: it needs ${formatBytes(o.need)} and ${formatBytes(Math.max(0, o.budget))} is free.`;
        }
        return null;
      }
      case 'pause':
      case 'resume': {
        const row = rowFor(space, a.ref);
        return row ? pauseStateError(row, a.kind === 'pause') : GONE;
      }
      case 'remove_files': {
        const d = await detailOf(a.ref);
        if ('error' in d) return d.error;
        const valid = new Set(d.files.map((f) => f.index));
        if (a.indices.some((i) => !valid.has(i))) return 'The file list changed. Ask me for a fresh card.';
        if (d.files.filter((f) => f.included && !a.indices.includes(f.index)).length === 0) return 'That would remove every file.';
        if (d.snapshot.state === 'MOVING' || d.snapshot.state === 'CHECKING') return plainEngineError('INVALID_STATE');
        return null;
      }
      case 'delete':
        return rowFor(space, a.ref) ? null : GONE;
    }
  }

  async function revalidate(cardId: string, signal?: AbortSignal): Promise<RevalidateResult> {
    try {
      const startEpoch = epoch;
      const found = lookup(cardId);
      if (!found) return { ok: false, reason: STALE_CARD };
      if (signal?.aborted) return { ok: false, reason: 'Stopped.' };
      const space = await readSpace();
      if (startEpoch !== epoch) return { ok: false, reason: STALE_CARD };
      let pendingAdds = 0;
      for (const i of found.indices) {
        if (found.rec.done[i] !== null) continue; // already ran
        if (inflight.has(`${found.rec.cardId}#${i}`)) continue; // still running: Retry joins it
        const a = found.rec.actions[i];
        const why = await revalidateAction(a, space, pendingAdds);
        if (startEpoch !== epoch) return { ok: false, reason: STALE_CARD };
        if (signal?.aborted) return { ok: false, reason: 'Stopped.' };
        if (why) return { ok: false, reason: found.rec.actions.length > 1 ? `Step ${i + 1}: ${why}` : why };
        if (a.kind === 'add') pendingAdds += a.selectedBytes;
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Couldn't check that. Try again." };
    }
  }

  // ------------------------------------------------------------ execute

  async function executeAction(a: Action): Promise<ExecuteResult> {
    const eng = deps.engine;
    const failed = (code: string): ExecuteResult => ({ ok: false, code, message: plainEngineError(code) });
    switch (a.kind) {
      case 'add': {
        const stored = results.get(a.hash);
        if (!stored) return failed('NOT_FOUND');
        const source = verifiedMagnet(stored);
        if (!source) return { ok: false, code: 'BAD_SOURCE', message: LINK_MISMATCH };
        const files = stored.files ?? [];
        const onlyFiles = a.indices.length < a.fileCount ? a.indices : null;
        const filePriorities = a.firsts.length > 0
          ? files.map((f) => ({
            index: f.index,
            priority: (!a.indices.includes(f.index) ? 'skip' : a.firsts.includes(f.index) ? 'first' : 'normal') as FilePriorityEntry['priority'],
          }))
          : null;
        // The same call the Add sheet makes (app/add-torrent.tsx doAdd). The folder is filled in natively.
        const res = await callEngine(() => eng.addTorrent(source, { onlyFiles, filePriorities, sequential: a.sequential, outputFolder: null }));
        return res.ok ? { ok: true, summary: 'Added.' } : failed(res.code);
      }
      case 'select': {
        const res = await callEngine(() => eng.setFilePriorities(a.ref.id, a.entries));
        return res.ok ? { ok: true, summary: 'Updated.' } : failed(res.code);
      }
      case 'pause':
      case 'resume': {
        const pause = a.kind === 'pause';
        const res = await callEngine(() => a.ref.kind === 'link'
          ? (pause ? eng.pauseDownload(a.ref.id) : eng.resumeDownload(a.ref.id))
          : (pause ? eng.pause(a.ref.id) : eng.resume(a.ref.id)));
        return res.ok ? { ok: true, summary: pause ? 'Paused.' : 'Resumed.' } : failed(res.code);
      }
      case 'remove_files': {
        const res = await callEngine(() => eng.removeFiles(a.ref.id, a.indices));
        return res.ok ? { ok: true, summary: `Freed ${formatBytes(res.freedBytes)}.` } : failed(res.code);
      }
      case 'delete': {
        const res = await callEngine(() => a.ref.kind === 'link' ? eng.removeDownload(a.ref.id, a.deleteFiles) : eng.delete(a.ref.id, a.deleteFiles));
        return res.ok ? { ok: true, summary: a.deleteFiles ? 'Removed and deleted the files.' : 'Removed.' } : failed(res.code);
      }
    }
  }

  /**
   * Runs one action once. The call is kept in `inflight` and its success is recorded when it finishes, whoever is
   * still waiting. A caller that gave up (the chat's 60 s limit) leaves the engine call running; a Retry then joins
   * that call instead of starting a second one. A joined call that failed is tried once more.
   */
  async function runStep(rec: CardRecord, i: number): Promise<ExecuteResult> {
    const key = `${rec.cardId}#${i}`;
    const joined = inflight.get(key);
    if (joined) {
      const res = await joined;
      if (res.ok || rec.done[i] !== null) return res.ok ? res : { ok: true, summary: rec.done[i] as string };
      // It failed: fall through and run it again (nobody else is running it now).
    }
    const existing = inflight.get(key);
    if (existing) return existing;
    const started: Promise<ExecuteResult> = executeAction(rec.actions[i]).then(
      (res): ExecuteResult => {
        if (res.ok) rec.done[i] = res.summary;
        if (inflight.get(key) === started) inflight.delete(key);
        return res;
      },
      (): ExecuteResult => {
        if (inflight.get(key) === started) inflight.delete(key);
        return { ok: false, code: 'INTERNAL', message: plainEngineError('INTERNAL') };
      },
    );
    inflight.set(key, started);
    return started;
  }

  async function execute(cardId: string): Promise<ExecuteResult> {
    try {
      const startEpoch = epoch;
      const found = lookup(cardId);
      if (!found) return { ok: false, code: 'NOT_FOUND', message: STALE_CARD };
      const { rec, indices } = found;
      let last = 'Done.';
      for (const i of indices) {
        const cached = rec.done[i];
        if (cached !== null) {
          last = cached;
          continue;
        }
        if (startEpoch !== epoch) return { ok: false, code: 'NOT_FOUND', message: STALE_CARD };
        const res = await runStep(rec, i);
        if (!res.ok) {
          return indices.length > 1 ? { ok: false, code: res.code, message: `Step ${i + 1} didn't run. ${res.message}` } : res;
        }
        last = res.summary;
      }
      return indices.length > 1 ? { ok: true, summary: `Done: ${plural(indices.length, 'step')}.` } : { ok: true, summary: last };
    } catch {
      return { ok: false, code: 'INTERNAL', message: plainEngineError('INTERNAL') };
    }
  }

  // ------------------------------------------------------------ run

  async function run(call: { id: string; name: string; args: Record<string, unknown> }, ctx: ToolRunContext): Promise<ToolRunOutput> {
    try {
      if (ctx.signal.aborted) throw new CancelledError();
      const args = call.args ?? {};
      let out: ToolRunOutput;
      switch (call.name) {
        case 'search_torrents': out = await searchTorrents(args, ctx); break;
        case 'get_result_details': out = await getResultDetails(args, ctx); break;
        case 'parse_release_name': out = parseReleaseNames(args, await deps.playbackSupport().catch(() => null)); break;
        case 'get_free_space': out = await getFreeSpaceTool(); break;
        case 'list_transfers': out = await listTransfers(args); break;
        case 'get_transfer_details': out = await getTransferDetails(args); break;
        case 'explain_error': out = await explainError(args); break;
        case 'ask_user': out = askUser(args); break;
        case 'open_screen': out = openScreen(args); break;
        default: out = fail('bad_args', 'That is not a read tool.');
      }
      if (ctx.signal.aborted) throw new CancelledError();
      return out;
    } catch (e) {
      if (e instanceof CancelledError || ctx.signal.aborted) return fail('cancelled', 'Stopped.');
      return fail('internal', "That didn't work. Try a different approach.");
    }
  }

  /**
   * The magnet Maglev hands to the engine: rebuilt from the verified hash and our own trackers, never the
   * provider's raw string (it can carry xs, ws or other parameters). Null when the link's hash differs from
   * the verified hash (or, before the result is opened, from the hash the result is keyed by).
   */
  function verifiedMagnet(stored: Stored): string | null {
    const expected = stored.realHash ?? normalizeInfoHash(stored.hash);
    if (!stored.magnet || !expected) return null;
    if (infoHashFromMagnet(stored.magnet) !== expected) return null;
    return buildMagnet(expected, stored.merged.name);
  }

  function sourceFor(handle: string): string | undefined {
    const stored = storedFor(handle);
    if (!stored) return undefined;
    return verifiedMagnet(stored) ?? undefined;
  }

  function reset(): void {
    epoch += 1;
    results.clear();
    cards.clear();
    inflight.clear();
    registry.clear();
  }

  return {
    registry,
    run,
    prepareCard,
    revalidate,
    execute,
    cardTarget: (cardId) => cards.get(cardId)?.target,
    cardTargets: (cardId) => {
      const rec = cards.get(cardId);
      return rec ? (rec.targets ?? (rec.target ? [rec.target] : [])) : [];
    },
    sourceFor,
    reset,
  };
}
