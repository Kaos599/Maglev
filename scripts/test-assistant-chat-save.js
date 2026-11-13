#!/usr/bin/env node
// 0.18 Assistant: the chat is saved and restored (utils/assistantApp/chatStore.ts), an interrupted turn offers Retry.
// Fake fetch and a fake ToolRunner. No network, no React. Needs Node 22.18+.
process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  }
}

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---- SSE builders ---------------------------------------------------------------------------------
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (i, o) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } })}\n\n`;
const sseText = (parts, usage) => [
  ...parts.map((p) => chunk({ content: p })),
  chunk({}, 'stop') + (usage ? usageChunk(usage[0], usage[1]) : '') + 'data: [DONE]\n\n',
];
const sseTools = (calls, usage) => [
  ...calls.map((c, i) => chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] })),
  chunk({}, 'tool_calls') + (usage ? usageChunk(usage[0], usage[1]) : '') + 'data: [DONE]\n\n',
];

/** Fake fetch. Push scripted responses; each request is recorded. */
function makeFetch() {
  const enc = new TextEncoder();
  const f = {
    queue: [],
    requests: [],
    fn: async (url, init) => {
      const rec = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
      f.requests.push(rec);
      const script = f.queue.shift() ?? { status: 500, chunks: [] };
      const headers = new Map(Object.entries(script.headers ?? {}));
      const chunks = [...(script.chunks ?? [])];
      return {
        ok: (script.status ?? 200) < 300,
        status: script.status ?? 200,
        headers: { get: (n) => headers.get(n.toLowerCase()) ?? null },
        body: {
          getReader: () => ({
            read: () => {
              if (chunks.length > 0) return Promise.resolve({ done: false, value: enc.encode(chunks.shift()) });
              if (!script.hang) return Promise.resolve({ done: true });
              return new Promise((_, reject) => {
                const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (init.signal.aborted) abort();
                else init.signal.addEventListener('abort', abort);
              });
            },
            cancel: async () => {},
          }),
        },
      };
    },
  };
  return f;
}

function makeTimers() {
  const t = { now: 0, list: [], nextId: 1 };
  t.setTimeout = (fn, ms) => {
    const id = t.nextId++;
    t.list.push({ id, fn, at: t.now + ms });
    return id;
  };
  t.clearTimeout = (id) => {
    t.list = t.list.filter((x) => x.id !== id);
  };
  t.advance = async (ms) => {
    t.now += ms;
    for (;;) {
      const due = t.list.filter((x) => x.at <= t.now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t.list = t.list.filter((x) => x !== due);
      due.fn();
      await settle();
    }
  };
  return t;
}

async function main() {
  const { HandleRegistry } = await import('../utils/assistant/handles.ts');
  const { buildSystemPrompt } = await import('../utils/assistant/systemPrompt.ts');
  const { createStreamFn, buildRequestBody, buildHeaders, parseRetryAfter, readWaitMs } = await import('../utils/assistantApp/client.ts');
  const { createChatController } = await import('../utils/assistantApp/chatController.ts');
  const { defaultAssistantPrefs, presetById } = await import('../utils/prefs/assistant.ts');
  const { createChatStore, capItems, CHAT_STORE_KEY, MAX_SAVED_ITEMS } = await import('../utils/assistantApp/chatStore.ts');
  const { INTERRUPTED, SAVE_DEBOUNCE_MS } = await import('../utils/assistantApp/chatController.ts');

  const resultView = (handle = 'r1') => ({
    handle, title: 'The Last Harbor (2023)', chips: [], sizeText: '2.1 GB', sharingText: '120 sharing', sourcesText: 'Knaben',
    fit: 'fits', fitText: '9 GB left after', reasons: [], tier: 'good',
  });
  const cardView = (cardId) => ({
    cardId, tool: 'propose_change', title: 'Pause this download?', facts: ['Show.S01'], confirmLabel: 'Pause',
    dismissLabel: 'Not now', danger: false, risky: false,
  });

  /** Build a controller with fakes. */
  function setup(opts = {}) {
    const fetch = makeFetch();
    const timers = makeTimers();
    const prefs = { ...defaultAssistantPrefs(), enabled: true, warningAcceptedAt: 1000, ...(opts.prefs ?? {}) };
    const env = { key: 'sk-test', usage: [], resets: 0, prefs };
    if (opts.key !== undefined) env.key = opts.key;
    const registry = new HandleRegistry();
    registry.issue('result', 'real-result-1'); // r1
    registry.issue('transfer', 7); // t1
    const calls = { run: [], prepare: [], revalidate: [], execute: [] };
    const runner = {
      registry,
      handlers: {
        run: async (call, ctx) => {
          ctx.progress('Searching 4 sources');
          return { content: JSON.stringify({ ok: true, data: { count: 1 } }), results: [resultView()] };
        },
        prepare: async (cardId) => cardView(cardId),
        revalidate: async () => ({ ok: true }),
        execute: async () => ({ ok: true, summary: 'Paused.' }),
      },
      run: (call, ctx) => {
        calls.run.push({ call, ctx });
        return runner.handlers.run(call, ctx);
      },
      prepareCard: (cardId, tool, args) => {
        calls.prepare.push({ cardId, tool, args });
        return runner.handlers.prepare(cardId, tool, args);
      },
      revalidate: (cardId, signal) => {
        calls.revalidate.push(cardId);
        return runner.handlers.revalidate(cardId, signal);
      },
      execute: (cardId) => {
        calls.execute.push(cardId);
        return runner.handlers.execute(cardId);
      },
      cardTarget: () => undefined,
      cardTargets: () => [],
      sourceFor: (h) => (h === 'r1' ? 'magnet:?xt=urn:btih:abc' : undefined),
      reset: () => {
        env.resets++;
      },
    };
    const controller = createChatController({
      runner,
      stream: createStreamFn(fetch.fn, { timers }),
      getPrefs: () => env.prefs,
      getKey: () => env.key,
      addUsage: (u) => {
        env.usage.push(u);
        env.prefs = { ...env.prefs, tokensUsed: { input: env.prefs.tokensUsed.input + u.input, output: env.prefs.tokensUsed.output + u.output } };
      },
      timers,
      random: () => 0.5,
      ...(opts.deps ?? {}),
    });
    return { fetch, timers, env, runner, calls, controller, chat: () => controller.getSnapshot() };
  }


  /** A fake storage shared across "processes". */
  const fakeStorage = () => {
    const m = new Map();
    return { m, writes: 0, getItem: (k) => m.get(k) ?? null, setItem(k, v) { this.writes++; m.set(k, v); } };
  };
  const storeOf = (st) => createChatStore(st);
  /** A second "process": a new controller over the same storage. */
  const reboot = (st, opts = {}) => setup({ ...opts, deps: { ...(opts.deps ?? {}), store: storeOf(st) } });
  const first = (st, opts = {}) => reboot(st, opts);

  // ---- 1. round trip -------------------------------------------------------------------------------------
  {
    const st = fakeStorage();
    const a = first(st);
    a.fetch.queue.push({ chunks: sseText(['Hello ', 'there.']) });
    a.chat().send('hi');
    await settle();
    await a.timers.advance(100);
    const before = a.chat().items;
    check('turn ended: chat saved at once', st.m.get(CHAT_STORE_KEY)?.includes('Hello there.'));
    const b = reboot(st);
    const after = b.chat().items;
    check('restore: same items in the first snapshot', JSON.stringify(after) === JSON.stringify(before), after);
    check('restore: not busy, no unseen reply', !b.chat().busy && !b.chat().unseenReply);
    b.fetch.queue.push({ chunks: sseText(['Fine.']) });
    b.chat().send('and now?');
    await settle();
    const msgs = b.fetch.requests[0].body.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`);
    check('restore: model gets the earlier text back', msgs.join('|') === 'user:hi|assistant:Hello there.|user:and now?', msgs);
    const ids = b.chat().items.map((i) => i.id);
    check('restore: new ids do not collide', new Set(ids).size === ids.length, ids);
  }

  // ---- 2. debounce ---------------------------------------------------------------------------------------
  {
    const st = fakeStorage();
    const a = first(st);
    a.fetch.queue.push({ chunks: [chunk({ content: 'one ' }), chunk({ content: 'two ' })], hang: true });
    a.chat().send('go');
    await settle();
    const w0 = st.writes; // the turn start saved already
    check('turn start saves at once (busy flag)', w0 >= 1 && JSON.parse(st.m.get(CHAT_STORE_KEY)).busy === true);
    await a.timers.advance(60);
    check('streaming text does not write per delta', st.writes === w0, st.writes - w0);
    await a.timers.advance(SAVE_DEBOUNCE_MS);
    check('one debounced write follows', st.writes === w0 + 1 && st.m.get(CHAT_STORE_KEY).includes('one two'), st.writes - w0);
    a.chat().stop();
  }

  // ---- 3. cap --------------------------------------------------------------------------------------------
  {
    const many = Array.from({ length: 260 }, (_, i) => ({ kind: 'note', id: `n${i + 1}`, text: `note ${i + 1}` }));
    const c = capItems(many);
    check('cap: last 200 items, oldest dropped', c.length === MAX_SAVED_ITEMS && c[0].id === 'n61' && c[199].id === 'n260', c.length);
    const big = Array.from({ length: 100 }, (_, i) => ({ kind: 'note', id: `n${i + 1}`, text: 'x'.repeat(20000) }));
    const cb = capItems(big);
    const bytes = JSON.stringify(cb).length;
    check('cap: 512 KB, oldest dropped, newest kept', bytes <= 512 * 1024 && cb[cb.length - 1].id === 'n100' && cb.length < 100, [bytes, cb.length]);
    const one = capItems([{ kind: 'note', id: 'n1', text: 'y'.repeat(600000) }]);
    check('cap: the newest item is never dropped', one.length === 1);
    const st = fakeStorage();
    createChatStore(st).save(many, false);
    check('cap: store writes the capped list', createChatStore(st).load().items.length === 200);
  }

  // ---- 4. interrupted turn ------------------------------------------------------------------------------
  {
    const st = fakeStorage();
    const a = first(st);
    a.runner.handlers.run = (call, ctx) => {
      ctx.progress('Searching 4 sources');
      return new Promise(() => {}); // the process dies here
    };
    a.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    a.chat().send('find The Last Harbor');
    await settle();
    check('turn in progress is saved as busy', JSON.parse(st.m.get(CHAT_STORE_KEY)).busy === true);
    await a.timers.advance(SAVE_DEBOUNCE_MS + 10);
    const saved = JSON.parse(st.m.get(CHAT_STORE_KEY));
    check('the running step was saved (busy)', saved.items.some((i) => i.kind === 'progress' && i.steps.some((s) => s.state === 'running')));

    const b = reboot(st);
    const items = b.chat().items;
    const prog = items.find((i) => i.kind === 'progress');
    check('interrupted: running step marked failed', prog && prog.steps.every((s) => s.state === 'failed'), prog);
    const tail = items[items.length - 1];
    check('interrupted: error row with Retry', tail.kind === 'error' && tail.message === INTERRUPTED && tail.action === 'retry', tail);
    check('interrupted: not busy', !b.chat().busy && b.chat().phase === 'idle');
    const c = reboot(st);
    check('a second restart adds no second row', c.chat().items.filter((i) => i.kind === 'error').length === 1);

    b.fetch.queue.push({ chunks: sseText(['Found it.']) });
    b.chat().retry();
    await settle();
    const users = b.fetch.requests[0].body.messages.filter((m) => m.role === 'user').map((m) => m.content);
    check('retry resends the last user message', users.length === 1 && users[0] === 'find The Last Harbor', users);
    const after = b.chat().items;
    check('retry: one user bubble, error row gone, reply shown', after.filter((i) => i.kind === 'user').length === 1 && !after.some((i) => i.kind === 'error') && after.some((i) => i.kind === 'assistant' && i.text === 'Found it.'), after.map((i) => i.kind));
  }

  // ---- 5. clear wipes the store --------------------------------------------------------------------------
  {
    const st = fakeStorage();
    const a = first(st);
    a.fetch.queue.push({ chunks: sseText(['Hi.']) });
    a.chat().send('hi');
    await settle();
    check('saved before clear', createChatStore(st).load() !== null);
    a.chat().clear();
    check('Clear wipes the store at once', createChatStore(st).load() === null);
    await a.timers.advance(SAVE_DEBOUNCE_MS * 2);
    check('nothing is written back after Clear', createChatStore(st).load() === null);
    check('a restart after Clear is empty', reboot(st).chat().items.length === 0);
  }

  // ---- 6. expired cards and results ---------------------------------------------------------------------
  {
    const st = fakeStorage();
    const s = createChatStore(st);
    s.save(
      [
        { kind: 'user', id: 'u1', text: 'pause it' },
        { kind: 'results', id: 'x1', results: [resultView('r1')] },
        { kind: 'card', id: 'c1', view: cardView('c1'), state: { kind: 'proposed', cardId: 'c1' } },
        { kind: 'card', id: 'c2', view: cardView('c2'), state: { kind: 'executing', cardId: 'c2' } },
        { kind: 'card', id: 'c3', view: cardView('c3'), state: { kind: 'done', cardId: 'c3', summary: 'Paused.' } },
        { kind: 'assistant', id: 'a1', text: 'Done', streaming: true },
      ],
      false,
    );
    const b = reboot(st);
    const it = (id) => b.chat().items.find((i) => i.id === id);
    check('open card restores as expired', it('c1').state.kind === 'expired' && /Expired/.test(it('c1').state.caption), it('c1').state);
    check('a card that was executing restores as expired', it('c2').state.kind === 'expired');
    check('a finished card stays done', it('c3').state.kind === 'done');
    check('result cards restore expired', it('x1').results.every((r) => r.expired === true));
    check('streaming text stops streaming', it('a1').streaming === false);
    b.chat().confirm('c1');
    await settle();
    check('confirming an expired card does nothing', b.calls.execute.length === 0 && it('c1').state.kind === 'expired');
    b.chat().askAbout('r1');
    check('Ask about an expired result is a no-op', b.fetch.requests.length === 0);
  }

  // ---- 7. junk and no key --------------------------------------------------------------------------------
  {
    const st = fakeStorage();
    st.m.set(CHAT_STORE_KEY, '{not json');
    check('a corrupt save restores empty', reboot(st).chat().items.length === 0);
    const st2 = fakeStorage();
    createChatStore(st2).save([{ kind: 'user', id: 'u1', text: 'hi' }], false);
    const nk = reboot(st2, { key: null });
    check('no API key: nothing restored and the save is wiped', nk.chat().items.length === 0 && createChatStore(st2).load() === null);
    // Cold start: a key is saved (keyRef set) but secure storage has not answered yet, so getKey() is still null.
    const st4 = fakeStorage();
    createChatStore(st4).save([{ kind: 'user', id: 'u1', text: 'hi' }, { kind: 'assistant', id: 'a2', text: 'Hello.' }], false);
    const cold = reboot(st4, { key: null, prefs: { keyRef: 'assistant.key.openrouter' } });
    check('cold start, key still loading: the chat is restored', cold.chat().items.length === 2, cold.chat().items);
    check('cold start, key still loading: the save is kept', createChatStore(st4).load() !== null);
    const st3 = fakeStorage();
    const a = first(st3);
    a.fetch.queue.push({ chunks: sseText(['Hi.']) });
    a.chat().send('hi');
    await settle();
    check('the saved text holds no API key', !st3.m.get(CHAT_STORE_KEY).includes('sk-test'));
  }

  console.log(failed === 0 ? '\nassistant chat save: all passed' : `\nassistant chat save: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
