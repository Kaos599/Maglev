// Tool definitions and argument validation for the assistant (ASSISTANT_DESIGN §4, SM-31 amendment D1, SM-39).
// The model sees OpenAI-style function definitions from TOOLS. Every call it makes goes through validateArgs,
// which checks the arguments against the schema in code, resolves session handles (r1, t1) to real ids, and
// rejects anything else. Pure TypeScript: no React, no React Native, no engine imports.
//
// Validation is hand-written and covers only the JSON Schema subset used here (object, array, string, integer,
// number, boolean, enum, length, range, pattern, uniqueItems). Every object is closed: unknown keys are rejected
// whether or not the schema says additionalProperties:false. Anthropic's compat layer ignores `strict`, so this
// check is required anyway (§7.3).

import type { HandleKind, HandleRegistry } from './handles.ts';
import { normalizeLanguage } from './releaseName.ts';
import { QUERY_MAX, sanitizeText } from './sanitize.ts';

/** The subset of JSON Schema used for tool parameters. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: string | number | boolean;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

export type ValidateResult =
  | { ok: true; args: Record<string, unknown>; /** Plain-English remarks about what was fixed or ignored, for the tool result. */ notes?: string[] }
  | { ok: false; error: { code: 'bad_args' | 'unknown_tool'; message: string } };

/** The eight tools the model sees (docs/ASSISTANT_DESIGN.md, 0.11). Few tools, because free models call many tools badly. */
export const READ_TOOL_NAMES = ['search_torrents', 'browse_torrents', 'get_result_details', 'list_transfers', 'ask_user', 'open_screen'] as const;

export const PROPOSAL_TOOL_NAMES = ['propose_add', 'propose_change', 'watch_title'] as const;

/**
 * Tools the model no longer sees. The runner still builds its cards and answers from the same code, and
 * validateArgs(..., internal = true) still accepts them, so propose_change and list_transfers reuse them.
 */
const LEGACY_TOOL_NAMES = [
  'parse_release_name',
  'get_free_space',
  'get_transfer_details',
  'explain_error',
  'propose_select_files',
  'propose_pause_resume',
  'propose_remove_files',
  'propose_delete',
  'propose_plan',
] as const;

type ExposedToolName = (typeof READ_TOOL_NAMES)[number] | (typeof PROPOSAL_TOOL_NAMES)[number];
type LegacyToolName = (typeof LEGACY_TOOL_NAMES)[number];
type ToolName = ExposedToolName | LegacyToolName;

/** Names of the read tools (run locally, return data). */
export const READ_TOOLS: ReadonlySet<string> = new Set<string>(READ_TOOL_NAMES);
/** Names of the proposal tools (create a card; nothing runs until the user confirms). */
export const PROPOSAL_TOOLS: ReadonlySet<string> = new Set<string>(PROPOSAL_TOOL_NAMES);

/**
 * Tools a plan step may use (R1-2). No plan inside a plan, and no destructive step: propose_delete and
 * propose_remove_files always get their own card.
 */
const PLAN_STEP_TOOL_NAMES = ['propose_add', 'propose_select_files', 'propose_pause_resume'] as const;

/** Destructive proposal tools. The turn machine allows at most one such card per turn (R1-4). */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set<string>(['propose_delete', 'propose_remove_files']);

/** Max steps in one plan (SM-39). */
const PLAN_MAX_STEPS = 6;

/** Handle fields and the kind of real id they stand for. Any other field is a plain value. */
const HANDLE_FIELD_KIND: Readonly<Record<string, HandleKind>> = {
  result_id: 'result',
  transfer_id: 'transfer',
};

const RESULT_ID: JsonSchema = {
  type: 'string',
  pattern: '^r[0-9]+$',
  description: 'Result id from search_torrents or browse_torrents, such as r1.',
};
const TRANSFER_ID: JsonSchema = {
  type: 'string',
  pattern: '^t[0-9]+$',
  description: 'Download id from list_transfers, such as t1.',
};
const FILE_INDEX: JsonSchema = { type: 'integer', minimum: 0 };
const FILE_INDEX_LIST = (maxItems: number, description?: string): JsonSchema => ({
  type: 'array',
  items: FILE_INDEX,
  maxItems,
  uniqueItems: true,
  description,
});
const REASON: JsonSchema = { type: 'string', maxLength: 200, description: 'One plain sentence for the user.' };

// ---- Read tools (ASSISTANT_DESIGN §4.2) ----

