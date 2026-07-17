import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCommandTimed,
  runIntMcPostSelection,
} from "./experiments/intMcExperimentCore.mjs";
import { rowsToCsv } from "./experiments/reportUtils.mjs";

const DEFAULT_PILOT_DIR = resolve("reports/experiment12-adaptive-structural-reuse-pilot-6pair");

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : 0;
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function relativeIncrease(candidate, baseline) {
  const base = numberValue(baseline, NaN);
  const value = numberValue(candidate, NaN);
  if (!Number.isFinite(base) || !Number.isFinite(value)) return NaN;
  return (value - base) / Math.max(Math.abs(base), 1e-9);
}

function relativeReduction(candidate, baseline) {
  const base = numberValue(baseline, NaN);
  const value = numberValue(candidate, NaN);
  if (!Number.isFinite(base) || !Number.isFinite(value)) return NaN;
  return (base - value) / Math.max(Math.abs(base), 1e-9);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function executePlan({ label, truthDir, contactDir, plannerDir, outputDir }) {
  const sourceDir = join(outputDir, "plan");
  const telemetryDir = join(outputDir, "telemetry");
  const groundDir = join(outputDir, "ground");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(plannerDir, sourceDir, { recursive: true });
  await cp(
    join(contactDir, "predicted-contact-plan.json"),
    join(sourceDir, "predicted-contact-plan.json"),
  );
  await runCommandTimed({
    label: `${label}: reporting plan`,
    script: "stage2-int/tools/reporting-path-planner.mjs",
    args: [
      "--input", truthDir,
      "--stage2", sourceDir,
      "--out", sourceDir,
      "--algorithm", "int-mc",
      "--probes", join(sourceDir, "probe-paths-int-mc.csv"),
    ],
  });
  return runIntMcPostSelection({
    label,
    truthDir,
    sourceStage2Dir: sourceDir,
    telemetryStage2Dir: telemetryDir,
    groundDir,
    rank: 5,
    windowSize: 12,
    iterations: 30,
  });
}

function compareMetrics(fresh, adaptive, errorTolerance) {
  const errorMetrics = [
    "cpu_mae",
    "queue_depth_mae",
    "energy_percent_mae",
    "link_utilization_mae",
  ];
  const checks = errorMetrics.map((metric) => {
    const increase = relativeIncrease(adaptive[metric], fresh[metric]);
    return {
      metric,
      fresh: numberValue(fresh[metric], NaN),
      adaptive: numberValue(adaptive[metric], NaN),
      relative_increase: round(increase),
      passed: Number.isFinite(increase) && increase <= errorTolerance + 1e-12,
    };
  });
  for (const metric of ["node_mode_accuracy", "link_status_accuracy"]) {
    const freshValue = numberValue(fresh[metric], NaN);
    const adaptiveValue = numberValue(adaptive[metric], NaN);
    const absoluteDrop = freshValue - adaptiveValue;
    checks.push({
      metric,
      fresh: freshValue,
      adaptive: adaptiveValue,
      absolute_drop: round(absoluteDrop),
      passed: Number.isFinite(absoluteDrop) && absoluteDrop <= 0.005 + 1e-12,
    });
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    telemetry_byte_reduction: round(relativeReduction(
      adaptive.total_telemetry_generated_bytes,
      fresh.total_telemetry_generated_bytes,
    )),
    telemetry_energy_reduction: round(relativeReduction(
      adaptive.total_telemetry_energy_j,
      fresh.total_telemetry_energy_j,
    )),
  };
}

function flattenResult(result) {
  const row = {
    pair_id: result.pair_id,
    error_tolerance: result.error_tolerance,
    all_error_gates_passed: result.comparison.passed,
    telemetry_byte_reduction_percent: round(result.comparison.telemetry_byte_reduction * 100),
    telemetry_energy_reduction_percent: round(result.comparison.telemetry_energy_reduction * 100),
  };
  for (const check of result.comparison.checks) {
    row[`${check.metric}_fresh`] = check.fresh;
    row[`${check.metric}_adaptive`] = check.adaptive;
    row[`${check.metric}_change`] = check.relative_increase ?? check.absolute_drop;
    row[`${check.metric}_passed`] = check.passed;
  }
  return row;
}

function buildMarkdown(rows, summary) {
  const body = rows.map((row) =>
    `| ${row.pair_id} | ${(row.cpu_mae_change * 100).toFixed(2)}% | ${(row.queue_depth_mae_change * 100).toFixed(2)}% | ${(row.energy_percent_mae_change * 100).toFixed(2)}% | ${(row.link_utilization_mae_change * 100).toFixed(2)}% | ${(row.node_mode_accuracy_change * 100).toFixed(2)} pp | ${(row.link_status_accuracy_change * 100).toFixed(2)} pp | ${row.telemetry_byte_reduction_percent.toFixed(2)}% | ${row.all_error_gates_passed ? "通过" : "未通过"} |`,
  ).join("\n");
  return `# 实验 12：自适应复用完整重构审计

本审计只重放 Pilot 中实际触发自适应复用的配对窗口。fresh 与 adaptive 使用相同真值快照、补全器和后处理机制，区别仅为 probe plan。复用决策不读取真值；真值只在重构完成后计算误差。

| 配对 | CPU MAE 相对变化 | 队列 MAE 相对变化 | 电量 MAE 相对变化 | 利用率 MAE 相对变化 | 节点模式准确率下降 | 链路状态准确率下降 | 实际遥测字节下降 | 2% 门禁 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${body}

- 审计配对：${summary.audited_pairs}
- 全指标 2% 门禁通过：${summary.passed_pairs}/${summary.audited_pairs}
- 平均 CPU MAE 变化：${summary.mean_cpu_mae_change_percent.toFixed(2)}%
- 平均队列 MAE 变化：${summary.mean_queue_depth_mae_change_percent.toFixed(2)}%
- 平均电量 MAE 变化：${summary.mean_energy_percent_mae_change_percent.toFixed(2)}%
- 平均链路利用率 MAE 变化：${summary.mean_link_utilization_mae_change_percent.toFixed(2)}%
- 平均实际遥测字节下降：${summary.mean_telemetry_byte_reduction_percent.toFixed(2)}%
- 平均实际遥测能耗下降：${summary.mean_telemetry_energy_reduction_percent.toFixed(2)}%

误差变化为负数表示自适应方案误差更低。注意：这是 2 时间片定向完整回放，用来校验机制是否值得进入正式实验；它不是 48 时间片统计结论。
`;
}

async function main() {
  const args = process.argv.slice(2);
  const pilotDir = resolve(argValue(args, "--pilot", DEFAULT_PILOT_DIR));
  const outputDir = resolve(argValue(args, "--out", join(pilotDir, "completion-audit")));
  const errorTolerance = Math.max(0, Math.min(0.1, numberValue(argValue(args, "--error-tolerance", "0.02"), 0.02)));
  const pilot = await readJson(join(pilotDir, "adaptive-structural-reuse-pilot.json"));
  const triggered = pilot.results.filter((result) => result.adaptive.mechanism_triggered);
  const results = [];
  for (const result of triggered) {
    const pairId = result.adaptive.pair_id;
    const snapshot = await readJson(result.adaptive.snapshot_manifest);
    const pairRoot = join(pilotDir, "adaptive", "pairs", pairId, "repetition-01");
    const fresh = await executePlan({
      label: `${pairId} fresh`,
      truthDir: snapshot.truth_dir,
      contactDir: snapshot.contact_dir,
      plannerDir: join(pairRoot, "fresh-only"),
      outputDir: join(outputDir, "pairs", pairId, "fresh"),
    });
    const adaptive = await executePlan({
      label: `${pairId} adaptive`,
      truthDir: snapshot.truth_dir,
      contactDir: snapshot.contact_dir,
      plannerDir: join(pairRoot, "reuse-enabled"),
      outputDir: join(outputDir, "pairs", pairId, "adaptive"),
    });
    results.push({
      pair_id: pairId,
      error_tolerance: errorTolerance,
      fresh: fresh.metrics,
      adaptive: adaptive.metrics,
      comparison: compareMetrics(fresh.metrics, adaptive.metrics, errorTolerance),
    });
  }
  const rows = results.map(flattenResult);
  const summary = {
    audited_pairs: rows.length,
    passed_pairs: rows.filter((row) => row.all_error_gates_passed).length,
    mean_cpu_mae_change_percent: round(mean(rows.map((row) => row.cpu_mae_change)) * 100),
    mean_queue_depth_mae_change_percent: round(mean(rows.map((row) => row.queue_depth_mae_change)) * 100),
    mean_energy_percent_mae_change_percent: round(mean(rows.map((row) => row.energy_percent_mae_change)) * 100),
    mean_link_utilization_mae_change_percent: round(mean(rows.map((row) => row.link_utilization_mae_change)) * 100),
    mean_telemetry_byte_reduction_percent: round(mean(rows.map((row) => row.telemetry_byte_reduction_percent))),
    mean_telemetry_energy_reduction_percent: round(mean(rows.map((row) => row.telemetry_energy_reduction_percent))),
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(join(outputDir, "adaptive-reuse-completion-audit.json"), {
      schema_version: "experiment12-adaptive-reuse-completion-audit-v1",
      generated_at: new Date().toISOString(),
      pilot_dir: pilotDir,
      error_tolerance: errorTolerance,
      truth_boundary: "truth used only for post-reconstruction evaluation",
      summary,
      results,
    }),
    writeFile(join(outputDir, "adaptive-reuse-completion-audit.csv"), rowsToCsv(rows), "utf8"),
    writeFile(join(outputDir, "ADAPTIVE_REUSE_COMPLETION_AUDIT.md"), buildMarkdown(rows, summary), "utf8"),
  ]);
  console.log(JSON.stringify({ status: "complete", output_dir: outputDir, summary }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
