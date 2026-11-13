// Expo config plugin: accept Android share (ACTION_SEND / ACTION_SEND_MULTIPLE) of magnet text and .torrent files.
// Expo only forwards `intent.data` to JS, and a share carries its payload in extras. So MainActivity
// rewrites a share intent into a VIEW intent in place (before React reads it); app/+native-intent.tsx
// then handles it like any other VIEW. The share, magnet and .torrent intent filters are declared in app.json for MainActivity, then moved to the quick share card by applyQuickShareManifest below (docs/contracts-0.19/quick-share.md). Several sources are packed as maglev://share?u=...&u=...
// Android docs: https://developer.android.com/training/sharing/receive
const PACKAGE = 'com.maglev';
const MARKER = 'MaglevShareIntent.rewrite';

const KOTLIN = `package ${PACKAGE}

import android.content.Intent
import android.net.Uri
import android.os.Build

/** Rewrites ACTION_SEND / ACTION_SEND_MULTIPLE into ACTION_VIEW so expo-router sees the payload as intent data. */
object MaglevShareIntent {
    private val MAGNET = Regex("magnet:\\\\?[^\\\\s\\"'<>]+", RegexOption.IGNORE_CASE)
    private val TORRENT_URL = Regex("https?://[^\\\\s\\"'<>]+\\\\.torrent(?:\\\\?[^\\\\s\\"'<>]*)?", RegexOption.IGNORE_CASE)
    /** Any other web link in shared text starts a download from a link (NATIVE_CONTRACT 17). Magnets and .torrent links win. */
    private val WEB_URL = Regex("https?://[^\\\\s\\"'<>]+", RegexOption.IGNORE_CASE)

    @JvmStatic
    fun rewrite(intent: Intent?) {
        if (intent == null) return
        val sources: List<String> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(streamUri(intent)?.toString() ?: textSource(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamUris(intent).map { it.toString() }
            else -> return
        }
        if (sources.isEmpty()) return
        intent.action = Intent.ACTION_VIEW
        intent.data = if (sources.size == 1) {
            Uri.parse(sources[0])
        } else {
            Uri.parse("maglev://share?" + sources.joinToString("&") { "u=" + Uri.encode(it) })
        }
    }

    private fun textSource(intent: Intent): String? {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
        return MAGNET.find(text)?.value
            ?: TORRENT_URL.find(text)?.value
            ?: WEB_URL.find(text)?.value?.trimEnd('.', ',', ';', ':', '!', '?', ')', ']', '}')
    }

    @Suppress("DEPRECATION")
    private fun streamUri(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamUris(intent: Intent): List<Uri> {
        val list: List<Uri>? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        return list ?: emptyList()
    }
}
`;

