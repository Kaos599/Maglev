// Contract: the release manifest declares only the permissions Maglev uses on purpose.
// SYSTEM_ALERT_WINDOW comes from Expo's base manifest template (prebuild-config), USE_BIOMETRIC and
// USE_FINGERPRINT from the androidx.biometric AAR that expo-secure-store depends on. Maglev uses neither
// overlays nor a biometric prompt, so app.json must block them (android.blockedPermissions).
const assert = require('assert');
const path = require('path');

const android = require(path.join('..', 'app.json')).expo.android;

const MUST_BLOCK = [
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
];

// Permissions Maglev declares on purpose (short names, as written in app.json android.permissions).
const ALLOWED = [
  'INTERNET',
  'ACCESS_NETWORK_STATE',
  'ACCESS_WIFI_STATE',
  'WAKE_LOCK',
  'FOREGROUND_SERVICE',
  'FOREGROUND_SERVICE_DATA_SYNC',
  'FOREGROUND_SERVICE_SPECIAL_USE',
  'POST_NOTIFICATIONS',
  'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];

const blocked = android.blockedPermissions || [];
for (const p of MUST_BLOCK) {
  assert(blocked.includes(p), `app.json android.blockedPermissions must include ${p}`);
}

const declared = android.permissions || [];
for (const p of declared) {
  assert(ALLOWED.includes(p.replace(/^android\.permission\./, '')), `permission ${p} is not on the allow-list in scripts/test-manifest-permissions.js`);
  assert(!blocked.includes(p) && !blocked.includes('android.permission.' + p), `${p} is both declared and blocked`);
}
for (const p of ALLOWED) assert(declared.includes(p), `allow-listed permission ${p} is missing from app.json android.permissions`);

// In-app updater (contract 27.5): added by plugins/withSelfUpdate.js, not by app.json android.permissions.
// A PLAY BUILD must drop the updater, the plugin and every permission below (Play forbids self-updating apps).
const SELF_UPDATE = [
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION',
  'android.permission.ENFORCE_UPDATE_OWNERSHIP',
];
const selfUpdate = require(path.join('..', 'plugins', 'withSelfUpdate.js'));
const manifest = selfUpdate.addSelfUpdatePermissions({});
const names = manifest['uses-permission'].map((p) => p.$['android:name']);
for (const p of SELF_UPDATE) {
  assert(names.includes(p), `plugins/withSelfUpdate.js must add ${p}`);
  assert(!blocked.includes(p), `${p} is needed by the updater and must not be in android.blockedPermissions`);
}
assert.strictEqual(names.length, SELF_UPDATE.length, 'withSelfUpdate adds exactly the updater permissions');
assert.strictEqual(selfUpdate.addSelfUpdatePermissions(manifest)['uses-permission'].length, SELF_UPDATE.length, 'plugin is idempotent');
assert((require(path.join('..', 'app.json')).expo.plugins || []).includes('./plugins/withSelfUpdate.js'), 'app.json must register ./plugins/withSelfUpdate.js');

console.log(`manifest permissions OK: ${declared.length} declared, ${blocked.length} blocked`);
