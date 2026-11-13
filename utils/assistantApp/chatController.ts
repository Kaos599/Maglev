// Chat controller for the assistant (build step 13, docs/ASSISTANT_DESIGN.md §10). Plain TypeScript: no React,
// no react-native, no expo imports. It drives SM-31 (turnMachine), SM-38 (cardMachine) and SM-42 (session rules),
// runs every effect, and publishes an `AssistantChat` snapshot for the UI (utils/assistant/runtime.ts).
//
// Events are queued and applied one at a time, so an effect that raises an event never re-enters the machine.

import { CARD_EXPIRED_CAPTION, CARD_REPLACED_CAPTION, cardSettledKind, cardStep, type CardEffect, type CardEvent, type CardState } from '../assistant/cardMachine.ts';
import { planInitial, planStep, type PlanEffect, type PlanEvent, type PlanState } from '../assistant/planMachine.ts';
import type { ChatMessage } from '../assistant/context.ts';
import { filterModelOutput } from '../assistant/sanitize.ts';
import type {
  AssistantChat,
  ChatGate,
  ChatPhase,
  ChatItem,
  ExecuteResult,
  ProgressStep,
  ProposalCardView,
  ResultCardView,
  RevalidateResult,
  ToolRunOutput,
  ToolRunner,
} from '../assistant/runtime.ts';
import { STREAM_COPY } from '../assistant/sse.ts';
import { buildSystemPrompt } from '../assistant/systemPrompt.ts';
import { modelDisplayName } from '../assistant/models.ts';
import {
  COPY,
  turnInitial,
  turnStep,
  type RequestEffect,
  type TurnEffect,
  type TurnEvent,
  type TurnState,
} from '../assistant/turnMachine.ts';
import { presetById, type AssistantPrefs } from '../prefs/assistant.ts';
import type { StreamFn } from './client.ts';
import { restoreItems, type ChatStore } from './chatStore.ts';

/** R1-5: a read tool that has not finished after this long is answered "That took too long." */
export const TOOL_TIMEOUT_MS = 60_000;
/** SM-31: UI text updates are batched at 50 ms. */
export const TEXT_BATCH_MS = 50;
/** Upper bound of the jitter added to a retry that had no Retry-After. SM-31 says "about 250 ms". */
export const RETRY_JITTER_MS = 250;
/** Time a card may take to be built, and to be rechecked on Confirm. A hung engine call fails the card instead. */
export const PREP_TIMEOUT_MS = 20_000;
export const REVALIDATE_TIMEOUT_MS = 20_000;
/** Time one confirmed action (or one plan step) may take. */
export const EXECUTE_TIMEOUT_MS = 60_000;

/** Shown when a saved chat was mid-turn and the process ended. Offers Retry, which asks the last question again. */
export const INTERRUPTED = 'Interrupted. Tap Retry to ask again.';
/** Debounce for saving the chat while it changes. A turn start and a turn end save at once. */
export const SAVE_DEBOUNCE_MS = 500;

const SLOW_PREP = 'That took too long. Ask me again.';
const SLOW_CHECK = 'That took too long to check. Try again.';
const SLOW_RUN = "That is taking too long. Check your downloads before you try again.";

export interface ChatTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatDeps {
  runner: ToolRunner;
  stream: StreamFn;
  getPrefs(): AssistantPrefs;
  /** The API key, read synchronously (the hook loads it from secure storage). Null when none is saved. */
  getKey(): string | null;
  addUsage(usage: { input: number; output: number }): void;
  timers?: ChatTimers;
  /** Returns a number in [0, 1). */
  random?: () => number;
  /** Defaults to buildSystemPrompt() with the current time, rebuilt for every new question. A fixed string is used as is. */
  systemPrompt?: string;
  /** Called when a finished reply is waiting unseen (true) or has been seen (false): the tab badge. */
  onUnseenChange?: (unseen: boolean) => void;
  /** The clock for the system prompt ("this week", "latest"). Defaults to the real time. */
  now?: () => Date;
  /** IANA time zone for the system prompt, e.g. "Asia/Kolkata". Defaults to the phone's. */
  timeZone?: string;
  /** Device locale such as "fr-FR". Default: the runtime's. Tests set it. */
  locale?: string;
  /** Saves the chat so it survives the process ending. Read once, synchronously, when the controller is created. */
  store?: ChatStore;
}

export interface ChatController {
  getSnapshot(): AssistantChat;
  subscribe(listener: () => void): () => void;
  /** Re-read prefs and key. Call when either changed. Key removed means Clear; Assistant turned off means Disabled. */
  refresh(): void;
  /**
   * The app went to the background. Does nothing: the turn keeps going. If the system ends the process the chat
   * is already saved; it comes back with an "Interrupted" row that offers Retry.
   */
  background(): void;
  /** Whether the Assistant tab is in view. A reply that finishes out of view sets `unseenReply`; seeing it clears it. */
  setFocused(focused: boolean): void;
  /** A card's target (a transfer or result handle) is gone. */
  targetGone(target: string): void;
}

