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
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: { code: 'bad_args' | 'unknown_tool'; message: string } };

export const READ_TOOL_NAMES = [
  'search_torrents',
  'get_result_details',
  'parse_release_name',
  'get_free_space',
  'list_transfers',
  'get_transfer_details',
  'explain_error',
] as const;

export const PROPOSAL_TOOL_NAMES = [
  'propose_add',
  'propose_select_files',
  'propose_pause_resume',
  'propose_remove_files',
  'propose_delete',
  'propose_plan',
] as const;

type ReadToolName = (typeof READ_TOOL_NAMES)[number];
type ProposalToolName = (typeof PROPOSAL_TOOL_NAMES)[number];
type ToolName = ReadToolName | ProposalToolName;

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
  description: 'Result id from search_torrents, such as r1.',
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
    query: { type: 'string', minLength: 2, maxLength: QUERY_MAX, description: 'Title and year, or show and season.' },
    category: {
      type: 'string',
      enum: ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
      default: 'all',
    },
    profile: { type: 'string', enum: ['phone', 'tv', 'archive'], default: 'phone' },
    sort: { type: 'string', enum: ['best', 'seeders', 'newest', 'size', 'name'], default: 'best' },
    max_size_gb: { type: 'number', minimum: 0.1, maximum: 200 },
    min_resolution: { type: 'integer', enum: [480, 720, 1080, 2160] },
    max_resolution: { type: 'integer', enum: [480, 720, 1080, 2160] },
    min_seeders: { type: 'integer', minimum: 0, maximum: 1000, default: 1 },
    include_cam: { type: 'boolean', default: false },
    runtime_min: { type: 'integer', minimum: 1, maximum: 600, description: 'Runtime in minutes, if the user said it.' },
    limit: { type: 'integer', minimum: 1, maximum: 8, default: 6 },
  },
  required: ['query'],
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

const LIST_TRANSFERS: JsonSchema = {
  type: 'object',
  properties: {
    filter: { type: 'string', enum: ['all', 'active', 'paused', 'error', 'finished'], default: 'all' },
  },
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
  required: ['result_id', 'reason'],
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

const PROPOSE_TOOL_SCHEMAS: Record<Exclude<ProposalToolName, 'propose_plan'>, JsonSchema> = {
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

const PARAMETERS: Record<ToolName, JsonSchema> = {
  search_torrents: SEARCH_TORRENTS,
  get_result_details: GET_RESULT_DETAILS,
  parse_release_name: PARSE_RELEASE_NAME,
  get_free_space: GET_FREE_SPACE,
  list_transfers: LIST_TRANSFERS,
  get_transfer_details: GET_TRANSFER_DETAILS,
  explain_error: EXPLAIN_ERROR,
  ...PROPOSE_TOOL_SCHEMAS,
  propose_plan: PROPOSE_PLAN,
};

// Short, plain English. Nothing here may mention adult content (D2).
const DESCRIPTIONS: Record<ToolName, string> = {
  search_torrents:
    'Search the enabled sources. Returns the best matches, already checked against free space. Use a short title and year, or show and season.',
  get_result_details:
    'Look inside one search result: its files, file safety check and space check. Slow. Call it before proposing a result.',
  parse_release_name:
    'Explain release names part by part: source, resolution, codec, HDR, audio and flags. Use for names the user pastes or asks about.',
  get_free_space:
    'Free space on the download folder, space promised to unfinished downloads, and what is left.',
  list_transfers: "The user's downloads, in short form.",
  get_transfer_details:
    'One download in detail: progress, connections and, optionally, its files with sizes.',
  explain_error:
    'Why a download is stuck, paused or failed, in plain words, with the fix the app offers. Use before guessing.',
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

function toolDef(name: ToolName): ToolDef {
  return {
    type: 'function',
    function: { name, description: DESCRIPTIONS[name], parameters: PARAMETERS[name] },
  };
}

/**
 * Validate a tool call from the model. `rawArgs` is the parsed object or the JSON string the provider sent.
 * On success `args` holds the same fields, with handle fields replaced by the real ids from `registry`.
 * Errors carry plain English and never echo a real id or a hash.
 */
export function validateArgs(name: string, rawArgs: unknown, registry: HandleRegistry): ValidateResult {
  if (!isToolName(name)) {
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
  return validateToolArgs(name, input, registry);
}

function validateToolArgs(name: ToolName, input: Record<string, unknown>, registry: HandleRegistry): ValidateResult {
  const schemaError = checkNode(PARAMETERS[name], input, 'arguments');
  if (schemaError) return bad(schemaError);

  if (name === 'propose_plan') return validatePlan(input, registry);

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
  return { ok: true, args };
}

function validatePlan(input: Record<string, unknown>, registry: HandleRegistry): ValidateResult {
  const steps = input.steps as Array<{ tool: string; args: Record<string, unknown> }>;
  // The schema enum already limits step tools; this guards direct callers of validateToolArgs too.
  const resolved: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!(PLAN_STEP_TOOL_NAMES as readonly string[]).includes(step.tool)) {
      return bad(`Step ${i + 1}: a plan can only add, select files or pause/resume.`);
    }
    const result = validateToolArgs(step.tool as ToolName, step.args, registry);
    if (!result.ok) return bad(`Step ${i + 1}: ${result.error.message}`);
    resolved.push({ tool: step.tool, args: result.args });
  }
  return { ok: true, args: { reason: input.reason, steps: resolved } };
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

function isToolName(name: string): name is ToolName {
  return hasOwn(PARAMETERS, name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
