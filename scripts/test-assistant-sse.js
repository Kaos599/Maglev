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
  const { createStreamParser } = await import('../utils/assistant/sse.ts');
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

  test('a call with no id or no name gives bad_response', () => {
    const p = make();
    p.push('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    assert.strictEqual(p.finish().error.code, 'bad_response');
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

  console.log('Fixtures: whole, every split point, one character at a time');

  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('sse-') && f.endsWith('.txt')).sort();
  test('fixture set covers text, one tool, parallel tools, error, length, Groq', () => {
    for (const f of ['sse-openai-text.txt', 'sse-openai-tool.txt', 'sse-openrouter-parallel.txt', 'sse-openrouter-error.txt', 'sse-openai-length.txt', 'sse-groq-parallel.txt']) {
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
