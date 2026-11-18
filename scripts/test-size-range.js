#!/usr/bin/env node
// Search size range: pure stops and labels, the max filter, and the slider's accessibility contract. Needs Node 22.18+.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}

const r = require(path.join(root, 'components/search/sizeRange.ts'));
const s = require(path.join(root, 'components/search/sharing.ts'));
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const last = r.SIZE_STOPS.length - 1;

check('13 stops', r.SIZE_STOPS.length === 13);
check('first stop 0, last Infinity', r.SIZE_STOPS[0] === 0 && r.SIZE_STOPS[last] === Infinity);
check('stops strictly increase', r.SIZE_STOPS.every((v, i) => i === 0 || v > r.SIZE_STOPS[i - 1]));
check('stops are binary', r.SIZE_STOPS[1] === 50 * MB && r.SIZE_STOPS[3] === 250 * MB && r.SIZE_STOPS[5] === GB && r.SIZE_STOPS[11] === 64 * GB);

check('rangeLabel both open', r.rangeLabel(0, last) === 'Any size');
check('rangeLabel min only', r.rangeLabel(5, last) === 'Over 1 GB');
check('rangeLabel max only', r.rangeLabel(0, 8) === 'Up to 8 GB');
check('rangeLabel both', r.rangeLabel(5, 8) === '1 GB – 8 GB', r.rangeLabel(5, 8));
check('rangeLabel MB', r.rangeLabel(1, last) === 'Over 50 MB');
check('stopLabel ends are Any', r.stopLabel(0) === 'Any' && r.stopLabel(last) === 'Any');
check('stopLabel sizes', r.stopLabel(1) === '50 MB' && r.stopLabel(5) === '1 GB' && r.stopLabel(11) === '64 GB');

const c = r.clampRange;
check('clampRange keeps a valid range', JSON.stringify(c(2, 5)) === JSON.stringify({ low: 2, high: 5 }) || (c(2, 5).low === 2 && c(2, 5).high === 5));
check('clampRange never equal or crossed', [[3, 3], [6, 2], [last, last], [0, 0]].every(([a, b]) => { const x = c(a, b); return x.low < x.high; }));
check('clampRange stays in bounds', (() => { const x = c(-4, 99); return x.low === 0 && x.high === last; })());

const f = r.toFilter(5, 8);
check('toFilter both', f.minBytes === GB && f.maxBytes === 8 * GB);
const fo = r.toFilter(0, last);
check('toFilter open', fo.minBytes === 0 && fo.maxBytes === undefined);

const base = { hideDead: false, minBytes: 0 };
check('over max is dropped', s.passesResultFilter({ sizeBytes: 9 }, { ...base, maxBytes: 8 }) === false);
check('exactly at max passes', s.passesResultFilter({ sizeBytes: 8 }, { ...base, maxBytes: 8 }) === true);
check('unknown size passes with max', s.passesResultFilter({}, { ...base, maxBytes: 8 }) === true);
check('unknown size passes with min and max', s.passesResultFilter({}, { hideDead: false, minBytes: 5, maxBytes: 8 }) === true);
check('no max keeps big files', s.passesResultFilter({ sizeBytes: 1e15 }, base) === true);
check('min unchanged', s.passesResultFilter({ sizeBytes: 4 }, { hideDead: false, minBytes: 5 }) === false);

const sheet = read('components/search/SortFilterSheet.tsx');
const slider = read('components/ui/RangeSlider.tsx');
check('sheet has no size chips', !sheet.includes('Over 100 MB') && !sheet.includes('MIN_SIZES'));
check('sheet uses RangeSlider', /<RangeSlider\b/.test(sheet));
check('sheet unknown-size caption', sheet.includes('Files of unknown size always show.'));
check('slider is adjustable', slider.includes('accessibilityRole="adjustable"'));
check('slider has increment and decrement', slider.includes("'increment'") && slider.includes("'decrement'"));
check('slider thumb hit area uses touch.min', /touch\.min/.test(slider));
check('slider haptic is select', /haptic\('select'\)/.test(slider));
check('slider haptic not in an effect', !/useEffect[\s\S]{0,200}haptic\(/.test(slider));
check('slider uses gesture-handler hooks', /usePanGesture/.test(slider) && slider.includes('activeOffsetX') && slider.includes('failOffsetY'));
check('slider no hex colours', !/#[0-9a-fA-F]{6}\b/.test(slider));
check('exported from ui index', read('components/ui/index.ts').includes('RangeSlider'));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall size-range checks passed');
