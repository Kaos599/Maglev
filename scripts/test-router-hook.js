#!/usr/bin/env node
// The global `router` exported by expo-router throws "The imperative router is unavailable before the first render
// has finished" while its bridge is unbound. A phone test crashed this way on a cold-start tap in Settings.
// Screens and components must use the useRouter() hook, which is bound to the mounted navigator.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);
const bad = ['app', 'components'].flatMap(walk).filter((f) =>
  /import\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]expo-router['"]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
if (bad.length) {
  console.error(`  FAIL global expo-router router imported in: ${bad.join(', ')} (use useRouter)`);
  process.exit(1);
}
console.log('  ok   no screen imports the global expo-router router\n\nall router hook checks passed');