const SEARCH_TORRENTS: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2, maxLength: QUERY_MAX, description: 'Just the title. Add a year, season or episode only if the user gave one.' },
    category: {
      type: 'string',
      enum: ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
      default: 'all',
    },
    profile: { type: 'string', enum: ['phone', 'tv', 'archive'], default: 'phone' },
    sort: { type: 'string', enum: ['best', 'seeders', 'newest'], default: 'best', description: 'newest for latest releases, seeders for most popular.' },
    max_size_gb: { type: 'number', minimum: 0.1, maximum: 200 },
    min_resolution: { type: 'integer', enum: [480, 720, 1080, 2160] },
    max_resolution: { type: 'integer', enum: [480, 720, 1080, 2160] },
    min_seeders: { type: 'integer', minimum: 0, maximum: 1000, default: 1 },
    include_cam: { type: 'boolean', default: false },
    runtime_min: { type: 'integer', minimum: 1, maximum: 600, description: 'Runtime in minutes, if the user said it.' },
    limit: { type: 'integer', minimum: 1, maximum: 8, default: 6 },
    audio_language: {
      type: 'string', maxLength: 30,
      description: 'Only if the user named one: the audio language, such as hindi, or "dual audio". Copies with it rank first.',
    },
    subtitles: {
      type: 'string', maxLength: 30,
      description: 'Only if the user asked for subtitles: "any", or a language such as english. Copies with them rank first.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

/** Kinds, orders and periods browse_torrents takes (utils/search/browse.ts). */
const BROWSE_TORRENTS: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['movies', 'tv', 'anime', 'books', 'games', 'music', 'apps'] },
    order: { type: 'string', enum: ['new', 'popular'], default: 'new', description: 'new for latest releases, popular for most shared.' },
    period: { type: 'string', enum: ['day', 'week', 'month', 'year'], default: 'week' },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
  },
  required: ['kind'],
  additionalProperties: false,
};

const GET_RESULT_DETAILS: JsonSchema = {
  type: 'object',
  properties: {
    result_id: RESULT_ID,
    resolve_files: { type: 'boolean', default: true },
  },
  required: ['result_id'],
  additionalProperties: false,
};

const PARSE_RELEASE_NAME: JsonSchema = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: { type: 'string', maxLength: 200 },
      minItems: 1,
      maxItems: 10,
    },
  },
  required: ['names'],
  additionalProperties: false,
};

const GET_FREE_SPACE: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

const GET_TRANSFER_DETAILS: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    include_files: { type: 'boolean', default: false },
  },
  required: ['transfer_id'],
  additionalProperties: false,
};

const EXPLAIN_ERROR: JsonSchema = {
  type: 'object',
  properties: { transfer_id: TRANSFER_ID },
  required: ['transfer_id'],
  additionalProperties: false,
};

// ---- Proposal tools (ASSISTANT_DESIGN §4.3, SM-31 amendment). Each only creates a card. ----

const PROPOSE_ADD: JsonSchema = {
  type: 'object',
  properties: {
    result_id: RESULT_ID,
    file_indices: FILE_INDEX_LIST(500, 'Files to take. Omit to take every file.'),
    first_indices: FILE_INDEX_LIST(50, 'Files to fetch first. Must be a subset of file_indices.'),
    sequential: { type: 'boolean', default: false, description: 'Download in order so it can be watched while downloading.' },
    reason: REASON,
  },
  required: ['result_id'],
  additionalProperties: false,
};

const PROPOSE_SELECT_FILES: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    include: FILE_INDEX_LIST(500, 'Files to keep downloading.'),
    skip: FILE_INDEX_LIST(500, 'Files to stop downloading. They are not deleted.'),
    first: FILE_INDEX_LIST(500, 'Files to fetch first.'),
    reason: REASON,
  },
  required: ['transfer_id', 'reason'],
  additionalProperties: false,
};

const PROPOSE_PAUSE_RESUME: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    action: { type: 'string', enum: ['pause', 'resume'] },
    reason: REASON,
  },
  required: ['transfer_id', 'action', 'reason'],
  additionalProperties: false,
};

const PROPOSE_REMOVE_FILES: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    file_indices: {
      ...FILE_INDEX_LIST(200, 'Files to delete from the phone. Only files the user named.'),
      minItems: 1,
    },
    reason: REASON,
  },
  required: ['transfer_id', 'file_indices', 'reason'],
  additionalProperties: false,
};

const PROPOSE_DELETE: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    delete_files: { type: 'boolean', default: false, description: 'Also delete the files from the phone.' },
    reason: REASON,
  },
  required: ['transfer_id', 'reason'],
  additionalProperties: false,
};

