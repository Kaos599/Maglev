// Expo config plugin: keep the engine's session and in-progress downloads out of Android Auto Backup.
// The session folder (`filesDir/session`, StorageManager.sessionDir) holds librqbit's resume state, which is
// tied to this install and useless on another device. Staging and fallback downloads live in
// `getExternalFilesDir(DOWNLOADS)` (domain "external"), which can be gigabytes.
// - Android 6-11 reads android:fullBackupContent; Android 12+ reads android:dataExtractionRules (cloud + device transfer).
// Docs: https://developer.android.com/identity/data/autobackup
const FULL_BACKUP = '@xml/maglev_backup_rules';
const DATA_EXTRACTION = '@xml/maglev_data_extraction_rules';

const EXCLUDES = [
  '<exclude domain="file" path="session/"/>',
  '<exclude domain="external" path="Download/"/>',
];

const fullBackupXml = () =>
  `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n${EXCLUDES.map((e) => '  ' + e).join('\n')}\n</full-backup-content>\n`;

const dataExtractionXml = () => {
  const body = EXCLUDES.map((e) => '    ' + e).join('\n');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n' +
    `  <cloud-backup>\n${body}\n  </cloud-backup>\n` +
    `  <device-transfer>\n${body}\n  </device-transfer>\n` +
    '</data-extraction-rules>\n'
  );
};

/** Pure transform for the <application> manifest node. Idempotent. */
function applyBackupAttributes(app) {
  app.$ = app.$ || {};
  app.$['android:fullBackupContent'] = FULL_BACKUP;
  app.$['android:dataExtractionRules'] = DATA_EXTRACTION;
  return app;
}

function withBackupRules(config) {
  const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
  const fs = require('fs');
  const path = require('path');
  config = withAndroidManifest(config, (c) => {
    applyBackupAttributes(c.modResults.manifest.application[0]);
    return c;
  });
  config = withDangerousMod(config, [
    'android',
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'maglev_backup_rules.xml'), fullBackupXml());
      fs.writeFileSync(path.join(dir, 'maglev_data_extraction_rules.xml'), dataExtractionXml());
      return c;
    },
  ]);
  return config;
}

module.exports = withBackupRules;
module.exports.fullBackupXml = fullBackupXml;
module.exports.dataExtractionXml = dataExtractionXml;
module.exports.applyBackupAttributes = applyBackupAttributes;
