#!/usr/bin/env node
// Launcher icon picker (Settings > Appearance > App icon): the 20 ids must agree everywhere.
// Checks constants/appIcons.ts, scripts/build-app-icons.py, assets/app-icons (generated), previews.ts,
// plugins/withAppIcons.js (and its manifest transform on a fixture), AppIconManager.kt, the TS bridge,
// the copy, and that the picker renders on Android only.
// Needs Node 22.18+ (loads the TypeScript source directly via type stripping).

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const OWNER_IDS = [
  'teal', 'all-dark', 'lime', 'cyan', 'mono', 'mono-black', 'mono-white', 'mono-gray',
  'm-keycap-teal', 'm-keycap-lime', 'm-keycap-light', 'm-keycap-mono', 'm-keycap-cyan',
  'm-bare-lime', 'm-bare-teal', 'm-bare-mono', 'nose', 'dash', 'crt', 'amber',
];
const rid = (id) => id.replace(/-/g, '_');

async function main() {
  // ---- constants
  const consts = await import('../constants/appIcons.ts');
  const ids = consts.APP_ICONS.map((i) => i.id);
  check('constants list the 20 owner ids in order', same(ids, OWNER_IDS), ids.join(','));
  check('every icon has a name and a group', consts.APP_ICONS.every((i) => i.name && ['train', 'm', 'extra'].includes(i.group)));
  check('default icon is teal and first', consts.DEFAULT_APP_ICON === 'teal' && ids[0] === 'teal');
  check('ids are unique', new Set(ids).size === ids.length);

  // ---- generator
  const gen = read('scripts/build-app-icons.py');
  const genBlock = gen.slice(gen.indexOf('ICONS = ['), gen.indexOf('IDS = ['));
  const genIds = [...genBlock.matchAll(/^\s*\("([a-z-]+)",/gm)].map((m) => m[1]);
  check('generator builds the same ids in order', same(genIds, OWNER_IDS), genIds.join(','));
  check('generator writes VectorDrawables, not PNGs', gen.includes('<vector') && !/\.png/.test(gen.replace(/#.*$/gm, '')));

  // ---- generated resources
  const res = 'assets/app-icons';
  const have = (rel) => fs.existsSync(path.join(root, res, rel));
  for (const id of OWNER_IDS) {
    const base = `ic_launcher_alt_${rid(id)}`;
    const files = {
      fg: `drawable/${base}_fg.xml`,
      bg: `drawable/${base}_bg.xml`,
      mono: `drawable/${base}_mono.xml`,
      adaptive: `mipmap-anydpi-v26/${base}.xml`,
      legacy: `mipmap-anydpi/${base}.xml`,
    };
    check(`${id}: fg, bg, mono, adaptive and legacy files exist`, Object.values(files).every(have));
    if (!Object.values(files).every(have)) continue;
    const ad = read(`${res}/${files.adaptive}`);
    check(
      `${id}: adaptive icon has background, foreground and monochrome`,
      ad.includes(`@drawable/${base}_bg`) && ad.includes(`@drawable/${base}_fg`) && ad.includes(`@drawable/${base}_mono`) && ad.includes('<monochrome'),
    );
    const fg = read(`${res}/${files.fg}`);
    check(`${id}: foreground is a 108dp vector with a path`, /android:width="108dp"/.test(fg) && /android:viewportWidth="108"/.test(fg) && fg.includes('android:pathData='));
    const legacy = read(`${res}/${files.legacy}`);
    check(`${id}: API 24-25 icon is one 48dp vector over a 72 viewport`, /<vector/.test(legacy) && /android:width="48dp"/.test(legacy) && /android:viewportWidth="72"/.test(legacy));
  }
  const strays = ['drawable', 'mipmap-anydpi', 'mipmap-anydpi-v26']
    .flatMap((d) => fs.readdirSync(path.join(root, res, d)).map((f) => `${d}/${f}`))
    .filter((f) => !OWNER_IDS.some((id) => f.includes(`ic_launcher_alt_${rid(id)}`)));
  check('no stray generated resources', strays.length === 0, strays.join(','));
  check('generated resources never clash with Expo ic_launcher', !fs.readdirSync(path.join(root, res, 'drawable')).some((f) => /^ic_launcher(_|\.)/.test(f) && !f.startsWith('ic_launcher_alt_')));

  // ---- previews.ts
  const pv = await import('../assets/app-icons/previews.ts');
  check('previews cover the same ids in order', same(Object.keys(pv.APP_ICON_PREVIEWS), OWNER_IDS));
  check('every preview has a tile and artwork layers', OWNER_IDS.every((id) => pv.APP_ICON_PREVIEWS[id].length >= 3 || id.startsWith('m-bare')));
  check('preview layers are [fill, path, evenodd]', OWNER_IDS.every((id) => pv.APP_ICON_PREVIEWS[id].every(([f, d, e]) => /^#[0-9A-F]{6}$/.test(f) && /^M[\d. HVMZ-]+$/.test(d) && typeof e === 'boolean')));
  check('previews are cropped like a launcher (middle 72 of 108)', pv.APP_ICON_PREVIEW_VIEWBOX === '18 18 72 72');

  // ---- plugin
  const plugin = require('../plugins/withAppIcons.js');
  check('plugin lists the same ids in order', same(plugin.ICON_IDS, OWNER_IDS));
  check('plugin default is teal', plugin.DEFAULT_ICON === 'teal');
  check('app.json registers the plugin', JSON.parse(read('app.json')).expo.plugins.includes('./plugins/withAppIcons.js'));

  const filter = (action, cats, data) => ({
    action: [{ $: { 'android:name': action } }],
    category: cats.map((c) => ({ $: { 'android:name': c } })),
    ...(data ? { data: [{ $: data }] } : {}),
  });
  const fixture = () => ({
    manifest: {
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: { 'android:name': '.MainActivity', 'android:exported': 'true' },
              'intent-filter': [
                filter('android.intent.action.MAIN', ['android.intent.category.LAUNCHER']),
                filter('android.intent.action.VIEW', ['android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE'], { 'android:scheme': 'magnet' }),
                filter('android.intent.action.SEND', ['android.intent.category.DEFAULT'], { 'android:mimeType': 'text/plain' }),
                filter('android.intent.action.SEND_MULTIPLE', ['android.intent.category.DEFAULT'], { 'android:mimeType': 'application/x-bittorrent' }),
              ],
            },
            { $: { 'android:name': '.OtherActivity' } },
          ],
        },
      ],
    },
  });
  const out = plugin.applyManifest(fixture());
  const app = out.manifest.application[0];
  const main = app.activity.find((a) => a.$['android:name'] === '.MainActivity');
  const actions = main['intent-filter'].map((f) => f.action[0].$['android:name']);
  check('MainActivity loses MAIN/LAUNCHER', !main['intent-filter'].some((f) => f.category.some((c) => c.$['android:name'] === 'android.intent.category.LAUNCHER')));
  check('MainActivity keeps the VIEW and share filters', same(actions, ['android.intent.action.VIEW', 'android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']));
  check('other activities are untouched', app.activity.some((a) => a.$['android:name'] === '.OtherActivity'));
  const aliases = app['activity-alias'];
  check('one alias per icon', aliases.length === 20, String(aliases.length));
  check('aliases follow the id order', same(aliases.map((a) => a.$['android:name']), OWNER_IDS.map((id) => `com.maglev.MaglevIcon_${rid(id)}`)));
  check('every alias targets MainActivity and is exported', aliases.every((a) => a.$['android:targetActivity'] === '.MainActivity' && a.$['android:exported'] === 'true'));
  check('every alias carries MAIN and LAUNCHER', aliases.every((a) => a['intent-filter'].length === 1 && a['intent-filter'][0].action[0].$['android:name'] === 'android.intent.action.MAIN' && a['intent-filter'][0].category[0].$['android:name'] === 'android.intent.category.LAUNCHER'));
  check('every alias has its own icon and round icon', aliases.every((a, i) => a.$['android:icon'] === `@mipmap/ic_launcher_alt_${rid(OWNER_IDS[i])}` && a.$['android:roundIcon'] === a.$['android:icon']));
  const enabled = aliases.filter((a) => a.$['android:enabled'] === 'true').map((a) => a.$['android:name']);
  check('exactly one alias is enabled, and it is teal', same(enabled, ['com.maglev.MaglevIcon_teal']), enabled.join(','));
  check('the manifest transform is idempotent', same(plugin.applyManifest(JSON.parse(JSON.stringify(out))), out));
  let threw = false;
  try { plugin.applyManifest({ manifest: { application: [{ activity: [] }] } }); } catch (e) { threw = /MainActivity/.test(e.message); }
  check('the transform throws when MainActivity is missing', threw);
  for (const id of OWNER_IDS) {
    const r = `ic_launcher_alt_${rid(id)}`;
    const refs = aliases.find((a) => a.$['android:name'].endsWith(`_${rid(id)}`)).$['android:icon'];
    check(`${id}: the alias icon resolves to a generated mipmap`, refs === `@mipmap/${r}` && have(`mipmap-anydpi-v26/${r}.xml`) && have(`mipmap-anydpi/${r}.xml`));
  }

  // ---- Kotlin
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/appicon/AppIconManager.kt');
  const ktList = kt.slice(kt.indexOf('val IDS'), kt.indexOf('private const val PACKAGE'));
  const ktIds = [...ktList.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  check('AppIconManager lists the same ids in order', same(ktIds, OWNER_IDS), ktIds.join(','));
  check('AppIconManager alias class matches the plugin', kt.includes('"$PACKAGE.MaglevIcon_" + id.replace(\'-\', \'_\')') && kt.includes('const val DEFAULT = "teal"'));
  const apply = kt.slice(kt.indexOf('fun apply('));
  check('setAppIcon enables the target', /setComponentEnabledSetting\(target, PackageManager\.COMPONENT_ENABLED_STATE_ENABLED, PackageManager\.DONT_KILL_APP\)/.test(apply));
  check('setAppIcon disables every other alias', /for \(other in IDS\)[\s\S]*if \(other == id\) continue[\s\S]*COMPONENT_ENABLED_STATE_DISABLED, PackageManager\.DONT_KILL_APP/.test(apply));
  check('the target is enabled before the others are disabled', apply.indexOf('COMPONENT_ENABLED_STATE_ENABLED') < apply.indexOf('COMPONENT_ENABLED_STATE_DISABLED'));
  check('unknown ids are rejected', kt.includes('fun request(id: String): String?') && kt.includes('Unknown app icon'));
  const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
  check('module exposes getAppIcon and setAppIcon', mod.includes('AsyncFunction("getAppIcon")') && mod.includes('AsyncFunction("setAppIcon")'));
  check('setAppIcon only records the choice', /AsyncFunction\("setAppIcon"\)[\s\S]*?AppIconManager\.request\(id\)/.test(mod) && !/AsyncFunction\("setAppIcon"\)[\s\S]{0,200}applyPending/.test(mod));
  check('the switch applies when the app goes to the background and on destroy', /OnActivityEntersBackground\s*\{[^}]*AppIconManager\.applyPending/.test(mod) && /OnDestroy\s*\{[^}]*AppIconManager\.applyPending/.test(mod));

  // ---- TS bridge and mock
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  check('API type declares getAppIcon and setAppIcon', /getAppIcon\(\): Promise<string>/.test(types) && /setAppIcon\(id: string\): Promise<EngineResult>/.test(types));
  check('bridge calls the native functions', bridge.includes("callNative<{ ok?: boolean; id?: string }>('getAppIcon')") && bridge.includes("callNative<EngineResult>('setAppIcon', id)"));
  check('mock keeps the choice in memory', /private appIcon = 'teal'/.test(mock) && /async setAppIcon\(id: string\)/.test(mock));

  // ---- picker and copy
  const copy = await import('../constants/copy.ts');
  check('copy has the picker caption', /leave Maglev/.test(copy.appIconCopy.hint) && copy.appIconCopy.hint.split(/\s+/).length <= 16 && /\.$/.test(copy.appIconCopy.hint));
  check('accessibility label reads "Teal app icon, selected"', copy.appIconCopy.a11y('Teal', true) === 'Teal app icon, selected' && copy.appIconCopy.a11y('Teal', false) === 'Teal app icon');
  const ui = read('components/settings/AppIconSection.tsx');
  check('picker is Android only', /Platform\.OS !== 'android'\) return null/.test(ui));
  check('picker lists every icon from constants', ui.includes('APP_ICONS.map') && ui.includes('APP_ICON_PREVIEWS'));
  check('picker targets are at least 44px', ui.includes('touch.min'));
  check('picker has no hex colours and no font file names', !/#[0-9A-Fa-f]{3,8}\b/.test(ui) && !/Inter_|Silkscreen|SpaceMono/.test(ui));
  check('picker uses theme colours for the ring', ui.includes('colors.accent') && ui.includes('useTheme()'));
  check('picker shows the caption', ui.includes('appIconCopy.hint'));

  console.log(failed ? `\n${failed} check(s) failed` : '\nall app icon checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
