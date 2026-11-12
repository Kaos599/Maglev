#!/usr/bin/env node
// SM-31 Assistant chat turn (with review round 1). One test per row of the transition table, plus caps, retry-once,
// card lifecycle, abort of running tools, the send gate and the RangeError path.
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
  const { TOOLS } = await import('../utils/assistant/tools.ts');
  const STOPPED = "I hit my limit for one question. Here's what I found. Ask me to keep going.";

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
  const send = (text = 'hello') => ({ type: 'Send', text, enabled: true, warningAccepted: true, hasKey: true });
  const FIRST = { type: 'FirstByte' };
  const toRequesting = (state = mk(), text = 'hello') => step(state, send(text)).state;
  const toStreaming = (state, text) => step(toRequesting(state, text), FIRST).state;
  const call = (id, name, args) => ({ id, name, arguments: args });
  const searchCall = (id = 'k1') => call(id, 'search_torrents', { query: 'The Last Harbor' });
  const proposePause = (id = 'k1') =>
    call(id, 'propose_pause_resume', { transfer_id: 't1', action: 'pause', reason: 'Because.' });
  const deleteCall = (id, t = 't1') => call(id, 'propose_delete', { transfer_id: t, reason: 'Not needed.' });
  const pauseCall = (id, t) => call(id, 'propose_pause_resume', { transfer_id: t, action: 'pause', reason: 'Because.' });
  const detailsCall = (id) => call(id, 'get_result_details', { result_id: 'r1' });
  const toolMsgs = (state) => state.history.filter((h) => h.role === 'tool');
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
      req.messages[0].role === 'system' && req.messages.at(-1).content === 'find a film' && req.tools.length === TOOLS.length && req.parallelToolCalls === false && req.toolChoice === 'auto' && req.maxCompletionTokens === ctx.MAX_COMPLETION_TOKENS,
    );
  }
  {
    const r = step(mk(), { type: 'Send', text: 'hi', enabled: true, warningAccepted: true, hasKey: false });
    check('idle + Send (no key) -> idle, notice', r.state.kind === 'idle' && r.state.history.length === 0 && JSON.stringify(r.effects) === JSON.stringify([{ type: 'showNotice', text: 'Add an API key in Settings → Assistant.' }]), r.effects);
  }
  check('requesting + FirstByte -> streaming', step(toRequesting(), FIRST).state.kind === 'streaming');
  const KEY_MSG = "{provider} didn't accept your key. Sign in again in Settings → Assistant.";
  const CREDIT_MSG = 'Your {provider} account is out of credit. Add credit on their site, or pick a free model in Settings.';
  for (const [status, msg] of [[401, KEY_MSG], [403, KEY_MSG], [402, CREDIT_MSG], [429, "You've hit this model's limit for now. Try again later, or pick another model."]]) {
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
    // Round 6 is the last. No read tool runs in it (the model could not use the result).
    const c = searchCall('z');
    const r = run(toRequestingRounds(6), FIRST, { type: 'ToolCallsDone', calls: [c] });
    check('round 6 never runs a read tool: no RunTool, no request, Note with the limit copy', r.state.kind === 'idle' && !r.effects.some((e) => e.type === 'runTool' || e.type === 'request') && r.effects.some((e) => e.type === 'note' && e.text === STOPPED), r.effects);
    check('the unrun call is answered with a tool error so history stays valid', JSON.parse(toolMsgs(r.state).at(-1).content).ok === false && toolMsgs(r.state).at(-1).tool_call_id === 'z');
    check('round 5 still runs read tools', step(run(toRequestingRounds(5), FIRST).state, { type: 'ToolCallsDone', calls: [c] }).effects.some((e) => e.type === 'runTool'));
    const p6 = run(toRequestingRounds(6), FIRST, { type: 'ToolCallsDone', calls: [proposePause('z2')] });
    check('round 6 may still create a card, then ends at awaitingConfirmation', p6.state.kind === 'awaitingConfirmation' && p6.effects.some((e) => e.type === 'createCard') && !p6.effects.some((e) => e.type === 'request'), p6.effects);
    const withCard = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] }).state;
    let st = withCard;
    for (let i = 2; i < 6; i++) {
      const c2 = searchCall(`w${i}`);
      st = run(st, FIRST, { type: 'ToolCallsDone', calls: [c2] }, { type: 'ToolsDone', results: okResults([c2]) }).state;
    }
    check('six round-trips so far', st.rounds === 6, st.rounds);
    st = run(st, FIRST, { type: 'ToolCallsDone', calls: [searchCall('w6')] }).state;
    check('cap hit with a pending card -> awaitingConfirmation', st.kind === 'awaitingConfirmation' && st.pendingCards.length === 1, st.kind);
  }
  {
    const a = toAwaitingConfirmation();
    const cardId = a.state.pendingCards[0];
    check('a proposal answers the model {"status":"proposed","card_id"}', a.state.history.some((h) => h.role === 'tool' && h.content === JSON.stringify({ status: 'proposed', card_id: cardId })), a.state.history);
    const c = step(a.state, { type: 'Confirm', cardId });
    check('Confirm only emits confirmCard; the card stays pending until cardMachine settles it', c.state.kind === 'awaitingConfirmation' && c.state.pendingCards.length === 1 && JSON.stringify(c.effects) === JSON.stringify([{ type: 'confirmCard', cardId }]), c);
    check('no executeCard effect exists any more', !JSON.stringify(c.effects).includes('executeCard'));
    const d = step(a.state, { type: 'Dismiss', cardId });
    check('Dismiss only emits dismissCard; the card stays pending until settled', d.state.pendingCards.length === 1 && JSON.stringify(d.effects) === JSON.stringify([{ type: 'dismissCard', cardId }]));
    const bad = step(a.state, { type: 'Confirm', cardId: 'c99' });
    check('Confirm for a card id that is not pending is a no-op', bad.state === a.state && bad.effects.length === 0);
    check('a failed revalidation leaves the card pending, so Confirm works again (adversarial)', JSON.stringify(step(c.state, { type: 'Confirm', cardId }).effects) === JSON.stringify([{ type: 'confirmCard', cardId }]));
    for (const kind of ['done', 'dismissed', 'expired']) {
      const r = step(a.state, { type: 'CardSettled', cardId, kind });
      check(`CardSettled(${kind}) removes the card; last card -> idle`, r.state.kind === 'idle' && r.state.pendingCards.length === 0 && r.effects.length === 0);
    }
    const failed = step(a.state, { type: 'CardSettled', cardId, kind: 'failed' });
    check('CardSettled(failed) keeps the card (it can be retried)', failed.state.pendingCards.length === 1 && failed.state.kind === 'awaitingConfirmation');
    check('CardSettled for an unknown card is a no-op', step(a.state, { type: 'CardSettled', cardId: 'c99', kind: 'done' }).state === a.state);

    let two = run(mk(), send('both'), FIRST, { type: 'ToolCallsDone', calls: [proposePause('p1'), call('p2', 'propose_pause_resume', { transfer_id: 't1', action: 'resume', reason: 'x' })] });
    two = run(two.state, FIRST, { type: 'Stop' });
    check('two proposals for the same target leave only the newer card (newer card for the same target)', two.state.pendingCards.length === 1, two.state.pendingCards);
    const reg = two.state.config.registry;
    reg.issue('transfer', 8);
    let three = run(two.state, send('more'), FIRST, { type: 'ToolCallsDone', calls: [pauseCall('p3', 't2')] }, FIRST, { type: 'Stop' });
    check('two cards for different targets are both pending', three.state.pendingCards.length === 2 && three.state.kind === 'awaitingConfirmation', three.state.pendingCards);
    const settled = step(three.state, { type: 'CardSettled', cardId: three.state.pendingCards[0], kind: 'done' });
    check('CardSettled with another card left -> stays awaitingConfirmation', settled.state.kind === 'awaitingConfirmation' && settled.state.pendingCards.length === 1);
  }
  {
    // Confirm and Dismiss work in every turn state.
    const a = toAwaitingConfirmation();
    const cardId = a.state.pendingCards[0];
    const inState = (kind, extra = {}) => ({ ...a.state, kind, ...extra });
    for (const kind of ['idle', 'requesting', 'streaming', 'runningTools', 'awaitingConfirmation']) {
      const st = inState(kind);
      const c = step(st, { type: 'Confirm', cardId });
      const d = step(st, { type: 'Dismiss', cardId });
      check(`Confirm in ${kind} emits confirmCard and keeps the state`, c.state.kind === kind && JSON.stringify(c.effects) === JSON.stringify([{ type: 'confirmCard', cardId }]));
      check(`Dismiss in ${kind} emits dismissCard and keeps the state`, d.state.kind === kind && JSON.stringify(d.effects) === JSON.stringify([{ type: 'dismissCard', cardId }]));
    }
    const midTurn = inState('streaming');
    const settled = step(midTurn, { type: 'CardSettled', cardId, kind: 'done' });
    check('a card settled mid-turn leaves the turn state alone', settled.state.kind === 'streaming' && settled.state.pendingCards.length === 0);
  }
  {
    const a = toAwaitingConfirmation();
    const r = step(a.state, send('never mind'));
    check('awaitingConfirmation + Send -> requesting, AppendUser, Request; no ExpireCards', r.state.kind === 'requesting' && types(r.effects).join() === 'appendUser,request', types(r.effects));
    check('a new Send keeps the pending cards', r.state.pendingCards.length === 1 && r.state.pendingCards[0] === a.state.pendingCards[0]);
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
      ['runningTools', running, ['TextDelta', 'FirstByte', 'Send', 'NetErr']],
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
    check('hitting the turn call cap ends the turn with "Stopped after 6 steps."', fin.state.kind === 'idle' && fin.effects.some((e) => e.type === 'note' && e.text === STOPPED));

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
    check('a mid-stream 429 is not retried', r3.state.kind === 'idle' && r3.effects[0].message === "You've hit this model's limit for now. Try again later, or pick another model.");
    const r4 = step(toStreaming(), { type: 'StreamFailed', error: { code: 'incomplete', message: 'The answer was cut off.' } });
    check('an incomplete stream counts as a bad response (retried once)', types(r4.effects).join() === 'retryOnce');
    const after = run(toRequesting(), { type: 'NetErr' }, FIRST, { type: 'ToolCallsDone', calls: [searchCall('q')] }, { type: 'ToolsDone', results: okResults([searchCall('q')]) });
    check('the retry budget is per turn: the flag does NOT reset for the next request', after.state.retried === true && after.state.kind === 'requesting');
    const second = step(after.state, { type: 'NetErr' });
    check('a NetErr in a later round of the same turn is not retried again', second.state.kind === 'requesting' ? false : true);
    const secondStream = step(step(after.state, FIRST).state, { type: 'StreamFailed', error: { code: 'bad_response', message: 'Bad response from the provider.' } });
    check('a second bad response later in the same turn is not retried', secondStream.state.kind === 'idle' && types(secondStream.effects).join() === 'errorCard', secondStream.effects);
    const fresh = run(secondStream.state, send('again'), { type: 'NetErr' });
    check('a new Send gets a fresh retry', fresh.state.retried === true && types(fresh.effects).join() === 'retryOnce');
  }
  {
    const r = step(toRequesting(), { type: 'HttpErr', status: 400 });
    check('other 4xx -> idle with a plain error, not retried', r.state.kind === 'idle' && r.effects[0].type === 'errorCard');
  }

  // ---- expire cards and session interplay (SM-42) ------------------------------------------------------------------
  {
    const a = toAwaitingConfirmation();
    const r = step(a.state, { type: 'Clear' });
    check('Clear (SM-42) -> idle, empty history, expire cards, drop handles', r.state.kind === 'idle' && r.state.history.length === 0 && r.state.pendingCards.length === 0 && types(r.effects).join() === 'expireCards,clearHandles', types(r.effects));
    const s = step(toStreaming(), { type: 'Clear' });
    check('Clear while streaming aborts the request first', types(s.effects).join() === 'abortFetch,expireCards,clearHandles' && s.state.kind === 'idle');
    check('after Clear, tool results arriving late are ignored', step(s.state, { type: 'ToolsDone', results: [] }).effects.length === 0);
  }
  {
    const a = toAwaitingConfirmation();
    check('Abort in awaitingConfirmation is a no-op (cards kept)', step(a.state, { type: 'Abort' }).state === a.state);
    let s = run(mk(), send('pause it'), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] });
    s = run(s.state, FIRST, { type: 'Abort' });
    check('Abort keeps pending cards and history (SM-42 "keep history and cards"); rests at awaitingConfirmation', s.state.kind === 'awaitingConfirmation' && s.state.pendingCards.length === 1 && s.state.history.length >= 3);
    const c = step(s.state, { type: 'Confirm', cardId: s.state.pendingCards[0] });
    check('a kept card can still be confirmed after Abort', c.effects[0].type === 'confirmCard' && c.state.pendingCards.length === 1);
    const n = step(s.state, send('next'));
    check('the next Send after Abort keeps the cards (no ExpireCards)', types(n.effects).join() === 'appendUser,request' && n.state.pendingCards.length === 1);
    check('history survives Abort and feeds the next request', n.effects.at(-1).messages.some((x) => x.role === 'user' && x.content === 'pause it'));
  }

  // ---- user text cap and RangeError ---------------------------------------------------------------------------------
  {
    const long = 'x'.repeat(USER_TEXT_MAX + 500);
    const r = step(mk(), send(long));
    check('user text is capped before it enters history', r.state.history[0].content.length === USER_TEXT_MAX && r.effects[0].text.length === USER_TEXT_MAX, r.state.history[0].content.length);
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
    check('RangeError path: stays idle, message not kept, plain error card', !threw && r.state.kind === 'idle' && r.state.history.length === 0 && JSON.stringify(r.effects) === JSON.stringify([{ type: 'errorCard', message: 'That message is too long. Try a shorter one.' }]), r && r.effects);
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

  // ---- send gate (R1-6) --------------------------------------------------------------------------------------------
  {
    const gate = (over) => step(mk(), { type: 'Send', text: 'hi', enabled: true, warningAccepted: true, hasKey: true, ...over });
    const notice = (r) => (r.effects[0] && r.effects[0].type === 'showNotice' ? r.effects[0].text : null);
    const off = gate({ enabled: false });
    check('Assistant off -> its own notice, state unchanged', notice(off) === 'Turn on the Assistant in Settings first.' && off.state.kind === 'idle' && off.state.history.length === 0, off.effects);
    const nowarn = gate({ warningAccepted: false });
    check('notice not accepted -> its own notice', notice(nowarn) === 'Read the Assistant notice in Settings first.' && nowarn.state.history.length === 0, nowarn.effects);
    const nokey = gate({ hasKey: false });
    check('no key -> its own notice', notice(nokey) === 'Add an API key in Settings → Assistant.');
    check('the three notices are different', new Set([notice(off), notice(nowarn), notice(nokey)]).size === 3);
    check('all three present -> request goes out', gate({}).state.kind === 'requesting');
  }

  // ---- caps (R1-4) --------------------------------------------------------------------------------------------------
  {
    const st = toStreaming();
    st.config.registry.issue('transfer', 8); // t2
    st.config.registry.issue('transfer', 9); // t3
    const r = step(st, { type: 'ToolCallsDone', calls: [deleteCall('d1'), deleteCall('d2', 't2'), deleteCall('d3', 't3')] });
    const creates = r.effects.filter((e) => e.type === 'createCard');
    const errs = toolMsgs(r.state).filter((m) => JSON.parse(m.content).ok === false).map((m) => JSON.parse(m.content).error);
    check('3 deletes in one round -> 1 card plus 2 tool errors', creates.length === 1 && errs.length === 2 && errs.every((e) => e === 'Only one delete per question. Ask again after this one.') && r.state.pendingCards.length === 1, { creates: creates.length, errs });
    const later = run(r.state, FIRST, { type: 'ToolCallsDone', calls: [call('d4', 'propose_remove_files', { transfer_id: 't2', file_indices: [0], reason: 'x' })] });
    check('the destructive cap is per turn: a remove_files in round 2 is refused too', !later.effects.some((e) => e.type === 'createCard') && JSON.parse(toolMsgs(later.state).at(-1).content).ok === false);
    const next = run(later.state, FIRST, { type: 'Stop' }, send('delete another'), FIRST, { type: 'ToolCallsDone', calls: [deleteCall('d5', 't3')] });
    check('a new turn resets the destructive cap', next.effects.some((e) => e.type === 'createCard'), next.effects);
  }
  {
    const st = toStreaming();
    st.config.registry.issue('transfer', 8);
    st.config.registry.issue('transfer', 9);
    const r = step(st, { type: 'ToolCallsDone', calls: [pauseCall('a', 't1'), pauseCall('b', 't2'), pauseCall('c', 't3')] });
    check('at most 2 proposal cards per turn: the third gets a tool error', r.effects.filter((e) => e.type === 'createCard').length === 2 && JSON.parse(toolMsgs(r.state).at(-1).content).ok === false && r.state.pendingCards.length === 2);
    const plan = call('pl', 'propose_plan', { reason: 'One step.', steps: [{ tool: 'propose_pause_resume', args: { transfer_id: 't1', action: 'pause', reason: 'x' } }] });
    const x = step(toStreaming(), { type: 'ToolCallsDone', calls: [plan, pauseCall('q', 't1')] });
    check('a plan counts as a proposal card', x.state.proposals === 2, x.state.proposals);
  }
  {
    const r = step(toStreaming(), { type: 'ToolCallsDone', calls: [detailsCall('g1'), detailsCall('g2'), detailsCall('g3')] });
    check('get_result_details runs at most 2 per turn', r.effects.filter((e) => e.type === 'runTool').length === 2 && r.state.details === 2);
    const done = step(r.state, { type: 'ToolsDone', results: okResults([detailsCall('g1'), detailsCall('g2')]) });
    check('the third details call is answered with a plain error', JSON.parse(toolMsgs(done.state)[2].content).ok === false);
    const again = run(done.state, FIRST, { type: 'ToolCallsDone', calls: [detailsCall('g4')] });
    check('the details cap holds across rounds of one turn', !again.effects.some((e) => e.type === 'runTool'));
  }

  // ---- retry: per turn, backoff, Retry-After, truncation (R1-4) -----------------------------------------------------
  {
    const r = step(toRequesting(), { type: 'HttpErr', status: 503 });
    check('retryOnce carries 1000 ms with jitter by default', r.effects[0].delayMs === 1000 && r.effects[0].jitter === true, r.effects[0]);
    const ra = step(toRequesting(), { type: 'HttpErr', status: 503, retryAfterMs: 4000 });
    check('retryOnce uses Retry-After when the error carries it (no jitter)', ra.effects[0].delayMs === 4000 && ra.effects[0].jitter === false, ra.effects[0]);
    const long = step(toRequesting(), { type: 'HttpErr', status: 503, retryAfterMs: 120000 });
    check('a Retry-After over 30 s is not waited for', long.state.kind === 'idle' && long.effects[0].type === 'errorCard');
    const n = step(toRequesting(), { type: 'NetErr' });
    check('a network error retries after 1000 ms with jitter', n.effects[0].delayMs === 1000 && n.effects[0].jitter === true);
  }
  {
    const t = run(toStreaming(), { type: 'TextDelta', text: 'Part of an answ' }, { type: 'Stop', truncated: true });
    check('a truncated stream ends the turn with the plain note and keeps the text', t.state.kind === 'idle' && JSON.stringify(t.effects) === JSON.stringify([{ type: 'note', text: 'The answer was too long. Ask a narrower question.' }]) && t.state.history.at(-1).content === 'Part of an answ', t.effects);
    const f = step(toStreaming(), { type: 'StreamFailed', error: { code: 'bad_args', message: 'Bad response from the provider.' }, truncated: true });
    check('a truncated stream that failed to parse never retries', f.state.kind === 'idle' && !types(f.effects).includes('retryOnce') && f.effects[0].text === 'The answer was too long. Ask a narrower question.', f.effects);
    const c = step(toStreaming(), { type: 'ToolCallsDone', calls: [searchCall()], truncated: true });
    check('a truncated tool call is never run', c.state.kind === 'idle' && !types(c.effects).includes('runTool'));
  }

  // ---- abort of running tools (R1-5) --------------------------------------------------------------------------------
  {
    const two = [searchCall('s1'), searchCall('s2')];
    const running = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: two }).state;
    check('two read tools are running', running.kind === 'runningTools' && running.calls.length === 2);
    for (const ev of [{ type: 'Abort' }, { type: 'Stop' }, { type: 'Background' }]) {
      const r = step(running, ev);
      const cancelled = r.effects.filter((e) => e.type === 'appendToolMessage');
      check(`runningTools + ${ev.type} -> cancelTools, cancelled results for pending calls, rest`, r.state.kind === 'idle' && r.effects[0].type === 'cancelTools' && cancelled.length === 2 && cancelled.every((e) => JSON.parse(e.content).error === 'cancelled' && JSON.parse(e.content).ok === false) && toolMsgs(r.state).length === 2, r.effects);
    }
    const ab = step(running, { type: 'Abort' });
    check('Abort in runningTools marks the answer cancelled and sends no request', ab.effects.at(-1).type === 'markCancelled' && !types(ab.effects).includes('request'));
    const mixed = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [searchCall('m1'), proposePause('m2')] }).state;
    const m = step(mixed, { type: 'Abort' });
    check('Abort with a card made this round keeps the card and rests at awaitingConfirmation', m.state.kind === 'awaitingConfirmation' && m.state.pendingCards.length === 1 && toolMsgs(m.state).find((x) => x.tool_call_id === 'm2').content.includes('proposed'));
    const cl = step(running, { type: 'Clear' });
    check('Clear during runningTools emits cancelTools first (adversarial)', types(cl.effects).join() === 'cancelTools,expireCards,clearHandles' && cl.state.kind === 'idle' && cl.state.history.length === 0, types(cl.effects));
    const off = step(running, { type: 'Disabled' });
    check('Disabled during runningTools cancels tools, expires cards, keeps history valid', types(off.effects).slice(0, 2).join() === 'cancelTools,expireCards' && off.state.kind === 'idle' && toolMsgs(off.state).length === 2);
  }
  {
    const two = [searchCall('s1'), searchCall('s2')];
    const running = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: two }).state;
    const t1 = step(running, { type: 'ToolTimeout', toolCallId: 's1' });
    check('ToolTimeout answers that call and keeps waiting for the other', t1.state.kind === 'runningTools' && JSON.stringify(t1.effects) === JSON.stringify([{ type: 'cancelTools', callIds: ['s1'] }]), t1.effects);
    const t2 = step(t1.state, { type: 'ToolsDone', results: [{ toolCallId: 's2', content: '{"ok":true}' }, { toolCallId: 's1', content: '{"ok":true,"late":1}' }] });
    check('the timed-out call keeps its timeout answer even if a late result arrives', t2.state.kind === 'requesting' && JSON.parse(toolMsgs(t2.state)[0].content).error === 'That took too long.');
    const one = run(mk(), send(), FIRST, { type: 'ToolCallsDone', calls: [searchCall('only')] }).state;
    const t3 = step(one, { type: 'ToolTimeout', toolCallId: 'only' });
    check('ToolTimeout on the only call continues the turn', t3.state.kind === 'requesting' && types(t3.effects).join() === 'cancelTools,appendToolMessage,request', types(t3.effects));
    check('ToolTimeout for an unknown call is a no-op', step(running, { type: 'ToolTimeout', toolCallId: 'zz' }).state === running);
    check('ToolTimeout outside runningTools is a no-op', step(toStreaming(), { type: 'ToolTimeout', toolCallId: 's1' }).effects.length === 0);
  }

  // ---- error mapping (no dead ends) -------------------------------------------------------------------------------
  {
    const err = (event) => {
      const r = step(toRequesting(), event);
      return r.effects.length === 1 && r.effects[0].type === 'errorCard' && r.state.kind === 'idle' ? r.effects[0].message : r;
    };
    const NO_TOOLS = "This model can't use Maglev's tools. Pick another model in Settings → Assistant.";
    const GONE = "That model isn't available any more. Pick another in Settings → Assistant.";
    const MUCH = 'That was too much for this model. Clear the chat or ask a shorter question.';
    const REFUSED = 'The AI service refused this message. Try again, or pick another model in Settings.';
    check('400 "does not support tools" -> pick another model', err({ type: 'HttpErr', status: 400, body: 'This model does not support tools' }) === NO_TOOLS);
    check('400 "function calling not supported" -> pick another model', err({ type: 'HttpErr', status: 400, body: 'function calling is not supported' }) === NO_TOOLS);
    check('404 "No endpoints found that support tool use" -> tools copy first', err({ type: 'HttpErr', status: 404, body: 'No endpoints found that support tool use' }) === NO_TOOLS);
    check('404 plain -> model gone', err({ type: 'HttpErr', status: 404 }) === GONE);
    check('400 "model not found" -> model gone', err({ type: 'HttpErr', status: 400, body: 'The model xyz does not exist' }) === GONE);
    check('413 -> too much', err({ type: 'HttpErr', status: 413 }) === MUCH);
    check('400 "maximum context length" -> too much', err({ type: 'HttpErr', status: 400, body: "This model's maximum context length is 8192 tokens" }) === MUCH);
    check('other 4xx -> refused', err({ type: 'HttpErr', status: 422, body: 'bad field' }) === REFUSED && err({ type: 'HttpErr', status: 400 }) === REFUSED);
    check('429 with Retry-After 20 s keeps "Rate limited."', err({ type: 'HttpErr', status: 429, retryAfterMs: 20_000 }) === 'Rate limited. Try again in a minute.');
    check('429 with Retry-After 120 s -> limit for now', err({ type: 'HttpErr', status: 429, retryAfterMs: 120_000 }) === "You've hit this model's limit for now. Try again later, or pick another model.");
    check('a 5xx body is not used (still retried)', step(toRequesting(), { type: 'HttpErr', status: 503, body: 'tools' }).effects[0].type === 'retryOnce');
    // Groq tool_use_failed: retried once, then a plain message.
    const t1 = step(toRequesting(), { type: 'HttpErr', status: 400, body: '{"error":{"code":"tool_use_failed"}}' });
    check('400 tool_use_failed -> retried once', t1.state.kind === 'requesting' && types(t1.effects).join() === 'retryOnce' && t1.state.retried === true);
    const t2 = step(step(t1.state, { type: 'HttpErr', status: 400, body: 'tool_use_failed' }).state, { type: 'HttpErr', status: 400, body: 'tool_use_failed' });
    const t2b = step(t1.state, { type: 'HttpErr', status: 400, body: 'tool_use_failed' });
    check('second tool_use_failed -> "The model sent a broken request."', t2b.effects[0].message === 'The model sent a broken request. Try again.', t2b.effects);
    void t2;
    const s1 = step(toStreaming(), { type: 'StreamFailed', error: { code: 'provider', message: 'x', providerCode: 'tool_use_failed' } });
    check('in-stream tool_use_failed code -> retried once, partial discarded', types(s1.effects).join() === 'retryOnce' && s1.effects[0].discardPartial === true);
    const s2 = step(step(s1.state, FIRST).state, { type: 'StreamFailed', error: { code: 'provider', message: 'x', providerCode: 'tool_use_failed' } });
    check('in-stream tool_use_failed twice -> broken request copy', s2.effects[0].message === 'The model sent a broken request. Try again.');
    const s3 = step(toStreaming(), { type: 'StreamFailed', error: { code: 'provider', message: 'x', status: 400, detail: 'tools not supported' } });
    check('in-stream error with a status uses its detail', s3.effects[0].message === NO_TOOLS);
    check('PortalErr -> public Wi-Fi copy', err({ type: 'PortalErr' }) === "Couldn't reach the AI service. If you're on public Wi-Fi, open your browser to sign in to it.");
  }

  // ---- empty answer and the background note ----------------------------------------------------------------------
  {
    const r = run(toRequesting(), FIRST, { type: 'Stop' });
    check('a stop with no text and no tool calls -> "The model didn\'t answer." error card', r.state.kind === 'idle' && r.effects.length === 1 && r.effects[0].type === 'errorCard' && r.effects[0].message === "The model didn't answer. Try again.", r.effects);
    const t = run(toRequesting(), FIRST, { type: 'TextDelta', text: 'Hi' }, { type: 'Stop' });
    check('a stop with text shows no error', !t.effects.some((e) => e.type === 'errorCard'));
    const c = run(mk(), send('pause it'), FIRST, { type: 'ToolCallsDone', calls: [proposePause()] }, FIRST, { type: 'Stop' });
    check('an empty closing stop after a card is fine (the card answered)', !c.effects.some((e) => e.type === 'errorCard') && c.state.kind === 'awaitingConfirmation', c.effects);
    const sa = run(mk(), send('go'), FIRST, { type: 'TextDelta', text: 'Looking.' }, { type: 'ToolCallsDone', calls: [searchCall('e1')] }, { type: 'ToolsDone', results: okResults([searchCall('e1')]) }, FIRST, { type: 'Stop' });
    check('an empty stop after text in an earlier round is fine', !sa.effects.some((e) => e.type === 'errorCard'), sa.effects);
    const bg = step(toStreaming(), { type: 'Background' });
    const ab = step(toStreaming(), { type: 'Abort' });
    check('Background -> markCancelled with background:true', bg.effects.some((e) => e.type === 'markCancelled' && e.background === true));
    check('Abort/Stop -> plain markCancelled', ab.effects.some((e) => e.type === 'markCancelled' && e.background === undefined));
  }

  // ---- usage --------------------------------------------------------------------------------------------------------
  {
    const r = step(toStreaming(), { type: 'Usage', input: 120, output: 45 });
    check('streaming + Usage -> kept, no effect yet, state kind unchanged', r.state.kind === 'streaming' && r.effects.length === 0 && r.state.usage.input === 120, r.effects);
    // Repeated usage chunks add once, at the end of the round-trip, with the last values.
    const many = run(toStreaming(), { type: 'Usage', input: 10, output: 1 }, { type: 'Usage', input: 120, output: 45 }, { type: 'Usage', input: 120, output: 50 });
    check('three Usage chunks -> still no addUsage', many.effects.length === 0);
    const end = step(many.state, { type: 'TextDelta', text: 'Hi' });
    const fin = step(end.state, { type: 'Stop' });
    const adds = fin.effects.filter((e) => e.type === 'addUsage');
    check('Stop adds the last usage once', adds.length === 1 && adds[0].input === 120 && adds[0].output === 50 && fin.state.usage === null, fin.effects);
    const tools = run(many.state, { type: 'ToolCallsDone', calls: [searchCall('u1')] });
    check('ToolCallsDone adds the usage once too', tools.effects.filter((e) => e.type === 'addUsage').length === 1);
    const cut = step(many.state, { type: 'StreamFailed', error: { code: 'incomplete', message: 'x' } });
    check('a failed stream adds the usage once, then the retry starts clean', cut.effects.filter((e) => e.type === 'addUsage').length === 1 && cut.state.usage === null);
    const bg = step(many.state, { type: 'Background' });
    check('Background adds the usage once', bg.effects.filter((e) => e.type === 'addUsage').length === 1);
    const clamp = run(toStreaming(), { type: 'Usage', input: 5e12, output: -4 }, { type: 'Stop' });
    const ca = clamp.effects.find((e) => e.type === 'addUsage');
    check('usage is clamped to 10 million and negatives to 0', ca.input === 10_000_000 && ca.output === 0, ca);
    const nan = run(toStreaming(), { type: 'Usage', input: 7, output: 3 }, { type: 'Usage', input: NaN, output: Infinity }, { type: 'Stop' });
    const na = nan.effects.find((e) => e.type === 'addUsage');
    check('non-finite usage is ignored (the last good one is kept)', na.input === 7 && na.output === 3, na);
    check('a stop with no usage adds nothing', !run(toStreaming(), { type: 'TextDelta', text: 'x' }, { type: 'Stop' }).effects.some((e) => e.type === 'addUsage'));
  }

  // ---- card expiry (R1-3) -------------------------------------------------------------------------------------------
  {
    const a = toAwaitingConfirmation();
    const cardId = a.state.pendingCards[0];
    const gone = step(a.state, { type: 'TargetGone', target: 't1' });
    check('TargetGone expires the cards for that target (cardMachine EXPIRE via the runner)', JSON.stringify(gone.effects) === JSON.stringify([{ type: 'expireCard', cardId }]), gone.effects);
    check('TargetGone for another target does nothing', step(a.state, { type: 'TargetGone', target: 't9' }).effects.length === 0);
    const off = step(a.state, { type: 'Disabled' });
    check('Disabled (Assistant turned off) expires all cards and keeps history', types(off.effects).join() === 'expireCards' && off.state.pendingCards.length === 0 && off.state.history.length === a.state.history.length);
    const newer = run(a.state, send('again'), FIRST, { type: 'ToolCallsDone', calls: [proposePause('again')] });
    check('a newer card for the same target expires the older one', newer.effects.some((e) => e.type === 'expireCard' && e.cardId === cardId) && newer.state.pendingCards.length === 1 && newer.state.pendingCards[0] !== cardId, newer.effects);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
