/**
 * SM-40 Provider setup (docs/STATE_MACHINES_AND_SCREENS.md §6, amended by review round 1 R1-14).
 * Pure reducer, no React. Anything not in the table is a no-op (same state, no effects).
 * The caller runs effects: probe (one tool "Test model" request), storeKey (expo-secure-store, only after
 * PROBE_OK), openAuth (OpenRouter PKCE page), exchangeCode, cancelAuth, removeKey, expireCards.
 * The key sits in `testing` (memory only) until the probe succeeds. A failed probe drops it.
 */
import { checkBaseUrl, presetById, type PresetId } from '../prefs/assistant.ts';

/** States the user can go back to after cancelling a sign-in. */
export type RestState = { kind: 'noKey' } | { kind: 'editing' } | { kind: 'invalid'; reason: string; preset?: string; key?: string };

export type ProviderState =
  | { kind: 'noKey' }
  | { kind: 'editing' }
  /** `key` stays in memory until PROBE_OK. It may be empty for the custom (Ollama) preset. */
  | { kind: 'testing'; preset: string; key: string }
  | { kind: 'ready' }
  /**
   * `key` (with its `preset`) stays in memory, never persisted, when the key itself may be fine: no credit,
   * model can't use tools, model not found, or the provider was unreachable. The user changes the model and
   * presses Test model again without signing in again.
   */
  | { kind: 'invalid'; reason: string; preset?: string; key?: string }
  | { kind: 'awaitingCode'; from: RestState }
  | { kind: 'exchanging'; from: RestState };

export type ProviderEvent =
  | { type: 'EDIT' }
  | { type: 'SAVE'; preset: string; baseUrl: string; model: string; key: string }
  | { type: 'PROBE_OK'; toolCallsWork: boolean }
  | { type: 'PROBE_ERR'; status: number | 'net' | 'timeout' }
  | { type: 'SIGN_IN_OPENROUTER' }
  | { type: 'CODE'; pasted: string }
  | { type: 'KEY'; key: string; baseUrl: string; model: string }
  | { type: 'ERR' }
  /** The probe passed but the phone's secure store refused the key. Back to editing, nothing switched. */
  | { type: 'STORE_FAILED' }
  /** Back out of awaitingCode or exchanging. */
  | { type: 'CANCEL' }
  /** The runner fires this PROVIDER_TIMEOUT_MS after sign-in started. */
  | { type: 'TIMEOUT' }
  | { type: 'REMOVE_KEY' };

export type ProviderEffect =
  | { type: 'showError'; message: string }
  /** Runs only after PROBE_OK. */
  | { type: 'storeKey'; key: string }
  | { type: 'probe'; preset: string; baseUrl: string; model: string; key: string }
  | { type: 'openAuth' }
  | { type: 'exchangeCode'; code: string }
  /** Drop the PKCE verifier and abort an exchange in flight. */
  | { type: 'cancelAuth' }
  | { type: 'removeKey' }
  | { type: 'expireCards' };

/** Sign-in gives up after 10 minutes (R1-14). */
export const PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

/** Copy. `{provider}` is replaced with the provider name by `fillProvider` when the reason is set. */
export const COPY = {
  pasteKey: 'Paste a key',
  httpsOnly: 'That address must start with https://',
  needAddress: "Type your computer's address, like http://192.168.1.20:11434/v1",
  pickModel: 'Pick a model',
  cantUseTools: "This model can't work with Maglev's actions. Pick another.",
  badKey: "{provider} didn't accept this key. Paste it again or make a new one.",
  outOfCredits: 'Your {provider} account is out of credit. Top up on their site or pick another model.',
  noCreditOpenRouter:
    'Your OpenRouter account has no credit yet. Pick a free model below, or add credit on openrouter.ai and test again.',
  saveFailed: "Couldn't save the key on this phone. Try again.",
  cantReach: "Couldn't reach the provider. Try again.",
  signInFailed: "Sign-in didn't finish. Try again.",
  signInTimedOut: 'Sign-in took too long. Try again.',
  modelNotFound: "That model wasn't found. Check the name.",
  rateLimited: 'Too many requests. Wait a minute and test again.',
  rejected: 'The provider refused the test. Check the address and model.',
  localCaption: 'Runs on your network. Nothing leaves it.',
} as const;

/** The name shown in copy for a preset id. Unknown ids read as "The provider". */
export function providerName(preset: string): string {
  switch (preset) {
    case 'openrouter':
    case 'openai':
    case 'groq':
      return presetById(preset as PresetId).label;
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    case 'custom':
      return 'Your server';
    default:
      return 'The provider';
  }
}

/** Fills the `{provider}` placeholder of a COPY string. */
export function fillProvider(copy: string, preset: string): string {
  return copy.replace('{provider}', providerName(preset));
}

/** The machine starts with no key. SM-40 does not name an initial state; the screen starts here. */
export const INITIAL_PROVIDER_STATE: ProviderState = { kind: 'noKey' };

