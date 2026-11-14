/**
 * One list check (docs/NATIVE_CONTRACT.md section 31.3). Pure: every outside thing (fetch, signature check, network
 * facts, stored serial, applying) comes in through `ListDeps`, so Node tests run it with fakes.
 * The request carries no cookies and no identifiers: no custom headers, `credentials: 'omit'`.
 */
import { parseSourcesFile, type SourcesFile } from './schema.ts';
import {
  adListAllowed,
  netVerdict,
  serialDecision,
  type AdResult,
  type FailedWhy,
  type ListsEvent,
  type ListsNet,
  type ListsState,
  type NetRules,
  type SourcesResult,
} from './machine.ts';

export const SOURCES_URL = 'https://harshdayal.dev/maglev/lists/sources.json';
export const SIGNATURE_URL = `${SOURCES_URL}.sig`;
export const FETCH_TIMEOUT_MS = 15_000;
/** The signature is a short base64 string; anything bigger is not one. */
const SIG_MAX_CHARS = 1024;

export type TextFetch = (
  url: string,
  init: { signal?: AbortSignal; credentials?: 'omit' | 'same-origin' | 'include' },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ListFetchError extends Error {
  readonly why: 'network' | 'http';
  constructor(why: 'network' | 'http') {
    super(why);
    this.why = why;
  }
}

async function getText(fetchImpl: TextFetch, url: string, timeoutMs: number, maxChars: number): Promise<string> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: controller?.signal, credentials: 'omit' });
    } catch {
      throw new ListFetchError('network');
    }
    if (!res.ok) throw new ListFetchError('http');
    try {
      const text = await res.text();
      // Too big to be the file: the same outcome as a bad file, so the caller's size check rejects it.
      return text.length > maxChars ? text.slice(0, maxChars + 1) : text;
    } catch {
      throw new ListFetchError('network');
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetches the file and its signature together. Throws [ListFetchError]. */
export async function fetchSources(fetchImpl: TextFetch, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<{ body: string; sig: string }> {
  const [body, sig] = await Promise.all([
    getText(fetchImpl, SOURCES_URL, timeoutMs, 512 * 1024),
    getText(fetchImpl, SIGNATURE_URL, timeoutMs, SIG_MAX_CHARS),
  ]);
  return { body, sig: sig.trim() };
}

/** How many provider entries differ between two files (added, removed or changed). */
export function countChangedSources(prev: SourcesFile | null, next: SourcesFile): number {
  const a = prev?.sources ?? {};
  const b = next.sources;
  let n = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[id] ?? null) !== JSON.stringify(b[id] ?? null)) n++;
  }
  return n;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The file's `blocklistUrls` become the default list address. They replace the user's addresses only when those
 * still equal the previous default; a list the user chose is kept. Returns the new addresses, or null for no change.
 */
export function nextBlocklistUrls(userUrls: readonly string[], previousDefault: readonly string[], fileUrls: readonly string[] | undefined): string[] | null {
  if (!fileUrls || fileUrls.length === 0) return null;
  if (!sameList(userUrls, previousDefault)) return null;
  return sameList(userUrls, fileUrls) ? null : fileUrls.slice();
}

export interface AdUpdateOutcome {
  ok: boolean;
  code?: string;
  domains?: number;
  changed?: boolean;
}

export interface ListDeps {
  now(): number;
  fetch: TextFetch;
  verify(body: string, sigB64: string): Promise<boolean>;
  /** Provider ids the file may describe. */
  known: ReadonlySet<string>;
  net(): Promise<ListsNet | null>;
  rules(): NetRules;
  appliedSerial(): number;
  /** Stores and applies a verified file with a higher serial; returns how many sources changed. */
  apply(file: SourcesFile): number;
  /** Runs the ad list update with the user's current addresses. */
  updateAdList(conditional: boolean): Promise<AdUpdateOutcome>;
  dispatch(e: ListsEvent): ListsState;
  /** A check (either half) is already running. */
  isBusy(): boolean;
  /** Called once when the check starts, to move the 24 h gate. */
  markChecked(at: number): void;
}

export function adResultOf(o: AdUpdateOutcome): AdResult {
  if (o.ok) return o.changed === false ? { kind: 'notModified' } : { kind: 'updated', domains: o.domains ?? 0 };
  switch (o.code) {
    case 'BLOCKED':
      return { kind: 'failed', why: 'blocked' };
    case 'HTTP_STATUS':
      return { kind: 'failed', why: 'http' };
    case 'LIST_INVALID':
    case 'LIST_TOO_LARGE':
      return { kind: 'failed', why: 'invalid' };
    default:
      return { kind: 'failed', why: 'network' };
  }
}

async function checkSourcesHalf(d: ListDeps): Promise<SourcesResult> {
  let got: { body: string; sig: string };
  try {
    got = await fetchSources(d.fetch);
  } catch (e) {
    return { kind: 'failed', why: e instanceof ListFetchError ? e.why : 'network' };
  }
  d.dispatch({ type: 'fetched' });
  let signed = false;
  try {
    signed = await d.verify(got.body, got.sig);
  } catch {
    signed = false;
  }
  if (!signed) return { kind: 'rejected', why: 'signature' };
  const parsed = parseSourcesFile(got.body, d.known);
  if (!parsed.ok) return { kind: 'rejected', why: 'schema' };
  const decision = serialDecision(parsed.file.serial, d.appliedSerial());
  if (decision === 'rollback') return { kind: 'rejected', why: 'serial' };
  if (decision === 'unchanged') return { kind: 'unchanged' };
  return { kind: 'applied', changed: d.apply(parsed.file) };
}

/**
 * Runs a check: the source file first, then the ad list. `manual` is "Check now": it ignores the 24 h gate (the
 * caller's job) and allows a metered link for the ad list. Returns false when a check was already running.
 */
export async function runListCheck(d: ListDeps, opts: { manual: boolean }): Promise<boolean> {
  if (d.isBusy()) return false;
  d.dispatch({ type: 'start' });
  d.markChecked(d.now());
  const net = await d.net();
  const verdict = netVerdict(net, d.rules());
  if (verdict !== 'ok') {
    const why: FailedWhy = verdict;
    d.dispatch({ type: 'sourcesResult', result: { kind: 'failed', why } });
    if (opts.manual) {
      d.dispatch({ type: 'adStart' });
      d.dispatch({ type: 'adResult', result: { kind: 'failed', why } });
    }
    return true;
  }
  d.dispatch({ type: 'sourcesResult', result: await checkSourcesHalf(d) });
  if (adListAllowed(net, d.rules(), opts.manual)) {
    d.dispatch({ type: 'adStart' });
    let outcome: AdUpdateOutcome;
    try {
      outcome = await d.updateAdList(true);
    } catch {
      outcome = { ok: false, code: 'NETWORK' };
    }
    d.dispatch({ type: 'adResult', result: adResultOf(outcome) });
  } else {
    d.dispatch({ type: 'adResult', result: { kind: 'skipped' } });
  }
  return true;
}