const PROPOSE_TOOL_SCHEMAS: Record<'propose_add' | 'propose_select_files' | 'propose_pause_resume' | 'propose_remove_files' | 'propose_delete', JsonSchema> = {
  propose_add: PROPOSE_ADD,
  propose_select_files: PROPOSE_SELECT_FILES,
  propose_pause_resume: PROPOSE_PAUSE_RESUME,
  propose_remove_files: PROPOSE_REMOVE_FILES,
  propose_delete: PROPOSE_DELETE,
};

// A step's args are one closed object that lists every field any step tool uses. Which fields a given step
// may carry is then checked against that step tool's own schema in validateToolArgs (exact, with required).
const STEP_ARG_PROPERTIES: Record<string, JsonSchema> = {};
for (const name of PLAN_STEP_TOOL_NAMES) {
  const props = PROPOSE_TOOL_SCHEMAS[name as keyof typeof PROPOSE_TOOL_SCHEMAS].properties ?? {};
  for (const [key, schema] of Object.entries(props)) {
    if (!hasOwn(STEP_ARG_PROPERTIES, key)) STEP_ARG_PROPERTIES[key] = schema;
  }
}

const PROPOSE_PLAN: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: PLAN_MAX_STEPS,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...PLAN_STEP_TOOL_NAMES] },
          args: { type: 'object', properties: STEP_ARG_PROPERTIES, required: [], additionalProperties: false },
        },
        required: ['tool', 'args'],
        additionalProperties: false,
      },
      description: 'Up to 6 steps, run in order after one Confirm.',
    },
    reason: { type: 'string', maxLength: 200, description: 'One plain sentence for the user.' },
  },
  required: ['steps', 'reason'],
  additionalProperties: false,
};

const LIST_TRANSFERS_V2: JsonSchema = {
  type: 'object',
  properties: {
    filter: { type: 'string', enum: ['all', 'active', 'paused', 'error', 'finished'], default: 'all', description: 'Which downloads to list.' },
    transfer_id: { ...TRANSFER_ID, description: 'One download, such as t1. Gives its files, status and the fix for a problem.' },
  },
  required: [],
  additionalProperties: false,
};

const PROPOSE_CHANGE: JsonSchema = {
  type: 'object',
  properties: {
    transfer_id: TRANSFER_ID,
    action: {
      type: 'string',
      enum: ['pause', 'resume', 'select_files', 'remove_files', 'delete'],
      description: 'select_files keeps only file_indices. remove_files deletes file_indices from the phone. delete removes the download.',
    },
    file_indices: { ...FILE_INDEX_LIST(500, 'File numbers from list_transfers. Only for select_files and remove_files.'), minItems: 1 },
    delete_files: { type: 'boolean', default: false, description: 'delete only: also delete the files from the phone.' },
    reason: REASON,
  },
  required: ['transfer_id', 'action'],
  additionalProperties: false,
};

const WATCH_TITLE: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2, maxLength: QUERY_MAX, description: 'Just the title.' },
    category: {
      type: 'string',
      enum: ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
      default: 'all',
    },
    min_resolution: { type: 'integer', enum: [480, 720, 1080, 2160] },
    max_size_gb: { type: 'number', minimum: 0.1, maximum: 200 },
    reason: REASON,
  },
  required: ['query'],
  additionalProperties: false,
};

const ASK_USER: JsonSchema = {
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 3, maxLength: 160, description: 'One short question.' },
    options: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 40 },
      minItems: 2,
      maxItems: 5,
      uniqueItems: true,
      description: '2 to 5 short answers the user can tap.',
    },
  },
  required: ['question', 'options'],
  additionalProperties: false,
};

const OPEN_SCREEN: JsonSchema = {
  type: 'object',
  properties: {
    screen: { type: 'string', enum: ['transfers', 'transfer', 'search', 'add_download', 'settings'] },
    filter: { type: 'string', enum: ['all', 'downloading', 'paused', 'done', 'errors'], description: 'transfers only.' },
    transfer_id: { ...TRANSFER_ID, description: 'transfer only: the download to open, such as t1.' },
    query: { type: 'string', minLength: 1, maxLength: QUERY_MAX, description: 'search only: what to search for.' },
    section: {
      type: 'string',
      enum: ['storage', 'network', 'assistant', 'search_providers', 'schedule', 'speed', 'notifications'],
      description: 'settings only: which part of Settings.',
    },
  },
  required: ['screen'],
  additionalProperties: false,
};

