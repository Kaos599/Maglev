#!/usr/bin/env node
// Selected text in fields must stay readable in every theme and accent: the selection highlight is the accent laid
// over the field at selectionOpacity(), and the text on it must reach 4.5:1 (WCAG AA) while the highlight itself
// stays visible against the field (at least 2:1). A solid lime highlight once hid white text in the address bar.
process.removeAllListeners('warning');
(async () => {
  const T = await import('../constants/theme.ts');
  const modes = ['oled', 'dim', 'light'];
  const accents = ['lime', 'cyan', 'pink', 'orange', 'violet', 'blue', 'amber', 'mint'];
  let failed = 0;
  let n = 0;
  for (const mode of modes) {
    for (const pureBlack of mode === 'oled' ? [false, true] : [false]) {
      for (const accent of accents) {
        const c = T.buildColors(mode, accent, pureBlack);
        const a = T.selectionOpacity(c);
        for (const field of ['surface', 'bg']) {
          n++;
          const shown = T.blend(c.accent, c[field], a);
          const text = T.contrast(c.text, shown);
          const seen = T.contrast(shown, c[field]);
          if (text < 4.5 || seen < 2) {
            failed++;
            console.error(`  FAIL ${mode}${pureBlack ? '+black' : ''} ${accent} on ${field}: text ${text.toFixed(2)}, highlight ${seen.toFixed(2)} (opacity ${a})`);
          }
        }
      }
    }
  }
  const tf = require('fs').readFileSync(require('path').join(__dirname, '..', 'components/ui/TextField.tsx'), 'utf8');
  if ((tf.match(/selectionColor=\{selectionColor\(colors\)\}/g) || []).length !== 2) {
    failed++;
    console.error('  FAIL TextField uses selectionColor(colors) on both inputs');
  }
  if (failed) {
    console.error(`\nselection contrast: ${failed} failed`);
    process.exit(1);
  }
  console.log(`selection contrast: ${n} theme/accent/field combinations readable`);
})();
