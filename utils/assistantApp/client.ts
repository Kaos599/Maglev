// Provider HTTP client for the assistant (ASSISTANT_DESIGN §8.1, §8.2, §8.6, SM-31, SM-41).
// Sends one OpenAI-compatible streaming request and turns the response into SM-31 TurnEvents.
// No React, no react-native, no `expo/fetch` import: the fetch is injected (useAssistantChat.ts passes expo/fetch),
// so Node tests run this file with a fake.

import { chatCompletionsUrl, type PresetId } from '../prefs/assistant.ts';
import { createStreamParser, requestExtras } from '../assistant/sse.ts';
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

export function createStreamFn(
  fetchImpl: FetchLike,
  opts: { timers?: ClientTimers; firstByteMs?: number; now?: () => number } = {},
): StreamFn {
  const timers: ClientTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const firstByteMs = opts.firstByteMs ?? FIRST_BYTE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  return async function stream(params, onEvent, signal) {
    if (signal.aborted) return;
    const inner = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => inner.abort();
    signal.addEventListener('abort', onOuterAbort);
    let timer: unknown = timers.setTimeout(() => {
      timedOut = true;
      inner.abort();
    }, firstByteMs);
    const stopTimer = () => {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    };
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
        stopTimer();
        try {
          await res.body?.getReader().cancel?.();
        } catch {
          // The body is not needed.
        }
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
        emit({ type: 'HttpErr', status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
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
      const firstByte = () => {
        if (gotFirstByte) return;
        gotFirstByte = true;
        stopTimer();
        emit({ type: 'FirstByte' });
      };

      try {
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            firstByte();
            feed(decoder.decode(value, { stream: true }));
          }
          feed(decoder.decode());
        } else if (res.text) {
          const all = await res.text();
          if (all.length > 0) firstByte();
          feed(all);
        }
      } catch {
        netFailure();
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
