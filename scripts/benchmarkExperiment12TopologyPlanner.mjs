import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommandTimed } from "./experiments/intMcExperimentCore.mjs";
import { rowsToCsv } from "./experiments/reportUtils.mjs";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  return Number(numberValue(value).toFixed(digits));
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requirePath(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  return path;
}

function selectorArgs({
  truthDir,
  candidatePathsPath,
  outputDir,
  predictedContactPlanPath,
  oamLinksPath,
  oamNodesPath,
  feedbackPath,
  controlActionsPath,
  plannerModes,
}) {
  return [
    "--input", truthDir,
    "--stage2", outputDir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", candidatePathsPath,
    "--sampling-rate", "0.25",
    "--target-active-link-sampling-rate", "0.25",
    "--rank", "5",
    "--selection-strategy", "int-mc-leverage",
    "--window-size", "12",
    "--warmup-slices", "6",
    "--max-paths-per-slice", "12",
    "--predicted-contact-plan", predictedContactPlanPath,
    "--observability-mode", "oam-only",
    "--feedback-lag-slices", "1",
    "--adaptive-reuse", "true",
    "--incremental-topology-repair", "true",
    "--forecast-risk-scoring", "true",
    "--topology-versioned-objective", "false",
    "--planner", "topology-versioned-risk-int",
    "--planner-modes", plannerModes,
    "--risk-weight", "0.35",
    "--redundancy-weight", "0.3",
    "--planning-cost-weight", "0.05",
    "--prediction-horizon", "4",
    "--information-gain-mode", "marginal",
    "--metadata-actions", "full,compact,selective",
    "--scale-adaptive-total-budget", "true",
    "--scale-budget-headroom-ratio", "0.1",
    "--scale-budget-path-headroom-ratio", "0.25",
    "--planner-oam-links", oamLinksPath,
    "--planner-oam-nodes", oamNodesPath,
    "--oam-priority-retest", feedbackPath,
    "--oam-control-actions", controlActionsPath,
  ];
}

