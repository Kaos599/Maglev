// React hook for the assistant chat (build step 13). Thin: wires real prefs, the secure-store key, expo/fetch and
// AppState into createChatController. The controller is kept per runner so the chat survives leaving the screen
// (SM-42: history lives in memory for the session).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch'; // Streaming fetch: response.body.getReader() (SDK 52+).
import type { AssistantChat, ToolRunner } from '../assistant/runtime.ts';
import { addTokensUsed, keyFor, type TaggedKey } from '../prefs/assistant.ts';
import { assistantPrefs, useAssistantPrefs } from '../prefs/assistantApp';
import { createStreamFn, type FetchLike } from './client.ts';
import { createChatController, goneTargets, type ChatController } from './chatController.ts';
import { useMaglevEngine } from '../../context/EngineContext';

// The loaded key is tagged with the preset it belongs to; keyFor() returns it only for that preset.
let loadedKey: TaggedKey | null = null;
const controllers = new WeakMap<ToolRunner, ChatController>();

function controllerFor(runner: ToolRunner): ChatController {
  let c = controllers.get(runner);
  if (!c) {
    c = createChatController({
      runner,
      stream: createStreamFn(expoFetch as unknown as FetchLike),
      getPrefs: () => assistantPrefs.get(),
      getKey: () => keyFor(loadedKey, assistantPrefs.get()),
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
  const [loaded, setLoaded] = useState<TaggedKey | null>(loadedKey);

  // Load the key from secure storage whenever the provider or its key name changes.
  useEffect(() => {
    let live = true;
    if (!prefs.keyRef) return;
    void assistantPrefs.readKey(prefs.presetId).then((k) => {
      if (!live) return;
      loadedKey = { presetId: prefs.presetId, key: k };
      setLoaded(loadedKey);
    });
    return () => {
      live = false;
    };
  }, [prefs.presetId, prefs.keyRef]);

  // A key is saved but not yet loaded for this provider (a switch in progress): do not look at the gate yet,
  // or the missing key would read as "removed" and clear the chat. Only a real removal (keyRef null) clears.
  const loadPending = prefs.keyRef !== null && (loaded === null || loaded.presetId !== prefs.presetId);

  // Prefs or key changed: recompute the gate; key removed means Clear, Assistant off means Disabled.
  useEffect(() => {
    if (loadPending) return;
    controller.refresh();
  }, [controller, prefs, loaded, loadPending]);

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
      .items.flatMap((i) =>
        i.kind === 'card' && (i.state.kind === 'proposed' || i.state.kind === 'failed')
          ? (runner.cardTargets?.(i.id) ?? [runner.cardTarget(i.id)])
          : [],
      );
    const resolve = (h: string) => {
      const v = runner.registry.resolve(h, 'transfer');
      return v === null ? null : String(v);
    };
    for (const h of goneTargets(targets, resolve, live, seen.current)) controller.targetGone(h);
  }, [telemetry.torrents, downloads, controller, runner]);

  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
