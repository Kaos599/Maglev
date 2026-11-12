// SM-31 Assistant chat turn. Pure: no React, no IO, no clock. app/assistant.tsx (the runner) runs the effects.
// One user message is one turn: Send, then up to 6 model round-trips, then idle or awaitingConfirmation.
// Anything not in the transition table is a no-op. Never add states.
//
// Interpretations the table leaves open (review round 1, ASSISTANT_DESIGN R1-3..R1-6):
//  - A proposal tool call creates a card and answers the model `{"status":"proposed","card_id":"c1"}`. The turn
//    then continues as the table says (ToolsDone -> requesting) so the model can say "I've put it on a card",
//    and ends at awaitingConfirmation through the `Stop` row (pending cards > 0).
//  - cardMachine is the only owner of card state. Confirm and Dismiss work in every turn state and only emit
//    `confirmCard` / `dismissCard`; the runner drives cardMachine and reports back with `CardSettled`. A card stays
//    in `pendingCards` until it is done, dismissed or expired (a failed card stays: it can be retried).
//  - Cards expire only on Clear, Disabled (key removed or Assistant off), TargetGone, or a newer card for the same
//    target. A new Send never expires cards.
//  - When a round has no read tools, there is nothing for the runner to wait for, so ToolsDone is applied in the
//    same step (the transient runningTools state is skipped).
//  - Caps per turn: 6 round-trips, 8 tool calls, 3 per round-trip, 2 proposal cards, 1 destructive card,
//    2 get_result_details. No read tool runs in the last allowed round. The retry budget (1) is per turn.
//  - Abort, Stop, Background, Clear and Disabled in runningTools emit `cancelTools` and answer the pending calls
//    `{ok:false,error:"cancelled"}`. `ToolTimeout` (the runner fires it after 60 s) answers one call the same way.

import {
  MAX_COMPLETION_TOKENS,
  MAX_ROUND_TRIPS,
  MAX_TOOL_CALLS_PER_ROUND_TRIP,
  MAX_TOOL_CALLS_PER_TURN,
  buildContext,
  type ChatMessage,
  type ToolCall,
} from './context.ts';
import type { HandleRegistry } from './handles.ts';
import { USER_TEXT_MAX, sanitizeText, truncate } from './sanitize.ts';
import { PROVIDER_STOPPED, sanitizeSnippet, type AssistantToolCall, type StreamFailure } from './sse.ts';
import { PROPOSAL_TOOLS, READ_TOOLS, TOOLS, validateArgs, type ToolDef } from './tools.ts';

export type TurnKind = 'idle' | 'requesting' | 'streaming' | 'runningTools' | 'awaitingConfirmation';

/** Fixed copy (SM-31 and the design). */
export const COPY = {
  notEnabled: 'Turn on the Assistant in Settings first.',
  noWarning: 'Read the Assistant notice in Settings first.',
  noKey: 'Add an API key in Settings → Assistant.',
  // `{provider}` is filled with the provider's name by the chat controller when it shows the error.
  checkKey: "{provider} didn't accept your key. Sign in again in Settings → Assistant.",
  noCredits: 'Your {provider} account is out of credit. Add credit on their site, or pick a free model in Settings.',
  rateLimited: 'Rate limited. Try again in a minute.',
  rateLimitedLong: "You've hit this model's limit for now. Try again later, or pick another model.",
  noTools: "This model can't use Maglev's tools. Pick another model in Settings → Assistant.",
  modelGone: "That model isn't available any more. Pick another in Settings → Assistant.",
  tooMuch: 'That was too much for this model. Clear the chat or ask a shorter question.',
  toolBroken: 'The model sent a broken request. Try again.',
  portal: "Couldn't reach the AI service. If you're on public Wi-Fi, open your browser to sign in to it.",
  noAnswer: "The model didn't answer. Try again.",
  stoppedAway: 'Stopped when you left Maglev.',
  stopped: "I hit my limit for one question. Here's what I found. Ask me to keep going.",
  answerTooLong: 'The answer was too long. Ask a narrower question.',
  oneDelete: 'Only one delete per question. Ask again after this one.',
  tooManyProposals: 'That is enough proposals for one question. Ask again after these.',
  tooManyDetails: 'I already looked at two results. Ask again to see more.',
  outOfSteps: 'No steps left for this question.',
  cancelled: 'cancelled',
  toolTimeout: 'That took too long.',
  tooLong: 'That message is too long. Try a shorter one.',
  network: "Couldn't reach the provider. Check your connection.",
  providerDown: 'The provider is having trouble. Try again later.',
  rejected: 'The AI service refused this message. Try again, or pick another model in Settings.',
  providerStopped: PROVIDER_STOPPED,
  toolMissing: 'The tool did not return a result.',
} as const;

