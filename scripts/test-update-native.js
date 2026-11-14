#!/usr/bin/env node
// In-app updates, static checks on the Kotlin, manifest, plugin and wiring (docs/NATIVE_CONTRACT.md section 27.10).
// Gradle is never run locally, so this reads the source and proves the safety rules are there.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
/** Body of the Kotlin function whose declaration line matches `re`, by brace counting. */
function body(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

const dir = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/update/';
const upd = read(dir + 'AppUpdater.kt');
const rcv = read(dir + 'UpdateInstallReceiver.kt');
const src = read(dir + 'InstallSource.kt');
const rep = read(dir + 'UpdateReplacedReceiver.kt');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const manifest = read('modules/maglev-engine/android/src/main/AndroidManifest.xml');

console.log('[who updates]');
check('installer comes from getInstallSourceInfo on API 30+, getInstallerPackageName below', /Build\.VERSION_CODES\.R/.test(src) && /getInstallSourceInfo\(context\.packageName\)\.installingPackageName/.test(src) && /getInstallerPackageName/.test(src));
for (const id of ['org.fdroid.fdroid', 'org.fdroid.basic', 'com.looker.droidify', 'com.machiav3lli.fdroid', 'in.sunilpaulmathew.izzyondroid']) check(`${id} is fdroid`, src.includes(`"${id}"`));
check('Obtainium and its sub-packages, and Play', /dev\.imranr\.obtainium/.test(src) && /startsWith\("\$OBTAINIUM\."\)/.test(src) && /com\.android\.vending/.test(src));
check('module exposes getInstallSource with managedBy', /AsyncFunction\("getInstallSource"\)/.test(mod) && /"managedBy" to InstallSource\.managedBy\(installer\)/.test(mod));

console.log('\n[no updater code when managed]');
check('download refuses with MANAGED first', /fun download\([^)]*\)[^{]*\{\s*managed\(context\)\?\.let \{ return it \}/.test(upd));
check('install refuses with MANAGED first', /fun install\([^)]*\)[^{]*\{\s*managed\(context\)\?\.let \{ return it \}/.test(upd));
check('MANAGED comes from InstallSource.managedBy', /InstallSource\.managedBy\(context\) != null\) failure\("MANAGED"/.test(upd));
check('the TS store turns Managed on at start, and the machine ignores every event after it', /if \(managedBy\) dispatch\(\{ type: 'managed'/.test(read('utils/update/index.ts')) && /if \(s\.kind === 'managed'\) return s;/.test(read('utils/update/machine.ts')));
check('the wiring starts no check or download for a managed install', /if \(!managedBy\) \{[\s\S]*onActive/.test(read('utils/update/index.ts')) && /autoCheckDue/.test(read('utils/update/index.ts')));

console.log('\n[download]');
check('host allow-list is exactly the three GitHub hosts', /"github\.com"/.test(upd) && /"objects\.githubusercontent\.com"/.test(upd) && /"release-assets\.githubusercontent\.com"/.test(upd) && (upd.match(/ALLOWED_HOSTS: Set<String> = setOf\(([^)]*)\)/s)?.[1].match(/"/g) ?? []).length === 6);
check('only https URLs pass', /u\.protocol == "https"/.test(upd) && /u\.host\.lowercase\(\) in ALLOWED_HOSTS/.test(upd));
check('the URL is checked before downloading and on every redirect hop', /if \(!isAllowedUrl\(url\)\) return failure\("UPDATE_INVALID"/.test(upd) && /if \(!isAllowedUrl\(current\.toString\(\)\)\)/.test(upd));
check('redirects are followed by hand, at most 5', /instanceFollowRedirects = false/.test(upd) && /MAX_REDIRECTS = 5/.test(upd) && /\+\+hops > MAX_REDIRECTS/.test(upd));
check('60 s read timeout and 150 MB cap', /READ_TIMEOUT_MS = 60_000/.test(upd) && /MAX_BYTES = 150L \* 1024 \* 1024/.test(upd) && /bytes > MAX_BYTES/.test(upd));
check('writes <sha256>.apk.part, then renames', /"\$sha256\.apk\.part"/.test(upd) && /part\.renameTo\(done\)/.test(upd) && /File\(context\.cacheDir, "updates"\)/.test(upd));
check('resumable with Range', /"Range", "bytes=\$from-"/.test(upd) && /206 ->/.test(upd) && /416/.test(upd));
check('progress is throttled to 4 a second', /PROGRESS_EVERY_MS = 250L/.test(upd) && /"onUpdateProgress"/.test(upd));
check('one download at a time, a second joins the first', /FutureTask/.test(upd) && /cur != null && !cur\.isDone/.test(upd));
check('own HttpURLConnection, not the transfer engine', /HttpURLConnection/.test(upd) && !/EngineHost\.(addDownload|addTorrent)/.test(upd));
check('events are declared on the module', /Events\([^)]*"onUpdateProgress"[^)]*"onUpdateResult"/.test(mod));
check('error codes: NETWORK, HTTP_STATUS, STORAGE_FULL, UPDATE_INVALID, MANAGED', ['NETWORK', 'HTTP_STATUS', 'STORAGE_FULL', 'UPDATE_INVALID', 'MANAGED'].every((c) => upd.includes(`"${c}"`)));
check('cleanup deletes everything but the pending file', /fun cleanup\(context: Context, keepPath: String\?\)/.test(upd) && /AsyncFunction\("cleanupUpdates"\)/.test(mod));

console.log('\n[verify before every install]');
const verify = body(upd, /fun verify\(/);
check('SHA-256 of the file equals the expected one', /sha256Hex\(file\) != sha256\.lowercase\(\)/.test(verify) && /MessageDigest\.getInstance\("SHA-256"\)/.test(upd));
check('package name is com.maglev', /PACKAGE = "com\.maglev"/.test(upd) && /archive\.packageName != PACKAGE/.test(verify));
check('versionCode is greater than the installed one', /versionOf\(archive\) <= versionOf\(installed\)/.test(verify) && /longVersionCode/.test(upd));
check('signers equal the installed app (SHA-256 sets of apkContentsSigners)', /apkContentsSigners/.test(upd) && /a != signers\(installed\)/.test(verify) && /a\.isEmpty\(\)/.test(verify));
check('getPackageArchiveInfo with GET_SIGNING_CERTIFICATES and the API 33 overload', /GET_SIGNING_CERTIFICATES/.test(upd) && /PackageInfoFlags\.of\(flags\(\)\.toLong\(\)\)/.test(upd) && /getPackageArchiveInfo/.test(upd));
check('download verifies after the rename and deletes a bad file', /val bad = verify\(context, done, sha256\)/.test(upd) && /done\.delete\(\)/.test(upd));
const install = body(upd, /fun install\(/);
check('install verifies again, before opening a session', install.indexOf('verify(context, file, sha) != null') > -1 && install.indexOf('verify(context, file, sha) != null') < install.indexOf('createSession'));
check('install only reads files inside cacheDir/updates', /inUpdatesDir\(context, path\) \?: return failure\("UPDATE_INVALID"/.test(install));
check('the message for a failed check is the contract one', /This update didn't pass Maglev's checks, so it wasn't installed\./.test(upd));

console.log('\n[install]');
check('MODE_FULL_INSTALL session', /SessionParams\.MODE_FULL_INSTALL/.test(install));
const silentUse = [...install.matchAll(/USER_ACTION_NOT_REQUIRED/g)].length;
check('USER_ACTION_NOT_REQUIRED only with silent, API 31+', silentUse === 1 && /if \(silent && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) \{\s*params\.setRequireUserAction\(PackageInstaller\.SessionParams\.USER_ACTION_NOT_REQUIRED\)/.test(install));
check('setRequestUpdateOwnership only on API 34+', /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE\) \{[^}]*setRequestUpdateOwnership\(true\)/.test(install));
check('the status PendingIntent goes to UpdateInstallReceiver and is FLAG_MUTABLE on API 31+', /Intent\(context, UpdateInstallReceiver::class\.java\)/.test(install) && /FLAG_MUTABLE/.test(install) && /PendingIntent\.getBroadcast/.test(install) && /session\.commit\(pi\.intentSender\)/.test(install));
check('canRequestPackageInstalls() false returns needs_permission', /canRequestPackageInstalls\(\)/.test(install) && /"status" to "needs_permission"/.test(install));
check('needs_permission is checked before the session is created', install.indexOf('canRequestPackageInstalls') < install.indexOf('createSession'));
check('the permission button opens ACTION_MANAGE_UNKNOWN_APP_SOURCES for the package', /ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri\.parse\("package:\$\{context\.packageName\}"\)/.test(upd) && /AsyncFunction\("openInstallPermissionSettings"\)/.test(mod));
check('install and download run off the main thread', /ioScope\.launch \{ promise\.resolve\(Json\.camelize\(AppUpdater\.install/.test(mod) && /ioScope\.launch \{ promise\.resolve\(Json\.camelize\(AppUpdater\.download/.test(mod));

console.log('\n[receiver]');
check('handles STATUS_PENDING_USER_ACTION, SUCCESS, and failures', ['STATUS_PENDING_USER_ACTION', 'STATUS_SUCCESS', 'STATUS_FAILURE_ABORTED', 'STATUS_FAILURE_STORAGE'].every((s) => rcv.includes(s)));
check('starts the confirm intent in the foreground, else posts the Install notification', /if \(AppUpdater\.inForeground\)/.test(rcv) && /startActivity\(confirm\)/.test(rcv) && /UpdateNotices\.showConfirm/.test(rcv));
check('failures reach JS as onUpdateResult {ok:false, code, message}', /"onUpdateResult"/.test(rcv) && /linkedMapOf\("ok" to false, "code" to code, "message" to message\)/.test(rcv));
check('the receiver is declared and not exported', /<receiver\s+android:name="\.update\.UpdateInstallReceiver"\s+android:exported="false"/.test(manifest));
check('MY_PACKAGE_REPLACED posts the updated notice only for an install Maglev started', /<receiver\s+android:name="\.update\.UpdateReplacedReceiver"\s+android:exported="false">[\s\S]*?MY_PACKAGE_REPLACED/.test(manifest) && /installingVersion\(app\) \?: return/.test(rep) && /UpdateNotices\.show\(app, "updated", version\)/.test(rep));
check('foreground flag follows the activity', /AppUpdater\.inForeground = true/.test(mod) && /AppUpdater\.inForeground = false/.test(mod));
check('an Updates notification channel exists', /CH_UPDATES = "maglev_updates"/.test(read(dir + 'UpdateNotices.kt')) && /"Updates"/.test(read(dir + 'UpdateNotices.kt')));

console.log('\n[plugin and permissions]');
const plugin = require('../plugins/withSelfUpdate.js');
const m = plugin.addSelfUpdatePermissions({});
const names = m['uses-permission'].map((p) => p.$['android:name']);
check('the plugin adds REQUEST_INSTALL_PACKAGES and UPDATE_PACKAGES_WITHOUT_USER_ACTION', names.includes('android.permission.REQUEST_INSTALL_PACKAGES') && names.includes('android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION'));
check('and ENFORCE_UPDATE_OWNERSHIP, which setRequestUpdateOwnership requires', names.includes('android.permission.ENFORCE_UPDATE_OWNERSHIP'));
check('it is idempotent', plugin.addSelfUpdatePermissions(m)['uses-permission'].length === names.length);
const app = JSON.parse(read('app.json')).expo;
check('app.json registers the plugin', app.plugins.includes('./plugins/withSelfUpdate.js'));
check('app.json does not block the updater permissions', !(app.android.blockedPermissions || []).some((p) => /REQUEST_INSTALL_PACKAGES|UPDATE_PACKAGES_WITHOUT_USER_ACTION|ENFORCE_UPDATE_OWNERSHIP/.test(p)));
check('the plugin says a Play build must drop them', /PLAY BUILD/.test(read('plugins/withSelfUpdate.js')) && /PLAY BUILD/.test(read('scripts/test-manifest-permissions.js')));

console.log('\n[bridge]');
const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
for (const fn of ['getInstallSource', 'downloadUpdate', 'installUpdate', 'cancelUpdateDownload', 'onUpdateProgress', 'onUpdateResult']) check(`bridge exposes ${fn}`, new RegExp(`public (async )?${fn}\\(`).test(bridge));
const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
check('the mock never fakes a download or install', /downloadUpdate\(\)[^\n]*\{\s*return this\.updateUnavailable\(\)/.test(mock) && /installUpdate\(\)[^\n]*\{\s*return this\.updateUnavailable\(\)/.test(mock) && /managedBy: null/.test(mock));

console.log('\n[About and wiring]');
const layout = read('app/_layout.tsx');
check('_layout starts the updater once the engine is ready', /startUpdates\(\)/.test(layout));
const about = read('app/settings/about.tsx');
check('About has the check, mode picker, auto-check toggle and Report a bug', /updateCopy\.check\.title/.test(about) && /updateCopy\.modes\.map/.test(about) && /updateAutoCheck/.test(about) && /updateCopy\.report\.title/.test(about) && /buildIssueUrl/.test(about));
check('Report a bug sends version, Android release and device', /Platform\.constants/.test(about) && /buildIssueUrl\(\{ version: appVersion, android, device \}\)/.test(about));
check('managed installs see "Updates come from"', /updateCopy\.managedBy\(managedBy\)/.test(about));
check('the card uses the app Sheet and shows release notes as plain text', /<Sheet/.test(about) && /plainNotes\(notes\)/.test(about));
check('no raw hex colours in the updater UI', !/#[0-9a-fA-F]{6}\b/.test(about));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
