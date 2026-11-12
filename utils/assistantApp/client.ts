// Provider HTTP client for the assistant (ASSISTANT_DESIGN §8.1, §8.2, §8.6, SM-31, SM-41).
// Sends one OpenAI-compatible streaming request and turns the response into SM-31 TurnEvents.
// No React, no react-native, no `expo/fetch` import: the fetch is injected (useAssistantChat.ts passes expo/fetch),
// so Node tests run this file with a fake.

import { chatCompletionsUrl, type PresetId } from '../prefs/assistant.ts';
import { MAX_DETAIL_CHARS, createStreamParser, requestExtras, sanitizeSnippet } from '../assistant/sse.ts';
import type { RequestEffect, TurnEvent } from '../assistant/turnMachine.ts';

/** The small part of the WinterCG fetch this client uses. expo/fetch fits it. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(reason?: unknown): Promise<void> | void } } | null;
  text?(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface StreamParams {
  request: RequestEffect;
  presetId: PresetId;
  baseUrl: string;
  model: string;
  /** Null for a local server that needs no key. */
  apiKey: string | null;
}

/** Runs one request and reports TurnEvents through `onEvent`. Resolves when the stream is over. Never rejects. */
export type StreamFn = (params: StreamParams, onEvent: (event: TurnEvent) => void, signal: AbortSignal) => Promise<void>;

/** SM-31 / §8.6: abort when nothing arrives for this long. */
export const FIRST_BYTE_TIMEOUT_MS = 20_000;
/** Abort a stream that goes quiet for this long after the first byte (SSE comments count as bytes). */
export const IDLE_TIMEOUT_MS = 45_000;
/** An error body is read only up to this many bytes. It is matched against, never shown. */
const ERROR_BODY_MAX_BYTES = 8 * 1024;

/**
 * Providers whose docs (§8.2) list parallel_tool_calls as a request parameter. Groq is left out: its gpt-oss
 * models "support tools but not parallel tool use" and may refuse the field. Gemini's compat page and Ollama
 * do not list it. The turn machine caps calls per round-trip in code, so omitting it is safe.
 */
const SENDS_PARALLEL_FLAG: ReadonlySet<PresetId> = new Set<PresetId>(['openrouter', 'openai', 'anthropic']);

/** Gemini's compat layer and Ollama document `max_tokens`. The others take `max_completion_tokens` (§8.4). */
const USES_MAX_TOKENS: ReadonlySet<PresetId> = new Set<PresetId>(['gemini', 'custom']);

export function buildRequestBody(p: StreamParams): Record<string, unknown> {
  const r = p.request;
  const body: Record<string, unknown> = {
    model: p.model,
    messages: r.messages,
    tools: r.tools,
    tool_choice: r.toolChoice,
    stream: true,
    ...requestExtras(),
  };
  body[USES_MAX_TOKENS.has(p.presetId) ? 'max_tokens' : 'max_completion_tokens'] = r.maxCompletionTokens;
  if (SENDS_PARALLEL_FLAG.has(p.presetId)) body.parallel_tool_calls = r.parallelToolCalls;
  return body;
}

export function buildHeaders(p: StreamParams): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  // §8.2 lists no extra headers for any preset. OpenRouter's attribution headers are optional and would
  // identify the app, so they are not sent.
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  return headers;
}

/** Retry-After: seconds ("5") or an HTTP date. Returns milliseconds, or undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - now);
}

export interface ClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The status inside a JSON error: a number, or a three-digit string. */
function codeToStatus(code: unknown): number | undefined {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

/**
 * Reads at most ERROR_BODY_MAX_BYTES of a response body and returns it as a short sanitised snippet. Never throws.
 * The text is only matched against (see turnMachine.statusStep). It is never logged or shown.
 */
async function readSnippet(res: FetchLikeResponse, signal: AbortSignal): Promise<string> {
  const raw = await readBody(res, signal);
  return sanitizeSnippet(raw, MAX_DETAIL_CHARS);
}

async function readBody(res: FetchLikeResponse, signal: AbortSignal): Promise<string> {
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let out = '';
      let bytes = 0;
      const aborted = new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      while (bytes < ERROR_BODY_MAX_BYTES) {
        const r = await Promise.race([reader.read(), aborted]);
        if (r === null || r.done) break;
        if (!r.value) continue;
        bytes += r.value.byteLength;
        out += decoder.decode(r.value, { stream: true });
      }
      try {
        await reader.cancel?.();
      } catch {
        // Nothing more is needed from the body.
      }
      return out;
    }
    if (res.text) return (await res.text()).slice(0, ERROR_BODY_MAX_BYTES);
  } catch {
    // An unreadable body is the same as no body.
  }
  return '';
}

/** `{error:{message,code}}` from a JSON error body, as the status and snippet an HttpErr carries. */
function jsonError(raw: string): { status: number; body: string } | null {
  try {
    const v = JSON.parse(raw) as { error?: unknown };
    const e = v && typeof v === 'object' ? v.error : undefined;
    if (e === undefined || e === null) return null;
    const err = (typeof e === 'object' ? e : { message: String(e) }) as { message?: unknown; code?: unknown; type?: unknown };
    const status = codeToStatus(err.code) ?? 400;
    const parts = [err.message, typeof err.code === 'string' ? err.code : '', err.type].filter((x) => typeof x === 'string');
    return { status, body: sanitizeSnippet(parts.join(' ')) };
  } catch {
    return null;
  }
}

