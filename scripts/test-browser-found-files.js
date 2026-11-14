#!/usr/bin/env node
// Browser found-files list: sizes, Clear, per-item remove, reset on navigation, and the size probe's limits.
// Needs Node 22.18+ (runs TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mk = (id, over = {}) => ({
  id, url: `https://cdn.test/${id}.mp4`, kind: 'video', mime: 'video/mp4', ext: 'mp4', name: `${id}.mp4`,
  size: null, width: null, height: null, source: 'network', stream: null, pageUrl: 'https://site.test/a', pageTitle: 'A', ...over,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const f = await import('../components/browser/foundFilter.ts');
  const s = await import('../utils/foundSize.ts');
  const { formatBytes } = await import('../constants/format.ts');

  console.log('size label');
  check('exact size uses the shared formatter', f.foundSizeLabel({ size: 5 * 1024 * 1024 }) === formatBytes(5 * 1024 * 1024));
  check('unknown shows an em dash', f.foundSizeLabel({ size: null }) === '—' && f.foundSizeLabel({}) === '—');
  check('zero or junk is unknown, never "0 B"', f.foundSizeLabel({ size: 0 }) === '—' && f.foundSizeLabel({ size: NaN }) === '—' && f.foundSizeLabel({ size: -4 }) === '—');
  check('estimate gets a tilde', f.foundSizeLabel({ size: 1.2 * 1024 ** 3, estimate: true }) === '~' + formatBytes(1.2 * 1024 ** 3));
  check('an unknown estimate is still an em dash', f.foundSizeLabel({ size: null, estimate: true }) === '—');
  check('quality and type', f.foundDetail(mk('a', { height: 1080 })) === '1080p' && f.foundDetail(mk('b')) === 'MP4' && f.foundDetail(mk('c', { stream: 'hls', ext: 'm3u8' })) === 'HLS');
  check('no type, no quality: nothing invented', f.foundDetail(mk('d', { ext: null, mime: null, name: 'file' })) === null);
  {
    const src = read('components/browser/FoundTray.tsx');
    check('tray shows size through foundSizeLabel, not its own math', /foundSizeLabel\(/.test(src) && !/item\.size != null \? formatBytes/.test(src));
  }

  console.log('clear and remove');
  const items = [mk('a'), mk('b'), mk('c')];
  check('clearFound empties the list', Array.isArray(f.clearFound()) && f.clearFound().length === 0);
  check('removeFound drops one id', f.removeFound(items, 'b').map((i) => i.id).join() === 'a,c');
  check('removeFound leaves the input alone', items.length === 3);
  check('removeFound with an unknown id changes nothing', f.removeFound(items, 'zz').length === 3);
  {
    const master = mk('m', { url: 'https://cdn.test/v/master.m3u8', stream: 'hls', ext: 'm3u8' });
    const variant = mk('v', { url: 'https://cdn.test/v/720/index.m3u8', stream: 'hls', ext: 'm3u8' });
    const all = [master, variant];
    check('premise: the variant is hidden behind its master', f.hideVariantPlaylists(all).length === 1);
    check('removing a master does not surface its variants', f.removeFound(all, 'm').length === 0);
  }
  {
    const tray = read('components/browser/FoundTray.tsx');
    const br = read('app/browser.tsx');
    check('tray has a Clear action wired to the screen', /onClear/.test(tray) && /onClear=\{/.test(br));
    check('tray has a per-item remove wired to the screen', /onRemove/.test(tray) && /onRemove=\{/.test(br));
    check('remove button has a 44px target', /hitSlop/.test(tray) && /44/.test(tray));
    check('Clear label comes from copy', /foundTray\./.test(tray) && /foundTray/.test(read('constants/copy.ts')));
  }

  console.log('navigation resets the list');
  const onA = [mk('a'), mk('b')];
  const onB = [mk('c', { pageUrl: 'https://site.test/b' })];
  check('a new document drops the old page’s files', f.pruneToPage([...onA, ...onB], 'https://site.test/b').map((i) => i.id).join() === 'c');
  check('same document keeps everything', f.pruneToPage(onA, 'https://site.test/a').length === 2);
  check('a hash change is the same document', f.pruneToPage(onA, 'https://site.test/a#part2').length === 2);
  check('a query change is a new document', f.pruneToPage(onA, 'https://site.test/a?p=2').length === 0);
  check('about:blank clears nothing mid-load', f.pruneToPage(onA, 'about:blank').length === 2 && f.pruneToPage(onA, '').length === 2);
  {
    const br = read('app/browser.tsx');
    check('the screen prunes on page change', /pruneToPage\(/.test(br));
  }

  console.log('size probe');
  check('timeout is short and set', s.PROBE_TIMEOUT_MS > 0 && s.PROBE_TIMEOUT_MS <= 10000);
  check('concurrency is capped at a small number', s.PROBE_CONCURRENCY >= 1 && s.PROBE_CONCURRENCY <= 4);
  check('probe skips local network hosts', !s.isProbeable('http://192.168.1.4/x.mp4') && !s.isProbeable('http://localhost/x') && !s.isProbeable('http://10.0.0.2/x') && !s.isProbeable('ftp://a.test/x') && s.isProbeable('https://cdn.test/x.mp4'));

  const resp = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push(init.method + (init.headers.Range ? ' ' + init.headers.Range : '')); return resp(200, { 'content-length': '4096' }); };
    check('HEAD content-length', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === 4096 && calls.join() === 'HEAD');
  }
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init.method);
      return init.method === 'HEAD' ? resp(405) : resp(206, { 'content-range': 'bytes 0-0/9000', 'content-length': '1' });
    };
    check('HEAD fails, ranged GET reads the total from Content-Range', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === 9000 && calls.join() === 'HEAD,GET');
  }
  {
    const fetchImpl = async (url, init) => (init.method === 'HEAD' ? resp(405) : resp(200, { 'content-length': '777' }));
    check('a 200 to a ranged GET means no range support: never the body length of one byte', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === 777);
  }
  {
    const fetchImpl = async () => resp(200, {});
    check('no length anywhere is null, not 0', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === null);
  }
  {
    const fetchImpl = async () => resp(200, { 'content-length': '0' });
    check('zero length is unknown', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === null);
  }
  {
    const fetchImpl = async () => { throw new Error('network'); };
    check('network error is null', (await s.fetchContentLength('https://cdn.test/a.mp4', {}, fetchImpl)) === null);
  }
  {
    const fetchImpl = (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    const t0 = Date.now();
    const p = s.createSizeProber({ timeoutMs: 60 });
    const v = await p.run('k', () => s.fetchContentLength('https://cdn.test/slow.mp4', {}, fetchImpl, 60));
    check('a hanging request gives up at the timeout', v === null && Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  }
  {
    let live = 0, peak = 0;
    const p = s.createSizeProber({ concurrency: 2, timeoutMs: 1000 });
    const task = async () => { live++; peak = Math.max(peak, live); await sleep(15); live--; return 10; };
    await Promise.all(Array.from({ length: 8 }, (_, i) => p.run('u' + i, task)));
    check('never more than the cap in flight', peak === 2, `peak ${peak}`);
  }
  {
    let n = 0;
    const p = s.createSizeProber({ concurrency: 2, timeoutMs: 1000 });
    const task = async () => { n++; return 42; };
    const [a, b] = await Promise.all([p.run('same', task), p.run('same', task)]);
    const c = await p.run('same', task);
    check('one request per URL, shared and cached', n === 1 && a === 42 && b === 42 && c === 42);
    check('cache is readable without a request', p.peek('same') === 42 && p.peek('other') === undefined);
  }
  {
    const p = s.createSizeProber({ concurrency: 1, timeoutMs: 1000 });
    await p.run('bad', async () => null);
    let n = 0;
    await p.run('bad', async () => { n++; return null; });
    check('an unknown answer is cached too (no hammering a server that will not say)', n === 0);
  }

  console.log('stream estimate');
  const v = (o) => ({ id: 'x', height: null, width: null, bandwidth: 0, codecs: null, estBytes: null, audio: 'muxed', ...o });
  check('largest quality estimate, flagged as an estimate', JSON.stringify(s.streamEstimate([v({ height: 480, estBytes: 100 }), v({ height: 1080, estBytes: 900 })])) === JSON.stringify({ bytes: 900, height: 1080 }));
  check('no estimate in the manifest is null', s.streamEstimate([v({ height: 480 })]) === null && s.streamEstimate([]) === null);
  {
    const src = read('components/browser/useFoundSize.ts');
    check('streams are probed through the engine, not guessed', /probeStream/.test(src) && /streamEstimate\(/.test(src));
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
