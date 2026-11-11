#!/usr/bin/env node
// SM-31 Assistant chat turn. One test per row of the transition table, plus caps, retry-once,
// expire cards, the RangeError path and the URL provenance rule.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');

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

async function main() {
  const m = await import('../utils/assistant/turnMachine.ts');
  const { HandleRegistry } = await import('../utils/assistant/handles.ts');
  const ctx = await import('../utils/assistant/context.ts');
  const { USER_TEXT_MAX } = await import('../utils/assistant/sanitize.ts');

  const mk = (opts = {}) => {
    const registry = new HandleRegistry();
    registry.issue('result', 'real-result-1'); // r1
    registry.issue('transfer', 7); // t1
    return m.turnInitial({ system: 'You help with downloads.', registry, ...opts });
  };
  const types = (effects) => effects.map((e) => e.type);
  const step = (state, event) => m.turnStep(state, event);
  /** Drive events in order; returns the last step. */
  const run = (state, ...events) => {
    let r = { state, effects: [] };
    for (const ev of events) r = step(r.state, ev);
    return r;
  };
  const send = (text = 'hello') => ({ type: 'Send', text, hasKey: true });
  const FIRST = { type: 'FirstByte' };
  const toRequesting = (state = mk(), text = 'hello') => step(state, send(text)).state;
  const toStreaming = (state, text) => step(toRequesting(state, text), FIRST).state;
  const call = (id, name, args) => ({ id, name, arguments: args });
  const searchCall = (id = 'k1') => call(id, 'search_torrents', { query: 'The Last Harbor' });
  const proposePause = (id = 'k1') =>
    call(id, 'propose_pause_resume', { transfer_id: 't1', action: 'pause', reason: 'Because.' });
  const urlCall = (url, id = 'k1') => call(id, 'propose_url_download', { url, reason: 'You asked.' });
  const okResults = (calls) => calls.map((c) => ({ toolCallId: c.id, content: '{"ok":true}' }));

  /** One user turn: a proposal, the model's closing text, Stop -> awaitingConfirmation. */
  function toAwaitingConfirmation() {
    const r = run(mk(), send('pause it'), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] });
    // No read tool in the round, so ToolsDone was applied at once and the next request is out.
    return run(r.state, FIRST, { type: 'TextDelta', text: 'On a card.' }, { type: 'Stop' });
  }

  /** Round-trips with one read call each until `rounds` requests are out. Returns the requesting state. */
  function toRequestingRounds(rounds, from = mk()) {
    let st = step(from, send('go')).state;
    for (let i = 1; i < rounds; i++) {
      const c = searchCall(`a${i}`);
      st = run(st, FIRST, { type: 'ToolCallsDone', calls: [c] }, { type: 'ToolsDone', results: okResults([c]) }).state;
    }
    return st;
  }

  // ---- SM-31 table rows, in order ----------------------------------------------------------------
  {
    const r = step(mk(), send('find a film'));
    check('idle + Send (key) -> requesting, AppendUser + Request', r.state.kind === 'requesting' && types(r.effects).join() === 'appendUser,request', types(r.effects));
    const req = r.effects[1];
    check(
      'Request: system first, user last, all tools, tool_choice auto, parallel_tool_calls false, completion cap',
      req.messages[0].role === 'system' && req.messages.at(-1).content === 'find a film' && req.tools.length === 15 && req.parallelToolCalls === false && req.toolChoice === 'auto' && req.maxCompletionTokens === ctx.MAX_COMPLETION_TOKENS,
    );
  }
  {
    const r = step(mk(), { type: 'Send', text: 'hi', hasKey: false });
    check('idle + Send (no key) -> idle, notice', r.state.kind === 'idle' && r.state.history.length === 0 && JSON.stringify(r.effects) === JSON.stringify([{ type: 'showNotice', text: 'Add an API key in Settings → Assistant.' }]), r.effects);
  }
  check('requesting + FirstByte -> streaming', step(toRequesting(), FIRST).state.kind === 'streaming');
  for (const [status, msg] of [[401, 'Check your key.'], [403, 'Check your key.'], [402, 'Out of credits.'], [429, 'Rate limited. Try again in a minute.']]) {
    const r = step(toRequesting(), { type: 'HttpErr', status });
    check(`requesting + HttpErr(${status}) -> idle, ErrorCard "${msg}"`, r.state.kind === 'idle' && JSON.stringify(r.effects) === JSON.stringify([{ type: 'errorCard', message: msg }]), r.effects);
  }
  {
    const r = step(toRequesting(), { type: 'NetErr' });
    check('requesting + NetErr (not retried) -> requesting, RetryOnce', r.state.kind === 'requesting' && r.state.retried === true && types(r.effects).join() === 'retryOnce' && r.effects[0].request.round === 1, r.effects);
    const r5 = step(toRequesting(), { type: 'HttpErr', status: 503 });
    check('requesting + 5xx (not retried) -> RetryOnce', r5.state.kind === 'requesting' && types(r5.effects).join() === 'retryOnce');
    const again = step(r.state, { type: 'NetErr' });
    check('requesting + NetErr (already retried) -> idle with an error card', again.state.kind === 'idle' && types(again.effects).join() === 'errorCard', again.effects);
    check('a retry does not count as a round-trip', r.state.rounds === 1);
  }
  {
    const r = step(toRequesting(), { type: 'Abort' });
    check('requesting + Abort -> idle, AbortFetch + MarkCancelled', r.state.kind === 'idle' && types(r.effects).join() === 'abortFetch,markCancelled');
    const t = run(toStreaming(), { type: 'TextDelta', text: 'part' }, { type: 'Abort' });
    check('streaming + Abort -> idle, AbortFetch + MarkCancelled, partial text kept', t.state.kind === 'idle' && types(t.effects).join() === 'abortFetch,markCancelled' && t.state.history.at(-1).content === 'part', t.state.history);
  }
  {
    const r = step(toStreaming(), { type: 'TextDelta', text: 'Hel' });
    check('streaming + TextDelta -> streaming, AppendText', r.state.kind === 'streaming' && JSON.stringify(r.effects) === JSON.stringify([{ type: 'appendText', text: 'Hel' }]));
  }
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [searchCall()] });
    check('streaming + ToolCallsDone (read tool) -> runningTools, RunTool', r.state.kind === 'runningTools' && types(r.effects).join() === 'runTool' && r.effects[0].name === 'search_torrents' && r.effects[0].callId === 'k1', r.effects);
    const h = r.state.history.at(-1);
    check('the assistant message with tool_calls enters history', h.role === 'assistant' && h.tool_calls.length === 1 && h.tool_calls[0].id === 'k1');
  }
  {
    const s = run(mk(), send(), FIRST, { type: 'TextDelta', text: 'Done.' });
    const r = step(s.state, { type: 'Stop' });
    check('streaming + Stop (no pending cards) -> idle, text in history', r.state.kind === 'idle' && r.state.history.at(-1).content === 'Done.' && r.effects.length === 0);
    const a = toAwaitingConfirmation();
    check('streaming + Stop (pending cards) -> awaitingConfirmation', a.state.kind === 'awaitingConfirmation' && a.state.pendingCards.length === 1, a.state);
  }
  {
    const r = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [searchCall()] });
    const done = step(r.state, { type: 'ToolsDone', results: [{ toolCallId: 'k1', content: '{"ok":true,"data":[]}' }] });
    check('runningTools + ToolsDone (under the caps) -> requesting, tool message, Request', done.state.kind === 'requesting' && types(done.effects).join() === 'appendToolMessage,request' && done.state.rounds === 2, types(done.effects));
    const msgs = done.effects[1].messages;
    check('the next Request carries the tool result', msgs.at(-1).role === 'tool' && msgs.at(-1).tool_call_id === 'k1');
  }
  {
    const c = searchCall('z');
    const r = run(toRequestingRounds(6), FIRST, { type: 'ToolCallsDone', calls: [c] }, { type: 'ToolsDone', results: okResults([c]) });
    check('runningTools + ToolsDone (6 round-trips used) -> idle, Note "Stopped after 6 steps."', r.state.kind === 'idle' && r.effects.some((e) => e.type === 'note' && e.text === 'Stopped after 6 steps.') && !r.effects.some((e) => e.type === 'request'), r.effects);
    const withCard = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] }).state;
    const y = searchCall('y');
    // The card is pending; burn the remaining round-trips, then hit the cap.
    let st = withCard;
    for (let i = 2; i < 6; i++) {
      const c2 = searchCall(`w${i}`);
      st = run(st, FIRST, { type: 'ToolCallsDone', calls: [c2] }, { type: 'ToolsDone', results: okResults([c2]) }).state;
    }
    check('six round-trips so far', st.rounds === 6, st.rounds);
    st = run(st, FIRST, { type: 'ToolCallsDone', calls: [searchCall('w6')] }, { type: 'ToolsDone', results: okResults([searchCall('w6')]) }).state;
    check('cap hit with a pending card -> awaitingConfirmation', st.kind === 'awaitingConfirmation' && st.pendingCards.length === 1, st.kind);
    void y;
  }
  {
    const a = toAwaitingConfirmation();
    const cardId = a.state.pendingCards[0];
    check('a proposal answers the model {"status":"proposed","card_id"}', a.state.history.some((h) => h.role === 'tool' && h.content === JSON.stringify({ status: 'proposed', card_id: cardId })), a.state.history);
    const c = step(a.state, { type: 'Confirm', cardId });
    check('awaitingConfirmation + Confirm (valid, last card) -> idle, executeCard', c.state.kind === 'idle' && JSON.stringify(c.effects) === JSON.stringify([{ type: 'executeCard', cardId }]), c.effects);
    const d = step(a.state, { type: 'Dismiss', cardId });
    check('awaitingConfirmation + Dismiss (last card) -> idle, removeCard', d.state.kind === 'idle' && JSON.stringify(d.effects) === JSON.stringify([{ type: 'removeCard', cardId }]));
    const bad = step(a.state, { type: 'Confirm', cardId: 'c99' });
    check('Confirm for a card id that is not valid is a no-op', bad.state === a.state && bad.effects.length === 0);

    let two = run(mk(), send('both'), FIRST, { type: 'ToolCallsDone', calls: [proposePause('p1'), call('p2', 'propose_pause_resume', { transfer_id: 't1', action: 'resume', reason: 'x' })] });
    two = run(two.state, FIRST, { type: 'Stop' });
    check('two proposals make two pending cards', two.state.pendingCards.length === 2 && two.state.kind === 'awaitingConfirmation', two.state.pendingCards);
    const one = step(two.state, { type: 'Confirm', cardId: two.state.pendingCards[0] });
    check('Confirm with another card left -> stays awaitingConfirmation', one.state.kind === 'awaitingConfirmation' && one.state.pendingCards.length === 1);
    const oneD = step(two.state, { type: 'Dismiss', cardId: two.state.pendingCards[1] });
    check('Dismiss with another card left -> stays awaitingConfirmation', oneD.state.kind === 'awaitingConfirmation' && oneD.state.pendingCards.length === 1);
  }
  {
    const a = toAwaitingConfirmation();
    const r = step(a.state, send('never mind'));
    check('awaitingConfirmation + Send -> requesting, ExpireCards, AppendUser, Request', r.state.kind === 'requesting' && types(r.effects).join() === 'expireCards,appendUser,request' && r.state.pendingCards.length === 0, types(r.effects));
    check('Send resets the round and call counters', r.state.rounds === 1 && r.state.toolCalls === 0);
  }

  // ---- no-ops (events not in the table) ---------------------------------------------------------------------
  {
    const idle = mk();
    const running = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [searchCall()] }).state;
    const payload = {
      Send: send('x'),
      TextDelta: { type: 'TextDelta', text: 'x' },
      ToolCallsDone: { type: 'ToolCallsDone', calls: [searchCall('n')] },
      ToolsDone: { type: 'ToolsDone', results: [] },
      HttpErr: { type: 'HttpErr', status: 500 },
      Confirm: { type: 'Confirm', cardId: 'c1' },
    };
    const table = [
      ['idle', idle, ['FirstByte', 'Stop', 'Abort', 'TextDelta', 'ToolsDone', 'NetErr']],
      ['requesting', toRequesting(), ['Stop', 'TextDelta', 'ToolCallsDone', 'ToolsDone', 'Send', 'Confirm']],
      ['streaming', toStreaming(), ['FirstByte', 'HttpErr', 'NetErr', 'ToolsDone', 'Send', 'Confirm']],
      ['runningTools', running, ['Abort', 'Stop', 'TextDelta', 'FirstByte', 'Send', 'NetErr']],
    ];
    for (const [name, st, evs] of table) {
      for (const t of evs) {
        const r = step(st, payload[t] ?? { type: t });
        check(`${name} + ${t} is a no-op`, r.state === st && r.effects.length === 0);
      }
    }
    check('an unknown event type is a no-op', step(idle, { type: 'Bogus' }).state === idle);
    check('a blank Send is a no-op', step(idle, send('   ')).state === idle);
  }

  // ---- caps -------------------------------------------------------------------------------------------------------
  {
    const five = [1, 2, 3, 4, 5].map((i) => searchCall(`m${i}`));
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: five });
    check('at most 3 tool calls per round-trip are run', r.state.kind === 'runningTools' && r.effects.filter((e) => e.type === 'runTool').length === 3 && r.state.history.at(-1).tool_calls.length === 3, r.effects.length);
    const done = step(r.state, { type: 'ToolsDone', results: okResults(five.slice(0, 3)) });
    check('dropping calls over the per-round cap ends the turn with the note', done.state.kind === 'idle' && done.effects.some((e) => e.type === 'note') && !done.effects.some((e) => e.type === 'request'));
  }
  {
    // 3 + 3 calls continue; the third round-trip is trimmed to 2 (turn cap 8) and the turn stops.
    let st = toRequesting();
    for (const p of ['a', 'b']) {
      const calls = [0, 1, 2].map((i) => searchCall(`${p}${i}`));
      st = run(st, FIRST, { type: 'ToolCallsDone', calls }, { type: 'ToolsDone', results: okResults(calls) }).state;
    }
    check('6 calls so far still continue', st.kind === 'requesting' && st.toolCalls === 6, st.toolCalls);
    const calls = [0, 1, 2].map((i) => searchCall(`c${i}`));
    const r = run(st, FIRST, { type: 'ToolCallsDone', calls });
    check('the 8-call turn cap trims the third round-trip to 2 calls', r.effects.filter((e) => e.type === 'runTool').length === 2 && r.state.toolCalls === 8);
    const fin = step(r.state, { type: 'ToolsDone', results: okResults(calls.slice(0, 2)) });
    check('hitting the turn call cap ends the turn with "Stopped after 6 steps."', fin.state.kind === 'idle' && fin.effects.some((e) => e.type === 'note' && e.text === 'Stopped after 6 steps.'));

    // Exactly 8 used and no call dropped: the model may still answer in text. A further call is refused.
    const calls2 = [0, 1].map((i) => searchCall(`d${i}`));
    const at8 = run(st, FIRST, { type: 'ToolCallsDone', calls: calls2 }, { type: 'ToolsDone', results: okResults(calls2) });
    check('exactly 8 calls with none dropped continues (table: calls <= 8)', at8.state.kind === 'requesting' && at8.state.toolCalls === 8, at8.state.kind);
    const late = run(at8.state, FIRST, { type: 'TextDelta', text: 'Here is what I found.' }, { type: 'ToolCallsDone', calls: [searchCall('late')] });
    check('a call after the 8th ends the turn with the note and keeps the text', late.state.kind === 'idle' && late.effects.some((e) => e.type === 'note') && late.state.history.at(-1).content === 'Here is what I found.', late.state.history.at(-1));
  }
  check('SM-31 caps match context.ts', ctx.MAX_ROUND_TRIPS === 6 && ctx.MAX_TOOL_CALLS_PER_TURN === 8 && ctx.MAX_TOOL_CALLS_PER_ROUND_TRIP === 3);
  {
    const st = toRequestingRounds(6);
    check('the 6th request is issued, rounds = 6', st.kind === 'requesting' && st.rounds === 6);
  }

  // ---- bad calls go back to the model -----------------------------------------------------------------------------
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [call('u1', 'delete_everything', {})] });
    const toolMsg = r.state.history.find((h) => h.role === 'tool');
    check('unknown tool -> {ok:false,error} tool message, no crash, next request goes out', r.state.kind === 'requesting' && JSON.parse(toolMsg.content).ok === false && typeof JSON.parse(toolMsg.content).error === 'string' && types(r.effects).includes('request'), toolMsg);
  }
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [call('b1', 'get_result_details', { result_id: 'r77' })] });
    const toolMsg = r.state.history.find((h) => h.role === 'tool');
    check('bad handle -> {ok:false,error} tool message and no RunTool', r.state.kind === 'requesting' && JSON.parse(toolMsg.content).ok === false && !types(r.effects).includes('runTool'), r.effects);
  }
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [call('b2', 'propose_pause_resume', { transfer_id: 't1', action: 'explode', reason: 'x' })] });
    check('bad args on a proposal create no card', r.state.pendingCards.length === 0 && !types(r.effects).includes('createCard'));
  }
  {
    const run1 = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [searchCall('q1')] });
    const r = step(run1.state, { type: 'ToolsDone', results: [] });
    check('a read tool with no result is answered with an error message', JSON.parse(r.state.history.at(-1).content).ok === false);
  }
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [searchCall('m1'), proposePause('m2')] });
    check('read + proposal in one round: RunTool and CreateCard', types(r.effects).join() === 'runTool,createCard' && r.state.kind === 'runningTools');
    const d = step(r.state, { type: 'ToolsDone', results: [{ toolCallId: 'm1', content: '{"ok":true}' }] });
    const tools = d.state.history.filter((h) => h.role === 'tool').map((h) => h.tool_call_id);
    check('tool messages keep call order', tools.join() === 'm1,m2', tools);
  }

  // ---- retry once --------------------------------------------------------------------------------------------------
  {
    const bad = (code) => ({ type: 'StreamFailed', error: { code, message: 'Bad response from the provider.' } });
    const r = step(toStreaming(), bad('bad_response'));
    check('streaming + bad response -> one retry, partial discarded', r.state.kind === 'requesting' && types(r.effects).join() === 'retryOnce' && r.effects[0].discardPartial === true);
    const r2 = step(step(r.state, FIRST).state, bad('bad_response'));
    check('a second bad response -> idle with the provider message', r2.state.kind === 'idle' && r2.effects[0].type === 'errorCard' && r2.effects[0].message === 'Bad response from the provider.', r2.effects);
    const r3 = step(toStreaming(), { type: 'StreamFailed', error: { code: 'provider', message: 'x', status: 429 } });
    check('a mid-stream 429 is not retried', r3.state.kind === 'idle' && r3.effects[0].message === 'Rate limited. Try again in a minute.');
    const r4 = step(toStreaming(), { type: 'StreamFailed', error: { code: 'incomplete', message: 'The answer was cut off.' } });
    check('an incomplete stream counts as a bad response (retried once)', types(r4.effects).join() === 'retryOnce');
    const after = run(toRequesting(), { type: 'NetErr' }, FIRST, { type: 'ToolCallsDone', calls: [searchCall('q')] }, { type: 'ToolsDone', results: okResults([searchCall('q')]) });
    check('the retry flag resets for the next request in the turn', after.state.retried === false && after.state.kind === 'requesting');
  }
  {
    const r = step(toRequesting(), { type: 'HttpErr', status: 400 });
    check('other 4xx -> idle with a plain error, not retried', r.state.kind === 'idle' && r.effects[0].type === 'errorCard');
  }

  // ---- expire cards and session interplay (SM-42) ------------------------------------------------------------------
  {
    const a = toAwaitingConfirmation();
    const r = step(a.state, { type: 'Clear' });
    check('Clear (SM-42) -> idle, empty history, expire cards, drop handles', r.state.kind === 'idle' && r.state.history.length === 0 && r.state.userTexts.length === 0 && r.state.pendingCards.length === 0 && types(r.effects).join() === 'expireCards,clearHandles', types(r.effects));
    const s = step(toStreaming(), { type: 'Clear' });
    check('Clear while streaming aborts the request first', types(s.effects).join() === 'abortFetch,expireCards,clearHandles' && s.state.kind === 'idle');
    check('after Clear, tool results arriving late are ignored', step(s.state, { type: 'ToolsDone', results: [] }).effects.length === 0);
  }
  {
    const a = toAwaitingConfirmation();
    check('Abort in awaitingConfirmation is a no-op (cards kept)', step(a.state, { type: 'Abort' }).state === a.state);
    let s = run(mk(), send('pause it'), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] });
    s = run(s.state, FIRST, { type: 'Abort' });
    check('Abort keeps pending cards and history (SM-42 "keep history and cards")', s.state.kind === 'idle' && s.state.pendingCards.length === 1 && s.state.history.length >= 3);
    const c = step(s.state, { type: 'Confirm', cardId: s.state.pendingCards[0] });
    check('a kept card can still be confirmed from idle', c.effects[0].type === 'executeCard' && c.state.pendingCards.length === 0 && c.state.kind === 'idle');
    const n = step(s.state, send('next'));
    check('the next Send after Abort expires the kept cards', types(n.effects).join() === 'expireCards,appendUser,request');
    check('history survives Abort and feeds the next request', n.effects.at(-1).messages.some((x) => x.role === 'user' && x.content === 'pause it'));
  }

  // ---- user text cap and RangeError ---------------------------------------------------------------------------------
  {
    const long = 'x'.repeat(USER_TEXT_MAX + 500);
    const r = step(mk(), send(long));
    check('user text is capped before it enters history', r.state.history[0].content.length === USER_TEXT_MAX && r.effects[0].text.length === USER_TEXT_MAX, r.state.history[0].content.length);
    check('userTexts holds the capped text', r.state.userTexts[0].length === USER_TEXT_MAX);
  }
  {
    let r;
    let threw = false;
    try {
      r = step(mk({ budget: 5 }), send('hello there'));
    } catch {
      threw = true;
    }
    check('RangeError from buildContext never escapes the reducer', !threw);
    check('RangeError path: stays idle, message not kept, plain error card', !threw && r.state.kind === 'idle' && r.state.history.length === 0 && r.state.userTexts.length === 0 && JSON.stringify(r.effects) === JSON.stringify([{ type: 'errorCard', message: 'That message is too long. Try a shorter one.' }]), r && r.effects);
    const a = toAwaitingConfirmation();
    const tight = step({ ...a.state, config: { ...a.state.config, budget: 5 } }, send('hi'));
    check('RangeError while awaitingConfirmation keeps the cards and the state', tight.state.kind === 'awaitingConfirmation' && tight.state.pendingCards.length === 1 && types(tight.effects).join() === 'errorCard', types(tight.effects));
  }
  {
    const run1 = run(mk(), send('hi'), FIRST, { type: 'ToolCallsDone', calls: [searchCall('q1')] });
    const tight = { ...run1.state, config: { ...run1.state.config, budget: 5 } };
    let r;
    let threw = false;
    try {
      r = step(tight, { type: 'ToolsDone', results: okResults([searchCall('q1')]) });
    } catch {
      threw = true;
    }
    check('RangeError on a follow-up request ends the turn with an error card', !threw && r.state.kind === 'idle' && r.effects.some((e) => e.type === 'errorCard'));
  }

  // ---- URL provenance -----------------------------------------------------------------------------------------------
  {
    const url = 'https://example.com/files/linux.iso';
    const r = step(toStreaming(mk(), `please get ${url} for me`), { type: 'ToolCallsDone', calls: [urlCall(url)] });
    check('propose_url_download with a pasted url creates a card', types(r.effects).includes('createCard') && r.state.pendingCards.length === 1, r.effects);
  }
  {
    const r = step(toStreaming(mk(), 'download something good'), { type: 'ToolCallsDone', calls: [urlCall('https://evil.example/a.zip')] });
    const msg = JSON.parse(r.state.history.find((h) => h.role === 'tool').content);
    check('propose_url_download with an invented url -> tool error, no card', !types(r.effects).includes('createCard') && r.state.pendingCards.length === 0 && msg.ok === false && /only download links you pasted/.test(msg.error), msg);
  }
  {
    const url = 'https://example.com/a.zip';
    const r = step(toStreaming(mk(), `get ${url}`), { type: 'ToolCallsDone', calls: [urlCall(`${url}?x=1`)] });
    check('the url must appear verbatim: a changed url is refused', r.state.pendingCards.length === 0);
  }
  {
    const url = 'https://example.com/b.zip';
    let s = run(mk(), send(`here: ${url}`), FIRST, { type: 'Stop' });
    s = run(s.state, send('and another thing'), FIRST);
    const r = step(s.state, { type: 'ToolCallsDone', calls: [urlCall(url)] });
    check('a url pasted in an earlier message of this session is allowed', r.state.pendingCards.length === 1);
  }
  {
    const url = 'https://example.com/c.zip';
    const t = step(toStreaming(mk(), 'get me the file'), { type: 'TextDelta', text: `try ${url}` });
    const r = step(t.state, { type: 'ToolCallsDone', calls: [urlCall(url)] });
    check('a url only the model wrote is refused', r.state.pendingCards.length === 0);
  }
  {
    const plan = (url) => call('pl', 'propose_plan', { reason: 'One step.', steps: [{ tool: 'propose_url_download', args: { url, reason: 'x' } }] });
    const bad = step(toStreaming(mk(), 'get the thing'), { type: 'ToolCallsDone', calls: [plan('https://evil.example/x.zip')] });
    check('a url inside a plan step is checked too', bad.state.pendingCards.length === 0);
    const good = step(toStreaming(mk(), 'get https://example.com/x.zip'), { type: 'ToolCallsDone', calls: [plan('https://example.com/x.zip')] });
    check('a pasted url inside a plan step is allowed', good.state.pendingCards.length === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
