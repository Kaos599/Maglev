// Expo config plugin: allow plain http from the app's JS `fetch` in release builds.
// Why: the assistant's custom provider (Ollama) is reached at http://192.168.x.x:11434. Android 9+ blocks
// cleartext traffic by default, and only dev builds relax that, so a release build could never reach it.
// Limits: Android's network-security-config matches domains only, never IP ranges, so it cannot say "private
// addresses only". The base config therefore permits cleartext everywhere, with the system trust anchors only
// (no user-installed CAs). The real restriction lives in app code: utils/prefs/assistant.ts checkBaseUrl accepts
// http only for private hosts. This config does not touch the Rust engine: its sockets (reqwest, librqbit) bypass
// the Android policy and enforce their own rules.
// If the manifest already names another networkSecurityConfig, it is left alone and a warning is printed.
// Docs: https://developer.android.com/privacy-and-security/security-config
const CONFIG_NAME = 'maglev_network_security_config';
const CONFIG_REF = '@xml/' + CONFIG_NAME;

const networkSecurityXml = () =>
  '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n' +
  '  <base-config cleartextTrafficPermitted="true">\n' +
  '    <trust-anchors>\n' +
  '      <certificates src="system"/>\n' +
  '    </trust-anchors>\n' +
  '  </base-config>\n' +
  '</network-security-config>\n';

/**
 * Pure transform for the <application> manifest node. Idempotent. Returns true when ours is in place, false when
 * another config is already set (kept untouched).
 */
function applyNetworkSecurityConfig(app) {
  app.$ = app.$ || {};
  const current = app.$['android:networkSecurityConfig'];
  if (current && current !== CONFIG_REF) return false;
  app.$['android:networkSecurityConfig'] = CONFIG_REF;
  // The config wins over usesCleartextTraffic on API 24+, so a leftover "false" would only confuse.
  delete app.$['android:usesCleartextTraffic'];
  return true;
}

function withCleartextLan(config) {
  const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
  const fs = require('fs');
  const path = require('path');
  let ours = true;
  config = withAndroidManifest(config, (c) => {
    ours = applyNetworkSecurityConfig(c.modResults.manifest.application[0]);
    if (!ours) console.warn('withCleartextLan: a networkSecurityConfig already exists, cleartext not enabled.');
    return c;
  });
  config = withDangerousMod(config, [
    'android',
    (c) => {
      if (!ours) return c;
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CONFIG_NAME + '.xml'), networkSecurityXml());
      return c;
    },
  ]);
  return config;
}

module.exports = withCleartextLan;
module.exports.networkSecurityXml = networkSecurityXml;
module.exports.applyNetworkSecurityConfig = applyNetworkSecurityConfig;
