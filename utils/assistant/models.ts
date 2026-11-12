/**
 * OpenRouter's live model list for the model picker (Settings > Assistant).
 * Endpoint and fields: https://openrouter.ai/docs/api-reference/list-available-models
 *   GET https://openrouter.ai/api/v1/models -> { data: [{ id, name, context_length, pricing: { prompt, completion }, supported_parameters }] }
 *   Prices are strings of USD per token. `supported_parameters` includes "tools" when the model can call tools.
 * App attribution headers: https://openrouter.ai/docs/api-reference/overview (`HTTP-Referer`, `X-OpenRouter-Title`; `X-Title` is also accepted).
 *
 * Pure TypeScript: no React, no expo. fetch, the key-value store and the clock are injected so Node tests run it.
 */
import { presetById, type PresetId } from '../prefs/assistant.ts';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const MODELS_CACHE_KEY = 'maglev.assistant.models.v1';
/** The list is fetched at most once a day. */
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelEntry {
  id: string;
  name: string;
  /** Tokens, or null when the provider does not say. */
  contextLength: number | null;
}

/** The router that picks any free model. Always the first option. */
export const AUTO_MODEL: ModelEntry & { name: 'Auto (any free model)' } = {
  id: 'openrouter/free',
  name: 'Auto (any free model)',
  contextLength: null,
};

interface Parsed extends ModelEntry {
  free: boolean;
  paid: boolean;
  tools: boolean;
}

function price(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Tolerant parse of the /models reply. Entries without an id are dropped. */
export function parseModels(json: unknown): Parsed[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: Parsed[] = [];
  for (const raw of data) {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id) continue;
    const p = (o.pricing ?? {}) as Record<string, unknown>;
    const prompt = price(p.prompt);
    const completion = price(p.completion);
    const zero = prompt === 0 && completion === 0;
    // Negative prices mark routers with variable pricing: neither free nor paid.
    const negative = (prompt ?? 0) < 0 || (completion ?? 0) < 0;
    const free = !negative && (zero || o.id.endsWith(':free'));
    const priced = !free && !negative && prompt !== null && completion !== null;
    const params = Array.isArray(o.supported_parameters) ? o.supported_parameters : [];
    const ctx = typeof o.context_length === 'number' && o.context_length > 0 ? o.context_length : null;
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : o.id,
      contextLength: ctx,
      free,
      paid: priced,
      tools: params.includes('tools'),
    });
  }
  return out;
}

function bySize(a: ModelEntry, b: ModelEntry): number {
  return (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.name.localeCompare(b.name);
}

function pick(all: Parsed[], want: (p: Parsed) => boolean): ModelEntry[] {
  return all
    .filter((p) => p.tools && p.id !== AUTO_MODEL.id && want(p))
    .map(({ id, name, contextLength }) => ({ id, name, contextLength }))
    .sort(bySize);
}

/** Free models that can call tools, longest memory first. */
export function freeToolModels(all: Parsed[]): ModelEntry[] {
  return pick(all, (p) => p.free);
}

/** Paid models that can call tools, longest memory first. */
export function paidToolModels(all: Parsed[]): ModelEntry[] {
  return pick(all, (p) => p.paid);
}

/** "128K", or "Long memory · 262K" from 200K tokens up. Empty when unknown. */
export function contextLabel(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  const short = tokens >= 1_000_000 ? `${Math.round((tokens / 1_000_000) * 10) / 10}M` : `${Math.round(tokens / 1000)}K`;
  return tokens >= 200_000 ? `Long memory · ${short}` : short;
}

/** "Google: Gemma 4 31B (free)" -> "Gemma 4 31B". */
export function shortModelName(name: string): string {
  return name.replace(/^[^:]{1,40}:\s+/, '').replace(/\s*\(free\)\s*$/i, '').trim() || name;
}

// ---- Load with a daily cache and an offline fallback ----

export interface ModelKv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ModelsFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ModelList {
  free: ModelEntry[];
  paid: ModelEntry[];
  /** live: just fetched. cache: stored copy. static: the short built-in list (offline, nothing cached). */
  source: 'live' | 'cache' | 'static';
}

function staticList(): ModelList {
  const free: ModelEntry[] = [];
  const paid: ModelEntry[] = [];
  for (const m of presetById('openrouter').models) {
    if (m.id === AUTO_MODEL.id) continue;
    (m.free ? free : paid).push({ id: m.id, name: m.label, contextLength: null });
  }
  return { free, paid, source: 'static' };
}

interface Cached {
  at: number;
  free: ModelEntry[];
  paid: ModelEntry[];
}

function readCache(kv: ModelKv): Cached | null {
  try {
    const raw = kv.getItem(MODELS_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Cached;
    if (typeof o?.at !== 'number' || !Array.isArray(o.free) || !Array.isArray(o.paid)) return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Cached list when it is under a day old, else a fresh fetch. A failed fetch (offline, HTTP error, no models)
 * uses a stale cache, then the static list. Never throws.
 */
export async function loadModels(deps: {
  fetch: ModelsFetch;
  kv: ModelKv;
  now?: () => number;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<ModelList> {
  const now = (deps.now ?? Date.now)();
  const cached = readCache(deps.kv);
  if (cached && !deps.force && now >= cached.at && now - cached.at < MODELS_TTL_MS) {
    return { free: cached.free, paid: cached.paid, source: 'cache' };
  }
  try {
    const res = await deps.fetch(OPENROUTER_MODELS_URL, { method: 'GET', headers: { Accept: 'application/json' }, signal: deps.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = parseModels(JSON.parse(await res.text()));
    const free = freeToolModels(all);
    const paid = paidToolModels(all);
    if (free.length === 0 && paid.length === 0) throw new Error('no models');
    try {
      deps.kv.setItem(MODELS_CACHE_KEY, JSON.stringify({ at: now, free, paid } satisfies Cached));
    } catch {
      // Kept for this session only.
    }
    return { free, paid, source: 'live' };
  } catch {
    if (cached) return { free: cached.free, paid: cached.paid, source: 'cache' };
    return staticList();
  }
}

// ---- Names for the chat ----

/** What the chat shows for the model in use: the saved name, else the built-in label, else the id with the vendor dropped. */
export function modelDisplayName(prefs: { presetId: PresetId; model: string; modelName?: string | null }): string {
  if (prefs.model === AUTO_MODEL.id && prefs.presetId === 'openrouter') return AUTO_MODEL.name;
  if (prefs.modelName) return prefs.modelName;
  const listed = presetById(prefs.presetId).models.find((m) => m.id === prefs.model);
  if (listed) return listed.label;
  return prefs.model.replace(/^[^/]+\//, '').replace(/:free$/, '');
}

// ---- Attribution (OpenRouter only) ----

export const APP_REFERER = 'https://github.com/Kaos599/Maglev';
export const APP_TITLE = 'Maglev';

/** Headers that identify Maglev to OpenRouter. Empty for every other provider: nothing is sent to them. */
export function attributionHeaders(presetId: string): Record<string, string> {
  if (presetId !== 'openrouter') return {};
  return { 'HTTP-Referer': APP_REFERER, 'X-Title': APP_TITLE };
}