/** SAVE field checks, in order: key, base URL, model. The custom (Ollama) preset needs no key but needs an address. */
export function validateSave(e: { preset?: string; baseUrl: string; model: string; key: string }): string | null {
  if (e.preset !== 'custom' && !e.key.trim()) return COPY.pasteKey;
  if (e.preset === 'custom' && !e.baseUrl.trim()) return COPY.needAddress;
  const url = checkBaseUrl(e.baseUrl);
  if (!url.ok) return url.reason;
  if (!e.model.trim()) return COPY.pickModel;
  return null;
}

const stay = (state: ProviderState): { state: ProviderState; effects: ProviderEffect[] } => ({ state, effects: [] });
const to = (state: ProviderState, effects: ProviderEffect[] = []): { state: ProviderState; effects: ProviderEffect[] } => ({
  state,
  effects,
});

export function reduceProvider(
  state: ProviderState,
  event: ProviderEvent,
): { state: ProviderState; effects: ProviderEffect[] } {
  switch (event.type) {
    case 'EDIT':
      if (state.kind === 'noKey' || state.kind === 'ready' || state.kind === 'invalid') return to({ kind: 'editing' });
      return stay(state);

    case 'SAVE': {
      // From invalid only when the key is still in memory (changed the model, pressed Test model again).
      if (state.kind !== 'editing' && !(state.kind === 'invalid' && state.key !== undefined)) return stay(state);
      const error = validateSave(event);
      if (error) return to(state, [{ type: 'showError', message: error }]);
      const key = event.key.trim();
      // The key is not stored yet. It is stored when the probe succeeds.
      return to({ kind: 'testing', preset: event.preset, key }, [
        { type: 'probe', preset: event.preset, baseUrl: event.baseUrl.trim(), model: event.model.trim(), key },
      ]);
    }

    case 'PROBE_OK':
      if (state.kind !== 'testing') return stay(state);
      if (event.toolCallsWork) return to({ kind: 'ready' }, state.key ? [{ type: 'storeKey', key: state.key }] : []);
      return to({ kind: 'invalid', reason: COPY.cantUseTools, preset: state.preset, key: state.key });

    case 'STORE_FAILED':
      if (state.kind !== 'testing') return stay(state);
      return to({ kind: 'editing' }, [{ type: 'showError', message: COPY.saveFailed }]);

    case 'PROBE_ERR': {
      if (state.kind !== 'testing') return stay(state);
      const s = event.status;
      const bad = (reason: string) => to({ kind: 'invalid', reason });
      // The key may still be fine, so keep it in memory for another Test model.
      const keep = (reason: string) => to({ kind: 'invalid', reason, preset: state.preset, key: state.key });
      if (s === 401 || s === 403) return bad(fillProvider(COPY.badKey, state.preset));
      if (s === 402) return keep(state.preset === 'openrouter' ? COPY.noCreditOpenRouter : fillProvider(COPY.outOfCredits, state.preset));
      if (s === 'net' || s === 'timeout' || (typeof s === 'number' && s >= 500 && s <= 599)) return keep(COPY.cantReach);
      // Any other status must still leave `testing`, or the screen hangs on "Testing…".
      if (s === 404) return keep(COPY.modelNotFound);
      if (s === 429) return keep(COPY.rateLimited);
      return bad(COPY.rejected);
    }

    case 'SIGN_IN_OPENROUTER':
      if (state.kind === 'noKey' || state.kind === 'invalid' || state.kind === 'editing') {
        return to({ kind: 'awaitingCode', from: state }, [{ type: 'openAuth' }]);
      }
      return stay(state);

    case 'CODE':
      if (state.kind === 'awaitingCode') {
        return to({ kind: 'exchanging', from: state.from }, [{ type: 'exchangeCode', code: event.pasted.trim() }]);
      }
      return stay(state);

    case 'KEY': {
      if (state.kind !== 'exchanging') return stay(state);
      const key = event.key.trim();
      return to({ kind: 'testing', preset: 'openrouter', key }, [
        { type: 'probe', preset: 'openrouter', baseUrl: event.baseUrl.trim(), model: event.model.trim(), key },
      ]);
    }

    case 'ERR':
      if (state.kind === 'exchanging') return to({ kind: 'invalid', reason: COPY.signInFailed });
      return stay(state);

    case 'CANCEL':
      if (state.kind === 'awaitingCode' || state.kind === 'exchanging') return to(state.from, [{ type: 'cancelAuth' }]);
      return stay(state);

    case 'TIMEOUT':
      if (state.kind === 'awaitingCode' || state.kind === 'exchanging') {
        return to({ kind: 'invalid', reason: COPY.signInTimedOut }, [{ type: 'cancelAuth' }]);
      }
      return stay(state);

    case 'REMOVE_KEY': {
      const auth = state.kind === 'awaitingCode' || state.kind === 'exchanging';
      return to({ kind: 'noKey' }, [...(auth ? [{ type: 'cancelAuth' as const }] : []), { type: 'removeKey' }, { type: 'expireCards' }]);
    }

    default:
      return stay(state);
  }
}