const ERROR_SETTINGS: ReadonlySet<string> = new Set([
  COPY.checkKey,
  COPY.noCredits,
  COPY.notEnabled,
  COPY.noWarning,
  COPY.noKey,
  COPY.noTools,
  COPY.modelGone,
]);
/** Every other error offers Retry, so no message is a dead end. */
const ERROR_RETRY: ReadonlySet<string> = new Set([
  COPY.rateLimited,
  COPY.rateLimitedLong,
  COPY.network,
  COPY.providerDown,
  COPY.rejected,
  COPY.providerStopped,
  COPY.tooMuch,
  COPY.toolBroken,
  COPY.portal,
  COPY.noAnswer,
  COPY.stoppedAway,
  INTERRUPTED,
  // A cut-off, unreadable or garbled answer often works the second time. An over-long answer does not
  // (STREAM_COPY.tooLong says to ask a narrower question), and "That message is too long." says to shorten it.
  STREAM_COPY.cutOff,
  STREAM_COPY.badResponse,
  STREAM_COPY.badArgs,
]);

/** The one recovery an error offers: Settings, Retry, or none (the copy says what to change). */
export function errorActionFor(message: string): 'settings' | 'retry' | undefined {
  return ERROR_SETTINGS.has(message) ? 'settings' : ERROR_RETRY.has(message) ? 'retry' : undefined;
}

const HANDLE_RE = /^[rt][0-9]+$/;

/** Id of one step of a plan card as the runner accepts it (`c3:0`). Same as toolRunner's planStepId. */
const stepId = (cardId: string, index: number): string => `${cardId}:${index}`;

/** A step reason from the runner starts with "Step 2: "; the plan message adds its own step label. */
function bareReason(reason: string): string {
  return reason.replace(/^Step \d+:\s*/, '');
}

function withStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "Step 2 of 3 stopped: It no longer fits. Step 3 did not run." */
export function planStopMessage(step: number, total: number, reason: string, notRun: readonly number[]): string {
  let out = `Step ${step + 1} of ${total} stopped: ${withStop(bareReason(reason))}`;
  if (notRun.length === 1) out += ` Step ${notRun[0] + 1} did not run.`;
  else if (notRun.length > 1) out += ` Steps ${notRun[0] + 1} to ${notRun[notRun.length - 1] + 1} did not run.`;
  return out;
}

interface ToolBatch {
  pending: Set<string>;
  results: Map<string, string>;
}

function toolErrorContent(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function contentFailed(content: string): boolean {
  try {
    const v = JSON.parse(content) as { ok?: unknown };
    return v?.ok === false;
  } catch {
    return false;
  }
}

/**
 * R1-3 "target gone": the transfer handles (t1…) of pending cards whose transfer was listed before and is not
 * listed now. A transfer never seen is left alone, so an engine restart that briefly empties the list expires
 * nothing. `resolve` maps a handle to the engine id (link downloads are "dl:<id>").
 */
export function goneTargets(
  targets: readonly (string | undefined)[],
  resolve: (handle: string) => string | null,
  live: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const h of targets) {
    if (!h || !h.startsWith('t') || out.includes(h)) continue;
    const id = resolve(h);
    if (id !== null && seen.has(id) && !live.has(id)) out.push(h);
  }
  return out;
}

/**
 * The device language as an English name ("French"), or undefined for English, an unknown locale, or a runtime
 * without Intl.DisplayNames (Hermes may lack it). `locale` overrides the device locale for tests.
 */
export function nonEnglishLanguage(locale?: string): string | undefined {
  try {
    const tag = locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
    if (!tag || /^en(?:[-_]|$)/i.test(tag)) return undefined;
    const lang = tag.split(/[-_]/)[0];
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang);
    return name && name !== lang ? name : undefined;
  } catch {
    return undefined;
  }
}

