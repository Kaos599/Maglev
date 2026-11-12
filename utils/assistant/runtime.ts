/**
 * Contract between the assistant's moving parts (build steps 12 and 13, docs/ASSISTANT_DESIGN.md §10).
 * Types only. No React, no engine, no expo imports (C-ASSIST-8).
 *
 *   ToolRunner      utils/assistant/toolRunner.ts       runs tools against search and the engine, owns card facts
 *   AssistantChat   utils/assistantApp/useAssistantChat.ts  drives turnMachine + cardMachine + the provider stream
 *   UI              components/assistant/*               renders AssistantChat; never calls the model or the engine
 *
 * Every string a view model carries is already plain English, sanitised and ready to show. The UI does no
 * formatting beyond layout. Facts on cards come from the app, never from the model (§4.5).
 */
import type { CardState } from './cardMachine.ts';
import type { Chip } from './glossary.ts';
import type { HandleRegistry } from './handles.ts';
import type { SafetyLevel } from './fileSafety.ts';
import type { Label, Tier } from './scoring.ts';

// ---------------------------------------------------------------- view models

/** One shortlisted search result, rendered by the app from `Ranked` (§9 "Result cards"). */
export interface ResultCardView {
  /** Session handle, e.g. "r1". */
  handle: string;
  /** Clean title and year from the parser, e.g. "The Last Harbor (2023)". */
  title: string;
  /** Quality tokens in order, each a tappable jargon chip ("WEB-DL", "1080p", "x265", "10-bit"). */
  chips: Chip[];
  /** e.g. "2.1 GB". */
  sizeText: string;
  /** e.g. "120 sharing". Uses "sharing", never "seeders" (R1-15). */
  sharingText: string;
  /** Short source names, e.g. "Knaben, YTS". */
  sourcesText: string;
  fit: 'fits' | 'tight' | 'too_big' | 'unknown';
  /** e.g. "9 GB left after". Empty when unknown. */
  fitText: string;
  /** Plain reasons from scoring (§3.5), at most 3. */
  reasons: string[];
  tier: Tier;
  /** Badge on the shortlisted three only. */
  label?: Label;
  /** SEARCH_CONTRACT §7 warning line when a source is flagged risky. */
  riskyWarning?: string;
  /** Present only after get_result_details looked inside. Red shows a danger banner. */
  safety?: { level: SafetyLevel; text: string };
}

/** A proposal awaiting the user's tap (§9 "Proposal cards"). */
export interface ProposalCardView {
  cardId: string;
  /** The proposal tool that made it, e.g. "propose_add". */
  tool: string;
  /** "Add torrent?", "Pause this download?", "Remove 3 files?", "Remove download?", "Run these 3 steps?" */
  title: string;
  /**
   * The name as the source gave it (sanitised, but not checked by Maglev). Rendered on its own row, labelled
   * "Name from the source", never inside `facts`, so a crafted name can't pass as a Maglev fact.
   */
  sourceName?: string;
  /** App-computed lines only: "5 files · 3.2 GB", "Needs 3.2 GB · 9 GB left after", "Saves to Download/Maglev". */
  facts: string[];
  /** The model's one-sentence reason, output-filtered. Shown under "Assistant says". */
  reason?: string;
  /** Verb label: "Add · 2.1 GB", "Pause", "Resume", "Remove 3 files", "Remove download", "Run 3 steps". */
  confirmLabel: string;
  /** "Not now". */
  dismissLabel: string;
  /** Destructive: danger tone on Confirm and the NATIVE_CONTRACT §14 copy in `facts`. */
  danger: boolean;
  /** A source is flagged risky: the UI shows the existing "Add from a risky source?" sheet before confirm(). */
  risky: boolean;
  /** propose_plan only: one line per step. */
  steps?: string[];
}

