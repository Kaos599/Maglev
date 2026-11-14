#!/usr/bin/env node
// Star prompt (docs/NATIVE_CONTRACT.md section 33): every gate, the outcomes, prefs, the About row and the copy.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');

const Module = require('module');
const fs = require('fs');
const path = require('path');

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
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  Module.registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'expo-sqlite/kv-store') return { url: `stub:${spec}`, shortCircuit: true, format: 'commonjs' };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith('stub:')) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = { default: { getItemSync: () => null, setItemSync() {} } };' };
      }
      return next(url, ctx);
    },
  });
  const s = await import('../utils/star.ts');
  const prefs = await import('../utils/prefs/star.ts');

  const NOW = 100 * DAY;
  const good = { ...s.defaultStarState(), firstSeenAt: NOW - 8 * DAY, completedCount: 3 };
  const ctx = { onboarding: false, overlayOpen: false, browserLoading: false, shownThisSession: false, foreground: true };
  const ask = (st, c = ctx, now = NOW) => s.shouldAskForStar(st, now, c);

  console.log('[gates]');
  check('all gates open: asks', ask(good));
  check('2 finished transfers: no', !ask({ ...good, completedCount: 2 }));
  check('3 finished transfers: yes', ask({ ...good, completedCount: 3 }));
  check('no first-seen stamp: no', !ask({ ...good, firstSeenAt: null }));
  check('6 days 23 h since first launch: no', !ask({ ...good, firstSeenAt: NOW - 7 * DAY + 1 }));
  check('exactly 7 days: yes', ask({ ...good, firstSeenAt: NOW - 7 * DAY }));
  check('starred: no', !ask({ ...good, starred: true }));
  check('never: no', !ask({ ...good, never: true }));
  check('onboarding: no', !ask(good, { ...ctx, onboarding: true }));
  check('another sheet open: no', !ask(good, { ...ctx, overlayOpen: true }));
  check('browser loading: no', !ask(good, { ...ctx, browserLoading: true }));
  check('already shown this session: no', !ask(good, { ...ctx, shownThisSession: true }));
  check('app in background: no', !ask(good, { ...ctx, foreground: false }));
  check('Not now 29 days ago: no', !ask({ ...good, dismissCount: 1, lastDismissedAt: NOW - 29 * DAY }));
  check('Not now 30 days ago: yes', ask({ ...good, dismissCount: 1, lastDismissedAt: NOW - 30 * DAY }));
  check('3 dismissals: no, even after 30 days', !ask({ ...good, dismissCount: 3, lastDismissedAt: NOW - 90 * DAY }));
  check('2 dismissals long ago: yes', ask({ ...good, dismissCount: 2, lastDismissedAt: NOW - 90 * DAY }));

  console.log('[outcomes]');
  const a = s.afterNotNow(good, NOW);
  check('Not now stores the time and counts it', a.lastDismissedAt === NOW && a.dismissCount === 1 && !a.never);
  const b = s.afterNotNow(s.afterNotNow(a, NOW + 31 * DAY), NOW + 62 * DAY);
  check('third Not now becomes never', b.dismissCount === 3 && b.never);
  check("Don't ask again sets never", s.afterNever(good).never === true);
  check('Star sets starred', s.afterStarred(good).starred === true);
  check('completed adds one', s.afterCompleted(good).completedCount === 4);
  check('first-seen is set once', s.withFirstSeen(s.defaultStarState(), 5).firstSeenAt === 5 && s.withFirstSeen({ ...good }, 5).firstSeenAt === good.firstSeenAt);
  check('reducers do not mutate', good.dismissCount === 0 && !good.never && !good.starred && good.completedCount === 3);
  check('the card waits 2 s', s.STAR_DELAY_MS === 2000);

  console.log('[prefs]');
  check('junk reads as defaults', JSON.stringify(prefs.normalizeStarState('x')) === JSON.stringify(s.defaultStarState()));
  check('negative and odd values are dropped', prefs.normalizeStarState({ completedCount: -2, firstSeenAt: 'a', starred: 1 }).completedCount === 0);
  prefs.ensureFirstSeen(1234);
  prefs.ensureFirstSeen(9999);
  check('ensureFirstSeen keeps the first stamp', prefs.getStarState().firstSeenAt === 1234);
  prefs.updateStarState(s.afterCompleted);
  check('updateStarState saves', prefs.getStarState().completedCount === 1);

  console.log('[wiring]');
  const about = read('app/settings/about.tsx');
  const ticket = read('components/settings/StarTicket.tsx');
  check('About keeps its star ticket, and starring from it stops the prompt', /<StarTicket \/>/.test(about) && /afterStarred/.test(ticket) && /openURL\(REPO_URL\)/.test(ticket));
  const layout = read('app/_layout.tsx');
  check('the card is mounted once at the app root', (layout.match(/<StarPrompt \/>/g) || []).length === 1);
  const prompt = read('components/StarPrompt.tsx');
  check('the card opens the repo and records the outcomes', /Linking\.openURL\(REPO_URL\)/.test(prompt) && /afterNotNow/.test(prompt) && /afterNever/.test(prompt) && /afterStarred/.test(prompt));
  check('Back and the scrim count as Not now', /onClose=\{notNow\}/.test(prompt));
  check('no payment links in the app copy', !/buymeacoffee|ko-fi|paypal|patreon|sponsor/i.test(read('constants/copy.ts') + prompt + about));
  check('sheets report to the overlay tracker', /useOverlayTracking/.test(read('components/ui/Sheet.tsx')) && /useOverlayTracking/.test(read('components/browser/FloatingSheet.tsx')));

  console.log('[copy]');
  const copy = await import('../constants/copy.ts');
  const c = copy.starCopy;
  check('title and body', c.title === 'Enjoying Maglev?' && c.body === 'A star on GitHub helps other people find it.');
  check('buttons', c.star === 'Star on GitHub' && c.notNow === 'Not now' && c.never === "Don't ask again");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
