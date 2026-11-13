#!/usr/bin/env node
// Feeds tab badge: the shared "new items" store, the initial count from stored data, and the tab wiring.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const store = require(path.join(root, 'utils/feedsBadge.ts'));

// Store: set / get / subscribe
check('starts at 0', store.getFeedsNewCount() === 0);
let calls = 0;
const off = store.subscribeFeedsNewCount(() => calls++);
store.setFeedsNewCount(3);
check('set then get', store.getFeedsNewCount() === 3);
check('subscriber notified once', calls === 1);
store.setFeedsNewCount(3);
check('same value does not notify', calls === 1);
store.setFeedsNewCount(-4);
check('negative clamps to 0', store.getFeedsNewCount() === 0);
store.setFeedsNewCount(2.7);
check('fraction floors', store.getFeedsNewCount() === 2);
off();
store.setFeedsNewCount(9);
check('unsubscribe stops notifications', calls === 3);

// Initial count from stored feeds + ids + seen
const feeds = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const ids = { a: ['1', '2', '3'], b: ['x', 'y'], gone: ['q'] };
const seen = { a: ['1', '2'], b: ['x', 'y'] };
check('initial count: unseen ids of known feeds only', store.countNewFromStored(feeds, ids, seen) === 1);
check('initial count: no feeds is 0', store.countNewFromStored([], ids, seen) === 0);
check('initial count: nothing stored is 0', store.countNewFromStored(feeds, {}, {}) === 0);
check('initial count: unseen feed with no seen list counts all', store.countNewFromStored([{ id: 'a' }], ids, {}) === 3);

// Label helper
check('label 0 hidden', store.badgeLabel(0) === null);
check('label 7', store.badgeLabel(7) === '7');
check('label 99', store.badgeLabel(99) === '99');
check('label 100 is 99+', store.badgeLabel(100) === '99+');

// Static wiring
const layout = read('app/(tabs)/_layout.tsx');
check('TabButton has badge prop', /badge\?: number/.test(layout));
check('a11y label appends ", N new"', /, \$\{[^}]*\} new/.test(layout));
check('layout passes useFeedsNewCount to feeds', /useFeedsNewCount\(\)/.test(layout) && /tab\('feeds'[^\n]*feedsNew/.test(layout));
check('feeds screen publishes the count', /setFeedsNewCount\(/.test(read('app/(tabs)/feeds.tsx')));
check('feeds.ts re-exports the store', /feedsBadge/.test(read('utils/feeds.ts')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
