// Context builder for the assistant (SM-31, ASSISTANT_DESIGN §8.4, build step 10).
// Decides which chat messages go to the model on each request. Pure TypeScript: no React, no IO.
// Chat history lives in memory only (SM-42), so this module never persists anything.
//
// Rules, in order of what is kept:
//   1. The system message and the newest user message always survive.
//   2. An assistant message with tool_calls and its tool results are one unit. Providers reject orphans,
//      so a unit is kept whole or dropped whole. Incomplete units in the input are dropped.
//   3. Tool results longer than MAX_TOOL_RESULT_TOKENS are truncated with a note.
//   4. Tool results from earlier turns are replaced by an app-written digest (R1-11), always: handles,
//      labels and numbers only, at most 300 characters, every string through sanitizeText. This keeps old
//      (possibly hostile) text out of the prompt, as §7.3 layer "segregate by turn" asks, and it keeps
//      "r1" meaning the same result when the user says "yes" in a later turn.
//      The digest stays the tool message content, so the assistant/tool_calls pairing stays valid.
//   5. If the request is still over budget, whole old turns are dropped, oldest first.
//   6. If it is still over budget, tool results in the newest turn are summarised, oldest first.
//   7. The tool definitions are sent with every request, so their estimated cost is taken off the budget
//      first (`toolsTokens`, default: the cost of TOOLS).
//   8. If the system message plus the newest user message cannot fit, buildContext throws a RangeError.
//      The caller must cap the user's text (QUERY_MAX and friends) so this does not happen.

import { TOOLS } from './tools.ts';
import { sanitizeText } from './sanitize.ts';

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
export const MAX_COMPLETION_TOKENS = 2048; // R1-12: reasoning models spend part of this on thinking
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

/** Longest digest of one tool result (R1-11). */
export const MAX_DIGEST_CHARS = 300;

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, kana, CJK symbols, ideographs
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo extended A
    (cp >= 0xac00 && cp <= 0xd7ff) || // Hangul syllables, Jamo extended B
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xffef) || // half- and full-width forms
    (cp >= 0x0e00 && cp <= 0x0eff) || // Thai, Lao
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    cp >= 0x10000 // astral: emoji, rare ideographs
  );
}

function isMidWidthCodePoint(cp: number): boolean {
  // Cyrillic, Greek, Armenian, Hebrew, Arabic, Indic scripts: roughly half a token per character.
  return (cp >= 0x0370 && cp <= 0x08ff) || (cp >= 0x0900 && cp <= 0x0dff) || (cp >= 0x0f00 && cp <= 0x109f);
}

/**
 * Cheap token estimate. Latin text counts characters / 4. CJK, Hangul, kana, Thai and other wide scripts
 * (and emoji) count about 1 token per character, other non-Latin scripts about 1/2. Rounded up.
 * This is an ESTIMATE: real tokenisers vary by model. Replace it with the provider's `usage` figures
 * when they are available.
 */
export function estimateTokens(text: string): number {
  // Fast path: Latin text (ASCII through Latin Extended / combining marks) is chars / 4.
  if (/^[\u0000-\u036f]*$/.test(text)) return Math.ceil(text.length / 4);
  let quarters = 0; // work in quarter-tokens so the sum stays an integer
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    quarters += isWideCodePoint(cp) ? 4 : isMidWidthCodePoint(cp) ? 2 : 1;
  }
  return Math.ceil(quarters / 4);
}

