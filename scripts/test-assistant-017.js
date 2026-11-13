#!/usr/bin/env node
// 0.17 Assistant: working phase, instant Stop, live step detail, keeps working when the user leaves, unseen reply.
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
  const { createChatController, TOOL_TIMEOUT_MS } = await import('../utils/assistantApp/chatController.ts');
  const { defaultAssistantPrefs, presetById } = await import('../utils/prefs/assistant.ts');
  const { turnInitial, turnStep } = await import('../utils/assistant/turnMachine.ts');

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

  // ---- 1. phase -----------------------------------------------------------------------------------------
  {
    const s = setup();
    check('idle chat: phase idle', s.chat().phase === 'idle' && !s.chat().busy);
    let release;
    s.runner.handlers.run = (call, ctx) => {
      ctx.progress('Searching 4 sources');
      return new Promise((r) => {
        release = () => r({ content: JSON.stringify({ ok: true, data: { count: 1 } }), results: [resultView()] });
      });
    };
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    s.fetch.queue.push({ chunks: [chunk({ content: 'Two ' })], hang: true });
    s.chat().send('find it');
    check('Send: phase thinking before any byte', s.chat().busy && s.chat().phase === 'thinking', s.chat().phase);
    await settle();
    check('a step is running: phase tools', s.chat().phase === 'tools', s.chat().phase);
    release();
    await settle();
    check('tools finished, model not answered yet: thinking again', s.chat().phase === 'thinking' || s.chat().phase === 'writing', s.chat().phase);
    await s.timers.advance(60);
    check('text streaming: phase writing', s.chat().phase === 'writing', s.chat().phase);
    s.chat().stop();
    check('Stop: phase idle at once', s.chat().phase === 'idle' && !s.chat().busy);
  }

  // ---- 2. Stop is immediate -----------------------------------------------------------------------------
  {
    // The connection never answers: fetch itself hangs and ignores the signal.
    const s = setup();
    const hung = createStreamFn(() => new Promise(() => {}), { timers: s.timers });
    const ac = new AbortController();
    const events = [];
    const done = hung({ request: { messages: [{ role: 'user', content: 'hi' }], tools: [] }, presetId: 'openrouter', baseUrl: presetById('openrouter').baseUrl, model: 'm', apiKey: 'k' }, (e) => events.push(e), ac.signal);
    let settled = false;
    void done.then(() => { settled = true; });
    await settle(1);
    ac.abort();
    await settle(2);
    check('client: abort while connecting settles at once, with no event', settled && events.length === 0, events);
  }
  {
    const s = setup({ deps: { stream: undefined } });
    const hung = createStreamFn(() => new Promise(() => {}), { timers: s.timers });
    const c2 = createChatController({
      runner: s.runner, stream: hung, getPrefs: () => s.env.prefs, getKey: () => 'k', addUsage: () => {}, timers: s.timers, random: () => 0.5,
    });
    c2.getSnapshot().send('hi');
    await settle(2);
    c2.getSnapshot().stop();
    const snap = c2.getSnapshot();
    check('controller: Stop while connecting is instant: not busy, "Stopped." shown', !snap.busy && snap.items.at(-1).kind === 'note' && snap.items.at(-1).text === 'Stopped.', snap.items);
  }
  {
    // A tool that answers after Stop leaves no card and no step change.
    const s = setup();
    let release;
    s.runner.handlers.run = () => new Promise((r) => { release = () => r({ content: JSON.stringify({ ok: true, data: {} }), results: [resultView()] }); });
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    s.chat().send('find it');
    await settle();
    s.chat().stop();
    const stoppedNow = s.chat();
    check('Stop during tools is instant: not busy, "Stopped." note', !stoppedNow.busy && stoppedNow.items.at(-1).text === 'Stopped.');
    release();
    await settle();
    check('a late tool result after Stop is dropped (no results card, still idle)', !s.chat().items.some((i) => i.kind === 'results') && !s.chat().busy, s.chat().items.map((i) => i.kind));
  }
  {
    // A card still preparing must not hold the next question after Stop.
    const s = setup();
    s.runner.handlers.prepare = () => new Promise(() => {});
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'propose_change', args: { target: 't1', action: 'pause' } }]) });
    s.fetch.queue.push({ chunks: sseText(['ok']) });
    s.chat().send('pause it');
    await settle();
    s.chat().stop();
    s.chat().send('hello');
    await settle();
    check('after Stop, a stuck card preparation does not delay the next request', s.fetch.requests.length >= 2, s.fetch.requests.length);
  }

  // ---- 3. step detail -----------------------------------------------------------------------------------
  {
    const s = setup();
    s.runner.handlers.run = async (call, ctx) => {
      ctx.progress('Searching: harbor', 'running');
      ctx.progress('Searching: harbor', 'running', 'Knaben answered \u00b7 1 of 3 sources');
      ctx.progress('Searching: harbor', 'done'); // the tool marks it done before it returns
      return { content: JSON.stringify({ ok: true, data: {} }), detail: '23 results from 4 sources', results: [resultView()] };
    };
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'harbor' } }]) });
    s.fetch.queue.push({ chunks: sseText(['ok']) });
    let live;
    s.controller.subscribe(() => {
      const p = s.chat().items.find((i) => i.kind === 'progress');
      if (p && p.steps[0].state === 'running' && p.steps[0].detail) live = p.steps[0].detail;
    });
    s.chat().send('find harbor');
    await settle();
    const step = s.chat().items.find((i) => i.kind === 'progress').steps[0];
    check('a running step carries its live detail', live === 'Knaben answered \u00b7 1 of 3 sources', live);
    check('final detail attaches although the tool already marked the step done', step.state === 'done' && step.detail === '23 results from 4 sources', step);
  }

  // ---- 4. leaving the app -------------------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: [chunk({ content: 'Partial ' })], hang: true });
    s.chat().send('hi');
    await settle();
    s.controller.background();
    await settle();
    check('going to the background does not stop the turn', s.chat().busy && !s.fetch.requests[0].signal.aborted && !s.chat().items.some((i) => i.kind === 'error'), s.chat().items.map((i) => i.kind));
  }
  {
    const hook = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'utils', 'assistantApp', 'useAssistantChat.ts'), 'utf8');
    check('the hook no longer aborts on AppState background', !/background\(\)/.test(hook));
  }

  // ---- 5. unseen reply ----------------------------------------------------------------------------------
  {
    const changes = [];
    const s = setup({ deps: { onUnseenChange: (v) => changes.push(v) } });
    s.controller.setFocused(false);
    s.fetch.queue.push({ chunks: sseText(['Done.']) });
    s.chat().send('hi');
    check('no badge while the turn runs', s.chat().unseenReply === false);
    await settle();
    await s.timers.advance(60);
    check('a reply that finishes while the tab is away sets unseenReply', s.chat().unseenReply === true && changes.at(-1) === true, changes);
    s.controller.setFocused(true);
    check('seeing the tab clears it', s.chat().unseenReply === false && changes.at(-1) === false);
    s.fetch.queue.push({ chunks: sseText(['Again.']) });
    s.chat().send('again');
    await settle();
    await s.timers.advance(60);
    check('a reply that finishes in view does not set it', s.chat().unseenReply === false);
  }

  // ---- 6. view helpers ----------------------------------------------------------------------------------
  {
    const { stepDetail, traceOpen, workingLabel } = await import('../utils/assistant/chatView.ts');
    const running = { callId: 'k', text: 'Searching: harbor', state: 'running', tool: 'search_torrents', detail: 'Knaben answered \u00b7 2 of 5 sources' };
    check('stepDetail: a running step shows its live detail', stepDetail(running) === 'Knaben answered \u00b7 2 of 5 sources');
    check('stepDetail: without live detail a running step shows its query', stepDetail({ ...running, detail: undefined }) === 'Searching: harbor');
    check('traceOpen: opens by itself while a step runs', traceOpen(null, [running]) === true);
    check('traceOpen: stays closed once everything is done', traceOpen(null, [{ ...running, state: 'done' }]) === false);
    check('traceOpen: the user choice wins both ways', traceOpen(false, [running]) === false && traceOpen(true, [{ ...running, state: 'done' }]) === true);
    check('workingLabel: thinking says Thinking…, others say nothing', workingLabel('thinking') === 'Thinking\u2026' && workingLabel('writing') === null && workingLabel('idle') === null);
  }

  // ---- 7. file check: glued or split title words ----------------------------------------------------------
  {
    const { checkFileSafety } = await import('../utils/assistant/fileSafety.ts');
    const mismatch = (queryTitle, file) =>
      checkFileSafety({ name: file, category: 'movie', queryTitle, files: [{ path: `${file}.mkv`, sizeBytes: 3 * 1024 ** 3 }] })
        .findings.some((f) => f.code === 'title_mismatch');
    check('file check: "prime time" matches Primetime', !mismatch('prime time', 'Primetime.2026.1080p.WEB-DL'));
    check('file check: "primetime" matches Prime.Time', !mismatch('primetime', 'Prime.Time.2026.1080p.WEB-DL'));
    check('file check: "prime time" still flags Prime.Suspect', mismatch('prime time', 'Prime.Suspect.S01.1080p'));
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nassistant 0.17 tests passed');
}
main();
