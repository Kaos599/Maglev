/**
 * Regenerates modules/maglev-engine/android/src/main/assets/blocklist.txt (docs/NATIVE_CONTRACT.md section 24.4).
 *
 *   node scripts/build-blocklist.js            fetch the upstream list once and write the asset
 *   node scripts/build-blocklist.js <file>     build from a local copy of the hosts file instead
 *
 * Upstream: StevenBlack/hosts, base "unified" list (ads, trackers, malware). MIT licence for the project; the list merges
 * public sources. The asset keeps one registrable domain per line: a child of a listed domain is dropped because
 * the app matches every parent suffix. The result must stay at or under 400 KB gzipped (APK assets are deflated).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
const LICENSE = 'MIT (StevenBlack/hosts, https://github.com/StevenBlack/hosts/blob/master/license.txt)';
const OUT = path.join(__dirname, '..', 'modules/maglev-engine/android/src/main/assets/blocklist.txt');
const MAX_GZ = 400 * 1024;
const LOCAL = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost', 'ip6-loopback',
  'ip6-localnet', 'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters', 'ip6-allhosts', '0.0.0.0']);
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validHost(h) {
  if (!h || h.length > 253 || LOCAL.has(h) || !h.includes('.')) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  const labels = h.split('.');
  return labels.every((l) => LABEL.test(l)) && !/^[0-9]+$/.test(labels[labels.length - 1]);
}

function parseHosts(text) {
  const out = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/.exec(line);
    if (m && validHost(m[1].toLowerCase())) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Drops every host that already has a listed parent suffix. */
function collapse(set) {
  const keep = [];
  for (const h of set) {
    const labels = h.split('.');
    let covered = false;
    for (let i = 1; i < labels.length - 1 && !covered; i++) covered = set.has(labels.slice(i).join('.'));
    if (!covered) keep.push(h);
  }
  return keep.sort();
}

async function main() {
  const arg = process.argv[2];
  const text = arg ? fs.readFileSync(arg, 'utf8') : await (await fetch(SOURCE_URL)).text();
  const parsed = parseHosts(text);
  const domains = collapse(parsed);
  const date = new Date().toISOString().slice(0, 10);
  const header = [
    '# Maglev ad and tracker block list',
    `# Source: ${SOURCE_URL}`,
    `# License: ${LICENSE}`,
    `# Date: ${date}`,
    `# Domains: ${domains.length}`,
    '# One domain per line. A request to a listed domain or any subdomain of it is blocked.',
    '# Rebuild with: node scripts/build-blocklist.js',
  ].join('\n');
  const body = `${header}\n${domains.join('\n')}\n`;
  const gz = zlib.gzipSync(body, { level: 9 }).length;
  if (gz > MAX_GZ) throw new Error(`asset is ${gz} bytes gzipped, over the ${MAX_GZ} limit`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`parsed ${parsed.size} hosts, wrote ${domains.length} domains, ${body.length} bytes (${gz} gzipped)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