export interface ProgressStep {
  /** The tool call this step belongs to. */
  callId: string;
  /** Real facts only: "Searching 4 sources", "Looking inside r1", "Checking space", "Knaben didn't answer". */
  text: string;
  state: 'running' | 'done' | 'failed';
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  /** Output-filtered model text. `streaming` while the round-trip is still sending it. */
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'progress'; id: string; steps: ProgressStep[] }
  | { kind: 'results'; id: string; results: ResultCardView[] }
  | { kind: 'card'; id: string; view: ProposalCardView; state: CardState }
  /** One-line app note: "Added.", "Freed 1.9 GB.", "Stopped." */
  | { kind: 'note'; id: string; text: string }
  /** SM-31 error copy. `action` is the one recovery the UI offers. */
  | { kind: 'error'; id: string; message: string; action?: 'settings' | 'retry' };

/** Why the composer is locked (R1-6 send gate). 'ready' means Send works. */
export type ChatGate = 'ready' | 'disabled' | 'notAccepted' | 'noKey';

/** What the chat screen renders and calls. Produced by useAssistantChat. */
export interface AssistantChat {
  items: ChatItem[];
  gate: ChatGate;
  /** A turn is in flight (requesting, streaming or running tools): Send becomes Stop. */
  busy: boolean;
  /** e.g. "OpenRouter". Used in "Your messages and the names of your downloads go to <provider>." */
  providerName: string;
  /** Tokens used on this provider, all time (D4: tokens, not money). */
  tokensUsed: { input: number; output: number };
  send(text: string): void;
  stop(): void;
  /** SM-42 CLEAR: chat, cards and handles go. */
  clear(): void;
  /** Call after any risky-source sheet was accepted. */
  confirm(cardId: string): void;
  dismiss(cardId: string): void;
  /** "Ask about this" on a result card: sends a canned question naming the handle. */
  askAbout(handle: string): void;
  /** "Choose files" on a result card: the magnet or .torrent URL to open in the Add sheet, if known. */
  sourceFor(handle: string): string | undefined;
}

// ---------------------------------------------------------------- tool runner (step 12)

export interface ToolRunContext {
  /** Aborted on Stop, Clear, key removal, backgrounding and the 60 s tool timeout (R1-5). */
  signal: AbortSignal;
  /** Report a progress line for this call. Calling again with the same text updates its state. */
  progress(text: string, state?: ProgressStep['state']): void;
}

export interface ToolRunOutput {
  /** The role:"tool" message content: JSON `{ok:true,data}` or `{ok:false,error:{code,message}}`, sanitised (§4.1). */
  content: string;
  /** search_torrents: the shortlist to render as result cards. */
  results?: ResultCardView[];
}

export type RevalidateResult = { ok: true } | { ok: false; reason: string };
export type ExecuteResult = { ok: true; summary: string } | { ok: false; code: string; message: string };

export interface ToolRunner {
  /** The one handle registry for the session (R1-10). The turn machine validates arguments against it. */
  readonly registry: HandleRegistry;
  /** Run one read tool. Never throws: failures become `{ok:false}` content. Cancelled → error code "cancelled". */
  run(call: { id: string; name: string; args: Record<string, unknown> }, ctx: ToolRunContext): Promise<ToolRunOutput>;
  /**
   * Build the card for a proposal tool the turn machine accepted. Computes the facts from fresh engine and
   * search data. Refuses (returns `error`, which becomes the tool result) on: unknown handle, red safety on
   * propose_add (R1-8), a plan with a destructive or dependent step (R1-2).
   */
  prepareCard(cardId: string, tool: string, args: Record<string, unknown>): Promise<ProposalCardView | { error: string }>;
  /** On Confirm (§4.5): target still exists, indices in range, admit() again with fresh free space. */
  revalidate(cardId: string, signal?: AbortSignal): Promise<RevalidateResult>;
  /** Run the confirmed action against the engine. `message` is plain English (SM-36 copy for the code). */
  execute(cardId: string): Promise<ExecuteResult>;
  /** The transfer or result handle a card acts on, for TargetGone and "newer card for the same target". */
  cardTarget(cardId: string): string | undefined;
  /** Magnet or .torrent URL for a result handle. */
  sourceFor(handle: string): string | undefined;
  /** Clear: forget results, cards and handles. */
  reset(): void;
}
