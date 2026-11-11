// Expo config plugin: per-ABI APK splits (+ universal) for release builds.
// Needed because `expo prebuild --clean` regenerates android/ on every CI run.
const ABIS = ['armeabi-v7a', 'arm64-v8a', 'x86_64'];
const MARKER = 'maglev-abi-splits';

const SPLITS_BLOCK = `
    // ${MARKER}
    splits {
        abi {
            reset()
            enable true
            universalApk true
            include "arm64-v8a", "armeabi-v7a", "x86_64"
        }
    }
`;

// Top-level (outside android {}). Uses the stable androidComponents API, which
// works on AGP 8.x and 9.x (applicationVariants / OutputFile were removed in 9).
const VERSION_CODE_BLOCK = `
// ${MARKER}-versioncodes
def abiCodes = ["armeabi-v7a": 1, "x86_64": 3, "arm64-v8a": 4]
androidComponents {
    onVariants(selector().all()) { variant ->
        variant.outputs.each { output ->
            def abiFilter = output.filters.find { it.filterType.name() == "ABI" }
            if (abiFilter != null) {
                def base = output.versionCode.getOrElse(1)
                output.versionCode.set(base * 10 + abiCodes.get(abiFilter.identifier, 0))
            }
        }
    }
}
`;

/** Pure transform: inject splits + versionCode mapping into app/build.gradle text. Idempotent. */
function applyAbiSplits(src) {
  if (src.includes(MARKER)) return src;
  const m = /^android\s*\{[^\n]*\n/m.exec(src);
  if (!m) throw new Error('withAbiSplits: could not find `android {` block in app/build.gradle');
  const at = m.index + m[0].length;
  let out = src.slice(0, at) + SPLITS_BLOCK + src.slice(at);
  if (!out.endsWith('\n')) out += '\n';
  return out + VERSION_CODE_BLOCK;
}

/** Pure transform for gradle.properties entries (array of {type,key,value}). */
function applyArchitectures(props) {
  const value = ABIS.join(',');
  const out = props.filter((p) => !(p.type === 'property' && p.key === 'reactNativeArchitectures'));
  out.push({ type: 'property', key: 'reactNativeArchitectures', value });
  return out;
}

function withAbiSplits(config) {
  const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');
  config = withAppBuildGradle(config, (c) => {
    c.modResults.contents = applyAbiSplits(c.modResults.contents);
    return c;
  });
  config = withGradleProperties(config, (c) => {
    c.modResults = applyArchitectures(c.modResults);
    return c;
  });
  return config;
}

module.exports = withAbiSplits;
module.exports.applyAbiSplits = applyAbiSplits;
module.exports.applyArchitectures = applyArchitectures;
