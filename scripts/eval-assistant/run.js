#!/usr/bin/env node
// Local eval harness for the in-app assistant. Runs the REAL controller, turn machine, tool runner, system prompt
// and OpenRouter client in Node against a real model, with a fake engine and the real search layer.
//   node scripts/eval-assistant/run.js [--only 1,5,9] [--fake] [--model <openrouter id>] [--gap <seconds>]
// Needs Node 22.18+ (imports the .ts sources directly with type stripping, same as scripts/test-assistant-*.js).
// The API key comes from .env.local (OPENROUTER_API_KEY) or the environment. It is never printed or written.
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { SCENARIOS, GENERIC } = require('./scenarios.js');
const { createWorld, fakeSearchRows, fakeBrowseRows } = require('./fakeEngine.js');
const RATE_LIMITED_TEXT = /rate limited|too many requests|\b429\b/i;

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const FAKE = argv.includes('--fake');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] || '').split(',').map((s) => Number(s.trim())).filter(Boolean)) : null;
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const MODEL = flag('--model') || process.env.MAGLEV_EVAL_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const gapArg = Number(flag('--gap'));
const MIN_GAP_MS = FAKE ? 0 : (Number.isFinite(gapArg) && gapArg >= 0 && flag('--gap') !== undefined ? gapArg : 4) * 1000;
const TURN_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- key -------------------------------------------------------------------------------------------------
function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch { /* no file */ }
  return null;
}
const KEY = FAKE ? 'fake-key' : loadKey();
if (!KEY) {
  console.error('No OpenRouter key found. Create .env.local at the repo root with the line OPENROUTER_API_KEY=<your key> (it is gitignored), or run with --fake.');
  process.exit(1);
}
/** Remove the key from any text before it is printed or written. */
const scrub = (s) => (!FAKE && KEY.length > 6 ? String(s).split(KEY).join('[redacted]') : String(s));

// ---- scripted fake model (--fake) ------------------------------------------------------------------------
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
function sseFor(step) {
  if (step.text !== undefined) return [chunk({ content: step.text }), chunk({}, 'stop') + 'data: [DONE]\n\n'];
  return [
    ...step.tools.map((c, i) => chunk({ tool_calls: [{ index: i, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] })),
    chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
  ];
}
/** Handles (t1, r1...) the fake model may use, read from the tool results in the request. */
function handlesFrom(messages) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.id === 'string' && /^[tr]\d+$/.test(v.id)) found.push({ id: v.id, name: String(v.name_untrusted ?? v.name ?? '').toLowerCase() });
      Object.values(v).forEach(walk);
    }
  };
  for (const m of messages) if (m.role === 'tool') { try { walk(JSON.parse(m.content)); } catch { /* not json */ } }
  /** Result rows of the latest search, in the order shown; rows marked on_card (when the runner marks them) come first as cards. */
  const lastRows = () => {
    let rows = [];
    for (const m of messages) {
      if (m.role !== 'tool') continue;
      try { const j0 = JSON.parse(m.content); const j = j0 && j0.data ? j0.data : j0; if (j && Array.isArray(j.results) && j.results.every((r) => r && typeof r.id === 'string')) rows = j.results; } catch { /* not json */ }
    }
    return rows;
  };
  /** First value of a key anywhere in the tool results (latest wins), for example shortfall_text. */
  const field = (key) => {
    let hit;
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') { if (key in v && v[key] !== undefined && v[key] !== null) hit = v[key]; Object.values(v).forEach(walk); }
    };
    for (const m of messages) if (m.role === 'tool') { try { walk(JSON.parse(m.content)); } catch { /* not json */ } }
    return hit;
  };
  return {
    tid: (sub) => (found.find((f) => f.id[0] === 't' && f.name.includes(sub)) || { id: 't1' }).id,
    rid: (n) => `r${n}`,
    cardIds: () => { const r = lastRows(); const on = r.filter((x) => x.on_card === true); return (on.length ? on : r).map((x) => x.id); },
    rowIds: () => lastRows().map((x) => x.id),
    field,
  };
}
function makeFakeFetch(state) {
  const enc = new TextEncoder();
  return async (url, init) => {
    state.requests++;
    const body = JSON.parse(init.body);
    state.lastMessages = body.messages;
    const raw = state.scenario.fake[state.fakeStep++] ?? { text: 'Okay.' };
    const step = typeof raw === 'function' ? raw(handlesFrom(body.messages)) : raw;
    if (step.status) return { ok: false, status: step.status, headers: { get: () => null }, text: async () => '{"error":"rate limited"}', body: null };
    const chunks = sseFor(step);
    return {
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: enc.encode(chunks.shift()) } : { done: true }), cancel: async () => {} }) },
    };
  };
}

