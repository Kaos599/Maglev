// React hook for the assistant chat (build step 13). Thin: wires real prefs, the secure-store key, expo/fetch and
// AppState into createChatController. The controller is kept per runner so the chat survives leaving the screen
// (SM-42: history lives in memory for the session).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch'; // Streaming fetch: response.body.getReader() (SDK 52+).
import type { AssistantChat, ToolRunner } from '../assistant/runtime.ts';
import { addTokensUsed } from '../prefs/assistant.ts';
import { assistantPrefs, useAssistantPrefs } from '../prefs/assistantApp';
import { createStreamFn, type FetchLike } from './client.ts';
import { createChatController, goneTargets, type ChatController } from './chatController.ts';
import { useMaglevEngine } from '../../context/EngineContext';

let currentKey: string | null = null;
const controllers = new WeakMap<ToolRunner, ChatController>();

function controllerFor(runner: ToolRunner): ChatController {
  let c = controllers.get(runner);
  if (!c) {
    c = createChatController({
      runner,
      stream: createStreamFn(expoFetch as unknown as FetchLike),
      getPrefs: () => assistantPrefs.get(),
      getKey: () => currentKey,
      addUsage: (usage) => {
        assistantPrefs.update((p) => addTokensUsed(p, usage));
      },
    });
    controllers.set(runner, c);
  }
  return c;
}

export function useAssistantChat(runner: ToolRunner): AssistantChat {
  const controller = controllerFor(runner);
  const prefs = useAssistantPrefs();
  const [key, setKey] = useState<string | null>(currentKey);

  // Load the key from secure storage whenever the provider or its key name changes.
  useEffect(() => {
    let live = true;
    if (!prefs.keyRef) {
      currentKey = null;
      setKey(null);
      return;
    }
    void assistantPrefs.readKey(prefs.presetId).then((k) => {
      if (!live) return;
      currentKey = k;
      setKey(k);
    });
    return () => {
      live = false;
    };
  }, [prefs.presetId, prefs.keyRef]);

  // Prefs or key changed: recompute the gate; key removed means Clear, Assistant off means Disabled.
  useEffect(() => {
    controller.refresh();
  }, [controller, prefs, key]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') controller.background();
    });
    return () => sub.remove();
  }, [controller]);

  // R1-3: a card whose download was removed elsewhere expires instead of looking valid until Confirm.
  const { telemetry, downloads } = useMaglevEngine();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const live = new Set<string>([...telemetry.torrents.map((t) => t.id), ...downloads.map((d) => `dl:${d.id}`)]);
    for (const id of live) seen.current.add(id);
    const targets = controller
      .getSnapshot()
      .items.flatMap((i) => (i.kind === 'card' && (i.state.kind === 'proposed' || i.state.kind === 'failed') ? [runner.cardTarget(i.id)] : []));
    const resolve = (h: string) => {
      const v = runner.registry.resolve(h, 'transfer');
      return v === null ? null : String(v);
    };
    for (const h of goneTargets(targets, resolve, live, seen.current)) controller.targetGone(h);
  }, [telemetry.torrents, downloads, controller, runner]);

  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
