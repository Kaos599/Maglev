#!/usr/bin/env node
// 0.32 UI: (1) Change folder on Add download / Add torrent is for this download only, (2) "engine" is "downloader"
// in copy, (3) torrent internals live on Settings > Network > Advanced, (4) the restart banner and block list status.
// Needs Node 22.18+ (imports the TypeScript helpers directly).
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  // 1. Per-download folder (B1)
  console.log('B1: Change folder is for this download only');
  const F = await import('../utils/downloadFolder.ts');
  const fail = () => { throw new Error('must not be called'); };
  check('cancelled pick', (await F.pickFolderForThisDownload(async () => ({ cancelled: true }))).kind === 'cancelled');
  const direct = await F.pickFolderForThisDownload(async () => ({ ok: true, uri: 'content://x', displayName: 'Movies', mode: 'direct', path: '/storage/emulated/0/Movies' }));
  check('direct folder gives its path and name', direct.kind === 'ok' && direct.path === '/storage/emulated/0/Movies' && direct.label === 'Movies');
  const staged = await F.pickFolderForThisDownload(async () => ({ ok: true, uri: 'content://x', displayName: 'SD card', mode: 'staging', path: null }));
  check('a folder with no direct path is unsupported, not silently the default', staged.kind === 'unsupported');
  void fail;

  const addDownload = read('app/add-download.tsx');
  const addTorrent = read('app/add-torrent.tsx');
  for (const [name, src] of [['add-download', addDownload], ['add-torrent', addTorrent]]) {
    check(`${name}: Change uses pickFolder (not the default-saving pickDownloadFolder)`,
      /pickFolderForThisDownload\(\(\) => maglevEngine\.pickFolder\(\)\)/.test(src) && !/pickDownloadFolder/.test(src));
    check(`${name}: an unsupported folder shows a plain notice`, /notices\.inline\.folderNotDirect/.test(src));
  }
  check('add-download passes the picked folder to startDownload', /\.\.\.\(folderPath \? \{ folder: folderPath \} : \{\}\)/.test(addDownload));
  check('add-torrent passes the picked folder as outputFolder (both add paths)',
    (addTorrent.match(/outputFolder: folder\?\.uri \?\? null/g) || []).length === 2);
  check('Settings, Storage and onboarding still set the default', /pickDownloadFolder/.test(read('app/settings/storage.tsx')) && /pickDownloadFolder/.test(read('app/onboarding.tsx')));
  check('PickFolderResult carries the optional path', /path\?: string \| null/.test(read('modules/maglev-engine/src/MaglevEngine.types.ts')));

  // 2. "engine" -> "downloader" in copy
  console.log('Copy: engine -> downloader');
  const copy = read('constants/copy.ts');
  const addErr = read('utils/addErrorNotice.ts');
  check("engineError title is \"The downloader didn't start\"", /engineError: \{\s*title: "The downloader didn't start"/.test(copy));
  check("engineStopped title is 'The downloader stopped'", /title: 'The downloader stopped'/.test(copy));
  check("button is 'Start the downloader'", /START_ENGINE_LABEL = 'Start the downloader'/.test(addErr));
  const errScreen = read('app/engine-error.tsx');
  check('error screen messages say downloader', /The downloader took too long to start\./.test(errScreen) && /The downloader didn't say why\./.test(errScreen));
  check("assistant NOT_READY says downloader", /The downloader isn't ready yet\./.test(read('utils/assistant/toolRunner.ts')));
  const gone = ['Engine failed to start', 'Start engine', 'The download engine'];
  const shown = ['constants/copy.ts', 'utils/addErrorNotice.ts', 'app/engine-error.tsx', 'utils/assistant/toolRunner.ts', 'modules/maglev-engine/src/MaglevNativeBridge.ts']
    .map((f) => read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'));
  for (const s of gone) check(`no "${s}" left in user-facing copy`, shown.every((t) => !t.includes(s)));

  // 3. Advanced network page
  console.log('Network: Advanced page');
  const network = read('app/settings/network.tsx');
  const advanced = read('app/settings/network-advanced.tsx');
  check('Network keeps Wi-Fi only, mobile data, VPN, networks', ['Wi-Fi only', 'Share on mobile data', 'Only download over a VPN', 'Only on these networks'].every((t) => network.includes(`title="${t}"`)));
  for (const t of ['Incoming port', 'UPnP', 'DHT', 'Local peer discovery', 'SOCKS5 proxy', 'Block listed IPs']) {
    check(`'${t}' moved to Advanced`, advanced.includes(`title="${t}"`) && !network.includes(`title="${t}"`));
  }
  check('Network links to the Advanced page', /router\.push\('\/settings\/network-advanced'/.test(network));
  check('Advanced page is registered in the layout', /settings\/network-advanced/.test(read('app/_layout.tsx')));
  const { SETTINGS_INDEX } = await import('../utils/settingsIndex.ts');
  const byId = (id) => SETTINGS_INDEX.find((e) => e.id === id);
  for (const id of ['network-port', 'network-upnp', 'network-dht', 'network-lsd', 'network-proxy-enable', 'network-proxy-host', 'network-proxy-port', 'network-proxy-user', 'network-proxy-pass', 'network-ip-blocklist']) {
    check(`search: ${id} opens network-advanced`, byId(id)?.page === 'network-advanced');
  }
  check('search: the Advanced row itself is indexed on Network', byId('network-advanced')?.page === 'network');
  check('search: Wi-Fi only still opens network', byId('network-wifi-only')?.page === 'network');

  // 4. Restart banner and block list status
  console.log('Native status UI');
  const S = await import('../utils/networkStatus.ts');
  check('reads restartPending (camel)', S.readNetworkStatus({ ok: true, restartPending: true }).restartPending === true);
  check('reads restart_pending (snake)', S.readNetworkStatus({ ok: true, restart_pending: false }).restartPending === false);
  check('missing fields stay unknown', (() => { const r = S.readNetworkStatus({ ok: true }); return r.restartPending === null && r.blocklist === null; })());
  check('reads the block list state and rules', (() => { const r = S.readNetworkStatus({ blocklist: { state: 'on', rules: 1200 } }); return r.blocklist.state === 'on' && r.blocklist.rules === 1200; })());
  check('ignores a block list state it does not know', S.readNetworkStatus({ blocklist: { state: 'weird', rules: 3 } }).blocklist === null);
  const un = S.blocklistSubtitle('list.p2p', { state: 'unreadable', rules: 0 });
  check("unreadable: danger subtitle \"Couldn't read the block list\"", un.danger === true && un.text === "Couldn't read the block list");
  const on = S.blocklistSubtitle('list.p2p', { state: 'on', rules: 1200 });
  check('on: file name and rule count', !on.danger && on.text === 'list.p2p · 1200 rules');
  check('on: one rule is singular', S.blocklistSubtitle('a', { state: 'on', rules: 1 }).text === 'a · 1 rule');
  check('no file and no status: "No file chosen"', S.blocklistSubtitle('', null).text === 'No file chosen');

  const banner = read('components/settings/NetworkRestartBanner.tsx');
  check('banner says "Restart the downloader to apply these changes" with a Restart action',
    /restartTitle: 'Restart the downloader to apply these changes'/.test(read('constants/copy.ts')) && /restartAction: 'Restart'/.test(read('constants/copy.ts')) && /copy\.restartTitle/.test(banner));
  check('restart calls the module restartEngine when present and treats ok:false as a failure', /typeof maglevEngine\.restartEngine === 'function'/.test(banner) && /ok === false/.test(banner));
  check('restart has a busy state and notices for done and error', /setBusy\(true\)/.test(banner) && /copy\.restarted/.test(banner) && /copy\.restartFailed/.test(banner));
  check('banner appears on Network and Advanced', /NetworkRestartBanner/.test(network) && /NetworkRestartBanner/.test(advanced));
  check('old "Takes effect next launch" chip is gone', !/Takes effect next launch/.test(network + advanced + banner));
  check('block list row uses the danger subtitle tone', /subtitleTone=\{blocklistLine\.danger \? 'danger' : undefined\}/.test(advanced) && /subtitleTone === 'danger'/.test(read('components/ui/ListRow.tsx')));
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  check('types: EffectiveConfig carries restartPending and the blocklist status', /restartPending: boolean/.test(types) && /export type BlocklistState = 'off' \| 'on' \| 'unreadable'/.test(types) && /restartEngine\(\): Promise<EngineResult>/.test(types));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\n0.32 UI checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
