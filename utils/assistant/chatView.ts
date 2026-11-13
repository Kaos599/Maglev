/**
 * Pure view helpers for the chat (no React, no expo, no engine): tool to label/icon, the "Steps" summary,
 * the "What's inside" summary, a tiny safe text formatter, token wording and the starter prompts.
 * Everything here is plain English and total: unknown input degrades to a sensible fallback, never throws.
 */
import type { ChatPhase, FileKind, ProgressStep, ResultDetailsView, ScreenTarget } from './runtime.ts';

/** Icon names this file may ask for. All exist in components/icons.generated.ts. */
export type ViewIcon =
  | 'search'
  | 'folder'
  | 'transfers'
  | 'storage'
  | 'file'
  | 'warning'
  | 'clock'
  | 'check'
  | 'file-video'
  | 'file-audio'
  | 'file-image'
  | 'file-archive'
  | 'file-doc'
  | 'file-app';

export interface ToolMeta {
  icon: ViewIcon;
  /** While it runs: "Searching". */
  running: string;
  /** Finished: "Searched". */
  done: string;
  /** Did not finish: "Couldn't search". */
  failed: string;
}

const META: Record<string, ToolMeta> = {
  search_torrents: { icon: 'search', running: 'Searching', done: 'Searched', failed: "Couldn't search" },
  browse_torrents: { icon: 'search', running: 'Looking at what is out', done: 'Looked at what is out', failed: "Couldn't list" },
  get_result_details: { icon: 'folder', running: 'Looking inside', done: 'Looked inside', failed: "Couldn't look inside" },
  parse_release_name: { icon: 'file-doc', running: 'Reading the name', done: 'Read the name', failed: "Couldn't read the name" },
  get_free_space: { icon: 'storage', running: 'Checking space', done: 'Checked space', failed: "Couldn't check space" },
  list_transfers: { icon: 'transfers', running: 'Checking your downloads', done: 'Checked your downloads', failed: "Couldn't check your downloads" },
  get_transfer_details: { icon: 'transfers', running: 'Looking at a download', done: 'Looked at a download', failed: "Couldn't look at a download" },
  explain_error: { icon: 'warning', running: 'Finding out what went wrong', done: 'Found out what went wrong', failed: "Couldn't find out what went wrong" },
};

const FALLBACK: ToolMeta = { icon: 'check', running: 'Working', done: 'Done', failed: "Couldn't finish" };

export function toolMeta(tool: string | undefined): ToolMeta {
  return (tool && META[tool]) || FALLBACK;
}

/** The label for one step, by state. Falls back to the step's own text when the tool is unknown. */
export function stepLabel(step: ProgressStep): string {
  const known = step.tool ? META[step.tool] : undefined;
  if (!known) return step.text;
  const base = step.state === 'running' ? known.running : step.state === 'failed' ? known.failed : known.done;
  if (step.tool === 'search_torrents') {
    const n = /(\d+)\s+sources?/i.exec(step.text);
    if (n) return `${base} ${n[1]} source${n[1] === '1' ? '' : 's'}`;
  }
  if (step.tool === 'get_result_details') {
    const h = /\br\d+\b/.exec(step.text);
    if (h) return `${base} ${h[0]}`;
  }
  return base;
}

/** The step's icon: a warning when it failed, else the tool's icon. */
export function stepIcon(step: ProgressStep): ViewIcon {
  return step.state === 'failed' ? 'warning' : toolMeta(step.tool).icon;
}

/** The expanded line: the plain detail if the app gave one, else the step's own text when it says more than the label. */
export function stepDetail(step: ProgressStep): string {
  if (step.detail) return step.detail;
  return step.text && step.text !== stepLabel(step) ? step.text : '';
}

/**
 * One line for the collapsed "Steps" header: "Searched 4 sources · Looked inside r1".
 * While a step runs it names that step instead, so the header always says what is happening.
 */
export function stepsSummary(steps: ProgressStep[]): string {
  if (steps.length === 0) return '';
  const running = steps.filter((s) => s.state === 'running');
  if (running.length > 0) return `${stepLabel(running[running.length - 1])}…`;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of steps) {
    if (s.state === 'failed') continue;
    const l = stepLabel(s);
    if (!seen.has(l)) {
      seen.add(l);
      parts.push(l);
    }
  }
  const failed = steps.filter((s) => s.state === 'failed').length;
  if (parts.length > 3) parts.splice(3, parts.length - 3, `${parts.length - 3} more`);
  if (failed > 0) parts.push(failed === 1 ? '1 step failed' : `${failed} steps failed`);
  return parts.join(' · ');
}