const PARAMETERS: Record<ToolName, JsonSchema> = {
  search_torrents: SEARCH_TORRENTS,
  browse_torrents: BROWSE_TORRENTS,
  get_result_details: GET_RESULT_DETAILS,
  parse_release_name: PARSE_RELEASE_NAME,
  get_free_space: GET_FREE_SPACE,
  get_transfer_details: GET_TRANSFER_DETAILS,
  explain_error: EXPLAIN_ERROR,
  list_transfers: LIST_TRANSFERS_V2,
  propose_change: PROPOSE_CHANGE,
  watch_title: WATCH_TITLE,
  ask_user: ASK_USER,
  open_screen: OPEN_SCREEN,
  ...PROPOSE_TOOL_SCHEMAS,
  propose_plan: PROPOSE_PLAN,
};

// Short, plain English. Nothing here may mention adult content (D2).
const DESCRIPTIONS: Record<ToolName, string> = {
  search_torrents:
    'Search the enabled sources for torrents. Returns the best matches with size, sharing, upload age when known, and a space check. Just the title. Add a year, season or episode only if the user gave one.',
  browse_torrents:
    'List what is new or popular in a kind of thing, with no title. Use it for latest, new, recent, popular, trending, top requests. If any other words are left, they are a title: use search_torrents.',
  get_result_details:
    'Look inside one search result: its files, file safety check and space check. Slow. Call it before proposing a result.',
  parse_release_name:
    'Explain release names part by part: source, resolution, codec, HDR, audio and flags. Use for names the user pastes or asks about.',
  get_free_space:
    'Free space on the download folder, space promised to unfinished downloads, and what is left.',
  list_transfers:
    "The user's downloads with status, plain problem text, a fix, and free space. Pass transfer_id for one download's files and details.",
  get_transfer_details:
    'One download in detail: progress, connections and, optionally, its files with sizes.',
  explain_error:
    'Why a download is stuck, paused or failed, in plain words, with the fix the app offers. Use before guessing.',
  propose_change:
    'Propose a change to one download: pause, resume, select_files, remove_files or delete. Nothing changes until the user taps Confirm.',
  watch_title:
    'Propose watching for a title. Maglev checks in the background and notifies when a new match appears. Nothing starts until the user taps Confirm.',
  ask_user:
    'Ask the user to pick one option. Shows tappable answers. Use it instead of asking a question in text. Then stop and wait.',
  open_screen:
    'Offer a button that opens a screen in the app: transfers, one download, search, add a download, or a Settings section. Nothing opens until the user taps.',
  propose_add:
    'Propose adding a search result. Nothing is added until the user taps Confirm. Call get_result_details first.',
  propose_select_files:
    'Propose which files of a download to keep. Skipped files are not downloaded. Nothing changes until the user taps Confirm.',
  propose_pause_resume:
    'Propose pausing or resuming one download. Nothing changes until the user taps Confirm.',
  propose_remove_files:
    'Propose deleting some files of a download from the phone. This cannot be undone. Only use files the user named.',
  propose_delete:
    'Propose removing a whole download. Files stay on the phone unless delete_files is true. Nothing changes until the user taps Confirm.',
  propose_plan:
    'Propose up to 6 independent steps you want confirmed together: add, select files, pause or resume. A step cannot refer to a download created by an earlier step.',
};

/** OpenAI-compatible function definitions for every read and proposal tool. */
export const TOOLS: ToolDef[] = [
  ...READ_TOOL_NAMES.map((name) => toolDef(name)),
  ...PROPOSAL_TOOL_NAMES.map((name) => toolDef(name)),
];

/** Every tool name the runner understands, model-facing or not. */
export const ALL_TOOL_NAMES: readonly string[] = [...READ_TOOL_NAMES, ...PROPOSAL_TOOL_NAMES, ...LEGACY_TOOL_NAMES];

function toolDef(name: ToolName): ToolDef {
  return {
    type: 'function',
    function: { name, description: DESCRIPTIONS[name], parameters: PARAMETERS[name] },
  };
}

// ---- Generated summaries: the system prompt's "Your tools" list and the describe_tools result ----

/** One argument of a tool, read from its schema. */
export interface ToolArgInfo {
  name: string;
  type: string;
  required: boolean;
  /** Allowed values of an enum. */
  values?: Array<string | number | boolean>;
  default?: string | number | boolean;
  /** Range or length limits, e.g. "1 to 8". */
  limits?: string;
  description?: string;
}

export interface ToolInfo {
  name: string;
  kind: 'read' | 'propose';
  description: string;
  args: ToolArgInfo[];
}

function argType(schema: JsonSchema): string {
  if (schema.type === 'array') return `list of ${schema.items ? argType(schema.items) : 'values'}`;
  return schema.type ?? 'value';
}