export interface TurnConfig {
  /** System prompt sent as the first message of every request. */
  system: string;
  /** Session handle registry (SM-42). Used to validate and resolve tool arguments. */
  registry: HandleRegistry;
  /** Input token budget for buildContext. Default: the context.ts default. */
  budget?: number;
}

interface PendingCall {
  id: string;
  name: string;
  /** Final tool message content, or undefined while a read tool is still running. */
  content?: string;
}

export interface TurnState {
  kind: TurnKind;
  config: TurnConfig;
  /** Chat history sent to the model (no system message). */
  history: ChatMessage[];
  /** Model round-trips started in this turn (retries do not count). */
  rounds: number;
  /** Tool calls accepted in this turn. */
  toolCalls: number;
  /** True once this turn used its one retry (the budget is per turn, not per request). */
  retried: boolean;
  /** Proposal cards, destructive cards and get_result_details calls accepted in this turn. */
  proposals: number;
  destructive: number;
  details: number;
  /** Text streamed so far in the current round-trip. */
  streamText: string;
  /** Cards created and not yet done, dismissed or expired. */
  pendingCards: string[];
  /** Target handle of each pending card (a result or transfer id), for "newer card for the same target". */
  cardTargets: Record<string, string>;
  /** propose_plan cards: every handle a step acts on. The plan expires when any of them is gone. */
  planTargets: Record<string, string[]>;
  /** Last usage the provider reported in the current round-trip, added once when it ends. */
  usage: { input: number; output: number } | null;
  /**
   * Short sanitised lines about cards the user settled (confirmed, dismissed, failed), newest last, at most
   * MAX_CARD_FACTS. The next Send puts them in front of the user's message for the model, once, then clears them.
   */
  cardFacts: string[];
  /** Calls of the current round-trip (runningTools only). */
  calls: PendingCall[];
  /** True when calls were dropped by a cap in this round-trip. */
  capHit: boolean;
}

export interface RequestEffect {
  type: 'request';
  messages: ChatMessage[];
  tools: ToolDef[];
  maxCompletionTokens: number;
  toolChoice: 'auto';
  parallelToolCalls: false;
  /** 1-based round-trip number within the turn. */
  round: number;
}

export type TurnEffect =
  | { type: 'appendUser'; text: string }
  | RequestEffect
  | { type: 'showNotice'; text: string }
  | { type: 'errorCard'; message: string }
  /** The runner waits `delayMs` (plus up to ~250 ms of jitter when `jitter`), then sends `request` again. */
  | { type: 'retryOnce'; request: RequestEffect; discardPartial: boolean; delayMs: number; jitter: boolean }
  | { type: 'abortFetch' }
  /** Stop the running read tools. `callIds` names one call (timeout); absent means all of them. */
  | { type: 'cancelTools'; callIds?: string[] }
  /** `background`: the app left the foreground (not the Stop button). */
  | { type: 'markCancelled'; background?: boolean }
  | { type: 'appendText'; text: string }
  | { type: 'runTool'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'createCard'; cardId: string; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'appendToolMessage'; toolCallId: string; content: string }
  | { type: 'note'; text: string }
  /** Runner: drive cardMachine CONFIRM for this card. Reports back with CardSettled. */
  | { type: 'confirmCard'; cardId: string }
  /** Runner: drive cardMachine DISMISS for this card. Reports back with CardSettled. */
  | { type: 'dismissCard'; cardId: string }
  /** Runner: drive cardMachine EXPIRE for one card (target gone, or a newer card for the same target). */
  /** `replaced`: a newer card for the same target took its place (the card says so; an action in flight is not interrupted). */
  | { type: 'expireCard'; cardId: string; replaced?: true }
  | { type: 'expireCards' }
  | { type: 'addUsage'; input: number; output: number }
  | { type: 'clearHandles' }
  /** Retry: the controller removes the old error item before the request goes out again. */
  | { type: 'dropError' };

export type CardSettledKind = 'done' | 'dismissed' | 'expired' | 'failed';

