/**
 * SM-40 Provider setup (docs/STATE_MACHINES_AND_SCREENS.md §6). Pure reducer, no React.
 * Implements the transition table literally. Anything not in the table is a no-op (same state, no effects).
 * The caller runs effects: storeKey (expo-secure-store), probe (one tool "Test model" request),
 * openAuth (OpenRouter PKCE page), exchangeCode, removeKey, expireCards.
 */
import { checkBaseUrl } from '../prefs/assistant.ts';

export type ProviderState =
  | { kind: 'noKey' }
  | { kind: 'editing' }
  | { kind: 'testing' }
  | { kind: 'ready' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'awaitingCode' }
  | { kind: 'exchanging' };

export type ProviderEvent =
  | { type: 'EDIT' }
  | { type: 'SAVE'; preset: string; baseUrl: string; model: string; key: string }
  | { type: 'PROBE_OK'; toolCallsWork: boolean }
  | { type: 'PROBE_ERR'; status: number | 'net' | 'timeout' }
  | { type: 'SIGN_IN_OPENROUTER' }
  | { type: 'CODE'; pasted: string }
  | { type: 'KEY'; key: string }
  | { type: 'ERR' }
  | { type: 'REMOVE_KEY' };

export type ProviderEffect =
  | { type: 'showError'; message: string }
  | { type: 'storeKey'; key: string }
  | { type: 'probe' }
  | { type: 'openAuth' }
  | { type: 'exchangeCode'; code: string }
  | { type: 'removeKey' }
  | { type: 'expireCards' };

/** Exact copy from SM-40. */
export const COPY = {
  pasteKey: 'Paste a key',
  httpsOnly: 'That address must start with https://',
  pickModel: 'Pick a model',
  cantUseTools: "This model can't use tools. Pick another.",
  checkKey: 'Check your key.',
  outOfCredits: 'Out of credits.',
  cantReach: "Couldn't reach the provider. Try again.",
  signInFailed: "Sign-in didn't finish. Try again.",
  modelNotFound: "That model wasn't found. Check the name.",
  rateLimited: 'Too many requests. Wait a minute and test again.',
  rejected: 'The provider refused the test. Check the address and model.',
  localCaption: 'Runs on your network. Nothing leaves it.',
} as const;

/** The machine starts with no key. SM-40 does not name an initial state; the screen starts here. */
export const INITIAL_PROVIDER_STATE: ProviderState = { kind: 'noKey' };

/** SAVE field checks, in order: key, base URL, model. Returns the first field error or null. */
export function validateSave(e: { baseUrl: string; model: string; key: string }): string | null {
  if (!e.key.trim()) return COPY.pasteKey;
  if (!checkBaseUrl(e.baseUrl).ok) return COPY.httpsOnly;
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
      if (state.kind !== 'editing') return stay(state);
      const error = validateSave(event);
      if (error) return to(state, [{ type: 'showError', message: error }]);
      return to({ kind: 'testing' }, [{ type: 'storeKey', key: event.key.trim() }, { type: 'probe' }]);
    }

    case 'PROBE_OK':
      if (state.kind !== 'testing') return stay(state);
      if (event.toolCallsWork) return to({ kind: 'ready' });
      return to({ kind: 'invalid', reason: COPY.cantUseTools });

    case 'PROBE_ERR': {
      if (state.kind !== 'testing') return stay(state);
      const s = event.status;
      if (s === 401 || s === 403) return to({ kind: 'invalid', reason: COPY.checkKey });
      if (s === 402) return to({ kind: 'invalid', reason: COPY.outOfCredits });
      if (s === 'net' || s === 'timeout' || (typeof s === 'number' && s >= 500 && s <= 599)) {
        return to({ kind: 'invalid', reason: COPY.cantReach });
      }
      // Any other status must still leave `testing`, or the screen hangs on "Testing…".
      if (s === 404) return to({ kind: 'invalid', reason: COPY.modelNotFound });
      if (s === 429) return to({ kind: 'invalid', reason: COPY.rateLimited });
      return to({ kind: 'invalid', reason: COPY.rejected });
    }

    case 'SIGN_IN_OPENROUTER':
      if (state.kind === 'noKey') return to({ kind: 'awaitingCode' }, [{ type: 'openAuth' }]);
      return stay(state);

    case 'CODE':
      if (state.kind === 'awaitingCode') return to({ kind: 'exchanging' }, [{ type: 'exchangeCode', code: event.pasted.trim() }]);
      return stay(state);

    case 'KEY':
      if (state.kind === 'exchanging') return to({ kind: 'testing' }, [{ type: 'storeKey', key: event.key.trim() }, { type: 'probe' }]);
      return stay(state);

    case 'ERR':
      if (state.kind === 'exchanging') return to({ kind: 'invalid', reason: COPY.signInFailed });
      return stay(state);

    case 'REMOVE_KEY':
      return to({ kind: 'noKey' }, [{ type: 'removeKey' }, { type: 'expireCards' }]);

    default:
      return stay(state);
  }
}
