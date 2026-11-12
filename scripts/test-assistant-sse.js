#!/usr/bin/env node
// SM-41 stream assembly (docs/STATE_MACHINES_AND_SCREENS.md §6) and recorded fixtures
// (docs/ASSISTANT_DESIGN.md §8.6). Runs the TypeScript source directly (Node 22.18+ type stripping).
// Every fixture is fed whole, then split at every character boundary, then one character at a time;
// all three must give identical events and outcome. Also checks CRLF and UTF-8 byte splits.

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'assistant');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

function run(parser, chunks) {
  const events = [];
  for (const c of chunks) events.push(...parser.push(c));
  return { events, outcome: parser.finish() };
}

function feedWhole(parser, text) {
  return run(parser, [text]);
}

function feedSplit2(make, text) {
  // Every two-way split point, including 0 and length.
  const results = [];
  for (let i = 0; i <= text.length; i++) {
    results.push(run(make(), [text.slice(0, i), text.slice(i)]));
  }
  return results;
}

function feedOneByOne(make, text) {
  return run(make(), [...text]);
}

const load = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

async function main() {
  const { createStreamParser, requestExtras } = await import('../utils/assistant/sse.ts');
  const make = createStreamParser;

  console.log('SM-41 rules');

  test('multiple events in one chunk are returned in order', () => {
    const p = make();
    const ev = p.push(
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    assert.deepStrictEqual(
      ev.map((e) => e.delta),
      ['a', 'b'],
    );
    const out = p.finish();
    assert.strictEqual(out.ok, true, '[DONE] alone is a valid end');
    assert.strictEqual(out.text, 'ab');
  });

  test('text deltas append and state moves idle -> text', () => {
    const p = make();
    assert.strictEqual(p.state, 'idle');
    p.push('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
    assert.strictEqual(p.state, 'text');
  });

  test('[DONE] sets state, later data is ignored', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const after = p.push('data: {"choices":[{"index":0,"delta":{"content":"LATE"}}]}\n\n');
    assert.deepStrictEqual(after, []);
    const out = p.finish();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.text, 'x');
  });

  test('comment lines and keep-alives are ignored', () => {
    const p = make();
    const ev = p.push(': OPENROUTER PROCESSING\n\n:\n\ndata: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(p.finish().text, 'ok');
  });

  test('CRLF line endings parse the same as LF', () => {
    const lf = 'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = run(make(), [lf]);
    const b = run(make(), [crlf]);
    assert.deepStrictEqual(b, a);
  });

  test('tool call fragments are keyed by index; id and name only on first fragment', () => {
    const p = make();
    const ev = p.push(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n',
    );
    assert.strictEqual(ev[0].type, 'tool');
    assert.strictEqual(ev[0].id, 'c1');
    assert.strictEqual(ev[0].name, 'f');
    assert.strictEqual(ev[1].id, 'c1', 'later fragment keeps the call id');
    assert.strictEqual(ev[1].name, 'f', 'later fragment keeps the name');
    assert.strictEqual(ev[1].argumentsLength, '{"a":1}'.length);
    assert.strictEqual(p.state, 'toolCall');
    assert.strictEqual(p.toolIndex, 0);
  });

  test('arguments are parsed only at finish, not while streaming', () => {
    const p = make();
    const ev = p.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n');
    assert.ok(ev.every((e) => e.type !== 'error'), 'partial JSON is not an error mid-stream');
    assert.ok(ev.every((e) => !('arguments' in e)), 'events never carry parsed arguments');
  });

  test('two parallel calls interleaved by index are assembled independently', () => {
    const r = run(make(), load('sse-openrouter-parallel.txt').split('\n').map((l) => l + '\n'));
    assert.strictEqual(r.outcome.ok, true);
    assert.deepStrictEqual(
      r.outcome.toolCalls.map((c) => [c.id, c.name, c.arguments]),
      [
        ['toolu_01', 'search_torrents', { query: 'the last harbor 2023', max_gb: 5 }],
        ['toolu_02', 'resolve_result', { id: 'r1' }],
      ],
    );
    assert.strictEqual(r.outcome.finishReason, 'tool_calls');
    assert.strictEqual(r.outcome.truncated, false);
  });

  test('finish_reason tool_calls returns the calls; stop returns none', () => {
    const r = feedWhole(make(), load('sse-openai-tool.txt'));
    assert.strictEqual(r.outcome.ok, true);
    assert.deepStrictEqual(r.outcome.toolCalls, [
      { id: 'call_abc123', name: 'get_disk_space', arguments: { path: 'Download/Maglev' } },
    ]);
    const t = feedWhole(make(), load('sse-openai-text.txt'));
    assert.strictEqual(t.outcome.finishReason, 'stop');
    assert.deepStrictEqual(t.outcome.toolCalls, []);
    assert.strictEqual(t.outcome.truncated, false);
  });

  test('finish_reason length sets truncated and keeps the text', () => {
    const r = feedWhole(make(), load('sse-openai-length.txt'));
    assert.strictEqual(r.outcome.ok, true);
    assert.strictEqual(r.outcome.truncated, true);
    assert.strictEqual(r.outcome.finishReason, 'length');
    assert.strictEqual(r.outcome.text, 'Here are the options I found, sorted by fit:\n1.');
  });

  test('error object in the stream gives a provider error event and a typed outcome', () => {
    const r = feedWhole(make(), load('sse-openrouter-error.txt'));
    const errEvents = r.events.filter((e) => e.type === 'error');
    assert.strictEqual(errEvents.length, 1);
    assert.strictEqual(r.outcome.ok, false);
    assert.strictEqual(r.outcome.error.code, 'provider');
    assert.strictEqual(r.outcome.error.message, 'The provider stopped mid-answer.');
    assert.strictEqual(r.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'The download needs 3.2 GB.');
  });

  test('numeric error codes map to plain English (401, 402, 429)', () => {
    const cases = [
      [401, 'Check your key.'],
      [402, 'Out of credits.'],
      [429, 'Rate limited. Try again in a minute.'],
    ];
    for (const [status, msg] of cases) {
      const p = make();
      p.push(`data: {"error":{"code":${status},"message":"x"}}\n\n`);
      const out = p.finish();
      assert.strictEqual(out.error.message, msg);
      assert.strictEqual(out.error.status, status);
    }
  });

  test('finish_reason "error" is a provider failure', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n');
    assert.strictEqual(p.finish().error.code, 'provider');
  });

  test('malformed JSON in a data line gives bad_response', () => {
    const p = make();
    const ev = p.push('data: {"choices":[{"index":0,"delta":{"content":"x"\n\n');
    assert.strictEqual(ev[0].type, 'error');
    assert.strictEqual(ev[0].error.message, 'Bad response from the provider.');
    const out = p.finish();
    assert.deepStrictEqual(out.error, { code: 'bad_response', message: 'Bad response from the provider.' });
    assert.strictEqual(p.state, 'error');
  });

  test('malformed JSON fixture-style line in the middle stops further events', () => {
    const p = make();
    p.push('data: nope\n\n');
    assert.deepStrictEqual(p.push('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n'), []);
    assert.strictEqual(p.finish().error.code, 'bad_response');
  });

  test('arguments that are not JSON give bad_args at finish, not mid-stream', () => {
    const p = make();
    const ev = p.push(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{oops"}}]},"finish_reason":"tool_calls"}]}\n\n',
    );
    assert.ok(ev.every((e) => e.type !== 'error'));
    assert.strictEqual(p.finish().error.code, 'bad_args');
  });

  test('arguments that parse but are not an object give bad_args', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"[1,2]"}}]},"finish_reason":"tool_calls"}]}\n\n');
    assert.strictEqual(p.finish().error.code, 'bad_args');
  });

  test('empty arguments are read as {}', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":""}}]},"finish_reason":"tool_calls"}]}\n\n');
    assert.deepStrictEqual(p.finish().toolCalls, [{ id: 'c', name: 'f', arguments: {} }]);
  });

  test('a call with no name gives bad_response; a missing id is synthesised', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    assert.strictEqual(p.finish().error.code, 'bad_response');
    const q = make();
    q.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    const out = q.finish();
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.toolCalls, [{ id: 'call_1', name: 'f', arguments: {} }]);
  });

  test('stream that ends with no finish_reason and no [DONE] gives incomplete', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n');
    assert.deepStrictEqual(p.finish().error, { code: 'incomplete', message: 'The answer was cut off.' });
  });

  test('a final event without a trailing blank line is still dispatched on finish', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":"stop"}]}');
    assert.strictEqual(p.finish().text, 'tail');
  });

  test('finish() is idempotent and push() after finish() is ignored', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"stop"}]}\n\n');
    const first = p.finish();
    assert.deepStrictEqual(p.finish(), first);
    assert.deepStrictEqual(p.push('data: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n\n'), []);
  });

  test('usage-only chunk with empty choices is accepted', () => {
    const r = feedWhole(make(), load('sse-openai-text.txt'));
    assert.strictEqual(r.outcome.ok, true);
    assert.strictEqual(r.outcome.text, 'Your download is stuck at 99%, usually because no peers are left.');
  });

  console.log('R1-12: usage, truncation, synthesis, caps');
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const tc = (frag, finish) => sse({ choices: [{ index: 0, delta: { tool_calls: [frag] }, ...(finish ? { finish_reason: finish } : {}) }] });

  test('requestExtras asks for usage', () => {
    assert.deepStrictEqual(requestExtras(), { stream_options: { include_usage: true } });
  });

  test('usage-only chunk after finish_reason emits a usage event and lands in the outcome', () => {
    const p = make();
    const ev = [
      ...p.push(sse({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] })),
      ...p.push(sse({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } })),
      ...p.push('data: [DONE]\n\n'),
    ];
    assert.deepStrictEqual(ev.filter((e) => e.type === 'usage'), [{ type: 'usage', input: 120, output: 8 }]);
    const out = p.finish();
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.usage, { input: 120, output: 8 });
    assert.strictEqual(out.text, 'hi');
  });

  test('input_tokens/output_tokens are accepted; usage:null and junk are ignored', () => {
    const p = make();
    const ev = [
      ...p.push(sse({ choices: [{ index: 0, delta: { content: 'a' } }], usage: null })),
      ...p.push(sse({ choices: [], usage: 'lots' })),
      ...p.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { input_tokens: 5, output_tokens: 2 } })),
    ];
    assert.deepStrictEqual(ev.filter((e) => e.type === 'usage'), [{ type: 'usage', input: 5, output: 2 }]);
    assert.deepStrictEqual(p.finish().usage, { input: 5, output: 2 });
  });

  test('no usage sent gives usage null', () => {
    const p = make();
    p.push(sse({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }] }));
    assert.strictEqual(p.finish().usage, null);
  });

  test('negative or non-numeric token counts are ignored', () => {
    const p = make();
    p.push(sse({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }], usage: { prompt_tokens: -4, completion_tokens: 'x' } }));
    assert.strictEqual(p.finish().usage, null);
  });

  test('length stop with plain text is ok and truncated', () => {
    const r = feedWhole(make(), load('sse-openai-length.txt'));
    assert.strictEqual(r.outcome.ok, true);
    assert.strictEqual(r.outcome.truncated, true);
    assert.strictEqual(r.outcome.finishReason, 'length');
  });

  test('length stop inside a tool call is truncated, not bad_args', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'c1', function: { name: 'propose_add', arguments: '{"result_id":"r1","rea' } }, 'length'));
    const out = p.finish();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'truncated');
    assert.strictEqual(out.error.code, 'truncated');
    assert.strictEqual(out.truncated, true);
  });

  test('length stop after a complete tool call is ok and truncated', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'c1', function: { name: 'get_free_space', arguments: '{}' } }, 'length'));
    const out = p.finish();
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.truncated, true);
  });

  test('a non-length stop with broken args is still bad_args, truncated false', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'c1', function: { name: 'f', arguments: '{oops' } }, 'tool_calls'));
    const out = p.finish();
    assert.strictEqual(out.code, 'bad_args');
    assert.strictEqual(out.truncated, false);
  });

  test('failures carry code equal to error.code', () => {
    const p = make();
    p.push('data: nope\n\n');
    const out = p.finish();
    assert.strictEqual(out.code, 'bad_response');
    assert.strictEqual(out.code, out.error.code);
  });

  test('no-index Gemini stream: new id starts a new call, same id continues', () => {
    const p = make();
    p.push(tc({ id: 'a', function: { name: 'search_torrents', arguments: '{"query":' } }));
    p.push(tc({ id: 'a', function: { arguments: '"abc"}' } }));
    p.push(tc({ id: 'b', function: { name: 'get_free_space', arguments: '{}' } }, 'tool_calls'));
    const out = p.finish();
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.toolCalls, [
      { id: 'a', name: 'search_torrents', arguments: { query: 'abc' } },
      { id: 'b', name: 'get_free_space', arguments: {} },
    ]);
  });

  test('no index and no id: fragments append to the last open call', () => {
    const p = make();
    p.push(tc({ function: { name: 'search_torrents', arguments: '{"query":' } }));
    p.push(tc({ function: { arguments: '"abc"}' } }, 'tool_calls'));
    const out = p.finish();
    assert.deepStrictEqual(out.toolCalls, [{ id: 'call_1', name: 'search_torrents', arguments: { query: 'abc' } }]);
  });

  test('no index, no id, a second named call starts a new call with its own synthesised id', () => {
    const p = make();
    p.push(tc({ function: { name: 'get_free_space', arguments: '{}' } }));
    p.push(tc({ function: { name: 'list_transfers', arguments: '{}' } }, 'tool_calls'));
    const out = p.finish();
    assert.deepStrictEqual(out.toolCalls.map((c) => [c.id, c.name]), [['call_1', 'get_free_space'], ['call_2', 'list_transfers']]);
  });

  test('a synthesised id never collides with a real one', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } }));
    p.push(tc({ index: 1, function: { name: 'b', arguments: '{}' } }, 'tool_calls'));
    const ids = p.finish().toolCalls.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, 2, ids.join());
  });

  test('a no-index fragment before any call starts call 0', () => {
    const p = make();
    const ev = p.push(tc({ function: { arguments: '{}' } }));
    assert.strictEqual(ev[0].index, 0);
  });

  test('text over 32 KB gives too_long', () => {
    const p = make();
    const chunk = sse({ choices: [{ index: 0, delta: { content: 'x'.repeat(8 * 1024) } }] });
    const errs = [];
    for (let i = 0; i < 5; i++) errs.push(...p.push(chunk).filter((e) => e.type === 'error'));
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].error.code, 'too_long');
    const out = p.finish();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'too_long');
  });

  test('text of exactly 32 KB is accepted', () => {
    const p = make();
    p.push(sse({ choices: [{ index: 0, delta: { content: 'x'.repeat(32 * 1024) }, finish_reason: 'stop' }] }));
    assert.strictEqual(p.finish().ok, true);
  });

  test('one call over 16 KB of arguments gives too_long, even in small fragments', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":"' } }));
    let err = null;
    for (let i = 0; i < 20 && !err; i++) {
      err = p.push(tc({ index: 0, function: { arguments: 'y'.repeat(1024) } })).find((e) => e.type === 'error') ?? null;
    }
    assert.ok(err, 'cap tripped');
    assert.strictEqual(err.error.code, 'too_long');
    assert.strictEqual(p.finish().code, 'too_long');
  });

  test('the args cap is per call, not shared', () => {
    const p = make();
    p.push(tc({ index: 0, id: 'a', function: { name: 'f', arguments: '{"a":"' + 'y'.repeat(10000) + '"}' } }));
    p.push(tc({ index: 1, id: 'b', function: { name: 'f', arguments: '{"a":"' + 'y'.repeat(10000) + '"}' } }, 'tool_calls'));
    assert.strictEqual(p.finish().ok, true);
  });

  test('sse-gemini-noindex.txt gives two calls and usage', () => {
    const o = feedWhole(make(), load('sse-gemini-noindex.txt')).outcome;
    assert.strictEqual(o.ok, true);
    assert.deepStrictEqual(o.toolCalls, [
      { id: 'call_g1', name: 'search_torrents', arguments: { query: 'The Last Harbor 2023' } },
      { id: 'call_g2', name: 'get_free_space', arguments: {} },
    ]);
    assert.deepStrictEqual(o.usage, { input: 812, output: 37 });
  });

  test('sse-ollama-whole.txt gives one call with a synthesised id and a usage-only chunk', () => {
    const o = feedWhole(make(), load('sse-ollama-whole.txt')).outcome;
    assert.strictEqual(o.ok, true);
    assert.deepStrictEqual(o.toolCalls, [{ id: 'call_1', name: 'list_transfers', arguments: { filter: 'active' } }]);
    assert.deepStrictEqual(o.usage, { input: 640, output: 21 });
    assert.strictEqual(o.finishReason, 'tool_calls');
  });

  console.log('Fixtures: whole, every split point, one character at a time');

  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('sse-') && f.endsWith('.txt')).sort();
  test('fixture set covers text, one tool, parallel tools, error, length, Groq', () => {
    for (const f of ['sse-openai-text.txt', 'sse-openai-tool.txt', 'sse-openrouter-parallel.txt', 'sse-openrouter-error.txt', 'sse-openai-length.txt', 'sse-groq-parallel.txt', 'sse-gemini-noindex.txt', 'sse-ollama-whole.txt']) {
      assert.ok(fixtures.includes(f), `missing ${f}`);
    }
  });

  for (const f of fixtures) {
    const text = load(f);
    test(`${f}: split at every character boundary matches whole`, () => {
      const whole = feedWhole(make(), text);
      const splits = feedSplit2(make, text);
      splits.forEach((r, i) => {
        assert.deepStrictEqual(r.outcome, whole.outcome, `split at ${i}`);
        assert.deepStrictEqual(r.events, whole.events, `events differ at split ${i}`);
      });
    });
    test(`${f}: one character at a time matches whole`, () => {
      const whole = feedWhole(make(), text);
      const one = feedOneByOne(make, text);
      assert.deepStrictEqual(one.outcome, whole.outcome);
      assert.deepStrictEqual(one.events, whole.events);
    });
    test(`${f}: CRLF variant matches LF`, () => {
      const lf = feedWhole(make(), text);
      const crlf = feedWhole(make(), text.replace(/\n/g, '\r\n'));
      assert.deepStrictEqual(crlf.outcome, lf.outcome);
      assert.deepStrictEqual(crlf.events, lf.events);
    });
  }

  console.log('UTF-8 bytes');

  test('multi-byte text split at every byte boundary via streaming TextDecoder', () => {
    const body = 'data: {"choices":[{"index":0,"delta":{"content":"Ünï ✓ 日本 🎬"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const bytes = Buffer.from(body, 'utf8');
    const expected = feedWhole(make(), body);
    for (let i = 0; i <= bytes.length; i++) {
      const dec = new TextDecoder('utf-8');
      const p = make();
      const events = [];
      const a = dec.decode(bytes.subarray(0, i), { stream: true });
      const b = dec.decode(bytes.subarray(i), { stream: true }) + dec.decode();
      events.push(...p.push(a), ...p.push(b));
      assert.deepStrictEqual(p.finish(), expected.outcome, `byte split ${i}`);
      assert.strictEqual(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Ünï ✓ 日本 🎬');
    }
  });

  console.log('limits and error detail');

  test('a string error code and a short detail are kept for the turn machine', () => {
    const p = make();
    p.push('data: {"error":{"code":"tool_use_failed","message":"Failed to call a\\nfunction \\u0007 x"}}\n\n');
    const out = p.finish();
    assert.strictEqual(out.error.code, 'provider');
    assert.strictEqual(out.error.providerCode, 'tool_use_failed');
    assert.strictEqual(out.error.status, undefined);
    assert.strictEqual(out.error.detail, 'Failed to call a function x');
  });

  test('error detail is capped at 500 characters', () => {
    const p = make();
    p.push(`data: ${JSON.stringify({ error: { code: 400, message: 'a'.repeat(5000) } })}\n\n`);
    assert.strictEqual(p.finish().error.detail.length, 500);
  });

  test('a line with no newline past 256 KB fails with too_long instead of growing', () => {
    const p = make();
    const events = p.push('data: ' + 'x'.repeat(300 * 1024));
    assert.ok(events.some((e) => e.type === 'error' && e.error.code === 'too_long'));
    assert.strictEqual(p.finish().ok, false);
  });

  test('an open event of many small data lines past 256 KB fails with too_long', () => {
    const p = make();
    let failedAt = -1;
    for (let i = 0; i < 100; i++) {
      const ev = p.push(('data: ' + 'y'.repeat(8 * 1024) + '\n').repeat(4));
      if (ev.some((e) => e.type === 'error')) {
        failedAt = i;
        break;
      }
    }
    assert.ok(failedAt > 0 && failedAt < 20, String(failedAt));
  });

  test('keep-alive comments never grow the buffer', () => {
    const p = make();
    for (let i = 0; i < 5000; i++) p.push(': OPENROUTER PROCESSING\n\n');
    const out = p.finish();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error.code, 'incomplete');
  });

  test('more than 16 tool-call slots fail with too_long', () => {
    const p = make();
    let errored = false;
    for (let i = 0; i < 40; i++) {
      const ev = p.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: 'search_torrents', arguments: '{}' } }] } }] })}\n\n`);
      if (ev.some((e) => e.type === 'error' && e.error.code === 'too_long')) errored = true;
    }
    assert.ok(errored);
  });

  test('calls with no index get distinct slots quickly (no spread of all keys)', () => {
    const p = make();
    const t0 = Date.now();
    for (let i = 0; i < 16; i++) {
      p.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: `n${i}`, function: { name: 'search_torrents', arguments: '{}' } }] } }] })}\n\n`);
    }
    p.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    const out = p.finish();
    assert.ok(out.ok && out.toolCalls.length === 16, JSON.stringify(out).slice(0, 200));
    assert.ok(Date.now() - t0 < 500);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
