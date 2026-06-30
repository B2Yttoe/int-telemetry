import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function boolArg(args, name, fallback = true) {
  const value = argValue(args, name, "");
  if (!value) return fallback;
  return value !== "false";
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function countCsvRows(path) {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return 0;
  let rowCount = 0;
  let quoted = false;
  let hasCellData = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') index += 1;
      else quoted = !quoted;
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (hasCellData) rowCount += 1;
      hasCellData = false;
      if (char === "\r" && next === "\n") index += 1;
    } else if (char !== "," && char !== " " && char !== "\t") {
      hasCellData = true;
    }
  }
  if (hasCellData) rowCount += 1;
  return Math.max(rowCount - 1, 0);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveFromRun(runDir, value, fallback = "") {
  if (value) return resolve(String(value));
  return resolve(runDir, fallback);
}

function samePath(left, right) {
  if (!left || !right) return false;
  return resolve(String(left)) === resolve(String(right));
}

function nestedValue(object, path) {
  return path.split(".").reduce((current, part) => (current && current[part] !== undefined ? current[part] : undefined), object);
}

function nearlyAtLeast(value, threshold) {
  return typeof value === "number" && value + 1e-9 >= threshold;
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  return String(value);
}

function markdownTable(rows) {
  return [
    "| 检查项 | 结果 | 证据 |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.label} | ${row.passed ? "通过" : "未通过"} | ${row.evidence.replaceAll("|", "\\|")} |`),
  ].join("\n");
}

function fileIndexMarkdown(rows) {
  return [
    "| 角色 | 相对路径 | 字节数 | SHA-256 |",
    "|---|---|---:|---|",
    ...rows.map((row) => `| ${row.role} | ${row.relative_path.replaceAll("|", "\\|")} | ${row.size_bytes} | ${row.sha256} |`),
  ].join("\n");
}

const args = process.argv.slice(2);
const runArg = argValue(args, "--run", "");
const manifestArg = argValue(args, "--manifest", runArg ? join(runArg, "int-experiment-manifest.json") : "");
if (!manifestArg) {
  throw new Error("Usage: npm run int:verify -- --run stage2-int/runs/<run-name>");
}

const manifestPath = resolve(manifestArg);
if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);

const manifest = await readJson(manifestPath);
const runDir = resolve(runArg || manifest.run_dir || dirname(manifestPath));
const minProbeNodeCoverage = numberArg(args, "--min-probe-node-coverage", 1);
const minProbeLinkCoverage = numberArg(args, "--min-probe-link-coverage", 1);
const requireProbeFull = boolArg(args, "--require-probe-full", true);
const requireNoUnknownProbe = boolArg(args, "--require-no-unknown-probe", true);
const writeReport = boolArg(args, "--write", true);

const stage1Dir = resolveFromRun(runDir, manifest.outputs?.stage1_truth_dir, "stage1-truth");
const stage2Dir = resolveFromRun(runDir, manifest.outputs?.stage2_int_dir, "stage2-int");
const trafficGroundDir = resolveFromRun(runDir, manifest.outputs?.traffic_ground_oam_dir, "stage2-int/ground-traffic-int");
const probeGroundDir = resolveFromRun(
  runDir,
  manifest.outputs?.probe_ground_oam_dir,
  `stage2-int/ground-probe-${manifest.input?.algorithm ?? "path-balance"}`,
);
const algorithm = manifest.input?.algorithm ?? "path-balance";

const checks = [];
function check(label, passed, evidence, extra = {}) {
  checks.push({
    label,
    passed: Boolean(passed),
    evidence,
    ...extra,
  });
}

function checkPath(label, path) {
  const exists = existsSync(path);
  const size = exists ? statSync(path).size : 0;
  check(label, exists && size >= 0, `${path}${exists ? ` (${size} bytes)` : " missing"}`, { path, size });
}

