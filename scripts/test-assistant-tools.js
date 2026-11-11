#!/usr/bin/env node
// Tool schemas and argument validation (SM-31 amendment, ASSISTANT_DESIGN §4, §7.3).
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

const HASH = 'b3f1c0de9a8b7c6d5e4f30112233445566778899';
const REASON = 'One plain sentence.';

// A valid call for every tool, using handles issued by the registry below.
function samples(R, T) {
  return {
    search_torrents: { query: 'The Last Harbor 2023', category: 'movies', max_size_gb: 5, limit: 6 },
    get_result_details: { result_id: R },
    parse_release_name: { names: ['The.Last.Harbor.2023.1080p.WEB-DL.DDP5.1.Atmos.H.265-LUMEN'] },
    get_free_space: {},
    list_transfers: { filter: 'active' },
    get_transfer_details: { transfer_id: T, include_files: true },
    explain_error: { transfer_id: T },
    propose_add: { result_id: R, file_indices: [0, 1], first_indices: [0], sequential: false, reason: REASON },
    propose_select_files: { transfer_id: T, include: [3, 4], skip: [0], reason: REASON },
    propose_pause_resume: { transfer_id: T, action: 'pause', reason: REASON },
    propose_remove_files: { transfer_id: T, file_indices: [0, 1, 2], reason: REASON },
    propose_delete: { transfer_id: T, delete_files: false, reason: REASON },
    propose_plan: {
      reason: REASON,
      steps: [{ tool: 'propose_pause_resume', args: { transfer_id: T, action: 'pause', reason: REASON } }],
    },
  };
}

function isObjectSchema(s) {
  return s && typeof s === 'object' && s.type === 'object';
}

// Every object schema, at any depth, must be closed and list its required keys among its properties.
function checkClosed(schema, where, problems) {
  if (!schema || typeof schema !== 'object') return;
  if (isObjectSchema(schema)) {
    if (!schema.properties || typeof schema.properties !== 'object') problems.push(`${where}: no properties`);
    if (schema.additionalProperties !== false) problems.push(`${where}: additionalProperties is not false`);
    if (!Array.isArray(schema.required)) problems.push(`${where}: required is not an array`);
    for (const r of schema.required ?? []) {
      if (!(r in (schema.properties ?? {}))) problems.push(`${where}: required "${r}" is not a property`);
    }
    for (const [k, v] of Object.entries(schema.properties ?? {})) checkClosed(v, `${where}.${k}`, problems);
  }
  if (schema.items) checkClosed(schema.items, `${where}[]`, problems);
}