export async function runPlannerBenchmark({
  experimentDir = resolve("reports/experiment12-topology-reuse-contribution-48slice-stress00"),
  outputDir = join(experimentDir, "planner-benchmark"),
  repetitions = 3,
} = {}) {
  const profileId = "starlink-main-large";
  const stressId = "stress-00";
  const fullRunDir = join(experimentDir, "runs", profileId, stressId, "full-unified");
  const truthDir = requirePath(
    resolve("reports/experiment8-dynamicity-causality/inputs", profileId, stressId),
    "48-slice truth directory",
  );
  const candidatePathsPath = requirePath(
    resolve("reports/experiment2-native-baseline-rerun-final", profileId, "experiment2/stage2/full-probe-int/probe-paths-path-balance.csv"),
    "candidate paths",
  );
  const predictedContactPlanPath = requirePath(
    join(fullRunDir, "stage2/full-unified/predicted-contact-plan.json"),
    "predicted contact plan",
  );
  const pass1GroundDir = requirePath(join(fullRunDir, "ground-oam/int-mc-pass1"), "shared pass-1 Ground OAM");
  const feedbackPath = requirePath(join(fullRunDir, "combined-int-mc-feedback.csv"), "shared deployable feedback");
  const oamLinksPath = requirePath(join(pass1GroundDir, "ground-mc-reconstructed-links.csv"), "pass-1 OAM links");
  const oamNodesPath = requirePath(join(pass1GroundDir, "ground-mc-reconstructed-nodes.csv"), "pass-1 OAM nodes");
  const controlActionsPath = requirePath(join(pass1GroundDir, "ground-oam-control-actions.csv"), "pass-1 OAM controls");
  await mkdir(outputDir, { recursive: true });

  const modes = {
    full: "reuse,repair,fresh",
    fresh: "fresh",
  };
  const rows = [];
  const runCount = Math.max(1, Math.floor(numberValue(repetitions, 3)));
  for (let repetition = 0; repetition < runCount; repetition += 1) {
    const order = repetition % 2 === 0 ? ["full", "fresh"] : ["fresh", "full"];
    for (const mode of order) {
      const runOutputDir = join(outputDir, "work", mode);
      await mkdir(runOutputDir, { recursive: true });
      console.log(`[Planner benchmark] repetition ${repetition + 1}/${runCount}: ${mode}`);
      const run = await runCommandTimed({
        label: `Experiment 12 planner benchmark ${mode} repetition ${repetition + 1}`,
        script: "stage2-int/tools/int-mc-path-selector.mjs",
        args: selectorArgs({
          truthDir,
          candidatePathsPath,
          outputDir: runOutputDir,
          predictedContactPlanPath,
          oamLinksPath,
          oamNodesPath,
          feedbackPath,
          controlActionsPath,
          plannerModes: modes[mode],
        }),
      });
      const report = await readJson(join(runOutputDir, "probe-coverage-int-mc.json"));
      rows.push({
        repetition: repetition + 1,
        execution_order: order.join(" > "),
        mode,
        wall_time_ms: run.timing.wall_time_ms,
        planning_candidate_paths: (report.per_slice ?? []).reduce(
          (sum, row) => sum + numberValue(row.planning_candidate_paths),
          0,
        ),
        marginal_evaluations: numberValue(report.coverage?.unified_planner_marginal_evaluations),
        score_cache_recomputations: numberValue(report.coverage?.unified_planner_score_cache_recomputations),
        repair_slices: numberValue(report.coverage?.unified_repair_slices),
        fresh_slices: numberValue(report.coverage?.unified_fresh_slices),
        hard_budget_violations: numberValue(report.coverage?.unified_hard_budget_violations),
        causal_feedback_violations: numberValue(report.coverage?.causal_feedback_violations),
      });
    }
  }

  const fullRows = rows.filter((row) => row.mode === "full");
  const freshRows = rows.filter((row) => row.mode === "fresh");
  const pairedSavings = Array.from({ length: runCount }, (_, index) => {
    const full = fullRows.find((row) => row.repetition === index + 1);
    const fresh = freshRows.find((row) => row.repetition === index + 1);
    return numberValue(fresh?.wall_time_ms) - numberValue(full?.wall_time_ms);
  });
  const fullMedianMs = median(fullRows.map((row) => row.wall_time_ms));
  const freshMedianMs = median(freshRows.map((row) => row.wall_time_ms));
  const summary = {
    repetitions: runCount,
    order_policy: "alternating-full-fresh",
    full_median_wall_time_ms: round(fullMedianMs, 3),
    fresh_median_wall_time_ms: round(freshMedianMs, 3),
    median_wall_time_saving_ms: round(median(pairedSavings), 3),
    median_wall_time_saving_percent: round(
      median(pairedSavings) / Math.max(freshMedianMs, 1e-9) * 100,
      3,
    ),
    full_marginal_evaluations: fullRows[0]?.marginal_evaluations ?? 0,
    fresh_marginal_evaluations: freshRows[0]?.marginal_evaluations ?? 0,
    marginal_evaluation_reduction_percent: round(
      (numberValue(freshRows[0]?.marginal_evaluations) - numberValue(fullRows[0]?.marginal_evaluations)) /
        Math.max(numberValue(freshRows[0]?.marginal_evaluations), 1e-9) * 100,
      3,
    ),
    full_score_cache_recomputations: fullRows[0]?.score_cache_recomputations ?? 0,
    fresh_score_cache_recomputations: freshRows[0]?.score_cache_recomputations ?? 0,
    score_cache_recomputation_reduction_percent: round(
      (numberValue(freshRows[0]?.score_cache_recomputations) - numberValue(fullRows[0]?.score_cache_recomputations)) /
        Math.max(numberValue(freshRows[0]?.score_cache_recomputations), 1e-9) * 100,
      3,
    ),
    hard_budget_passed: rows.every((row) => row.hard_budget_violations === 0),
    causal_boundary_passed: rows.every((row) => row.causal_feedback_violations === 0),
  };
  const result = {
    schema_version: "experiment12-planner-benchmark-v1",
    generated_at: new Date().toISOString(),
    experiment_dir: experimentDir,
    inputs: {
      truth_dir: truthDir,
      candidate_paths: candidatePathsPath,
      predicted_contact_plan: predictedContactPlanPath,
      shared_pass1_ground_oam: pass1GroundDir,
    },
    summary,
    runs: rows,
  };
  const markdown = `# 实验 12：路径规划重复计时\n\n` +
    `在相同 48 时间片 Starlink 1584 真值、候选路径、预测拓扑和 Ground OAM 下，交替顺序运行 ${runCount} 组路径选择器。\n\n` +
    `- 完整拓扑版本化方案中位墙钟：${summary.full_median_wall_time_ms} ms\n` +
    `- fresh-only 中位墙钟：${summary.fresh_median_wall_time_ms} ms\n` +
    `- 配对中位节省：${summary.median_wall_time_saving_ms} ms（${summary.median_wall_time_saving_percent}%）\n` +
    `- 边际评分减少：${summary.marginal_evaluation_reduction_percent}%\n` +
    `- 缓存重算减少：${summary.score_cache_recomputation_reduction_percent}%\n` +
    `- 硬预算/因果门禁：${summary.hard_budget_passed && summary.causal_boundary_passed ? "通过" : "失败"}\n\n` +
    `单次完整流水线墙钟仍会受到文件缓存、进程调度和输出写入影响；本微基准只隔离路径选择阶段。\n`;
  await Promise.all([
    writeFile(join(outputDir, "planner-benchmark.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "planner-benchmark.csv"), `${rowsToCsv(rows)}\n`, "utf8"),
    writeFile(join(outputDir, "PLANNER_BENCHMARK.md"), markdown, "utf8"),
  ]);
  await rm(join(outputDir, "work"), { recursive: true, force: true });
  console.log(JSON.stringify({ status: "complete", output_dir: outputDir, summary }, null, 2));
  return result;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await runPlannerBenchmark({
    experimentDir: resolve(argValue("--input", "reports/experiment12-topology-reuse-contribution-48slice-stress00")),
    outputDir: resolve(argValue("--out", "reports/experiment12-topology-reuse-contribution-48slice-stress00/planner-benchmark")),
    repetitions: numberValue(argValue("--repetitions", "3"), 3),
  });
}
