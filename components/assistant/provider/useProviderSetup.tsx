/**
 * Runs SM-40 (utils/assistant/providerMachine.ts) for the Settings → Assistant screen.
 * The reducer decides every state change; this hook only runs its effects (probe, storeKey, openAuth,
 * exchangeCode, cancelAuth, removeKey, expireCards), owns the form fields and the 10-minute sign-in timer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  COPY,
  INITIAL_PROVIDER_STATE,
  PROVIDER_TIMEOUT_MS,
  reduceProvider,
  type ProviderEffect,
  type ProviderEvent,
  type ProviderState,
} from '../../../utils/assistant/providerMachine';
import { PRESETS, presetById, type PresetId, type ProviderPreset } from '../../../utils/prefs/assistant';
import { assistantPrefs, useAssistantPrefs } from '../../../utils/prefs/assistantApp';
import { createOpenRouterAuth, parseAuthCode } from '../../../utils/assistantApp/openrouterAuth';
import { probeModel, type ProbeFetch } from '../../../utils/assistantApp/probe';
import { probeMayStore } from '../../../utils/assistant/providerSave';

export interface ProviderForm {
  preset: PresetId;
  key: string;
  baseUrl: string;
  model: string;
}

const auth = createOpenRouterAuth({
  randomBytes: (n) => Crypto.getRandomBytesAsync(n),
  sha256Base64: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s, { encoding: Crypto.CryptoEncoding.BASE64 }),
  secrets: {
    get: (n) => SecureStore.getItemAsync(n),
    set: (n, v) => SecureStore.setItemAsync(n, v),
    remove: (n) => SecureStore.deleteItemAsync(n),
  },
  openBrowser: async (url) => {
    await WebBrowser.openBrowserAsync(url);
  },
  fetch: fetch as unknown as Parameters<typeof createOpenRouterAuth>[0]['fetch'],
});

/** The Ollama preset has no default address (R1-14): the user types their computer's address. */
export function defaultBaseUrlFor(preset: ProviderPreset): string {
  return preset.local ? '' : preset.baseUrl;
}

function formFromPrefs(p: { presetId: PresetId; baseUrl: string; model: string }, saved: boolean): ProviderForm {
  const preset = presetById(p.presetId);
  return {
    preset: p.presetId,
    key: '',
    baseUrl: preset.local && !saved ? '' : p.baseUrl,
    model: p.model,
  };
}

/** A saved key means ready. The custom server has no key, so a non-default address means the user set it up. */
function initialState(p: { presetId: PresetId; baseUrl: string; keyRef: string | null }): ProviderState {
  if (p.keyRef) return { kind: 'ready' };
  if (p.presetId === 'custom' && p.baseUrl !== presetById('custom').baseUrl) return { kind: 'ready' };
  return INITIAL_PROVIDER_STATE;
}

export const SIGN_IN_CODE_HINT = 'Paste the code OpenRouter shows you.';
const LOCAL_NAME = "Use the computer's address (like 192.168.1.20), not a .local name.";

