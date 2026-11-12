/**
 * Streaming parser for OpenAI-compatible Chat Completions (SSE) with tool calls.
 * Pure: no React, no react-native, no network. SM-41 in docs/STATE_MACHINES_AND_SCREENS.md
 * is the law; design notes in docs/ASSISTANT_DESIGN.md §8.6.
 *
 * Usage: const p = createStreamParser(); events = p.push(chunk); ...; outcome = p.finish();
 * Chunks are strings. Decode bytes with a streaming TextDecoder so multi-byte UTF-8 is never split.
 */

/** SM-41 states. `toolCall` also exposes the index of the call being streamed (`toolIndex`). */
export type StreamState = 'idle' | 'text' | 'toolCall' | 'done' | 'error';

/**
 * `truncated`: the provider stopped on its length limit in the middle of a tool call. Never retry it as is.
 * `too_long`: the text or one call's arguments passed the accumulator cap (MAX_TEXT_CHARS, MAX_ARGS_CHARS).
 */
export type StreamErrorCode = 'provider' | 'bad_response' | 'bad_args' | 'incomplete' | 'truncated' | 'too_long';

/** Accumulated assistant text cap, in UTF-16 units (about 32 KB of text). */
export const MAX_TEXT_CHARS = 32 * 1024;
/** Cap for the argument JSON of one tool call. */
export const MAX_ARGS_CHARS = 16 * 1024;
/** Cap for the unparsed SSE line buffer (one line with no newline, or the lines of one open event). */
export const MAX_LINE_BUFFER_CHARS = 256 * 1024;
/** Cap for tool-call slots in one response. A real model sends 1 to 3. */
export const MAX_CALL_SLOTS = 16;
/** Longest error snippet kept from a provider error (never logged, never shown raw). */
export const MAX_DETAIL_CHARS = 500;

/** Message of an error the provider sent inside the stream, with no status. */
export const PROVIDER_STOPPED = 'The provider stopped mid-answer.';

/** A short single-line snippet of provider text for matching. Control characters go, spaces collapse. */
export function sanitizeSnippet(raw: unknown, max: number = MAX_DETAIL_CHARS): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Extra fields every streaming request body must carry so the provider sends a final `usage` chunk (R1-12).
 * Spread it into the request: `{ ...body, ...requestExtras() }`.
 */
export function requestExtras(): { stream_options: { include_usage: true } } {
  return { stream_options: { include_usage: true } };
}

/** Token counts reported by the provider. */
export interface StreamUsage {
  input: number;
  output: number;
}

export interface StreamFailure {
  code: StreamErrorCode;
  /** Plain-English message, safe to show in the chat. */
  message: string;
  /** HTTP-like status when the provider sent one inside the stream. */
  status?: number;
  /** A string error code the provider sent (Groq: "tool_use_failed"). Short, sanitised. */
  providerCode?: string;
  /** Sanitised snippet of the provider's error message (at most 500 chars). For matching only: never show it. */
  detail?: string;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      index: number;
      id?: string;
      name?: string;
      /** Characters of argument JSON received so far for this call. */
      argumentsLength: number;
    }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; error: StreamFailure };

export interface AssistantToolCall {
  id: string;
  name: string;
  /** Parsed JSON object. Empty arguments are read as `{}`. */
  arguments: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  toolCalls: AssistantToolCall[];
  finishReason: string | null;
  /** True when finish_reason was `length`. The turn machine must not retry on this. */
  truncated: boolean;
  /** Last usage the provider sent, or null when it sent none. */
  usage: StreamUsage | null;
}

/**
 * A failure carries `code` (same as `error.code`) for easy switching, and `truncated`, true when the
 * provider hit its length limit (so a retry would hit it again).
 */
export type FinishOutcome =
  | ({ ok: true } & StreamResult)
  | { ok: false; code: StreamErrorCode; error: StreamFailure; truncated: boolean };

export interface StreamParser {
  readonly state: StreamState;
  /** Index of the tool call being streamed while `state === 'toolCall'`, else null. */
  readonly toolIndex: number | null;
  push(chunk: string): StreamEvent[];
  finish(): FinishOutcome;
}