export function createChatController(deps: ChatDeps): ChatController {
  const { runner, stream, getPrefs, getKey } = deps;
  const timers: ChatTimers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const random = deps.random ?? Math.random;

  const currentSystem = (): string =>
    deps.systemPrompt ?? buildSystemPrompt({ now: (deps.now ?? (() => new Date()))(), timeZone: deps.timeZone, language: nonEnglishLanguage(deps.locale) });
  let turn: TurnState = turnInitial({ system: currentSystem(), registry: runner.registry });
  let items: ChatItem[] = [];
  let nextId = 1;
  const newId = (prefix: string) => `${prefix}${nextId++}`;

  // ---- in-flight work -------------------------------------------------------------------------------
  /** Bumped whenever the current request is abandoned, so late callbacks are ignored. */
  let reqSeq = 0;
  let fetchAbort: AbortController | null = null;
  let retryTimer: unknown;
  let batch: ToolBatch | null = null;
  const toolAborts = new Map<string, AbortController>();
  const toolTimers = new Map<string, unknown>();
  /** Progress item of the current tool batch. */
  let progressId: string | null = null;
  /** Assistant item receiving text, and the raw text behind it. */
  let assistantId: string | null = null;
  let rawText = '';
  /** Card preparations still running, and the proposals the runner refused (callId to message). */
  const preps = new Set<Promise<void>>();
  const refused = new Map<string, string>();
  /** propose_plan cards: step count, and how many steps already ran (a retry starts after them). */
  const planSizes = new Map<string, number>();
  const planDone = new Map<string, number>();
  /**
   * Cards that must expire as soon as their action stops (a newer card replaced them, or the Assistant was turned
   * off) but were mid-action when asked: cardMachine ignores EXPIRE there. Value: the caption to show.
   */
  const expireOnSettle = new Map<string, string>();
  /** Cards whose prepareCard has not finished, and the ones to drop when it does (expired or switched off meanwhile). */
  const preparing = new Set<string>();
  const dropPrepared = new Set<string>();

  // ---- snapshot -------------------------------------------------------------------------------------
  const listeners = new Set<() => void>();
  let snapshot: AssistantChat | null = null;
  let textTimer: unknown;
  let focused = true;
  let unseen = false;
  let wasBusy = false;
  let lastEnabled = getPrefs().enabled;
  let lastHadKey = hasKey();

  function hasKey(): boolean {
    const key = getKey();
    if (key) return true;
    // A local server (Ollama) needs no key (R1-14).
    return presetById(getPrefs().presetId).local;
  }

  function gate(): ChatGate {
    const p = getPrefs();
    if (!p.enabled) return 'disabled';
    if (!p.warningAcceptedAt) return 'notAccepted';
    if (!hasKey()) return 'noKey';
    return 'ready';
  }

  const isBusy = (): boolean => turn.kind === 'requesting' || turn.kind === 'streaming' || turn.kind === 'runningTools';

  function phase(): ChatPhase {
    if (!isBusy()) return 'idle';
    if (assistantId !== null && rawText.length > 0) return 'writing';
    if (batch !== null && batch.pending.size > 0) return 'tools';
    return 'thinking';
  }

  // ---- saved chat -----------------------------------------------------------------------------------
  // The store is read synchronously (expo-sqlite kv), so a restored chat is in the first snapshot and the screen
  // never flashes an empty state. Not saved: the unseen flag, the model's tool history, API keys.
  const store = deps.store;
  let saveTimer: unknown;

  function saveNow(): void {
    if (!store) return;
    if (saveTimer !== undefined) {
      timers.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (items.length === 0) store.clear();
    else store.save(items, isBusy());
  }

  /** Debounced: at most one write per SAVE_DEBOUNCE_MS while the chat keeps changing (streaming text). */
  function saveSoon(): void {
    if (!store || saveTimer !== undefined) return;
    saveTimer = timers.setTimeout(() => {
      saveTimer = undefined;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  // Restore when a key is saved, not only when it is loaded: on a cold start the key is still being read from
  // secure storage (getKey() is null until then), and checking hasKey() alone wiped every saved chat.
  // A key removed later still clears the chat through refresh() (KEY_REMOVED).
  if (store && (hasKey() || getPrefs().keyRef !== null)) {
    const saved = store.load();
    if (saved) {
      const restoredItems = restoreItems(saved.items);
      let maxId = 0;
      for (const i of restoredItems) {
        const n = Number(i.id.replace(/^[a-z]+/, ''));
        if (Number.isFinite(n) && n > maxId) maxId = n;
      }
      nextId = maxId + 1;
      items = restoredItems;
      // The model gets the plain text of the conversation back (no tool calls): enough to retry or carry on.
      const history: ChatMessage[] = [];
      for (const i of restoredItems) {
        if (i.kind === 'user') history.push({ role: 'user', content: i.text });
        else if (i.kind === 'assistant' && i.text) history.push({ role: 'assistant', content: i.text });
      }
      turn = { ...turn, history };
      if (saved.busy && history.some((m) => m.role === 'user')) {
        items = [...items, { kind: 'error', id: newId('e'), message: INTERRUPTED, action: 'retry' }];
        store.save(items, false); // not busy any more: a second restart must not add a second row
      }
    } else store.clear();
  } else if (store) store.clear();

  function setUnseen(next: boolean): void {
    if (unseen === next) return;
    unseen = next;
    deps.onUnseenChange?.(next);
  }

  function build(): AssistantChat {
    const p = getPrefs();
    return {
      items,
      gate: gate(),
      busy: isBusy(),
      phase: phase(),
      unseenReply: unseen,
      providerName: presetById(p.presetId).label,
      modelName: modelDisplayName(p),
      tokensUsed: { ...p.tokensUsed },
      send,
      stop,
      clear,
      confirm,
      dismiss,
      retry: retryLast,
      askAbout,
      answer,
      sourceFor: (handle) => runner.sourceFor(handle),
    };
  }

  function emit(): void {
    if (textTimer !== undefined) {
      timers.clearTimeout(textTimer);
      textTimer = undefined;
    }
    snapshot = null;
    listeners.forEach((l) => l());
  }

  /** Text deltas arrive fast. The UI sees them at most every 50 ms. */
  function emitSoon(): void {
    if (textTimer !== undefined) return;
    textTimer = timers.setTimeout(() => {
      textTimer = undefined;
      emit();
    }, TEXT_BATCH_MS);
  }

  // ---- items ----------------------------------------------------------------------------------------
  const setItems = (next: ChatItem[]) => {
    items = next;
  };
  const push = (item: ChatItem) => setItems([...items, item]);
  const replace = (id: string, fn: (item: ChatItem) => ChatItem) =>
    setItems(items.map((i) => (i.id === id ? fn(i) : i)));

  function closeStreaming(): void {
    if (assistantId === null) return;
    const id = assistantId;
    assistantId = null;
    rawText = '';
    replace(id, (i) => (i.kind === 'assistant' ? { ...i, streaming: false } : i));
  }

  function pushNote(text: string): void {
    push({ kind: 'note', id: newId('n'), text });
  }

  /** Removes the error items of the failed turn (everything after the last user message). */
  function dropTrailingErrors(): void {
    let from = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'user') {
        from = i + 1;
        break;
      }
    }
    setItems(items.filter((it, i) => i < from || it.kind !== 'error'));
  }

  function pushError(message: string): void {
    const action = errorActionFor(message);
    // `{provider}` in the fixed copy is the provider's name.
    const shown = message.replace('{provider}', presetById(getPrefs().presetId).label);
    push({ kind: 'error', id: newId('e'), message: shown, ...(action ? { action } : {}) });
  }

  // ---- event loop -----------------------------------------------------------------------------------
  const queue: TurnEvent[] = [];
  let draining = false;

  function dispatch(event: TurnEvent): void {
    queue.push(event);
    if (draining) return;
    draining = true;
    let onlyText = true;
    try {
      while (queue.length > 0) {
        const ev = queue.shift() as TurnEvent;
        if (ev.type !== 'TextDelta') onlyText = false;
        apply(ev);
      }
    } finally {
      draining = false;
    }
    const busyNow = isBusy();
    // A turn that ended while the tab was out of view leaves a reply to look at. Clear and Stop do not.
    if (wasBusy && !busyNow && !focused && items.length > 0 && items[items.length - 1].kind !== 'note') setUnseen(true);
    if (items.length === 0) setUnseen(false);
    const turnChanged = wasBusy !== busyNow;
    wasBusy = busyNow;
    if (store) {
      if (turnChanged || items.length === 0) saveNow();
      else saveSoon();
    }
    if (onlyText) emitSoon();
    else emit();
  }

  function apply(event: TurnEvent): void {
    // Each new question (and a retry) gets today's date and time in the system prompt.
    if ((event.type === 'Send' || event.type === 'Retry') && deps.systemPrompt === undefined) {
      turn = { ...turn, config: { ...turn.config, system: currentSystem() } };
    }
    const step = turnStep(turn, event);
    turn = step.state;
    if (step.effects.some((e) => e.type === 'runTool')) startBatch(step.effects);
    for (const effect of step.effects) runEffect(effect);
    if (event.type === 'Clear') {
      setItems([]);
      progressId = null;
      assistantId = null;
      rawText = '';
      refused.clear();
      planSizes.clear();
      planDone.clear();
      expireOnSettle.clear();
      preparing.clear();
      dropPrepared.clear();
    }
    if (turn.kind !== 'streaming') closeStreaming();
  }

  // ---- turn effects ---------------------------------------------------------------------------------
  function runEffect(e: TurnEffect): void {
    switch (e.type) {
      case 'appendUser':
        push({ kind: 'user', id: newId('u'), text: e.text });
        break;
      case 'showNotice':
        pushError(e.text);
        break;
      case 'request':
        closeStreaming();
        sendRequest(e, 0);
        break;
      case 'retryOnce':
        retry(e.request, e.discardPartial, e.delayMs, e.jitter);
        break;
      case 'abortFetch':
        abortRequest();
        break;
      case 'cancelTools':
        cancelTools(e.callIds);
        break;
      case 'markCancelled':
        closeStreaming();
        // Stop must not leave the next question waiting on a card that is still being built.
        preps.clear();
        // Leaving the app is not the user's choice, so it offers Retry. The Stop button keeps the plain note.
        if (e.background) pushError(COPY.stoppedAway);
        else pushNote('Stopped.');
        break;
      case 'appendText':
        appendText(e.text);
        break;
      case 'runTool':
        runTool(e.callId, e.name, e.args);
        break;
      case 'createCard':
        createCard(e.cardId, e.callId, e.tool, e.args);
        break;
      case 'appendToolMessage':
        break; // The turn machine already keeps the history.
      case 'note':
        closeStreaming();
        pushNote(e.text);
        break;
      case 'errorCard':
        closeStreaming();
        pushError(e.message);
        break;
      case 'confirmCard':
        cardEvent(e.cardId, items.some((i) => i.kind === 'card' && i.id === e.cardId && i.state.kind === 'failed') ? { type: 'RETRY' } : { type: 'CONFIRM' });
        break;
      case 'dismissCard':
        cardEvent(e.cardId, { type: 'DISMISS' });
        break;
      case 'expireCard':
        expireCard(e.cardId, e.replaced ? CARD_REPLACED_CAPTION : CARD_EXPIRED_CAPTION);
        break;
      case 'expireCards':
        for (const i of items) if (i.kind === 'card') expireCard(i.id, CARD_EXPIRED_CAPTION);
        for (const id of preparing) expireCard(id, CARD_EXPIRED_CAPTION);
        break;
      case 'addUsage':
        deps.addUsage({ input: e.input, output: e.output });
        break;
      case 'clearHandles':
        runner.reset();
        break;
      case 'dropError':
        // Retry: the failed turn's error items go; the user's message stays and is not added again.
        dropTrailingErrors();
        break;
    }
  }

  // ---- request / stream -----------------------------------------------------------------------------
  function abortRequest(): void {
    reqSeq++;
    if (retryTimer !== undefined) {
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
  }

  /** The runner refused a proposal after the machine told the model "proposed": fix the tool message the model sees. */
  function patchRefusals(request: RequestEffect): RequestEffect {
    if (refused.size === 0) return request;
    const patch = (msgs: ChatMessage[]): ChatMessage[] => {
      const out = [...msgs];
      for (const [callId, message] of refused) {
        for (let i = out.length - 1; i >= 0; i--) {
          const m = out[i];
          if (m.role === 'tool' && m.tool_call_id === callId) {
            out[i] = { ...m, content: toolErrorContent('refused', message) };
            break;
          }
        }
      }
      return out;
    };
    turn = { ...turn, history: patch(turn.history) };
    const next = { ...request, messages: patch(request.messages) };
    refused.clear();
    return next;
  }

  function sendRequest(request: RequestEffect, delayMs: number, jitter = false): void {
    const seq = ++reqSeq;
    const go = () => {
      retryTimer = undefined;
      if (seq !== reqSeq) return;
      const wait = preps.size > 0 ? Promise.all([...preps]) : null;
      const start = () => {
        if (seq !== reqSeq) return;
        launch(patchRefusals(request), seq);
      };
      if (wait) void wait.then(start);
      else start();
    };
    if (delayMs > 0 || jitter) {
      retryTimer = timers.setTimeout(go, delayMs + (jitter ? Math.floor(random() * RETRY_JITTER_MS) : 0));
    } else go();
  }

  function launch(request: RequestEffect, seq: number): void {
    const p = getPrefs();
    const ac = new AbortController();
    fetchAbort = ac;
    const onEvent = (ev: TurnEvent) => {
      if (seq !== reqSeq || ac.signal.aborted) return;
      dispatch(ev);
    };
    void stream({ request, presetId: p.presetId, baseUrl: p.baseUrl, model: p.model, apiKey: getKey() }, onEvent, ac.signal).catch(
      () => {
        if (seq === reqSeq && !ac.signal.aborted) dispatch({ type: 'NetErr' });
      },
    );
  }

  function retry(request: RequestEffect, discardPartial: boolean, delayMs: number, jitter: boolean): void {
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
    if (discardPartial && assistantId !== null) {
      const id = assistantId;
      assistantId = null;
      rawText = '';
      setItems(items.filter((i) => i.id !== id));
    }
    sendRequest(request, delayMs, jitter);
  }

  function appendText(text: string): void {
    rawText += text;
    const shown = filterModelOutput(rawText);
    if (assistantId === null) {
      assistantId = newId('a');
      push({ kind: 'assistant', id: assistantId, text: shown, streaming: true });
    } else {
      replace(assistantId, (i) => (i.kind === 'assistant' ? { ...i, text: shown } : i));
    }
  }

  // ---- tools ----------------------------------------------------------------------------------------
  function startBatch(effects: TurnEffect[]): void {
    const pending = new Set<string>();
    for (const e of effects) if (e.type === 'runTool') pending.add(e.callId);
    batch = { pending, results: new Map() };
    progressId = null;
  }

  function progressFor(callId: string, text: string, state: ProgressStep['state'], tool?: string, detail?: string): void {
    const step: ProgressStep = { callId, text, state, ...(tool ? { tool } : {}), ...(detail ? { detail } : {}) };
    if (progressId === null) {
      progressId = newId('p');
      push({ kind: 'progress', id: progressId, steps: [step] });
    } else {
      replace(progressId, (i) => {
        if (i.kind !== 'progress') return i;
        const at = i.steps.findIndex((s) => s.callId === callId && s.text === text);
        // A later update of the same line keeps the live detail it had unless it brings a new one.
        const steps = at >= 0 ? i.steps.map((s, k) => (k === at ? { ...step, ...(!step.detail && s.detail ? { detail: s.detail } : {}) } : s)) : [...i.steps, step];
        return { ...i, steps };
      });
    }
    emit();
  }

  /**
   * Settles the steps of one tool call. The call's first step is its main one: it takes the final detail whatever
   * its state (a tool marks it done before it returns). Other steps of the call (a source that did not answer)
   * only change state if still running.
   */
  function settleProgress(callId: string, failed: boolean, detail?: string): void {
    if (progressId === null) return;
    replace(progressId, (i) => {
      if (i.kind !== 'progress') return i;
      const main = i.steps.findIndex((s) => s.callId === callId);
      return {
        ...i,
        steps: i.steps.map((s, k) => {
          if (s.callId !== callId) return s;
          const state = s.state === 'running' ? (failed ? 'failed' : 'done') : s.state;
          if (k === main) {
            // The main step drops its live line; a final detail (only on success) replaces it.
            const base: ProgressStep = { callId: s.callId, text: s.text, state, ...(s.tool ? { tool: s.tool } : {}) };
            return !failed && detail ? { ...base, detail } : base;
          }
          return { ...s, state };
        }),
      };
    });
  }

  function clearToolTimer(callId: string): void {
    const t = toolTimers.get(callId);
    if (t !== undefined) timers.clearTimeout(t);
    toolTimers.delete(callId);
  }

  function runTool(callId: string, name: string, args: Record<string, unknown>): void {
    const mine = batch;
    const ac = new AbortController();
    toolAborts.set(callId, ac);
    toolTimers.set(
      callId,
      timers.setTimeout(() => {
        toolTimers.delete(callId);
        if (batch === mine && mine?.pending.has(callId)) dispatch({ type: 'ToolTimeout', toolCallId: callId });
      }, TOOL_TIMEOUT_MS),
    );
    let run: Promise<ToolRunOutput>;
    try {
      run = runner.run(
        { id: callId, name, args },
        {
          signal: ac.signal,
          progress: (text, state = 'running', detail) => {
            if (batch === mine && !ac.signal.aborted) progressFor(callId, text, state, name, detail);
          },
        },
      );
    } catch {
      run = Promise.resolve({ content: toolErrorContent('tool_failed', 'That did not work.') });
    }
    void run
      .catch((): ToolRunOutput => ({ content: toolErrorContent('tool_failed', 'That did not work.') }))
      .then((out) => {
        toolAborts.delete(callId);
        clearToolTimer(callId);
        // Abandoned by Stop, Clear, timeout or a newer batch: the machine already has its answer.
        if (batch !== mine || ac.signal.aborted || !mine || !mine.pending.has(callId)) return;
        settleProgress(callId, contentFailed(out.content), out.detail);
        if (out.results && out.results.length > 0) push({ kind: 'results', id: newId('s'), results: out.results as ResultCardView[] });
        if (out.question) push({ kind: 'question', id: newId('q'), question: out.question.question, options: out.question.options });
        if (out.link) push({ kind: 'link', id: newId('l'), label: out.link.label, target: out.link.target });
        mine.pending.delete(callId);
        mine.results.set(callId, out.content);
        if (mine.pending.size === 0) {
          batch = null;
          dispatch({ type: 'ToolsDone', results: [...mine.results].map(([toolCallId, content]) => ({ toolCallId, content })) });
        } else emit();
      });
  }

  function cancelTools(callIds?: string[]): void {
    const ids = callIds ?? [...toolAborts.keys()];
    for (const id of ids) {
      toolAborts.get(id)?.abort();
      toolAborts.delete(id);
      clearToolTimer(id);
      batch?.pending.delete(id);
      settleProgress(id, true);
    }
    if (!callIds) {
      batch = null;
      return;
    }
    // A timeout cancelled the last running call. Calls that already finished are held here, not in the
    // turn machine, so hand them over now or the turn waits in runningTools for ever.
    const mine = batch;
    if (mine && mine.pending.size === 0) {
      batch = null;
      dispatch({ type: 'ToolsDone', results: [...mine.results].map(([toolCallId, content]) => ({ toolCallId, content })) });
    }
  }

  // ---- cards ----------------------------------------------------------------------------------------
  function createCard(cardId: string, callId: string, tool: string, args: Record<string, unknown>): void {
    preparing.add(cardId);
    const job = (async () => {
      let result: ProposalCardView | { error: string };
      try {
        result = await timed(
          runner.prepareCard(cardId, tool, args).catch((): { error: string } => ({ error: 'That could not be set up.' })),
          PREP_TIMEOUT_MS,
          { error: SLOW_PREP },
        );
      } catch {
        result = { error: 'That could not be set up.' };
      }
      preparing.delete(cardId);
      // Cleared, expired (target gone, replaced) or the Assistant turned off while preparing: nothing to show.
      // The turn machine still lists the card as pending, so it is settled as expired here.
      if (dropPrepared.delete(cardId) || !getPrefs().enabled) {
        if (turn.pendingCards.includes(cardId)) dispatch({ type: 'CardSettled', cardId, kind: 'expired' });
        return;
      }
      if (!turn.pendingCards.includes(cardId)) return;
      if ('error' in result) {
        refused.set(callId, result.error);
        dispatch({ type: 'CardSettled', cardId, kind: 'dismissed' });
        return;
      }
      closeStreaming();
      if (result.tool === 'propose_plan' && result.steps && result.steps.length > 0) planSizes.set(cardId, result.steps.length);
      push({ kind: 'card', id: cardId, view: result, state: { kind: 'proposed', cardId } });
      emit();
    })();
    const tracked: Promise<void> = job.finally(() => preps.delete(tracked));
    preps.add(tracked);
  }

  /** Resolves with `fallback` when `p` has not settled after `ms`. Whichever comes first wins, once. */
  function timed<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const t = timers.setTimeout(() => resolve(fallback), ms);
      void p.then(
        (v) => {
          timers.clearTimeout(t);
          resolve(v);
        },
        () => {
          timers.clearTimeout(t);
          resolve(fallback);
        },
      );
    });
  }

  /** EXPIRE a card. One that is mid-action ignores it, so it expires the moment its action stops. */
  function expireCard(cardId: string, caption: string): void {
    if (preparing.has(cardId)) {
      // Not on screen yet: drop it when it is ready (and let the turn stop waiting for it now).
      dropPrepared.add(cardId);
      return;
    }
    cardEvent(cardId, { type: 'EXPIRE', caption });
    const k = cardItem(cardId)?.state.kind;
    if (k === 'confirming' || k === 'executing') expireOnSettle.set(cardId, caption);
  }

  function cardItem(cardId: string): (ChatItem & { kind: 'card' }) | undefined {
    const i = items.find((x) => x.kind === 'card' && x.id === cardId);
    return i && i.kind === 'card' ? i : undefined;
  }

  /** Applies one cardMachine event, runs its effects, and reports a settled card to the turn machine. */
  function cardEvent(cardId: string, event: CardEvent): void {
    const item = cardItem(cardId);
    if (!item) return;
    let step = cardStep(item.state, event);
    if (step.state === item.state) return;
    const caption = expireOnSettle.get(cardId);
    if (caption !== undefined) {
      if (step.state.kind === 'proposed' || step.state.kind === 'failed') {
        // The action stopped (recheck refused, or it failed): the card was already replaced or switched off.
        expireOnSettle.delete(cardId);
        step = cardStep(step.state, { type: 'EXPIRE', caption });
      } else if (step.state.kind === 'done' || step.state.kind === 'dismissed' || step.state.kind === 'expired') expireOnSettle.delete(cardId);
    }
    setCardState(cardId, step.state);
    for (const eff of step.effects) runCardEffect(eff, cardId);
    const kind = cardSettledKind(step.state);
    if (kind) {
      const note = cardNote(cardId, step.state);
      const settled: TurnEvent = { type: 'CardSettled', cardId, kind, ...(note ? { note } : {}) };
      if (draining) queue.push(settled);
      else dispatch(settled);
    } else if (!draining) emit();
  }

  /** What the model should hear about a card the user settled. Expired cards say nothing. */
  function cardNote(cardId: string, state: CardState): string | undefined {
    switch (state.kind) {
      case 'done':
        return `User confirmed ${cardId}: ${state.summary ?? 'Done.'}`;
      case 'dismissed':
        return `User dismissed ${cardId}.`;
      case 'failed':
        return `${cardId} failed: ${state.error ?? 'It did not work.'}`;
      default:
        return undefined;
    }
  }

  function setCardState(cardId: string, state: CardState): void {
    replace(cardId, (i) => (i.kind === 'card' ? { ...i, state } : i));
  }

  function runCardEffect(eff: CardEffect, cardId: string): void {
    switch (eff.type) {
      case 'revalidate': {
        const ac = new AbortController();
        void timed(
          runner.revalidate(cardId, ac.signal).catch(
            (): RevalidateResult => ({ ok: false, reason: 'Could not check this right now. Try again.' }),
          ),
          REVALIDATE_TIMEOUT_MS,
          { ok: false, reason: SLOW_CHECK } as RevalidateResult,
        )
          .then((r) => cardEvent(cardId, r.ok ? { type: 'REVALIDATED', ok: true } : { type: 'REVALIDATED', ok: false, reason: r.reason }));
        break;
      }
      case 'execute':
        void (planSizes.has(cardId)
          ? runPlan(cardId, planSizes.get(cardId) as number)
          : timed(
              runner.execute(cardId).catch((): ExecuteResult => ({ ok: false, code: 'failed', message: 'That did not work. Try again.' })),
              EXECUTE_TIMEOUT_MS,
              { ok: false, code: 'timeout', message: SLOW_RUN } as ExecuteResult,
            )
        )
          .catch((): ExecuteResult => ({ ok: false, code: 'failed', message: 'That did not work. Try again.' }))
          .then((r) => cardEvent(cardId, r.ok ? { type: 'EXEC_OK', summary: r.summary } : { type: 'EXEC_ERR', code: r.code, message: r.message }));
        break;
      case 'appendToolNote': {
        const done = cardItem(cardId);
        if (done?.state.summary) pushNote(done.state.summary);
        break;
      }
    }
  }

  /**
   * Runs a multi-step plan card through SM-39 (planMachine). The card as a whole was checked on Confirm; here every
   * step is checked again right before it runs (target exists, free space, admit), because the earlier steps change
   * the world. A failing step stops the plan and the later steps never run. A retry starts after the steps that ran.
   */
  async function runPlan(cardId: string, total: number): Promise<ExecuteResult> {
    const from = planDone.get(cardId) ?? 0;
    let plan: PlanState;
    let queue: PlanEffect[];
    if (from > 0) {
      plan = { kind: 'running', total, index: from, phase: 'revalidating' };
      queue = [{ type: 'revalidate', step: from }];
    } else {
      const first = planStep(planInitial(total), { type: 'CONFIRM', checks: Array.from({ length: total }, () => ({ ok: true })) });
      plan = first.state;
      queue = [...first.effects];
    }
    const feed = (event: PlanEvent): void => {
      const r = planStep(plan, event);
      plan = r.state;
      queue.push(...r.effects);
    };
    for (let eff = queue.shift(); eff; eff = queue.shift()) {
      switch (eff.type) {
        case 'revalidate': {
          const r: RevalidateResult = await timed(
            runner.revalidate(stepId(cardId, eff.step)).catch((): RevalidateResult => ({ ok: false, reason: 'Could not check this right now. Try again.' })),
            REVALIDATE_TIMEOUT_MS,
            { ok: false, reason: SLOW_CHECK } as RevalidateResult,
          );
          feed(r.ok ? { type: 'STEP_REVALIDATED', ok: true } : { type: 'STEP_REVALIDATED', ok: false, reason: r.reason });
          break;
        }
        case 'execute': {
          const r: ExecuteResult = await timed(
            runner.execute(stepId(cardId, eff.step)).catch((): ExecuteResult => ({ ok: false, code: 'failed', message: 'That did not work. Try again.' })),
            EXECUTE_TIMEOUT_MS,
            { ok: false, code: 'timeout', message: SLOW_RUN } as ExecuteResult,
          );
          if (r.ok) {
            planDone.set(cardId, eff.step + 1);
            feed({ type: 'STEP_OK' });
          } else feed({ type: 'STEP_ERR', message: r.message });
          break;
        }
        case 'halt':
          return { ok: false, code: 'plan_halted', message: planStopMessage(eff.step, total, eff.message, eff.notRun) };
        case 'summary':
          return { ok: true, summary: eff.text };
        default:
          break;
      }
    }
    return { ok: false, code: 'plan_halted', message: 'The plan stopped. Try again.' };
  }

  // ---- public actions -------------------------------------------------------------------------------
  function send(text: string): void {
    const p = getPrefs();
    dispatch({ type: 'Send', text, enabled: p.enabled, warningAccepted: p.warningAcceptedAt !== null, hasKey: hasKey() });
  }
  /** A tap on a question chip: lock the question and send the option as the user's next message. */
  function answer(itemId: string, option: string): void {
    const q = items.find((i) => i.id === itemId);
    if (!q || q.kind !== 'question' || q.answered !== undefined || !q.options.includes(option)) return;
    if (turn.kind !== 'idle' && turn.kind !== 'awaitingConfirmation') return;
    replace(itemId, (i) => (i.kind === 'question' ? { ...i, answered: option } : i));
    send(option);
  }
  function stop(): void {
    // The turn machine's `Stop` means "the stream ended". The Stop button is `Abort`.
    dispatch({ type: 'Abort' });
  }
  function clear(): void {
    dispatch({ type: 'Clear' });
  }
  function confirm(cardId: string): void {
    dispatch({ type: 'Confirm', cardId });
  }
  function dismiss(cardId: string): void {
    dispatch({ type: 'Dismiss', cardId });
  }
  function retryLast(): void {
    // Only a turn that ended in an error with Retry can be re-run.
    const tail = items[items.length - 1];
    if (!tail || tail.kind !== 'error' || tail.action !== 'retry') return;
    const p = getPrefs();
    dispatch({ type: 'Retry', enabled: p.enabled, warningAccepted: p.warningAcceptedAt !== null, hasKey: hasKey() });
  }
  /** The model is asked about the handle. The bubble shows the result's title, never "r3". */
  function askAbout(handle: string): void {
    if (!HANDLE_RE.test(handle)) return;
    let title: string | undefined;
    for (const i of items) {
      if (i.kind !== 'results') continue;
      const hit = i.results.find((r) => r.handle === handle);
      if (hit) {
        if (hit.expired) return; // restored from a saved chat: the handle is from a past session
        title = hit.title;
      }
    }
    const p = getPrefs();
    dispatch({
      type: 'Send',
      text: `Tell me more about ${handle}. Is it a good pick?`,
      display: title ? `Tell me about ${title}` : 'Tell me more about this one. Is it a good pick?',
      enabled: p.enabled,
      warningAccepted: p.warningAcceptedAt !== null,
      hasKey: hasKey(),
    });
  }

  const controller: ChatController = {
    getSnapshot() {
      if (!snapshot) snapshot = build();
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      const enabled = getPrefs().enabled;
      const had = hasKey();
      const wasEnabled = lastEnabled;
      const hadKey = lastHadKey;
      lastEnabled = enabled;
      lastHadKey = had;
      if (hadKey && !had) dispatch({ type: 'Clear' }); // SM-42 KEY_REMOVED
      else if (wasEnabled && !enabled) dispatch({ type: 'Disabled' });
      else emit();
    },
    background() {
      // Intentionally nothing: leaving the app does not stop a turn.
    },
    setFocused(f) {
      focused = f;
      if (f && unseen) {
        setUnseen(false);
        emit();
      }
    },
    targetGone(target) {
      dispatch({ type: 'TargetGone', target });
    },
  };
  return controller;
}