export type TurnEvent =
  /** `display`: what the chat bubble shows when it differs from what the model gets ("Ask about this"). */
  | { type: 'Send'; text: string; display?: string; enabled: boolean; warningAccepted: boolean; hasKey: boolean }
  /**
   * Re-run the last turn after an error: the same user message, no new bubble, a fresh retry budget. Whatever the
   * failed turn added after that message (partial text, tool results) is dropped. Same gate as Send.
   */
  | { type: 'Retry'; enabled: boolean; warningAccepted: boolean; hasKey: boolean }
  | { type: 'FirstByte' }
  /**
   * `retryAfterMs` is the parsed Retry-After header, when the provider sent one. `body` is a short sanitised
   * snippet of the error body (at most 500 chars). It is only matched against, never logged or shown.
   */
  | { type: 'HttpErr'; status: number; retryAfterMs?: number; body?: string }
  /** A 200 that is a web page (captive portal), not the provider's stream. */
  | { type: 'PortalErr' }
  | { type: 'NetErr' }
  /** A stream that failed after it started. `truncated` is true when it ended with finish_reason "length". */
  | { type: 'StreamFailed'; error: StreamFailure; truncated?: boolean }
  | { type: 'Abort' }
  /** The app went to the background (SM-42). Same as Abort for the turn. */
  | { type: 'Background' }
  | { type: 'TextDelta'; text: string }
  | { type: 'Usage'; input: number; output: number }
  | { type: 'ToolCallsDone'; calls: AssistantToolCall[]; truncated?: boolean }
  | { type: 'Stop'; truncated?: boolean }
  | { type: 'ToolsDone'; results: { toolCallId: string; content: string }[] }
  /** The runner fires this 60 s after a read tool started and it has not finished. */
  | { type: 'ToolTimeout'; toolCallId: string }
  | { type: 'Confirm'; cardId: string }
  | { type: 'Dismiss'; cardId: string }
  /** cardMachine reached a final-ish state. done, dismissed and expired leave pendingCards; failed stays. */
  | { type: 'CardSettled'; cardId: string; kind: CardSettledKind; /** What the model should know next turn, e.g. "User confirmed c2: Added." */ note?: string }
  /** The transfer or result a card points at is gone (handle, e.g. "t1"). */
  | { type: 'TargetGone'; target: string }
  /** SM-42 CLEAR and KEY_REMOVED. */
  | { type: 'Clear' }
  /** The Assistant switch was turned off. Cards expire, history stays. */
  | { type: 'Disabled' };

export interface TurnStep {
  state: TurnState;
  effects: TurnEffect[];
}

export function turnInitial(config: TurnConfig): TurnState {
  return {
    kind: 'idle',
    config,
    history: [],
    rounds: 0,
    toolCalls: 0,
    retried: false,
    proposals: 0,
    destructive: 0,
    details: 0,
    streamText: '',
    pendingCards: [],
    cardTargets: {},
    planTargets: {},
    usage: null,
    cardFacts: [],
    calls: [],
    capHit: false,
  };
}

/** Proposal tools that remove something from the user's device. At most one per turn. */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['propose_delete', 'propose_remove_files']);
export const MAX_PROPOSALS_PER_TURN = 2;
export const MAX_DESTRUCTIVE_PER_TURN = 1;
export const MAX_DETAILS_PER_TURN = 2;
/** Card facts kept for the next message, and the length of one. */
export const MAX_CARD_FACTS = 6;
export const CARD_FACT_MAX = 200;
/** Retry delay when the provider sends no Retry-After. The runner adds jitter. */
export const RETRY_DELAY_MS = 1000;
/** A Retry-After longer than this is not waited for. */
export const RETRY_AFTER_MAX_MS = 30_000;

// ---- helpers ------------------------------------------------------------------------------------

function restKind(s: TurnState): TurnKind {
  return s.pendingCards.length > 0 ? 'awaitingConfirmation' : 'idle';
}

/** Builds the request for the current history. Throws RangeError like buildContext. */
function buildRequest(s: TurnState, round: number): RequestEffect {
  const ctx = buildContext(s.config.system, s.history, s.config.budget);
  return {
    type: 'request',
    messages: ctx.messages,
    tools: TOOLS,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    toolChoice: 'auto',
    parallelToolCalls: false,
    round,
  };
}

/** Ends the turn with a plain error. The history keeps what it had; pending cards stay. */
function failTurn(s: TurnState, message: string, extra: TurnEffect[] = []): TurnStep {
  const next: TurnState = { ...s, streamText: '', calls: [], capHit: false };
  return { state: { ...next, kind: restKind(next) }, effects: [...extra, { type: 'errorCard', message }] };
}

function toolError(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}

const NO_TOOLS_RE = /\btools?\b|function[ _-]?calling/i;
const TOO_MUCH_RE = /context[ _-]?(length|window)|too (long|large|many)|token limit|max(imum)?\b.*\btokens\b|\btokens\b.*\b(exceed|limit)/i;
const TOOL_USE_FAILED_RE = /tool_use_failed/i;
/** A Retry-After longer than this on a 429 means "later", not "in a moment". */
export const RATE_LIMIT_SHORT_MS = 60_000;

