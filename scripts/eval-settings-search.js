#!/usr/bin/env node
/**
 * Eval (not a gate): runs the query intents in scripts/fixtures/settings-intents.json
 * through searchSettings() from utils/settingsIndex.ts and reports whether the expected
 * setting ids come first, in the top 3, or not at all.
 *
 * Run: node scripts/eval-settings-search.js [path/to/intents.json]
 * Without --gate it always exits 0.
 * With --gate it exits 1 when hit@3 is below 85% or any negative query returns results.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INTENTS_PATH = path.join(
  ROOT,
  "scripts",
  "fixtures",
  "settings-intents.json",
);
const GATE_MIN_HIT3 = 0.85;

const args = process.argv.slice(2);
const GATE = args.includes("--gate");
const pathArg = args.find((a) => !a.startsWith("--"));
const INTENTS_PATH = pathArg
  ? path.resolve(process.cwd(), pathArg)
  : DEFAULT_INTENTS_PATH;

function titleOf(entry) {
  return entry ? `${entry.title} (${entry.id})` : "-";
}

function classify(intent, results) {
  if (intent.expect === null) {
    return results.length === 0 ? "NEG-OK" : "NEG-NOISE";
  }
  const expected = new Set(intent.expect);
  if (results.length > 0 && expected.has(results[0].id)) return "HIT@1";
  if (results.slice(0, 3).some((r) => expected.has(r.id))) return "HIT@3";
  return "MISS";
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width
    ? s.slice(0, width)
    : s + " ".repeat(width - s.length);
}

async function main() {
  const { searchSettings, SETTINGS_INDEX } = await import(
    pathToFileURL(path.join(ROOT, "utils", "settingsIndex.ts")).href
  );
  const intents = JSON.parse(fs.readFileSync(INTENTS_PATH, "utf8"));
  const byId = new Map(SETTINGS_INDEX.map((e) => [e.id, e]));

  const rows = intents.map((intent, i) => {
    const results = searchSettings(intent.query);
    const status = classify(intent, results);
    const expectedTitles =
      intent.expect === null
        ? "none"
        : intent.expect
            .map((id) => titleOf(byId.get(id) ?? { title: "?", id }))
            .join(" | ");
    return { n: i + 1, intent, results, status, expectedTitles };
  });

  console.log(
    `${pad("#", 4)}${pad("STATUS", 11)}${pad("QUERY", 36)}${pad("TOP RESULT", 44)}EXPECTED`,
  );
  console.log("-".repeat(150));
  for (const r of rows) {
    const top = r.results[0] ? titleOf(r.results[0]) : "(no results)";
    console.log(
      `${pad(r.n, 4)}${pad(r.status, 11)}${pad(JSON.stringify(r.intent.query), 36)}${pad(top, 44)}${r.expectedTitles}`,
    );
  }

  const positives = rows.filter((r) => r.intent.expect !== null);
  const negatives = rows.filter((r) => r.intent.expect === null);
  const hit1 = positives.filter((r) => r.status === "HIT@1").length;
  const hit3 = positives.filter((r) => r.status === "HIT@3").length;
  const misses = positives.filter((r) => r.status === "MISS").length;
  const pct = (n) =>
    positives.length ? ((100 * n) / positives.length).toFixed(1) : "0.0";
  const negOk = negatives.filter((r) => r.status === "NEG-OK").length;
  const negNoise = negatives.filter((r) => r.status === "NEG-NOISE").length;

  console.log("");
  console.log(
    `Queries: ${rows.length} (positive ${positives.length}, negative ${negatives.length})`,
  );
  console.log(`hit@1:   ${hit1}/${positives.length} = ${pct(hit1)}%`);
  console.log(
    `hit@3:   ${hit1 + hit3}/${positives.length} = ${pct(hit1 + hit3)}%  (of which @3 only: ${hit3})`,
  );
  console.log(`misses:  ${misses}`);
  console.log(`negatives: NEG-OK ${negOk}, NEG-NOISE ${negNoise}`);

  if (GATE) {
    const hit3Rate = positives.length ? (hit1 + hit3) / positives.length : 0;
    const failures = [];
    if (hit3Rate < GATE_MIN_HIT3)
      failures.push(
        `hit@3 ${(100 * hit3Rate).toFixed(1)}% is below ${100 * GATE_MIN_HIT3}%`,
      );
    if (negNoise > 0)
      failures.push(
        `${negNoise} negative quer${negNoise === 1 ? "y returns" : "ies return"} results`,
      );
    if (failures.length > 0) {
      console.log(`GATE FAILED: ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("GATE PASSED");
    }
  }
}

main().catch((err) => {
  console.error("eval failed:", err);
  if (GATE) process.exitCode = 1;
});
