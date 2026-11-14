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

console.log(`manifest permissions OK: ${declared.length} declared, ${blocked.length} blocked`);
