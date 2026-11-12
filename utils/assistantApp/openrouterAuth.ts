/**
 * Sign in with OpenRouter (OAuth PKCE, headless mode) for SM-40.
 * https://openrouter.ai/docs/guides/overview/auth/oauth
 *
 * Flow: make a verifier, keep it in secure storage, open openrouter.ai/auth with only the S256 challenge
 * (no callback_url, so OpenRouter shows the code on screen), the user pastes the code, we POST
 * code + verifier to /api/v1/auth/keys and get the user's own key back. The key is not saved here: the
 * provider machine saves it only after the probe passes.
 *
 * Pure TypeScript: no React, no expo imports. Random bytes, SHA-256, secure storage, the browser and
 * fetch are injected, so Node tests can run all of it.
 */

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** SecureStore names allow [A-Za-z0-9._-] only. */
export const VERIFIER_SECRET_NAME = 'assistant.openrouter.pkce';
/** 32 random bytes encode to 43 base64url characters, the RFC 7636 minimum. */
const VERIFIER_BYTES = 32;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding, no Buffer or btoa needed. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

/** Standard base64 (as expo-crypto returns it) to base64url without padding. */
export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifierFromBytes(bytes: Uint8Array): string {
  return base64UrlEncode(bytes);
}

/** challenge = base64url(SHA-256(verifier)). `sha256Base64` returns the standard base64 digest of a UTF-8 string. */
export async function challengeFor(verifier: string, sha256Base64: (s: string) => Promise<string>): Promise<string> {
  return toBase64Url(await sha256Base64(verifier));
}

/** `key_label` names the key in the user's OpenRouter account (https://openrouter.ai/docs/guides/overview/auth/oauth, Optional Parameters). */
export const KEY_LABEL = 'Maglev';

export function buildAuthUrl(challenge: string): string {
  return `${OPENROUTER_AUTH_URL}?code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&key_label=${encodeURIComponent(KEY_LABEL)}`;
}

/**
 * Pulls the authorization code out of what the user pasted: the bare code, or a URL / query string that has `code=`.
 * Returns null when nothing usable is there. Codes are short URL-safe strings; anything with spaces is refused.
 */
export function parseAuthCode(pasted: string): string | null {
  const text = (pasted ?? '').trim();
  if (!text) return null;
  const q = /[?&#]code=([^&#\s]+)/.exec(text) ?? /^code=([^&#\s]+)/.exec(text);
  let candidate = text;
  if (q) {
    try {
      candidate = decodeURIComponent(q[1]);
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9._~+\-/=]{4,512}$/.test(candidate) ? candidate : null;
}

export interface AuthSecrets {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export type AuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AuthDeps {
  randomBytes(n: number): Promise<Uint8Array>;
  sha256Base64(s: string): Promise<string>;
  secrets: AuthSecrets;
  openBrowser(url: string): Promise<void>;
  fetch: AuthFetch;
}

export type ExchangeResult = { ok: true; key: string } | { ok: false };

export interface OpenRouterAuth {
  /** Makes and persists a verifier, then opens the sign-in page. Throws if the page cannot open. */
  start(): Promise<void>;
  /** Trades the pasted code for a key. `{ ok: false }` for every failure, including cancel. */
  exchange(code: string): Promise<ExchangeResult>;
  /** Drops the stored verifier and aborts an exchange in flight. */
  cancel(): Promise<void>;
}

export function createOpenRouterAuth(deps: AuthDeps): OpenRouterAuth {
  let inFlight: AbortController | null = null;

  return {
    async start() {
      const verifier = verifierFromBytes(await deps.randomBytes(VERIFIER_BYTES));
      await deps.secrets.set(VERIFIER_SECRET_NAME, verifier);
      const challenge = await challengeFor(verifier, deps.sha256Base64);
      await deps.openBrowser(buildAuthUrl(challenge));
    },

    async exchange(code) {
      const ctl = new AbortController();
      inFlight = ctl;
      try {
        const verifier = await deps.secrets.get(VERIFIER_SECRET_NAME);
        if (!verifier || !code) return { ok: false };
        const res = await deps.fetch(OPENROUTER_KEYS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
          signal: ctl.signal,
        });
        const text = await res.text();
        if (!res.ok) return { ok: false };
        const key = (JSON.parse(text) as { key?: unknown })?.key;
        if (typeof key !== 'string' || !key.trim() || ctl.signal.aborted) return { ok: false };
        // The code is single use, so the verifier is done.
        await deps.secrets.remove(VERIFIER_SECRET_NAME).catch(() => {});
        return { ok: true, key: key.trim() };
      } catch {
        return { ok: false };
      } finally {
        if (inFlight === ctl) inFlight = null;
      }
    },

    async cancel() {
      inFlight?.abort();
      inFlight = null;
      await deps.secrets.remove(VERIFIER_SECRET_NAME).catch(() => {});
    },
  };
}
