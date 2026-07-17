import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCsv } from "./experiments/reportUtils.mjs";
import { buildExperiment12Variants } from "./experiments/topologyVersionedCausalExperiment.mjs";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const inputDir = resolve(argValue("--input", "reports/_scratch/experiment12-topology-causal-smoke"));
const files = {
  results: join(inputDir, "experiment12-results.json"),
  summary: join(inputDir, "experiment12-summary.csv"),
  deltas: join(inputDir, "experiment12-mechanism-deltas.csv"),
  causal: join(inputDir, "experiment12-causal-audit.csv"),
  markdown: join(inputDir, "EXPERIMENT_12_REPORT.md"),
  html: join(inputDir, "index.html"),
};

for (const [label, path] of Object.entries(files)) {
  assert.ok(existsSync(path), `Missing ${label}: ${path}`);
}

const results = JSON.parse(await readFile(files.results, "utf8"));
const summaryRows = parseCsv(await readFile(files.summary, "utf8"));
const deltaRows = parseCsv(await readFile(files.deltas, "utf8"));
const causalRows = parseCsv(await readFile(files.causal, "utf8"));
const profileIds = results.parameters?.profile_ids ?? [];
const variantIds = results.parameters?.variant_ids ?? buildExperiment12Variants().map((variant) => variant.id);
const stressRates = results.parameters?.stress_rates ?? [];

assert.equal(results.schema_version, "experiment12-topology-causal-v2");
assert.equal(results.scope?.claim, "medium-large-equal-budget-only");
assert.equal(summaryRows.length, profileIds.length * stressRates.length * variantIds.length);
assert.equal(deltaRows.length, profileIds.length * stressRates.length * (variantIds.length - 1));
assert.ok(summaryRows.every((row) => Object.hasOwn(row, "mechanism_triggered") && row.mechanism_triggered !== ""));
assert.ok(summaryRows.every((row) => Object.hasOwn(row, "mechanism_trigger_evidence") && row.mechanism_trigger_evidence !== ""));
for (const row of summaryRows.filter((candidate) => candidate.variant_id === "full-unified")) {
  const topologyActionSlices = Number(row.unified_reuse_slices) + Number(row.unified_repair_slices);
  assert.equal(
    row.mechanism_triggered,
    topologyActionSlices > 0 ? "true" : "false",
    `${row.profile_id} trigger status must follow actual reuse/repair slices`,
  );
}

for (const profileId of profileIds) {
  for (const stressRate of stressRates) {
    const profileRows = summaryRows.filter(
      (row) => row.profile_id === profileId && Number(row.stress_rate) === Number(stressRate),
    );
    assert.deepEqual(profileRows.map((row) => row.variant_id), variantIds);
    assert.equal(new Set(profileRows.map((row) => row.telemetry_budget_bytes_per_node_slice)).size, 1);
    assert.ok(profileRows.every((row) => Number(row.telemetry_bytes_per_node_slice) <= Number(row.telemetry_budget_bytes_per_node_slice) + 1e-6));
    assert.ok(profileRows.every((row) => row.strict_causal_passed === "true"));
  }
}

assert.ok(causalRows.length >= summaryRows.length * 6);
assert.ok(causalRows.every((row) => row.passed === "true"));

const markdown = await readFile(files.markdown, "utf8");
const html = await readFile(files.html, "utf8");
for (const phrase of [
  "中大型动态 LEO",
  "严格时间因果",
  "相同遥测字节预算",
  "不追求全指标全面胜出",
  "机制触发审计",
  "缓存重算次数",
]) {
  assert.ok(markdown.includes(phrase), `Markdown missing phrase: ${phrase}`);
  assert.ok(html.includes(phrase), `HTML missing phrase: ${phrase}`);
}

console.log(`Experiment 12 artifact tests passed: ${inputDir}`);