check("manifest schema", manifest.schema_version === "stage2-int-experiment-run-v1", formatValue(manifest.schema_version));
check("manifest objective", String(manifest.objective ?? "").includes("INT telemetry"), formatValue(manifest.objective));
check("stage1 runtime truth boundary", manifest.boundary?.stage1_truth_used_for_runtime === false, formatValue(manifest.boundary?.stage1_truth_used_for_runtime));
check("truth only for validation", manifest.boundary?.truth_used_only_for_validation === true, formatValue(manifest.boundary?.truth_used_only_for_validation));
check("ground OAM uses delivered reports", manifest.boundary?.ground_oam_uses_only_delivered_reports === true, formatValue(manifest.boundary?.ground_oam_uses_only_delivered_reports));
check("unknown not filled from truth", manifest.boundary?.unknown_not_filled_from_truth === true, formatValue(manifest.boundary?.unknown_not_filled_from_truth));
check("stage1 validation has no errors", (manifest.stage1?.validation?.errors ?? []).length === 0, `${(manifest.stage1?.validation?.errors ?? []).length} errors`);

const requiredFiles = {
  manifest: manifestPath,
  readme: resolveFromRun(runDir, manifest.outputs?.readme_md, "README.md"),
  inputValidationJson: resolveFromRun(runDir, manifest.outputs?.input_validation_json, "input-dataset-validation.json"),
  inputValidationMarkdown: resolveFromRun(runDir, manifest.outputs?.input_validation_md, "input-dataset-validation.md"),
  deliverablesJson: resolveFromRun(runDir, manifest.outputs?.deliverables_json, "int-telemetry-deliverables.json"),
  deliverablesMarkdown: resolveFromRun(runDir, manifest.outputs?.deliverables_md, "int-telemetry-deliverables.md"),
  processVisualizationJson: resolveFromRun(runDir, manifest.outputs?.process_visualization_json, "int-process-visualization.json"),
  processVisualizationMarkdown: resolveFromRun(runDir, manifest.outputs?.process_visualization_md, "int-process-visualization.md"),
  accuracyReportJson: resolveFromRun(runDir, manifest.outputs?.accuracy_report_json, "int-telemetry-accuracy-report.json"),
  accuracyReportMarkdown: resolveFromRun(runDir, manifest.outputs?.accuracy_report_md, "int-telemetry-accuracy-report.md"),
  report: resolveFromRun(runDir, manifest.outputs?.report_md, "int-experiment-report.md"),
  stage1Nodes: join(stage1Dir, "nodes.csv"),
  stage1Links: join(stage1Dir, "links.csv"),
  stage1Routes: join(stage1Dir, "routes.csv"),
  stage1Metrics: join(stage1Dir, "metrics.csv"),
  trafficHops: join(stage2Dir, "int-hop-records.csv"),
  trafficReports: join(stage2Dir, "int-reports.csv"),
  probeHops: join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
  probeReports: join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
  probePaths: join(stage2Dir, `probe-paths-${algorithm}.csv`),
  reportingPaths: join(stage2Dir, `reporting-paths-${algorithm}.csv`),
  trafficEvaluation: join(trafficGroundDir, "ground-oam-evaluation.json"),
  probeEvaluation: join(probeGroundDir, "ground-oam-evaluation.json"),
  coverageAudit: join(probeGroundDir, "full-telemetry-coverage-audit.json"),
  reconstructedNodes: join(probeGroundDir, "ground-reconstructed-nodes.csv"),
  reconstructedLinks: join(probeGroundDir, "ground-reconstructed-links.csv"),
};

Object.entries(requiredFiles).forEach(([label, path]) => checkPath(`file exists: ${label}`, path));
if (manifest.input?.tasks_snapshot_path) {
  checkPath("file exists: taskDatasetSnapshot", resolve(String(manifest.input.tasks_snapshot_path)));
}

