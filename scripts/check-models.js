#!/usr/bin/env node
// Runs the TLC model checker on every state-machine model under specs/ and compares each result with what the
// model's .cfg says it should be.
//
//   node scripts/check-models.js                       every .cfg under specs/
//   node scripts/check-models.js specs/share-handoff   one folder (or one .cfg file)
//
// The first line of each .cfg states the expected result:
//   \* expect: pass                          TLC must find no broken rule
//   \* expect: fail LatestShown              TLC must report that this rule breaks
//   \* expect: fail LatestShown in 4 steps   ...and on the shortest path, which is this many steps long
// A design that was tried and rejected keeps its .cfg with "fail", so the reason it was rejected is checked too.
//
// Which .tla a .cfg checks: the one named on line 2 as "\* module: Name", else the .tla with the same name as the
// .cfg, else the only .tla in the folder. A folder with helper modules needs the "module:" line.
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
// CI caches .cache/tla under a key with this version in it, so change both together.
const TLA_VERSION = '1.7.4';
const JAR_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`;
const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
// A model meant to be run on every pull request finishes in seconds. Past this, the constants are too big.
const TLC_TIMEOUT_MS = 5 * 60 * 1000;
const TLC_MAX_OUTPUT = 64 * 1024 * 1024;

// The .cfg keywords TLC knows. A rule list ends at the next one.
const CFG_KEYWORDS = new Set([
  'CONSTANT', 'CONSTANTS', 'INIT', 'NEXT', 'SPECIFICATION', 'INVARIANT', 'INVARIANTS', 'PROPERTY', 'PROPERTIES',
  'SYMMETRY', 'VIEW', 'CONSTRAINT', 'CONSTRAINTS', 'ACTION_CONSTRAINT', 'ACTION_CONSTRAINTS', 'CHECK_DEADLOCK',
  'POSTCONDITION', 'ALIAS',
]);

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

function stop(message) {
  console.error(message);
  process.exit(2);
}

async function ensureJar() {
  if (fs.existsSync(JAR) && sha256(JAR) === JAR_SHA256) return;
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Downloading TLC (tla2tools.jar v${TLA_VERSION}) into ${path.relative(ROOT, CACHE)}/ ...`);
  const offline = `Run once online, or put tla2tools.jar v${TLA_VERSION} in .cache/tla/.`;
  let res;
  try {
    res = await fetch(JAR_URL);
  } catch (e) {
    stop(`Couldn't download TLC from ${JAR_URL} (${e.cause?.code ?? e.message}). ${offline}`);
  }
  if (!res.ok) stop(`Couldn't download TLC: HTTP ${res.status} from ${JAR_URL}. ${offline}`);
  const tmp = `${JAR}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  const got = sha256(tmp);
  if (got !== JAR_SHA256) {
    fs.rmSync(tmp, { force: true });
    stop(`The downloaded tla2tools.jar has sha256 ${got}, expected ${JAR_SHA256}. Not running it.`);
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

/** { kind: 'pass' } or { kind: 'fail', rule, steps? }, from the cfg's first line; null when the line is missing. */
function readExpectation(lines) {
  const first = (lines[0] ?? '').trim();
  if (/^\\\*\s*expect:\s*pass\s*$/.test(first)) return { kind: 'pass' };
  const m = /^\\\*\s*expect:\s*fail\s+(\w+)(?:\s+in\s+(\d+)\s+steps?)?\s*$/.exec(first);
  if (!m) return null;
  return { kind: 'fail', rule: m[1], steps: m[2] === undefined ? null : Number(m[2]) };
}

/** The rules a cfg asks TLC to check: names listed after INVARIANT(S) and PROPERTY(IES). */
function readRules(text) {
  const words = text
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\\\*.*$/gm, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const rules = { invariants: [], properties: [] };
  let into = null;
  for (const w of words) {
    if (CFG_KEYWORDS.has(w)) {
      into = /^INVARIANTS?$/.test(w) ? rules.invariants : /^PROPERT(Y|IES)$/.test(w) ? rules.properties : null;
    } else if (into) {
      into.push(w);
    }
  }
  return rules;
}

/** { spec } for the .tla this cfg checks, or { error } saying why there is no single answer. */
function specFor(cfg, lines) {
  const dir = path.dirname(cfg);
  const named = /^\\\*\s*module:\s*(\w+)\s*$/.exec((lines[1] ?? '').trim());
  if (named) {
    const file = path.join(dir, `${named[1]}.tla`);
    return fs.existsSync(file) ? { spec: file } : { error: `line 2 names module ${named[1]}, but there is no ${named[1]}.tla here` };
  }
  const same = cfg.replace(/\.cfg$/, '.tla');
  if (fs.existsSync(same)) return { spec: same };
  const tlas = fs.readdirSync(dir).filter((f) => f.endsWith('.tla'));
  if (tlas.length === 1) return { spec: path.join(dir, tlas[0]) };
  if (tlas.length === 0) return { error: 'there is no .tla in this folder' };
  return { error: `the folder has ${tlas.length} .tla files (${tlas.join(', ')}). Name the one to check on line 2: "\\* module: <Name>"` };
}

/**
 * Runs TLC and reads its result. A model expected to fail runs on one worker: TLC then explores states breadth-first
 * in a fixed order, so it reports the shortest path, and when two rules break, the same one on every run. A model
 * expected to pass explores every state either way, so it uses every core.
 */
function runTlc(cfg, spec, workers, rules) {
  const meta = path.join(CACHE, 'states', `${path.basename(path.dirname(cfg))}-${path.basename(cfg, '.cfg')}-${process.pid}`);
  const args = [
    '-XX:+UseParallelGC',
    '-cp', JAR, 'tlc2.TLC',
    '-config', path.relative(path.dirname(spec), cfg),
    '-workers', workers,
    '-metadir', meta, // TLC's working files go to .cache, not next to the spec
    path.basename(spec),
  ];
  const r = spawnSync('java', args, {
    cwd: path.dirname(spec),
    encoding: 'utf8',
    timeout: TLC_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: TLC_MAX_OUTPUT,
  });
  fs.rmSync(meta, { recursive: true, force: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error?.code === 'ETIMEDOUT') {
    return { kind: 'error', reason: 'TLC ran longer than 5 minutes; shrink the constants in the .cfg', out: '' };
  }
  if (r.error?.code === 'ENOBUFS') {
    return { kind: 'error', reason: 'TLC printed more than 64 MB; shrink the constants in the .cfg', out: '' };
  }
  if (r.error) return { kind: 'error', reason: `Java didn't run: ${r.error.message}`, out };
  const states = /([\d,]+) distinct states found/.exec(out)?.[1]?.replace(/,/g, '');
  const steps = [...out.matchAll(/^State (\d+):/gm)].reduce((n, m) => Math.max(n, Number(m[1]) - 1), 0);
  const broken = /^Error: (?:Invariant|Action property) (\w+) is violated/m.exec(out);
  if (broken) return { kind: 'fail', rule: broken[1], steps, out };
  if (/^Error: Temporal properties were violated/m.test(out)) {
    // TLC doesn't say which temporal property broke. With only one listed, it can only be that one.
    const rule = rules.properties.length === 1 ? rules.properties[0] : null;
    return { kind: 'fail', rule, temporal: true, steps, out };
  }
  if (/^Error: Deadlock reached/m.test(out)) return { kind: 'fail', rule: 'deadlock', steps, out };
  if (r.status === 0 && /No error has been found/.test(out)) return { kind: 'pass', states, out };
  return { kind: 'error', reason: 'TLC stopped with an error', out };
}