function statusStep(s: TurnState, status: number, retryAfterMs?: number, body?: string): TurnStep {
  const text = sanitizeSnippet(body);
  if (status === 401 || status === 403) return failTurn(s, COPY.checkKey);
  if (status === 402) return failTurn(s, COPY.noCredits);
  if (status === 429) {
    const short = retryAfterMs !== undefined && retryAfterMs <= RATE_LIMIT_SHORT_MS;
    return failTurn(s, short ? COPY.rateLimited : COPY.rateLimitedLong);
  }
  if (status >= 500) return retryStep(s, COPY.providerDown, retryAfterMs);
  // Other 4xx: the model's own malformed call is retried once, then the body decides the wording.
  if (TOOL_USE_FAILED_RE.test(text)) return retryStep(s, COPY.toolBroken);
  if (status === 413 || TOO_MUCH_RE.test(text)) return failTurn(s, COPY.tooMuch);
  if (NO_TOOLS_RE.test(text)) return failTurn(s, COPY.noTools);
  if (status === 404 || /model.{0,40}(not found|does not exist|not available|unavailable)/i.test(text)) {
    return failTurn(s, COPY.modelGone);
  }
  return failTurn(s, COPY.rejected);
}

/** SM-31: one retry per turn, on network/5xx only. Otherwise the error card. */
function retryStep(s: TurnState, finalMessage: string, retryAfterMs?: number): TurnStep {
  if (s.retried) return failTurn(s, finalMessage);
  if (retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_MAX_MS) return failTurn(s, finalMessage);
  let request: RequestEffect;
  try {
    request = buildRequest(s, s.rounds);
  } catch {
    return failTurn(s, COPY.tooLong);
  }
  const hasAfter = retryAfterMs !== undefined && retryAfterMs >= 0;
  return {
    state: { ...s, kind: 'requesting', retried: true, streamText: '' },
    effects: [
      {
        type: 'retryOnce',
        request,
        discardPartial: s.kind === 'streaming',
        delayMs: hasAfter ? (retryAfterMs as number) : RETRY_DELAY_MS,
        jitter: !hasAfter,
      },
    ],
  };
}

/** Starts the next round-trip from `s` (history already holds everything to send). */
function startRequest(s: TurnState, pre: TurnEffect[]): TurnStep {
  const round = s.rounds + 1;
  let request: RequestEffect;
  try {
    request = buildRequest(s, round);
  } catch (e) {
    if (e instanceof RangeError) return failTurn(s, COPY.tooLong, pre);
    throw e;
  }
  return {
    state: { ...s, kind: 'requesting', rounds: round, streamText: '', calls: [], capHit: false },
    effects: [...pre, request],
  };
}

/** The assistant text of a finished round-trip goes into history. */
function withAssistantText(s: TurnState): ChatMessage[] {
  return s.streamText ? [...s.history, { role: 'assistant', content: s.streamText }] : s.history;
}

function endTurn(s: TurnState, history: ChatMessage[], effects: TurnEffect[]): TurnStep {
  const next: TurnState = { ...s, history, streamText: '', calls: [], capHit: false };
  return { state: { ...next, kind: restKind(next) }, effects };
}

/** The card's target handle ("t1", "r2") from the model's own arguments. Plans have none. */
function targetOf(args: Record<string, unknown>): string | undefined {
  if (typeof args.transfer_id === 'string') return args.transfer_id;
  if (typeof args.result_id === 'string') return args.result_id;
  return undefined;
}

