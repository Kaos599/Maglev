#!/usr/bin/env node
// Haptics are a small vocabulary (constants/haptics.ts). Every call site uses a verb, nothing
// else touches expo-haptics, and nothing buzzes from an effect without a user action behind it.
// Grep-level checks over the TypeScript source. Needs no TS loader.

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

const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'native', 'dist', '.expo']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

const hapticsSrc = fs.readFileSync(path.join(root, 'constants/haptics.ts'), 'utf8');
const m = /export const HAPTIC_VERBS = \[([^\]]*)\]/.exec(hapticsSrc);
const verbs = m ? [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]) : [];
check('vocabulary is select, tap, commit, done, warn, fail', verbs.join(',') === 'select,tap,commit,done,warn,fail', verbs.join(','));
check('header documents every verb', verbs.every((v) => new RegExp(`\\b${v}\\b`).test(hapticsSrc.split('export')[0])));
check('raw triggerHaptic is gone from constants/haptics.ts', !/triggerHaptic/.test(hapticsSrc));

const files = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'components')), ...walk(path.join(root, 'context')), ...walk(path.join(root, 'utils')), ...walk(path.join(root, 'modules/maglev-engine/src'))];

const rawImports = files.filter((f) => /from\s+['"]expo-haptics['"]|require\(['"]expo-haptics['"]\)/.test(fs.readFileSync(f, 'utf8'))).map(rel);
check('no expo-haptics import outside constants/haptics.ts', rawImports.length === 0, rawImports.join(', '));

const oldApi = files.filter((f) => /triggerHaptic/.test(fs.readFileSync(f, 'utf8'))).map(rel);
check('no triggerHaptic call sites remain', oldApi.length === 0, oldApi.join(', '));

/** Index of the paren that closes the one opened at `open`. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return src.length;
}

let calls = 0;
const badVerb = [];
const inEffect = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/constants\/haptics['"]/.test(src)) continue;
  for (const c of src.matchAll(/\bhaptic\(\s*([^)]*?)\s*\)/g)) {
    calls++;
    const arg = c[1];
    const lits = [...arg.matchAll(/'(\w+)'/g)].map((x) => x[1]);
    if (lits.length ? !lits.every((v) => verbs.includes(v)) : !/^[\w.\[\]]+$/.test(arg)) badVerb.push(`${rel(f)}: haptic(${arg})`);
  }
  for (const e of src.matchAll(/useEffect\(/g)) {
    const open = e.index + 'useEffect'.length;
    const body = src.slice(open, closeParen(src, open));
    if (/\bhaptic\(/.test(body)) inEffect.push(rel(f));
  }
}
check('haptic() is called with a vocabulary verb', badVerb.length === 0, badVerb.join('; '));
check('there are haptic call sites to check', calls > 10, String(calls));
check('no haptic inside useEffect', inEffect.length === 0, inEffect.join(', '));

// Components that take a haptic option take a verb or false, never a boolean true.
const press = fs.readFileSync(path.join(root, 'components/ui/PressableScale.tsx'), 'utf8');
check('PressableScale is silent by default', /haptic\?: HapticVerb \| false/.test(press) && /haptic = false/.test(press));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll haptics checks passed.');