const csvExpectations = [
  ["stage1 nodes rows", requiredFiles.stage1Nodes, manifest.stage1?.counts?.nodes],
  ["stage1 links rows", requiredFiles.stage1Links, manifest.stage1?.counts?.links],
  ["stage1 routes rows", requiredFiles.stage1Routes, manifest.stage1?.counts?.routes],
  ["stage1 metrics rows", requiredFiles.stage1Metrics, manifest.stage1?.counts?.metrics],
  ["traffic hop rows", requiredFiles.trafficHops, manifest.int_pipeline?.traffic_int?.hopRecords],
  ["traffic report rows", requiredFiles.trafficReports, manifest.int_pipeline?.traffic_int?.reports],
  ["probe hop rows", requiredFiles.probeHops, manifest.int_pipeline?.probe_int?.hopRecords],
  ["probe report rows", requiredFiles.probeReports, manifest.int_pipeline?.probe_int?.reports],
  ["probe path rows", requiredFiles.probePaths, manifest.int_pipeline?.probe_int?.probePaths],
  ["reporting path rows", requiredFiles.reportingPaths, manifest.int_pipeline?.reporting?.plannedReportingPaths],
  ["probe reconstructed node rows", requiredFiles.reconstructedNodes, manifest.stage1?.counts?.nodes],
  ["probe reconstructed link rows", requiredFiles.reconstructedLinks, manifest.stage1?.counts?.links],
];

for (const [label, path, expected] of csvExpectations) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const actual = await countCsvRows(path);
  check(label, actual === expected, `actual=${actual}, expected=${formatValue(expected)}`, { actual, expected });
}

const trafficEvaluation = existsSync(requiredFiles.trafficEvaluation) ? await readJson(requiredFiles.trafficEvaluation) : {};
const probeEvaluation = existsSync(requiredFiles.probeEvaluation) ? await readJson(requiredFiles.probeEvaluation) : {};
const coverageAudit = existsSync(requiredFiles.coverageAudit) ? await readJson(requiredFiles.coverageAudit) : {};
const inputValidation = existsSync(requiredFiles.inputValidationJson) ? await readJson(requiredFiles.inputValidationJson) : {};
const deliverables = existsSync(requiredFiles.deliverablesJson) ? await readJson(requiredFiles.deliverablesJson) : {};
const processVisualization = existsSync(requiredFiles.processVisualizationJson) ? await readJson(requiredFiles.processVisualizationJson) : {};
const accuracyReport = existsSync(requiredFiles.accuracyReportJson) ? await readJson(requiredFiles.accuracyReportJson) : {};

