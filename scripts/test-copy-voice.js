#!/usr/bin/env node
// One voice for notices, banners and empty states (rules in the header of constants/copy.ts).
// Lints every string exported from constants/copy.ts, then checks the call sites read from it.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const words = (s) => s.trim().split(/\s+/).filter(Boolean);

/** Collects { path, kind, text } for every string under a group, calling functions with a sample. */
function collect(node, trail, kind, out) {
  if (typeof node === 'function') return collect(node('3', '3', '3'), trail, kind, out);
  if (typeof node === 'string') {
    out.push({ path: trail.join('.'), kind, text: node });
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const next = [...trail, k];
    // title and body keys decide the kind inside banners and empty states.
    const sub = k === 'title' || k === 'body' ? `${kind}.${k}` : kind;
    collect(v, next, sub, out);
  }
}

function universalProblems(text, acronyms, proper, glossary) {
  const p = [];
  if (/!/.test(text)) p.push('has "!"');
  if (/successfully/i.test(text)) p.push('says "successfully"');
  if (/\b(oops|uh[ -]?oh)\b/i.test(text)) p.push('says oops/uh oh');
  if (/^\s*error\s*:/i.test(text)) p.push('starts with "Error:"');
  if (/\p{Extended_Pictographic}/u.test(text)) p.push('has an emoji');
  if (/…|\.\.\./.test(text)) p.push('has an ellipsis');
  if (/\b(could not|cannot|please)\b|^(unable to|failed to)\b/i.test(text)) p.push('uses a banned phrase (use Couldn\'t / Can\'t, no please)');
  if (/\s{2,}/.test(text) || text !== text.trim()) p.push('has stray spaces');
  if (!/^[A-Z.0-9]/.test(text)) p.push('does not start with a capital');
  const noQuotes = text.replace(/"[^"]*"/g, '');
  for (const w of noQuotes.match(/[A-Za-z][A-Za-z'-]*/g) ?? []) {
    if (w.length > 1 && w === w.toUpperCase() && /[A-Z]{2}/.test(w) && !acronyms.includes(w)) p.push(`ALL CAPS word "${w}"`);
  }
  // Sentence case: after the first word of a sentence, no capitalised word unless it is a proper word.
  for (const sentence of noQuotes.split(/(?<=[.?])\s+/)) {
    for (const w of words(sentence).slice(1)) {
      const bare = w.replace(/[^A-Za-z'-]/g, '');
      if (/^[A-Z][a-z]/.test(bare) && !proper.includes(bare)) p.push(`Title Case word "${bare}"`);
    }
  }
  for (const [term, g] of Object.entries(glossary)) {
    for (const re of g.avoid) if (re.test(text)) p.push(`glossary: use "${g.use}" (matched ${re})`);
  }
  return p;
}

async function main() {
  const copy = await import('../constants/copy.ts');
  const { notices, banners, empty, glossary, ACRONYMS, PROPER_WORDS } = copy;

  const items = [];
  collect(notices, ['notices'], 'notice', items);
  collect(banners, ['banners'], 'banner', items);
  collect(empty, ['empty'], 'empty', items);
  // Font setting descriptions follow the banner body rules (16 words, ends with a period).
  for (const o of copy.fontStyleCopy.options) collect(o.description, ['fontStyleCopy', o.value], 'banner.body', items);
  // In-app updates (contract 27): notices and hints follow the notice and banner body rules.
  collect(copy.updateCopy.notices, ['updateCopy', 'notices'], 'notice', items);
  collect(copy.updateCopy.hints, ['updateCopy', 'hints'], 'banner.body', items);
  for (const m of copy.updateCopy.modes) collect(m.description, ['updateCopy', 'modes', m.value], 'banner.body', items);
  // Self-updating lists (contract 31): sentences follow the banner body rules, row values the universal rules.
  collect(copy.listsCopy.hints, ['listsCopy', 'hints'], 'banner.body', items);
  collect(copy.listsCopy.values, ['listsCopy', 'values'], 'value', items);
  collect(copy.listsCopy.providers, ['listsCopy', 'providers'], 'value', items);
  collect(copy.listsCopy.browser, ['listsCopy', 'browser'], 'notice', items);
  check('copy.ts exports strings to lint', items.length > 60, String(items.length));

  const problems = [];
  for (const it of items) {
    const prob = universalProblems(it.text, ACRONYMS, PROPER_WORDS, glossary);
    const n = words(it.text).length;
    const endsPeriod = /\.$/.test(it.text);
    switch (it.kind) {
      case 'notice':
        if (n > 12) prob.push(`${n} words, max 12`);
        if (!endsPeriod) prob.push('does not end with a period');
        break;
      case 'banner.title':
      case 'empty.title':
        if (n > (it.kind === 'banner.title' ? 8 : 5)) prob.push(`${n} words, max ${it.kind === 'banner.title' ? 8 : 5}`);
        if (endsPeriod) prob.push('title ends with a period');
        break;
      case 'banner.body':
      case 'empty.body':
        if (n > 16) prob.push(`${n} words, max 16`);
        if (!endsPeriod) prob.push('does not end with a period');
        break;
      default:
        // A bare string inside empty (a body variant) follows the body rules.
        if (it.kind === 'empty') {
          if (n > 16) prob.push(`${n} words, max 16`);
          if (!endsPeriod) prob.push('does not end with a period');
        }
    }
    for (const x of prob) problems.push(`${it.path}: ${x} -> "${it.text}"`);
  }
  check('every copy.ts string follows the voice rules', problems.length === 0, '\n    ' + problems.join('\n    '));

  const emptyBlocks = items.filter((i) => i.kind === 'empty.title');
  const noBody = [];
  for (const group of Object.values(empty)) {
    for (const [k, v] of Object.entries(group)) {
      const r = typeof v === 'function' ? v('3') : v;
      if (r && typeof r === 'object' && r.title && !r.body) noBody.push(k);
    }
  }
  check('empty titles exist', emptyBlocks.length > 10);
  // Empty states without a body here get one from the engine at run time (an error message).
  check('only run-time-body empty states omit a body', noBody.every((k) => ['timedOut', 'readFailed', 'waitingForNetwork', 'deviceOnNetwork', 'badLink', 'loadFailed'].includes(k)), noBody.join(', '));

  // ---- call sites ----
  const SKIP = new Set(['node_modules', '.git']);
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'components')), ...walk(path.join(root, 'context'))];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  /** Source of the balanced (...) or <.../> starting at `from`. */
  function balanced(src, from, open, close) {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close && --depth === 0) return src.slice(from, i + 1);
    }
    return src.slice(from);
  }
  const hasLiteral = (s) => /(['"`])(?:(?!\1)[^\\]|\\.)*[A-Za-z](?:(?!\1)[^\\]|\\.)*\1/.test(s);

  const noticeLiterals = [];
  const emptyLiterals = [];
  const bannerLiterals = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // showNotice( ... ) calls, not the declaration or the type.
    for (const m of src.matchAll(/\bshowNotice\(/g)) {
      const before = src.slice(Math.max(0, m.index - 16), m.index);
      if (/(?:const|function)\s+$/.test(before)) continue;
      const call = balanced(src, m.index + 'showNotice'.length, '(', ')');
      // Only the text/message values count: strip the tone and other short keys first.
      const body = call.replace(/\b(?:tone|actionLabel)\s*:\s*'[^']*'/g, '');
      if (/\b(?:message|text)\s*:\s*(?:['"`]|[^,}]*\?\s*['"`])/.test(body) || /\?\s*\{[^}]*(?:message|text)\s*:\s*['"`]/.test(body)) {
        noticeLiterals.push(`${rel(f)}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    for (const m of src.matchAll(/<EmptyBlock\b/g)) {
      const tag = balanced(src, m.index, '<', '>');
      // Walk to the end of the opening tag, treating {...} as nested.
      let depth = 0, end = m.index;
      for (let i = m.index; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        else if (depth === 0 && src[i] === '>' ) { end = i; break; }
      }
      const open = src.slice(m.index, end + 1);
      void tag;
      if (/\b(?:title|body)=["']/.test(open) || /\b(?:title|body)=\{\s*[`'"]/.test(open)) emptyLiterals.push(`${rel(f)}: ${open.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    for (const m of src.matchAll(/<Banner\b/g)) {
      let depth = 0, end = m.index;
      for (let i = m.index; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        else if (depth === 0 && src[i] === '>') { end = i; break; }
      }
      const open = src.slice(m.index, end + 1);
      if (/\b(?:title|body)=["']/.test(open) || /\b(?:title|body)=\{\s*[`'"]/.test(open)) bannerLiterals.push(`${rel(f)}: ${open.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  check('showNotice never gets an inline string', noticeLiterals.length === 0, '\n    ' + noticeLiterals.join('\n    '));
  check('EmptyBlock title and body never inline strings', emptyLiterals.length === 0, '\n    ' + emptyLiterals.join('\n    '));
  check('Banner title and body never inline strings', bannerLiterals.length === 0, '\n    ' + bannerLiterals.join('\n    '));

  const teaching = fs.readFileSync(path.join(root, 'components/transfers/TeachingEmptyState.tsx'), 'utf8');
  check('TeachingEmptyState reads its words from copy.ts', /constants\/copy/.test(teaching) && !/>\s*\n\s*Paste a magnet/.test(teaching));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll copy voice checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