function argLimits(schema: JsonSchema): string | undefined {
  if (schema.minimum !== undefined || schema.maximum !== undefined) return `${schema.minimum ?? ''} to ${schema.maximum ?? ''}`.trim();
  if (schema.maxItems !== undefined) return `up to ${schema.maxItems} items`;
  if (schema.maxLength !== undefined) return `up to ${schema.maxLength} characters`;
  return undefined;
}

function argsOf(name: ToolName): ToolArgInfo[] {
  const schema = PARAMETERS[name];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const info: ToolArgInfo = { name: key, type: argType(p), required: required.has(key) };
    if (p.enum) info.values = [...p.enum];
    if (p.default !== undefined) info.default = p.default;
    const limits = argLimits(p);
    if (limits) info.limits = limits;
    if (p.description) info.description = p.description;
    return info;
  });
}

/** Every tool, or the one named, with its full description and argument summary. Generated from the same schemas the model sees. */
export function describeTools(name?: string): { tools: ToolInfo[] } {
  const names: ExposedToolName[] = [...READ_TOOL_NAMES, ...PROPOSAL_TOOL_NAMES];
  const pick = name === undefined ? names : names.filter((n) => n === name);
  return {
    tools: pick.map((n) => ({
      name: n,
      kind: READ_TOOLS.has(n) ? 'read' : 'propose',
      description: DESCRIPTIONS[n],
      args: argsOf(n),
    })),
  };
}

/** Enums longer than this are not spelled out in the overview line. */
const OVERVIEW_ENUM_MAX = 5;
/** Arguments shown per line in the overview. */
const OVERVIEW_ARGS_MAX = 6;

/**
 * "Your tools" for the system prompt: one line per tool, name, plain purpose and key arguments. Generated from
 * the tool definitions so it cannot drift. Internal ids and the free-text `reason` are left out.
 */
export function toolsOverview(): string {
  return describeTools()
    .tools.map((t) => {
      const purpose = t.description.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
      const shown = t.args.filter((a) => a.name !== 'reason' && a.name !== 'steps' && !/_id$/.test(a.name));
      const parts = shown.slice(0, OVERVIEW_ARGS_MAX).map((a) =>
        a.values && a.values.length <= OVERVIEW_ENUM_MAX ? `${a.name} ${a.values.join('|')}` : a.name,
      );
      if (t.name === 'propose_plan') parts.unshift('steps');
      const more = shown.length > OVERVIEW_ARGS_MAX ? ', ...' : '';
      return `- ${t.name}: ${purpose}${parts.length > 0 ? ` (${parts.join(', ')}${more})` : ''}`;
    })
    .join('\n');
}

/**
 * Validate a tool call from the model. `rawArgs` is the parsed object or the JSON string the provider sent.
 * On success `args` holds the same fields, with handle fields replaced by the real ids from `registry`.
 * Errors carry plain English and never echo a real id or a hash.
 */
export function validateArgs(name: string, rawArgs: unknown, registry: HandleRegistry, internal = false): ValidateResult {
  const known = internal ? isToolName(name) : isExposedToolName(name);
  if (!known) {
    return { ok: false, error: { code: 'unknown_tool', message: 'There is no tool with that name.' } };
  }
  let input: unknown = rawArgs;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return bad('Arguments are not valid JSON.');
    }
  }
  if (!isPlainObject(input)) return bad('Arguments must be a JSON object.');
  return validateToolArgs(name as ToolName, input, registry);
}

function validateToolArgs(name: ToolName, input: Record<string, unknown>, registry: HandleRegistry): ValidateResult {
  const dropped: string[] = [];
  input = applyAliases(name, input);
  if (name === 'search_torrents') input = coerceLanguageArgs(input);
  input = normalizeNode(PARAMETERS[name], input, '', dropped) as Record<string, unknown>;
  const schemaError = checkNode(PARAMETERS[name], input, 'arguments');
  if (schemaError) return bad(schemaError);

  const notes = dropped.length === 0 ? undefined : [ignoredNote(dropped)];
  if (name === 'propose_plan') return withNotes(validatePlan(input, registry), notes);

  const args: Record<string, unknown> = { ...input };
  for (const field of Object.keys(HANDLE_FIELD_KIND)) {
    if (!hasOwn(args, field)) continue;
    const kind = HANDLE_FIELD_KIND[field];
    const real = registry.resolve(args[field], kind);
    if (real === null) return bad(unknownHandleMessage(field, kind));
    args[field] = real;
  }

  const crossError = crossFieldError(name, args);
  if (crossError) return bad(crossError);
  return notes ? { ok: true, args, notes } : { ok: true, args };
}

