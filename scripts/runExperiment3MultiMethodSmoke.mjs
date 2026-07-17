import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const BACKENDS = [
  "prior-only",
  "low-rank",
  "soft-impute",
  "kalman-smoother",
  "graph-neighbor",
  "graph-regularized",
  "st-gnn",
  "costco",
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

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
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function maskHash(rows) {
  return hash(rows
    .map((row) => `${row.slice_index}|${row.node_id}|${String(row.observed).toLowerCase()}`)
    .sort()
    .join("\n"));
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : "";
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment3:smoke] ${label}`);
    const startedAt = performance.now();
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed (${code})\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ wallClockMs: performance.now() - startedAt, stdout });
    });
  });
}

function observedLockAudit(observedRows, reconstructedRows) {
  const reconstructedByKey = new Map(reconstructedRows.map((row) => [`${row.slice_index}|${row.node_id}`, row]));
  let checked = 0;
  let violations = 0;
  for (const row of observedRows) {
    if (String(row.observed).toLowerCase() !== "true") continue;
    const reconstructed = reconstructedByKey.get(`${row.slice_index}|${row.node_id}`);
    checked += 1;
    if (!reconstructed || Math.abs(Number(row.cpu_percent_estimate) - Number(reconstructed.cpu_percent_estimate)) > 1e-9) {
      violations += 1;
    }
  }
  return { checked, violations, passed: checked > 0 && violations === 0 };
}

function buildHtml(summary) {
  const rows = summary.rows.map((row) => `<tr><td>${row.completion_backend}</td><td>${row.inferred_samples}</td><td>${row.inferred_mae}</td><td>${row.inferred_rmse}</td><td>${row.inferred_p95_ae}</td><td>${row.inferred_r2}</td><td>${row.completion_wall_clock_ms}</td><td>${row.observed_lock_passed ? "通过" : "失败"}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验3六方法短烟测</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:28px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8e0ea;padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#eef3f8}code{background:#eef3f8;padding:2px 4px}</style></head><body><h1>实验3：六方法短烟测</h1><p>使用既有 Ground OAM 输入的前 ${summary.slice_count} 个时间片，只重跑补全后端。该结果不是正式统计实验。</p><p>共享观测掩码：<code>${summary.observation_mask_sha256}</code></p><table><thead><tr><th>方法</th><th>推断样本</th><th>MAE</th><th>RMSE</th><th>P95 AE</th><th>R²</th><th>墙钟时间(ms)</th><th>观测锁定</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

const args = process.argv.slice(2);
const sliceLimit = Math.max(2, Math.floor(numberArg(args, "--slices", 8)));
const sourceTruthDir = resolve(argValue(args, "--truth", "reports/experiment2-native-baseline-rerun-final/iridium-next-small/stage1-truth"));
const sourceExperimentDir = resolve(argValue(args, "--source", "reports/experiment3-cpu-single-metric-completion/iridium-next-small"));
const outputDir = resolve(argValue(args, "--out", "reports/_scratch/experiment3-multi-method-smoke"));
const sourceObservedDir = join(sourceExperimentDir, "ground-oam", "observed-int-mc");

for (const path of [
  join(sourceTruthDir, "links.csv"),
  join(sourceTruthDir, "nodes.csv"),
  join(sourceObservedDir, "ground-reconstructed-links.csv"),
  join(sourceObservedDir, "ground-reconstructed-nodes.csv"),
]) {
  if (!existsSync(path)) throw new Error(`Smoke source artifact not found: ${path}`);
}

const [truthLinks, truthNodes, routes, observedLinks, observedNodes] = await Promise.all([
  readCsv(join(sourceTruthDir, "links.csv")),
  readCsv(join(sourceTruthDir, "nodes.csv")),
  existsSync(join(sourceTruthDir, "routes.csv")) ? readCsv(join(sourceTruthDir, "routes.csv")) : Promise.resolve([]),
  readCsv(join(sourceObservedDir, "ground-reconstructed-links.csv")),
  readCsv(join(sourceObservedDir, "ground-reconstructed-nodes.csv")),
]);
const selectedSlices = [...new Set(truthNodes.map((row) => String(row.slice_index)))]
  .sort((left, right) => Number(left) - Number(right))
  .slice(0, sliceLimit);
const selected = new Set(selectedSlices);
const filterSlices = (rows) => rows.filter((row) => selected.has(String(row.slice_index)));
const fixtureTruthDir = join(outputDir, "fixture", "truth");
const fixtureGroundDir = join(outputDir, "fixture", "ground-oam");
const fixtureStage2Dir = join(outputDir, "fixture", "stage2");
await Promise.all([
  mkdir(fixtureTruthDir, { recursive: true }),
  mkdir(fixtureGroundDir, { recursive: true }),
  mkdir(fixtureStage2Dir, { recursive: true }),
]);
const fixtureObservedNodes = filterSlices(observedNodes);
await Promise.all([
  writeFile(join(fixtureTruthDir, "links.csv"), rowsToCsv(filterSlices(truthLinks)), "utf8"),
  writeFile(join(fixtureTruthDir, "nodes.csv"), rowsToCsv(filterSlices(truthNodes)), "utf8"),
  writeFile(join(fixtureTruthDir, "routes.csv"), rowsToCsv(filterSlices(routes)), "utf8"),
  writeFile(join(fixtureGroundDir, "ground-reconstructed-links.csv"), rowsToCsv(filterSlices(observedLinks)), "utf8"),
  writeFile(join(fixtureGroundDir, "ground-reconstructed-nodes.csv"), rowsToCsv(fixtureObservedNodes), "utf8"),
]);

const rows = [];
for (const backend of BACKENDS) {
  const backendDir = join(outputDir, "backends", backend);
  await mkdir(backendDir, { recursive: true });
  const processResult = await runNode(backend, "stage2-int/tools/int-mc-reconstructor.mjs", [
    "--input", fixtureTruthDir,
    "--stage2", fixtureStage2Dir,
    "--ground", fixtureGroundDir,
    "--out", backendDir,
    "--algorithm", "int-mc",
    "--completion-backend", backend,
    "--link-metrics", "none",
    "--node-metrics", "cpu_percent",
    "--rank", "4",
    "--iterations", "6",
    "--window-size", String(Math.min(6, selectedSlices.length)),
    "--ml-epochs", "4",
    "--ml-training-samples", "2000",
    "--ml-hidden-units", "32",
    "--ml-hidden-layers", "2",
    "--ml-latent-rank", "16",
  ]);
  const evaluation = JSON.parse(await readFile(join(backendDir, "int-mc-evaluation.json"), "utf8"));
  const reconstructedNodes = await readCsv(join(backendDir, "ground-mc-reconstructed-nodes.csv"));
  const metric = evaluation.node_reconstruction.metrics.cpu_percent;
  const matrixSummary = evaluation.node_matrix_summaries.find((item) => item.metric === "cpu_percent") ?? {};
  const lockAudit = observedLockAudit(fixtureObservedNodes, reconstructedNodes);
  rows.push({
    completion_backend: backend,
    inferred_samples: metric.inferred_samples,
    inferred_mae: metric.inferred_mae,
    inferred_rmse: metric.inferred_rmse,
    inferred_p95_ae: metric.inferred_p95_ae,
    inferred_r2: metric.inferred_r2,
    completion_wall_clock_ms: matrixSummary.completion_wall_clock_ms ?? round(processResult.wallClockMs),
    process_wall_clock_ms: round(processResult.wallClockMs),
    observed_lock_checked: lockAudit.checked,
    observed_lock_violations: lockAudit.violations,
    observed_lock_passed: lockAudit.passed,
    truth_used_only_for_evaluation: evaluation.boundary.truth_metrics_used_only_for_evaluation === true,
  });
}

const summary = {
  schema_version: "experiment3-multi-method-smoke-v1",
  generated_at: new Date().toISOString(),
  formal_experiment: false,
  profile: "iridium-next-small",
  slice_indexes: selectedSlices.map(Number),
  slice_count: selectedSlices.length,
  backends: BACKENDS,
  observation_mask_sha256: maskHash(fixtureObservedNodes),
  all_observed_locks_passed: rows.every((row) => row.observed_lock_passed),
  all_truth_boundaries_passed: rows.every((row) => row.truth_used_only_for_evaluation),
  rows,
};
if (!summary.all_observed_locks_passed || !summary.all_truth_boundaries_passed) {
  throw new Error(`Experiment 3 smoke invariant failed: ${JSON.stringify(summary.rows)}`);
}

await Promise.all([
  writeFile(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8"),
  writeFile(join(outputDir, "summary.csv"), rowsToCsv(rows), "utf8"),
  writeFile(join(outputDir, "report.html"), buildHtml(summary), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  output_dir: outputDir,
  slice_count: selectedSlices.length,
  observation_mask_sha256: summary.observation_mask_sha256,
  rows,
}, null, 2));
