/**
 * Assistant provider prefs (docs/ASSISTANT_DESIGN.md §8.2, §8.3; SM-40).
 *
 * Pure TypeScript: no React and no expo imports, so Node tests run it directly.
 * Storage is injected (KeyValueStore, SecretStore). The app wires expo-sqlite kv-store and
 * expo-secure-store behind those interfaces. The API key itself never enters prefs or the kv store;
 * prefs keep only the secure-store key NAME (`keyRef`).
 */

export interface ModelChoice {
  id: string;
  label: string;
  /** true: costs nothing to use (may be rate-limited). false: needs credit or a paid plan. */
  free: boolean;
}

export type PresetId = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'gemini' | 'custom';

export interface ProviderPreset {
  id: PresetId;
  label: string;
  /** Default base URL. The custom preset starts at the Ollama default. */
  baseUrl: string;
  /** Model id to start with. It is the first entry of `models` when the preset has a list. */
  defaultModel: string;
  /** Short list of tool-capable models for the picker. Empty for the custom preset (free text). */
  models: readonly ModelChoice[];
  notes: string;
  /** true when the base URL was read on the provider's own page at `sourceUrl`. */
  verified: boolean;
  sourceUrl: string;
  /** Local servers may use http, but only on private-range hosts (isPrivateHost). */
  local: boolean;
}

/**
 * Base URLs, checked 2026-11-12:
 * - OpenRouter: https://openrouter.ai/docs/quickstart (OpenAI SDK example uses baseURL https://openrouter.ai/api/v1).
 * - OpenAI: https://developers.openai.com/api/reference/overview (examples use https://api.openai.com/v1).
 *   The OpenAI-hosted docs page returned 403 to the fetcher, so this is the developers.openai.com mirror.
 * - Anthropic compatible: https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk (base_url https://api.anthropic.com/v1/).
 * - Groq: https://console.groq.com/docs/openai ("change the base_url to https://api.groq.com/openai/v1").
 * - Gemini: https://aistudio.google.com/docs/openai (redirect from https://ai.google.dev/gemini-api/docs/openai);
 *   base_url https://generativelanguage.googleapis.com/v1beta/openai/.
 * - Ollama (custom): https://docs.ollama.com/api/openai-compatibility (base_url http://localhost:11434/v1/).
 */
export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Free so a new account with no credit passes Test model. Checked 2026-11-12 against the public list
    // https://openrouter.ai/api/v1/models: pricing.prompt and completion "0" and supported_parameters has "tools"
    // for openrouter/free (router, 200k context) and google/gemma-4-31b-it:free. openai/gpt-5-nano is paid and has tools.
    defaultModel: 'openrouter/free',
    models: [
      { id: 'openrouter/free', label: 'Auto (any free model)', free: true },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', free: true },
      { id: 'openai/gpt-5-nano', label: 'GPT-5 Nano', free: false },
    ],
    notes: 'One key, many models. Sign in with OpenRouter, or paste a key.',
    verified: true,
    sourceUrl: 'https://openrouter.ai/docs/quickstart',
    local: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-nano',
    // Tool calling: both are listed with "tools" at https://openrouter.ai/api/v1/models as openai/gpt-5-nano and openai/gpt-5-mini (checked 2026-11-12).
    models: [
      { id: 'gpt-5-nano', label: 'GPT-5 Nano', free: false },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini', free: false },
    ],
    notes: 'OpenAI API key from the OpenAI platform.',
    verified: true,
    sourceUrl: 'https://developers.openai.com/api/reference/overview',
    local: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (compatible)',
    baseUrl: 'https://api.anthropic.com/v1/',
    defaultModel: 'claude-haiku-5-5',
    // Claude models support tool use: https://platform.claude.com/docs/en/about-claude/models/overview (no free tier).
    models: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', free: false },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', free: false },
    ],
    notes: 'Claude through its OpenAI-compatible layer. Anthropic calls this layer a test tool, not a production API.',
    verified: true,
    sourceUrl: 'https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk',
    local: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    // Listed with tool use on https://console.groq.com/docs/tool-use/overview (checked 2026-11-12). Free tier has limits.
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', free: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', free: true },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', free: true },
    ],
    notes: 'Fast hosted models. Free tier has daily token limits.',
    verified: true,
    sourceUrl: 'https://console.groq.com/docs/openai',
    local: false,
  },
  {
    id: 'gemini',
    label: 'Gemini (OpenAI-compatible)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash-lite',
    // Both are on https://ai.google.dev/gemini-api/docs/pricing with a free tier (checked 2026-11-12); function calling is supported.
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', free: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', free: true },
    ],
    notes: 'Google AI Studio key, through the OpenAI-compatible endpoint.',
    verified: true,
    sourceUrl: 'https://aistudio.google.com/docs/openai',
    local: false,
  },
  {
    id: 'custom',
    label: 'Custom (Ollama on your network)',
    // R1-14: no default. On a phone, localhost is the phone; the user types the computer's address.
    baseUrl: '',
    defaultModel: 'llama3.1',
    models: [],
    notes: 'Ollama or any OpenAI-compatible server. Private addresses may use http.',
    verified: true,
    sourceUrl: 'https://docs.ollama.com/api/openai-compatibility',
    local: true,
  },
];

