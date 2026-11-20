#!/usr/bin/env node
// Cold-start window colour: the first frame must be Void, not the platform grey.
// Checks plugins/withWindowBackground.js against constants/theme.ts (palettes.oled.bg is the only source of the
// hex), that app.json registers it and keeps its splash colour on Void, and runs the plugin's transforms on the
// same style/colour shapes prebuild generates.
// Needs Node 22.18+ (loads the TypeScript source directly via type stripping).

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

async function main() {
  const theme = await import('../constants/theme.ts');
  const plugin = require('../plugins/withWindowBackground.js');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
  const { AndroidConfig } = require('expo/config-plugins');

  const voidHex = theme.palettes.oled.bg.toUpperCase();
  check('Void is the default mode background', theme.DEFAULT_MODE === 'oled' && /^#[0-9A-F]{6}$/.test(voidHex), voidHex);
  check('plugin reads Void from constants/theme.ts', plugin.readVoid() === voidHex, plugin.readVoid());
  check('plugin fails loudly when the palette is missing', (() => {
    try { plugin.readVoid('export const x = 1;'); return false; } catch (e) { return /oled\.bg/.test(String(e)); }
  })());

  check('app.json splash.backgroundColor is Void', String(app.splash && app.splash.backgroundColor).toUpperCase() === voidHex, app.splash && app.splash.backgroundColor);
  check('app.json registers the plugin', (app.plugins || []).includes('./plugins/withWindowBackground.js'));
  check('plugin file does not write a hex literal', !/#[0-9A-Fa-f]{6}\b/.test(fs.readFileSync(path.join(root, 'plugins/withWindowBackground.js'), 'utf8').replace(/^\/\/.*$/gm, '')));

  // colors.xml: template shape ({resources:{color:[{$:{name},_:value}]}}) with the template's white splash colour.
  let colors = { resources: { color: [{ $: { name: 'splashscreen_background' }, _: '#FFFFFF' }] } };
  colors = plugin.applyColors(colors, voidHex, AndroidConfig.Colors.assignColorValue);
  const colorObj = AndroidConfig.Colors.getColorsAsObject(colors);
  check('splashscreen_background (pre-12 splash base) is Void', colorObj.splashscreen_background === voidHex, colorObj.splashscreen_background);
  check('maglev_window_background is Void', colorObj[plugin.COLOR_NAME] === voidHex);
  const again = plugin.applyColors(colors, voidHex, AndroidConfig.Colors.assignColorValue);
  check('colors transform is idempotent', JSON.stringify(again) === JSON.stringify(colors));

  // styles.xml: the two themes the expo template ships.
  let styles = {
    resources: {
      style: [
        { $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' }, item: [{ $: { name: 'android:editTextBackground' }, _: '@drawable/rn_edit_text_material' }] },
        { $: { name: 'Theme.App.SplashScreen', parent: 'AppTheme' }, item: [{ $: { name: 'android:windowBackground' }, _: '@drawable/splashscreen_logo' }] },
      ],
    },
  };
  for (let i = 0; i < 2; i++) {
    for (const [parent, name, value] of plugin.STYLE_ITEMS) {
      styles = AndroidConfig.Styles.assignStylesValue(styles, { add: true, parent, name, value });
    }
  }
  const item = (theme_, n) => {
    const s = styles.resources.style.find((x) => x.$.name === theme_);
    const all = ((s && s.item) || []).filter((i) => i.$.name === n);
    return all.length === 1 ? all[0]._ : all.length === 0 ? undefined : 'duplicate';
  };
  const ref = '@color/' + plugin.COLOR_NAME;
  check('AppTheme windowBackground is Void (after setTheme in MainActivity.onCreate)', item('AppTheme', 'android:windowBackground') === ref);
  check('launch theme sets windowSplashScreenBackground to Void (Android 12+)', item('Theme.App.SplashScreen', 'android:windowSplashScreenBackground') === ref);
  check('launch theme keeps the template windowBackground drawable', item('Theme.App.SplashScreen', 'android:windowBackground') === '@drawable/splashscreen_logo');
  check('existing AppTheme items survive', item('AppTheme', 'android:editTextBackground') === '@drawable/rn_edit_text_material');
  check('styles transform is idempotent (no duplicate items)', styles.resources.style.every((s) => new Set(s.item.map((i) => i.$.name)).size === s.item.length));

  console.log(failed ? `\n${failed} check(s) failed` : '\nwindow background checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