/** Every handle the steps of a plan act on, once each. */
function planTargetsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const steps = Array.isArray(args.steps) ? args.steps : [];
  for (const st of steps) {
    const a = (st as { args?: unknown } | null)?.args;
    if (a && typeof a === 'object') {
      const t = targetOf(a as Record<string, unknown>);
      if (t !== undefined && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ---- ToolsDone ------------------------------------------------------------------------------------

function toolsDone(s: TurnState, results: { toolCallId: string; content: string }[]): TurnStep {
  const byId = new Map(results.map((r) => [r.toolCallId, r.content]));
  const messages: ChatMessage[] = [];
  const effects: TurnEffect[] = [];
  for (const c of s.calls) {
    const content = c.content ?? byId.get(c.id) ?? toolError(COPY.toolMissing);
    messages.push({ role: 'tool', tool_call_id: c.id, content });
    effects.push({ type: 'appendToolMessage', toolCallId: c.id, content });
  }
  const history = [...s.history, ...messages];
  const capped = s.capHit || s.rounds >= MAX_ROUND_TRIPS;
  if (capped) {
    return endTurn(s, history, [...effects, { type: 'note', text: COPY.stopped }]);
  }
  return startRequest({ ...s, history }, effects);
}

function toolCallsDone(s: TurnState, calls: AssistantToolCall[], truncated: boolean): TurnStep {
  // A call cut off by the length limit has partial arguments. Never run it.
  if (truncated) return truncatedStep(s);
  if (calls.length === 0) return stopStep(s, false);

  const allowed = Math.max(0, Math.min(MAX_TOOL_CALLS_PER_ROUND_TRIP, MAX_TOOL_CALLS_PER_TURN - s.toolCalls));
  const used = calls.slice(0, allowed);
  const capHit = calls.length > used.length;

  if (used.length === 0) {
    // Nothing may run any more. Keep the text, end the turn with the note.
    return endTurn(s, withAssistantText(s), [{ type: 'note', text: COPY.stopped }]);
  }

  // The last allowed round: the model cannot use what a read tool returns, so none runs.
  const lastRound = s.rounds >= MAX_ROUND_TRIPS;

  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const pending: PendingCall[] = [];
  const effects: TurnEffect[] = [];
  const pendingCards = [...s.pendingCards];
  const cardTargets = { ...s.cardTargets };
  const planTargets = { ...s.planTargets };
  let proposals = s.proposals;
  let destructive = s.destructive;
  let details = s.details;

  used.forEach((call, i) => {
    const id = seen.has(call.id) ? `${call.id}-${i}` : call.id;
    seen.add(id);
    // Provider extras (Gemini 3 thought signature) go back unchanged; they can never replace our own fields.
    toolCalls.push({ ...call.extra, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } } as ToolCall);
    const entry: PendingCall = { id, name: call.name };
    pending.push(entry);

    const v = validateArgs(call.name, call.arguments, s.config.registry);
    if (!v.ok) {
      entry.content = toolError(v.error.message);
      return;
    }
    if (READ_TOOLS.has(call.name)) {
      if (lastRound) {
        entry.content = toolError(COPY.outOfSteps);
        return;
      }
      if (call.name === 'get_result_details') {
        if (details >= MAX_DETAILS_PER_TURN) {
          entry.content = toolError(COPY.tooManyDetails);
          return;
        }
        details += 1;
      }
      effects.push({ type: 'runTool', callId: id, name: call.name, args: v.args });
      return;
    }
    if (PROPOSAL_TOOLS.has(call.name)) {
      const isDestructive = DESTRUCTIVE_TOOLS.has(call.name);
      if (isDestructive && destructive >= MAX_DESTRUCTIVE_PER_TURN) {
        entry.content = toolError(COPY.oneDelete);
        return;
      }
      if (proposals >= MAX_PROPOSALS_PER_TURN) {
        entry.content = toolError(COPY.tooManyProposals);
        return;
      }
      proposals += 1;
      if (isDestructive) destructive += 1;
      const cardId = s.config.registry.issue('card', `${s.history.length}:${id}`);
      const target = targetOf(call.arguments);
      if (target !== undefined) {
        // A newer card for the same target replaces the older one. The older card leaves pendingCards only when it
        // reaches a final state (CardSettled): one that is confirming or executing cannot be expired at once, and
        // must keep working Dismiss and Retry if its action then fails.
        for (const old of pendingCards) {
          if (cardTargets[old] === target) effects.push({ type: 'expireCard', cardId: old, replaced: true });
        }
        cardTargets[cardId] = target;
      }
      const planned = call.name === 'propose_plan' ? planTargetsOf(call.arguments) : [];
      if (planned.length > 0) planTargets[cardId] = planned;
      pendingCards.push(cardId);
      effects.push({ type: 'createCard', cardId, callId: id, tool: call.name, args: v.args });
      entry.content = JSON.stringify({ status: 'proposed', card_id: cardId });
      return;
    }
    entry.content = toolError('There is no tool with that name.');
  });

  const assistant: ChatMessage = { role: 'assistant', content: s.streamText || null, tool_calls: toolCalls };
  const next: TurnState = {
    ...s,
    kind: 'runningTools',
    history: [...s.history, assistant],
    toolCalls: s.toolCalls + used.length,
    proposals,
    destructive,
    details,
    pendingCards,
    cardTargets,
    planTargets,
    calls: pending,
    capHit,
    streamText: '',
  };
  // No read tool to wait for: apply ToolsDone now.
  if (!effects.some((e) => e.type === 'runTool')) {
    const done = toolsDone(next, []);
    return { state: done.state, effects: [...effects, ...done.effects] };
  }
  return { state: next, effects };
}

function stopStep(s: TurnState, truncated: boolean): TurnStep {
  if (truncated) return truncatedStep(s);
  const silent = s.streamText === '' && s.pendingCards.length === 0 && !saidSomething(s);
  const step = endTurn(s, withAssistantText(s), []);
  // A stop with no text and no tool calls would show nothing. A card or earlier text already answered.
  if (silent) return { state: step.state, effects: [{ type: 'errorCard', message: COPY.noAnswer }] };
  return step;
}

/** True when the model already wrote text in an earlier round-trip of this turn. */
function saidSomething(s: TurnState): boolean {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if (m.role === 'user') return false;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content !== '') return true;
  }
  return false;
}

