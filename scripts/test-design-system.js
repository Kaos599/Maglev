#!/usr/bin/env node
// Design-system checks. Keeps the code honest to DESIGN.md and DESIGN.md honest to the code.
// Plain node, no dependencies. Run: node scripts/test-design-system.js
// Override the scanned root with MAGLEV_ROOT=<dir> (used to prove the checks fail on a bad copy).

const fs = require('fs');
const path = require('path');

const root = process.env.MAGLEV_ROOT ? path.resolve(process.env.MAGLEV_ROOT) : path.join(__dirname, '..');
let failed = 0;

function check(name, problems) {
  if (problems.length === 0) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed++;
  console.error(`  FAIL ${name}`);
  for (const p of problems.slice(0, 40)) console.error(`       ${p}`);
  if (problems.length > 40) console.error(`       ... and ${problems.length - 40} more`);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
const isGenerated = (r) => /\.generated\.tsx?$/.test(r);
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

function scan(dirs, { skip = () => false, test }) {
  const hits = [];
  for (const d of dirs) {
    for (const f of walk(path.join(root, d))) {
      const r = rel(f);
      if (isGenerated(r) || skip(r)) continue;
      read(f).split('\n').forEach((line, i) => {
        if (isCommentLine(line)) return;
        const msg = test(line, r);
        if (msg) hits.push(`${r}:${i + 1}  ${msg}  ${line.trim().slice(0, 80)}`);
      });
    }
  }
  return hits;
}

// Allowlist. Each entry says why it is there.
const ALLOW = {
  // ErrorScreen is the crash fallback. It renders outside the providers, with no custom fonts loaded,
  // so its two fontWeight uses sit on system text, where fontWeight works.
  // TODO: give it the Inter faces if the fallback ever loads fonts.
  fontWeight: new Set(['components/ErrorScreen.tsx']),
};

// ---------------------------------------------------------------------------------------------
console.log('Colours come from the theme');
check(
  'no hex or rgb/rgba/hsl literals in app, components, context, utils (constants/ and components/brand/ excluded)',
  scan(['app', 'components', 'context', 'utils'], {
    skip: (r) => r.startsWith('components/brand/'),
    test: (line) => {
      if (/['"`]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})['"`]/.test(line)) return 'hex colour';
      if (/['"`]\s*(rgba?|hsla?)\(/.test(line)) return 'rgb/hsl colour';
      return null;
    },
  }),
);

console.log('Fonts');
check(
  "no fontFamily: 'monospace' anywhere",
  scan(['app', 'components', 'context', 'utils', 'constants'], {
    test: (line) => (/fontFamily\s*:\s*['"]monospace['"]/.test(line) ? "fontFamily 'monospace'" : null),
  }),
);
check(
  'no fontWeight in app/ components/ (custom faces have no synthetic bold; use the Bold/SemiBold slot)',
  scan(['app', 'components'], {
    skip: (r) => ALLOW.fontWeight.has(r),
    test: (line) => (/\bfontWeight\s*:/.test(line) ? 'fontWeight' : null),
  }),
);

console.log('Flat surfaces');
check(
  'no shadow* or elevation style keys in app/ components/',
  scan(['app', 'components'], {
    test: (line) => (/\b(shadowColor|shadowOffset|shadowOpacity|shadowRadius|elevation)\s*:/.test(line) ? 'shadow/elevation' : null),
  }),
);

console.log('One icon family');
check(
  'no other icon libraries imported in app/ components/ context/',
  scan(['app', 'components', 'context'], {
    test: (line) =>
      /(from\s+|require\()\s*['"](@expo\/vector-icons|react-native-vector-icons|lucide[\w-]*|@tabler\/icons[\w-]*|react-native-heroicons|@fortawesome\/[\w-]+|phosphor-react-native)/.test(line)
        ? 'other icon library'
        : null,
  }),
);

// ---------------------------------------------------------------------------------------------
console.log('DESIGN.md matches the code');
const designPath = path.join(root, 'DESIGN.md');
const design = fs.existsSync(designPath) ? read(designPath) : '';
check('DESIGN.md exists', design ? [] : ['DESIGN.md is missing']);

function parseKeys(src, name) {
  // `export const spacing = { xs: 4, ... }` -> { xs: 4, ... }
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const kv = part.split(':').map((s) => s.trim());
    if (kv.length === 2 && kv[0]) out[kv[0]] = Number(kv[1]);
  }
  return out;
}

if (design) {
  const theme = read(path.join(root, 'constants/theme.ts'));
  const fontStyles = read(path.join(root, 'constants/fontStyles.ts'));
  const spacing = parseKeys(theme, 'spacing');
  const radius = parseKeys(theme, 'radius');

  // ThemeColors keys
  const ifaceBody = theme.match(/export interface ThemeColors\s*\{([\s\S]*?)\n\}/)[1];
  const colorKeys = new Set([...ifaceBody.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]));

  const colorProblems = [];
  for (const m of design.matchAll(/\bcolors\.(\w+)/g)) {
    if (!colorKeys.has(m[1])) colorProblems.push(`colors.${m[1]} is not in ThemeColors`);
  }
  check('every colors.<role> in DESIGN.md exists in ThemeColors', [...new Set(colorProblems)]);

  // Every role has a row in the colour table.
  const missingRoles = [...colorKeys].filter((k) => !new RegExp(`\\|\\s*\`${k}\`\\s*\\|`).test(design));
  check('every ThemeColors role has a row in the DESIGN.md colour table', missingRoles.map((k) => `no row for ${k}`));

  // Oled values in the colour table.
  const oledMatch = theme.match(/oled:\s*\{([\s\S]*?)\},\s*\n\s*dim:/);
  const oled = {};
  if (oledMatch) for (const m of oledMatch[1].matchAll(/(\w+):\s*'([^']+)'/g)) oled[m[1]] = m[2];
  // accent-derived roles under the default (lime) accent
  const lime = theme.match(/lime:\s*\{\s*bright:\s*'([^']+)'/);
  if (lime) {
    oled.accent = lime[1];
    oled.accentText = lime[1];
  }
  const valueProblems = [];
  for (const m of design.matchAll(/^\|\s*`(\w+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`/gm)) {
    const want = oled[m[1]];
    if (want && want.toLowerCase() !== m[2].toLowerCase()) valueProblems.push(`${m[1]}: DESIGN.md says ${m[2]}, theme.ts oled is ${want}`);
  }
  check('oled colour values in DESIGN.md equal constants/theme.ts', valueProblems);

  // Spacing and radius: keys exist, printed values match.
  function scaleCheck(label, scale, tableName) {
    const problems = [];
    if (!scale) return [`could not parse ${label} from theme.ts`];
    for (const m of design.matchAll(new RegExp(`\\b${tableName}\\.(\\w+)(?:\\s*\\(\\s*(\\d+)\\s*\\))?`, 'g'))) {
      if (!(m[1] in scale)) problems.push(`${tableName}.${m[1]} is not in theme.ts`);
      else if (m[2] !== undefined && Number(m[2]) !== scale[m[1]]) problems.push(`${tableName}.${m[1]}: DESIGN.md says ${m[2]}, code is ${scale[m[1]]}`);
    }
    // Every key appears in the scale table with its value: | `key` | value |
    for (const [k, v] of Object.entries(scale)) {
      const row = design.match(new RegExp(`^\\|\\s*\`${tableName}\\.${k}\`\\s*\\|\\s*(\\d+)\\s*\\|`, 'm'));
      if (!row) problems.push(`no table row for ${tableName}.${k}`);
      else if (Number(row[1]) !== v) problems.push(`${tableName}.${k}: table says ${row[1]}, code is ${v}`);
    }
    return problems;
  }
  check('spacing keys and values in DESIGN.md equal theme.ts', scaleCheck('spacing', spacing, 'spacing'));
  check('radius keys and values in DESIGN.md equal theme.ts', scaleCheck('radius', radius, 'radius'));

  // Type slots
  const slots = [...fontStyles.matchAll(/export const FONT_SLOTS = \[([^\]]*)\]/g)][0][1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
  const slotProblems = [];
  for (const m of design.matchAll(/\btype\.(\w+)/g)) {
    const ok = slots.includes(m[1]) || ['size', 'family', 'slotAdvance'].includes(m[1]);
    if (!ok) slotProblems.push(`type.${m[1]} is not a slot in theme.ts`);
  }
  for (const s of slots) if (!new RegExp(`type\\.${s}\\b`).test(design)) slotProblems.push(`type.${s} is not mentioned`);
  check('every type slot in DESIGN.md exists, and every slot is mentioned', [...new Set(slotProblems)]);

  // Components
  const index = read(path.join(root, 'components/ui/index.ts'));
  const exported = [...index.matchAll(/^export \{ ([^}]+) \} from/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  check(
    'every export of components/ui/index.ts is mentioned in DESIGN.md',
    exported.filter((n) => !new RegExp(`\\b${n}\\b`).test(design)).map((n) => `${n} is not mentioned`),
  );
}

// ---------------------------------------------------------------------------------------------
console.log('Live fonts and one motion set');

// `type.*` reads the current font style at call time. A style built at module level freezes the font style from
// app start, so it ignores a live Clean/Retro/Mono switch. Split a file into top-level statements and flag any
// `const x = ...` that evaluates `type.` at load (a function or arrow before the `type.` runs per call: fine).
function topLevelStatements(source) {
  // Blank out comments (keeping newlines) so a leading doc comment never hides the statement under it.
  const src = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, (m, p1) => (p1 === undefined ? '' : p1) + m.slice((p1 || '').length).replace(/[^\n]/g, ' '));
  const out = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  let line = 1;
  let startLine = 1;
  const n = src.length;
  const push = (end) => {
    out.push({ text: src.slice(start, end), line: startLine });
    start = end;
    startLine = line;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < n && src[i] !== ch) {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) {
      depth--;
      if (depth === 0 && ch === '}' && /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|enum)\b/.test(src.slice(start, i))) push(i + 1);
    } else if (ch === ';' && depth === 0) push(i + 1);
    i++;
  }
  push(n);
  return out;
}

function moduleLevelTypeUse(src) {
  const hits = [];
  for (const s of topLevelStatements(src)) {
    const t = s.text.replace(/^\s+/, '');
    if (!/^(export\s+)?(const|let|var)\s/.test(t)) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const body = t.slice(eq + 1);
    const first = body.search(/\btype\./);
    if (first < 0) continue;
    if (/=>|\bfunction\b/.test(body.slice(0, first))) continue;
    const lead = (s.text.slice(0, s.text.length - t.length).match(/\n/g) || []).length;
    hits.push({ line: s.line + lead, head: t.split('\n')[0].trim().slice(0, 70) });
  }
  return hits;
}

{
  const problems = [];
  for (const d of ['app', 'components']) {
    for (const f of walk(path.join(root, d))) {
      const r = rel(f);
      if (isGenerated(r)) continue;
      for (const h of moduleLevelTypeUse(read(f))) problems.push(`${r}:${h.line}  module-level style reads type.*  ${h.head}`);
    }
  }
  check('no module-level StyleSheet.create or object spreads type.* in app/ or components/ (use makeStyles(colors) in useMemo)', problems);
}

// Every animation length is a token from constants/theme.ts (`motion.duration`, `motion.loop`), never a bare number.
// A bare number is allowed only with `// design-exception: <why>` (or the block form) on the same line. Timers that are
// not animation (setTimeout, setInterval, debounce) are not checked.
const DESIGN_EXCEPTION = /design-exception:/;
// Files allowed a bare duration. Empty: every animation reads `motion`. Add an entry only with a reason.
const DURATION_ALLOW = new Set([]);
const numericConsts = (text) => {
  const names = new Set();
  for (const m of text.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[\d_.]+\s*;(.*)$/gm)) {
    if (!DESIGN_EXCEPTION.test(m[2])) names.add(m[1]);
  }
  return names;
};
{
  const problems = [];
  for (const d of ['app', 'components']) {
    for (const f of walk(path.join(root, d))) {
      const r = rel(f);
      if (isGenerated(r) || DURATION_ALLOW.has(r)) continue;
      const text = read(f);
      const consts = numericConsts(text);
      text.split('\n').forEach((line, i) => {
        if (isCommentLine(line) || DESIGN_EXCEPTION.test(line)) return;
        let msg = null;
        if (/\bduration:\s*[^,}\n]*\b\d/.test(line)) msg = 'numeric duration literal';
        else if (/\bAnimated\.delay\(\s*\d|\bwithDelay\(\s*\d/.test(line)) msg = 'numeric delay literal';
        else if (/\bwithTiming\([^,]+,\s*\d/.test(line)) msg = 'numeric withTiming duration';
        else {
          const m = line.match(/\bduration:\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
          if (m && consts.has(m[1])) msg = `duration comes from a local number constant ${m[1]}`;
        }
        if (msg) problems.push(`${r}:${i + 1}  ${msg}  ${line.trim().slice(0, 80)}`);
      });
    }
  }
  check('no bare animation duration in app/ or components/ (use motion.duration.* or motion.loop.*, or // design-exception:)', problems);
}

// Every file that runs an animation also honours reduce motion: it reads useReduceMotion / useMotion, goes through animateTo,
// or takes a `reduce` / `reduceMotion` value from its caller.
const REDUCE_ALLOW = {
  // Add `'path': 'why'` here only when a file legitimately cannot read reduce motion.
};
{
  const problems = [];
  for (const d of ['app', 'components']) {
    for (const f of walk(path.join(root, d))) {
      const r = rel(f);
      if (isGenerated(r) || REDUCE_ALLOW[r]) continue;
      const code = read(f)
        .split('\n')
        .filter((l) => !isCommentLine(l))
        .join('\n');
      if (!/\b(Animated\.timing|Animated\.loop|withTiming|withRepeat)\b/.test(code)) continue;
      if (/\b(useReduceMotion|useMotion|animateTo)\b|\breduce(Motion)?\b/.test(code)) continue;
      problems.push(`${r}  runs an animation but never reads reduce motion`);
    }
  }
  check('every file that animates reads reduce motion (useReduceMotion, useMotion, animateTo or a reduce param)', problems);
}

console.log('One text input, token font sizes');
check(
  'no raw <TextInput in app/ or components/ outside components/ui/ (use TextField)',
  scan(['app', 'components'], {
    skip: (r) => r.startsWith('components/ui/'),
    test: (line) => (/<TextInput\b/.test(line) ? 'raw <TextInput' : null),
  }),
);
// Sizes come from `type.size.*` (or a constant built from it). A bare number is allowed only for fixed geometry,
// with `// design-exception: <why>` on the same line.
check(
  'no numeric fontSize: <number> in app/ or components/ without a // design-exception: on the line',
  scan(['app', 'components'], {
    test: (line) => (/\bfontSize:\s*\d/.test(line) && !/\/\/\s*design-exception:/.test(line) ? 'numeric fontSize' : null),
  }),
);

console.log(failed === 0 ? '\ndesign-system: all checks passed' : `\ndesign-system: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
