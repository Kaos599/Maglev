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
    check('401: error item names the provider, with action settings', e.kind === 'error' && e.message === "OpenRouter didn't accept your key. Sign in again in Settings → Assistant." && e.action === 'settings' && !s.chat().busy, e);
  }
  {
    const s = setup();
    s.fetch.queue.push({ status: 402, chunks: [] });
    s.chat().send('hi');
    await settle();
    check('402: out of credit with the provider named, action settings', s.chat().items.at(-1).action === 'settings' && s.chat().items.at(-1).message === 'Your OpenRouter account is out of credit. Add credit on their site, or pick a free model in Settings.', s.chat().items.at(-1));
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

  // ---- errors with a way forward (R1: no dead ends) ------------------------------------------------------
  {
    const cases = [
      [400, 'This model does not support tools', "This model can't use Maglev's tools. Pick another model in Settings → Assistant.", 'settings'],
      [404, '{"error":{"message":"No endpoints found"}}', "That model isn't available any more. Pick another in Settings → Assistant.", 'settings'],
      [413, '', 'That was too much for this model. Clear the chat or ask a shorter question.', 'retry'],
      [422, 'nope', 'The AI service refused this message. Try again, or pick another model in Settings.', 'retry'],
      [429, '', "You've hit this model's limit for now. Try again later, or pick another model.", 'retry'],
    ];
    for (const [status, body, msg, action] of cases) {
      const s = setup();
      s.fetch.queue.push({ status, chunks: body ? [body] : [] });
      s.chat().send('hi');
      await settle();
      const e = s.chat().items.at(-1);
      check(`HTTP ${status}${body ? ' + body' : ''}: "${msg.slice(0, 32)}..." action ${action}`, e.kind === 'error' && e.message === msg && e.action === action && !s.chat().busy && s.fetch.requests.length === 1, e);
    }
    const s = setup({ prefs: { presetId: 'groq', baseUrl: presetById('groq').baseUrl } });
    s.fetch.queue.push({ status: 400, chunks: ['{"error":{"message":"Failed to call a function.","code":"tool_use_failed"}}'] });
    s.fetch.queue.push({ chunks: sseText(['Second try.']) });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(1000 + 250);
    await s.timers.advance(60);
    check('Groq tool_use_failed (400): retried once automatically, then the answer shows', s.fetch.requests.length === 2 && s.chat().items.at(-1).text === 'Second try.', s.chat().items.at(-1));
    const s2 = setup();
    s2.fetch.queue.push({ status: 400, chunks: ['tool_use_failed'] });
    s2.fetch.queue.push({ status: 400, chunks: ['tool_use_failed'] });
    s2.chat().send('hi');
    await settle();
    await s2.timers.advance(1000 + 250);
    const e2 = s2.chat().items.at(-1);
    check('tool_use_failed twice: "The model sent a broken request." with retry', s2.fetch.requests.length === 2 && e2.message === 'The model sent a broken request. Try again.' && e2.action === 'retry', e2);
    const s3 = setup();
    s3.fetch.queue.push({ chunks: [`data: ${JSON.stringify({ error: { code: 'tool_use_failed', message: 'Failed to call a function' } })}\n\n`] });
    s3.fetch.queue.push({ chunks: sseText(['Fine now.']) });
    s3.chat().send('hi');
    await settle();
    await s3.timers.advance(1000 + 250);
    await s3.timers.advance(60);
    check('in-stream string-coded tool_use_failed: retried once', s3.fetch.requests.length === 2 && s3.chat().items.at(-1).text === 'Fine now.', s3.chat().items.at(-1));
    const s4 = setup();
    s4.fetch.queue.push({ status: 400, chunks: ['x'.repeat(5000) + ' tools'] });
    s4.chat().send('hi');
    await settle();
    check('an oversized error body is cut and never shown', !s4.chat().items.some((i) => JSON.stringify(i).includes('xxxx')), s4.chat().items.at(-1));
  }

  // ---- a 200 that is not a stream ---------------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ headers: { 'content-type': 'application/json' }, chunks: ['{"error":{"message":"Insufficient credits","code":402}}'] });
    s.chat().send('hi');
    await settle();
    const e = s.chat().items.at(-1);
    check('200 JSON error with code 402: mapped like HTTP 402, not retried', e.kind === 'error' && e.action === 'settings' && e.message.includes('out of credit') && s.fetch.requests.length === 1, e);
    const s2 = setup();
    s2.fetch.queue.push({ headers: { 'content-type': 'application/json; charset=utf-8' }, chunks: ['{"error":{"message":"model does not support tools"}}'] });
    s2.chat().send('hi');
    await settle();
    check('200 JSON error without a code: mapped by its message', s2.chat().items.at(-1).message.startsWith("This model can't use Maglev's tools"), s2.chat().items.at(-1));
    const s3 = setup();
    s3.fetch.queue.push({ headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: ['<html>Sign in to Wi-Fi</html>'] });
    s3.chat().send('hi');
    await settle();
    const e3 = s3.chat().items.at(-1);
    check('200 HTML: public Wi-Fi copy with retry, not retried automatically', e3.kind === 'error' && e3.message === "Couldn't reach the AI service. If you're on public Wi-Fi, open your browser to sign in to it." && e3.action === 'retry' && s3.fetch.requests.length === 1, e3);
    const s4 = setup();
    s4.fetch.queue.push({ headers: { 'content-type': 'text/event-stream' }, chunks: sseText(['Hello.']) });
    s4.chat().send('hi');
    await settle();
    await s4.timers.advance(60);
    check('a real event-stream content type still streams', s4.chat().items.at(-1).text === 'Hello.');
  }

  // ---- idle watchdog after the first byte ------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: [chunk({ content: 'Partial ' })], hang: true });
    s.fetch.queue.push({ chunks: sseText(['Whole answer.']) });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(44_000);
    check('idle: 44 s of silence after the first byte does nothing', s.fetch.requests.length === 1 && s.chat().busy);
    await s.timers.advance(1_500);
    await s.timers.advance(1_500);
    await s.timers.advance(60);
    const c = s.chat();
    check('idle: 45 s of silence aborts and retries once; the partial is dropped and the answer shows', s.fetch.requests.length === 2 && s.fetch.requests[0].signal.aborted && c.items.filter((i) => i.kind === 'assistant').length === 1 && c.items.at(-1).text === 'Whole answer.' && !c.busy, c.items);
    const s2 = setup();
    s2.fetch.queue.push({ chunks: [chunk({ content: 'A' })], hang: true });
    s2.fetch.queue.push({ chunks: [chunk({ content: 'B' })], hang: true });
    s2.chat().send('hi');
    await settle();
    await s2.timers.advance(45_000);
    await s2.timers.advance(1_500);
    await s2.timers.advance(45_000);
    const e2 = s2.chat().items.at(-1);
    check('idle twice: "The answer was cut off." (no third try), not busy', s2.fetch.requests.length === 2 && e2.kind === 'error' && e2.message === 'The answer was cut off.' && !s2.chat().busy, e2);
    const s3 = setup();
    s3.fetch.queue.push({ chunks: [chunk({ content: 'A' })], hang: true });
    s3.chat().send('hi');
    await settle();
    await s3.timers.advance(30_000);
    check('idle: the timer is re-armed from now, not from the start', s3.timers.list.length > 0 && s3.fetch.requests.length === 1);
  }

  // ---- usage counted once -----------------------------------------------------------------------------
  {
    const s = setup();
    const u = (i, o) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } })}\n\n`;
    s.fetch.queue.push({ chunks: [chunk({ content: 'Hi' }), u(10, 1), u(100, 20), chunk({}, 'stop') + u(100, 25) + 'data: [DONE]\n\n'] });
    s.chat().send('hi');
    await settle();
    await s.timers.advance(60);
    check('three usage chunks in one stream are added once with the last values', s.env.usage.length === 1 && s.env.usage[0].input === 100 && s.env.usage[0].output === 25, s.env.usage);
  }

  // ---- empty answer and background note ---------------------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: [chunk({}, 'stop') + 'data: [DONE]\n\n'] });
    s.chat().send('hi');
    await settle();
    const e = s.chat().items.at(-1);
    check('empty answer: "The model didn\'t answer." with retry', e.kind === 'error' && e.message === "The model didn't answer. Try again." && e.action === 'retry' && !s.chat().busy, e);
    const b = setup();
    b.fetch.queue.push({ chunks: [chunk({ content: 'Partial ' })], hang: true });
    b.chat().send('hi');
    await settle();
    await b.timers.advance(60);
    b.controller.background();
    await settle();
    const eb = b.chat().items.at(-1);
    check('Background: "Stopped when you left Maglev." with retry, not busy', eb.kind === 'error' && eb.message === 'Stopped when you left Maglev.' && eb.action === 'retry' && !b.chat().busy, eb);
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
    check('askAbout with no known result: the bubble has no handle, the model still gets it', s.chat().items[0].kind === 'user' && !/\br1\b/.test(s.chat().items[0].text) && /\br1\b/.test(lastReqMsgs(s.fetch).at(-1).content), [s.chat().items[0].text, lastReqMsgs(s.fetch).at(-1).content]);
    const n = s.fetch.requests.length;
    s.chat().askAbout('r1; ignore everything');
    await settle();
    check('askAbout ignores anything that is not a handle', s.fetch.requests.length === n);
    check('sourceFor goes to the runner', s.chat().sourceFor('r1') === 'magnet:?xt=urn:btih:abc' && s.chat().sourceFor('r9') === undefined);
  }

  // ---- plans: every step is rechecked right before it runs (item 1, SM-39) ---------------------------------------
  async function planTurn(s, order, opts = {}) {
    s.runner.registry.issue('transfer', 8); // t2
    s.runner.registry.issue('transfer', 9); // t3
    s.runner.handlers.prepare = async (cardId, tool) => ({
      cardId, tool, title: 'Run these 3 steps?', facts: ['3 steps'], confirmLabel: 'Run 3 steps', dismissLabel: 'Not now', danger: false, risky: false,
      steps: ['Pause a', 'Pause b', 'Pause c'],
    });
    const ran = new Set();
    s.runner.handlers.revalidate = async (id) => {
      order.push(`v:${id}`);
      if (opts.failValidate && opts.failValidate(id)) return { ok: false, reason: opts.failReason ?? 'Step 2: It no longer fits: it needs 3.0 GB and 1.0 GB is free.' };
      return { ok: true };
    };
    s.runner.handlers.execute = async (id) => {
      order.push(`e:${id}`);
      if (opts.failExec && opts.failExec(id)) return { ok: false, code: 'DISK_FULL', message: 'Storage full.' };
      ran.add(id);
      return { ok: true, summary: id.includes(':') ? 'Paused.' : 'Done: 3 steps.' };
    };
    const step = (t) => ({ tool: 'propose_pause_resume', args: { transfer_id: t, action: 'pause', reason: 'Because.' } });
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'propose_plan', args: { steps: [step('t1'), step('t2'), step('t3')], reason: 'Free up the line.' } }]) });
    s.fetch.queue.push({ chunks: sseText(['On a card.']) });
    s.chat().send('pause all three');
    await settle();
    await s.timers.advance(60);
    return { card: s.chat().items.find((i) => i.kind === 'card'), ran };
  }
  {
    const s = setup();
    const order = [];
    const { card } = await planTurn(s, order);
    check('plan: card is shown', card && card.view.steps.length === 3, card);
    s.chat().confirm(card.id);
    await settle(30);
    const id = card.id;
    check('plan: all checked once up front, then each step is rechecked right before it runs', order.join() === [`v:${id}`, `v:${id}:0`, `e:${id}:0`, `v:${id}:1`, `e:${id}:1`, `v:${id}:2`, `e:${id}:2`].join(), order);
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('plan: done with a one-line summary', st.kind === 'done' && st.summary === 'Done: 3 steps.', st);
  }
  {
    const s = setup();
    const order = [];
    let id;
    const { card } = await planTurn(s, order, { failValidate: (x) => x.endsWith(':1') });
    id = card.id;
    s.chat().confirm(card.id);
    await settle(30);
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('plan: a step that fails its recheck stops the plan; later steps never run', !order.some((o) => o === `e:${id}:1` || o.includes(`:2`)) && order.includes(`e:${id}:0`), order);
    check('plan: the card says which step stopped, why, and what did not run', st.kind === 'failed' && /^Step 2 of 3 stopped: It no longer fits/.test(st.error) && /Step 3 did not run\.$/.test(st.error) && !/Step 2: /.test(st.error), st);
  }
  {
    const s = setup();
    const order = [];
    const { card } = await planTurn(s, order, { failExec: (x) => x.endsWith(':0') });
    s.chat().confirm(card.id);
    await settle(30);
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('plan: a step whose action fails stops the plan with its plain message', st.kind === 'failed' && st.error === 'Step 1 of 3 stopped: Storage full. Steps 2 to 3 did not run.' && !order.some((o) => o.includes(':1')), st);
  }
  {
    // Try again resumes at the step that stopped; a step that succeeded never runs twice.
    const s = setup();
    const order = [];
    let blocked = true;
    const { card } = await planTurn(s, order, { failValidate: (x) => blocked && x.endsWith(':1') });
    s.chat().confirm(card.id);
    await settle(30);
    blocked = false;
    s.chat().confirm(card.id);
    await settle(30);
    const id = card.id;
    const execs = order.filter((o) => o.startsWith('e:'));
    check('plan retry: step 1 ran once, steps 2 and 3 ran after the retry, in order', execs.join() === [`e:${id}:0`, `e:${id}:1`, `e:${id}:2`].join(), execs);
    check('plan retry: the card is done', s.chat().items.find((i) => i.kind === 'card').state.kind === 'done', s.chat().items.find((i) => i.kind === 'card').state);
  }
  {
    const s = setup();
    const order = [];
    const { card } = await planTurn(s, order, { failValidate: (x) => !x.includes(':'), failReason: 'Step 3: That download is gone.' });
    s.chat().confirm(card.id);
    await settle(30);
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('plan: the up-front check failing keeps the card proposed and runs nothing', st.kind === 'proposed' && st.reason === 'Step 3: That download is gone.' && !order.some((o) => o.startsWith('e:')), st);
  }

  // ---- a card that is superseded or disabled while in flight never keeps dead buttons (wave 2, item 1) ---------------
  {
    const s = setup();
    const c1 = await proposalTurn(s);
    let finish;
    s.runner.handlers.execute = () => new Promise((resolve) => { finish = resolve; });
    s.chat().confirm(c1.id);
    await settle();
    // The user keeps talking; the model proposes a newer card for the same transfer.
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k2', name: 'propose_pause_resume', args: { transfer_id: 't1', action: 'resume', reason: 'Because.' } }]) });
    s.fetch.queue.push({ chunks: sseText(['New card.']) });
    s.chat().send('actually resume it');
    await settle();
    await s.timers.advance(60);
    const cards = () => s.chat().items.filter((i) => i.kind === 'card');
    const c2 = cards().find((c) => c.id !== c1.id);
    check('setup: c1 is executing, c2 is proposed', cards().find((c) => c.id === c1.id).state.kind === 'executing' && c2 && c2.state.kind === 'proposed', cards().map((c) => c.state.kind));
    finish({ ok: false, code: 'DISK_FULL', message: 'Storage full.' });
    await settle();
    const old = cards().find((c) => c.id === c1.id).state;
    check('the superseded card that fails ends as expired with the plain caption', old.kind === 'expired' && old.caption === 'A newer card replaced this one.', old);
    s.chat().dismiss(c2.id);
    await settle();
    check('the newer card still works', cards().find((c) => c.id === c2.id).state.kind === 'dismissed');
  }
  {
    // Assistant turned off while a card is confirming, then its action fails: expired, not stuck.
    const s = setup();
    const c1 = await proposalTurn(s);
    let finish;
    s.runner.handlers.execute = () => new Promise((resolve) => { finish = resolve; });
    s.chat().confirm(c1.id);
    await settle();
    s.env.prefs = { ...s.env.prefs, enabled: false };
    s.controller.refresh();
    await settle();
    finish({ ok: false, code: 'DISK_FULL', message: 'Storage full.' });
    await settle();
    check('Disabled while executing: the card that then fails ends expired', s.chat().items.find((i) => i.kind === 'card').state.kind === 'expired', s.chat().items.find((i) => i.kind === 'card').state);
  }
  {
    // The superseded card is still in revalidation when it is replaced: it goes back to proposed, then expires.
    const s = setup();
    const c1 = await proposalTurn(s);
    let release;
    s.runner.handlers.revalidate = () => new Promise((resolve) => { release = resolve; });
    s.chat().confirm(c1.id);
    await settle();
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k2', name: 'propose_pause_resume', args: { transfer_id: 't1', action: 'resume', reason: 'Because.' } }]) });
    s.fetch.queue.push({ chunks: sseText(['New card.']) });
    s.chat().send('resume instead');
    await settle();
    await s.timers.advance(60);
    release({ ok: false, reason: 'That download is gone.' });
    await settle();
    check('a superseded card whose recheck fails expires instead of going back to proposed', s.chat().items.find((i) => i.id === c1.id).state.kind === 'expired', s.chat().items.find((i) => i.id === c1.id).state);
  }

  // ---- errors: Retry where it can help (wave 2, item 3) ------------------------------------------------------------
  {
    const bad = async (chunks, label, wantAction) => {
      const s = setup();
      s.fetch.queue.push({ chunks });
      s.fetch.queue.push({ chunks });
      s.chat().send('hi');
      await settle();
      await s.timers.advance(5000);
      await settle();
      const e = s.chat().items.at(-1);
      check(`${label}: error item ${wantAction ? 'offers Retry' : 'has no Retry'}`, e.kind === 'error' && e.action === wantAction, e);
      return s;
    };
    await bad([chunk({ content: 'Hel' })], 'a cut-off answer', 'retry');
    await bad(['data: {not json}\n\n'], 'a bad response', 'retry');
    await bad([chunk({ tool_calls: [{ index: 0, id: 'k', function: { name: 'search_torrents', arguments: '{"query":' } }] }, 'tool_calls') + 'data: [DONE]\n\n'], 'unreadable tool arguments', 'retry');
    const long = await bad(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(40 * 1024) } }] }) + '\n\n'], 'an over-long answer', undefined);
    check('an over-long answer says what to do', /narrower|shorter/i.test(long.chat().items.at(-1).message), long.chat().items.at(-1).message);
    const s = setup();
    s.chat().send('x'.repeat(5000));
    await settle();
    const t = s.chat().items.at(-1);
    check('"That message is too long" has no Retry but says to shorten it', t.kind === 'error' ? (t.action === undefined && /shorter/.test(t.message)) : true);
  }

  // ---- hung engine calls fail plainly and free the turn (wave 2, item 4) -----------------------------------------------
  {
    const s = setup();
    s.runner.handlers.prepare = () => new Promise(() => {});
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'propose_pause_resume', args: { transfer_id: 't1', action: 'pause', reason: 'Because.' } }]) });
    s.fetch.queue.push({ chunks: sseText(['Sorry.']) });
    s.chat().send('pause');
    await settle();
    await s.timers.advance(60);
    check('setup: the turn waits for the card', s.chat().busy && s.fetch.requests.length === 1);
    await s.timers.advance(20_000);
    await settle();
    await s.timers.advance(60);
    check('prepareCard timeout: no card, the model hears why, the turn finishes', !s.chat().items.some((i) => i.kind === 'card') && /too long/i.test(toolMsg(lastReqMsgs(s.fetch), 'k1').content) && !s.chat().busy, [s.chat().busy, toolMsg(lastReqMsgs(s.fetch), 'k1')]);
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.runner.handlers.revalidate = () => new Promise(() => {});
    s.chat().confirm(card.id);
    await settle();
    check('setup: confirming', s.chat().items.find((i) => i.kind === 'card').state.kind === 'confirming');
    await s.timers.advance(20_000);
    await settle();
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('revalidate timeout: back to proposed with plain copy', st.kind === 'proposed' && /too long/i.test(st.reason), st);
    s.runner.handlers.revalidate = async () => ({ ok: true });
    s.chat().confirm(card.id);
    await settle();
    check('after a timeout the card can be confirmed again', s.chat().items.find((i) => i.kind === 'card').state.kind === 'done');
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.runner.handlers.execute = () => new Promise(() => {});
    s.chat().confirm(card.id);
    await settle();
    check('setup: executing', s.chat().items.find((i) => i.kind === 'card').state.kind === 'executing');
    await s.timers.advance(59_000);
    check('execute: still waiting before 60 s', s.chat().items.find((i) => i.kind === 'card').state.kind === 'executing');
    await s.timers.advance(1_500);
    await settle();
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('execute timeout: failed with plain copy and a way to retry', st.kind === 'failed' && /too long/i.test(st.error), st);
    s.fetch.queue.push({ chunks: sseText(['Ok.']) });
    s.chat().send('what now');
    await settle();
    check('a timed-out card does not block Send', s.fetch.requests.length >= 3);
  }
  {
    // A plan step that hangs stops the plan and says which step.
    const s = setup();
    const order = [];
    const { card } = await planTurn(s, order);
    s.runner.handlers.execute = (id) => (id.endsWith(':1') ? new Promise(() => {}) : Promise.resolve({ ok: true, summary: 'Paused.' }));
    s.chat().confirm(card.id);
    await settle(30);
    await s.timers.advance(60_000);
    await settle(30);
    const st = s.chat().items.find((i) => i.kind === 'card').state;
    check('plan step timeout: the plan stops at that step', st.kind === 'failed' && /^Step 2 of 3 stopped: .*too long/i.test(st.error) && /Step 3 did not run\.$/.test(st.error), st);
  }

  // ---- askAbout shows the title, not the handle (item 6) -----------------------------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'The Last Harbor' } }]) });
    s.fetch.queue.push({ chunks: sseText(['Two good options.']) });
    s.chat().send('find The Last Harbor');
    await settle();
    await s.timers.advance(60);
    s.fetch.queue.push({ chunks: sseText(['Yes.']) });
    s.chat().askAbout('r1');
    await settle();
    const bubble = s.chat().items.filter((i) => i.kind === 'user').at(-1);
    check('askAbout: the bubble shows the result title', bubble.text === 'Tell me about The Last Harbor (2023)', bubble.text);
    check('askAbout: the model is told the handle', /\br1\b/.test(lastReqMsgs(s.fetch).at(-1).content), lastReqMsgs(s.fetch).at(-1).content);
    check('askAbout: no bubble shows a bare handle', !s.chat().items.some((i) => i.kind === 'user' && /\b[rt]\d+\b/.test(i.text)));
  }

  // ---- Retry re-runs the last turn, no second user message, no old error (item 2) ------------------------------
  {
    const s = setup();
    s.fetch.queue.push({ status: 500, chunks: [] });
    s.fetch.queue.push({ status: 500, chunks: [] });
    s.chat().send('find a film');
    await settle();
    await s.timers.advance(5000);
    check('setup: a provider error with Retry is shown', s.chat().items.at(-1).kind === 'error' && s.chat().items.at(-1).action === 'retry', s.chat().items.at(-1));
    s.fetch.queue.push({ chunks: sseText(['Here you go.'], [10, 2]) });
    s.chat().retry();
    await settle();
    await s.timers.advance(60);
    const c = s.chat();
    check('retry: one user bubble, the old error is gone, the answer is there', kinds(c).join() === 'user,assistant' && c.items[1].text === 'Here you go.', kinds(c));
    const msgs = lastReqMsgs(s.fetch);
    check('retry: the request has the user message exactly once', msgs.filter((m) => m.role === 'user').length === 1 && msgs.at(-1).content === 'find a film', msgs);
    check('retry: usage of the failed attempts is not double counted', s.env.usage.length === 1 && s.env.usage[0].input === 10, s.env.usage);
    s.chat().retry();
    await settle();
    check('retry with nothing failed does nothing', s.fetch.requests.length === 3 && kinds(s.chat()).join() === 'user,assistant', s.fetch.requests.length);
  }

  // ---- card results reach the model on the next message (item 3) -----------------------------------------------
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.chat().confirm(card.id);
    await settle();
    s.fetch.queue.push({ chunks: sseText(['Done.']) });
    s.chat().send('thanks');
    await settle();
    await s.timers.advance(60);
    const last = lastReqMsgs(s.fetch).at(-1);
    check('confirmed card: the next request tells the model what happened', last.role === 'user' && last.content.includes(`User confirmed ${card.id}: Paused.`) && last.content.endsWith('thanks'), last.content);
    check('confirmed card: the bubble shows only what the user typed', s.chat().items.filter((i) => i.kind === 'user').at(-1).text === 'thanks');
    s.fetch.queue.push({ chunks: sseText(['Sure.']) });
    s.chat().send('and now?');
    await settle();
    check('the fact is sent once', !lastReqMsgs(s.fetch).at(-1).content.includes('User confirmed'));
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.chat().dismiss(card.id);
    await settle();
    s.fetch.queue.push({ chunks: sseText(['Ok.']) });
    s.chat().send('hm');
    await settle();
    check('dismissed card: the model is told', lastReqMsgs(s.fetch).at(-1).content.includes(`User dismissed ${card.id}.`), lastReqMsgs(s.fetch).at(-1).content);
  }
  {
    const s = setup();
    const card = await proposalTurn(s);
    s.runner.handlers.execute = async () => ({ ok: false, code: 'DISK_FULL', message: 'Storage full.' });
    s.chat().confirm(card.id);
    await settle();
    s.fetch.queue.push({ chunks: sseText(['Ok.']) });
    s.chat().send('what happened?');
    await settle();
    check('failed card: the model is told why', lastReqMsgs(s.fetch).at(-1).content.includes(`${card.id} failed: Storage full.`), lastReqMsgs(s.fetch).at(-1).content);
  }

  // ---- Gemini thought signature goes back on the assistant tool call (item 4) -------------------------------------
  {
    const s = setup();
    const sig = { google: { thought_signature: 'SIG-123' } };
    s.fetch.queue.push({ chunks: [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ extra_content: sig, function: { name: 'search_torrents', arguments: '{"query":"The Last Harbor"}' }, id: 'function-call-1', type: 'function' }] }, finish_reason: null }] })}\n\n`,
      chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
    ] });
    s.fetch.queue.push({ chunks: sseText(['Two good options.']) });
    s.chat().send('find The Last Harbor');
    await settle();
    await s.timers.advance(60);
    const asst = lastReqMsgs(s.fetch).find((m) => m.role === 'assistant' && m.tool_calls);
    check('second request: tool call carries extra_content.google.thought_signature unchanged', asst && asst.tool_calls[0].extra_content.google.thought_signature === 'SIG-123' && asst.tool_calls[0].id === 'function-call-1', asst);
  }

  // ---- usage counted once through retries and rounds (item 5) -----------------------------------------------------
  {
    const s = setup();
    // Round 1 gets cut off after its usage chunk (a stall), the retry runs the tool, round 2 answers.
    s.fetch.queue.push({ chunks: [chunk({ content: 'Hmm' }), usageChunk(40, 4)], hang: true });
    s.fetch.queue.push({ chunks: sseTools([{ id: 'k1', name: 'search_torrents', args: { query: 'x' } }], [100, 10]) });
    s.fetch.queue.push({ chunks: sseText(['Done.'], [200, 20]) });
    s.chat().send('find x');
    await settle();
    await s.timers.advance(45_000);
    await s.timers.advance(2000);
    await settle();
    await s.timers.advance(60);
    check('usage: stall + retry + tool round adds each request once (40+100+200)', s.env.usage.length === 3 && s.env.prefs.tokensUsed.input === 340 && s.env.prefs.tokensUsed.output === 34, [s.env.usage, s.chat().items.at(-1)]);
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
