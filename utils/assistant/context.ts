// Context builder for the assistant (SM-31, ASSISTANT_DESIGN §8.4, build step 10).
// Decides which chat messages go to the model on each request. Pure TypeScript: no React, no IO.
// Chat history lives in memory only (SM-42), so this module never persists anything.
//
// Rules, in order of what is kept:
//   1. The system message and the newest user message always survive.
//   2. An assistant message with tool_calls and its tool results are one unit. Providers reject orphans,
//      so a unit is kept whole or dropped whole. Incomplete units in the input are dropped.
//   3. Tool results longer than MAX_TOOL_RESULT_TOKENS are truncated with a note.
//   4. Tool results from earlier turns are replaced by a one-line summary, always. This keeps old
//      (possibly hostile) text out of the prompt, as §7.3 layer "segregate by turn" asks.
//   5. If the request is still over budget, whole old turns are dropped, oldest first.
//   6. If it is still over budget, tool results in the newest turn are summarised, oldest first.
//   7. If the system message plus the newest user message cannot fit, buildContext throws a RangeError.
//      The caller must cap the user's text (QUERY_MAX and friends) so this does not happen.

/** A tool call the model made. OpenAI chat format. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One chat message in the OpenAI chat format. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

// ---- Caps (SM-31 and ASSISTANT_DESIGN §8.4) ---------------------------------------------------

/** Model round-trips per user turn (SM-31). */
export const MAX_ROUND_TRIPS = 6;
/** Tool calls per user turn (SM-31). */
export const MAX_TOOL_CALLS_PER_TURN = 8;
/** Tool calls per round-trip (SM-31). */
export const MAX_TOOL_CALLS_PER_ROUND_TRIP = 3;
/** `max_completion_tokens` per round-trip (§8.4). */
export const MAX_COMPLETION_TOKENS = 600;
/** Each tool result, after truncation (§8.4). */
export const MAX_TOOL_RESULT_TOKENS = 1500;
/**
 * Turns kept in the request, the current one included (§8.4 says "last ~6 turns").
 * Older turns are dropped even when the budget has room, so the request stays small.
 */
export const MAX_HISTORY_TURNS = 6;
/** Input budget for the messages of one request (§8.4 "Request cap 12,000 input tokens"). */
export const DEFAULT_INPUT_BUDGET = 12000;
/**
 * Per-message cost for role and framing. Chosen here; the design gives no number.
 * Providers add a few tokens per message. This is a rough allowance, not an exact count.
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Content that replaces a tool result from an earlier turn, or one that was cut for budget. */
export const SUMMARY_OK = '{"ok":true,"summarised":true}';
export const SUMMARY_FAILED = '{"ok":false,"summarised":true}';

/**
 * Cheap token estimate: characters divided by 4, rounded up.
 * This is an ESTIMATE. Real tokenisers vary by model and by language (non-Latin text often costs more
 * per character). Replace it with the provider's `usage` figures when they are available.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated cost of one message, including MESSAGE_OVERHEAD_TOKENS. Used for every budget decision. */
export function messageTokens(m: ChatMessage): number {
  let n = MESSAGE_OVERHEAD_TOKENS;
  if (m.role === 'assistant') {
    n += estimateTokens(m.content ?? '');
    if (m.tool_calls && m.tool_calls.length > 0) n += estimateTokens(JSON.stringify(m.tool_calls));
  } else if (m.role === 'tool') {
    n += estimateTokens(m.content) + estimateTokens(m.tool_call_id);
  } else {
    n += estimateTokens(m.content);
  }
  return n;
}

/** Result of buildContext. */
export interface ContextResult {
  /** Messages to send, system message first. */
  messages: ChatMessage[];
  /** Messages whose content was replaced: tool results summarised or truncated. */
  summarised: number;
  /** Messages removed: whole turns dropped, plus unpaired or incomplete tool units in the input. */
  dropped: number;
  /** Estimated tokens of `messages`. Always <= budget when no error is thrown. */
  tokens: number;
}

interface Slot {
  msg: ChatMessage;
  turn: number;
  touched: boolean;
}

/**
 * Build the messages for one request.
 * @param system   The system prompt, sent as the first message.
 * @param history  Earlier messages in order (user, assistant, tool). A system message here is ignored.
 * @param budget   Token budget for all messages together (see DEFAULT_INPUT_BUDGET).
 * @throws RangeError if the budget is not a non-negative number, or if the system message and the
 *         newest user message cannot fit inside it.
 */