async function main() {
  const { TOOLS, READ_TOOLS, PROPOSAL_TOOLS, DESTRUCTIVE_TOOLS, validateArgs } = await import('../utils/assistant/tools.ts');
  const { HandleRegistry } = await import('../utils/assistant/handles.ts');

  const reg = new HandleRegistry();
  const R = reg.issue('result', HASH);
  const T = reg.issue('transfer', 42);
  const S = samples(R, T);
  const bad = (name, args) => validateArgs(name, args, reg);
  const isBad = (r, code = 'bad_args') => !r.ok && r.error.code === code;

  console.log('tools: schema structure');
  check('TOOLS has 13 entries', TOOLS.length === 13, TOOLS.length);
  check('READ_TOOLS has the 7 read tools', READ_TOOLS.size === 7, [...READ_TOOLS]);
  check('PROPOSAL_TOOLS has the 6 proposal tools', PROPOSAL_TOOLS.size === 6, [...PROPOSAL_TOOLS]);
  check('READ and PROPOSAL cover TOOLS exactly', TOOLS.every((t) => READ_TOOLS.has(t.function.name) || PROPOSAL_TOOLS.has(t.function.name)));
  const names = TOOLS.map((t) => t.function.name);
  check('tool names are unique', new Set(names).size === names.length, names);
  for (const t of TOOLS) {
    const n = t.function.name;
    check(`${n}: wrapper is a function`, t.type === 'function' && typeof t.function.description === 'string');
    const p = t.function.parameters;
    check(`${n}: parameters are an object schema`, isObjectSchema(p));
    const problems = [];
    checkClosed(p, n, problems);
    check(`${n}: closed, required ⊆ properties at every depth`, problems.length === 0, problems);
    check(`${n}: description is short plain text`, t.function.description.length > 20 && t.function.description.length < 300);
  }

  console.log('tools: wording');
  const all = JSON.stringify(TOOLS);
  check('no tool text mentions adult content', !/adult|nsfw|porn/i.test(all));
  check('search_torrents category has no adult value', !TOOLS[0].function.parameters.properties.category.enum.includes('adult'));

  console.log('tools: unknown tool');
  check('unknown tool gives unknown_tool', isBad(bad('launch_missiles', {}), 'unknown_tool'));
  check('prototype name gives unknown_tool', isBad(bad('constructor', {}), 'unknown_tool'));

  console.log('tools: valid calls resolve handles');
  for (const name of Object.keys(S)) {
    if (name === 'propose_plan') continue;
    const r = bad(name, S[name]);
    check(`${name}: valid call is accepted`, r.ok === true, r.ok ? undefined : r.error);
  }
  const addOk = bad('propose_add', S.propose_add);
  check('propose_add resolves r1 to the real id', addOk.ok && addOk.args.result_id === HASH, addOk);
  const pauseOk = bad('propose_pause_resume', S.propose_pause_resume);
  check('propose_pause_resume resolves t1 to the numeric id', pauseOk.ok && pauseOk.args.transfer_id === 42, pauseOk);
  const jsonOk = bad('propose_add', JSON.stringify(S.propose_add));
  check('JSON string arguments are accepted', jsonOk.ok && jsonOk.args.result_id === HASH);
  const planOk = bad('propose_plan', S.propose_plan);
  check('plan resolves step handles', planOk.ok && planOk.args.steps[0].args.transfer_id === 42, planOk);

  console.log('tools: unknown keys rejected per tool');
  for (const name of Object.keys(S)) {
    const r = bad(name, { ...S[name], not_a_field: 1 });
    check(`${name}: unknown key gives bad_args`, isBad(r), r.ok ? 'accepted' : r.error.message);
  }
  const planStepExtra = bad('propose_plan', {
    reason: REASON,
    steps: [{ tool: 'propose_pause_resume', args: { transfer_id: T, action: 'pause', reason: REASON, file_indices: [1] } }],
  });
  check('plan step with a field its tool does not take is rejected', isBad(planStepExtra));

  console.log('tools: bad, hash-like and wrong-kind handles');
  check('unknown result handle gives bad_args', isBad(bad('propose_add', { result_id: 'r99', reason: REASON })));
  check('unknown transfer handle gives bad_args', isBad(bad('explain_error', { transfer_id: 't99' })));
  check('hash-like result id gives bad_args', isBad(bad('propose_add', { result_id: HASH, reason: REASON })));
  check('magnet text as result id gives bad_args', isBad(bad('get_result_details', { result_id: `magnet:?xt=urn:btih:${HASH}` })));
  check('hash as transfer id gives bad_args', isBad(bad('get_transfer_details', { transfer_id: HASH })));
  check('transfer handle given as result gives bad_args', isBad(bad('propose_add', { result_id: 't1', reason: REASON })));
  check('result handle given as transfer gives bad_args', isBad(bad('propose_remove_files', { transfer_id: 'r1', file_indices: [0], reason: REASON })));
  check('handle with leading zero gives bad_args', isBad(bad('explain_error', { transfer_id: 't01' })));
  check('numeric handle gives bad_args', isBad(bad('explain_error', { transfer_id: 1 })));
  const hashMsg = bad('propose_add', { result_id: HASH, reason: REASON });
  check('error message never echoes the hash', !hashMsg.ok && !hashMsg.error.message.includes(HASH));
  const unknownMsg = bad('explain_error', { transfer_id: 't99' });
  check('handle error is plain English', !unknownMsg.ok && unknownMsg.error.message.length > 10);

  console.log('tools: types, enums and ranges');
  check('string where number expected gives bad_args', isBad(bad('search_torrents', { query: 'abc', max_size_gb: '5' })));
  check('fraction where integer expected gives bad_args', isBad(bad('search_torrents', { query: 'abc', limit: 2.5 })));
  check('limit above 8 gives bad_args', isBad(bad('search_torrents', { query: 'abc', limit: 9 })));
  check('adult category gives bad_args', isBad(bad('search_torrents', { query: 'abc', category: 'adult' })));
  check('resolution 4320 gives bad_args', isBad(bad('search_torrents', { query: 'abc', max_resolution: 4320 })));
  check('min resolution above max gives bad_args', isBad(bad('search_torrents', { query: 'abc', min_resolution: 1080, max_resolution: 720 })));
  check('bad action enum gives bad_args', isBad(bad('propose_pause_resume', { transfer_id: 't1', action: 'delete', reason: REASON })));
  check('boolean as string gives bad_args', isBad(bad('propose_delete', { transfer_id: 't1', delete_files: 'yes', reason: REASON })));
  check('missing required reason gives bad_args', isBad(bad('propose_add', { result_id: 'r1' })));
  check('missing required query gives bad_args', isBad(bad('search_torrents', { category: 'movies' })));
  check('negative file index gives bad_args', isBad(bad('propose_remove_files', { transfer_id: 't1', file_indices: [-1], reason: REASON })));
  check('duplicate file indices give bad_args', isBad(bad('propose_remove_files', { transfer_id: 't1', file_indices: [1, 1], reason: REASON })));
  check('remove with no files gives bad_args', isBad(bad('propose_remove_files', { transfer_id: 't1', file_indices: [], reason: REASON })));
  check('reason over 200 chars gives bad_args', isBad(bad('propose_delete', { transfer_id: 't1', reason: 'x'.repeat(201) })));
  check('non-object arguments give bad_args', isBad(bad('get_free_space', [])));
  check('invalid JSON string gives bad_args', isBad(bad('get_free_space', '{not json')));
  check('null arguments give bad_args', isBad(bad('get_free_space', null)));
  check('no-argument tool accepts an empty object', bad('get_free_space', {}).ok === true);

  console.log('tools: search query length');
  check('80-character query is accepted', bad('search_torrents', { query: 'q'.repeat(80) }).ok === true);
  check('81-character query gives bad_args', isBad(bad('search_torrents', { query: 'q'.repeat(81) })));
  check('single character query gives bad_args', isBad(bad('search_torrents', { query: 'a' })));
  check('query length counts code points, not UTF-16 units', bad('search_torrents', { query: '😀'.repeat(80) }).ok === true);

  console.log('tools: file index rules');
  check('first_indices outside file_indices gives bad_args', isBad(bad('propose_add', { result_id: 'r1', file_indices: [0, 1], first_indices: [2], reason: REASON })));
  check('first_indices inside file_indices is accepted', bad('propose_add', { result_id: 'r1', file_indices: [0, 1], first_indices: [1], reason: REASON }).ok === true);
  check('select with nothing to include or skip gives bad_args', isBad(bad('propose_select_files', { transfer_id: 't1', reason: REASON })));
  check('file both included and skipped gives bad_args', isBad(bad('propose_select_files', { transfer_id: 't1', include: [1], skip: [1], reason: REASON })));

  console.log('tools: removed tools (R1-1) and plans (R1-2)');
  check('propose_url_download is gone', isBad(bad('propose_url_download', { url: 'https://example.com/a', reason: REASON }), 'unknown_tool'));
  check('propose_setting_change is gone', isBad(bad('propose_setting_change', { key: 'wifi_only', value: true, reason: REASON }), 'unknown_tool'));
  check('no tool definition mentions the removed tools', !/url_download|setting_change/.test(JSON.stringify(TOOLS)));
  check('DESTRUCTIVE_TOOLS is delete and remove_files', DESTRUCTIVE_TOOLS.size === 2 && DESTRUCTIVE_TOOLS.has('propose_delete') && DESTRUCTIVE_TOOLS.has('propose_remove_files'), [...DESTRUCTIVE_TOOLS]);
  check('destructive tools are proposal tools', [...DESTRUCTIVE_TOOLS].every((n) => PROPOSAL_TOOLS.has(n)));
  const planDesc = TOOLS.find((t) => t.function.name === 'propose_plan').function.description;
  check('plan description says steps are independent', /independent/.test(planDesc) && /cannot refer to a download created by an earlier step/.test(planDesc), planDesc);
  const stepEnum = TOOLS.find((t) => t.function.name === 'propose_plan').function.parameters.properties.steps.items.properties.tool.enum;
  check('plan step enum is add, select_files, pause_resume', JSON.stringify([...stepEnum].sort()) === JSON.stringify(['propose_add', 'propose_pause_resume', 'propose_select_files']), stepEnum);
  const addStep = { tool: 'propose_add', args: { result_id: R, reason: REASON } };
  const selStep = { tool: 'propose_select_files', args: { transfer_id: T, include: [1], reason: REASON } };
  check('plan of add + select + pause is accepted', bad('propose_plan', { reason: REASON, steps: [addStep, selStep, { tool: 'propose_pause_resume', args: { transfer_id: T, action: 'pause', reason: REASON } }] }).ok === true);
  check('plan with a delete step gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_delete', args: { transfer_id: T, reason: REASON } }] })));
  check('plan with a remove_files step gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_remove_files', args: { transfer_id: T, file_indices: [0], reason: REASON } }] })));
  check('plan with a removed-tool step gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_url_download', args: { url: 'https://a.b/c', reason: REASON } }] })));
  check('delete step is blocked even when hidden in step 2', isBad(bad('propose_plan', { reason: REASON, steps: [addStep, { tool: 'propose_delete', args: { transfer_id: T, delete_files: true, reason: REASON } }] })));

  const step = { tool: 'propose_pause_resume', args: { transfer_id: T, action: 'pause', reason: REASON } };
  const planOfSix = Array.from({ length: 6 }, () => step);
  check('plan with 6 steps is accepted', bad('propose_plan', { reason: REASON, steps: planOfSix }).ok === true);
  check('plan with 7 steps gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [...planOfSix, step] })));
  check('plan with 0 steps gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [] })));
  check('plan step that is a read tool gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'search_torrents', args: { query: 'abc' } }] })));
  check('plan step that is a plan gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_plan', args: { reason: REASON, steps: [step] } }] })));
  check('plan step with a bad handle gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_pause_resume', args: { transfer_id: 'r1', action: 'pause', reason: REASON } }] })));
  check('plan step missing its args gives bad_args', isBad(bad('propose_plan', { reason: REASON, steps: [{ tool: 'propose_pause_resume' }] })));
  const badStepMsg = bad('propose_plan', { reason: REASON, steps: [step, { tool: 'propose_pause_resume', args: { transfer_id: 't99', action: 'pause', reason: REASON } }] });
  check('plan error names the failing step', !badStepMsg.ok && badStepMsg.error.message.startsWith('Step 2:'), badStepMsg);

  console.log('handles: hash-keyed results (R1-11 / handles.ts)');
  {
    const h = new HandleRegistry();
    const a = h.issue('result', HASH);
    check('issuing the same info hash twice gives the same handle', h.issue('result', HASH) === a && h.size === 1);
    const b = h.issue('result', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check('a different hash gets the next handle', a === 'r1' && b === 'r2');
    check('a transfer with the same text is a different handle', h.issue('transfer', HASH) === 't1');
    check('resolve gives the hash back for the right kind only', h.resolve('r1', 'result') === HASH && h.resolve('r1', 'transfer') === null);
    check('handleFor finds the handle by hash', h.handleFor('result', HASH) === 'r1');
    h.clearKind('result');
    check('clearKind drops result handles only', h.resolve('r1') === null && h.resolve('t1', 'transfer') === HASH && h.size === 1);
    check('clearKind restarts that counter', h.issue('result', HASH) === 'r1');
    check('clearKind leaves the other counters alone', h.issue('transfer', 'zzz') === 't2');
    check('after clearKind a stale handle no longer validates', !validateArgs('get_result_details', { result_id: 'r2' }, h).ok);
  }

  console.log();
  if (failed) {
    console.error(`${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`assistant tools tests passed (${passed})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
