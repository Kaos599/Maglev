#!/usr/bin/env node
// Wiring check for the "old files from a previous install" fix. The behaviour itself is proven by the Rust
// unit test `foreign_owned_file_moves_to_numbered_folder` (CI runs `cargo test`); this keeps the call site honest.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
const engine = read('native/maglev-core/src/engine.rs');
const types = read('native/maglev-core/src/types.rs');
const add = engine.slice(engine.indexOf('async fn add_resolved'), engine.indexOf('fn is_known'));
check('add_resolved picks a writable folder', add.includes('pick_writable_folder(') && add.includes('can_open_for_write'));
check('picker is defined once and probes by opening for write', /pub fn pick_writable_folder/.test(types) && /OpenOptions::new\(\)\s*\.write\(true\)/.test(types));
check('Rust test covers numbered folders and single files', types.includes('fn foreign_owned_file_moves_to_numbered_folder') && types.includes('movie.mkv (1)'));
check('recheck and move keep their folder (readd_at not changed)', !engine.slice(engine.indexOf('async fn readd_at'), engine.indexOf('async fn readd_at') + 600).includes('pick_writable_folder'));
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('add collision: all ok');
