#!/usr/bin/env node
/**
 * Route guard contract: every route in the root Stack sits inside a <Stack.Protected> block.
 *
 * Why: when the route being opened is guarded, expo-router falls back to the first UNGUARDED
 * route in file order (expo-router 58, layouts/GuardContext.js findDefaultRedirectRouteInNavigator),
 * not the order of the screens in _layout.tsx. A route left out of every guard is never guarded,
 * so on a fresh install (onboarded = false, "(tabs)" guarded) Maglev 0.12 opened `browser`
 * instead of onboarding, with nothing behind it.
 *
 * With every route guarded, the only unguarded route on a fresh install is `onboarding`.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'app');
const layout = fs.readFileSync(path.join(appDir, '_layout.tsx'), 'utf8');

let failed = 0;
const check = (ok, msg) => {
  if (ok) console.log(`ok   ${msg}`);
  else {
    failed++;
    console.log(`FAIL ${msg}`);
  }
};

// Routes of the root Stack: files directly in app/ and in plain (non-group) folders, plus groups.
function routes() {
  const out = new Set();
  for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (/^\(.*\)$/.test(name)) {
        out.add(name); // a group is one screen of the root Stack
        continue;
      }
      if (fs.existsSync(path.join(appDir, name, '_layout.tsx'))) {
        out.add(name);
        continue;
      }
      for (const f of fs.readdirSync(path.join(appDir, name))) {
        if (/\.tsx?$/.test(f)) out.add(`${name}/${f.replace(/\.tsx?$/, '')}`);
      }
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    const route = name.replace(/\.tsx?$/, '');
    if (route.startsWith('_') || route.startsWith('+')) continue; // layouts and special files
    out.add(route);
  }
  return out;
}

// Screen names inside each <Stack.Protected guard={X}> ... </Stack.Protected>.
const guarded = new Map();
const blockRe = /<Stack\.Protected\s+guard=\{(\w+)\}\s*>([\s\S]*?)<\/Stack\.Protected>/g;
for (const m of layout.matchAll(blockRe)) {
  const names = [...m[2].matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((s) => s[1]);
  guarded.set(m[1], names);
}
const declared = new Set([...guarded.values()].flat());

check(guarded.has('onboarding') && guarded.has('main') && guarded.has('unavailable'), 'root layout has the unavailable, onboarding and main guards');
for (const r of routes()) {
  check(declared.has(r), `route "${r}" is declared inside a Stack.Protected guard`);
}
const onboardingScreens = guarded.get('onboarding') ?? [];
check(onboardingScreens.length === 1 && onboardingScreens[0] === 'onboarding', 'the onboarding guard holds only the onboarding screen');
check(!(guarded.get('main') ?? []).includes('onboarding'), 'onboarding is not reachable from the main guard');

if (failed) {
  console.log(`\n${failed} route guard check(s) failed`);
  process.exit(1);
}
console.log('\nroute guards: all checks passed');
