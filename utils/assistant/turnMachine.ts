// SM-31 Assistant chat turn. Pure: no React, no IO, no clock. app/assistant.tsx (the runner) runs the effects.
// One user message is one turn: Send, then up to 6 model round-trips, then idle or awaitingConfirmation.
// Anything not in the transition table is a no-op. Never add states.
//
// Interpretations the table leaves open (also listed in the build report):
//  - A proposal tool call creates a card and answers the model `{"status":"proposed","card_id":"c1"}`. The turn
//    then continues as the table says (ToolsDone -> requesting) so the model can say "I've put it on a card",
//    and ends at awaitingConfirmation through the `Stop` row (pending cards > 0).
//  - When a round has no read tools, there is nothing for the runner to wait for, so ToolsDone is applied in the
//    same step (the transient runningTools state is skipped).
//  - Cap: at most 3 calls per round-trip and 8 per turn. Calls over the allowance are dropped from history. The
//    turn ends with "Stopped after 6 steps." when any call was dropped or 6 round-trips are used.
//  - Abort and errors go to idle but keep pending cards (SM-42: "keep history and cards"). Confirm and Dismiss
//    still work for those cards. The next Send expires them.

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
import { USER_TEXT_MAX, truncate } from './sanitize.ts';
import type { AssistantToolCall, StreamFailure } from './sse.ts';
import { PROPOSAL_TOOLS, READ_TOOLS, TOOLS, validateArgs, type ToolDef } from './tools.ts';

export type TurnKind = 'idle' | 'requesting' | 'streaming' | 'runningTools' | 'awaitingConfirmation';

