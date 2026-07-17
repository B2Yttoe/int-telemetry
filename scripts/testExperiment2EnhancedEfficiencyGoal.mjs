import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function runExperiment(outputDir) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/runExperiment2IntMcEnhancementComparison.mjs",
      "--profiles",
      "iridium-next-small",
      "--out",
      outputDir,
      "--int-mc-sampling-rate",
      "0.25",
      "--int-mc-target-active-link-sampling-rate",
      "0.25",
      "--int-mc-iterations",
      "12",
      "--int-mc-window-size",
      "12",
      "--int-mc-warmup-slices",
      "6",
      "--int-mc-max-paths-per-slice",
      "12",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`experiment2 efficiency run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

const outputDir = resolve("reports/tmp-experiment2-enhanced-efficiency-test");
if (!outputDir.includes("tmp-experiment2-enhanced-efficiency-test")) {
  throw new Error(`refusing to clean unexpected path: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
runExperiment(outputDir);

const rows = parseCsv(await readFile(resolve(outputDir, "experiment2-int-mc-enhancement-comparison.csv"), "utf8"));
const baseline = rows.find((row) => row.version === "before");
const enhanced = rows.find((row) => row.version === "after");
assert.ok(baseline, "comparison CSV should include baseline row");
assert.ok(enhanced, "comparison CSV should include enhanced row");

const baselineCoverage = numberValue(baseline.active_link_direct_coverage);
const enhancedCoverage = numberValue(enhanced.active_link_direct_coverage);
const baselineBytesPerNodeSlice = numberValue(baseline.telemetry_bytes_per_node_slice);
const enhancedBytesPerNodeSlice = numberValue(enhanced.telemetry_bytes_per_node_slice);
const baselineTotalBytes = numberValue(baseline.total_telemetry_generated_bytes);
const enhancedTotalBytes = numberValue(enhanced.total_telemetry_generated_bytes);
const baselineMae = numberValue(baseline.utilization_inferred_mae);
const enhancedMae = numberValue(enhanced.utilization_inferred_mae);

assert.ok(
  enhancedCoverage >= baselineCoverage,
  `enhanced direct coverage should preserve or improve baseline coverage: enhanced=${enhancedCoverage}, baseline=${baselineCoverage}`,
);
assert.ok(
  enhancedBytesPerNodeSlice <= baselineBytesPerNodeSlice * 1.05,
  `enhanced bytes/node/slice should stay within 5% of baseline: enhanced=${enhancedBytesPerNodeSlice}, baseline=${baselineBytesPerNodeSlice}`,
);
assert.ok(
  enhancedTotalBytes <= baselineTotalBytes * 1.05,
  `enhanced total telemetry bytes should stay within 5% of baseline: enhanced=${enhancedTotalBytes}, baseline=${baselineTotalBytes}`,
);
assert.ok(
  enhancedMae <= baselineMae,
  `enhanced utilization MAE should not exceed baseline: enhanced=${enhancedMae}, baseline=${baselineMae}`,
);
assert.ok(
  numberValue(enhanced.adaptive_metadata_compact_paths) > 0,
  "enhanced run should use compact metadata paths to reduce telemetry bytes",
);
assert.ok(
  numberValue(enhanced.adaptive_path_only_observation_paths) > 0,
  "enhanced run should still use path-only observations where full metadata is unnecessary",
);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  baselineCoverage,
  enhancedCoverage,
  baselineBytesPerNodeSlice,
  enhancedBytesPerNodeSlice,
  baselineTotalBytes,
  enhancedTotalBytes,
  baselineMae,
  enhancedMae,
  compactPaths: enhanced.adaptive_metadata_compact_paths,
  pathOnlyPaths: enhanced.adaptive_path_only_observation_paths,
}, null, 2));
