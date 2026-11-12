#!/usr/bin/env node
// Assistant chat controller (build step 13): systemPrompt, provider client, chatController.
// Fake fetch (recorded-style SSE) and a fake ToolRunner. No network, no React.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
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
  const { createStreamFn, buildRequestBody, buildHeaders, parseRetryAfter } = await import('../utils/assistantApp/client.ts');
  const { createChatController, TOOL_TIMEOUT_MS } = await import('../utils/assistantApp/chatController.ts');
  const { defaultAssistantPrefs, presetById } = await import('../utils/prefs/assistant.ts');
  const { turnInitial, turnStep } = await import('../utils/assistant/turnMachine.ts');

  const resultView = (handle = 'r1') => ({
    handle, title: 'The Last Harbor (2023)', chips: [], sizeText: '2.1 GB', sharingText: '120 sharing', sourcesText: 'Knaben',
    fit: 'fits', fitText: '9 GB left after', reasons: [], tier: 'good',
  });
  const cardView = (cardId) => ({
    cardId, tool: 'propose_pause_resume', title: 'Pause this download?', facts: ['Show.S01'], confirmLabel: 'Pause',
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
    });
    return { fetch, timers, env, runner, calls, controller, chat: () => controller.getSnapshot() };
  }
  const kinds = (chat) => chat.items.map((i) => i.kind);
  const lastReqMsgs = (fetch) => fetch.requests.at(-1).body.messages;
  const toolMsg = (msgs, id) => msgs.find((m) => m.role === 'tool' && m.tool_call_id === id);

  // ---- system prompt ------------------------------------------------------------------------------
  {
    const p = buildSystemPrompt();
    check('system prompt: sharing wording, no year rule, cards need a tap, no setting tool', p.includes('sharing') && p.includes("Never add a year") && p.includes('Nothing happens until the user taps the card') && !p.includes('propose_setting_change') && !p.includes('propose_url_download'), p.length);
    const q = buildSystemPrompt({ profile: 'tv', maxSizeGb: 5, language: 'English', glossaryKeys: ['x265'] });
    check('system prompt: profile lines added only when set', q.includes('on a tv') && q.includes('5 GB') && q.includes('x265') && !p.includes('About this user'));
  }

  // ---- client helpers -----------------------------------------------------------------------------
  {
    check('parseRetryAfter: seconds, date, junk', parseRetryAfter('3') === 3000 && parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')) === 5000 && parseRetryAfter('soon') === undefined && parseRetryAfter(null) === undefined);
    const base = turnStep(turnInitial({ system: 'S', registry: new HandleRegistry() }), { type: 'Send', text: 'hi', enabled: true, warningAccepted: true, hasKey: true }).effects[1];
    const mk = (presetId, apiKey = 'k') => ({ request: base, presetId, baseUrl: presetById(presetId).baseUrl, model: 'm', apiKey });
    const o = buildRequestBody(mk('openrouter'));
    check('body: system first, tools, auto, stream, usage extras, max_completion_tokens, parallel false', o.messages[0].role === 'system' && o.tools.length === 13 && o.tool_choice === 'auto' && o.stream === true && o.stream_options.include_usage === true && o.max_completion_tokens === 2048 && o.parallel_tool_calls === false, Object.keys(o));
    check('body: groq omits parallel_tool_calls', !('parallel_tool_calls' in buildRequestBody(mk('groq'))));
    const g = buildRequestBody(mk('gemini'));
    check('body: gemini and custom use max_tokens', g.max_tokens === 2048 && !('max_completion_tokens' in g) && buildRequestBody(mk('custom')).max_tokens === 2048);
    check('headers: bearer when a key exists, none for a keyless local server', buildHeaders(mk('openai')).Authorization === 'Bearer k' && !('Authorization' in buildHeaders(mk('custom', null))));
  }

  // ---- text-only turn (recorded fixture) ----------------------------------------------------------
  {
    const s = setup();
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/assistant/sse-openai-text.txt'), 'utf8');
    s.fetch.queue.push({ chunks: [fixture.slice(0, 700), fixture.slice(700)] });
    let notified = 0;
    s.controller.subscribe(() => notified++);
    s.chat().send('why is it stuck?');
    check('send: busy right away, user item first', s.chat().busy && s.chat().items[0].kind === 'user' && s.chat().items[0].text === 'why is it stuck?');
    await settle();
    await s.timers.advance(60);
    const c = s.chat();
    const a = c.items.find((i) => i.kind === 'assistant');
    check('text turn: one assistant item with the full text, not streaming', c.items.length === 2 && a.text === 'Your download is stuck at 99%, usually because no peers are left.' && a.streaming === false && !c.busy, c.items);
    check('text turn: usage added from the stream', JSON.stringify(s.env.usage) === JSON.stringify([{ input: 812, output: 14 }]) && c.tokensUsed.input === 812);
    const req = s.fetch.requests[0];
    check('request: chat/completions URL, bearer key, model, system message first', req.url === 'https://openrouter.ai/api/v1/chat/completions' && req.headers.Authorization === 'Bearer sk-test' && req.body.model === presetById('openrouter').defaultModel && req.body.messages[0].role === 'system' && req.body.messages.at(-1).content === 'why is it stuck?');
    check('subscribers were notified and snapshots are stable between changes', notified > 0 && s.chat() === s.chat());
  }

  // ---- model text is filtered ----------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: sseText(['Get it at https://ev', 'il.example/x now']) });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(60);
    const a = s.chat().items.find((i) => i.kind === 'assistant');
    check('model text: links removed from what is shown', a && !a.text.includes('evil') && !a.text.includes('http'), a?.text);
  }

  // ---- tool round trip -------------------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }], [100, 10]) });
    s.fetch.queue.push({ chunks: sseText(['Two good options.'], [200, 20]) });
    s.chat().send('find The Last Harbor');
    await settle();
    await s.timers.advance(60);
    const c = s.chat();
    const prog = c.items.find((i) => i.kind === 'progress');
    check('tool round trip: progress item with a done step, results item, then text', kinds(c).join() === 'user,progress,results,assistant' && prog.steps[0].text === 'Searching 4 sources' && prog.steps[0].state === 'done' && c.items[2].results[0].handle === 'r1', kinds(c));
    check('tool round trip: second request carries the tool result', s.fetch.requests.length === 2 && toolMsg(lastReqMsgs(s.fetch), 'k1').content.includes('"ok":true'));
    check('tool round trip: usage of both requests added', s.env.usage.length === 2 && c.tokensUsed.input === 300);
    check('runner got validated args with the resolved handle', s.calls.run[0].call.name === 'search_torrents');
  }

  // ---- proposal -> card -> confirm -> note ------------------------------------------------------------
  async function proposalTurn(s) {
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'propose_pause_resume', args: { transfer_id: 't1', action: 'pause', reason: 'Because.' } }]) });
    s.fetch.queue.push({ chunks: sseText(["I've put it on a card."]) });
    s.chat().send('pause my show');
    await settle();
    await s.timers.advance(60);
    return s.chat().items.find((i) => i.kind === 'card');
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    check('proposal: card item (proposed) before the closing text', card && card.state.kind === 'proposed' && kinds(s.chat()).join() === 'user,card,assistant', kinds(s.chat()));
    check('proposal: model was told "proposed"', toolMsg(lastReqMsgs(s.fetch), 'k1').content.includes('proposed'));
    check('proposal: turn rests with a pending card, not busy', !s.chat().busy);
    s.chat().confirm(card.id);
    await settle();
    const c = s.chat();
    const done = c.items.find((i) => i.kind === 'card');
    check('confirm: revalidate then execute, card done, note added', s.calls.revalidate.length === 1 && s.calls.execute.length === 1 && done.state.kind === 'done' && c.items.at(-1).kind === 'note' && c.items.at(-1).text === 'Paused.', done.state);
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.chat().dismiss(card.id);
    await settle();
    check('dismiss: card dismissed, nothing executed', s.chat().items.find((i) => i.kind === 'card').state.kind === 'dismissed' && s.calls.execute.length === 0 && s.calls.revalidate.length === 0);
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.runner.handlers.revalidate = async () => ({ ok: false, reason: 'That download is gone.' });
    s.chat().confirm(card.id);
    await settle();
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('revalidate failure: card stays proposed with the reason, no execute', st.kind === 'proposed' && st.reason === 'That download is gone.' && s.calls.execute.length === 0, st);
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.runner.handlers.execute = async () => ({ ok: false, code: 'E_X', message: 'Could not pause it.' });
    s.chat().confirm(card.id);
    await settle();
    check('execute failure: card failed with the message', s.chat().items.find((i) => i.kind === 'card').state.kind === 'failed' && s.chat().items.find((i) => i.kind === 'card').state.error === 'Could not pause it.');
    s.runner.handlers.execute = async () => ({ ok: true, summary: 'Paused.' });
    s.chat().confirm(card.id); // the UI's "Try again"
    await settle();
    const c = s.chat();
    check('confirm on a failed card is RETRY: revalidates again, executes, done', s.calls.revalidate.length === 2 && s.calls.execute.length === 2 && c.items.find((i) => i.kind === 'card').state.kind === 'done' && c.items.at(-1).text === 'Paused.', c.items.find((i) => i.kind === 'card').state);
  }
  {
    // The runner refuses the card after the machine said "proposed": the model must see the refusal.
    const s = setup();
    s.runner.handlers.prepare = async () => ({ error: 'That one looks risky, so I did not make a card.' });
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'propose_pause_resume', args: { transfer_id: 't1', action: 'pause', reason: 'Because.' } }]) });
    s.fetch.queue.push({ chunks: sseText(['Sorry.']) });
    s.chat().send('pause');
    await settle();
    await s.timers.advance(60);
    check('refused card: no card item, the next request carries the error as the tool result', !s.chat().items.some((i) => i.kind === 'card') && toolMsg(lastReqMsgs(s.fetch), 'k1').content.includes('looks risky'), toolMsg(lastReqMsgs(s.fetch), 'k1'));
    check('refused card: the turn is not stuck waiting for it', !s.chat().busy && s.chat().items.at(-1).kind === 'assistant');
  }

  // ---- HTTP failures -----------------------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ status: 401, chunks: [] });
    s.chat().send('hi');
    await settle();
    const e = s.chat().items.at(-1);
    check('401: error item "Check your key." with action settings', e.kind === 'error' && e.message === 'Check your key.' && e.action === 'settings' && !s.chat().busy, e);
  }
  {
    const s = setup();
    s.fetch.queue.push({ status: 402, chunks: [] });
    s.chat().send('hi');
    await settle();
    check('402: "Out of credits." with action settings', s.chat().items.at(-1).action === 'settings' && s.chat().items.at(-1).message === 'Out of credits.');
  }
  {
    const s = setup();
    s.fetch.queue.push({ status: 429, headers: { 'retry-after': '2' }, chunks: [] });
    s.chat().send('hi');
    await settle();
    const e = s.chat().items.at(-1);
    check('429: SM-31 does not retry it; error item "Rate limited." with action retry', s.fetch.requests.length === 1 && e.message === 'Rate limited. Try again in a minute.' && e.action === 'retry', e);
  }
  {
    const s = setup();
    s.fetch.queue.push({ status: 503, headers: { 'retry-after': '2' }, chunks: [] });
    s.fetch.queue.push({ chunks: sseText(['Back again.']) });
    s.chat().send('hi');
    await settle();
    const early = s.fetch.requests.length;
    await s.timers.advance(1999);
    const before = s.fetch.requests.length;
    await s.timers.advance(2);
    await s.timers.advance(60);
    check('503 with Retry-After: waits for the header, then retries once and shows the answer', early === 1 && before === 1 && s.fetch.requests.length === 2 && s.chat().items.at(-1).text === 'Back again.', [early, before, s.fetch.requests.length]);
  }
  {
    const s = setup();
    s.fetch.queue.push({ status: 500, chunks: [] });
    s.fetch.queue.push({ status: 500, chunks: [] });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(1000 + 250);
    const e = s.chat().items.at(-1);
    check('5xx twice: one retry (1 s plus jitter), then "The provider is having trouble."', s.fetch.requests.length === 2 && e.kind === 'error' && e.message === 'The provider is having trouble. Try again later.' && e.action === 'retry', e);
  }

  // ---- Stop / Clear / Background ----------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: [chunk({ content: 'Partial ' })], hang: true });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(60);
    check('streaming: partial text is shown while busy', s.chat().busy && s.chat().items.some((i) => i.kind === 'assistant' && i.streaming && i.text === 'Partial '), s.chat().items);
    s.chat().stop();
    await settle();
    const c = s.chat();
    check('Stop: fetch signal aborted, not busy, item closed, "Stopped." note', s.fetch.requests[0].signal.aborted && !c.busy && c.items.find((i) => i.kind === 'assistant').streaming === false && c.items.at(-1).text === 'Stopped.', c.items);
  }
  {
    // Stop while a read tool runs: the tool's signal aborts and the model later sees "cancelled".
    const s = setup();
    s.runner.handlers.run = (call, ctx) => new Promise(() => {}); // never answers
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    s.chat().send('find it');
    await settle();
    const sig = s.calls.run[0].ctx.signal;
    check('tool running: busy', s.chat().busy && !sig.aborted);
    s.chat().stop();
    await settle();
    check('Stop during tools: tool signal aborted, not busy', sig.aborted && !s.chat().busy);
    s.fetch.queue.push({ chunks: sseText(['ok']) });
    s.chat().send('again');
    await settle();
    check('after Stop the cancelled call still has its tool message (pairing valid; older turns are digested)', !!toolMsg(lastReqMsgs(s.fetch), 'k1') && !toolMsg(lastReqMsgs(s.fetch), 'k1').content.includes('"ok":true'), toolMsg(lastReqMsgs(s.fetch), 'k1'));
  }
  {
    const s = setup();
    s.fetch.queue.push({ chunks: [chunk({ content: 'x' })], hang: true });
    s.chat().send('hi');
    await settle();
    s.controller.background();
    await settle();
    check('Background aborts the stream', s.fetch.requests[0].signal.aborted && !s.chat().busy);
  }
  {
    const s = setup();
    s.runner.handlers.run = () => new Promise(() => {});
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    s.fetch.queue.push({ chunks: sseText(['I could not finish that search.']) });
    s.chat().send('find it');
    await settle();
    await s.timers.advance(TOOL_TIMEOUT_MS);
    await s.timers.advance(60);
    check('60 s tool timeout: answered "That took too long." and the turn goes on', s.calls.run[0].ctx.signal.aborted && toolMsg(lastReqMsgs(s.fetch), 'k1').content.includes('That took too long.') && s.chat().items.at(-1).text === 'I could not finish that search.', toolMsg(lastReqMsgs(s.fetch), 'k1'));
  }
  {
    // Review fix: one call finishes, the other times out. The turn must go on with both answers.
    const s = setup();
    s.runner.handlers.run = (call) =>
      call.id === 'k1' ? Promise.resolve({ content: JSON.stringify({ ok: true, data: { found: 2 } }) }) : new Promise(() => {});
    s.fetch.queue.push({
      chunks: sseTools([
        { id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } },
        { id: 'k2', name: 'get_free_space', args: {} },
      ]),
    });
    s.fetch.queue.push({ chunks: sseText(['Here is what I found.']) });
    s.chat().send('find it');
    await settle();
    await s.timers.advance(TOOL_TIMEOUT_MS);
    await s.timers.advance(60);
    const msgs = lastReqMsgs(s.fetch);
    check('one call done + one timed out: second request carries both answers and the turn ends',
      s.fetch.requests.length === 2 && toolMsg(msgs, 'k1')?.content.includes('"ok":true') && toolMsg(msgs, 'k2')?.content.includes('That took too long.') && !s.chat().busy,
      { reqs: s.fetch.requests.length, busy: s.chat().busy });
  }

  {
    const s = setup();
    const card = await proposalTurn(s);
    s.chat().clear();
    await settle();
    check('Clear: items empty, runner.reset called, not busy', s.chat().items.length === 0 && s.env.resets === 1 && !s.chat().busy && card);
    s.fetch.queue.push({ chunks: sseText(['fresh']) });
    s.chat().send('hello');
    await settle();
    check('after Clear the history is gone (request has system + the new user message only)', lastReqMsgs(s.fetch).length === 2);
  }
  {
    // Clear while a request is in flight aborts it and late events do not come back.
    const s = setup();
    s.fetch.queue.push({ chunks: [], hang: true });
    s.chat().send('hi');
    await settle();
    s.chat().clear();
    await settle();
    check('Clear while requesting: fetch aborted, no items, not busy', s.fetch.requests[0].signal.aborted && s.chat().items.length === 0 && !s.chat().busy);
  }

  // ---- gate ---------------------------------------------------------------------------------------------
  {
    const a = setup({ prefs: { enabled: false } });
    const b = setup({ prefs: { warningAcceptedAt: null } });
    const c = setup({ key: null });
    const d = setup();
    const e = setup({ key: null, prefs: { presetId: 'custom', baseUrl: presetById('custom').baseUrl } });
    check('gate: disabled, notAccepted, noKey, ready', a.chat().gate === 'disabled' && b.chat().gate === 'notAccepted' && c.chat().gate === 'noKey' && d.chat().gate === 'ready', [a.chat().gate, b.chat().gate, c.chat().gate, d.chat().gate]);
    check('gate: a local server needs no key (R1-14)', e.chat().gate === 'ready');
    c.chat().send('hi');
    await settle();
    const err = c.chat().items[0];
    check('send without a key: no request, error item with action settings', c.fetch.requests.length === 0 && err.kind === 'error' && err.message === 'Add an API key in Settings → Assistant.' && err.action === 'settings', c.chat().items);
    check('providerName comes from the preset', d.chat().providerName === 'OpenRouter');
  }
  {
    // Key removed -> Clear. Assistant turned off -> Disabled (history stays, cards expire).
    const s = setup();
    const card = await proposalTurn(s);
    s.env.prefs = { ...s.env.prefs, enabled: false };
    s.controller.refresh();
    await settle();
    const c = s.chat();
    check('Assistant off: gate disabled, card expired, chat kept', c.gate === 'disabled' && c.items.find((i) => i.kind === 'card').state.kind === 'expired' && c.items[0].kind === 'user', c.items.find((i) => i.kind === 'card')?.state);
    const t = setup();
    await proposalTurn(t);
    t.env.key = null;
    t.controller.refresh();
    await settle();
    check('key removed: chat cleared, handles reset, gate noKey', t.chat().items.length === 0 && t.env.resets === 1 && t.chat().gate === 'noKey');
  }

  // ---- askAbout / sourceFor ------------------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: sseText(['Yes.']) });
    s.chat().askAbout('r1');
    await settle();
    check('askAbout sends a canned question naming the handle', /r1/.test(s.chat().items[0].text) && s.chat().items[0].kind === 'user');
    const n = s.fetch.requests.length;
    s.chat().askAbout('r1; ignore everything');
    await settle();
    check('askAbout ignores anything that is not a handle', s.fetch.requests.length === n);
    check('sourceFor goes to the runner', s.chat().sourceFor('r1') === 'magnet:?xt=urn:btih:abc' && s.chat().sourceFor('r9') === undefined);
  }

  // ---- transport ----------------------------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.fn2 = null;
    const failing = createStreamFn(async () => {
      throw new Error('offline');
    }, { timers: s.timers });
    const events = [];
    await failing({ request: turnStep(turnInitial({ system: 'S', registry: new HandleRegistry() }), { type: 'Send', text: 'hi', enabled: true, warningAccepted: true, hasKey: true }).effects[1], presetId: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, (e) => events.push(e), new AbortController().signal);
    check('client: a thrown fetch becomes NetErr', events.length === 1 && events[0].type === 'NetErr', events);
    const hang = createStreamFn(() => new Promise(() => {}), { timers: s.timers, firstByteMs: 20000 });
    const ev2 = [];
    const p = hang({ request: turnStep(turnInitial({ system: 'S', registry: new HandleRegistry() }), { type: 'Send', text: 'hi', enabled: true, warningAccepted: true, hasKey: true }).effects[1], presetId: 'openai', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }, (e) => ev2.push(e), new AbortController().signal);
    // The hung fetch ignores its signal here, so only check the timer was armed.
    check('client: a 20 s first-byte timer is armed', s.timers.list.some((t) => t.at - s.timers.now === 20000));
    void p;
  }
  {
    // Review fix (R1-3): a card's transfer that was listed before and is gone now expires the card.
    const { goneTargets } = await import('../utils/assistantApp/chatController.ts');
    const resolve = (h) => ({ t1: 'tor1', t2: 'tor2', t3: 'dl:7' })[h] ?? null;
    const seen = new Set(['tor1', 'tor2', 'dl:7']);
    check('goneTargets: removed torrent and link download expire', JSON.stringify(goneTargets(['t1', 't2', 't3', 'r1', undefined], resolve, new Set(['tor2']), seen)) === JSON.stringify(['t1', 't3']));
    check('goneTargets: an engine restart that empties a never-seen list expires nothing', goneTargets(['t1'], resolve, new Set(), new Set()).length === 0);
    check('goneTargets: result handles are never transfers', goneTargets(['r1'], () => 'x', new Set(), new Set(['x'])).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