/** finish_reason "length": never retried. Keep what arrived and tell the user. */
function truncatedStep(s: TurnState): TurnStep {
  return endTurn(s, withAssistantText(s), [{ type: 'note', text: COPY.answerTooLong }]);
}

// ---- reducer ----------------------------------------------------------------------------------------

const MAX_USAGE_TOKENS = 10_000_000;

/** One token count: finite, whole, between 0 and 10 million. Anything else counts as 0. */
function clampTokens(n: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_USAGE_TOKENS, Math.max(0, Math.floor(n))) : 0;
}

function clampUsage(input: number, output: number): { input: number; output: number } | null {
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!ok(input) && !ok(output)) return null;
  return { input: clampTokens(input), output: clampTokens(output) };
}

/** Events that end a round-trip (or the turn): the usage kept so far is added now, once. */
const ENDS_ROUND_TRIP: ReadonlySet<TurnEvent['type']> = new Set([
  'Stop', 'ToolCallsDone', 'StreamFailed', 'HttpErr', 'NetErr', 'PortalErr', 'Abort', 'Background', 'Clear', 'Disabled',
]);

/** One step of the SM-31 machine. Returns the next state and the effects to run. Never throws. */
export function turnStep(state: TurnState, event: TurnEvent): TurnStep {
  const r = turnStepInner(state, event);
  if (!state.usage || !ENDS_ROUND_TRIP.has(event.type)) return r;
  if (state.kind !== 'requesting' && state.kind !== 'streaming' && event.type !== 'Clear' && event.type !== 'Disabled') return r;
  const { input, output } = state.usage;
  return {
    state: r.state.usage ? { ...r.state, usage: null } : r.state,
    effects: [...r.effects, { type: 'addUsage', input, output }],
  };
}

function turnStepInner(state: TurnState, event: TurnEvent): TurnStep {
  const same: TurnStep = { state, effects: [] };
  const s = state;

  // Accounting and cards do not depend on the turn state.
  switch (event.type) {
    case 'Usage': {
      // A provider may repeat usage on several chunks. Keep the last one, add it once when the round-trip ends.
      // Only a request in flight has usage to report. A late chunk in any other state would be added to a later round-trip.
      if (s.kind !== 'requesting' && s.kind !== 'streaming') return same;
      const usage = clampUsage(event.input, event.output);
      return usage ? { state: { ...s, usage }, effects: [] } : same;
    }
    case 'Clear':
      return clearStep(s, true);
    case 'Disabled':
      return clearStep(s, false);
    case 'Confirm':
      if (!s.pendingCards.includes(event.cardId)) return same;
      return { state, effects: [{ type: 'confirmCard', cardId: event.cardId }] };
    case 'Dismiss':
      if (!s.pendingCards.includes(event.cardId)) return same;
      return { state, effects: [{ type: 'dismissCard', cardId: event.cardId }] };
    case 'CardSettled':
      return cardSettled(s, event.cardId, event.kind, event.note);
    case 'TargetGone':
      return targetGone(s, event.target);
    default:
      break;
  }

  switch (s.kind) {
    case 'idle':
    case 'awaitingConfirmation': {
      if (event.type === 'Send') return send(s, event);
      if (event.type === 'Retry') return retryTurn(s, event);
      return same;
    }
    case 'requesting': {
      switch (event.type) {
        case 'FirstByte':
          return { state: { ...s, kind: 'streaming', streamText: '' }, effects: [] };
        case 'HttpErr':
          return statusStep(s, event.status, event.retryAfterMs, event.body);
        case 'PortalErr':
          return failTurn(s, COPY.portal);
        case 'NetErr':
          return retryStep(s, COPY.network);
        case 'StreamFailed':
          return streamFailed(s, event.error, event.truncated === true);
        case 'Abort':
          return abort(s);
        case 'Background':
          return abort(s, true);
        default:
          return same;
      }
    }
    case 'streaming': {
      switch (event.type) {
        case 'TextDelta':
          if (event.text === '') return same;
          return {
            state: { ...s, streamText: s.streamText + event.text },
            effects: [{ type: 'appendText', text: event.text }],
          };
        case 'ToolCallsDone':
          return toolCallsDone(s, event.calls, event.truncated === true);
        case 'Stop':
          return stopStep(s, event.truncated === true);
        case 'StreamFailed':
          return streamFailed(s, event.error, event.truncated === true);
        case 'Abort':
          return abort(s);
        case 'Background':
          return abort(s, true);
        default:
          return same;
      }
    }
    case 'runningTools': {
      switch (event.type) {
        case 'ToolsDone':
          return toolsDone(s, event.results);
        case 'ToolTimeout':
          return toolTimeout(s, event.toolCallId);
        case 'Abort':
        case 'Stop':
          return abort(s);
        case 'Background':
          return abort(s, true);
        default:
          return same;
      }
    }
    default:
      return same;
  }
}