/**
 * Whether the "Steps" list is open. The user's own choice (`true`/`false`) always wins; with none, it opens by
 * itself while a step runs so its progress is visible, and rests closed once the turn is over.
 */
export function traceOpen(userChoice: boolean | null, steps: ProgressStep[]): boolean {
  return userChoice ?? stepsRunning(steps);
}

/** The words next to the working squares, or null when the turn already shows its own progress. */
export function workingLabel(phase: ChatPhase | undefined): string | null {
  return phase === 'thinking' ? 'Thinking\u2026' : null;
}

/** True when any step is still running. */
export function stepsRunning(steps: ProgressStep[]): boolean {
  return steps.some((s) => s.state === 'running');
}

// ---------------------------------------------------------------- What's inside

const KIND_ORDER: FileKind[] = ['video', 'audio', 'subtitle', 'image', 'archive', 'app', 'book', 'text', 'other'];
const KIND_WORDS: Record<FileKind, [string, string]> = {
  video: ['video', 'videos'],
  audio: ['audio file', 'audio files'],
  subtitle: ['subtitle', 'subtitles'],
  image: ['image', 'images'],
  archive: ['archive', 'archives'],
  app: ['app', 'apps'],
  book: ['book', 'books'],
  text: ['text file', 'text files'],
  other: ['other file', 'other files'],
};

/** "1 video · 3 subtitles · 4.2 GB". Uses the total from the file list, never the .torrent's own size. */
export function kindsSummary(d: ResultDetailsView): string {
  const parts: string[] = [];
  for (const k of KIND_ORDER) {
    const n = d.kinds?.[k] ?? 0;
    if (n > 0) parts.push(`${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`);
  }
  if (parts.length === 0 && d.fileCount > 0) parts.push(`${d.fileCount} ${d.fileCount === 1 ? 'file' : 'files'}`);
  if (d.totalText) parts.push(d.totalText);
  return parts.join(' · ');
}

const KIND_ICON: Record<FileKind, ViewIcon> = {
  video: 'file-video',
  audio: 'file-audio',
  subtitle: 'file-doc',
  image: 'file-image',
  archive: 'file-archive',
  app: 'file-app',
  book: 'file-doc',
  text: 'file-doc',
  other: 'file',
};

export function kindIcon(kind: FileKind): ViewIcon {
  return KIND_ICON[kind] ?? 'file';
}

// ---------------------------------------------------------------- light formatting

export interface Span {
  text: string;
  bold?: boolean;
}
export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'ul'; items: Span[][] }
  | { type: 'ol'; items: Span[][] };

/** Bold spans from **x**. Links and images collapse to their label, code ticks and stray markers are dropped. */
export function parseInline(raw: string): Span[] {
  const text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/__(.+?)__/g, '**$1**');
  const out: Span[] = [];
  const re = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.map((s) => (s.bold ? s : { text: s.text.replace(/\*\*/g, '') })).filter((s) => s.text.length > 0);
}

/**
 * Paragraphs, "- " / "* " bullet lists, "1." numbered lists and **bold**. Headings become bold lines.
 * Nothing else is interpreted: no links, no images, no HTML. Safe on partial text while it streams.
 */
export function parseLight(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: Span[][] } | null = null;
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: 'p', spans: parseInline(para.join(' ')) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (t === '') {
      flushPara();
      flushList();
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(t);
    const num = /^\d+[.)]\s+(.*)$/.exec(t);
    const head = /^#{1,6}\s+(.*)$/.exec(t);
    if (bullet || num) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push(parseInline((bullet ?? num)![1]));
    } else if (head) {
      flushPara();
      flushList();
      blocks.push({ type: 'p', spans: parseInline(head[1]).map((s) => ({ ...s, bold: true })) });
    } else {
      flushList();
      para.push(t);
    }
  }
  flushPara();
  flushList();
  return blocks.filter((b) => (b.type === 'p' ? b.spans.length > 0 : b.items.length > 0));
}

// ---------------------------------------------------------------- empty state and composer

/** One-tap prompts on the empty chat. */
export const SUGGESTIONS: readonly string[] = [
  "What's new in movies this week?",
  'Popular shows right now',
  'Why is my download stuck?',
  'What does WEB-DL mean?',
  'Suggest a good book to read',
  'How do I download a game?',
];