function withNotes(r: ValidateResult, notes: string[] | undefined): ValidateResult {
  if (!r.ok || !notes) return r;
  return { ...r, notes: [...(r.notes ?? []), ...notes] };
}

function ignoredNote(keys: string[]): string {
  const shown = [...new Set(keys)].slice(0, 3).join(', ');
  return `Ignored unknown field${new Set(keys).size === 1 ? '' : 's'} ${shown}.`;
}

// ---- Lenient input: small free models send slightly wrong shapes. Fix what is unambiguous, reject the rest. ----

const CATEGORY_SYNONYMS: Record<string, string> = {
  movie: 'movies', film: 'movies', films: 'movies', cinema: 'movies',
  show: 'tv', shows: 'tv', series: 'tv', 'tv show': 'tv', 'tv shows': 'tv', 'tv series': 'tv', television: 'tv',
  song: 'music', songs: 'music', album: 'music', albums: 'music',
  book: 'books', ebook: 'books', ebooks: 'books',
  game: 'games',
  app: 'apps', software: 'apps', application: 'apps', applications: 'apps',
};

const ENUM_SYNONYMS: Record<string, Record<string, string>> = {
  category: CATEGORY_SYNONYMS,
  sort: {
    popular: 'seeders', seeds: 'seeders', seeder: 'seeders', seeded: 'seeders', 'most seeded': 'seeders', 'most popular': 'seeders',
    latest: 'newest', new: 'newest', recent: 'newest', newer: 'newest', date: 'newest',
    relevance: 'best', relevant: 'best', default: 'best',
  },
  // browse_torrents
  kind: {
    ...CATEGORY_SYNONYMS,
    episodes: 'tv', episode: 'tv', animes: 'anime', cartoon: 'anime', cartoons: 'anime',
    audiobook: 'books', audiobooks: 'books', comic: 'books', comics: 'books', program: 'apps', programs: 'apps',
  },
  order: {
    latest: 'new', newest: 'new', recent: 'new', newer: 'new', fresh: 'new', date: 'new', 'date added': 'new', released: 'new',
    trending: 'popular', top: 'popular', best: 'popular', hot: 'popular', seeders: 'popular', seeds: 'popular', seeded: 'popular',
    'most popular': 'popular', 'most seeded': 'popular', 'most shared': 'popular', sharing: 'popular',
  },
  period: {
    today: 'day', daily: 'day', '24h': 'day', '24 hours': 'day', 'last 24 hours': 'day', 'this day': 'day', tonight: 'day',
    'this week': 'week', weekly: 'week', '7 days': 'week', 'last week': 'week', 'last 7 days': 'week',
    'this month': 'month', monthly: 'month', '30 days': 'month', 'last month': 'month', 'last 30 days': 'month',
    'this year': 'year', yearly: 'year', annual: 'year', 'last year': 'year', '12 months': 'year',
  },
};

/** Field names small models use for another tool's argument, per tool: renamed when the real field is absent. */
const FIELD_ALIASES: Partial<Record<string, Record<string, string>>> = {
  search_torrents: {
    language: 'audio_language', audio: 'audio_language', lang: 'audio_language', audio_lang: 'audio_language', dub: 'audio_language',
    subtitle: 'subtitles', subs: 'subtitles', sub: 'subtitles', subtitle_language: 'subtitles', subtitles_language: 'subtitles',
  },
  browse_torrents: { category: 'kind', type: 'kind', sort: 'order', order_by: 'order', time: 'period', window: 'period', range: 'period', timeframe: 'period' },
};

function applyAliases(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const aliases = FIELD_ALIASES[name];
  if (!aliases) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const to = hasOwn(aliases, k) ? aliases[k] : undefined;
    if (to !== undefined && !hasOwn(input, to) && !hasOwn(out, to)) out[to] = v;
    else if (!hasOwn(out, k)) out[k] = v;
  }
  return out;
}

/** Values that mean "no subtitles wanted" or "any subtitles". */
const SUBS_OFF = new Set(['false', 'no', 'none', 'off', 'n', '0', '']);
const SUBS_ANY = new Set(['true', 'yes', 'y', 'any', 'on', '1', 'subs', 'sub', 'subtitles', 'subtitle', 'subbed', 'with subtitles']);

/**
 * search_torrents: audio_language and subtitles arrive as booleans, lists or loose text. A list keeps its first
 * entry; audio text goes through normalizeLanguage ("Hin" → "hindi", "dual audio" → "multi"); subtitles true or
 * "yes" become "any", false or "no" drop the field. Anything else is left for checkNode to reject.
 */
function coerceLanguageArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  const first = (v: unknown): unknown => (Array.isArray(v) ? v.find((x) => typeof x === 'string' || typeof x === 'boolean') : v);
  if (hasOwn(out, 'audio_language')) {
    const v = first(out.audio_language);
    if (v === null || v === undefined || v === false || (typeof v === 'string' && v.trim() === '')) delete out.audio_language;
    else if (typeof v === 'string') {
      const lang = normalizeLanguage(v);
      if (lang === null) delete out.audio_language;
      else out.audio_language = lang;
    }
  }
  if (hasOwn(out, 'subtitles')) {
    const v = first(out.subtitles);
    if (v === true) out.subtitles = 'any';
    else if (v === false || v === null || v === undefined) delete out.subtitles;
    else if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (SUBS_OFF.has(t)) delete out.subtitles;
      else if (SUBS_ANY.has(t)) out.subtitles = 'any';
      else {
        const lang = normalizeLanguage(t);
        if (lang === null) delete out.subtitles;
        else out.subtitles = lang === 'multi' ? 'any' : lang;
      }
    }
  }
  return out;
}

/** "1080", "1080p", "5", "5 GB", "90 min" → a number. Other units (MB, TB) are not guessed. */
function coerceNumber(value: string, schema: JsonSchema): number | string {
  const v = value.trim();
  if (schema.enum?.includes(2160) && /^4k$/i.test(v)) return 2160;
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:p|gb|g|mins?|m)?$/i.exec(v);
  return m ? Number(m[1]) : value;
}

/**
 * Copies `value` with the safe fixes applied: numeric strings to numbers, "true"/"false" to booleans, enum text
 * case-folded and mapped from near-synonyms, null optionals dropped, unknown keys dropped (their names go to `dropped`).
 * Anything it cannot fix is returned as it was, and checkNode rejects it.
 */
function normalizeNode(schema: JsonSchema, value: unknown, name: string, dropped: string[]): unknown {
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) return value;
      const props = schema.properties ?? {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (!hasOwn(props, key)) {
          dropped.push(sanitizeText(key, 40));
          continue;
        }
        if (value[key] === null && !(schema.required ?? []).includes(key)) continue;
        out[key] = normalizeNode(props[key], value[key], key, dropped);
      }
      return out;
    }
    case 'array':
      return Array.isArray(value) && schema.items ? value.map((v) => normalizeNode(schema.items as JsonSchema, v, name, dropped)) : value;
    case 'integer':
    case 'number':
      return typeof value === 'string' ? coerceNumber(value, schema) : value;
    case 'boolean': {
      if (typeof value !== 'string') return value;
      const v = value.trim().toLowerCase();
      return v === 'true' ? true : v === 'false' ? false : value;
    }
    case 'string': {
      if (typeof value !== 'string' || !schema.enum) return value;
      const v = value.trim().toLowerCase();
      const hit = schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === v);
      if (hit !== undefined) return hit;
      const mapped = hasOwn(ENUM_SYNONYMS, name) ? ENUM_SYNONYMS[name][v] : undefined;
      return mapped !== undefined && schema.enum.includes(mapped) ? mapped : value;
    }
    default:
      return value;
  }
}

function validatePlan(input: Record<string, unknown>, registry: HandleRegistry): ValidateResult {
  const steps = input.steps as Array<{ tool: string; args: Record<string, unknown> }>;
  // The schema enum already limits step tools; this guards direct callers of validateToolArgs too.
  const resolved: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const notes: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!(PLAN_STEP_TOOL_NAMES as readonly string[]).includes(step.tool)) {
      return bad(`Step ${i + 1}: a plan can only add, select files or pause/resume.`);
    }
    const result = validateToolArgs(step.tool as ToolName, step.args, registry);
    if (!result.ok) return bad(`Step ${i + 1}: ${result.error.message}`);
    resolved.push({ tool: step.tool, args: result.args });
    for (const n of result.notes ?? []) if (!notes.includes(n)) notes.push(n);
  }
  return notes.length > 0 ? { ok: true, args: { reason: input.reason, steps: resolved }, notes } : { ok: true, args: { reason: input.reason, steps: resolved } };
}