export const ASSISTANT_PREFS_VERSION = 1;
export const ASSISTANT_PREFS_KEY = 'maglev.assistant.prefs.v1';
const MAX_MODEL_LENGTH = 120;
const KEY_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface AssistantPrefs {
  presetId: PresetId;
  baseUrl: string;
  model: string;
  /** Display name of `model` from the provider's list (for the chat header). Null when unknown. Cleared whenever `model` changes without a name. */
  modelName: string | null;
  /** Secure-store key NAME for the API key (keyNameFor(presetId)). Null when no key is saved. Never the key. */
  keyRef: string | null;
  /** Lifetime token counters from provider `usage`. Shown as tokens, never money (D4). */
  tokensUsed: { input: number; output: number };
  /** Master switch from Settings > Assistant. Off hides the tab and stops every request. Default off. */
  enabled: boolean;
  /** When the user accepted the usage warning (ms since epoch), or null if never. */
  warningAcceptedAt: number | null;
  /** When the user first closed "What the Assistant can do" (ms since epoch), or null if never. */
  capabilitiesSeenAt: number | null;
}

export function presetById(id: PresetId): ProviderPreset {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown assistant preset: ${id}`);
  return found;
}

function isPresetId(v: unknown): v is PresetId {
  return typeof v === 'string' && PRESETS.some((p) => p.id === v);
}

export function defaultAssistantPrefs(): AssistantPrefs {
  const p = presetById('openrouter');
  return { presetId: p.id, baseUrl: p.baseUrl, model: p.defaultModel, modelName: null, keyRef: null, tokensUsed: { input: 0, output: 0 }, enabled: false, warningAcceptedAt: null, capabilitiesSeenAt: null };
}

/** The key loaded for one preset. Used so a key is never sent to another preset's address. */
export interface TaggedKey {
  presetId: PresetId;
  key: string | null;
}

/** The key to send for `current`: only when the loaded key belongs to the same preset and a key is saved. */
export function keyFor(loaded: TaggedKey | null, current: { presetId: PresetId; keyRef: string | null }): string | null {
  if (!loaded || !current.keyRef || loaded.presetId !== current.presetId) return null;
  return loaded.key;
}

/** SecureStore key names allow [A-Za-z0-9._-] only. */
export function keyNameFor(presetId: PresetId): string {
  return `assistant.${presetId}`;
}

// ---- Base URL and LAN rule (SM-40) ----

/**
 * True for hosts on a private network or loopback: 10/8, 172.16/12, 192.168/16, 127/8, ::1, fc00::/7.
 * `localhost` is treated as loopback (127/8). Brackets around IPv6 literals are optional.
 */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost') return true;
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export const ADDRESS_COPY = 'That address must start with https://';

/** R1-14: Android can't resolve mDNS (.local) names, so those addresses are refused with this line. */
export const LOCAL_NAME_COPY = "Use the computer's address, like 192.168.1.20, not a .local name.";

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** https passes, http only for a private-range host. Credentials in the URL and .local names are refused. */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: ADDRESS_COPY };
  }
  if (u.username || u.password) return { ok: false, reason: ADDRESS_COPY };
  if (/\.local\.?$/i.test(u.hostname)) return { ok: false, reason: LOCAL_NAME_COPY };
  if (u.protocol === 'https:') return { ok: true, url: text };
  if (u.protocol === 'http:' && isPrivateHost(u.hostname)) return { ok: true, url: text };
  return { ok: false, reason: ADDRESS_COPY };
}

/** `${base}/chat/completions` without a doubled slash. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

// ---- Migration-tolerant parse (same style as normalizeSearchPrefs) ----

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Missing, unknown or invalid fields fall back to defaults. Accepts raw records without `version` (version 0). */
export function normalizeAssistantPrefs(raw: unknown): AssistantPrefs {
  const d = defaultAssistantPrefs();
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const presetId = isPresetId(o.presetId) ? o.presetId : d.presetId;
  const preset = presetById(presetId);
  const baseUrl =
    typeof o.baseUrl === 'string' && checkBaseUrl(o.baseUrl).ok ? o.baseUrl.trim() : preset.baseUrl;
  const model =
    typeof o.model === 'string' && o.model.trim() && o.model.trim().length <= MAX_MODEL_LENGTH
      ? o.model.trim()
      : preset.defaultModel;
  const modelName =
    typeof o.modelName === 'string' && o.modelName.trim() && o.modelName.trim().length <= MAX_MODEL_LENGTH ? o.modelName.trim() : null;
  const keyRef = typeof o.keyRef === 'string' && KEY_REF_PATTERN.test(o.keyRef) ? o.keyRef : null;
  const t = o.tokensUsed && typeof o.tokensUsed === 'object' ? (o.tokensUsed as Record<string, unknown>) : {};
  return {
    presetId,
    baseUrl,
    model,
    modelName,
    keyRef,
    tokensUsed: { input: count(t.input), output: count(t.output) },
    enabled: o.enabled === true,
    warningAcceptedAt:
      typeof o.warningAcceptedAt === 'number' && Number.isFinite(o.warningAcceptedAt) && o.warningAcceptedAt > 0
        ? o.warningAcceptedAt
        : null,
    capabilitiesSeenAt:
      typeof o.capabilitiesSeenAt === 'number' && Number.isFinite(o.capabilitiesSeenAt) && o.capabilitiesSeenAt > 0
        ? o.capabilitiesSeenAt
        : null,
  };
}

/** Switching preset resets base URL and model to that preset's defaults and clears keyRef (the old key stays in secure store). */
export function selectPreset(prefs: AssistantPrefs, presetId: PresetId): AssistantPrefs {
  const p = presetById(presetId);
  return { ...prefs, presetId, baseUrl: p.baseUrl, model: p.defaultModel, modelName: null, keyRef: null };
}

export function addTokensUsed(prefs: AssistantPrefs, usage: { input?: number; output?: number }): AssistantPrefs {
  return {
    ...prefs,
    tokensUsed: {
      input: prefs.tokensUsed.input + count(usage.input),
      output: prefs.tokensUsed.output + count(usage.output),
    },
  };
}

// ---- Store (injected storage; no React) ----

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface AssistantPrefsStore {
  get(): AssistantPrefs;
  update(change: Partial<AssistantPrefs> | ((p: AssistantPrefs) => Partial<AssistantPrefs>)): AssistantPrefs;
  subscribe(listener: () => void): () => void;
  /**
   * Stores the key under keyNameFor(presetId), deletes every other provider's key, then in ONE update sets
   * keyRef and, when `settings` is given, presetId, baseUrl and model. If the secret write throws, prefs are untouched.
   * Returns the key name.
   *
   * Save and remove run one after the other (a Remove during a save waits for it, then removes). `stillWanted`
   * is checked before and after the secret write; when it says no, whatever was written is deleted, prefs stay
   * as they were, and the result is null.
   */
  saveKey(
    presetId: PresetId,
    key: string,
    settings?: { baseUrl: string; model: string; modelName?: string | null },
    stillWanted?: () => boolean,
  ): Promise<string | null>;
  readKey(presetId: PresetId): Promise<string | null>;
  /** Removes every provider's key (`assistant.<preset>`) and clears keyRef. */
  removeKey(): Promise<void>;
}

export function createAssistantPrefsStore(kv: KeyValueStore, secrets: SecretStore): AssistantPrefsStore {
  let cache: AssistantPrefs | null = null;
  const listeners = new Set<() => void>();
  /** Save and remove never overlap: each waits for the one before it, whether that one worked or not. */
  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  function load(): AssistantPrefs {
    if (cache) return cache;
    let raw: unknown = null;
    try {
      const s = kv.getItem(ASSISTANT_PREFS_KEY);
      if (s) raw = JSON.parse(s);
    } catch {
      // Unreadable storage: defaults for this session.
    }
    cache = normalizeAssistantPrefs(raw);
    return cache;
  }

  function persist(p: AssistantPrefs): void {
    try {
      kv.setItem(ASSISTANT_PREFS_KEY, JSON.stringify({ version: ASSISTANT_PREFS_VERSION, ...p }));
    } catch {
      // Kept in memory only.
    }
  }

  function set(next: AssistantPrefs): AssistantPrefs {
    cache = next;
    persist(next);
    listeners.forEach((l) => l());
    return next;
  }

  /** Deletes the key of every preset except `keep`. A failing delete is skipped. */
  async function removeOthers(keep: PresetId | null): Promise<void> {
    for (const p of PRESETS) {
      if (p.id === keep) continue;
      try {
        await secrets.remove(keyNameFor(p.id));
      } catch {
        // Nothing stored.
      }
    }
  }

  return {
    get: load,
    update(change) {
      const prev = load();
      const patch = typeof change === 'function' ? change(prev) : change;
      // A new model without its name must not keep the old model's name.
      const stale = patch.model !== undefined && patch.model !== prev.model && patch.modelName === undefined;
      return set(normalizeAssistantPrefs({ ...prev, ...patch, ...(stale ? { modelName: null } : {}) }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    saveKey(presetId, key, settings, stillWanted) {
      return exclusive(async () => {
        const name = keyNameFor(presetId);
        const wanted = () => stillWanted === undefined || stillWanted();
        if (!wanted()) return null;
        await secrets.set(name, key.trim());
        if (!wanted()) {
          // Revoked (Remove key) while the write ran: take back what was written.
          try {
            await secrets.remove(name);
          } catch {
            // Nothing more to do.
          }
          return null;
        }
        await removeOthers(presetId);
        set(normalizeAssistantPrefs({ ...load(), ...(settings ? { presetId, modelName: null, ...settings } : {}), keyRef: name }));
        return name;
      });
    },
    async readKey(presetId) {
      try {
        return await secrets.get(keyNameFor(presetId));
      } catch {
        return null;
      }
    },
    removeKey() {
      return exclusive(async () => {
        await removeOthers(null);
        set({ ...load(), keyRef: null });
      });
    },
  };
}
