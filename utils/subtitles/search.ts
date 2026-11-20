/**
 * Subtitle search and download (docs/NATIVE_CONTRACT.md sections 36.3, 36.5, 36.7). Orchestration only: the
 * providers, the unzip and the clock come in as arguments, so Node tests run it with fakes.
 */
import { ProviderError } from '../search/http.ts';
import { parseName, parseTyped } from './parseName.ts';
import { rankCandidates, type RankedSubtitle } from './rank.ts';
import { archiveKind, base64ToBytes, bytesToBase64, decodeSubtitleText, hasSubtitleCues, pickZipMember, prepareText, SubtitleError, type SubtitleErrorCode, type ZipMember } from './payload.ts';
import { subtitleFileName } from './naming.ts';
import type { SubFormat, SubtitleCandidate, SubtitleProvider, SubtitleQuery } from './types.ts';

/** Same per-source wait as search (SEARCH_CONTRACT section 4): 8 s unless told otherwise. */
const DEFAULT_WAIT_SECONDS = 8;
/** A download is one request to one source; give it longer than a search. */
const DOWNLOAD_WAIT_SECONDS = 15;

export type SubtitleSourceState = 'searching' | 'done' | 'empty' | 'timeout' | 'error' | 'challenge' | 'limit';

export interface SubtitleSourceStatus {
  providerId: string;
  state: SubtitleSourceState;
  count: number;
  ms: number;
  message?: string;
}

export interface SubtitleFile {
  /** Video file name, no folders. */
  fileName: string;
  videoBytes: number;
  /** 16 lowercase hex, from native `subtitleHash`, only for a finished local file. */
  hash?: string;
  /** NATIVE_CONTRACT 42.4: text the user typed to search for. `fileName` and `videoBytes` stay the real file's. */
  searchName?: string;
}

/** The query for a file (36.3, 36.4). */
export function buildQuery(file: SubtitleFile, languages: string[]): SubtitleQuery {
  // NATIVE_CONTRACT 42.4: the typed name (if any) is what gets parsed; the real file name stays for ranking and saving.
  const p = file.searchName ? parseTyped(file.searchName) : parseName(file.fileName);
  const q: SubtitleQuery = {
    fileName: file.fileName,
    videoBytes: file.videoBytes,
    title: p.title,
    episodeConfidence: p.episodeConfidence,
    languages: languages.slice(),
  };
  // NATIVE_CONTRACT 42.4: the fingerprint belongs to the file, not to a typed name.
  if (file.hash && !file.searchName) q.hash = file.hash;
  if (p.year !== undefined) q.year = p.year;
  if (p.season !== undefined) q.season = p.season;
  if (p.episode !== undefined) q.episode = p.episode;
  if (p.absoluteEpisode !== undefined) q.absoluteEpisode = p.absoluteEpisode;
  return q;
}

/** The code a provider failure becomes for the error copy (copy.ts). HTTP 429 is "limit". */
export function failureCode(e: unknown): SubtitleErrorCode {
  if (e instanceof SubtitleError) return e.code;
  if (e instanceof ProviderError) {
    if (e.kind === 'timeout') return 'timeout';
    if (e.kind === 'challenge' || e.kind === 'blocked') return 'challenge';
    if (e.kind === 'http' && e.status === 429) return 'limit';
  }
  return 'error';
}

interface Run<T> {
  value?: T;
  state: 'ok' | 'timeout' | 'error' | 'challenge' | 'limit' | 'cancelled';
  message?: string;
}

/** Runs one call with a time limit, one retry on the next mirror for network errors and 5xx. */
async function guarded<T>(p: SubtitleProvider, waitMs: number, cancel: AbortSignal | undefined, call: (baseUrl: string, signal: AbortSignal) => Promise<T>): Promise<Run<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitMs);
  const onCancel = () => controller.abort();
  if (cancel) {
    if (cancel.aborted) controller.abort();
    else cancel.addEventListener('abort', onCancel, { once: true });
  }
  let gateListener: (() => void) | undefined;
  // Settles when the controller aborts, even if the provider ignores the signal.
  const gate = new Promise<never>((_, reject) => {
    const fire = () => reject(timedOut ? new ProviderError('timeout', 'No answer in time') : new ProviderError('cancelled', 'Cancelled'));
    if (controller.signal.aborted) fire();
    else {
      gateListener = fire;
      controller.signal.addEventListener('abort', fire, { once: true });
    }
  });
  gate.catch(() => {});
  const work = (async (): Promise<T> => {
    const bases = p.mirrors.length > 0 ? p.mirrors : [''];
    const attempts = Math.min(bases.length, 2);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await call(bases[i], controller.signal);
      } catch (e) {
        last = e;
        if (controller.signal.aborted) throw e;
        const retry = e instanceof ProviderError ? e.retryable : false;
        if (!retry || i + 1 >= attempts) throw e;
      }
    }
    throw last;
  })();
  work.catch(() => {});
  try {
    return { state: 'ok', value: await Promise.race([work, gate]) };
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'cancelled') return { state: 'cancelled', message: 'Cancelled' };
    const code = failureCode(e);
    const message = e instanceof Error ? e.message : 'Unexpected error';
    if (code === 'timeout') return { state: 'timeout', message };
    if (code === 'limit') return { state: 'limit', message };
    if (code === 'challenge') return { state: 'challenge', message };
    return { state: 'error', message };
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
    if (gateListener) controller.signal.removeEventListener('abort', gateListener);
  }
}

