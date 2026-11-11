#!/usr/bin/env node
// Tracker address rules (NATIVE_CONTRACT 15). Mirrors the Rust tests in native/maglev-core/src/trackers.rs.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

async function main() {
  const t = await import('../modules/maglev-engine/src/trackerUrl.ts');
  const url = (s) => {
    const r = t.validateTrackerUrl(s);
    return r.ok ? r.url : null;
  };

  check('udp with port', url('udp://tracker.opentrackr.org:1337/announce') === 'udp://tracker.opentrackr.org:1337/announce');
  check('lower-cases scheme and host', url('  HTTPS://Tracker.Example.com/announce?x=1 ') === 'https://tracker.example.com/announce?x=1');
  check('empty path becomes /', url('http://t.example.com') === 'http://t.example.com/');
  check('default http port dropped', url('http://t.example.com:80/a') === 'http://t.example.com/a');
  check('default https port dropped', url('https://t.example.com:443/a') === 'https://t.example.com/a');
  check('udp keeps port 80', url('udp://t.example.com:80/a') === 'udp://t.example.com:80/a');
  check('fragment dropped', url('http://t.example.com/a#frag') === 'http://t.example.com/a');
  check('ipv6 host', url('udp://[2001:db8::1]:80/announce') === 'udp://[2001:db8::1]:80/announce');

  for (const bad of [
    '', '   ', 'tracker.example.com/announce', 'magnet:?xt=urn:btih:abc', 'ftp://t.example.com/a', 'ws://t.example.com/a',
    'http://', 'http:///announce', 'udp://t.example.com/announce', 'udp://t.example.com:0/announce',
    'http://t.example.com:99999/a', 'http://t.example.com:abc/a', 'http://us er@t.example.com/a',
    'http://user:pw@t.example.com/a', 'http://t.exa$mple.com/a', 'http://::1/a', 'udp://[2001:db8::1/announce',
    `http://t.example.com/${'a'.repeat(2100)}`,
  ]) {
    check(`rejects ${JSON.stringify(bad.slice(0, 40))}`, url(bad) === null);
  }

  const list = t.checkTrackerLines(['udp://a.example.com:1337/announce', '', '  ', 'UDP://A.example.com:1337/announce', 'http://b.example.com']);
  check('list skips blanks and repeats', list.ok && list.urls.length === 2 && list.urls[1] === 'http://b.example.com/');
  const badList = t.checkTrackerLines(['udp://a.example.com:1337/announce', 'nonsense']);
  check('one bad line fails the list and names it', !badList.ok && badList.message.includes('nonsense'));
  check('empty list is refused', !t.checkTrackerLines(['', ' ']).ok);
  const many = Array.from({ length: t.MAX_TRACKERS_PER_CALL + 1 }, (_, i) => `http://t${i}.example.com/announce`);
  check('more than the limit is refused', !t.checkTrackerLines(many).ok);
  const pasted = t.checkTrackerText('udp://a.example.com:1337/announce\r\n\r\nhttp://b.example.com/announce\n');
  check('pasted text splits on lines', pasted.ok && pasted.urls.length === 2);
  check('key ignores case and default port', t.trackerKey('http://T.example.com:80/a') === t.trackerKey('http://t.example.com/a'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