// ---- real fetch to OpenRouter: throttle, count, retry a 429 once -----------------------------------------
let lastRequestAt = 0;
function makeRealFetch(state) {
  return async (url, init) => {
    if (state.rateLimited) return new Response('{"error":"rate limited"}', { status: 429 });
    const send = async () => {
      const wait = lastRequestAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      state.requests++;
      try { state.lastMessages = JSON.parse(init.body).messages; } catch { /* ignore */ }
      let r;
      try {
        r = await fetch(url, init);
      } catch (e) {
        console.log(`    fetch threw: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
        throw e;
      }
      // Log any failure status with the start of its body, so app error copy can be traced to its cause.
      if (!r.ok) {
        const body = await r.clone().text().catch(() => '');
        console.log(`    HTTP ${r.status} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      return r;
    };
    // A 429 goes straight to the app, so its own rate-limit copy is what gets tested. Sleeping here would outlast
    // the app's request timeout and surface as "Couldn't reach the provider" instead.
    const res = await send();
    if (res.status === 429) state.rateLimited = true;
    return res;
  };
}

// ---- output helpers --------------------------------------------------------------------------------------
const cut = (s, n = 2048) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s);
function deepCut(v) {
  if (typeof v === 'string') return cut(v);
  if (Array.isArray(v)) return v.map(deepCut);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepCut(x)]));
  return v;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const md = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ---- one scenario ----------------------------------------------------------------------------------------