export interface SearchSubtitlesOptions {
  /** Already filtered by `enabledProviders` (master switch, user switches, signed list). */
  providers: readonly SubtitleProvider[];
  /** Language order (36.2), from `effectiveLanguages`. */
  languages: string[];
  hearingImpaired: 'both' | 'prefer' | 'avoid';
  waitSeconds?: number;
  signal?: AbortSignal;
  onUpdate?: (u: SubtitleSearchUpdate) => void;
}

export interface SubtitleSearchUpdate {
  ranked: RankedSubtitle[];
  sources: SubtitleSourceStatus[];
  done: boolean;
}

export interface SubtitleSearchResult extends SubtitleSearchUpdate {
  query: SubtitleQuery;
}

/**
 * Asks every provider in parallel with a per-source time limit, collects each source's status, and returns the
 * merged, grouped and ordered rows. A source that fails never costs the others. A provider that returns a
 * candidate for a language nobody asked for still has it listed (it shows under "Other…").
 */
export async function searchSubtitles(file: SubtitleFile, opts: SearchSubtitlesOptions): Promise<SubtitleSearchResult> {
  const query = buildQuery(file, opts.languages);
  const waitMs = (opts.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  const statuses = new Map<string, SubtitleSourceStatus>();
  const rows = new Map<string, SubtitleCandidate[]>();
  for (const p of opts.providers) statuses.set(p.id, { providerId: p.id, state: 'searching', count: 0, ms: 0 });

  const snapshot = (done: boolean): SubtitleSearchUpdate => ({
    ranked: rankCandidates(
      opts.providers.flatMap((p) => rows.get(p.id) ?? []),
      { fileName: file.fileName, episodeConfidence: query.episodeConfidence, languages: opts.languages, hearingImpaired: opts.hearingImpaired },
    ),
    sources: opts.providers.map((p) => ({ ...statuses.get(p.id)! })),
    done,
  });
  const emit = (u: SubtitleSearchUpdate) => {
    try {
      opts.onUpdate?.(u);
    } catch {
      // A listener must not break the search.
    }
  };
  emit(snapshot(false));

  await Promise.all(
    opts.providers.map(async (p) => {
      const started = Date.now();
      const r = await guarded(p, waitMs, opts.signal, (baseUrl, signal) => p.search(query, { baseUrl, signal }));
      const list = r.state === 'ok' ? (r.value ?? []).map((c) => ({ ...c, providerId: p.id })) : [];
      rows.set(p.id, list);
      const state: SubtitleSourceState = r.state === 'ok' ? (list.length ? 'done' : 'empty') : r.state === 'cancelled' ? 'error' : r.state;
      statuses.set(p.id, { providerId: p.id, state, count: list.length, ms: Date.now() - started, message: r.message });
      emit(snapshot(false));
    }),
  );
  const final = snapshot(true);
  emit(final);
  return { ...final, query };
}

export interface DownloadDeps {
  provider: SubtitleProvider;
  /** The video being served: its name drives the zip member choice and the suggested file name. */
  query: Pick<SubtitleQuery, 'fileName' | 'season' | 'episode' | 'absoluteEpisode'>;
  /** Native `unzipSubtitles`: base64 in, `{name, base64}` members out. */
  unzip(base64: string): Promise<{ name: string; base64: string }[]>;
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface PreparedSubtitle {
  /** UTF-8, no BOM. */
  text: string;
  format: SubFormat;
  suggestedName: string;
}

/**
 * Downloads one candidate and gets it ready to save: unzips when needed, picks the member (36.7), decodes to UTF-8
 * and finds the format. Throws SubtitleError (or a code from `failureCode`) for the error copy.
 */
export async function downloadAndPrepare(c: SubtitleCandidate, d: DownloadDeps): Promise<PreparedSubtitle> {
  const waitMs = (d.waitSeconds ?? DOWNLOAD_WAIT_SECONDS) * 1000;
  const r = await guarded(d.provider, waitMs, d.signal, (baseUrl, signal) => d.provider.download(c, { baseUrl, signal }));
  if (r.state !== 'ok' || !r.value) throw new SubtitleError(r.state === 'cancelled' ? 'error' : (r.state as SubtitleErrorCode), r.message);
  const payload = r.value;

  let bytes = payload.bytes;
  const kind = archiveKind(bytes);
  if (kind === 'rar' || kind === '7z') throw new SubtitleError('unsupported_archive');
  if (payload.kind === 'zip' || kind === 'zip') {
    let members: ZipMember[];
    try {
      members = (await d.unzip(bytesToBase64(payload.bytes))).map((m) => ({ name: m.name, bytes: base64ToBytes(m.base64) }));
    } catch {
      throw new SubtitleError('unsupported_archive');
    }
    // NATIVE_CONTRACT 39.1 S1: a member counts only when its decoded text holds a cue.
    const real = members.filter((m) => {
      const r = decodeSubtitleText(m.bytes, c.language);
      return r.ok ? hasSubtitleCues(r.text) : true; // unreadable text is reported as unreadable_text below
    });
    const pick = pickZipMember(real, { fileName: d.query.fileName, season: d.query.season, episode: d.query.episode, absoluteEpisode: d.query.absoluteEpisode });
    if (!pick.ok) throw new SubtitleError(pick.code);
    bytes = pick.member.bytes;
  }
  const prepared = prepareText(bytes, c.language);
  // NATIVE_CONTRACT 39.1 S1: once more on the final text, before anything is saved.
  if (!hasSubtitleCues(prepared.text)) throw new SubtitleError('unreadable_text');
  return {
    text: prepared.text,
    format: prepared.format,
    suggestedName: subtitleFileName(d.query.fileName, c.language, prepared.format, { hearingImpaired: c.hearingImpaired }),
  };
}