/** TLC's counterexample: from the error line to the summary line. */
function trace(out) {
  const start = out.search(/^Error: /m);
  const end = out.search(/^\d[\d,]* states generated/m);
  return start < 0 ? out.trim() : out.slice(start, end > start ? end : undefined).trim();
}

const stepWord = (n) => `${n} step${n === 1 ? '' : 's'}`;

function describe(result) {
  if (result.kind === 'pass') return 'no rule breaks';
  if (result.rule === 'deadlock') return `it gets stuck in a state with no step out, after ${stepWord(result.steps)}`;
  if (result.rule === null) return `a temporal property breaks after ${stepWord(result.steps)}, and TLC doesn't say which`;
  return `${result.rule} breaks after ${stepWord(result.steps)}`;
}

/** Why the result differs from the expectation, or null when it matches. */
function mismatch(expect, result) {
  if (expect.kind === 'pass') return result.kind === 'pass' ? null : `expected no rule to break, but ${describe(result)}`;
  const wanted = `${expect.rule} to break${expect.steps === null ? '' : ` in ${stepWord(expect.steps)}`}`;
  if (result.kind !== 'fail' || result.rule !== expect.rule) {
    const hint = result.temporal && result.rule === null ? ' (list one PROPERTY per .cfg so the name is known)' : '';
    return `expected ${wanted}, but ${describe(result)}${hint}`;
  }
  if (expect.steps !== null && result.steps !== expect.steps) return `expected ${wanted}, but it breaks after ${stepWord(result.steps)}`;
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (arg?.startsWith('-')) stop(`Unknown option ${arg}. Pass a folder or a .cfg file under specs/, or nothing for all of them.`);
  const target = path.resolve(arg ?? SPECS);
  if (!fs.existsSync(target)) stop(`No such file or folder: ${arg}`);
  const cfgs = findCfgs(target);
  if (cfgs.length === 0) stop(`No .cfg files under ${path.relative(ROOT, target) || '.'}`);

  const java = javaVersion();
  if (java === null || java < 11) {
    stop(
      java === null
        ? 'Java was not found. The model checker needs Java 11 or newer: install a JDK (for example Temurin 21) and run this again.'
        : `This Java is version ${java || 'unknown'}. The model checker needs Java 11 or newer.`,
    );
  }
  await ensureJar();

  let failed = 0;
  for (const cfg of cfgs) {
    const rel = path.relative(SPECS, cfg);
    const name = rel.startsWith('..') ? cfg : rel.split(path.sep).join('/');
    const text = fs.readFileSync(cfg, 'utf8');
    const lines = text.split(/\r?\n/);
    const expect = readExpectation(lines);
    const found = specFor(cfg, lines);
    const rules = readRules(text);
    const problem = !expect
      ? 'the first line must be "\\* expect: pass" or "\\* expect: fail <RuleName>" (optionally "in <N> steps")'
      : found.error
        ? `can't tell which .tla to check: ${found.error}`
        : rules.invariants.length + rules.properties.length === 0
          ? 'it names no rule to check. List at least one under INVARIANTS (or PROPERTIES), or TLC passes without checking anything'
          : null;
    if (problem) {
      console.log(`FAIL ${name}: ${problem}`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    let result = runTlc(cfg, found.spec, expect.kind === 'fail' ? '1' : 'auto', rules);
    // Several workers can report a longer path than the shortest one. Run again on one worker for a path to read.
    if (expect.kind === 'pass' && result.kind === 'fail') result = runTlc(cfg, found.spec, '1', rules);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.kind === 'error') {
      console.log(`FAIL ${name}: ${result.reason} (${secs}s)`);
      if (result.out.trim()) console.log(indent(result.out.trim().split('\n').slice(-25).join('\n')));
      failed++;
      continue;
    }
    const why = mismatch(expect, result);
    if (!why) {
      console.log(
        expect.kind === 'pass'
          ? `PASS ${name} ${Number(result.states).toLocaleString('en-US')} states (${secs}s)`
          : `PASS ${name} ${expect.rule} breaks, as expected, after ${stepWord(result.steps)} (${secs}s)`,
      );
    } else {
      console.log(`FAIL ${name}: ${why} (${secs}s)`);
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

main().catch((e) => stop(e.message));
