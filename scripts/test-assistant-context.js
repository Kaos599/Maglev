#!/usr/bin/env node
// Context builder: caps, token budget, tool pairing, summarise-before-drop (SM-31, ASSISTANT_DESIGN §8.4).
// Random histories use a seeded PRNG (mulberry32), so every run checks the same cases.
// Pure TS, no network. Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let failed = 0;
let passed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Structural validity: system first, every tool result follows its assistant tool_calls, and vice versa. */
function pairingProblem(messages) {
  let expected = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      if (!expected || !expected.has(m.tool_call_id)) return `orphan tool at ${i}`;
      expected.delete(m.tool_call_id);
      continue;
    }
    if (expected && expected.size > 0) return `tool_calls missing results before ${i}`;
    expected = null;
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      expected = new Set(m.tool_calls.map((c) => c.id));
    }
  }
  if (expected && expected.size > 0) return 'tool_calls missing results at end';
  return null;
}

async function main() {
  const ctx = await import('../utils/assistant/context.ts');
  const {
    buildContext,
    estimateTokens,
    messageTokens,
    MAX_HISTORY_TURNS,
    MAX_TOOL_RESULT_TOKENS,
    MAX_ROUND_TRIPS,
    MAX_TOOL_CALLS_PER_TURN,
    MAX_TOOL_CALLS_PER_ROUND_TRIP,
    MAX_COMPLETION_TOKENS,
    DEFAULT_INPUT_BUDGET,
    SUMMARY_OK,
    SUMMARY_FAILED,
  } = ctx;

  const SYSTEM = 'You are the Maglev assistant. Rules follow.';
  const sum = (ms) => ms.reduce((n, m) => n + messageTokens(m), 0);

  /** Build a history of `turns` user turns. Tool results have sizes from `sizes`, in characters. */
  function makeHistory(rand, turns, opts = {}) {
    const out = [];
    let id = 0;
    const sizes = opts.sizes ?? [10, 200, 1000, 8000];
    const text = (n) => 'x'.repeat(n);
    for (let t = 0; t < turns; t++) {
      out.push({ role: 'user', content: `${t}:${text(Math.floor(rand() * (opts.userLen ?? 300)))}` });
      const rounds = Math.floor(rand() * 4);
      for (let r = 0; r < rounds; r++) {
        const calls = 1 + Math.floor(rand() * 3);
        const tool_calls = [];
        for (let c = 0; c < calls; c++) {
          id += 1;
          tool_calls.push({ id: `call_${id}`, type: 'function', function: { name: 'search_torrents', arguments: '{}' } });
        }
        out.push({ role: 'assistant', content: rand() < 0.3 ? 'Checking.' : null, tool_calls });
        for (const call of tool_calls) {
          const n = sizes[Math.floor(rand() * sizes.length)];
          const body = JSON.stringify({ ok: rand() < 0.9, data: { s: text(n) } });
          out.push({ role: 'tool', tool_call_id: call.id, content: body });
        }
      }
      if (rand() < 0.7) out.push({ role: 'assistant', content: `Answer ${t} ${text(Math.floor(rand() * 200))}` });
    }
    return out;
  }

  /** Lower bound a budget must reach: system, every newest-turn non-tool message, and summaries of its results. */
  function lowerBound(history) {
    let lastUser = -1;
    history.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
    });
    let bound = messageTokens({ role: 'system', content: SYSTEM });
    if (lastUser < 0) return bound;
    const newest = history.slice(lastUser);
    for (const m of newest) {
      if (m.role === 'tool') {
        bound += messageTokens({ role: 'tool', tool_call_id: m.tool_call_id, content: SUMMARY_FAILED });
      } else {
        bound += messageTokens(m);
      }
    }
    return bound;
  }

  console.log('estimate and constants');
  check('estimateTokens: chars/4 rounded up', estimateTokens('abcd') === 1 && estimateTokens('abcde') === 2);
  check('estimateTokens: empty is 0', estimateTokens('') === 0);
  check('design constant: 6 round-trips', MAX_ROUND_TRIPS === 6);
  check('design constant: 8 tool calls per turn', MAX_TOOL_CALLS_PER_TURN === 8);
  check('design constant: 3 tool calls per round-trip', MAX_TOOL_CALLS_PER_ROUND_TRIP === 3);
  check('design constant: 600 completion tokens', MAX_COMPLETION_TOKENS === 600);
  check('design constant: 1500 tool result tokens', MAX_TOOL_RESULT_TOKENS === 1500);
  check('design constant: 12000 input budget', DEFAULT_INPUT_BUDGET === 12000);
  check('history turns cap is 6', MAX_HISTORY_TURNS === 6);

  console.log('caps');
  {
    const history = [];
    for (let t = 0; t < 20; t++) {
      history.push({ role: 'user', content: `q${t}` });
      history.push({ role: 'assistant', content: `a${t}` });
    }
    const r = buildContext(SYSTEM, history, 1e9);
    const users = r.messages.filter((m) => m.role === 'user').length;
    check('20 turns keep only 6 user turns', users === MAX_HISTORY_TURNS, users);
    check('newest user kept under a huge budget', r.messages.at(-2).content === 'q19', r.messages.at(-2));
    check('turn cap drops the rest', r.dropped === 28, r.dropped);
  }
  {
    const big = JSON.stringify({ ok: true, data: { s: 'y'.repeat(30000) } });
    const history = [
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: big },
    ];
    const r = buildContext(SYSTEM, history, 1e9);
    const tool = r.messages.find((m) => m.role === 'tool');
    check('oversized tool result is cut to the cap', estimateTokens(tool.content) <= MAX_TOOL_RESULT_TOKENS, estimateTokens(tool.content));
    let parsed = null;
    try {
      parsed = JSON.parse(tool.content);
    } catch {
      parsed = null;
    }
    check('truncated tool result is still valid JSON with a note', parsed !== null && parsed.truncated === true);
    check('truncation counts as summarised', r.summarised === 1, r.summarised);
  }

  console.log('random histories');
  {
    const rand = mulberry32(20261112);
    let cases = 0;
    let budgetViolations = 0;
    let pairingFailures = 0;
    let systemFailures = 0;
    let newestFailures = 0;
    let capFailures = 0;
    let throwsBelowFloor = 0;
    let wrongThrows = 0;
    let unexpectedThrows = 0;
    let orphanCases = 0;
    for (let k = 0; k < 400; k++) {
      const turns = 1 + Math.floor(rand() * 12);
      const history = makeHistory(rand, turns, { userLen: k % 5 === 0 ? 3000 : 300 });
      if (k % 7 === 0) {
        // Inject a stray tool result and an incomplete tool_calls unit.
        orphanCases++;
        history.splice(0, 0, { role: 'tool', tool_call_id: 'ghost', content: '{"ok":true}' });
        history.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'half_a', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'half_b', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        });
        history.push({ role: 'tool', tool_call_id: 'half_a', content: '{"ok":true}' });
      }
      const floor = lowerBound(history);
      const budget = floor + Math.floor(rand() * 4000);
      const hasUser = history.some((m) => m.role === 'user');
      const newestUser = hasUser ? history.filter((m) => m.role === 'user').at(-1).content : null;
      cases++;
      let r;
      try {
        r = buildContext(SYSTEM, history, budget);
      } catch (e) {
        if (e instanceof RangeError) unexpectedThrows++;
        continue;
      }
      if (sum(r.messages) > budget || r.tokens > budget) budgetViolations++;
      if (pairingProblem(r.messages) !== null) pairingFailures++;
      if (r.messages[0].role !== 'system' || r.messages[0].content !== SYSTEM) systemFailures++;
      if (hasUser) {
        const users = r.messages.filter((m) => m.role === 'user');
        if (users.at(-1).content !== newestUser) newestFailures++;
      }
      const userCount = r.messages.filter((m) => m.role === 'user').length;
      const toolTooBig = r.messages.some((m) => m.role === 'tool' && estimateTokens(m.content) > MAX_TOOL_RESULT_TOKENS);
      if (userCount > MAX_HISTORY_TURNS || toolTooBig) capFailures++;
    }
    console.log(`  (${cases} cases, ${orphanCases} with injected orphans)`);
    check('budget never exceeded (400 histories)', budgetViolations === 0, budgetViolations);
    check('no orphan tool messages and no tool_calls without results', pairingFailures === 0, pairingFailures);
    check('system message always first and unchanged', systemFailures === 0, systemFailures);
    check('newest user message always survives', newestFailures === 0, newestFailures);
    check('caps hold on every case (turns, tool result size)', capFailures === 0, capFailures);
    check('no throw when the budget covers the floor', unexpectedThrows === 0, unexpectedThrows);
  }

  console.log('below the floor');
  {
    const rand = mulberry32(42);
    let throwsBelowFloor = 0;
    let wrongThrows = 0;
    for (let k = 0; k < 100; k++) {
      const history = makeHistory(rand, 1 + Math.floor(rand() * 5));
      const userTokens = (() => {
        const u = history.filter((m) => m.role === 'user').at(-1);
        return u ? messageTokens(u) : 0;
      })();
      const systemTokens = messageTokens({ role: 'system', content: SYSTEM });
      const tight = systemTokens + userTokens - 1;
      if (tight < 0) continue;
      try {
        buildContext(SYSTEM, history, tight);
        wrongThrows++;
      } catch (e) {
        if (e instanceof RangeError) throwsBelowFloor++;
        else wrongThrows++;
      }
    }
    check('budget below system + newest user throws RangeError', throwsBelowFloor > 0 && wrongThrows === 0, { throwsBelowFloor, wrongThrows });
  }
  {
    let threw = false;
    try {
      buildContext(SYSTEM, [], -1);
    } catch (e) {
      threw = e instanceof RangeError;
    }
    check('negative budget throws RangeError', threw);
  }

  console.log('summarise before drop');
  {
    const big = JSON.stringify({ ok: true, data: { s: 'z'.repeat(6000) } });
    const oldTurn = [
      { role: 'user', content: 'old one' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'o1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'o1', content: big },
      { role: 'assistant', content: 'done' },
    ];
    const newest = [
      { role: 'user', content: 'now' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'n1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'n1', content: '{"ok":true,"data":{}}' },
    ];
    const history = [...oldTurn, ...newest];
    const systemTokens = messageTokens({ role: 'system', content: SYSTEM });
    const newestCost = sum(newest) - messageTokens(newest[2]) + messageTokens({ role: 'tool', tool_call_id: 'n1', content: '{"ok":true,"data":{}}' });

    const roomy = buildContext(SYSTEM, history, 1e9);
    check('old tool result is summarised even with room to spare', roomy.summarised === 1, roomy.summarised);
    check('old tool result content is the summary', roomy.messages.some((m) => m.role === 'tool' && m.content === SUMMARY_OK));
    check('nothing dropped when the summary fits', roomy.dropped === 0, roomy.dropped);

    const summaryFits = systemTokens + sum(oldTurn) - messageTokens(oldTurn[2]) + messageTokens({ role: 'tool', tool_call_id: 'o1', content: SUMMARY_OK }) + newestCost;
    const r1 = buildContext(SYSTEM, history, summaryFits);
    check('tight budget met by summarising alone: old turn kept', r1.dropped === 0 && r1.messages.length === history.length + 1, { dropped: r1.dropped, n: r1.messages.length });

    const onlyNewest = systemTokens + newestCost;
    const r2 = buildContext(SYSTEM, history, onlyNewest);
    check('budget that fits only the newest turn drops the old one', r2.dropped === oldTurn.length, r2.dropped);
    check('dropped old turn leaves no old tool messages', !r2.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'o1'));
    check('newest turn kept intact', r2.messages.at(-1).role === 'tool' && r2.messages.at(-1).tool_call_id === 'n1');
  }
  {
    // Newest turn results are summarised only when the budget needs it, and the pairing holds.
    const history = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ ok: true, data: 'p'.repeat(2000) }) },
      { role: 'tool', tool_call_id: 'b', content: JSON.stringify({ ok: true, data: 'q'.repeat(2000) }) },
    ];
    const systemTokens = messageTokens({ role: 'system', content: SYSTEM });
    const roomy = buildContext(SYSTEM, history, 1e9);
    check('newest turn results kept when budget allows', roomy.summarised === 0 && roomy.messages.length === 5);
    const tight = systemTokens + messageTokens(history[0]) + messageTokens(history[1]) + 2 * messageTokens({ role: 'tool', tool_call_id: 'a', content: SUMMARY_OK });
    const r = buildContext(SYSTEM, history, tight);
    check('newest results summarised oldest first under pressure', r.summarised === 2 && pairingProblem(r.messages) === null, r.summarised);
    check('newest turn never dropped under pressure', r.messages.length === 5, r.messages.length);
  }

  console.log('input cleanup');
  {
    const history = [
      { role: 'system', content: 'stray' },
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'nope', content: '{"ok":true}' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'user', content: 'again' },
    ];
    const r = buildContext(SYSTEM, history, 1e9);
    check('stray system and orphan tool removed', r.messages.length === 3 && r.dropped === 3, { n: r.messages.length, dropped: r.dropped });
    check('incomplete tool_calls unit removed', !r.messages.some((m) => m.role === 'assistant' && m.tool_calls));
    check('output is valid pairing', pairingProblem(r.messages) === null);
  }
  {
    const r = buildContext(SYSTEM, [], 1e9);
    check('empty history gives the system message only', r.messages.length === 1 && r.dropped === 0);
  }
  {
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'hello' },
    ];
    const budget = messageTokens({ role: 'system', content: SYSTEM }) + messageTokens(history[2]);
    const r = buildContext(SYSTEM, history, budget);
    check('tightest legal budget keeps system and newest user', r.messages.length === 2 && r.messages[1].content === 'hello', r.messages);
    check('tightest legal budget is met exactly', r.tokens <= budget, { tokens: r.tokens, budget });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
