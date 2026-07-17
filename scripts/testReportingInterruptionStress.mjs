import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { applyControlledReportingInterruptions } from "../stage2-int/tools/reporting-interruption.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

const reports = [0, 1].flatMap((sliceIndex) =>
  Array.from({ length: 10 }, (_, index) => ({
    slice_index: sliceIndex,
    probe_id: `P-${sliceIndex}-${index}`,
    reporting_status: index === 9 ? "blocked" : "planned",
    status: index === 9 ? "dropped" : "generated",
    drop_reason: index === 9 ? "no-reporting-path" : "",
  })),
);

const zero = applyControlledReportingInterruptions(reports, { rate: 0, seed: "fixture" });
assert.deepEqual(zero.reports, reports);
assert.equal(zero.summary.interrupted_reports, 0);

const stressed = applyControlledReportingInterruptions(reports, { rate: 0.2, seed: "fixture" });
assert.equal(stressed.summary.eligible_reports, 18);
assert.equal(stressed.summary.interrupted_reports, 4);
assert.equal(stressed.reports.filter((row) => row.reporting_status === "interrupted").length, 4);
assert.equal(stressed.reports.filter((row) => row.reporting_status === "blocked").length, 2);
assert.ok(stressed.reports.filter((row) => row.reporting_status === "interrupted").every((row) =>
  row.status === "dropped" && row.drop_reason === "controlled-reporting-path-interruption"
));

const repeated = applyControlledReportingInterruptions(reports, { rate: 0.2, seed: "fixture" });
assert.deepEqual(repeated.reports, stressed.reports);

const execFileAsync = promisify(execFile);
const outputDir = resolve("reports/tmp-reporting-interruption-test");
if (!outputDir.endsWith("tmp-reporting-interruption-test")) throw new Error(`Unexpected test path: ${outputDir}`);
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
await execFileAsync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", resolve("exports/tmp-highload-check"),
  "--stage2", resolve("stage2-int/outputs/tmp-highload-check"),
  "--out", outputDir,
  "--algorithm", "path-balance",
  "--reporting-interruption-rate", "0.2",
  "--reporting-interruption-seed", "fixture-cli",
], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
const cliReports = parseCsv(await readFile(resolve(outputDir, "probe-int-reports-path-balance.csv"), "utf8"));
const cliSummary = JSON.parse(await readFile(resolve(outputDir, "probe-int-run-report-path-balance.json"), "utf8"));
assert.ok(cliReports.some((row) => row.reporting_status === "interrupted"));
assert.ok(cliSummary.planning.controlled_reporting_interruptions > 0);

const groundDir = resolve(outputDir, "ground-lightweight");
await execFileAsync(process.execPath, [
  "stage2-int/tools/ground-oam-reconstructor.mjs",
  "--input", resolve("exports/tmp-highload-check"),
  "--stage2", resolve("stage2-int/outputs/tmp-highload-check"),
  "--out", groundDir,
  "--hops", resolve(outputDir, "probe-int-hop-records-path-balance.csv"),
  "--reports", resolve(outputDir, "probe-int-reports-path-balance.csv"),
  "--downlink-budget-bytes", "1000000000",
  "--write-estimate-graph", "false",
], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });
assert.ok(existsSync(resolve(groundDir, "ground-oam-evaluation.json")));
assert.ok(existsSync(resolve(groundDir, "ground-reconstructed-nodes.csv")));
assert.ok(existsSync(resolve(groundDir, "ground-reconstructed-links.csv")));
assert.equal(existsSync(resolve(groundDir, "ground-oam-estimate-graph.json")), false);

console.log(JSON.stringify({
  ok: true,
  ...stressed.summary,
  cli_interrupted_reports: cliReports.filter((row) => row.reporting_status === "interrupted").length,
}, null, 2));