/** Fixed copy (SM-31 and the design). */
export const COPY = {
  noKey: 'Add an API key in Settings → Assistant.',
  checkKey: 'Check your key.',
  noCredits: 'Out of credits.',
  rateLimited: 'Rate limited. Try again in a minute.',
  stopped: 'Stopped after 6 steps.',
  tooLong: 'That message is too long. Try a shorter one.',
  network: "Couldn't reach the provider. Check your connection.",
  providerDown: 'The provider is having trouble. Try again later.',
  rejected: 'The provider rejected the request.',
  urlNotPasted: 'I can only download links you pasted in this chat.',
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
  /** The user's capped raw texts this session, for the URL provenance check. */
  userTexts: string[];
  /** Model round-trips started in this turn (retries do not count). */
  rounds: number;
  /** Tool calls accepted in this turn. */
  toolCalls: number;
  /** True once the current request used its one retry. */
  retried: boolean;
  /** Text streamed so far in the current round-trip. */
  streamText: string;
  /** Cards created and not yet confirmed or dismissed. */
  pendingCards: string[];
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
  | { type: 'retryOnce'; request: RequestEffect; discardPartial: boolean }
  | { type: 'abortFetch' }
  | { type: 'markCancelled' }
  | { type: 'appendText'; text: string }
  | { type: 'runTool'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'createCard'; cardId: string; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'appendToolMessage'; toolCallId: string; content: string }
  | { type: 'note'; text: string }
  | { type: 'executeCard'; cardId: string }
  | { type: 'removeCard'; cardId: string }
  | { type: 'expireCards' }
  | { type: 'clearHandles' };

export type TurnEvent =
  | { type: 'Send'; text: string; hasKey: boolean }
  | { type: 'FirstByte' }
  | { type: 'HttpErr'; status: number }
  | { type: 'NetErr' }
  /** A stream that failed after it started (the parser's `{ok:false}` outcome or an `error` event). */
  | { type: 'StreamFailed'; error: StreamFailure }
  | { type: 'Abort' }
  | { type: 'TextDelta'; text: string }
  | { type: 'ToolCallsDone'; calls: AssistantToolCall[] }
  | { type: 'Stop' }
  | { type: 'ToolsDone'; results: { toolCallId: string; content: string }[] }
  | { type: 'Confirm'; cardId: string }
  | { type: 'Dismiss'; cardId: string }
  /** SM-42 CLEAR and KEY_REMOVED. */
  | { type: 'Clear' };

export interface TurnStep {
  state: TurnState;
  effects: TurnEffect[];
}

export function turnInitial(config: TurnConfig): TurnState {
  return {
    kind: 'idle',
    config,
    history: [],
    userTexts: [],
    rounds: 0,
    toolCalls: 0,
    retried: false,
    streamText: '',
    pendingCards: [],
    calls: [],
    capHit: false,
  };
}

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

/** Ends the turn with a plain error. The history keeps what it had. */
function failTurn(s: TurnState, message: string, extra: TurnEffect[] = []): TurnStep {
  return {
    state: { ...s, kind: 'idle', streamText: '', calls: [], capHit: false },
    effects: [...extra, { type: 'errorCard', message }],
  };
}

function toolError(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}

function statusStep(s: TurnState, status: number): TurnStep {
  if (status === 401 || status === 403) return failTurn(s, COPY.checkKey);
  if (status === 402) return failTurn(s, COPY.noCredits);
  if (status === 429) return failTurn(s, COPY.rateLimited);
  if (status >= 500) return retryStep(s, COPY.providerDown);
  return failTurn(s, COPY.rejected);
}

/** SM-31: one retry on network/5xx only. Otherwise the error card. */
function retryStep(s: TurnState, finalMessage: string): TurnStep {
  if (s.retried) return failTurn(s, finalMessage);
  let request: RequestEffect;
  try {
    request = buildRequest(s, s.rounds);
  } catch {
    return failTurn(s, COPY.tooLong);
  }
  return {
    state: { ...s, kind: 'requesting', retried: true, streamText: '' },
    effects: [{ type: 'retryOnce', request, discardPartial: s.kind === 'streaming' }],
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
    state: { ...s, kind: 'requesting', rounds: round, retried: false, streamText: '', calls: [], capHit: false },
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

/** All urls in a validated proposal (a plan can hold several steps). */
function urlsOf(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'propose_url_download') return typeof args.url === 'string' ? [args.url] : [''];
  if (tool === 'propose_plan' && Array.isArray(args.steps)) {
    return (args.steps as Array<{ tool: string; args: Record<string, unknown> }>).flatMap((st) =>
      urlsOf(st.tool, st.args),
    );
  }
  return [];
}

function urlsAreProvenanced(s: TurnState, tool: string, args: Record<string, unknown>): boolean {
  return urlsOf(tool, args).every((u) => u !== '' && s.userTexts.some((t) => t.includes(u)));
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

function toolCallsDone(s: TurnState, calls: AssistantToolCall[]): TurnStep {
  if (calls.length === 0) return stopStep(s);

  const allowed = Math.max(0, Math.min(MAX_TOOL_CALLS_PER_ROUND_TRIP, MAX_TOOL_CALLS_PER_TURN - s.toolCalls));
  const used = calls.slice(0, allowed);
  const capHit = calls.length > used.length;

  if (used.length === 0) {
    // Nothing may run any more. Keep the text, end the turn with the note.
    return endTurn(s, withAssistantText(s), [{ type: 'note', text: COPY.stopped }]);
  }

  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const pending: PendingCall[] = [];
  const effects: TurnEffect[] = [];
  const pendingCards = [...s.pendingCards];

  used.forEach((call, i) => {
    const id = seen.has(call.id) ? `${call.id}-${i}` : call.id;
    seen.add(id);
    toolCalls.push({ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
    const entry: PendingCall = { id, name: call.name };
    pending.push(entry);

    const v = validateArgs(call.name, call.arguments, s.config.registry);
    if (!v.ok) {
      entry.content = toolError(v.error.message);
      return;
    }
    if (READ_TOOLS.has(call.name)) {
      effects.push({ type: 'runTool', callId: id, name: call.name, args: v.args });
      return;
    }
    if (PROPOSAL_TOOLS.has(call.name)) {
      if (!urlsAreProvenanced(s, call.name, v.args)) {
        entry.content = toolError(COPY.urlNotPasted);
        return;
      }
      const cardId = s.config.registry.issue('card', `${s.userTexts.length}:${s.history.length}:${id}`);
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
    pendingCards,
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

function stopStep(s: TurnState): TurnStep {
  return endTurn(s, withAssistantText(s), []);
}

// ---- reducer ----------------------------------------------------------------------------------------

/** One step of the SM-31 machine. Returns the next state and the effects to run. Never throws. */
export function turnStep(state: TurnState, event: TurnEvent): TurnStep {
  const same: TurnStep = { state, effects: [] };
  const s = state;

  if (event.type === 'Clear') {
    const inFlight = s.kind === 'requesting' || s.kind === 'streaming';
    return {
      state: turnInitial(s.config),
      effects: [...(inFlight ? [{ type: 'abortFetch' } as const] : []), { type: 'expireCards' }, { type: 'clearHandles' }],
    };
  }

  switch (s.kind) {
    case 'idle':
    case 'awaitingConfirmation': {
      if (event.type === 'Send') return send(s, event.text, event.hasKey);
      if (event.type === 'Confirm' || event.type === 'Dismiss') return cardEvent(s, event);
      return same;
    }
    case 'requesting': {
      switch (event.type) {
        case 'FirstByte':
          return { state: { ...s, kind: 'streaming', streamText: '' }, effects: [] };
        case 'HttpErr':
          return statusStep(s, event.status);
        case 'NetErr':
          return retryStep(s, COPY.network);
        case 'StreamFailed':
          return streamFailed(s, event.error);
        case 'Abort':
          return abort(s);
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
          return toolCallsDone(s, event.calls);
        case 'Stop':
          return stopStep(s);
        case 'StreamFailed':
          return streamFailed(s, event.error);
        case 'Abort':
          return abort(s);
        default:
          return same;
      }
    }
    case 'runningTools': {
      if (event.type === 'ToolsDone') return toolsDone(s, event.results);
      return same;
    }
    default:
      return same;
  }
}

function send(s: TurnState, rawText: string, hasKey: boolean): TurnStep {
  if (!hasKey) return { state: s, effects: [{ type: 'showNotice', text: COPY.noKey }] };
  const text = truncate(rawText, USER_TEXT_MAX);
  if (text.trim() === '') return { state: s, effects: [] };

  const expire: TurnEffect[] = s.pendingCards.length > 0 ? [{ type: 'expireCards' }] : [];
  const next: TurnState = {
    ...s,
    history: [...s.history, { role: 'user', content: text }],
    userTexts: [...s.userTexts, text],
    rounds: 0,
    toolCalls: 0,
    retried: false,
    streamText: '',
    pendingCards: [],
    calls: [],
    capHit: false,
  };
  const r = startRequest(next, [...expire, { type: 'appendUser', text }]);
  if (r.state.kind === 'requesting') return r;
  // buildContext refused (RangeError): the message does not enter history, cards expire only if it was sent.
  return {
    state: { ...s, kind: restKind(s) },
    effects: [{ type: 'errorCard', message: COPY.tooLong }],
  };
}

function streamFailed(s: TurnState, error: StreamFailure): TurnStep {
  if (error.code === 'provider' && error.status !== undefined) return statusStep(s, error.status);
  if (error.code === 'provider') return failTurn(s, error.message);
  // bad_response, bad_args, incomplete: a bad response. One retry, then the plain message.
  return retryStep(s, error.message);
}

function abort(s: TurnState): TurnStep {
  const history = withAssistantText(s);
  return {
    state: { ...s, kind: 'idle', history, streamText: '', calls: [], capHit: false },
    effects: [{ type: 'abortFetch' }, { type: 'markCancelled' }],
  };
}

function cardEvent(s: TurnState, event: { type: 'Confirm' | 'Dismiss'; cardId: string }): TurnStep {
  if (!s.pendingCards.includes(event.cardId)) return { state: s, effects: [] };
  const pendingCards = s.pendingCards.filter((c) => c !== event.cardId);
  const next: TurnState = { ...s, pendingCards };
  return {
    state: { ...next, kind: restKind(next) },
    effects: [
      event.type === 'Confirm'
        ? { type: 'executeCard', cardId: event.cardId }
        : { type: 'removeCard', cardId: event.cardId },
    ],
  };
}