/** Pure transform for MainActivity.kt. Idempotent. Throws when the template shape is not recognised. */
function applyMainActivity(src) {
  if (src.includes(MARKER)) return src;
  const onCreate = /(override fun onCreate\(savedInstanceState: Bundle\?\)\s*\{\n)/;
  if (!onCreate.test(src)) throw new Error('withShareIntents: MainActivity.onCreate not found');
  let out = src.replace(
    onCreate,
    `override fun onNewIntent(intent: Intent) {\n    ${MARKER}(intent)\n    super.onNewIntent(intent)\n  }\n\n  $1    ${MARKER}(intent)\n`,
  );
  if (!/^import android\.content\.Intent$/m.test(out)) {
    out = out.replace(/^(package .*\n)/m, '$1\nimport android.content.Intent\n');
  }
  return out;
}

// --- Quick share (docs/contracts-0.19/quick-share.md) ---
const QUICK_ACTIVITY = 'com.maglev.engine.share.QuickShareActivity';
const A = 'android.intent.action.';
const C = 'android.intent.category.';
const TORRENT_TYPES = ['application/x-bittorrent', 'application/x-torrent'];
/**
 * Types a browser can attach to an http(s) VIEW. A filter with a mime type matches only an intent that carries a
 * matching data type; a plain link tap has none, so ordinary browsing never reaches Maglev.
 * https://developer.android.com/guide/components/intents-filters#DataTest  No APK on purpose.
 */
const WEB_MIME_TYPES = [
  'application/octet-stream', 'application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed',
  'application/vnd.rar', 'application/x-rar-compressed', 'application/x-iso9660-image',
  'application/x-bittorrent', 'video/*', 'audio/*',
];

const filter = (actions, categories, data) => ({
  action: actions.map((a) => ({ $: { 'android:name': A + a } })),
  category: categories.map((c) => ({ $: { 'android:name': C + c } })),
  data: data.map((d) => ({ $: Object.fromEntries(Object.entries(d).map(([k, v]) => [`android:${k}`, v])) })),
});

/** The filters the card answers. The first four are the ones MainActivity used to hold (app.json). */
function quickShareFilters() {
  return [
    filter(['VIEW'], ['BROWSABLE', 'DEFAULT'], [{ scheme: 'magnet' }]),
    filter(['VIEW'], ['BROWSABLE', 'DEFAULT'], [
      ...TORRENT_TYPES.map((mimeType) => ({ mimeType })),
      { scheme: 'file', pathPattern: '.*\\.torrent' },
      { scheme: 'content', pathPattern: '.*\\.torrent' },
    ]),
    filter(['SEND'], ['DEFAULT'], [{ mimeType: 'text/plain' }, ...TORRENT_TYPES.map((mimeType) => ({ mimeType }))]),
    filter(['SEND_MULTIPLE'], ['DEFAULT'], TORRENT_TYPES.map((mimeType) => ({ mimeType }))),
    // Other browsers: DEFAULT only (not BROWSABLE), so a web page cannot start it.
    filter(['VIEW'], ['DEFAULT'], [
      { scheme: 'http' }, { scheme: 'https' },
      ...WEB_MIME_TYPES.map((mimeType) => ({ mimeType })),
    ]),
  ];
}

/** True for a MainActivity filter the card now owns: any SEND, a magnet, or a .torrent type or path. */
function isShareFilter(f) {
  const actions = (f.action || []).map((a) => a.$['android:name']);
  if (actions.some((a) => a === A + 'SEND' || a === A + 'SEND_MULTIPLE')) return true;
  return (f.data || []).some((d) => {
    const x = d.$ || {};
    return x['android:scheme'] === 'magnet' || /torrent/.test(x['android:mimeType'] || '') || /torrent/.test(x['android:pathPattern'] || '');
  });
}

/** Pure transform for AndroidManifest.xml (the parsed object). Idempotent. Throws when MainActivity is missing. */
function applyQuickShareManifest(manifest) {
  const app = manifest.manifest.application && manifest.manifest.application[0];
  const activities = (app && app.activity) || [];
  const main = activities.find((a) => /(^|\.)MainActivity$/.test(a.$['android:name']));
  if (!main) throw new Error('withShareIntents: MainActivity not found in the manifest');
  main['intent-filter'] = (main['intent-filter'] || []).filter((f) => !isShareFilter(f));
  const quick = {
    $: {
      'android:name': QUICK_ACTIVITY,
      'android:exported': 'true',
      'android:theme': '@style/MaglevQuickShare',
      'android:excludeFromRecents': 'true',
      'android:autoRemoveFromRecents': 'true',
      'android:taskAffinity': '',
      'android:configChanges': 'orientation|screenSize|keyboardHidden|uiMode',
    },
    'intent-filter': quickShareFilters(),
  };
  const at = activities.findIndex((a) => a.$['android:name'] === QUICK_ACTIVITY);
  if (at >= 0) activities[at] = quick;
  else activities.push(quick);
  app.activity = activities;
  return manifest;
}

function withShareIntents(config) {
  const { withMainActivity, withDangerousMod, withAndroidManifest } = require('expo/config-plugins');
  const fs = require('fs');
  const path = require('path');
  config = withMainActivity(config, (c) => {
    if (c.modResults.language !== 'kt') throw new Error('withShareIntents: expected a Kotlin MainActivity');
    c.modResults.contents = applyMainActivity(c.modResults.contents);
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyQuickShareManifest(c.modResults);
    return c;
  });
  config = withDangerousMod(config, [
    'android',
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...PACKAGE.split('.'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'MaglevShareIntent.kt'), KOTLIN);
      return c;
    },
  ]);
  return config;
}

module.exports = withShareIntents;
module.exports.applyMainActivity = applyMainActivity;
module.exports.KOTLIN = KOTLIN;
module.exports.applyQuickShareManifest = applyQuickShareManifest;
