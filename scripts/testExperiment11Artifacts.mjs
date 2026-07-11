import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function readJson(path) {
  assert.ok(existsSync(path), `Missing Experiment 11 artifact: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCsvRows(path) {
  assert.ok(existsSync(path), `Missing Experiment 11 artifact: ${path}`);
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  return Math.max(lines.length - 1, 0);
}

function artifactPath(inputDir, path) {
  return isAbsolute(path) ? path : resolve(inputDir, path);
}

const inputDir = resolve(argValue(process.argv.slice(2), "--input", "reports/experiment11-dynamic-equal-budget-ablation"));
const manifestPath = join(inputDir, "experiment11-manifest.json");
const manifest = readJson(manifestPath);
const summary = readJson(artifactPath(inputDir, manifest.outputs.summary_json));
const profileCount = summary.parameters.profile_ids.length;
const stressCount = summary.parameters.stress_rates.length;
const seedCount = summary.parameters.seed_count;
const variantCount = summary.parameters.variant_ids.length;
const metricCount = 10;
const ablationCount = variantCount - 1;

const expected = {
  raw: profileCount * stressCount * seedCount * variantCount,
  aggregate: profileCount * stressCount * variantCount,
  contribution_samples: profileCount * stressCount * seedCount * ablationCount * metricCount,
  contributions: profileCount * stressCount * ablationCount * metricCount,
  interactions: profileCount * ablationCount * metricCount,
  fairness: profileCount * stressCount * seedCount,
};

assert.equal(manifest.status, "complete");
assert.deepEqual(manifest.row_counts, expected);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.raw_csv)), expected.raw);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.aggregate_csv)), expected.aggregate);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.contribution_samples_csv)), expected.contribution_samples);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.contribution_csv)), expected.contributions);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.interaction_csv)), expected.interactions);
assert.equal(readCsvRows(artifactPath(inputDir, manifest.outputs.fairness_csv)), expected.fairness);

assert.equal(summary.raw_rows.length, expected.raw);
assert.equal(summary.aggregate_rows.length, expected.aggregate);
assert.equal(summary.contribution_rows.length, expected.contributions);
assert.equal(summary.dynamicity_interaction_rows.length, expected.interactions);
assert.equal(summary.fairness_rows.length, expected.fairness);
assert.ok(summary.fairness_rows.every((row) => row.ok === true));
assert.ok(summary.fairness_rows.every((row) => Number(row.cap_violations) === 0));
assert.ok(summary.fairness_rows.every((row) => Number(row.actual_bytes_per_node_slice_spread) <= 1e-4));

const htmlPath = artifactPath(inputDir, manifest.outputs.report_html);
assert.ok(existsSync(htmlPath), `Missing Experiment 11 artifact: ${htmlPath}`);
const html = readFileSync(htmlPath, "utf8");
for (const marker of ["主要结论", "动态性交互效应", "负结果与边界", "预算公平性"]) {
  assert.ok(html.includes(marker), `Experiment 11 HTML is missing section: ${marker}`);
}
assert.ok(!html.includes("\uFFFD"), "Experiment 11 HTML contains Unicode replacement characters");
assert.ok(!/(?:锟斤拷|Ã.|Â.|æœ|å®žéªŒ)/u.test(html), "Experiment 11 HTML contains a mojibake marker");

const rootReportPath = artifactPath(inputDir, manifest.outputs.root_report_md);
assert.ok(existsSync(rootReportPath), `Missing Experiment 11 artifact: ${rootReportPath}`);
const rootReport = readFileSync(rootReportPath, "utf8");
assert.ok(rootReport.includes("实验 11"));
assert.ok(rootReport.includes("严格等预算"));

if (manifest.formal) {
  assert.equal(expected.raw, 360);
  assert.equal(expected.aggregate, 36);
  assert.equal(expected.fairness, 60);
  assert.equal(expected.contributions, 300);
  assert.equal(expected.interactions, 150);
}

console.log(`Experiment 11 artifact tests passed (${expected.raw} raw rows).`);
