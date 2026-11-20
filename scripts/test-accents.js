#!/usr/bin/env node
// Eight accent colours: lime, cyan, pink, orange, violet, blue, amber, mint.
// Checks WCAG contrast for every accent in every mode (onAccent on the fill, accent text on the page and
// on cards), that the four places that list accents agree, that no accent hue sits near danger, and
// that unknown saved values fall back to lime.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const NAMES = ['lime', 'cyan', 'pink', 'orange', 'violet', 'blue', 'amber', 'mint'];
const MODES = ['oled', 'dim', 'light'];
const MIN = 4.5;
const MIN_HUE_GAP = 20;

function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(d, 360 - d);
};

(async () => {
  const theme = await import('../constants/theme.ts');
  const { accents, buildColors, contrast, palettes, DEFAULT_ACCENT } = theme;

  console.log('names');
  check('theme has exactly the 8 accents', JSON.stringify(Object.keys(accents).sort()) === JSON.stringify([...NAMES].sort()), Object.keys(accents).join());
  check('default accent is lime', DEFAULT_ACCENT === 'lime');

  console.log('contrast (>= 4.5)');
  const rows = [];
  for (const name of NAMES) {
    if (!accents[name]) continue;
    for (const mode of MODES) {
      for (const pureBlack of mode === 'oled' ? [false, true] : [false]) {
        const c = buildColors(mode, name, pureBlack);
        const p = palettes[mode];
        const tag = `${name} ${mode}${pureBlack ? ' pure' : ''}`;
        const onFill = contrast(c.onAccent, c.accent);
        const onBg = contrast(c.accentText, c.bg);
        const onSurface = contrast(c.accentText, c.surface);
        const onRaised = contrast(c.accentText, p.surfaceRaised);
        check(`${tag}: onAccent on fill`, onFill >= MIN, onFill.toFixed(2));
        check(`${tag}: accent text on bg`, onBg >= MIN, onBg.toFixed(2));
        check(`${tag}: accent text on surface`, onSurface >= MIN, onSurface.toFixed(2));
        check(`${tag}: accent text on raised surface`, onRaised >= MIN, onRaised.toFixed(2));
        if (!pureBlack) rows.push(`${name.padEnd(7)} ${mode.padEnd(5)} fill ${c.accent} onAccent ${c.onAccent} ${onFill.toFixed(2)}  text ${c.accentText} on bg ${onBg.toFixed(2)}`);
      }
    }
    // Light fills are also graphics on paper: 3:1 minimum.
    const lc = buildColors('light', name);
    check(`${name} light: fill vs paper >= 3`, contrast(lc.accent, lc.bg) >= 3, contrast(lc.accent, lc.bg).toFixed(2));
  }
  for (const r of rows) console.log('  ' + r);

  console.log('hue distance from danger (>= 20 degrees)');
  const dangers = [...new Set(MODES.map((m) => palettes[m].danger).concat('#FF3366'))];
  for (const name of NAMES) {
    if (!accents[name]) continue;
    for (const [k, hex] of Object.entries(accents[name])) {
      for (const d of dangers) check(`${name}.${k} ${hex} vs danger ${d}`, hueGap(hex, d) >= MIN_HUE_GAP, `${hueGap(hex, d).toFixed(0)} deg`);
    }
  }

  console.log('not the downloading cyan');
  for (const name of NAMES) {
    if (name === 'cyan' || !accents[name]) continue;
    check(`${name}.bright hue is 25+ deg from #00E5FF`, hueGap(accents[name].bright, '#00E5FF') >= 25, `${hueGap(accents[name].bright, '#00E5FF').toFixed(0)} deg`);
  }

  console.log('lists agree');
  const types = read('modules/maglev-engine/src/MaglevSettings.types.ts');
  const union = (types.match(/export type AccentName =([^;]+);/) || [])[1] || '';
  const store = read('modules/maglev-engine/src/MaglevSettingsStore.ts');
  const labels = (read('app/(tabs)/settings.tsx').match(/const ACCENT_LABEL[^=]*=\s*\{([^}]+)\}/) || [])[1] || '';
  const iface = read('app/settings/interface.tsx');
  const swatches = (iface.match(/const ACCENTS[^=]*=\s*\[([\s\S]*?)\n\];/) || [])[1] || '';
  for (const n of NAMES) {
    check(`${n}: in AccentName type`, union.includes(`'${n}'`));
    check(`${n}: accepted by the store`, new RegExp(`'${n}'`).test(store));
    check(`${n}: in ACCENT_LABEL`, new RegExp(`\\b${n}:`).test(labels));
    check(`${n}: has a swatch`, swatches.includes(`name: '${n}'`));
  }
  check('swatch row is a radiogroup with radio items', /accessibilityRole="radiogroup"/.test(iface) && /accessibilityRole="radio"/.test(iface));
  check('swatches wrap in rows of 4 (25% items)', /flexWrap:\s*'wrap'/.test(iface) && /width:\s*'25%'/.test(iface));
  check('swatch target is 44px', /width:\s*(44|touch\.min),\s*\n\s*height:\s*(44|touch\.min)/.test(iface));

  console.log('saved values');
  const { migrateSettings } = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  for (const n of NAMES) check(`saved ${n} is kept`, migrateSettings({ appearance: { accent: n } }).appearance.accent === n);
  for (const bad of ['teal', '', 7, null, 'constructor', 'LIME']) {
    check(`saved ${JSON.stringify(bad)} falls back to lime`, migrateSettings({ appearance: { accent: bad } }).appearance.accent === 'lime');
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall accent checks passed');
})();
