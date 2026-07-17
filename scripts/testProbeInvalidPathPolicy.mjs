import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

const execFileAsync = promisify(execFile);
const inputDir = resolve("exports/tmp-highload-check");
const sourceStage2Dir = resolve("stage2-int/outputs/tmp-highload-check");
const outputDir = resolve("reports/tmp-probe-invalid-path-test");
if (!outputDir.endsWith("tmp-probe-invalid-path-test")) throw new Error(`Unexpected test path: ${outputDir}`);
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const links = parseCsv(await readFile(resolve(inputDir, "links.csv"), "utf8"));
const failedLink = links.find((row) => row.status === "down" && row.source && row.target);
const warningLink = links.find((row) => row.status === "warning" && row.is_active === "true" && row.source && row.target);
assert.ok(failedLink, "fixture must contain a down link");
assert.ok(warningLink, "fixture must contain an active warning link");
const sourceProbe = parseCsv(await readFile(resolve(sourceStage2Dir, "probe-paths-path-balance.csv"), "utf8"))[0];
const sourceReporting = parseCsv(await readFile(resolve(sourceStage2Dir, "reporting-paths-path-balance.csv"), "utf8"))[0];
const probe = {
  ...sourceProbe,
  probe_id: "STATIC-INVALID-001",
  slice_index: failedLink.slice_index,
  time: failedLink.time,
  source: failedLink.source,
  sink: failedLink.target,
  path_node_count: 2,
  path_link_count: 1,
  covered_link_count: 1,
  path: `${failedLink.source} > ${failedLink.target}`,
  link_ids: failedLink.link_id,
};
const reporting = {
  ...sourceReporting,
  probe_id: probe.probe_id,
  slice_index: probe.slice_index,
  time: probe.time,
  sink_node: probe.sink,
  reporting_status: "planned",
};
const warningProbe = {
  ...probe,
  probe_id: "STATIC-WARNING-001",
  slice_index: warningLink.slice_index,
  time: warningLink.time,
  source: warningLink.source,
  sink: warningLink.target,
  path: `${warningLink.source} > ${warningLink.target}`,
  link_ids: warningLink.link_id,
};
const warningReporting = {
  ...reporting,
  probe_id: warningProbe.probe_id,
  slice_index: warningProbe.slice_index,
  time: warningProbe.time,
  sink_node: warningProbe.sink,
};
const probePath = resolve(outputDir, "probe-paths.csv");
const reportingPath = resolve(outputDir, "reporting-paths.csv");
await Promise.all([
  writeFile(probePath, rowsToCsv([probe, warningProbe]), "utf8"),
  writeFile(reportingPath, rowsToCsv([reporting, warningReporting]), "utf8"),
]);

await execFileAsync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", inputDir,
  "--stage2", sourceStage2Dir,
  "--out", outputDir,
  "--algorithm", "path-balance",
  "--probe-paths", probePath,
  "--reporting-paths", reportingPath,
  "--invalid-probe-policy", "drop",
], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });

const reports = parseCsv(await readFile(resolve(outputDir, "probe-int-reports-path-balance.csv"), "utf8"));
const runReport = JSON.parse(await readFile(resolve(outputDir, "probe-int-run-report-path-balance.json"), "utf8"));
assert.equal(reports.length, 2);
assert.equal(reports[0].status, "dropped");
assert.equal(reports[0].reporting_status, "probe-path-failed");
assert.match(reports[0].drop_reason, /invalid-probe-path/);
assert.equal(reports[1].status, "generated");
assert.equal(runReport.planning.invalid_probe_paths, 1);
assert.equal(runReport.planning.invalid_probe_path_ratio, 0.5);

console.log(JSON.stringify({ ok: true, failed_link_id: failedLink.link_id }, null, 2));