check("traffic OAM boundary", trafficEvaluation.boundary?.runtime_uses_only_delivered_int_reports === true, formatValue(trafficEvaluation.boundary?.runtime_uses_only_delivered_int_reports));
check("probe OAM boundary", probeEvaluation.boundary?.runtime_uses_only_delivered_int_reports === true, formatValue(probeEvaluation.boundary?.runtime_uses_only_delivered_int_reports));
check("input validation schema", inputValidation.schema_version === "stage2-int-input-dataset-validation-v1", formatValue(inputValidation.schema_version));
check("input validation pass", inputValidation.status?.pass === true, formatValue(inputValidation.status?.pass));
check("input validation stage1 errors", inputValidation.status?.stage1_effective_errors === 0, formatValue(inputValidation.status?.stage1_effective_errors));
check("input validation snapshot path", !manifest.input?.tasks_snapshot_path || samePath(inputValidation.input?.task_dataset_snapshot, manifest.input.tasks_snapshot_path), formatValue(inputValidation.input?.task_dataset_snapshot));
check("input validation stage1 fingerprint", inputValidation.fingerprints?.stage1_dataset === manifest.stage1?.fingerprints?.dataset, formatValue(inputValidation.fingerprints?.stage1_dataset));
check("deliverables schema", deliverables.schema_version === "stage2-int-telemetry-deliverables-v1", formatValue(deliverables.schema_version));
check("deliverables primary node dataset", samePath(deliverables.primary_int_state_dataset?.node_state_csv, requiredFiles.reconstructedNodes), formatValue(deliverables.primary_int_state_dataset?.node_state_csv));
check("deliverables primary link dataset", samePath(deliverables.primary_int_state_dataset?.link_state_csv, requiredFiles.reconstructedLinks), formatValue(deliverables.primary_int_state_dataset?.link_state_csv));
check("deliverables input validation", samePath(deliverables.input?.input_validation_json, requiredFiles.inputValidationJson), formatValue(deliverables.input?.input_validation_json));
check("deliverables final accuracy report", samePath(deliverables.validation?.final_accuracy_report_json, requiredFiles.accuracyReportJson), formatValue(deliverables.validation?.final_accuracy_report_json));
check("deliverables process visualization", samePath(deliverables.process_visualization?.visualization_json, requiredFiles.processVisualizationJson), formatValue(deliverables.process_visualization?.visualization_json));
check("deliverables probe node coverage", deliverables.primary_int_state_dataset?.coverage?.node_sample_coverage === manifest.accuracy?.probe_int?.node_sample_coverage, formatValue(deliverables.primary_int_state_dataset?.coverage?.node_sample_coverage));
check("deliverables probe link coverage", deliverables.primary_int_state_dataset?.coverage?.link_sample_coverage === manifest.accuracy?.probe_int?.link_sample_coverage, formatValue(deliverables.primary_int_state_dataset?.coverage?.link_sample_coverage));
check("deliverables validation truth boundary", deliverables.validation?.truth_boundary?.truth_used_only_for_validation === true, formatValue(deliverables.validation?.truth_boundary?.truth_used_only_for_validation));
check("deliverables unknown boundary", deliverables.validation?.truth_boundary?.unknown_not_filled_from_truth === true, formatValue(deliverables.validation?.truth_boundary?.unknown_not_filled_from_truth));
check("process visualization schema", processVisualization.schema_version === "stage2-int-process-visualization-v1", formatValue(processVisualization.schema_version));
check("process visualization slice count", Array.isArray(processVisualization.slices) && processVisualization.slices.length === manifest.stage1?.counts?.metrics, `actual=${processVisualization.slices?.length ?? 0}, expected=${formatValue(manifest.stage1?.counts?.metrics)}`);
check("process visualization has probes", (processVisualization.summary?.probes ?? 0) === manifest.int_pipeline?.probe_int?.probePaths, `actual=${formatValue(processVisualization.summary?.probes)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.probePaths)}`);
check("process visualization has hop events", (processVisualization.summary?.hop_events ?? 0) === manifest.int_pipeline?.probe_int?.hopRecords, `actual=${formatValue(processVisualization.summary?.hop_events)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.hopRecords)}`);
check("process visualization has report events", (processVisualization.summary?.report_events ?? 0) === manifest.int_pipeline?.probe_int?.reports, `actual=${formatValue(processVisualization.summary?.report_events)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.reports)}`);
check("process visualization OAM snapshots", Array.isArray(processVisualization.slices) && processVisualization.slices.every((slice) => slice.oam_reconstruction?.nodes?.length > 0 && slice.oam_reconstruction?.links?.length > 0), "every slice has reconstructed nodes and links");
check("process visualization non-truth state boundary", processVisualization.boundary?.process_view_uses_truth_for_state === false, formatValue(processVisualization.boundary?.process_view_uses_truth_for_state));
check("accuracy report schema", accuracyReport.schema_version === "stage2-int-telemetry-accuracy-report-v1", formatValue(accuracyReport.schema_version));
check("accuracy report conclusion", accuracyReport.conclusion?.pass === true, formatValue(accuracyReport.conclusion?.pass));
check("accuracy report primary node dataset", samePath(accuracyReport.primary_probe_int?.node_state_csv, requiredFiles.reconstructedNodes), formatValue(accuracyReport.primary_probe_int?.node_state_csv));
check("accuracy report primary link dataset", samePath(accuracyReport.primary_probe_int?.link_state_csv, requiredFiles.reconstructedLinks), formatValue(accuracyReport.primary_probe_int?.link_state_csv));
check("accuracy report probe node coverage", accuracyReport.primary_probe_int?.metrics?.node_sample_coverage === manifest.accuracy?.probe_int?.node_sample_coverage, formatValue(accuracyReport.primary_probe_int?.metrics?.node_sample_coverage));
check("accuracy report probe link coverage", accuracyReport.primary_probe_int?.metrics?.link_sample_coverage === manifest.accuracy?.probe_int?.link_sample_coverage, formatValue(accuracyReport.primary_probe_int?.metrics?.link_sample_coverage));
check("accuracy report coverage audit pass", accuracyReport.primary_probe_int?.coverage_audit_summary?.pass === true, formatValue(accuracyReport.primary_probe_int?.coverage_audit_summary?.pass));
check("probe node coverage threshold", nearlyAtLeast(manifest.accuracy?.probe_int?.node_sample_coverage, minProbeNodeCoverage), formatValue(manifest.accuracy?.probe_int?.node_sample_coverage));
check("probe link coverage threshold", nearlyAtLeast(manifest.accuracy?.probe_int?.link_sample_coverage, minProbeLinkCoverage), formatValue(manifest.accuracy?.probe_int?.link_sample_coverage));
check("probe active link coverage", nearlyAtLeast(manifest.accuracy?.probe_int?.active_link_sample_coverage, 1), formatValue(manifest.accuracy?.probe_int?.active_link_sample_coverage));
check("probe mode accuracy", nearlyAtLeast(manifest.accuracy?.probe_int?.mode_accuracy, 1), formatValue(manifest.accuracy?.probe_int?.mode_accuracy));
check("probe link status accuracy", nearlyAtLeast(manifest.accuracy?.probe_int?.link_status_accuracy, 1), formatValue(manifest.accuracy?.probe_int?.link_status_accuracy));

