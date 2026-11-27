#!/usr/bin/env node
// Runs the TLC model checker on every state-machine model under specs/ and compares each result with what the
// model's .cfg says it should be.
//
//   node scripts/check-models.js                       every .cfg under specs/
//   node scripts/check-models.js specs/share-handoff   one folder (or one .cfg file)
//
// The first line of each .cfg states the expected result:
//   \* expect: pass                   TLC must find no broken rule
//   \* expect: fail LatestShown       TLC must report that this rule (invariant) breaks
// A design that was tried and rejected keeps its .cfg with "fail", so the reason it was rejected is checked too.
//
// Needs Java 11 or newer. TLC comes from the official tlaplus release, downloaded once into .cache/tla/ and checked
// against a pinned sha256 so a changed file is never run. No npm dependencies.

'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SPECS = path.join(ROOT, 'specs');
const CACHE = path.join(ROOT, '.cache', 'tla');
const JAR = path.join(CACHE, 'tla2tools.jar');
const JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Java's major version, or null when java is not on the PATH. */
function javaVersion() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (r.error) return null;
  // "openjdk version "21.0.10"" or, before Java 9, "java version "1.8.0_392"".
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return 0;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

async function ensureJar() {
  if (fs.existsSync(JAR) && sha256(JAR) === JAR_SHA256) return;
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Downloading TLC (tla2tools.jar v1.7.4) into ${path.relative(ROOT, CACHE)}/ ...`);
  const res = await fetch(JAR_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} from ${JAR_URL}`);
  const tmp = `${JAR}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const got = sha256(tmp);
  if (got !== JAR_SHA256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`The downloaded tla2tools.jar has sha256 ${got}, expected ${JAR_SHA256}. Not running it.`);
  }
  fs.renameSync(tmp, JAR);
}

/** Every .cfg under dir, sorted, skipping nothing: the template is checked too, so it stays a working model. */
function findCfgs(target) {
  if (fs.statSync(target).isFile()) return target.endsWith('.cfg') ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...findCfgs(p));
    else if (entry.name.endsWith('.cfg')) out.push(p);
  }
  return out.sort();
}

/** { kind: 'pass' } or { kind: 'fail', rule }, from the cfg's first line; null when the line is missing. */
function readExpectation(cfg) {
  const first = fs.readFileSync(cfg, 'utf8').split(/\r?\n/, 1)[0].trim();
  if (/^\\\*\s*expect:\s*pass\s*$/.test(first)) return { kind: 'pass' };
  const m = /^\\\*\s*expect:\s*fail\s+(\w+)\s*$/.exec(first);
  return m ? { kind: 'fail', rule: m[1] } : null;
}

/** The spec a cfg checks: the .tla with the same name, or else the only .tla in the folder. */
function specFor(cfg) {
  const dir = path.dirname(cfg);
  const same = cfg.replace(/\.cfg$/, '.tla');
  if (fs.existsSync(same)) return same;
  const tlas = fs.readdirSync(dir).filter((f) => f.endsWith('.tla'));
  return tlas.length === 1 ? path.join(dir, tlas[0]) : null;
}

/**
 * Runs TLC and reads its result. A model expected to fail runs on one worker: TLC then explores states breadth-first
 * in a fixed order, so it reports the shortest path, and when two rules break, the same one on every run. A model
 * expected to pass explores every state either way, so it uses every core.
 */
function runTlc(cfg, spec, workers) {
  const meta = path.join(CACHE, 'states', `${path.basename(path.dirname(cfg))}-${path.basename(cfg, '.cfg')}-${process.pid}`);
  const args = [
    '-XX:+UseParallelGC',
    '-cp', JAR, 'tlc2.TLC',
    '-config', path.basename(cfg),
    '-workers', workers,
    '-metadir', meta, // TLC's working files go to .cache, not next to the spec
    path.basename(spec),
  ];
  const r = spawnSync('java', args, { cwd: path.dirname(spec), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(meta, { recursive: true, force: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const states = /([\d,]+) distinct states found/.exec(out)?.[1]?.replace(/,/g, '');
  const steps = [...out.matchAll(/^State (\d+):/gm)].reduce((n, m) => Math.max(n, Number(m[1]) - 1), 0);
  const broken = /Error: Invariant (\w+) is violated/.exec(out);
  if (broken) return { kind: 'fail', rule: broken[1], steps, out };
  if (/Error: Deadlock reached/.test(out)) return { kind: 'fail', rule: 'deadlock', steps, out };
  if (r.status === 0 && /No error has been found/.test(out)) return { kind: 'pass', states, out };
  return { kind: 'error', out };
}

/** TLC's counterexample: from the error line to the summary line. */
function trace(out) {
  const start = out.search(/^Error: /m);
  const end = out.search(/^\d[\d,]* states generated/m);
  return start < 0 ? out.trim() : out.slice(start, end > start ? end : undefined).trim();
}

function describe(result) {
  if (result.kind === 'pass') return 'no rule breaks';
  if (result.rule === 'deadlock') return `it gets stuck in a state with no step out, after ${result.steps} steps`;
  return `${result.rule} breaks after ${result.steps} steps`;
}

async function main() {
  const target = path.resolve(process.argv[2] ?? SPECS);
  if (!fs.existsSync(target)) {
    console.error(`No such file or folder: ${process.argv[2]}`);
    process.exit(2);
  }
  const cfgs = findCfgs(target);
  if (cfgs.length === 0) {
    console.error(`No .cfg files under ${path.relative(ROOT, target) || '.'}`);
    process.exit(2);
  }

  const java = javaVersion();
  if (java === null || java < 11) {
    console.error(
      java === null
        ? 'Java was not found. The model checker needs Java 11 or newer: install a JDK (for example Temurin 21) and run this again.'
        : `This Java is version ${java || 'unknown'}. The model checker needs Java 11 or newer.`,
    );
    process.exit(2);
  }
  await ensureJar();

  let failed = 0;
  for (const cfg of cfgs) {
    const name = path.relative(SPECS, cfg).split(path.sep).join('/');
    const expect = readExpectation(cfg);
    const spec = specFor(cfg);
    if (!expect) {
      console.log(`FAIL ${name}: the first line must be "\\* expect: pass" or "\\* expect: fail <RuleName>"`);
      failed++;
      continue;
    }
    if (!spec) {
      console.log(`FAIL ${name}: no .tla with the same name, and the folder has more than one .tla`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    let result = runTlc(cfg, spec, expect.kind === 'fail' ? '1' : 'auto');
    // Several workers can report a longer path than the shortest one. Run again on one worker for a path to read.
    if (expect.kind === 'pass' && result.kind === 'fail') result = runTlc(cfg, spec, '1');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.kind === 'error') {
      console.log(`FAIL ${name}: TLC stopped with an error (${secs}s)`);
      console.log(indent(result.out.trim().split('\n').slice(-25).join('\n')));
      failed++;
    } else if (expect.kind === 'pass' && result.kind === 'pass') {
      console.log(`PASS ${name} ${Number(result.states).toLocaleString('en-US')} states (${secs}s)`);
    } else if (expect.kind === 'fail' && result.kind === 'fail' && result.rule === expect.rule) {
      console.log(`PASS ${name} ${expect.rule} breaks, as expected, after ${result.steps} steps (${secs}s)`);
    } else {
      const wanted = expect.kind === 'pass' ? 'no rule to break' : `${expect.rule} to break`;
      console.log(`FAIL ${name}: expected ${wanted}, but ${describe(result)} (${secs}s)`);
      if (result.kind === 'fail') console.log(indent(trace(result.out)));
      failed++;
    }
  }
  console.log(`\n${cfgs.length - failed} of ${cfgs.length} models gave the expected result.`);
  process.exit(failed ? 1 : 0);
}

function indent(text) {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