/** 950 -> "950", 12400 -> "12.4k", 2300000 -> "2.3M". */
export function compactCount(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "12.4k tokens used" in plain words. Zero reads "No tokens used yet". */
export function tokensLine(used: { input: number; output: number }): string {
  const total = (used?.input ?? 0) + (used?.output ?? 0);
  return total > 0 ? `${compactCount(total)} tokens used` : 'No tokens used yet';
}

/** The model chip's text: the model if known, else the provider. */
export function modelChipText(modelName: string | undefined, providerName: string): string {
  return modelName?.trim() || providerName;
}

// ---------------------------------------------------------------- links to screens

export interface AppRoute {
  pathname: string;
  params?: Record<string, string>;
}

const SETTINGS_PATH: Record<NonNullable<Extract<ScreenTarget, { screen: 'settings' }>['section']>, string> = {
  storage: '/settings/storage',
  network: '/settings/network',
  assistant: '/settings/assistant',
  search_providers: '/settings/search-providers',
  schedule: '/settings/scheduling',
  speed: '/settings/speed',
  notifications: '/settings/notifications',
};

/**
 * ScreenTarget to an expo-router route. The Transfers and Search tabs keep their filter and query in local state
 * and take no route params, so those open the tab itself. Downloads from links (ids "dl_..." or the runner's
 * "dl:..." form) have no route of their own (a sheet on Transfers), so they open Transfers. Unknown shapes fall back to Transfers.
 */
export function routeForTarget(t: ScreenTarget): AppRoute {
  switch (t?.screen) {
    case 'transfer':
      if (typeof t.id === 'string' && t.id && !t.id.startsWith('dl_') && !t.id.startsWith('dl:')) return { pathname: '/torrent/[id]', params: { id: t.id } };
      return { pathname: '/' };
    case 'search':
      return typeof t.query === 'string' && t.query.trim() ? { pathname: '/search', params: { q: t.query.trim() } } : { pathname: '/search' };
    case 'add_download':
      return { pathname: '/add-download' };
    case 'settings':
      return { pathname: (t.section && SETTINGS_PATH[t.section]) || '/settings' };
    case 'transfers':
      return typeof t.filter === 'string' && t.filter ? { pathname: '/', params: { filter: t.filter } } : { pathname: '/' };
    default:
      return { pathname: '/' };
  }
}

/** Speech for a question once it is answered or shown. */
export function questionLabel(question: string, answered?: string): string {
  return answered ? `${question} You chose ${answered}.` : `${question} Choose one answer.`;
}

// ---------------------------------------------------------------- "What the Assistant can do" sheet

export const CAPABILITIES_TITLE = 'What the Assistant can do';

export const CAN_DO: readonly string[] = [
  'Find something to download and compare the copies: quality, size and how many people are sharing.',
  'Explain the words in file names, like WEB-DL or x265.',
  'Look inside a download before you add it.',
  'Check on your downloads and say why one is stuck.',
  'Get an add, pause, file choice or removal ready for you to confirm.',
  'Take you to the right screen or setting.',
];

export const CANT_DO: readonly string[] = [
  'Change anything without your tap. Every change is a card you confirm.',
  'Remember earlier chats. Leaving Maglev or tapping Clear ends the chat.',
  'Know the newest releases from memory. It searches for those.',
  "Tell you a file is safe, or what's legal where you live.",
];

export const CAPABILITIES_NOTE =
  'Free models are small. They can misread a question, stop early or pick the wrong result. Check every card before you confirm.';

/** The collapsed "Technical details" lines. `contextLabel` is optional and skipped when empty. */
export function capabilitiesFacts(info: { modelName?: string; providerName: string; contextLabel?: string }): string[] {
  const model = info.modelName?.trim() || (/openrouter/i.test(info.providerName) ? 'Auto (any free model)' : "the provider's default model");
  const context = info.contextLabel?.trim() ? ` Context ${info.contextLabel.trim()}.` : '';
  return [
    `Model: ${model} on ${info.providerName}.${context}`,
    'Each message can use up to 6 model requests, 8 tool calls and 2 cards, only 1 of which can delete.',
    'Tools: search by title, list what is new or popular, look inside a result, list downloads, ask you a question, open a screen, propose an add, propose a change.',
    'The model only sees names, sizes, sharing counts and file lists from the search sources you turned on, and the names of your downloads. It never sees your files.',
    'Every fact on a card is worked out by Maglev, not the model, and every tool call is checked before it runs.',
    'Smaller models sometimes answer without searching, make up details in their text, or send a broken tool call. Maglev rejects broken calls; the text can still be wrong.',
    "OpenRouter's free models are rate limited (about 20 requests a minute, and 50 a day on accounts with less than $10 of credit), and one message can use several requests.",
  ];
}

/** Open the sheet on first sight: chat is ready and the user never closed it before. */
export function shouldAutoOpenCapabilities(gate: string, seenAt: number | null): boolean {
  return gate === 'ready' && seenAt === null;
}
