/**
 * Assistant provider prefs (docs/ASSISTANT_DESIGN.md §8.2, §8.3; SM-40).
 *
 * Pure TypeScript: no React and no expo imports, so Node tests run it directly.
 * Storage is injected (KeyValueStore, SecretStore). The app wires expo-sqlite kv-store and
 * expo-secure-store behind those interfaces. The API key itself never enters prefs or the kv store;
 * prefs keep only the secure-store key NAME (`keyRef`).
 */

export type PresetId = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'gemini' | 'custom';

export interface ProviderPreset {
  id: PresetId;
  label: string;
  /** Default base URL. The custom preset starts at the Ollama default. */
  baseUrl: string;
  /** Model id to start with. Model ids are not checked against the provider's list (see report). */
  defaultModel: string;
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
    defaultModel: 'openai/gpt-5-nano',
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
  /** Secure-store key NAME for the API key (keyNameFor(presetId)). Null when no key is saved. Never the key. */
  keyRef: string | null;
  /** Lifetime token counters from provider `usage`. Shown as tokens, never money (D4). */
  tokensUsed: { input: number; output: number };
  /** Master switch from Settings > Assistant. Off hides the tab and stops every request. Default off. */
  enabled: boolean;
  /** When the user accepted the usage warning (ms since epoch), or null if never. */
  warningAcceptedAt: number | null;
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
  return { presetId: p.id, baseUrl: p.baseUrl, model: p.defaultModel, keyRef: null, tokensUsed: { input: 0, output: 0 }, enabled: false, warningAcceptedAt: null };
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
  const keyRef = typeof o.keyRef === 'string' && KEY_REF_PATTERN.test(o.keyRef) ? o.keyRef : null;
  const t = o.tokensUsed && typeof o.tokensUsed === 'object' ? (o.tokensUsed as Record<string, unknown>) : {};
  return {
    presetId,
    baseUrl,
    model,
    keyRef,
    tokensUsed: { input: count(t.input), output: count(t.output) },
    enabled: o.enabled === true,
    warningAcceptedAt:
      typeof o.warningAcceptedAt === 'number' && Number.isFinite(o.warningAcceptedAt) && o.warningAcceptedAt > 0
        ? o.warningAcceptedAt
        : null,
  };
}

/** Switching preset resets base URL and model to that preset's defaults and clears keyRef (the old key stays in secure store). */
export function selectPreset(prefs: AssistantPrefs, presetId: PresetId): AssistantPrefs {
  const p = presetById(presetId);
  return { ...prefs, presetId, baseUrl: p.baseUrl, model: p.defaultModel, keyRef: null };
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
  /** Stores the key under keyNameFor(presetId) and sets keyRef. Returns the key name. */
  saveKey(presetId: PresetId, key: string): Promise<string>;
  readKey(presetId: PresetId): Promise<string | null>;
  /** Removes the key named by keyRef and clears keyRef. */
  removeKey(): Promise<void>;
}

export function createAssistantPrefsStore(kv: KeyValueStore, secrets: SecretStore): AssistantPrefsStore {
  let cache: AssistantPrefs | null = null;
  const listeners = new Set<() => void>();

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

  return {
    get: load,
    update(change) {
      const prev = load();
      const patch = typeof change === 'function' ? change(prev) : change;
      return set(normalizeAssistantPrefs({ ...prev, ...patch }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async saveKey(presetId, key) {
      const name = keyNameFor(presetId);
      await secrets.set(name, key.trim());
      set({ ...load(), keyRef: name });
      return name;
    },
    async readKey(presetId) {
      try {
        return await secrets.get(keyNameFor(presetId));
      } catch {
        return null;
      }
    },
    async removeKey() {
      const ref = load().keyRef;
      if (ref) {
        try {
          await secrets.remove(ref);
        } catch {
          // Nothing stored.
        }
      }
      set({ ...load(), keyRef: null });
    },
  };
}
