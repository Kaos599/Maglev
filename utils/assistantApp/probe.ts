/**
 * "Test model" probe (docs/ASSISTANT_DESIGN.md 8.3, SM-40).
 * One small non-streaming chat-completions request with one trivial tool. The reply tells the screen whether
 * the provider accepts the key and whether the model answers with a well-formed tool call.
 * Pure TypeScript: no React, no expo. `fetch` is injected so Node tests can fake it. The key is only ever
 * placed in the Authorization header of this one request; it is never logged or returned.
 */
import { chatCompletionsUrl } from '../prefs/assistant.ts';

export interface ProbeInput {
  baseUrl: string;
  model: string;
  /** May be empty for the custom (Ollama) preset: no Authorization header is sent then. */
  key: string;
  preset: string;
}

/** The two providerMachine events the probe can produce. Dispatch the result as it is. */
export type ProbeEvent =
  | { type: 'PROBE_OK'; toolCallsWork: boolean }
  | { type: 'PROBE_ERR'; status: number | 'net' | 'timeout' };

/** How long one probe may take before it counts as a timeout. */
export const PROBE_TIMEOUT_MS = 30_000;

export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const PING_TOOL = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Reports that the tool call worked.',
    parameters: {
      type: 'object',
      properties: { ok: { type: 'boolean', description: 'Always true.' } },
      required: ['ok'],
    },
  },
};

export function buildProbeBody(model: string): string {
  return JSON.stringify({
    model,
    stream: false,
    messages: [
      { role: 'system', content: 'You are a connection test. Answer by calling a tool.' },
      { role: 'user', content: 'Call the ping tool with ok set to true.' },
    ],
    tools: [PING_TOOL],
    // "auto", never a forced tool: some providers return 400 for a forced tool_choice (design 8.2).
    tool_choice: 'auto',
  });
}

/** True when the reply has at least one tool call with a name and arguments that parse as a JSON object. */
export function hasWellFormedToolCall(json: unknown): boolean {
  const choices = (json as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const calls = (choices[0] as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return false;
  return calls.every((c) => {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name) return false;
    if (typeof fn.arguments !== 'string') return false;
    try {
      const args = JSON.parse(fn.arguments);
      return !!args && typeof args === 'object' && !Array.isArray(args);
    } catch {
      return false;
    }
  });
}

// A 400 or 404 that talks about tools means "this model has no tool support", not "wrong key" or "no such model".
const NO_TOOLS = /\btools?\b|function[ _-]?calling/i;

/**
 * Runs the probe. Resolves with a providerMachine event, or `null` when the caller aborted `signal`
 * (the screen moved on, so there is nothing to report). Never throws.
 */
export async function probeModel(
  input: ProbeInput,
  fetchImpl: ProbeFetch,
  signal?: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeEvent | null> {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (input.key) headers.Authorization = `Bearer ${input.key}`;
    const res = await fetchImpl(chatCompletionsUrl(input.baseUrl), {
      method: 'POST',
      headers,
      body: buildProbeBody(input.model),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      if ((res.status === 400 || res.status === 404) && NO_TOOLS.test(text)) return { type: 'PROBE_OK', toolCallsWork: false };
      return { type: 'PROBE_ERR', status: res.status };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // A 200 that is not JSON is not an OpenAI-style server (wrong address, a login page).
      return { type: 'PROBE_ERR', status: 400 };
    }
    // OpenRouter and some gateways report failures as 200 with an `error` object.
    const err = (json as { error?: { code?: unknown; message?: unknown } })?.error;
    if (err && typeof err === 'object') {
      const code = Number(err.code);
      const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
      if ((status === 400 || status === 404) && NO_TOOLS.test(String(err.message ?? ''))) {
        return { type: 'PROBE_OK', toolCallsWork: false };
      }
      return { type: 'PROBE_ERR', status };
    }
    return { type: 'PROBE_OK', toolCallsWork: hasWellFormedToolCall(json) };
  } catch {
    if (signal?.aborted && !timedOut) return null;
    return { type: 'PROBE_ERR', status: timedOut ? 'timeout' : 'net' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