async function runScenario(mods, scenario) {
  const { createChatController, createStreamFn, createToolRunner, defaultAssistantPrefs, PROVIDERS, searchAll, resolveResult, browseAll } = mods;
  const world = createWorld({ freeGB: scenario.freeGB });
  const state = { scenario, requests: 0, fakeStep: 0, rateLimited: false, searches: 0, browses: 0 };
  let turn = 0;
  const tools = [];
  const cards = [];
  const executes = [];
  /** Every tool the runner saw, in order: read tools by name, proposals as propose_change:<action>. */
  const seq = [];

  const enabled = PROVIDERS.filter((p) => p.enabledByDefault && !p.nsfw).map((p) => p.id);
  const providers = new Map(PROVIDERS.map((p) => [p.id, { name: p.name, ...(p.unsafeReason ? { unsafeReason: p.unsafeReason } : {}) }]));
  const remember = (u) => { for (const x of u.results || []) world.knownResults.set(String(x.infoHash).toLowerCase(), { name: x.name, sizeBytes: x.sizeBytes }); return u; };
  const base = createToolRunner({
    async search(query, category, opts) {
      // A scenario's own fixture defines it (a hostile name, a source down), so it applies to real runs too.
      if (FAKE || scenario.fixture) {
        const fx = scenario.fixture ? scenario.fixture(query, state.searches++) : fakeSearchRows(query);
        const results = Array.isArray(fx) ? fx : fx.results;
        const sources = Array.isArray(fx) || !fx.sources ? [{ providerId: 'knaben', state: 'done', count: results.length, ms: 5 }] : fx.sources;
        const update = { results, sources, done: true };
        opts.onUpdate?.(update);
        return remember(update);
      }
      return remember(await searchAll(query, category, { enabled, useFor: {}, mirrorOverride: {}, adult: false, waitSeconds: 8, limit: 50, hideDead: true, sort: 'seeders', signal: opts.signal, onUpdate: opts.onUpdate }));
    },
    async browse(kind, order, period, opts) {
      if (FAKE) {
        const fx = scenario.browseFixture ? scenario.browseFixture(kind, order, period, state.browses++) : fakeBrowseRows(kind);
        const results = Array.isArray(fx) ? fx : fx.results;
        const sources = Array.isArray(fx) || !fx.sources ? [{ providerId: 'knaben', state: 'done', count: results.length, ms: 5 }, { providerId: 'yts', state: 'done', count: 0, ms: 5 }] : fx.sources;
        const update = { results, sources, done: true };
        opts.onUpdate?.(update);
        return remember(update);
      }
      return remember(await browseAll(kind, order, period, { enabled, useFor: {}, mirrorOverride: {}, adult: false, waitSeconds: 8, hideDead: true, signal: opts.signal, onUpdate: opts.onUpdate }));
    },
    searchPrefs: () => ({ warnUnsafe: true, providers }),
    resolveResult: async (r, signal) => (FAKE ? r : resolveResult(r, signal)),
    engine: world.engine,
    playbackSupport: async () => null,
    now: () => Date.now(),
  });
  const runner = {
    ...base,
    async run(call, ctx) {
      const t0 = Date.now();
      const out = await base.run(call, ctx);
      seq.push(call.name);
      tools.push({ name: call.name, args: call.args, content: cut(out.content), full: out.content, turn, detail: out.detail, ms: Date.now() - t0 });
      return out;
    },
    async prepareCard(cardId, tool, args) {
      seq.push(tool === 'propose_change' ? `propose_change:${args.action}` : tool);
      const out = await base.prepareCard(cardId, tool, args);
      cards.push({ cardId, tool, args, ...('error' in out ? { error: out.error } : { view: out }) });
      return out;
    },
    async execute(cardId) {
      const out = await base.execute(cardId);
      executes.push({ cardId, result: out });
      return out;
    },
  };

  const prefs = { ...defaultAssistantPrefs(), enabled: true, warningAcceptedAt: 1, model: MODEL };
  const fetchImpl = FAKE ? makeFakeFetch(state) : makeRealFetch(state);
  const controller = createChatController({
    runner,
    stream: createStreamFn(fetchImpl),
    getPrefs: () => prefs,
    getKey: () => KEY,
    addUsage: () => {},
    now: () => new Date(),
    timeZone: 'Asia/Kolkata',
  });
  const chat = () => controller.getSnapshot();
  const idle = () => !chat().busy && !chat().items.some((i) => i.kind === 'card' && (i.state.kind === 'confirming' || i.state.kind === 'executing'));
  let timedOut = false;
  async function waitIdle() {
    await sleep(60);
    const t0 = Date.now();
    while (!idle()) {
      if (Date.now() - t0 > TURN_TIMEOUT_MS) { timedOut = true; chat().stop(); break; }
      await sleep(50);
    }
    await sleep(120);
  }
  const confirmed = new Set();
  async function settleCards() {
    for (;;) {
      const pending = chat().items.filter((i) => i.kind === 'card' && i.state.kind === 'proposed' && !confirmed.has(i.id));
      if (!scenario.confirm || pending.length === 0) return;
      for (const c of pending) { confirmed.add(c.id); chat().confirm(c.view.cardId); await waitIdle(); }
    }
  }

  const t0 = Date.now();
  const turnTexts = [];
  let seenItems = 0;
  for (const msg of scenario.messages) {
    turn = turnTexts.length;
    if (typeof msg === 'string') chat().send(msg);
    else {
      const q = [...chat().items].reverse().find((i) => i.kind === 'question' && !i.answered);
      if (!q) break;
      chat().answer?.(q.id, q.options[msg.pick] ?? q.options[0]);
    }
    await waitIdle();
    await settleCards();
    turnTexts.push(chat().items.slice(seenItems).filter((i) => i.kind === 'assistant').map((i) => i.text.trim()).filter(Boolean).join('\n\n'));
    seenItems = chat().items.length;
    if (state.rateLimited || timedOut) break;
  }
  const latencyMs = Date.now() - t0;

  const items = chat().items;
  const assistantTexts = items.filter((i) => i.kind === 'assistant').map((i) => i.text.trim()).filter(Boolean);
  const ctx = {
    items,
    text: assistantTexts.join('\n\n'),
    firstText: assistantTexts[0] ?? '',
    tools,
    seq,
    cards,
    cardItems: items.filter((i) => i.kind === 'card'),
    errors: items.filter((i) => i.kind === 'error'),
    turnTexts,
    resultItems: items.filter((i) => i.kind === 'results'),
    cardsShown: items.filter((i) => i.kind === 'results').flatMap((i) => i.results),
    modelRequests: state.requests,
    timedOut,
    engineActions: world.actions.filter((a) => !['resolveMetadata'].includes(a.name)),
    subtitleIndices: world.subtitleIndices,
  };
  const errorRateLimited = ctx.errors.some((e) => RATE_LIMITED_TEXT.test(String(e.message)));
  const status = state.rateLimited || errorRateLimited ? 'rate_limited' : timedOut ? 'timeout' : 'ok';
  const checks = [];
  if (status === 'ok') {
    for (const c of [...GENERIC, ...scenario.checks]) {
      let pass = false;
      try { pass = !!c.fn(ctx); } catch { pass = false; }
      checks.push({ name: c.name, pass, generic: GENERIC.includes(c) });
    }
  }
  return {
    id: scenario.id, prompt: scenario.messages.map((m) => (typeof m === 'string' ? m : `[pick option ${m.pick}]`)).join(' / '), model: FAKE ? 'fake' : MODEL,
    fake: FAKE, status, record_only: !!scenario.record, confirm: !!scenario.confirm, modelRequests: state.requests, latencyMs,
    toolSequence: seq, toolCalls: tools.map(({ full, ...t }) => t), toolMessages: (state.lastMessages || []).filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, content: cut(m.content) })), cards, executes, engineActions: ctx.engineActions, checks, finalText: ctx.text, items,
  };
}