if (requireNoUnknownProbe) {
  check("probe unknown node samples", manifest.accuracy?.probe_int?.unknown_node_samples === 0, formatValue(manifest.accuracy?.probe_int?.unknown_node_samples));
  check("probe unknown link samples", manifest.accuracy?.probe_int?.unknown_link_samples === 0, formatValue(manifest.accuracy?.probe_int?.unknown_link_samples));
}

if (requireProbeFull) {
  check("probe full time-step pass", manifest.accuracy?.probe_int?.full_time_step_pass === true, formatValue(manifest.accuracy?.probe_int?.full_time_step_pass));
  check("coverage audit pass", coverageAudit.summary?.pass === true, formatValue(coverageAudit.summary?.pass));
  check("coverage audit passed slices", coverageAudit.summary?.passed_slices === manifest.stage1?.counts?.metrics, `passed=${formatValue(coverageAudit.summary?.passed_slices)}, slices=${formatValue(manifest.stage1?.counts?.metrics)}`);
  const failedSlices = Array.isArray(coverageAudit.slices) ? coverageAudit.slices.filter((slice) => !slice.pass) : [];
  check("coverage audit failed slice count", failedSlices.length === 0, `${failedSlices.length} failed slices`);
}

check("traffic INT remains partial or equal", (manifest.accuracy?.traffic_int?.node_sample_coverage ?? 0) <= 1, formatValue(manifest.accuracy?.traffic_int?.node_sample_coverage));
check("experiment report includes accuracy section", existsSync(requiredFiles.report) && (await readFile(requiredFiles.report, "utf8")).includes("准确率与覆盖率"), requiredFiles.report);

