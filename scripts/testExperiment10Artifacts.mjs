import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCsv } from "./experiments/reportUtils.mjs";
import { validateEqualBudgetMatrix } from "./experiments/equalBudgetStatistics.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "reports/experiment10-equal-budget-dynamic-multiseed"));
const paths = {
  manifest: resolve(inputDir, "experiment10-manifest.json"),
  summary: resolve(inputDir, "experiment10-equal-budget-summary.json"),
  raw: resolve(inputDir, "experiment10-equal-budget-by-seed.csv"),
  aggregate: resolve(inputDir, "experiment10-equal-budget-aggregate.csv"),
  effects: resolve(inputDir, "experiment10-paired-effects.csv"),
  fairness: resolve(inputDir, "experiment10-budget-fairness.csv"),
  html: resolve(inputDir, "experiment10-equal-budget-report.html"),
};
for (const [label, path] of Object.entries(paths)) assert.ok(existsSync(path), `${label} missing: ${path}`);

const [manifest, summary, rawRows, aggregateRows, effectRows, fairnessRows, html] = await Promise.all([
  readFile(paths.manifest, "utf8").then(JSON.parse),
  readFile(paths.summary, "utf8").then(JSON.parse),
  readFile(paths.raw, "utf8").then(parseCsv),
  readFile(paths.aggregate, "utf8").then(parseCsv),
  readFile(paths.effects, "utf8").then(parseCsv),
  readFile(paths.fairness, "utf8").then(parseCsv),
  readFile(paths.html, "utf8"),
]);

assert.equal(manifest.status, "complete");
assert.equal(summary.schema_version, "experiment10-equal-budget-dynamic-multiseed-v1");
assert.equal(manifest.row_counts.raw, rawRows.length);
assert.equal(manifest.row_counts.aggregate, aggregateRows.length);
assert.equal(manifest.row_counts.effects, effectRows.length);
assert.equal(manifest.row_counts.fairness, fairnessRows.length);
validateEqualBudgetMatrix(rawRows, {
  profileIds: summary.parameters.profile_ids,
  stressRates: summary.parameters.stress_rates,
  seeds: summary.parameters.seeds,
  methodIds: summary.parameters.method_ids,
});
assert.ok(rawRows.every((row) => Number(row.telemetry_byte_budget_cap_violations) === 0));
assert.ok(rawRows.every((row) => Number(row.telemetry_bytes_per_node_slice) <= Number(row.telemetry_byte_budget_per_node_slice) + 1e-4));
assert.ok(fairnessRows.every((row) => row.ok === "true"));
assert.ok(fairnessRows.every((row) => row.primary_achieved_budget_match_ok === "true"));
assert.match(html, /严格等硬字节预算/);
assert.match(html, /95% CI/);
assert.match(html, /主要结论/);
assert.equal(html.includes("\uFFFD"), false);

if (summary.formal) {
  assert.equal(rawRows.length, 270);
  assert.equal(aggregateRows.length, 27);
  assert.equal(fairnessRows.length, 90);
  assert.equal(summary.parameters.seed_count, 10);
}

console.log(JSON.stringify({
  ok: true,
  formal: summary.formal,
  raw_rows: rawRows.length,
  aggregate_rows: aggregateRows.length,
  fairness_rows: fairnessRows.length,
}, null, 2));
