#!/usr/bin/env node
/**
 * Onboarding motion and copy contract (static checks).
 *
 * The idea: the train carries you forward. Step 1 the train arrives; moving between steps slides the
 * content in a few whole-pixel steps (the way the mark moves); the progress squares step in.
 * Rules: reduce motion is read and honoured, no spring or overshoot, no glow, native driver only,
 * UI durations 100-320 ms, no haptic from an effect, and step 1 no longer sells "Fast, simple torrents."
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? ` (${extra})` : ''}`);
  if (!ok) failed++;
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = [
  'app/onboarding.tsx',
  'components/onboarding/StepLayout.tsx',
  'components/onboarding/ProgressSquares.tsx',
  'components/onboarding/StepSlide.tsx',
  'components/onboarding/BrandMark.tsx',
];
const srcs = Object.fromEntries(files.filter(exists).map((f) => [f, strip(read(f))]));
const code = Object.values(srcs).join('\n');
const of = (f) => srcs[f] || '';

check('StepSlide exists (the step-to-step slide)', exists('components/onboarding/StepSlide.tsx'));
check('reduce motion is read (useReduceMotion)', /useReduceMotion\(/.test(code));
check('slide honours reduce motion (fade only)', /reduce/.test(of('components/onboarding/StepSlide.tsx')));
check('chunk honours reduce motion', /reduce/.test(of('components/onboarding/StepLayout.tsx')));
check('progress honours reduce motion', /reduce/.test(of('components/onboarding/ProgressSquares.tsx')));
check('no spring, bounce, elastic or back easing', !/Animated\.spring|\bspring\(|Easing\.(bounce|elastic|back)|withSpring|overshoot/i.test(code));
check('no glow or shadows', !/shadowColor|shadowRadius|textShadow|elevation|glow/i.test(code));
check('native driver only', /useNativeDriver:\s*true/.test(code) && !/useNativeDriver:\s*false/.test(code));
check('slide uses pixel-stepped easing (steppedRanges)', /steppedRanges/.test(of('components/onboarding/StepSlide.tsx')));
check('the train arrives on step 1 (arrive)', /\barrive\b/.test(of('components/onboarding/BrandMark.tsx')));

const durations = [...code.matchAll(/duration:\s*([^,\n]+)/g)].flatMap((m) => m[1].match(/\d+/g) || []).map(Number);
check('durations are declared', durations.length >= 3, String(durations));
check('every duration is within 100-320 ms', durations.every((d) => d >= 100 && d <= 320), durations.join(','));

check('haptics come from constants/haptics, never expo-haptics', !/expo-haptics/.test(code));
const verbs = [...code.matchAll(/haptic\('(\w+)'\)/g)].map((m) => m[1]);
check('haptic verbs are in the vocabulary', verbs.length > 0 && verbs.every((v) => ['select', 'tap', 'commit', 'done', 'warn', 'fail'].includes(v)), verbs.join(','));
const effects = [...code.matchAll(/useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[/g)].map((m) => m[1]);
check('no haptic inside useEffect', effects.every((b) => !/haptic\(/.test(b)));

check('nothing waits for an animation before the buttons work', !/animating|isAnimating|setTransitioning/i.test(code));

const copy = read('constants/copy.ts');
check('step 1 no longer says "Fast, simple torrents."', !/Fast, simple torrents\./.test(code) && !/Fast, simple torrents\./.test(copy));
const m = copy.match(/export const onboarding = \{([\s\S]*?)\n\};/);
const ob = m ? m[1] : '';
check('onboarding copy lives in constants/copy.ts', !!m);
check('promise names links and videos, not only torrents', /link/i.test(ob) && /video/i.test(ob));
check('no hype words or exclamation marks in onboarding copy', !/!|seamless|powerful|blazing|effortless|supercharge|revolution|unleash/i.test(ob));

if (failed) {
  console.error(`\n${failed} onboarding motion check(s) failed`);
  process.exit(1);
}
console.log('\nOnboarding motion: all checks pass');
