/**
 * Regenerates modules/maglev-engine/android/src/main/assets/miners.txt (docs/NATIVE_CONTRACT.md section 24.4a).
 *
 *   node scripts/build-miners.js            fetch the upstream list once and write the asset
 *   node scripts/build-miners.js <file>     build from a local copy of the hosts file instead
 *
 * Upstream: hoshsadiq/adblock-nocoin-list, `hosts.txt` (in-browser crypto-mining domains). MIT licence.
 * The asset is merged into the ad and tracker block list at load time, so it applies to every list the user picks.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/hosts.txt';
const LICENSE = 'MIT (hoshsadiq/adblock-nocoin-list, https://github.com/hoshsadiq/adblock-nocoin-list/blob/master/LICENSE)';
const OUT = path.join(__dirname, '..', 'modules/maglev-engine/android/src/main/assets/miners.txt');
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validHost(h) {
  if (!h || h.length > 253 || !h.includes('.') || /^[0-9.]+$/.test(h)) return false;
  return h.split('.').every((l) => LABEL.test(l));
}

function parse(text) {
  const out = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/.exec(raw.replace(/#.*/, '').trim());
    if (m && validHost(m[1].toLowerCase())) out.add(m[1].toLowerCase());
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  const text = arg ? fs.readFileSync(arg, 'utf8') : await (await fetch(SOURCE_URL)).text();
  const domains = [...parse(text)].sort();
  if (domains.length < 100) throw new Error(`only ${domains.length} domains found, refusing to write`);
  const header = [
    '# Maglev crypto-mining block list',
    `# Source: ${SOURCE_URL}`,
    `# License: ${LICENSE}`,
    `# Date: ${new Date().toISOString().slice(0, 10)}`,
    `# Domains: ${domains.length}`,
    '# One domain per line. A request to a listed domain or any subdomain of it is blocked.',
    '# Rebuild with: node scripts/build-miners.js',
  ].join('\n');
  fs.writeFileSync(OUT, `${header}\n${domains.join('\n')}\n`);
  console.log(`wrote ${domains.length} domains`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
