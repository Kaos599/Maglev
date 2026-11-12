// Expo config plugin: accept Android share (ACTION_SEND / ACTION_SEND_MULTIPLE) of magnet text and .torrent files.
// Expo only forwards `intent.data` to JS, and a share carries its payload in extras. So MainActivity
// rewrites a share intent into a VIEW intent in place (before React reads it); app/+native-intent.tsx
// then handles it like any other VIEW. The intent filters themselves are in app.json. Several sources are packed as maglev://share?u=...&u=...
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

function withShareIntents(config) {
  const { withMainActivity, withDangerousMod } = require('expo/config-plugins');
  const fs = require('fs');
  const path = require('path');
  config = withMainActivity(config, (c) => {
    if (c.modResults.language !== 'kt') throw new Error('withShareIntents: expected a Kotlin MainActivity');
    c.modResults.contents = applyMainActivity(c.modResults.contents);
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