let toolsTokensCache: number | null = null;
/** Estimated cost of the tool definitions, which ride along with every request. */
export function toolsTokenEstimate(): number {
  if (toolsTokensCache === null) toolsTokensCache = estimateTokens(JSON.stringify(TOOLS));
  return toolsTokensCache;
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
  /** Estimated tokens of `messages` plus `toolsTokens`. Always <= budget when no error is thrown. */
  tokens: number;
  /** The tool-definition cost that was subtracted from the budget. */
  toolsTokens: number;
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
 * @param budget   Token budget for the whole request: messages plus tool definitions (see DEFAULT_INPUT_BUDGET).
 * @param toolsTokens Estimated cost of the tool definitions. Default: toolsTokenEstimate() (the cost of TOOLS).
 *                 Pass 0 when the request carries no tools.
 * @throws RangeError if the budget is not a non-negative number, or if the system message and the
 *         newest user message cannot fit inside it.
 */
export function buildContext(
  system: string,
  history: readonly ChatMessage[],
  budget: number = DEFAULT_INPUT_BUDGET,
  toolsTokens: number = toolsTokenEstimate(),
): ContextResult {
  if (!(budget >= 0) || !Number.isFinite(budget)) {
    throw new RangeError(`budget must be a finite non-negative number, got ${budget}`);
  }

  if (!(toolsTokens >= 0) || !Number.isFinite(toolsTokens)) {
    throw new RangeError(`toolsTokens must be a finite non-negative number, got ${toolsTokens}`);
  }

  const systemMsg: ChatMessage = { role: 'system', content: system };
  const systemTokens = messageTokens(systemMsg) + toolsTokens;

  const { messages: units, dropped: unitDropped } = keepCompleteUnits(history);

  // Group into turns. A turn starts at each user message. Messages before the first user form turn 0.
  const slots: Slot[] = [];
  let turn = -1;
  for (const msg of units) {
    if (msg.role === 'user' || turn < 0) turn += 1;
    slots.push({ msg, turn, touched: false });
  }
  const newestTurn = turn;

  // Which tool produced each result, so the digest knows what it is reading.
  const toolNameById = new Map<string, string>();
  for (const s of slots) {
    if (s.msg.role === 'assistant') for (const c of s.msg.tool_calls ?? []) toolNameById.set(c.id, c.function.name);
  }
  const digestOf = (s: Slot): string =>
    s.msg.role === 'tool' ? digestToolResult(toolNameById.get(s.msg.tool_call_id) ?? 'tool', s.msg.content) : '';

  // Keep the last MAX_HISTORY_TURNS turns. The newest turn is always kept.
  let dropped = unitDropped;
  const firstKeptTurn = newestTurn - MAX_HISTORY_TURNS + 1;
  const turnKept = slots.filter((s) => s.turn >= firstKeptTurn);
  dropped += slots.length - turnKept.length;
  let live: Slot[] = turnKept;

  // Tool results from earlier turns become a digest (built from the full result, before any truncation).
  // Results in the newest turn are only truncated when oversized.
  const originalContent = new Map<Slot, string>();
  for (const s of live) if (s.msg.role === 'tool') originalContent.set(s, s.msg.content);
  for (const s of live) {
    if (s.msg.role !== 'tool') continue;
    if (s.turn < newestTurn) setToolContent(s, digestOf(s));
    else {
      const next = truncateIfLarge(s.msg.content);
      if (next !== s.msg.content) setToolContent(s, next);
    }
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

  // Still over budget: digest tool results in the newest turn, oldest first. The digest is built from the
  // original content, because truncation may already have cut the JSON.
  for (const s of live) {
    if (total() <= budget) break;
    if (s.msg.role === 'tool' && s.turn === newestTurn) {
      const d = digestToolResult(toolNameById.get(s.msg.tool_call_id) ?? 'tool', originalContent.get(s) ?? s.msg.content);
      if (s.msg.content !== d && d.length < s.msg.content.length) setToolContent(s, d);
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
  return { messages, summarised, dropped, tokens, toolsTokens };
}

// ---- helpers --------------------------------------------------------------------------------

function setToolContent(s: Slot, content: string): void {
  if (s.msg.role !== 'tool' || s.msg.content === content) return;
  s.msg = { ...s.msg, content };
  s.touched = true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toolOk(content: string): boolean {
  try {
    const v: unknown = JSON.parse(content);
    return isRecord(v) && v.ok === true;
  } catch {
    return false;
  }
}

/**
 * Return content unchanged if it fits MAX_TOOL_RESULT_TOKENS; otherwise a valid JSON object with a head.
 * Tokens are estimated per script, so CJK text is cut much shorter than Latin text.
 */
function truncateIfLarge(content: string): string {
  if (estimateTokens(content) <= MAX_TOOL_RESULT_TOKENS) return content;
  const ok = toolOk(content);
  const cps = Array.from(content);
  let n = Math.min(cps.length, MAX_TOOL_RESULT_TOKENS * 4);
  for (;;) {
    const out = JSON.stringify({ ok, truncated: true, head: cps.slice(0, n).join('') });
    if (estimateTokens(out) <= MAX_TOOL_RESULT_TOKENS || n === 0) return out;
    // Escapes and wide characters make the JSON cost more than the slice, so shrink and try again.
    n = Math.floor(n * 0.85);
  }
}

// ---- digest (R1-11) ---------------------------------------------------------------------------

const LABEL_KEYS = ['label', 'source', 'resolution', 'codec', 'hdr', 'state', 'status', 'fit', 'verdict', 'kind'] as const;
const SHARING_KEYS = ['seeders', 'sharing'] as const;
const ROW_LIST_KEYS = ['results', 'transfers', 'files', 'items', 'rows'] as const;
const ROW_HANDLE_KEYS = ['id', 'handle', 'result_id', 'transfer_id', 'file_id'] as const;
const HANDLE_LIKE = /^[rtfc][1-9][0-9]{0,8}$/;
/** A label is short and made of plain characters. Anything else is left out of the digest. */
const LABEL_LIKE = /^[A-Za-z0-9][A-Za-z0-9 .+\-_/]{0,23}$/;

function safeLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = sanitizeText(v, 24);
  return LABEL_LIKE.test(t) ? t : null;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) < 10 ? n.toFixed(1) : String(Math.round(n));
}

function fmtGb(gb: number): string {
  return gb >= 1 ? `${fmtNum(gb)} GB` : `${Math.round(gb * 1000)} MB`;
}

function rowDigest(row: unknown): string {
  if (!isRecord(row)) return '';
  const parts: string[] = [];
  for (const k of ROW_HANDLE_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && HANDLE_LIKE.test(v)) {
      parts.push(v);
      break;
    }
  }
  for (const k of LABEL_KEYS) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v) && k === 'resolution') parts.push(`${fmtNum(v)}p`);
    else {
      const t = safeLabel(v);
      if (t !== null) parts.push(t);
    }
  }
  const gb = row.size_gb ?? row.sizeGb;
  const bytes = row.size_bytes ?? row.sizeBytes ?? row.total_bytes;
  if (typeof gb === 'number' && Number.isFinite(gb) && gb >= 0) parts.push(fmtGb(gb));
  else if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) parts.push(fmtGb(bytes / 1e9));
  for (const k of SHARING_KEYS) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      parts.push(`${fmtNum(v)} sharing`);
      break;
    }
  }
  const p = row.progress;
  if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) parts.push(`${Math.round(p * 100)}%`);
  return parts.join(' ');
}