const passed = checks.filter((item) => item.passed).length;
const failed = checks.length - passed;
const report = {
  schema_version: "stage2-int-experiment-verification-v1",
  generated_at: new Date().toISOString(),
  run_dir: runDir,
  manifest_path: manifestPath,
  thresholds: {
    min_probe_node_coverage: minProbeNodeCoverage,
    min_probe_link_coverage: minProbeLinkCoverage,
    require_probe_full: requireProbeFull,
    require_no_unknown_probe: requireNoUnknownProbe,
  },
  summary: {
    pass: failed === 0,
    checks: checks.length,
    passed,
    failed,
    config_fingerprint: manifest.stage1?.fingerprints?.config ?? "",
    dataset_fingerprint: manifest.stage1?.fingerprints?.dataset ?? "",
    truth_fingerprint: manifest.stage1?.fingerprints?.truth ?? "",
    traffic_node_coverage: manifest.accuracy?.traffic_int?.node_sample_coverage ?? null,
    traffic_link_coverage: manifest.accuracy?.traffic_int?.link_sample_coverage ?? null,
    probe_node_coverage: manifest.accuracy?.probe_int?.node_sample_coverage ?? null,
    probe_link_coverage: manifest.accuracy?.probe_int?.link_sample_coverage ?? null,
    probe_full_time_step_pass: manifest.accuracy?.probe_int?.full_time_step_pass ?? null,
  },
  checks,
};

if (writeReport) {
  const outputJson = join(runDir, "int-experiment-verification.json");
  const outputMd = join(runDir, "int-experiment-verification.md");
  const fileIndexJson = join(runDir, "int-experiment-file-index.json");
  const fileIndexMd = join(runDir, "int-experiment-file-index.md");
  await mkdir(runDir, { recursive: true });
  await writeFile(outputJson, JSON.stringify(report, null, 2), "utf8");
  await writeFile(
    outputMd,
    [
      "# INT 实验验收报告",
      "",
      `- 结论：${report.summary.pass ? "通过" : "未通过"}`,
      `- 检查项：${passed}/${checks.length}`,
      `- 配置指纹：${formatValue(report.summary.config_fingerprint)}`,
      `- 数据集指纹：${formatValue(report.summary.dataset_fingerprint)}`,
      `- 真值指纹：${formatValue(report.summary.truth_fingerprint)}`,
      `- probe-int 节点/链路覆盖：${formatValue(report.summary.probe_node_coverage)} / ${formatValue(report.summary.probe_link_coverage)}`,
      `- 全网逐时间片：${formatValue(report.summary.probe_full_time_step_pass)}`,
      "",
      markdownTable(checks),
      "",
    ].join("\n"),
    "utf8",
  );

  const indexCandidates = new Map();
  const addIndexCandidate = (role, path) => {
    if (!path || !existsSync(path)) return;
    indexCandidates.set(resolve(path), role);
  };
  Object.entries(requiredFiles).forEach(([role, path]) => addIndexCandidate(role, path));
  if (manifest.input?.tasks_snapshot_path) addIndexCandidate("taskDatasetSnapshot", String(manifest.input.tasks_snapshot_path));
  addIndexCandidate("verificationJson", outputJson);
  addIndexCandidate("verificationMarkdown", outputMd);

  const fileRows = [];
  for (const [path, role] of [...indexCandidates.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stats = statSync(path);
    fileRows.push({
      role,
      path,
      relative_path: path.startsWith(runDir) ? path.slice(runDir.length + 1) : path,
      size_bytes: stats.size,
      sha256: await sha256File(path),
    });
  }

  const fileIndex = {
    schema_version: "stage2-int-experiment-file-index-v1",
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    manifest_path: manifestPath,
    hash_algorithm: "sha256",
    file_count: fileRows.length,
    files: fileRows,
  };
  await writeFile(fileIndexJson, JSON.stringify(fileIndex, null, 2), "utf8");
  await writeFile(
    fileIndexMd,
    [
      "# INT 实验文件完整性索引",
      "",
      `- 文件数：${fileRows.length}`,
      "- 哈希算法：SHA-256",
      "",
      fileIndexMarkdown(fileRows),
      "",
    ].join("\n"),
    "utf8",
  );

  report.outputs = {
    verification_json: outputJson,
    verification_md: outputMd,
    file_index_json: fileIndexJson,
    file_index_md: fileIndexMd,
  };
}

console.log(JSON.stringify(report, null, 2));
if (!report.summary.pass) process.exit(1);
