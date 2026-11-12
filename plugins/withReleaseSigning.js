// Expo config plugin: sign release builds with a real key supplied through env vars.
// Gradle reads the env at build time (not at prebuild), so `expo prebuild` stays secret-free.
// Without MAGLEV_KEYSTORE_PATH (or when the file is missing) the template's debug signing is kept,
// so local builds, forks and PRs without secrets still build.
const MARKER = 'maglev-release-signing';

// Appended after the template's own `android {}` block, so its buildTypes override wins.
// Docs: https://developer.android.com/build/building-cmdline#sign_cmdline
//       https://developer.android.com/reference/tools/gradle-api/8.3/com/android/build/api/dsl/ApkSigningConfig
// v1 is off: minSdk is 24 (Android 7.0), the release that introduced v2 (https://source.android.com/docs/security/features/apksigning/v2).
const SIGNING_BLOCK = `
// ${MARKER}
def maglevKeystorePath = System.getenv("MAGLEV_KEYSTORE_PATH")
if (maglevKeystorePath && new File(maglevKeystorePath).exists()) {
    android {
        signingConfigs {
            release {
                storeFile new File(maglevKeystorePath)
                storePassword System.getenv("MAGLEV_KEYSTORE_PASSWORD")
                keyAlias System.getenv("MAGLEV_KEY_ALIAS")
                keyPassword System.getenv("MAGLEV_KEY_PASSWORD")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }
}
`;

/** Pure transform: append the env-driven release signing block to app/build.gradle text. Idempotent. */
function applyReleaseSigning(src) {
  if (src.includes(MARKER)) return src;
  if (!/^android\s*\{/m.test(src)) throw new Error('withReleaseSigning: could not find `android {` block in app/build.gradle');
  return (src.endsWith('\n') ? src : src + '\n') + SIGNING_BLOCK;
}

function withReleaseSigning(config) {
  const { withAppBuildGradle } = require('expo/config-plugins');
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = applyReleaseSigning(c.modResults.contents);
    return c;
  });
}

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
module.exports.MARKER = MARKER;
