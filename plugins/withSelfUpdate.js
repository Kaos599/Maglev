// Expo config plugin: the permissions the in-app updater needs (docs/NATIVE_CONTRACT.md section 27.5).
//   REQUEST_INSTALL_PACKAGES              lets Maglev hand a downloaded APK to PackageInstaller.
//   UPDATE_PACKAGES_WITHOUT_USER_ACTION   (API 31+) lets an update by the installer of record skip the confirm screen.
//   ENFORCE_UPDATE_OWNERSHIP              (API 34+, normal permission) lets setRequestUpdateOwnership(true) work.
// PLAY BUILD: a Play build must remove the updater and all three permissions (Play does not allow self-updating
// apps). Drop this plugin from app.json and the updater code paths; scripts/test-manifest-permissions.js says so.
const PERMISSIONS = [
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION',
  'android.permission.ENFORCE_UPDATE_OWNERSHIP',
];

/** Pure transform for the <manifest> node. Idempotent. */
function addSelfUpdatePermissions(manifest) {
  const list = (manifest['uses-permission'] = manifest['uses-permission'] || []);
  for (const name of PERMISSIONS) {
    if (!list.some((p) => p.$ && p.$['android:name'] === name)) list.push({ $: { 'android:name': name } });
  }
  return manifest;
}

function withSelfUpdate(config) {
  const { withAndroidManifest } = require('expo/config-plugins');
  return withAndroidManifest(config, (c) => {
    addSelfUpdatePermissions(c.modResults.manifest);
    return c;
  });
}

module.exports = withSelfUpdate;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.addSelfUpdatePermissions = addSelfUpdatePermissions;