function send(s: TurnState, e: Extract<TurnEvent, { type: 'Send' }>): TurnStep {
  if (!e.enabled) return { state: s, effects: [{ type: 'showNotice', text: COPY.notEnabled }] };
  if (!e.warningAccepted) return { state: s, effects: [{ type: 'showNotice', text: COPY.noWarning }] };
  if (!e.hasKey) return { state: s, effects: [{ type: 'showNotice', text: COPY.noKey }] };
  const text = truncate(e.text, USER_TEXT_MAX);
  if (text.trim() === '') return { state: s, effects: [] };

  // Cards survive a new message. Only the per-turn counters reset. What happened to cards since the last message
  // goes in front of the text for the model (once); the chat bubble shows only what the user typed.
  const next: TurnState = {
    ...s,
    history: [...s.history, { role: 'user', content: withCardFacts(s.cardFacts, text) }],
    cardFacts: [],
    rounds: 0,
    toolCalls: 0,
    retried: false,
    proposals: 0,
    destructive: 0,
    details: 0,
    streamText: '',
    calls: [],
    capHit: false,
  };
  const shown = e.display !== undefined && e.display.trim() !== '' ? truncate(e.display, USER_TEXT_MAX) : text;
  const r = startRequest(next, [{ type: 'appendUser', text: shown }]);
  if (r.state.kind === 'requesting') return r;
  // buildContext refused (RangeError): the message does not enter history.
  return {
    state: { ...s, kind: restKind(s) },
    effects: [{ type: 'errorCard', message: COPY.tooLong }],
  };
}

/** "[Maglev: User confirmed c2: Added.]" lines in front of the user's text. Empty list: the text as it is. */
function withCardFacts(facts: readonly string[], text: string): string {
  if (facts.length === 0) return text;
  return `${facts.map((f) => `[Maglev: ${f}]`).join('\n')}\n\n${text}`;
}

function retryTurn(s: TurnState, e: Extract<TurnEvent, { type: 'Retry' }>): TurnStep {
  let last = -1;
  for (let i = s.history.length - 1; i >= 0; i--) {
    if (s.history[i].role === 'user') {
      last = i;
      break;
    }
  }
  if (last < 0) return { state: s, effects: [] };
  if (!e.enabled) return { state: s, effects: [{ type: 'showNotice', text: COPY.notEnabled }] };
  if (!e.warningAccepted) return { state: s, effects: [{ type: 'showNotice', text: COPY.noWarning }] };
  if (!e.hasKey) return { state: s, effects: [{ type: 'showNotice', text: COPY.noKey }] };
  const next: TurnState = {
    ...s,
    history: s.history.slice(0, last + 1),
    rounds: 0,
    toolCalls: 0,
    retried: false,
    proposals: 0,
    destructive: 0,
    details: 0,
    streamText: '',
    calls: [],
    capHit: false,
  };
  const r = startRequest(next, [{ type: 'dropError' }]);
  if (r.state.kind === 'requesting') return r;
  return { state: s, effects: [{ type: 'errorCard', message: COPY.tooLong }] };
}

function streamFailed(s: TurnState, error: StreamFailure, truncated: boolean): TurnStep {
  if (truncated) return truncatedStep(s);
  if (error.code === 'provider') {
    // Groq: the model's own malformed tool call comes as an error with a string code. Retry once.
    if (error.providerCode === 'tool_use_failed' || TOOL_USE_FAILED_RE.test(error.detail ?? '')) {
      return retryStep(s, COPY.toolBroken);
    }
    if (error.status !== undefined) return statusStep(s, error.status, undefined, error.detail);
    return failTurn(s, error.message);
  }
  // Over the local size cap: asking again would give the same answer. The message says what to do.
  if (error.code === 'too_long') return failTurn(s, error.message);
  // bad_response, bad_args, incomplete: a bad response. One retry, then the plain message.
  return retryStep(s, error.message);
}