function cutAtEntry(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - 1; // one character for the ellipsis
  const at = text.lastIndexOf('; ', room);
  return (at > 0 ? text.slice(0, at) : text.slice(0, room)) + '…';
}

/**
 * App-written digest of one tool result, kept in later turns instead of the raw JSON (R1-11).
 * Example for a search: `r1 WEB-DL 1080p x265 2.1 GB 340 sharing; r2 ...`.
 * Only handles (r1, t2), short labels and numbers are used, never names, paths or free text, and every string
 * goes through sanitizeText. At most MAX_DIGEST_CHARS characters. Rows are read from `data.results`,
 * `data.transfers`, `data.files`, `data.items` or `data.rows` (or `data` itself when it is a list);
 * a result without rows gets its top-level numbers and flags.
 */
export function digestToolResult(toolName: string, resultJson: string): string {
  const name = safeLabel(toolName) ?? 'tool';
  let v: unknown;
  try {
    v = JSON.parse(resultJson);
  } catch {
    return cutAtEntry(`${name}: unreadable result`, MAX_DIGEST_CHARS);
  }
  if (!isRecord(v)) return cutAtEntry(`${name}: unreadable result`, MAX_DIGEST_CHARS);
  if (v.ok === false) {
    const err = isRecord(v.error) ? safeLabel(v.error.code) : null;
    return cutAtEntry(err ? `${name} failed: ${err}` : `${name} failed`, MAX_DIGEST_CHARS);
  }
  const data = v.data !== undefined ? v.data : v;
  let rows: unknown[] | null = Array.isArray(data) ? data : null;
  if (!rows && isRecord(data)) {
    for (const k of ROW_LIST_KEYS) {
      if (Array.isArray(data[k])) {
        rows = data[k] as unknown[];
        break;
      }
    }
  }
  if (rows) {
    const entries = rows.map(rowDigest).filter((e) => e !== '');
    if (entries.length === 0) return cutAtEntry(`${name}: ${rows.length} item(s)`, MAX_DIGEST_CHARS);
    return cutAtEntry(entries.join('; '), MAX_DIGEST_CHARS);
  }
  const pairs: string[] = [];
  if (isRecord(data)) {
    for (const [k, val] of Object.entries(data)) {
      if (pairs.length >= 8) break;
      const key = sanitizeText(k, 24);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(key)) continue;
      if (typeof val === 'number' && Number.isFinite(val)) pairs.push(`${key} ${fmtNum(val)}`);
      else if (typeof val === 'boolean') pairs.push(`${key} ${val ? 'yes' : 'no'}`);
    }
  }
  return cutAtEntry(pairs.length > 0 ? `${name}: ${pairs.join(', ')}` : `${name} ok`, MAX_DIGEST_CHARS);
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
