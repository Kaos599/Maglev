#!/usr/bin/env node
// Light-mode logo: the mark and wordmark are mono near-black on light, unchanged on dark themes.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
const check = (n, c) => { if (c) console.log(`  ok   ${n}`); else { failed++; console.error(`  FAIL ${n}`); } };

const mark = read('components/brand/MaglevMark.tsx');
const word = read('components/settings/Wordmark.tsx');
const paths = read('components/brand/markPaths.ts');

check('MaglevMark reads the theme', /useTheme\(\)/.test(mark));
check('MaglevMark branches on dark', /dark\s*\?\s*\{\s*body: MARK_LIME, lines: MARK_CYAN\s*\}\s*:\s*\{\s*body: colors\.text, lines: colors\.textMuted/.test(mark));
check('MaglevMark no longer paints with the brand constants directly', !/fill=\{MARK_(LIME|CYAN)\}|backgroundColor: MARK_/.test(mark));
check('MaglevMark has no hex literals', !/#[0-9a-fA-F]{3,8}\b/.test(mark));
check('markPaths brand hexes unchanged', /MARK_LIME = '#A5FB48'/.test(paths) && /MARK_CYAN = '#01E5EF'/.test(paths));
check('Wordmark reads the theme and branches on dark', /useTheme\(\)/.test(word) && /dark \? colors\.accent : colors\.text/.test(word));
check('Wordmark has no hex literals', !/#[0-9a-fA-F]{3,8}\b/.test(word));

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
(async () => {
  const { palettes } = await import('../constants/theme.ts');
  const l = palettes.light;
  check(`light mark body contrast >= 3 (${ratio(l.text, l.bg).toFixed(1)})`, ratio(l.text, l.bg) >= 3);
  check(`light speed lines contrast >= 3 (${ratio(l.textMuted, l.bg).toFixed(1)})`, ratio(l.textMuted, l.bg) >= 3);
  check(`light wordmark contrast >= 4.5`, ratio(l.text, l.bg) >= 4.5);
  process.exit(failed ? 1 : 0);
})();
