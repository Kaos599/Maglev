#!/usr/bin/env node
// Font style setting (Settings > Interface > Font): Clean (default), Retro, Mono.
// Checks the persisted pref, that every style maps every semantic font slot to a font loaded in
// app/_layout.tsx, that the MAGLEV wordmark is always Silkscreen, that switching is live through the
// shared `type` tokens, mono slot widths, and the copy.
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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

async function main() {
  const FS = await import('../constants/fontStyles.ts');
  const T = await import('../constants/theme.ts');
  const S = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const Store = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const copy = await import('../constants/copy.ts');

  // ---- the pref
  check('styles are clean, retro, mono', JSON.stringify(FS.FONT_STYLES) === JSON.stringify(['clean', 'retro', 'mono']));
  check('default style is clean', FS.DEFAULT_FONT_STYLE === 'clean');
  check('settings default is clean', S.DEFAULT_SETTINGS.appearance.fontStyle === 'clean');
  check('resolveFontStyle falls back to clean', FS.resolveFontStyle('bogus') === 'clean' && FS.resolveFontStyle(undefined) === 'clean' && FS.resolveFontStyle(42) === 'clean');
  check('resolveFontStyle keeps a valid value', FS.FONT_STYLES.every((s) => FS.resolveFontStyle(s) === s));

  // ---- persistence round trip (same path as theme mode and accent: appearance in the kv-store payload)
  const stored = JSON.parse(JSON.stringify({ version: S.SETTINGS_SCHEMA_VERSION, settings: { ...S.DEFAULT_SETTINGS, appearance: { ...S.DEFAULT_SETTINGS.appearance, fontStyle: 'mono' } } }));
  check('a saved style survives migrate', Store.migrateSettings(stored).appearance.fontStyle === 'mono');
  check('an older payload without the field gets clean', Store.migrateSettings({ version: 3, settings: { appearance: { mode: 'dim' } } }).appearance.fontStyle === 'clean');
  check('an older payload keeps its other appearance fields', Store.migrateSettings({ version: 3, settings: { appearance: { mode: 'dim' } } }).appearance.mode === 'dim');
  check('an unknown saved style becomes clean', Store.migrateSettings({ settings: { appearance: { fontStyle: 'comic' } } }).appearance.fontStyle === 'clean');
  const store = Store.MaglevSettingsStore.getInstance();
  store.updateSettings((prev) => ({ appearance: { ...prev.appearance, fontStyle: 'retro' } }));
  check('updateSettings stores the style and keeps the rest', store.getSettings().appearance.fontStyle === 'retro' && store.getSettings().appearance.accent === S.DEFAULT_SETTINGS.appearance.accent);
  check('the settings type lists the same styles', /export type FontStyle = 'clean' \| 'retro' \| 'mono';/.test(read('modules/maglev-engine/src/MaglevSettings.types.ts')));
  const nativeCfg = read('modules/maglev-engine/src/toNativeConfig.ts');
  check('the style is UI only: toNativeConfig never reads it', !/fontStyle/.test(nativeCfg));
  check('the style is UI only: Rust and Kotlin never see it', !/fontStyle/.test(read('docs/NATIVE_CONTRACT.md')));

  // ---- every style maps every slot to a loaded font
  const layout = read('app/_layout.tsx');
  const loaded = new Set();
  for (const m of layout.matchAll(/\[FONT_NAMES\.(\w+)\]:\s*require\('([^']+)'\)/g)) {
    loaded.add(FS.FONT_NAMES[m[1]]);
    check(`font file exists for ${m[1]}`, fs.existsSync(path.join(root, 'node_modules', m[2])), m[2]);
  }
  check('_layout loads fonts through FONT_NAMES', loaded.size === Object.keys(FS.FONT_NAMES).length, `${loaded.size} of ${Object.keys(FS.FONT_NAMES).length}`);
  for (const style of FS.FONT_STYLES) {
    const map = FS.fontFamilies[style];
    check(`${style}: has every slot`, FS.FONT_SLOTS.every((s) => typeof map[s] === 'string'), Object.keys(map).join(','));
    check(`${style}: every slot is a loaded font`, FS.FONT_SLOTS.every((s) => loaded.has(map[s])), FS.FONT_SLOTS.filter((s) => !loaded.has(map[s])).map((s) => map[s]).join(','));
    check(`${style}: the wordmark is Silkscreen`, map.brand === 'Silkscreen');
  }
  const F = FS.fontFamilies;
  check('clean: headings are Inter Bold', F.clean.heading === 'InterBold');
  check('clean: names and numbers are Inter Medium, not Space Mono', F.clean.mono === 'InterMedium' && F.clean.monoBold === 'InterSemiBold');
  check('clean: Silkscreen only on the wordmark', FS.FONT_SLOTS.filter((s) => F.clean[s] === 'Silkscreen').join() === 'brand');
  check('retro: today\'s look', F.retro.heading === 'Silkscreen' && F.retro.mono === 'SpaceMono' && F.retro.monoBold === 'SpaceMonoBold' && F.retro.body === 'Inter' && F.retro.bodyStrong === 'InterSemiBold');
  check('mono: Space Mono Bold headings, Space Mono numbers', F.mono.heading === 'SpaceMonoBold' && F.mono.mono === 'SpaceMono' && F.mono.monoBold === 'SpaceMonoBold');
  check('body copy is Inter in every style', FS.FONT_STYLES.every((s) => F[s].body === 'Inter' && F[s].bodyStrong === 'InterSemiBold'));

  // ---- live switching through the shared tokens
  check('theme starts on clean', T.getActiveFontStyle() === 'clean' && T.type.mono.fontFamily === 'InterMedium');
  T.setActiveFontStyle('retro');
  check('retro switches type.mono', T.type.mono.fontFamily === 'SpaceMono' && T.type.heading.fontFamily === 'Silkscreen' && T.fontFamily.monoBold === 'SpaceMonoBold');
  check('type.mono keeps tabular-nums', T.type.mono.fontVariant[0] === 'tabular-nums' && T.type.monoBold.fontVariant[0] === 'tabular-nums');
  T.setActiveFontStyle('mono');
  check('mono switches type.heading', T.type.heading.fontFamily === 'SpaceMonoBold' && T.type.brand.fontFamily === 'Silkscreen');
  T.setActiveFontStyle('nonsense');
  check('a bad style value leaves clean', T.getActiveFontStyle() === 'clean' && T.type.heading.fontFamily === 'InterBold');
  check('the wordmark token is Silkscreen in every style', FS.FONT_STYLES.every((s) => { T.setActiveFontStyle(s); return T.type.brand.fontFamily === 'Silkscreen'; }));
  T.setActiveFontStyle('clean');

  const ctx = read('context/ThemeContext.tsx');
  check('ThemeContext applies the pref and rebuilds colours so memoised styles refresh', /setActiveFontStyle\(/.test(ctx) && /fontStyle/.test(ctx));
  check('ThemeContext exposes fontStyle', /fontStyle: FontStyleName/.test(ctx));

  // ---- the wordmark stays Silkscreen: only the header wordmark uses type.brand
  const brandUsers = walk('app').concat(walk('components')).filter((f) => /type\.brand|fontFamily\.brand|family\.brand/.test(read(f)));
  check('only HeaderBar uses the brand (wordmark) font', brandUsers.join() === 'components/HeaderBar.tsx', brandUsers.join(', '));
  check('no file hardcodes the Silkscreen name outside constants and _layout', walk('app').concat(walk('components'), walk('context'), walk('utils')).every((f) => !/'Silkscreen'/.test(read(f))));
  check('screen titles use the heading slot', /type\.heading/.test(read('components/ui/Screen.tsx')));

  // ---- never the system monospace
  const mono = walk('app').concat(walk('components'), walk('constants'), walk('context'), walk('utils')).filter((f) => /fontFamily:\s*['"`]monospace['"`]/.test(read(f)));
  check("no file uses fontFamily: 'monospace'", mono.length === 0, mono.join(', '));

  // ---- mono slots: Space Mono advance is exact, Inter tabular figures are measured
  check('default slot advance is Space Mono', T.monoSlotWidth(11, 12) === Math.ceil(11 * 12 * T.MONO_ADVANCE));
  // Measured from the Inter 500 and 600 TTFs with tabular digit glyphs (fontTools hmtx): the widest
  // speed and size strings average 0.579 em per glyph ("1023.9 GB"), the widest speed 0.574.
  const INTER_WORST_ADVANCE = 0.579;
  check('clean slot advance covers the widest measured Inter string', FS.slotAdvance.clean >= INTER_WORST_ADVANCE, String(FS.slotAdvance.clean));
  check('clean slot advance is not wider than Space Mono', FS.slotAdvance.clean <= FS.slotAdvance.retro);
  check('retro and mono use the Space Mono advance', FS.slotAdvance.retro === T.MONO_ADVANCE && FS.slotAdvance.mono === T.MONO_ADVANCE);
  check('monoSlotWidth takes the advance', T.monoSlotWidth(11, 12, 1, FS.slotAdvance.clean) === Math.ceil(11 * 12 * FS.slotAdvance.clean));
  check('TransferCard passes the active advance', /monoSlotWidth\([^)]*slotAdvance/.test(read('components/TransferCard.tsx')) || /monoSlotWidth\([^)]*type\.slotAdvance/.test(read('components/TransferCard.tsx')));

  // ---- the settings row
  const ui = read('app/settings/interface.tsx');
  check('Interface settings has the Font section with a RadioCard per style', /Font/.test(ui) && /RadioCard/.test(ui) && /fontStyle/.test(ui));
  check('choosing a style persists through appearance', /set\(\{ fontStyle/.test(ui));
  check('each option previews in its own style', /fontFamilies\[/.test(ui) || /FONT_STYLES/.test(ui));
  check('RadioCard gives the select haptic and a 44px target', /haptic="select"/.test(read('components/ui/RadioCard.tsx')) && /minHeight: 64/.test(read('components/ui/RadioCard.tsx')));

  // ---- copy (same voice rules as scripts/test-copy-voice.js, which also lints these strings)
  const c = copy.fontStyleCopy;
  check('copy: section label is Font', c.label === 'Font');
  check('copy: options are Clean, Retro, Mono', JSON.stringify(c.options.map((o) => o.title)) === JSON.stringify(['Clean', 'Retro', 'Mono']));
  check('copy: one option per style', c.options.map((o) => o.value).join() === FS.FONT_STYLES.join());
  const bad = [];
  for (const o of c.options) {
    const n = o.description.trim().split(/\s+/).length;
    if (n > 16) bad.push(`${o.value}: ${n} words`);
    if (!/\.$/.test(o.description)) bad.push(`${o.value}: no period`);
    if (/[!…]|\.\.\./.test(o.description)) bad.push(`${o.value}: ! or ellipsis`);
  }
  check('copy: descriptions are short sentences', bad.length === 0, bad.join('; '));
  check('copy: preview sample is a filename and a size', /^Big Buck Bunny 1080p/.test(c.sampleName) && /\d+(\.\d)? MB$/.test(c.sampleSize));

  // ---- AGENTS.md
  const agents = read('AGENTS.md');
  check('AGENTS.md describes the three styles', /Clean/.test(agents) && /Retro/.test(agents) && /Mono/.test(agents) && /Never use `fontFamily: 'monospace'`/.test(agents));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll font style checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
