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

export type StreamErrorCode = 'provider' | 'bad_response' | 'bad_args' | 'incomplete';

export interface StreamFailure {
  code: StreamErrorCode;
  /** Plain-English message, safe to show in the chat. */
  message: string;
  /** HTTP-like status when the provider sent one inside the stream. */
  status?: number;
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
  truncated: boolean;
}

export type FinishOutcome = ({ ok: true } & StreamResult) | { ok: false; error: StreamFailure };

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

const BAD_ARGS: StreamFailure = {
  code: 'bad_args',
  message: 'The assistant sent a tool request I could not read.',
};

/** Maps a provider error status to plain English (SM-31 copy). */
function providerFailure(status: number | undefined): StreamFailure {
  let message = 'The provider stopped mid-answer.';
  if (status === 401 || status === 403) message = 'Check your key.';
  else if (status === 402) message = 'Out of credits.';
  else if (status === 429) message = 'Rate limited. Try again in a minute.';
  return status === undefined ? { code: 'provider', message } : { code: 'provider', message, status };
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

/** Creates one parser per response. Feed chunks in order, then call finish() once. */
export function createStreamParser(): StreamParser {
  let buffer = '';
  let dataLines: string[] = [];
  let state: StreamState = 'idle';
  let toolIndex: number | null = null;
  let text = '';
  const calls = new Map<number, CallAccumulator>();
  let finishReason: string | null = null;
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
      fail(providerFailure(asStatus(err.code)), out);
      return;
    }
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};

      // Fragments before finish_reason: a finish_reason in the same chunk must not drop them.
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        state = 'text';
        toolIndex = null;
        out.push({ type: 'text', delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const frag of delta.tool_calls) {
          if (!isRecord(frag) || typeof frag.index !== 'number') continue;
          let acc = calls.get(frag.index);
          if (!acc) {
            acc = { index: frag.index, args: '' };
            calls.set(frag.index, acc);
          }
          if (acc.id === undefined && typeof frag.id === 'string' && frag.id.length > 0) acc.id = frag.id;
          const fn = isRecord(frag.function) ? frag.function : {};
          if (acc.name === undefined && typeof fn.name === 'string' && fn.name.length > 0) acc.name = fn.name;
          if (typeof fn.arguments === 'string') acc.args += fn.arguments;
          state = 'toolCall';
          toolIndex = frag.index;
          out.push({
            type: 'tool',
            index: frag.index,
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
    return out;
  }

  function resolve(): FinishOutcome {
    if (failure) return { ok: false, error: failure };
    if (!sawDone && finishReason === null) {
      return { ok: false, error: { code: 'incomplete', message: 'The answer was cut off.' } };
    }
    const toolCalls: AssistantToolCall[] = [];
    const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
    for (const acc of ordered) {
      if (!acc.id || !acc.name) return { ok: false, error: BAD_RESPONSE };
      const raw = acc.args.trim();
      let args: unknown = {};
      if (raw !== '') {
        try {
          args = JSON.parse(raw);
        } catch {
          return { ok: false, error: BAD_ARGS };
        }
      }
      if (!isRecord(args)) return { ok: false, error: BAD_ARGS };
      toolCalls.push({ id: acc.id, name: acc.name, arguments: args });
    }
    return { ok: true, text, toolCalls, finishReason, truncated: finishReason === 'length' };
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