export function buildContext(
  system: string,
  history: readonly ChatMessage[],
  budget: number = DEFAULT_INPUT_BUDGET,
): ContextResult {
  if (!(budget >= 0) || !Number.isFinite(budget)) {
    throw new RangeError(`budget must be a finite non-negative number, got ${budget}`);
  }

  const systemMsg: ChatMessage = { role: 'system', content: system };
  const systemTokens = messageTokens(systemMsg);

  const { messages: units, dropped: unitDropped } = keepCompleteUnits(history);

  // Group into turns. A turn starts at each user message. Messages before the first user form turn 0.
  const slots: Slot[] = [];
  let turn = -1;
  for (const msg of units) {
    if (msg.role === 'user' || turn < 0) turn += 1;
    slots.push({ msg, turn, touched: false });
  }
  const newestTurn = turn;

  // Keep the last MAX_HISTORY_TURNS turns. The newest turn is always kept.
  let dropped = unitDropped;
  const firstKeptTurn = newestTurn - MAX_HISTORY_TURNS + 1;
  const turnKept = slots.filter((s) => s.turn >= firstKeptTurn);
  dropped += slots.length - turnKept.length;
  let live: Slot[] = turnKept;

  // Truncate oversized tool results, then summarise tool results from earlier turns.
  for (const s of live) {
    if (s.msg.role !== 'tool') continue;
    const next = truncateIfLarge(s.msg.content);
    if (next !== s.msg.content) setToolContent(s, next);
  }
  for (const s of live) {
    if (s.msg.role !== 'tool' || s.turn >= newestTurn) continue;
    setToolContent(s, summaryFor(s.msg.content));
  }

  const total = (): number => systemTokens + live.reduce((sum, s) => sum + messageTokens(s.msg), 0);

  // Drop whole old turns, oldest first.
  while (total() > budget) {
    const oldest = live.reduce((min, s) => (s.turn < min ? s.turn : min), Infinity);
    if (!(oldest < newestTurn)) break;
    const before = live.length;
    live = live.filter((s) => s.turn !== oldest);
    dropped += before - live.length;
  }

  // Still over budget: summarise tool results in the newest turn, oldest first.
  for (const s of live) {
    if (total() <= budget) break;
    if (s.msg.role === 'tool' && s.turn === newestTurn && s.msg.content !== summaryFor(s.msg.content)) {
      setToolContent(s, summaryFor(s.msg.content));
    }
  }

  const tokens = total();
  if (tokens > budget) {
    throw new RangeError(
      `system and newest user message need ${tokens} tokens, budget is ${budget}`,
    );
  }

  const messages: ChatMessage[] = [systemMsg, ...live.map((s) => s.msg)];
  const summarised = live.filter((s) => s.touched).length;
  return { messages, summarised, dropped, tokens };
}

// ---- helpers --------------------------------------------------------------------------------

function setToolContent(s: Slot, content: string): void {
  if (s.msg.role !== 'tool' || s.msg.content === content) return;
  s.msg = { ...s.msg, content };
  s.touched = true;
}

/** The summary for a tool result: `{"ok":…,"summarised":true}`. ok is true only when the input says so. */
function summaryFor(content: string): string {
  return toolOk(content) ? SUMMARY_OK : SUMMARY_FAILED;
}

function toolOk(content: string): boolean {
  try {
    const v: unknown = JSON.parse(content);
    return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** Return content unchanged if it fits MAX_TOOL_RESULT_TOKENS; otherwise a valid JSON object with a head. */
function truncateIfLarge(content: string): string {
  if (estimateTokens(content) <= MAX_TOOL_RESULT_TOKENS) return content;
  const maxChars = MAX_TOOL_RESULT_TOKENS * 4;
  const ok = toolOk(content);
  let n = Math.max(0, maxChars - 100);
  for (;;) {
    const out = JSON.stringify({ ok, truncated: true, head: content.slice(0, n) });
    if (out.length <= maxChars || n === 0) return out;
    // Escapes can make the JSON longer than the slice, so shrink by the excess and try again.
    n = Math.max(0, n - Math.max(1, Math.ceil((out.length - maxChars) / 2)));
  }
}

/**
 * Remove history that a provider would reject: tool results with no assistant tool_calls before them,
 * assistant tool_calls whose results are missing or extra, and stray system messages.
 * Returns the cleaned list and the number of messages removed.
 */
function keepCompleteUnits(history: readonly ChatMessage[]): { messages: ChatMessage[]; dropped: number } {
  const out: ChatMessage[] = [];
  let dropped = 0;
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') j += 1;
      const results = history.slice(i + 1, j);
      const ids = m.tool_calls.map((c) => c.id);
      const byId = new Map<string, ChatMessage>();
      for (const r of results) {
        if (r.role === 'tool' && !byId.has(r.tool_call_id)) byId.set(r.tool_call_id, r);
      }
      const complete =
        new Set(ids).size === ids.length && results.length === ids.length && ids.every((id) => byId.has(id));
      if (complete) {
        out.push(m, ...ids.map((id) => byId.get(id) as ChatMessage));
      } else {
        dropped += 1 + results.length;
      }
      i = j;
      continue;
    }
    if (m.role === 'tool' || m.role === 'system') {
      dropped += 1;
    } else {
      out.push(m);
    }
    i += 1;
  }
  return { messages: out, dropped };
}
