import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(command, args, label, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: options.shell ?? false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        label,
        command: `${command} ${args.join(" ")}`,
        code,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      };
      if (code !== 0) {
        reject(new Error(`${label} failed with code ${code}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function parseLastJson(stdout, label) {
  const text = stdout.trim();
  if (!text) throw new Error(`${label} produced no stdout`);
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") candidates.push(index);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(text.slice(candidates[index]));
    } catch {
      // Try the previous opening brace.
    }
  }
  throw new Error(`${label} did not contain parseable JSON`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function check(checks, label, passed, evidence = "") {
  checks.push({ label, passed: Boolean(passed), evidence });
}

function pct(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "-";
}

function markdownTable(checks) {
  return [
    "| 检查项 | 结果 | 证据 |",
    "|---|---|---|",
    ...checks.map((item) => `| ${item.label} | ${item.passed ? "通过" : "未通过"} | ${String(item.evidence ?? "").replace(/\|/g, "\\|")} |`),
  ].join("\n");
}

const args = process.argv.slice(2);
const tasks = resolve(argValue(args, "--tasks", "examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv"));
const orbit = argValue(args, "--orbit", "real-tle-sgp4");
const mode = argValue(args, "--mode", "operational");
const algorithm = argValue(args, "--algorithm", "path-balance");
const routing = argValue(args, "--routing", "shortest-path");
const slices = argValue(args, "--slices", "");
const tleSnapshot = resolve(
  argValue(args, "--tle-snapshot", "data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json"),
);
const reportDir = resolve(argValue(args, "--report-dir", "reports/goal"));
const out = resolve(argValue(args, "--out", `stage2-int/runs/goal-e2e-${nowStamp()}`));
const skipStage1 = hasArg(args, "--skip-stage1");
const skipBuild = hasArg(args, "--skip-build");

if (!existsSync(tasks)) throw new Error(`Task dataset not found: ${tasks}`);
if (orbit === "real-tle-sgp4" && !existsSync(tleSnapshot)) throw new Error(`TLE snapshot not found: ${tleSnapshot}`);

await mkdir(reportDir, { recursive: true });

const commands = [];
let stage1Verification = null;
if (!skipStage1) {
  const stage1Result = await runCommand(process.execPath, ["scripts/verifyStageOne.mjs"], "stage1 verification");
  commands.push({
    label: stage1Result.label,
    command: stage1Result.command,
    duration_ms: stage1Result.duration_ms,
  });
  stage1Verification = parseLastJson(stage1Result.stdout, "stage1 verification");
}

const experimentArgs = [
  "stage2-int/tools/run-int-experiment.mjs",
  "--tasks",
  tasks,
  "--out",
  out,
  "--orbit",
  orbit,
  "--mode",
  mode,
  "--routing",
  routing,
  "--algorithm",
  algorithm,
];
if (orbit === "real-tle-sgp4") experimentArgs.push("--tle-snapshot", tleSnapshot);
if (slices) experimentArgs.push("--slices", slices);

const experimentResult = await runCommand(
  process.execPath,
  experimentArgs,
  "INT end-to-end experiment",
);
commands.push({
  label: experimentResult.label,
  command: experimentResult.command,
  duration_ms: experimentResult.duration_ms,
});
const experiment = parseLastJson(experimentResult.stdout, "INT end-to-end experiment");

const verifyResult = await runCommand(
  process.execPath,
  ["stage2-int/tools/verify-int-experiment.mjs", "--run", out],
  "INT experiment verification",
);
commands.push({
  label: verifyResult.label,
  command: verifyResult.command,
  duration_ms: verifyResult.duration_ms,
});
const intVerification = parseLastJson(verifyResult.stdout, "INT experiment verification");

let buildPassed = null;
if (!skipBuild) {
  const buildResult = await runCommand(npmCommand(), ["run", "build"], "frontend build", { shell: true });
  commands.push({
    label: buildResult.label,
    command: buildResult.command,
    duration_ms: buildResult.duration_ms,
  });
  buildPassed = buildResult.code === 0;
}

const manifestPath = join(out, "int-experiment-manifest.json");
const inputValidationPath = join(out, "input-dataset-validation.json");
const deliverablesPath = join(out, "int-telemetry-deliverables.json");
const processVisualizationPath = join(out, "int-process-visualization.json");
const accuracyPath = join(out, "int-telemetry-accuracy-report.json");
const fileIndexPath = join(out, "int-experiment-file-index.json");

const manifest = await readJson(manifestPath);
const inputValidation = await readJson(inputValidationPath);
const deliverables = await readJson(deliverablesPath);
const processVisualization = await readJson(processVisualizationPath);
const accuracy = await readJson(accuracyPath);
const fileIndex = await readJson(fileIndexPath);

const checks = [];
check(
  checks,
  "第一阶段高仿真底座验收",
  skipStage1 || stage1Verification?.overall_passed === true,
  skipStage1 ? "跳过" : `score=${stage1Verification?.assessment_summary?.score}/${stage1Verification?.assessment_summary?.max_score}`,
);
check(checks, "外部业务数据集快照存在", existsSync(manifest.input.tasks_snapshot_path), manifest.input.tasks_snapshot_path);
check(checks, "输入数据集校验通过", inputValidation.status?.pass === true, `raw_errors=${inputValidation.status?.raw_dataset_errors}, stage1_errors=${inputValidation.status?.stage1_effective_errors}`);
check(checks, "第一阶段真值未参与 INT 运行", manifest.boundary?.stage1_truth_used_for_runtime === false, String(manifest.boundary?.stage1_truth_used_for_runtime));
check(checks, "真值仅用于检验", manifest.boundary?.truth_used_only_for_validation === true, String(manifest.boundary?.truth_used_only_for_validation));
check(checks, "OAM 只使用已下传 INT 报告", manifest.boundary?.ground_oam_uses_only_delivered_reports === true, String(manifest.boundary?.ground_oam_uses_only_delivered_reports));
check(checks, "unknown 不用真值补齐", manifest.boundary?.unknown_not_filled_from_truth === true, String(manifest.boundary?.unknown_not_filled_from_truth));
check(checks, "INT 实验脚本返回 verified", experiment.verified === true, String(experiment.verified));
check(checks, "INT 独立复验通过", intVerification.summary?.pass === true, `${intVerification.summary?.passed}/${intVerification.summary?.checks}`);
check(checks, "交付清单指向节点状态主输出", existsSync(deliverables.primary_int_state_dataset?.node_state_csv), deliverables.primary_int_state_dataset?.node_state_csv);
check(checks, "交付清单指向链路状态主输出", existsSync(deliverables.primary_int_state_dataset?.link_state_csv), deliverables.primary_int_state_dataset?.link_state_csv);
check(checks, "INT 过程可视化包存在", existsSync(processVisualizationPath) && processVisualization.schema_version === "stage2-int-process-visualization-v1", processVisualizationPath);
check(checks, "INT 过程包覆盖全部时间片", processVisualization.summary?.slices === manifest.stage1?.counts?.metrics, `${processVisualization.summary?.slices}/${manifest.stage1?.counts?.metrics}`);
check(checks, "probe-int 节点覆盖率 100%", accuracy.primary_probe_int?.metrics?.node_sample_coverage === 1, pct(accuracy.primary_probe_int?.metrics?.node_sample_coverage));
check(checks, "probe-int 链路覆盖率 100%", accuracy.primary_probe_int?.metrics?.link_sample_coverage === 1, pct(accuracy.primary_probe_int?.metrics?.link_sample_coverage));
check(checks, "probe-int 活动链路覆盖率 100%", accuracy.primary_probe_int?.metrics?.active_link_sample_coverage === 1, pct(accuracy.primary_probe_int?.metrics?.active_link_sample_coverage));
check(checks, "probe-int unknown 样本为 0", accuracy.primary_probe_int?.metrics?.unknown_node_samples === 0 && accuracy.primary_probe_int?.metrics?.unknown_link_samples === 0, `${accuracy.primary_probe_int?.metrics?.unknown_node_samples}/${accuracy.primary_probe_int?.metrics?.unknown_link_samples}`);
check(checks, "逐时间片全覆盖审计通过", accuracy.primary_probe_int?.coverage_audit_summary?.pass === true, `${accuracy.primary_probe_int?.coverage_audit_summary?.passed_slices}/${accuracy.primary_probe_int?.coverage_audit_summary?.slices}`);
check(checks, "准确率报告结论通过", accuracy.conclusion?.pass === true, accuracy.conclusion?.statement ?? "");
check(checks, "文件完整性索引覆盖关键产物", fileIndex.file_count >= 27, `file_count=${fileIndex.file_count}`);
check(checks, "前端构建通过", skipBuild || buildPassed === true, skipBuild ? "跳过" : String(buildPassed));

const passed = checks.filter((item) => item.passed).length;
const failed = checks.length - passed;
const report = {
  schema_version: "int-temerity-goal-e2e-verification-v1",
  generated_at: new Date().toISOString(),
  objective:
    "external traffic dataset -> high-fidelity satellite simulation -> INT telemetry -> network-wide state dataset -> accuracy report",
  run_dir: out,
  input_dataset: tasks,
  commands,
  summary: {
    pass: failed === 0,
    checks: checks.length,
    passed,
    failed,
    stage1_score: stage1Verification?.assessment_summary?.score ?? null,
    stage1_config_fingerprint: stage1Verification?.assessment_summary?.config_fingerprint ?? manifest.stage1?.fingerprints?.config,
    dataset_fingerprint: manifest.stage1?.fingerprints?.dataset,
    truth_fingerprint: manifest.stage1?.fingerprints?.truth,
    int_verification_checks: intVerification.summary?.checks,
    probe_node_coverage: accuracy.primary_probe_int?.metrics?.node_sample_coverage,
    probe_link_coverage: accuracy.primary_probe_int?.metrics?.link_sample_coverage,
    probe_full_time_step_pass: accuracy.primary_probe_int?.metrics?.full_time_step_pass,
  },
  artifacts: {
    manifest_json: manifestPath,
    input_validation_json: inputValidationPath,
    deliverables_json: deliverablesPath,
    process_visualization_json: processVisualizationPath,
    accuracy_report_json: accuracyPath,
    int_verification_json: join(out, "int-experiment-verification.json"),
    file_index_json: fileIndexPath,
    node_state_csv: deliverables.primary_int_state_dataset?.node_state_csv,
    link_state_csv: deliverables.primary_int_state_dataset?.link_state_csv,
  },
  checks,
};

const reportJson = join(reportDir, "goal-e2e-verification.json");
const reportMd = join(reportDir, "goal-e2e-verification.md");
await writeFile(reportJson, JSON.stringify(report, null, 2), "utf8");
await writeFile(
  reportMd,
  [
    "# 项目总体验收报告",
    "",
    `- 结论：${report.summary.pass ? "通过" : "未通过"}`,
    `- 检查项：${passed}/${checks.length}`,
    `- 运行目录：${out}`,
    `- 输入数据集：${tasks}`,
    `- probe-int 节点/链路覆盖率：${pct(report.summary.probe_node_coverage)} / ${pct(report.summary.probe_link_coverage)}`,
    `- 逐时间片全覆盖：${String(report.summary.probe_full_time_step_pass)}`,
    "",
    "## 关键产物",
    "",
    `- 输入校验：${inputValidationPath}`,
    `- INT 全网状态交付清单：${deliverablesPath}`,
    `- 准确率报告：${accuracyPath}`,
    `- INT 验收报告：${report.artifacts.int_verification_json}`,
    "",
    "## 检查明细",
    "",
    markdownTable(checks),
    "",
  ].join("\n"),
  "utf8",
);

console.log(JSON.stringify(report, null, 2));
if (!report.summary.pass) process.exit(1);