export function createStreamFn(
  fetchImpl: FetchLike,
  opts: { timers?: ClientTimers; firstByteMs?: number; idleMs?: number; now?: () => number } = {},
): StreamFn {
  const timers: ClientTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const firstByteMs = opts.firstByteMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  return async function stream(params, onEvent, signal) {
    if (signal.aborted) return;
    const inner = new AbortController();
    let timedOut = false;
    let idled = false;
    const onOuterAbort = () => inner.abort();
    signal.addEventListener('abort', onOuterAbort);
    let timer: unknown;
    const stopTimer = () => {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    };
    /** One watchdog: the first-byte limit until a byte arrives, then the idle limit, restarted on every chunk. */
    const arm = (ms: number, onFire: () => void) => {
      stopTimer();
      timer = timers.setTimeout(() => {
        onFire();
        inner.abort();
      }, ms);
    };
    arm(firstByteMs, () => {
      timedOut = true;
    });
    let gotFirstByte = false;

    const emit = (e: TurnEvent) => {
      if (!signal.aborted) onEvent(e);
    };
    /** A transport failure: quiet when the caller aborted, NetErr before the first byte, a cut-off stream after. */
    const netFailure = () => {
      if (signal.aborted) return;
      if (!gotFirstByte || timedOut) emit({ type: 'NetErr' });
      else emit({ type: 'StreamFailed', error: { code: 'incomplete', message: 'The answer was cut off.' } });
    };

    try {
      let res: FetchLikeResponse;
      try {
        res = await fetchImpl(chatCompletionsUrl(params.baseUrl), {
          method: 'POST',
          headers: buildHeaders(params),
          body: JSON.stringify(buildRequestBody(params)),
          signal: inner.signal,
        });
      } catch {
        netFailure();
        return;
      }
      if (!res.ok) {
        // The first-byte timer keeps running while the error body is read, so a stalled body cannot hang the turn.
        const snippet = await readSnippet(res, inner.signal);
        stopTimer();
        if (signal.aborted) return;
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
        emit({
          type: 'HttpErr',
          status: res.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(snippet !== '' ? { body: snippet } : {}),
        });
        return;
      }

      // A 200 that is not an event stream: a JSON error body, or a captive portal's web page.
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('text/html')) {
        stopTimer();
        try {
          await res.body?.getReader().cancel?.();
        } catch {
          // The page is not needed.
        }
        emit({ type: 'PortalErr' });
        return;
      }
      if (contentType.includes('application/json')) {
        const raw = await readBody(res, inner.signal);
        stopTimer();
        if (signal.aborted) return;
        const err = jsonError(raw);
        emit(err ? { type: 'HttpErr', status: err.status, ...(err.body !== '' ? { body: err.body } : {}) } : { type: 'HttpErr', status: 400 });
        return;
      }

      const parser = createStreamParser();
      const decoder = new TextDecoder();
      const feed = (chunk: string) => {
        for (const ev of parser.push(chunk)) {
          if (ev.type === 'text') emit({ type: 'TextDelta', text: ev.delta });
          else if (ev.type === 'usage') {
            emit({ type: 'Usage', input: ev.input, output: ev.output });
          }
          // 'tool' progress and 'error' events are not needed here: finish() reports both.
        }
      };
      const onIdle = () => {
        idled = true;
      };
      const firstByte = () => {
        if (gotFirstByte) return;
        gotFirstByte = true;
        emit({ type: 'FirstByte' });
      };

      try {
        if (res.body) {
          const reader = res.body.getReader();
          // A reader that ignores the abort signal must not keep the turn waiting, so the read races it.
          const aborted = new Promise<null>((resolve) => {
            if (inner.signal.aborted) resolve(null);
            else inner.signal.addEventListener('abort', () => resolve(null), { once: true });
          });
          while (true) {
            const r = await Promise.race([reader.read(), aborted]);
            if (r === null) {
              try {
                await reader.cancel?.();
              } catch {
                // Already closed.
              }
              throw new Error('aborted');
            }
            if (r.done) break;
            const value = r.value;
            if (!value || value.byteLength === 0) continue;
            firstByte();
            arm(idleMs, onIdle);
            feed(decoder.decode(value, { stream: true }));
          }
          stopTimer();
          feed(decoder.decode());
        } else if (res.text) {
          const all = await res.text();
          stopTimer();
          if (all.length > 0) firstByte();
          feed(all);
        }
      } catch {
        if (signal.aborted) return;
        // Quiet for too long after the stream started: a cut-off answer, which the turn retries once.
        if (idled) emit({ type: 'StreamFailed', error: { code: 'incomplete', message: 'The answer was cut off.' } });
        else netFailure();
        return;
      }
      if (signal.aborted) return;
      // An empty body: the stream never started. Count it as first byte so the turn can hear the failure.
      firstByte();

      const out = parser.finish();
      if (!out.ok) {
        emit({ type: 'StreamFailed', error: out.error, truncated: out.truncated });
        return;
      }
      if (out.toolCalls.length > 0) emit({ type: 'ToolCallsDone', calls: out.toolCalls, truncated: out.truncated });
      else emit({ type: 'Stop', truncated: out.truncated });
    } finally {
      stopTimer();
      signal.removeEventListener('abort', onOuterAbort);
    }
  };
}