/** Abort, Stop (button) and Background: cancel what is in flight and go to rest. Pending cards stay. */
function abort(s: TurnState, background = false): TurnStep {
  const cancelled: TurnEffect = background ? { type: 'markCancelled', background: true } : { type: 'markCancelled' };
  if (s.kind === 'runningTools') {
    const { history, effects } = cancelledCalls(s);
    const next: TurnState = { ...s, history, streamText: '', calls: [], capHit: false };
    return {
      state: { ...next, kind: restKind(next) },
      effects: [{ type: 'cancelTools' }, ...effects, cancelled],
    };
  }
  const next: TurnState = { ...s, history: withAssistantText(s), streamText: '', calls: [], capHit: false };
  return {
    state: { ...next, kind: restKind(next) },
    effects: [{ type: 'abortFetch' }, cancelled],
  };
}

/** History messages for every call of the round: finished ones keep their content, the rest are cancelled. */
function cancelledCalls(s: TurnState): { history: ChatMessage[]; effects: TurnEffect[] } {
  const messages: ChatMessage[] = [];
  const effects: TurnEffect[] = [];
  for (const c of s.calls) {
    const content = c.content ?? toolError(COPY.cancelled);
    messages.push({ role: 'tool', tool_call_id: c.id, content });
    effects.push({ type: 'appendToolMessage', toolCallId: c.id, content });
  }
  return { history: [...s.history, ...messages], effects };
}

/** Clear drops history, cards and handles. Disabled expires cards and keeps history. */
function clearStep(s: TurnState, drop: boolean): TurnStep {
  const effects: TurnEffect[] = [];
  if (s.kind === 'requesting' || s.kind === 'streaming') effects.push({ type: 'abortFetch' });
  if (s.kind === 'runningTools') effects.push({ type: 'cancelTools' });
  effects.push({ type: 'expireCards' });
  if (drop) {
    effects.push({ type: 'clearHandles' });
    return { state: turnInitial(s.config), effects };
  }
  let history = s.history;
  if (s.kind === 'runningTools') {
    const c = cancelledCalls(s);
    history = c.history;
    effects.push(...c.effects);
  } else if (s.kind === 'streaming') {
    history = withAssistantText(s);
  }
  // Cards stay pending until each reports a final state: one that is mid-action cannot be expired, and when it
  // fails the user must still be able to dismiss it. Expiry is applied by the runner (expireCards).
  const base: TurnState = {
    ...turnInitial(s.config),
    history,
    pendingCards: s.pendingCards,
    cardTargets: s.cardTargets,
    planTargets: s.planTargets,
  };
  return { state: { ...base, kind: restKind(base) }, effects };
}

function addFact(s: TurnState, note: string | undefined): string[] {
  const fact = note === undefined ? '' : sanitizeText(note, CARD_FACT_MAX);
  return fact === '' ? s.cardFacts : [...s.cardFacts, fact].slice(-MAX_CARD_FACTS);
}

function cardSettled(s: TurnState, cardId: string, kind: CardSettledKind, note?: string): TurnStep {
  if (!s.pendingCards.includes(cardId)) return { state: s, effects: [] };
  const cardFacts = addFact(s, note);
  // A failed card stays pending (it can be retried), but the model still hears that it failed.
  if (kind === 'failed') return { state: { ...s, cardFacts }, effects: [] };
  const pendingCards = s.pendingCards.filter((c) => c !== cardId);
  const cardTargets = { ...s.cardTargets };
  delete cardTargets[cardId];
  const planTargets = { ...s.planTargets };
  delete planTargets[cardId];
  const next: TurnState = { ...s, pendingCards, cardTargets, planTargets, cardFacts };
  const atRest = s.kind === 'idle' || s.kind === 'awaitingConfirmation';
  return { state: atRest ? { ...next, kind: restKind(next) } : next, effects: [] };
}

function targetGone(s: TurnState, target: string): TurnStep {
  const gone = s.pendingCards.filter((c) => s.cardTargets[c] === target || (s.planTargets[c]?.includes(target) ?? false));
  if (gone.length === 0) return { state: s, effects: [] };
  // The runner drives cardMachine EXPIRE and reports each card back with CardSettled.
  return { state: s, effects: gone.map((cardId) => ({ type: 'expireCard' as const, cardId })) };
}

function toolTimeout(s: TurnState, toolCallId: string): TurnStep {
  const target = s.calls.find((c) => c.id === toolCallId);
  if (!target || target.content !== undefined) return { state: s, effects: [] };
  const calls = s.calls.map((c) => (c.id === toolCallId ? { ...c, content: toolError(COPY.toolTimeout) } : c));
  const next: TurnState = { ...s, calls };
  const cancel: TurnEffect = { type: 'cancelTools', callIds: [toolCallId] };
  // A call that never started a tool (an error or a card) already has content, so these are all read tools.
  if (calls.every((c) => c.content !== undefined)) {
    const done = toolsDone(next, []);
    return { state: done.state, effects: [cancel, ...done.effects] };
  }
  return { state: next, effects: [cancel] };
}
