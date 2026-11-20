/**
 * Release-bundle slimming contracts (source level).
 * 1. The mock engine must not be statically reachable from the bridge or the module index,
 *    so Metro's __DEV__ constant folding can drop it from release bundles.
 * 2. The bridge must not re-camelize telemetry that Kotlin already camelized (EngineHost.kt).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'modules', 'maglev-engine', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const bridge = read('MaglevNativeBridge.ts');
const index = read('index.ts');

check('bridge has no static import of MaglevMock*', !/^\s*import\b[^;]*['"]\.\/MaglevMock\w*(\.ts)?['"]/m.test(bridge));
check('index has no re-export of MaglevMock*', !/['"]\.\/MaglevMock\w*(\.ts)?['"]/.test(index));

// The only reference to the mock module is a require() inside an `if (__DEV__ ...)` block Metro can fold.
const reqs = [...bridge.matchAll(/require\(\s*['"]\.\/MaglevMockEngine(\.ts)?['"]\s*\)/g)];
check('bridge requires the mock exactly once', reqs.length === 1);
if (reqs.length === 1) {
  const before = bridge.slice(0, reqs[0].index).replace(/const\s*\{[^}]*\}\s*=\s*$/, '');
  const m = [...before.matchAll(/if\s*\(([^)]*)\)\s*\{/g)].pop();
  check('mock require sits directly in an if (__DEV__ ...) block', !!m && /__DEV__/.test(m[1]) && !before.slice(m.index + m[0].length).includes('}'));
  check(
    'web check is Metro-foldable (process.env.EXPO_OS, not Platform.OS)',
    !!m && !/Platform\.OS/.test(m[1])
  );
} else {
  check('mock require sits directly in an if (__DEV__ ...) block', false);
  check('web check is Metro-foldable (process.env.EXPO_OS, not Platform.OS)', false);
}

// Kotlin camelizes onTelemetry (EngineHost.kt Json.camelize), so JS must not run camelizeKeys on it.
const tele = bridge.match(/sub\(\s*'onTelemetry'[\s\S]*?\n      \}(?:,\s*(false))?\);/);
check('onTelemetry (camelized by Kotlin) skips the JS camelize pass', !!tele && tele[1] === 'false');
check('sub() camelizes by default, so every other event keeps the pass', /camelize = true/.test(bridge));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nbundle-slim contracts OK');
