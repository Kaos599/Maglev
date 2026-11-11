// Expo config plugin: shrink release APKs (compressed .so, R8 code shrinking, resource shrinking).
// `expo prebuild --clean` regenerates android/ in CI, so every setting lives here.
// The Expo bare template reads these gradle.properties keys:
//   expo.useLegacyPackaging                         -> packaging.jniLibs.useLegacyPackaging
//   android.enableMinifyInReleaseBuilds             -> R8 minifyEnabled
//   android.enableShrinkResourcesInReleaseBuilds    -> shrinkResources
// useLegacyPackaging=true stores .so deflated in the APK and extracts them at install. Android's
// 16 KB page-size guide recommends compressed libs for 16 KB devices (no zip alignment needed).
const PROPS = {
  'expo.useLegacyPackaging': 'true',
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};
const MARKER = '# maglev-size-reduction';

// consumer-rules.pro in modules/maglev-engine is not wired into the module's gradle, so R8 would
// otherwise rename the JNI entry points (Java_com_maglev_engine_NativeCore_*) and break the Rust bridge.
const KEEP_RULES = `
${MARKER}
-keep class com.maglev.engine.** { *; }
-keepclassmembers class * {
    native <methods>;
}
`;

/** Pure transform for gradle.properties entries (array of {type,key,value}). Idempotent. */
function applySizeProperties(props) {
  const out = props.filter((p) => !(p.type === 'property' && p.key in PROPS));
  for (const [key, value] of Object.entries(PROPS)) out.push({ type: 'property', key, value });
  return out;
}

/** Pure transform for proguard-rules.pro text. Idempotent. */
function applyKeepRules(src) {
  if (src.includes(MARKER)) return src;
  const base = src && !src.endsWith('\n') ? src + '\n' : src || '';
  return base + KEEP_RULES;
}

function withSizeReduction(config) {
  const { withGradleProperties, withDangerousMod } = require('expo/config-plugins');
  const fs = require('fs');
  const path = require('path');
  config = withGradleProperties(config, (c) => {
    c.modResults = applySizeProperties(c.modResults);
    return c;
  });
  config = withDangerousMod(config, [
    'android',
    (c) => {
      const file = path.join(c.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, applyKeepRules(cur));
      return c;
    },
  ]);
  return config;
}

module.exports = withSizeReduction;
module.exports.applySizeProperties = applySizeProperties;
module.exports.applyKeepRules = applyKeepRules;