interface CallAccumulator {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

const BAD_RESPONSE: StreamFailure = {
  code: 'bad_response',
  message: 'Bad response from the provider.',
};

const TRUNCATED: StreamFailure = {
  code: 'truncated',
  message: 'The answer hit the length limit before it was finished.',
};

const TOO_LONG: StreamFailure = {
  code: 'too_long',
  message: 'The answer was too long to handle.',
};

const BAD_ARGS: StreamFailure = {
  code: 'bad_args',
  message: 'The assistant sent a tool request I could not read.',
};

/** Maps a provider error status to plain English (SM-31 copy). */
function providerFailure(status: number | undefined, err?: Record<string, unknown>): StreamFailure {
  let message = PROVIDER_STOPPED;
  if (status === 401 || status === 403) message = 'Check your key.';
  else if (status === 402) message = 'Out of credits.';
  else if (status === 429) message = 'Rate limited. Try again in a minute.';
  const f: StreamFailure = status === undefined ? { code: 'provider', message } : { code: 'provider', message, status };
  if (err) {
    if (typeof err.code === 'string' && status === undefined) {
      const c = sanitizeSnippet(err.code, 80);
      if (c !== '') f.providerCode = c;
    }
    const detail = sanitizeSnippet(err.message);
    if (detail !== '') f.detail = detail;
  }
  return f;
}

/** Accepts numeric or three-digit string codes, as providers send both. */
function asStatus(code: unknown): number | undefined {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/** Reads `usage` in the OpenAI shape (prompt/completion_tokens) or the Anthropic-style one (input/output_tokens). */
function readUsage(raw: unknown): StreamUsage | null {
  if (!isRecord(raw)) return null;
  const input = count(raw.prompt_tokens) ?? count(raw.input_tokens);
  const output = count(raw.completion_tokens) ?? count(raw.output_tokens);
  if (input === undefined && output === undefined) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

/** Creates one parser per response. Feed chunks in order, then call finish() once. */
export function createStreamParser(): StreamParser {
  let buffer = '';
  let dataLines: string[] = [];
  let dataChars = 0; // total length of dataLines, capped like the line buffer
  let state: StreamState = 'idle';
  let toolIndex: number | null = null;
  let text = '';
  const calls = new Map<number, CallAccumulator>();
  let finishReason: string | null = null;
  let usage: StreamUsage | null = null;
  let maxIndex = -1; // highest call index seen, so the next free index is O(1)
  let lastIndex: number | null = null; // the call most recently written to, for fragments with no index and no id
  let sawDone = false; // `data: [DONE]` seen; later data is ignored
  let failure: StreamFailure | null = null;
  let finished: FinishOutcome | null = null;

  function fail(f: StreamFailure, out: StreamEvent[]): void {
    if (failure) return;
    failure = f;
    state = 'error';
    toolIndex = null;
    out.push({ type: 'error', error: f });
  }

  /**
   * Which call a fragment belongs to. A numeric `index` is trusted. Without one (Gemini's compat layer
   * omits it; Ollama sends whole calls with no id), the rules are:
   *   - same id as an earlier call: that call;
   *   - a new id: a new call;
   *   - neither: the last call written to, unless this fragment names a function and that call
   *     already has a name (a second whole call in the same stream), which starts a new call.
   */
  function fragmentIndex(raw: unknown, id: string | undefined, name: string | undefined): number {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
    const next = (): number => maxIndex + 1;
    if (id !== undefined) {
      for (const c of calls.values()) if (c.id === id) return c.index;
      return next();
    }
    const last = lastIndex === null ? undefined : calls.get(lastIndex);
    if (!last) return next();
    if (name !== undefined && last.name !== undefined) return next();
    return last.index;
  }

  /** Handles one complete event payload (the `data:` lines of one SSE event, joined by \n). */
  function handleData(payload: string, out: StreamEvent[]): void {
    if (failure || sawDone) return;
    if (payload === '[DONE]') {
      sawDone = true;
      toolIndex = null;
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      fail(BAD_RESPONSE, out);
      return;
    }
    if (!isRecord(obj)) {
      fail(BAD_RESPONSE, out);
      return;
    }
    if (obj.error !== undefined) {
      const err = isRecord(obj.error) ? obj.error : {};
      fail(providerFailure(asStatus(err.code), err), out);
      return;
    }
    // Usage can ride on any chunk, including a final chunk with an empty `choices` array.
    const u = readUsage(obj.usage);
    if (u) {
      usage = u;
      out.push({ type: 'usage', input: u.input, output: u.output });
    }
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};

      // Fragments before finish_reason: a finish_reason in the same chunk must not drop them.
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (text.length + delta.content.length > MAX_TEXT_CHARS) {
          fail(TOO_LONG, out);
          return;
        }
        text += delta.content;
        state = 'text';
        toolIndex = null;
        out.push({ type: 'text', delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const frag of delta.tool_calls) {
          if (!isRecord(frag)) continue;
          const fn = isRecord(frag.function) ? frag.function : {};
          const fragId = typeof frag.id === 'string' && frag.id.length > 0 ? frag.id : undefined;
          const fragName = typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : undefined;
          const index = fragmentIndex(frag.index, fragId, fragName);
          let acc = calls.get(index);
          if (!acc) {
            if (calls.size >= MAX_CALL_SLOTS) {
              fail(TOO_LONG, out);
              return;
            }
            if (index > maxIndex) maxIndex = index;
            acc = { index, args: '' };
            calls.set(index, acc);
          }
          lastIndex = index;
          if (acc.id === undefined && fragId !== undefined) acc.id = fragId;
          if (acc.name === undefined && fragName !== undefined) acc.name = fragName;
          if (typeof fn.arguments === 'string') {
            if (acc.args.length + fn.arguments.length > MAX_ARGS_CHARS) {
              fail(TOO_LONG, out);
              return;
            }
            acc.args += fn.arguments;
          }
          state = 'toolCall';
          toolIndex = index;
          out.push({
            type: 'tool',
            index,
            ...(acc.id !== undefined ? { id: acc.id } : {}),
            ...(acc.name !== undefined ? { name: acc.name } : {}),
            argumentsLength: acc.args.length,
          });
        }
      }
      if (typeof choice.finish_reason === 'string') {
        // OpenRouter: a mid-stream failure arrives as finish_reason "error" (docs/streaming).
        if (choice.finish_reason === 'error') {
          fail(providerFailure(undefined), out);
          return;
        }
        finishReason = choice.finish_reason;
        state = 'done';
        toolIndex = null;
      }
    }
  }

  function dispatchEvent(out: StreamEvent[]): void {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    dataChars = 0;
    handleData(payload, out);
  }

  function handleLine(raw: string, out: StreamEvent[]): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      dispatchEvent(out);
      return;
    }
    if (line.startsWith(':')) return; // comment or keep-alive, e.g. ": OPENROUTER PROCESSING"
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return; // event:, id:, retry: are not used here
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
    dataChars += value.length + 1;
  }

  function consumeLines(out: StreamEvent[]): void {
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl), out);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }

  function push(chunk: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (finished || failure || sawDone) return out;
    buffer += chunk;
    consumeLines(out);
    if (!failure && !sawDone && (buffer.length > MAX_LINE_BUFFER_CHARS || dataChars > MAX_LINE_BUFFER_CHARS)) {
      buffer = '';
      dataLines = [];
      dataChars = 0;
      fail(TOO_LONG, out);
    }
    return out;
  }

  function resolve(): FinishOutcome {
    const lengthStop = finishReason === 'length';
    const failed = (error: StreamFailure): FinishOutcome => ({
      ok: false,
      code: error.code,
      error,
      truncated: lengthStop || error.code === 'truncated',
    });
    if (failure) return failed(failure);
    if (!sawDone && finishReason === null) {
      return failed({ code: 'incomplete', message: 'The answer was cut off.' });
    }
    const toolCalls: AssistantToolCall[] = [];
    const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
    const used = new Set(ordered.map((c) => c.id).filter((id): id is string => id !== undefined));
    let n = 0;
    for (const acc of ordered) {
      n += 1;
      const raw = acc.args.trim();
      let args: unknown = {};
      let parsed = true;
      if (raw !== '') {
        try {
          args = JSON.parse(raw);
        } catch {
          parsed = false;
        }
      }
      // A length stop inside a call is truncation, not a model mistake.
      if (lengthStop && (!parsed || !acc.name)) return failed(TRUNCATED);
      if (!acc.name) return failed(BAD_RESPONSE);
      if (!parsed || !isRecord(args)) return failed(BAD_ARGS);
      let id = acc.id;
      if (!id) {
        let k = n;
        while (used.has(`call_${k}`)) k += 1;
        id = `call_${k}`;
        used.add(id);
      }
      toolCalls.push({ id, name: acc.name, arguments: args });
    }
    return { ok: true, text, toolCalls, finishReason, truncated: lengthStop, usage };
  }

  function finish(): FinishOutcome {
    if (finished) return finished;
    const out: StreamEvent[] = [];
    if (!failure && !sawDone) {
      // Flush a final line that had no trailing newline, then any open event.
      if (buffer.length > 0) {
        handleLine(buffer, out);
        buffer = '';
      }
      dispatchEvent(out);
    }
    finished = resolve();
    if (!finished.ok) state = 'error';
    return finished;
  }

  return {
    get state() {
      return state;
    },
    get toolIndex() {
      return toolIndex;
    },
    push,
    finish,
  };
}