// ---- main ------------------------------------------------------------------------------------------------
async function main() {
  const [{ createChatController }, { createStreamFn }, { createToolRunner }, { defaultAssistantPrefs }, agg, browse] = await Promise.all([
    import(path.join(ROOT, 'utils/assistantApp/chatController.ts')),
    import(path.join(ROOT, 'utils/assistantApp/client.ts')),
    import(path.join(ROOT, 'utils/assistant/toolRunner.ts')),
    import(path.join(ROOT, 'utils/prefs/assistant.ts')),
    import(path.join(ROOT, 'utils/search/aggregate.ts')),
    import(path.join(ROOT, 'utils/search/browse.ts')),
  ]);
  const mods = { createChatController, createStreamFn, createToolRunner, defaultAssistantPrefs, PROVIDERS: agg.PROVIDERS, searchAll: agg.searchAll, resolveResult: agg.resolveResult, browseAll: browse.browseAll };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'out', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  // fakeOnly scenarios test the app's handling of scripted model output; a real model writes its own, so skip them.
  const picked = SCENARIOS.filter((s) => (!ONLY || ONLY.has(s.id)) && (FAKE || !s.fakeOnly));
  console.log(`Assistant eval: ${picked.length} scenario(s), model ${FAKE ? 'fake (scripted)' : MODEL}${FAKE ? '' : `, 1 request per ${MIN_GAP_MS / 1000}s max`}`);

  const results = [];
  let total = 0;
  for (const s of picked) {
    process.stdout.write(`  #${s.id} ${s.messages[0]} ... `);
    let r;
    try {
      r = await runScenario(mods, s);
    } catch (e) {
      r = { id: s.id, prompt: s.messages[0], status: 'harness_error', modelRequests: 0, latencyMs: 0, toolCalls: [], cards: [], executes: [], engineActions: [], checks: [], finalText: `Harness error: ${scrub(e && e.message)}`, items: [] };
    }
    total += r.modelRequests;
    results.push(r);
    const failed = r.checks.filter((c) => !c.pass).length;
    console.log(r.status === 'ok' ? (failed ? `${failed} check(s) failed` : 'pass') : r.status === 'rate_limited' ? 'rate limited' : r.status);
    fs.writeFileSync(path.join(outDir, `${s.id}.json`), scrub(JSON.stringify(deepCut(r), null, 2)));
  }

  const rows = results.map((r) => {
    const pass = r.checks.filter((c) => c.pass).map((c) => c.name);
    const fail = r.checks.filter((c) => !c.pass).map((c) => c.name);
    const checksCell = r.status === 'rate_limited' ? 'rate limited' : r.status !== 'ok' ? r.status : `${pass.length} ok${fail.length ? `; FAIL: ${fail.join('; ')}` : ''}`;
    return { id: r.id, prompt: r.prompt, tools: (r.toolSequence || []).join(' > ') || '(none)', checksCell, text: r.finalText || '(no text)' };
  });
  const rl = results.filter((r) => r.status === 'rate_limited').length;
  const bad = results.filter((r) => r.status === 'ok' && r.checks.some((c) => !c.pass)).length;
  const good = results.filter((r) => r.status === 'ok' && r.checks.every((c) => c.pass)).length;
  const other = results.length - rl - bad - good;
  const tally = `${good} passed, ${bad} failed, ${rl} rate limited${other ? `, ${other} timeout or harness error` : ''}`;
  const header = `# Assistant eval ${stamp}\n\nModel: ${FAKE ? 'fake (scripted dry run)' : MODEL}. Model requests used: ${total}.\n\nScenarios: ${tally}. Rate limited scenarios are not scored.\n\n`;
  const table = ['| id | prompt | tools (in order) | checks | final assistant text |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.id} | ${md(r.prompt)} | ${md(r.tools)} | ${md(r.checksCell)} | ${md(clip(r.text, 400))} |`)].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), scrub(`${header}${table}\n`));

  console.log(`\n${scrub(table)}`);
  console.log(`\nScenarios: ${tally}`);
  console.log(`Model requests used: ${total}`);
  console.log(`Transcripts: ${path.relative(ROOT, outDir)}`);
  // A failed check or a harness error fails the run (CI gates on this). Rate limits are not scored, so they do not.
  if (bad > 0 || other > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(scrub(e && e.stack ? e.stack : e)); process.exit(1); });