export function useProviderSetup(opts?: { onExpireCards?: () => void }) {
  const prefs = useAssistantPrefs();
  const [state, setState] = useState<ProviderState>(() => initialState(prefs));
  const stateRef = useRef(state);
  const [form, setFormState] = useState<ProviderForm>(() => formFromPrefs(prefs, initialState(prefs).kind === 'ready'));
  const formRef = useRef(form);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeCtl = useRef<AbortController | null>(null);
  const lastProbe = useRef<{ preset: string; baseUrl: string; model: string } | null>(null);
  const dispatchRef = useRef<(e: ProviderEvent) => void>(() => {});
  const onExpire = useRef(opts?.onExpireCards);
  onExpire.current = opts?.onExpireCards;

  const setForm = useCallback((patch: Partial<ProviderForm>) => {
    formRef.current = { ...formRef.current, ...patch };
    setFormState(formRef.current);
  }, []);

  const runEffect = useCallback(
    (fx: ProviderEffect) => {
      switch (fx.type) {
        case 'showError':
          setError(fx.message);
          break;
        case 'probe': {
          probeCtl.current?.abort();
          const ctl = new AbortController();
          probeCtl.current = ctl;
          lastProbe.current = { preset: fx.preset, baseUrl: fx.baseUrl, model: fx.model };
          probeModel(
            { preset: fx.preset, baseUrl: fx.baseUrl, model: fx.model, key: fx.key },
            fetch as unknown as ProbeFetch,
            ctl.signal,
          ).then(async (ev) => {
            if (!ev) return;
            // Remove key (or a newer test) aborted this probe: a late answer must not save the key again.
            if (!probeMayStore({ aborted: ctl.signal.aborted, state: stateRef.current })) return;
            if (ev.type === 'PROBE_OK' && ev.toolCallsWork) {
              // R1-14: settings and key are saved only once the probe passes, in one step. The key is written first;
              // if the phone refuses it, nothing switches and the user can try again.
              try {
                if (fx.key) {
                  const saved = await assistantPrefs.saveKey(
                    fx.preset as PresetId,
                    fx.key,
                    { baseUrl: fx.baseUrl, model: fx.model },
                    // Remove key during the write revokes it: the store deletes what it wrote.
                    () => probeMayStore({ aborted: ctl.signal.aborted, state: stateRef.current }),
                  );
                  if (saved === null) return;
                } else {
                  await assistantPrefs.removeKey();
                  if (!probeMayStore({ aborted: ctl.signal.aborted, state: stateRef.current })) return;
                  assistantPrefs.update({ presetId: fx.preset as PresetId, baseUrl: fx.baseUrl, model: fx.model });
                }
              } catch {
                dispatchRef.current({ type: 'STORE_FAILED' });
                return;
              }
              setForm({ key: '' });
            }
            dispatchRef.current(ev);
          });
          break;
        }
        case 'storeKey':
          // Already written before PROBE_OK was dispatched (see the probe effect).
          break;
        case 'openAuth':
          auth.start().catch(() => {
            dispatchRef.current({ type: 'CANCEL' });
            setError(COPY.signInFailed);
          });
          break;
        case 'exchangeCode':
          auth.exchange(fx.code).then((r) => {
            if (!r.ok) return dispatchRef.current({ type: 'ERR' });
            const or = presetById('openrouter');
            const model = formRef.current.preset === 'openrouter' ? formRef.current.model : or.defaultModel;
            dispatchRef.current({ type: 'KEY', key: r.key, baseUrl: or.baseUrl, model });
          });
          break;
        case 'cancelAuth':
          void auth.cancel();
          break;
        case 'removeKey':
          probeCtl.current?.abort();
          void assistantPrefs.removeKey();
          setForm({ key: '' });
          break;
        case 'expireCards':
          onExpire.current?.();
          break;
      }
    },
    [setForm],
  );

  const dispatch = useCallback(
    (event: ProviderEvent) => {
      const { state: next, effects } = reduceProvider(stateRef.current, event);
      stateRef.current = next;
      setState(next);
      setError(null);
      // The sign-in timer runs from the moment sign-in starts until the machine leaves awaitingCode/exchanging.
      const signingIn = next.kind === 'awaitingCode' || next.kind === 'exchanging';
      if (signingIn && !timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          dispatchRef.current({ type: 'TIMEOUT' });
        }, PROVIDER_TIMEOUT_MS);
      } else if (!signingIn && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // A key kept through a failed test (no credit, no tools, wrong model) goes back into the form so the user can
      // change the model and press Test model again.
      if (next.kind === 'invalid' && next.key !== undefined && next.preset) {
        const l = lastProbe.current;
        setForm({ preset: next.preset as PresetId, key: next.key, ...(l ? { baseUrl: l.baseUrl, model: l.model } : {}) });
      }
      effects.forEach(runEffect);
    },
    [runEffect, setForm],
  );
  dispatchRef.current = dispatch;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const k = stateRef.current.kind;
      if (k === 'awaitingCode' || k === 'exchanging') void auth.cancel();
    },
    [],
  );

  const pickPreset = useCallback(
    (id: PresetId) => {
      const p = presetById(id);
      setForm({ preset: id, key: '', baseUrl: defaultBaseUrlFor(p), model: p.defaultModel });
      setError(null);
    },
    [setForm],
  );

  /** Move to editing. From ready, the saved key is filled in so Test model works without pasting it again. */
  const startEdit = useCallback(async () => {
    const wasReady = stateRef.current.kind === 'ready';
    dispatch({ type: 'EDIT' });
    if (wasReady) {
      const key = await assistantPrefs.readKey(formRef.current.preset);
      if (key) setForm({ key });
    }
  }, [dispatch, setForm]);

  const save = useCallback(() => {
    const f = formRef.current;
    if (presetById(f.preset).local) {
      let host = '';
      try {
        host = new URL(f.baseUrl.trim()).hostname.toLowerCase();
      } catch {
        // validateSave reports the bad address.
      }
      if (host.endsWith('.local')) {
        setError(LOCAL_NAME);
        return;
      }
    }
    setError(null);
    dispatch({ type: 'SAVE', preset: f.preset, baseUrl: f.baseUrl, model: f.model, key: f.key });
  }, [dispatch]);

  const signIn = useCallback(() => {
    const or = presetById('openrouter');
    if (formRef.current.preset !== 'openrouter') setForm({ preset: 'openrouter', key: '', baseUrl: or.baseUrl, model: or.defaultModel });
    dispatch({ type: 'SIGN_IN_OPENROUTER' });
  }, [dispatch, setForm]);

  const submitCode = useCallback(
    (pasted: string) => {
      const code = parseAuthCode(pasted);
      if (!code) {
        setError(SIGN_IN_CODE_HINT);
        return;
      }
      dispatch({ type: 'CODE', pasted: code });
    },
    [dispatch],
  );

  const cancel = useCallback(() => dispatch({ type: 'CANCEL' }), [dispatch]);
  const removeKey = useCallback(() => dispatch({ type: 'REMOVE_KEY' }), [dispatch]);

  return {
    state,
    form,
    setForm,
    error,
    presets: PRESETS,
    pickPreset,
    startEdit,
    save,
    signIn,
    submitCode,
    cancel,
    removeKey,
    /** Name of the saved provider and model, for the ready summary. */
    saved: { preset: prefs.presetId, model: prefs.model, baseUrl: prefs.baseUrl },
  };
}

export type ProviderSetup = ReturnType<typeof useProviderSetup>;