/** Checks that need more than one field. Runs after handles are resolved. */
function crossFieldError(name: ToolName, args: Record<string, unknown>): string | null {
  switch (name) {
    case 'search_torrents': {
      const min = args.min_resolution as number | undefined;
      const max = args.max_resolution as number | undefined;
      if (min !== undefined && max !== undefined && min > max) {
        return 'min_resolution is larger than max_resolution.';
      }
      return null;
    }
    case 'propose_add': {
      const first = args.first_indices as number[] | undefined;
      const all = args.file_indices as number[] | undefined;
      if (first && all && !first.every((i) => all.includes(i))) {
        return 'first_indices must be a subset of file_indices.';
      }
      return null;
    }
    case 'propose_change': {
      const action = args.action as string;
      const files = args.file_indices as number[] | undefined;
      if ((action === 'select_files' || action === 'remove_files') && (!files || files.length === 0)) {
        return `${action} needs file_indices: the file numbers from list_transfers with transfer_id.`;
      }
      if (action !== 'select_files' && action !== 'remove_files' && files !== undefined) {
        return 'file_indices only goes with select_files or remove_files.';
      }
      if (action !== 'delete' && args.delete_files !== undefined) return 'delete_files only goes with delete.';
      return null;
    }
    case 'open_screen': {
      const screen = args.screen as string;
      if (screen === 'transfer' && args.transfer_id === undefined) return 'screen transfer needs transfer_id, such as t1.';
      if (screen !== 'transfer' && args.transfer_id !== undefined) return 'transfer_id only goes with screen transfer.';
      if (screen !== 'transfers' && args.filter !== undefined) return 'filter only goes with screen transfers.';
      if (screen !== 'search' && args.query !== undefined) return 'query only goes with screen search.';
      if (screen !== 'settings' && args.section !== undefined) return 'section only goes with screen settings.';
      return null;
    }
    case 'propose_select_files': {
      const include = (args.include as number[] | undefined) ?? [];
      const skip = (args.skip as number[] | undefined) ?? [];
      if (include.length === 0 && skip.length === 0) return 'Give at least one file to include or skip.';
      if (include.some((i) => skip.includes(i))) return 'A file cannot be both included and skipped.';
      return null;
    }
    default:
      return null;
  }
}

function unknownHandleMessage(field: string, kind: HandleKind): string {
  if (kind === 'result') return `${field} is not a search result from this chat. Search again.`;
  return `${field} is not a download in this chat. Check list_transfers.`;
}

/**
 * Check one value against a schema node. Returns an error message or null.
 * `name` is the field name used in messages. It comes from our schemas, never from the model.
 */
function checkNode(schema: JsonSchema, value: unknown, name: string): string | null {
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    return `${name} must be one of: ${schema.enum.map((e) => String(e)).join(', ')}.`;
  }
  switch (schema.type) {
    case undefined:
      return null;
    case 'object': {
      if (!isPlainObject(value)) return `${name} must be an object.`;
      const props = schema.properties ?? {};
      for (const key of Object.keys(value)) {
        if (!hasOwn(props, key)) return `Unknown field "${sanitizeText(key, 40)}".`;
      }
      for (const req of schema.required ?? []) {
        if (!hasOwn(value, req)) return `Missing field "${req}".`;
      }
      for (const key of Object.keys(props)) {
        if (!hasOwn(value, key)) continue;
        const err = checkNode(props[key], value[key], key);
        if (err) return err;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${name} must be a list.`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${name} needs at least ${schema.minItems} item(s).`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${name} allows at most ${schema.maxItems} item(s).`;
      }
      if (schema.uniqueItems && new Set(value).size !== value.length) {
        return `${name} lists the same value twice.`;
      }
      if (schema.items) {
        for (const item of value) {
          const err = checkNode(schema.items, item, name);
          if (err) return err;
        }
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${name} must be text.`;
      const length = Array.from(value).length;
      if (schema.minLength !== undefined && length < schema.minLength) return `${name} is too short.`;
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        return `${name} is too long (max ${schema.maxLength} characters).`;
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        if (hasOwn(HANDLE_FIELD_KIND, name)) {
          return `${name} must be an id from this chat, such as ${name === 'result_id' ? 'r1' : 't1'}.`;
        }
        return `${name} has the wrong format.`;
      }
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${name} must be a whole number.`;
      return rangeError(schema, value, name);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number.`;
      return rangeError(schema, value, name);
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be true or false.`;
  }
}

function rangeError(schema: JsonSchema, value: number, name: string): string | null {
  if (schema.minimum !== undefined && value < schema.minimum) return `${name} is below ${schema.minimum}.`;
  if (schema.maximum !== undefined && value > schema.maximum) return `${name} is above ${schema.maximum}.`;
  return null;
}

function bad(message: string): ValidateResult {
  return { ok: false, error: { code: 'bad_args', message } };
}

function isExposedToolName(name: string): name is ExposedToolName {
  return (READ_TOOL_NAMES as readonly string[]).includes(name) || (PROPOSAL_TOOL_NAMES as readonly string[]).includes(name);
}

function isToolName(name: string): name is ToolName {
  return hasOwn(PARAMETERS, name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
