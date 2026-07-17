import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  collectIntMcMetrics,
  runTwoPassVariant,
} from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";
import {
  EXPERIMENT12_PROFILE_BUDGETS,
  EXPERIMENT12_PROFILE_IDS,
  auditStrictCausalReplay,
  buildExperiment12Variants,
  validateVariantLadder,
} from "./experiments/topologyVersionedCausalExperiment.mjs";
import {
  scheduleObservableRows,
} from "../stage2-int/tools/int-mc-observability.mjs";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const DEFAULT_SOURCE_ROOT = resolve("reports/experiment2-native-baseline-rerun-final");
const DEFAULT_STRESS_ROOT = resolve("reports/experiment8-dynamicity-causality/inputs");
const DEFAULT_OUTPUT_DIR = resolve("reports/experiment12-topology-versioned-causal");

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function round(value, digits = 6) {
  return Number(numberValue(value).toFixed(digits));
}

function stressId(rate) {
  return `stress-${String(Math.round(numberValue(rate) * 100)).padStart(2, "0")}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function filterRowsBySlice(rows, sliceCount) {
  if (!rows.length || !("slice_index" in rows[0])) return rows;
  return rows.filter((row) => numberValue(row.slice_index, Number.POSITIVE_INFINITY) < sliceCount);
}

async function prepareSmokeFixture({ sourceTruthDir, candidatePathsPath, fixtureDir, sliceCount }) {
  const metadata = await readJson(join(sourceTruthDir, "metadata.json"));
  const sourceSliceCount = numberValue(metadata.slice_count, 48);
  if (sliceCount >= sourceSliceCount) {
    return {
      truthDir: sourceTruthDir,
      candidatePathsPath,
      metadata,
      truncated: false,
    };
  }

  await mkdir(fixtureDir, { recursive: true });
  const entries = await readdir(sourceTruthDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === "metadata.json") continue;
    const sourcePath = join(sourceTruthDir, entry.name);
    const destinationPath = join(fixtureDir, entry.name);
    if (extname(entry.name).toLowerCase() !== ".csv") {
      await copyFile(sourcePath, destinationPath);
      continue;
    }
    const rows = await readCsv(sourcePath);
    await writeFile(destinationPath, rowsToCsv(filterRowsBySlice(rows, sliceCount)), "utf8");
  }

  const fixtureMetadata = {
    ...metadata,
    slice_count: sliceCount,
    truth_fingerprint: `${metadata.truth_fingerprint ?? "truth"}:experiment12-${sliceCount}`,
    experiment12_fixture: {
      source_truth_dir: sourceTruthDir,
      source_slice_count: sourceSliceCount,
      retained_slice_count: sliceCount,
      evaluation_scope: "low-cost-smoke-only",
    },
  };
  await writeJson(join(fixtureDir, "metadata.json"), fixtureMetadata);
  const fixtureCandidatePathsPath = join(fixtureDir, "candidate-paths.csv");
  const candidateRows = await readCsv(candidatePathsPath);
  await writeFile(
    fixtureCandidatePathsPath,
    rowsToCsv(filterRowsBySlice(candidateRows, sliceCount)),
    "utf8",
  );
  return {
    truthDir: fixtureDir,
    candidatePathsPath: fixtureCandidatePathsPath,
    metadata: fixtureMetadata,
    truncated: true,
  };
}

function splitLinkIds(value) {
  return String(value ?? "")
    .split(/\s+>\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function invalidProbePathRatio(probeRows, truthLinkRowsOrActiveSet) {
  const active = truthLinkRowsOrActiveSet instanceof Set
    ? truthLinkRowsOrActiveSet
    : new Set(
        truthLinkRowsOrActiveSet
          .filter((row) => ["true", "1"].includes(String(row.is_active).toLowerCase()))
          .map((row) => `${row.slice_index}|${row.link_id}`),
      );
  let invalid = 0;
  for (const probe of probeRows) {
    const linkIds = splitLinkIds(probe.link_ids || probe.pathLinks);
    if (linkIds.some((linkId) => !active.has(`${probe.slice_index}|${linkId}`))) invalid += 1;
  }
  return probeRows.length ? invalid / probeRows.length : 0;
}

function mechanismTriggerStatus(variant, coverage = {}) {
  const reuseSlices = numberValue(coverage.unified_reuse_slices);
  const repairSlices = numberValue(coverage.unified_repair_slices);
  const freshSlices = numberValue(coverage.unified_fresh_slices);
  const compactActions = numberValue(coverage.unified_compact_actions);
  const selectiveActions = numberValue(coverage.unified_selective_actions);
  const fullActions = numberValue(coverage.unified_full_actions);
  if (variant.id === "full-unified") {
    return {
      triggered: reuseSlices + repairSlices > 0,
      evidence: `复用片=${reuseSlices}，修复片=${repairSlices}，fresh片=${freshSlices}`,
    };
  }
  if (variant.id === "no-topology-version") {
    return {
      triggered: reuseSlices === 0 && repairSlices === 0,
      evidence: `仅允许 fresh，fresh片=${freshSlices}`,
    };
  }
  if (variant.id === "no-risk") {
    return { triggered: true, evidence: "风险权重固定为 0" };
  }
  if (variant.id === "no-marginal-information") {
    return { triggered: true, evidence: "信息模式固定为 coverage-only" };
  }
  return {
    triggered: compactActions === 0 && selectiveActions === 0,
    evidence: `full动作=${fullActions}，compact动作=${compactActions}，selective动作=${selectiveActions}`,
  };
}

async function buildCausalContext({ fixture, sharedPass1, predictedContactPlanPath, feedbackPath, feedbackLagSlices }) {
  const truthLinks = await readCsvStream(join(fixture.truthDir, "links.csv"), {
    columns: ["slice_index", "link_id", "is_active"],
  });
  const activeTruthLinkKeys = new Set(
    truthLinks
      .filter((row) => ["true", "1"].includes(String(row.is_active).toLowerCase()))
      .map((row) => `${row.slice_index}|${row.link_id}`),
  );
  const oamLinks = await readCsvStream(join(sharedPass1.groundDir, "ground-mc-reconstructed-links.csv"), {
    columns: ["slice_index", "link_id"],
  });
  const oamLinkSourceByKey = new Map(
    oamLinks.map((row) => [`${row.slice_index}|${row.link_id}`, numberValue(row.slice_index, NaN)]),
  );
  const predictedEntriesCsv = join(dirname(predictedContactPlanPath), "predicted-contact-plan.csv");
  const predictedEntries = existsSync(predictedEntriesCsv)
    ? await readCsvStream(predictedEntriesCsv, { columns: ["slice_index", "link_id"] })
    : (await readJson(predictedContactPlanPath)).entries ?? [];
  const plannerRows = [];
  for (const entry of predictedEntries) {
    const targetSlice = numberValue(entry.slice_index, NaN);
    const expectedSourceSlice = targetSlice - feedbackLagSlices;
    const sourceSlice = oamLinkSourceByKey.get(`${expectedSourceSlice}|${entry.link_id}`);
    if (Number.isFinite(sourceSlice) && sourceSlice >= targetSlice) {
      plannerRows.push({
        slice_index: targetSlice,
        planner_state_source_slice_index: sourceSlice,
      });
    }
  }

  const truthNodes = await readCsvStream(join(fixture.truthDir, "nodes.csv"), {
    columns: ["slice_index", "node_id"],
  });
  const oamNodes = await readCsvStream(join(sharedPass1.groundDir, "ground-mc-reconstructed-nodes.csv"), {
    columns: ["slice_index", "node_id"],
  });
  const oamNodeSourceByKey = new Map(
    oamNodes.map((row) => [`${row.slice_index}|${row.node_id}`, numberValue(row.slice_index, NaN)]),
  );
  for (const node of truthNodes) {
    const targetSlice = numberValue(node.slice_index, NaN);
    const expectedSourceSlice = targetSlice - feedbackLagSlices;
    const sourceSlice = oamNodeSourceByKey.get(`${expectedSourceSlice}|${node.node_id}`);
    if (Number.isFinite(sourceSlice) && sourceSlice >= targetSlice) {
      plannerRows.push({
        slice_index: targetSlice,
        planner_state_source_slice_index: sourceSlice,
      });
    }
  }

  const rawFeedbackRows = await readCsvStream(feedbackPath, {
    columns: [
      "slice_index", "source_slice_index", "control_source_slice_index",
      "next_slice_index", "target_slice_index", "feedback_basis", "reason",
    ],
  });
  return {
    activeTruthLinkKeys,
    scheduledFeedbackRows: scheduleObservableRows(rawFeedbackRows, { lagSlices: feedbackLagSlices }),
    // auditStrictCausalReplay only consumes violating source/target pairs. Valid
    // rows are counted by the selector's independent causal violation counter.
    plannerRows,
  };
}

const DELTA_FIELDS = Object.freeze([
  "planning_wall_time_ms",
  "planning_candidate_paths",
  "unified_planner_marginal_evaluations",
  "unified_planner_score_cache_recomputations",
  "telemetry_bytes_per_node_slice",
  "total_telemetry_energy_j",
  "invalid_probe_path_ratio",
  "active_link_direct_coverage",
  "node_completion_coverage",
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "link_utilization_mae",
  "node_mode_accuracy",
  "link_status_accuracy",
]);

function buildMechanismDeltas(summaryRows, variants) {
  const rows = [];
  const groups = [...new Set(summaryRows.map((row) => `${row.profile_id}|${row.stress_rate}`))];
  for (const group of groups) {
    const [profileId, stressRate] = group.split("|");
    const profileRows = summaryRows.filter((row) => `${row.profile_id}|${row.stress_rate}` === group);
    const full = profileRows.find((row) => row.variant_id === variants[0].id);
    for (let index = 1; index < variants.length; index += 1) {
      const current = profileRows.find((row) => row.variant_id === variants[index].id);
      if (!full || !current) continue;
      const row = {
        profile_id: profileId,
        profile_label: current.profile_label,
        stress_rate: numberValue(stressRate),
        from_variant_id: full.variant_id,
        to_variant_id: current.variant_id,
        isolated_contribution: variants[index].contribution,
        comparison_policy: "ablation-minus-full-unified",
      };
      for (const field of DELTA_FIELDS) {
        row[`${field}_delta`] = round(numberValue(current[field]) - numberValue(full[field]));
      }
      row.reused_slice_plans_delta = round(numberValue(current.reused_slice_plans) - numberValue(full.reused_slice_plans));
      row.fresh_slice_plans_delta = round(numberValue(current.fresh_slice_plans) - numberValue(full.fresh_slice_plans));
      row.planning_local_repair_slices_delta = round(
        numberValue(current.planning_local_repair_slices) - numberValue(full.planning_local_repair_slices),
      );
      rows.push(row);
    }
  }
  return rows;
}

function auditEqualBudget(summaryRows, { expectedVariantCount = buildExperiment12Variants().length } = {}) {
  const groups = [...new Set(summaryRows.map((row) => `${row.profile_id}|${row.stress_rate}`))];
  return groups.map((group) => {
    const [profileId, stressRate] = group.split("|");
    const rows = summaryRows.filter((row) => `${row.profile_id}|${row.stress_rate}` === group);
    const actual = rows.map((row) => numberValue(row.telemetry_bytes_per_node_slice));
    const configured = rows.map((row) => numberValue(row.telemetry_budget_bytes_per_node_slice));
    const actualSpread = Math.max(...actual) - Math.min(...actual);
    const configuredSpread = Math.max(...configured) - Math.min(...configured);
    const capViolations = rows.reduce((total, row) => total + numberValue(row.telemetry_byte_budget_cap_violations), 0);
    return {
      profile_id: profileId,
      stress_rate: numberValue(stressRate),
      variant_count: rows.length,
      configured_budget_spread: round(configuredSpread),
      actual_byte_spread: round(actualSpread),
      cap_violations: capViolations,
      max_actual_to_cap_ratio: round(Math.max(...rows.map((row) =>
        numberValue(row.telemetry_bytes_per_node_slice) /
          Math.max(numberValue(row.telemetry_budget_bytes_per_node_slice), 1e-9)
      ))),
      passed: rows.length === expectedVariantCount && configuredSpread <= 1e-9 && capViolations === 0 &&
        rows.every((row) => numberValue(row.telemetry_bytes_per_node_slice) <=
          numberValue(row.telemetry_budget_bytes_per_node_slice) + 1e-6),
    };
  });
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `|${columns.map(() => "---").join("|")}|`;
  const body = rows.map((row) => `| ${columns.map((column) => column.render ? column.render(row) : row[column.key]).join(" | ")} |`).join("\n");
  return `${header}\n${divider}\n${body}`;
}

function groupedBarChart(rows, metric, title, { lowerBetter = true, digits = 3 } = {}) {
  const values = rows.map((row) => numberValue(row[metric]));
  const maximum = Math.max(...values, 1e-9);
  const bars = rows.map((row) => {
    const width = Math.max(1, numberValue(row[metric]) / maximum * 100);
    return `<div class="bar-row"><span>${escapeHtml(row.profile_label)} / ${escapeHtml(row.variant_label)} / ${escapeHtml(row.stress_rate)}</span><div class="track"><i style="width:${width}%"></i></div><strong>${numberValue(row[metric]).toFixed(digits)}</strong></div>`;
  }).join("");
  return `<section class="chart"><h3>${escapeHtml(title)}</h3><p>${lowerBetter ? "越低越好" : "越高越好"}</p>${bars}</section>`;
}

function buildConclusions(summaryRows, variants) {
  const groups = [...new Set(summaryRows.map((row) => `${row.profile_id}|${row.stress_rate}`))];
  return groups.map((group) => {
    const full = summaryRows.find((row) => `${row.profile_id}|${row.stress_rate}` === group && row.variant_id === variants[0].id);
    const noTopology = summaryRows.find((row) => `${row.profile_id}|${row.stress_rate}` === group && row.variant_id === "no-topology-version");
    const noRisk = summaryRows.find((row) => `${row.profile_id}|${row.stress_rate}` === group && row.variant_id === "no-risk");
    const noMarginal = summaryRows.find((row) => `${row.profile_id}|${row.stress_rate}` === group && row.variant_id === "no-marginal-information");
    const fixedMetadata = summaryRows.find((row) => `${row.profile_id}|${row.stress_rate}` === group && row.variant_id === "fixed-metadata");
    if (!full) return "";
    const fragments = [];
    if (noTopology) {
      const topologyActionSlices = numberValue(full.unified_reuse_slices) + numberValue(full.unified_repair_slices);
      const planningSaving = round(numberValue(noTopology.planning_wall_time_ms) - numberValue(full.planning_wall_time_ms), 3);
      const planningSavingRatio = round(
        planningSaving / Math.max(numberValue(noTopology.planning_wall_time_ms), 1e-9) * 100,
        3,
      );
      if (topologyActionSlices === 0) {
        fragments.push("拓扑版本化未触发，本轮不能据此评价复用贡献");
      } else {
        const reduction = (field) => round(
          (numberValue(noTopology[field]) - numberValue(full[field])) /
            Math.max(numberValue(noTopology[field]), 1e-9) * 100,
          3,
        );
        const maeFields = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
        const maximumMaeRegression = round(Math.max(0, ...maeFields.map((field) =>
          (numberValue(full[field]) - numberValue(noTopology[field])) /
            Math.max(numberValue(noTopology[field]), 1e-9) * 100
        )), 3);
        const wallTimeConclusion = planningSaving >= 0
          ? `单次规划墙钟减少 ${planningSavingRatio}%`
          : `单次规划墙钟增加 ${Math.abs(planningSavingRatio)}%，需以重复计时判断`;
        const telemetryByteReduction = reduction("telemetry_bytes_per_node_slice");
        const telemetryByteConclusion = telemetryByteReduction >= 0
          ? `实际遥测字节减少 ${telemetryByteReduction}%`
          : `实际遥测字节增加 ${Math.abs(telemetryByteReduction)}%（相近开销）`;
        fragments.push(
          `拓扑版本化触发 ${topologyActionSlices} 片，规划候选减少 ${reduction("planning_candidate_paths")}%、` +
          `边际评分减少 ${reduction("unified_planner_marginal_evaluations")}%、` +
          `缓存重算减少 ${reduction("unified_planner_score_cache_recomputations")}%、` +
          `${telemetryByteConclusion}、` +
          `最大 MAE 相对退化 ${maximumMaeRegression}%，${wallTimeConclusion}`,
        );
      }
    }
    if (noRisk) {
      const riskMaeGain = round(numberValue(noRisk.link_utilization_mae) - numberValue(full.link_utilization_mae), 6);
      fragments.push(`风险项对应的链路利用率 MAE 改善为 ${riskMaeGain}`);
    }
    if (noMarginal) {
      const marginalCoverageGain = round(
        numberValue(full.active_link_direct_coverage) - numberValue(noMarginal.active_link_direct_coverage),
        6,
      );
      fragments.push(`边际信息项对应的活动链路直接覆盖变化为 ${marginalCoverageGain}`);
    }
    if (fixedMetadata) {
      const metadataByteSaving = round(numberValue(fixedMetadata.telemetry_bytes_per_node_slice) - numberValue(full.telemetry_bytes_per_node_slice), 6);
      fragments.push(`可变 metadata 相对固定 full 节省 ${metadataByteSaving} B/节点/片`);
    }
    return `${full.profile_label}（动态压力 ${full.stress_rate}）：${fragments.join("；")}。`;
  }).filter(Boolean);
}

function buildMarkdown({ summaryRows, deltaRows, causalRows, fairnessRows, variants, parameters, formal }) {
  const conclusions = buildConclusions(summaryRows, variants);
  const summaryColumns = [
    { key: "profile_label", label: "星座" },
    { key: "stress_rate", label: "动态压力" },
    { key: "variant_label", label: "机制档位" },
    { key: "telemetry_bytes_per_node_slice", label: "B/节点/片" },
    { key: "planning_wall_time_ms", label: "规划 ms" },
    { key: "planning_candidate_paths", label: "规划候选" },
    { key: "unified_planner_marginal_evaluations", label: "边际评分次数" },
    { key: "unified_planner_score_cache_recomputations", label: "缓存重算次数" },
    { key: "invalid_probe_path_ratio", label: "无效路径率" },
    { key: "active_link_direct_coverage", label: "活动链路直接覆盖" },
    { key: "cpu_mae", label: "CPU MAE" },
    { key: "queue_depth_mae", label: "队列 MAE" },
    { key: "energy_percent_mae", label: "电量 MAE" },
    { key: "link_utilization_mae", label: "链路利用率 MAE" },
  ];
  return `# 实验 12：拓扑版本化严格因果等预算实验\n\n` +
    `## 结论边界\n\n` +
    `本实验只面向**中大型动态 LEO**星座，在**相同遥测字节预算**下对本轮选中的核心机制进行单因素检验。研究目标是找到有数据支持的等预算优势，**不追求全指标全面胜出**。\n\n` +
    `当前结果属于${formal ? "正式运行" : "低成本冒烟运行"}，共 ${parameters.slice_count} 个时间片，动态压力为 ${parameters.stress_rates.join(", ")}。${formal ? "可进入统计汇总。" : "只能证明流水线、公平性和机制方向可运行，不能替代多种子统计证据。"}\n\n` +
    `## 方法\n\n` +
    `实验以 \`full-unified\` 为完整算法，本轮选取的消融档每次只删除一个核心量：${variants.slice(1).map((variant) => `\`${variant.id}\``).join("、")}。所有档位共享同一 pass-1 Ground OAM、同一补全器与同一硬字节预算；差值统一按“消融档减完整算法”计算。\n\n` +
    `## 机制触发审计\n\n${markdownTable(summaryRows, [
      { key: "profile_label", label: "星座" },
      { key: "stress_rate", label: "动态压力" },
      { key: "variant_label", label: "机制档位" },
      { key: "mechanism_triggered", label: "本档新增机制已触发" },
      { key: "mechanism_trigger_evidence", label: "证据" },
    ])}\n\n未触发的机制不能用本轮零差值证明有效或无效；需要延长到能够出现轨道周期复现的时间窗口，并覆盖较低与较高动态压力。\n\n` +
    `## 严格时间因果\n\n` +
    `规划器只使用过去 OAM 与可预测轨道，要求每条反馈和规划状态满足 \(t_{source}<t_{target}\)。真值只在运行结束后计算误差。本轮 ${causalRows.filter((row) => row.passed === true).length}/${causalRows.length} 项因果检查通过。\n\n` +
    `## 综合结果\n\n${markdownTable(summaryRows, summaryColumns)}\n\n` +
    `## 公平性审计\n\n${markdownTable(fairnessRows, [
      { key: "profile_id", label: "星座" },
      { key: "stress_rate", label: "动态压力" },
      { key: "configured_budget_spread", label: "配置预算差" },
      { key: "actual_byte_spread", label: "实际字节差" },
      { key: "cap_violations", label: "超预算次数" },
      { key: "passed", label: "通过" },
    ])}\n\n` +
    `## 本轮可观察结论\n\n${conclusions.map((line) => `- ${line}`).join("\n")}\n\n` +
    `这些数值只描述本轮运行，不把${formal ? "单次正式运行" : "单次冒烟运行"}的差异写成普遍统计结论。机制边际数据见 \`experiment12-mechanism-deltas.csv\`，规划重复计时见 \`planner-benchmark/PLANNER_BENCHMARK.md\`。\n`;
}

function buildHtml({ summaryRows, causalRows, fairnessRows, variants, parameters, formal }) {
  const conclusions = buildConclusions(summaryRows, variants);
  const tableRows = summaryRows.map((row) => `<tr><td>${escapeHtml(row.profile_label)}</td><td>${row.stress_rate}</td><td>${escapeHtml(row.variant_label)}</td><td>${row.telemetry_bytes_per_node_slice}</td><td>${row.planning_wall_time_ms}</td><td>${row.planning_candidate_paths}</td><td>${row.unified_planner_marginal_evaluations}</td><td>${row.unified_planner_score_cache_recomputations}</td><td>${row.invalid_probe_path_ratio}</td><td>${row.active_link_direct_coverage}</td><td>${row.cpu_mae}</td><td>${row.queue_depth_mae}</td><td>${row.energy_percent_mae}</td><td>${row.link_utilization_mae}</td></tr>`).join("");
  const fairnessTable = fairnessRows.map((row) => `<tr><td>${escapeHtml(row.profile_id)}</td><td>${row.stress_rate}</td><td>${row.configured_budget_spread}</td><td>${row.actual_byte_spread}</td><td>${row.cap_violations}</td><td>${row.passed ? "通过" : "失败"}</td></tr>`).join("");
  const triggerTable = summaryRows.map((row) => `<tr><td>${escapeHtml(row.profile_label)}</td><td>${row.stress_rate}</td><td>${escapeHtml(row.variant_label)}</td><td>${row.mechanism_triggered ? "已触发" : "未触发"}</td><td>${escapeHtml(row.mechanism_trigger_evidence)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验 12：拓扑版本化严格因果等预算实验</title><style>
  :root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#172033;background:#f4f6f8}body{margin:0}main{max-width:1320px;margin:auto;padding:28px}header{background:#fff;border-left:5px solid #0f766e;padding:24px;margin-bottom:18px}h1{margin:0 0 10px;font-size:28px}h2{margin-top:30px}section{background:#fff;padding:20px;margin:14px 0;border:1px solid #d9e0e7;border-radius:6px}.notice{background:#ecfdf5;border-color:#6ee7b7}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}.chart{margin:0}.chart p{color:#64748b;font-size:13px}.bar-row{display:grid;grid-template-columns:minmax(170px,1.5fr) 2fr 80px;gap:10px;align-items:center;margin:9px 0;font-size:12px}.track{height:10px;background:#e2e8f0}.track i{display:block;height:100%;background:#0f766e}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}.scroll{overflow:auto}code{background:#eef2f7;padding:2px 5px}li{margin:7px 0}@media(max-width:700px){main{padding:12px}.bar-row{grid-template-columns:1fr}.charts{grid-template-columns:1fr}}
  </style></head><body><main><header><h1>实验 12：拓扑版本化严格因果等预算实验</h1><p>面向中大型动态 LEO 星座的机制级消融与在线因果回放</p></header>
  <section class="notice"><h2>结论边界</h2><p>本实验只在<strong>中大型动态 LEO</strong>星座中研究等预算优势。全部方案使用<strong>相同遥测字节预算</strong>，对本轮选中的核心机制进行单因素检验，<strong>不追求全指标全面胜出</strong>。</p><p>当前为${formal ? "正式运行" : "低成本冒烟运行"}：${parameters.slice_count} 个时间片，动态压力 ${parameters.stress_rates.join(", ")}。</p></section>
  <section><h2>单因素消融</h2><p><code>full-unified</code> 是完整算法，其余方案每次只删除一个核心量，所有方案共享 Ground OAM、补全器和硬字节预算。</p><ol>${variants.map((variant) => `<li><code>${escapeHtml(variant.id)}</code>：${escapeHtml(variant.label)}；${escapeHtml(variant.contribution)}</li>`).join("")}</ol></section>
  <section><h2>机制触发审计</h2><p>未触发机制的零差值不能解释为有效或无效。</p><table><thead><tr><th>星座</th><th>动态压力</th><th>机制档位</th><th>状态</th><th>证据</th></tr></thead><tbody>${triggerTable}</tbody></table></section>
  <section><h2>严格时间因果</h2><p>所有路径规划只使用过去 Ground OAM 与可预测轨道，逐行满足 <code>source_slice &lt; target_slice</code>。真值只用于事后评价。因果检查通过 ${causalRows.filter((row) => row.passed === true).length}/${causalRows.length} 项。</p></section>
  <div class="charts">${groupedBarChart(summaryRows, "planning_wall_time_ms", "路径规划墙钟时间（ms）")}${groupedBarChart(summaryRows, "unified_planner_marginal_evaluations", "边际评分次数")}${groupedBarChart(summaryRows, "invalid_probe_path_ratio", "无效 probe 路径比例")}${groupedBarChart(summaryRows, "active_link_direct_coverage", "活动链路直接覆盖率", { lowerBetter: false })}${groupedBarChart(summaryRows, "link_utilization_mae", "链路利用率 MAE")}</div>
  <section class="scroll"><h2>综合结果</h2><table><thead><tr><th>星座</th><th>动态压力</th><th>机制档位</th><th>B/节点/片</th><th>规划 ms</th><th>规划候选</th><th>边际评分次数</th><th>缓存重算次数</th><th>无效路径率</th><th>活动链路覆盖</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th></tr></thead><tbody>${tableRows}</tbody></table></section>
  <section><h2>公平性审计</h2><table><thead><tr><th>星座</th><th>动态压力</th><th>配置预算差</th><th>实际字节差</th><th>超预算次数</th><th>结论</th></tr></thead><tbody>${fairnessTable}</tbody></table></section>
  <section><h2>本轮可观察结论</h2><ul>${conclusions.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>${formal ? "正式统计仍应结合多随机种子置信区间。" : "冒烟结果仅验证实现、公平性和方向，不能替代多随机种子正式统计。"} 规划重复计时见 <code>planner-benchmark/PLANNER_BENCHMARK.md</code>。</p></section>
  </main></body></html>`;
}

export async function runExperiment12({
  profileIds = EXPERIMENT12_PROFILE_IDS,
  variantIds = null,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  stressRoot = DEFAULT_STRESS_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
  stressRates = [0, 0.1, 0.25],
  sliceCount = 48,
  formal = true,
  resume = true,
  neutralPass1Planner = "legacy",
} = {}) {
  const allVariants = buildExperiment12Variants();
  const ladderAudit = validateVariantLadder(allVariants);
  if (!ladderAudit.valid) throw new Error(`Invalid Experiment 12 variant ladder: ${ladderAudit.errors.join("; ")}`);
  const requestedVariantIds = Array.isArray(variantIds) && variantIds.length > 0
    ? [...new Set(variantIds.map(String))]
    : allVariants.map((variant) => variant.id);
  const unknownVariantIds = requestedVariantIds.filter(
    (variantId) => !allVariants.some((variant) => variant.id === variantId),
  );
  if (unknownVariantIds.length > 0) {
    throw new Error(`Unknown Experiment 12 variants: ${unknownVariantIds.join(",")}`);
  }
  if (!requestedVariantIds.includes("full-unified")) {
    throw new Error("Experiment 12 variant selection must include full-unified as the comparison reference");
  }
  const variants = allVariants.filter((variant) => requestedVariantIds.includes(variant.id));
  const profiles = profileIds.map((id) => PROFILE_CATALOG.find((profile) => profile.id === id));
  if (profiles.some((profile) => !profile)) throw new Error(`Unknown profile in ${profileIds.join(",")}`);
  if (profiles.some((profile) => !EXPERIMENT12_PROFILE_IDS.includes(profile.id))) {
    throw new Error("Experiment 12 core claim is restricted to medium and large constellations");
  }
  await mkdir(outputDir, { recursive: true });
  const summaryRows = [];
  const causalAuditRows = [];
  const runManifests = [];
  const feedbackLagSlices = 1;
  const neutralPass1Mechanisms = neutralPass1Planner === "efficient-fresh"
    ? {
        planner: "topology-versioned-risk-int",
        plannerModes: "fresh",
        riskWeight: 0.35,
        redundancyWeight: 0.3,
        planningCostWeight: 0.05,
        predictionHorizon: 4,
        informationGainMode: "marginal",
        metadataActions: "full,compact,selective",
        adaptiveReuse: false,
        topologyVersionedObjective: false,
        incrementalTopologyRepair: false,
        forecastRiskScoring: true,
      }
    : null;
  if (!["legacy", "efficient-fresh"].includes(neutralPass1Planner)) {
    throw new Error(`Unknown neutral pass-1 planner: ${neutralPass1Planner}`);
  }

  for (const profile of profiles) {
    const candidatePathsPath = join(
      sourceRoot,
      profile.id,
      "experiment2",
      "stage2",
      "full-probe-int",
      "probe-paths-path-balance.csv",
    );
    if (!existsSync(candidatePathsPath)) throw new Error(`Missing candidate paths: ${candidatePathsPath}`);
    for (const stressRate of stressRates) {
      const currentStressId = stressId(stressRate);
      const sourceTruthDir = join(stressRoot, profile.id, currentStressId);
      if (!existsSync(join(sourceTruthDir, "metadata.json"))) throw new Error(`Missing stress truth: ${sourceTruthDir}`);
    const fixture = await prepareSmokeFixture({
      sourceTruthDir,
      candidatePathsPath,
      fixtureDir: join(outputDir, "fixtures", profile.id, currentStressId),
      sliceCount,
    });
    const runParameters = {
      samplingRate: 0.25,
      targetActiveLinkSamplingRate: 0.25,
      rank: 5,
      windowSize: Math.min(12, Math.max(2, sliceCount)),
      warmupSlices: Math.min(6, Math.max(1, sliceCount - 1)),
      iterations: formal ? 12 : 4,
      maxPathsPerSlice: formal ? 12 : 6,
      feedbackLagSlices,
      observabilityMode: "oam-only",
      downlinkBudgetBytes: 1_000_000_000,
      telemetryByteBudgetPerNodeSlice: EXPERIMENT12_PROFILE_BUDGETS[profile.id],
      telemetryByteBudgetPadToCap: false,
      writeEstimateGraph: false,
    };
    let sharedPass1 = null;
    let causalContext = null;

    for (const variant of variants) {
      console.log(`[Experiment 12] ${profile.short_label} ${currentStressId}: ${variant.label}`);
      const variantDir = join(outputDir, "runs", profile.id, currentStressId, variant.id);
      const run = await runTwoPassVariant({
        profile,
        variant,
        truthDir: fixture.truthDir,
        candidatePathsPath: fixture.candidatePathsPath,
        outputDir: variantDir,
        parameters: runParameters,
        resume,
        sharedPass1,
        neutralPass1Mechanisms,
      });
      if (!sharedPass1) {
        sharedPass1 = {
          run: run.before,
          stage2Dir: run.manifest.pass1_stage2_dir,
          groundDir: run.manifest.pass1_ground_dir,
          fingerprint: run.manifest.pass1_fingerprint,
        };
      }
      const stage2Dir = dirname(run.after.artifacts.probe_paths_csv);
      const groundDir = dirname(run.after.artifacts.evaluation_json);
      const [metrics, selectorReport, probeRows] = await Promise.all([
        collectIntMcMetrics({ truthDir: fixture.truthDir, stage2Dir, groundDir }),
        readJson(run.after.artifacts.selector_report_json),
        readCsv(run.after.artifacts.probe_paths_csv),
      ]);
      if (!causalContext) {
        causalContext = await buildCausalContext({
          fixture,
          sharedPass1,
          predictedContactPlanPath: run.after.artifacts.predicted_contact_plan_json,
          feedbackPath: run.manifest.combined_feedback_csv,
          feedbackLagSlices,
        });
      }
      const causalAudit = auditStrictCausalReplay({
        manifest: run.manifest,
        selectorReport,
        feedbackRows: causalContext.scheduledFeedbackRows,
        plannerRows: causalContext.plannerRows,
      });
      const mechanismTrigger = mechanismTriggerStatus(variant, selectorReport.coverage);
      for (const check of causalAudit.checks) {
        causalAuditRows.push({
          profile_id: profile.id,
          stress_rate: stressRate,
          variant_id: variant.id,
          check_id: check.id,
          passed: check.passed,
          observed: check.observed,
          expected: check.expected,
        });
      }
      const summary = {
        profile_id: profile.id,
        profile_label: profile.short_label,
        scale: profile.scale,
        node_count: profile.node_count,
        variant_id: variant.id,
        variant_label: variant.label,
        isolated_contribution: variant.contribution,
        mechanism_triggered: mechanismTrigger.triggered,
        mechanism_trigger_evidence: mechanismTrigger.evidence,
        slice_count: metrics.slice_count,
        stress_rate: stressRate,
        telemetry_budget_bytes_per_node_slice: EXPERIMENT12_PROFILE_BUDGETS[profile.id],
        telemetry_bytes_per_node_slice: metrics.telemetry_bytes_per_node_slice,
        telemetry_padding_bytes_per_node_slice: metrics.telemetry_padding_bytes_per_node_slice,
        telemetry_byte_budget_cap_violations: metrics.telemetry_byte_budget_cap_violations,
        total_telemetry_energy_j: metrics.total_telemetry_energy_j,
        total_report_bytes: metrics.total_report_bytes,
        planning_wall_time_ms: round(run.after.timings?.path_selection?.wall_time_ms),
        reconstruction_wall_time_ms: round(run.after.timings?.matrix_completion?.wall_time_ms),
        selected_paths: metrics.selected_paths,
        reused_slice_plans: metrics.reused_slice_plans,
        fresh_slice_plans: metrics.fresh_slice_plans,
        estimated_full_replanning_avoided: metrics.estimated_full_replanning_avoided,
        planning_local_repair_slices: metrics.planning_local_repair_slices,
        unified_reuse_slices: numberValue(selectorReport.coverage?.unified_reuse_slices),
        unified_repair_slices: numberValue(selectorReport.coverage?.unified_repair_slices),
        unified_fresh_slices: numberValue(selectorReport.coverage?.unified_fresh_slices),
        unified_full_actions: numberValue(selectorReport.coverage?.unified_full_actions),
        unified_compact_actions: numberValue(selectorReport.coverage?.unified_compact_actions),
        unified_selective_actions: numberValue(selectorReport.coverage?.unified_selective_actions),
        unified_forward_only_hops: numberValue(selectorReport.coverage?.unified_forward_only_hops),
        unified_hard_budget_violations: numberValue(selectorReport.coverage?.unified_hard_budget_violations),
        unified_mode_prefilter_reuse_slices: numberValue(selectorReport.coverage?.unified_mode_prefilter_reuse_slices),
        unified_mode_prefilter_repair_slices: numberValue(selectorReport.coverage?.unified_mode_prefilter_repair_slices),
        unified_mode_prefilter_fresh_slices: numberValue(selectorReport.coverage?.unified_mode_prefilter_fresh_slices),
        unified_mode_prefilter_ambiguous_slices: numberValue(selectorReport.coverage?.unified_mode_prefilter_ambiguous_slices),
        unified_planner_marginal_evaluations: numberValue(selectorReport.coverage?.unified_planner_marginal_evaluations),
        unified_planner_score_cache_hits: numberValue(selectorReport.coverage?.unified_planner_score_cache_hits),
        unified_planner_score_cache_recomputations: numberValue(selectorReport.coverage?.unified_planner_score_cache_recomputations),
        unified_stable_path_cache_hits: numberValue(selectorReport.coverage?.unified_stable_path_cache_hits),
        unified_stable_path_cache_misses: numberValue(selectorReport.coverage?.unified_stable_path_cache_misses),
        planning_candidate_paths: (selectorReport.per_slice ?? []).reduce(
          (sum, row) => sum + numberValue(row.planning_candidate_paths),
          0,
        ),
        unified_information_gain: numberValue(selectorReport.coverage?.mean_unified_information_gain),
        unified_risk_gain: numberValue(selectorReport.coverage?.mean_unified_risk_gain),
        invalid_probe_path_ratio: round(invalidProbePathRatio(probeRows, causalContext.activeTruthLinkKeys)),
        active_link_direct_coverage: metrics.active_link_direct_coverage,
        active_link_effective_coverage: metrics.active_link_effective_coverage,
        node_completion_coverage: metrics.node_completion_coverage,
        cpu_mae: metrics.cpu_mae,
        queue_depth_mae: metrics.queue_depth_mae,
        energy_percent_mae: metrics.energy_percent_mae,
        link_utilization_mae: metrics.link_utilization_mae,
        node_mode_accuracy: metrics.node_mode_accuracy,
        link_status_accuracy: metrics.link_status_accuracy,
        strict_causal_passed: causalAudit.passed,
        causal_violation_count: causalAudit.violation_count,
        truth_metrics_used_only_for_evaluation: metrics.truth_metrics_used_only_for_evaluation,
      };
      summaryRows.push(summary);
      runManifests.push({ profile_id: profile.id, stress_rate: stressRate, variant_id: variant.id, manifest_path: join(variantDir, "run-manifest.json") });
      if (!causalAudit.passed) throw new Error(`Strict causal audit failed for ${profile.id}/${variant.id}`);
      global.gc?.();
    }
    }
  }

  const fairnessRows = auditEqualBudget(summaryRows, { expectedVariantCount: variants.length });
  if (fairnessRows.some((row) => !row.passed)) {
    throw new Error(`Equal-budget audit failed: ${JSON.stringify(fairnessRows)}`);
  }
  const deltaRows = buildMechanismDeltas(summaryRows, variants);
  const parameters = {
    profile_ids: profileIds,
    variant_ids: variants.map((variant) => variant.id),
    stress_rates: stressRates,
    slice_count: sliceCount,
    formal,
    feedback_lag_slices: feedbackLagSlices,
    telemetry_byte_budget_pad_to_cap: false,
    neutral_pass1_planner: neutralPass1Planner,
  };
  const results = {
    schema_version: "experiment12-topology-causal-v2",
    generated_at: new Date().toISOString(),
    status: "complete",
    scope: {
      claim: "medium-large-equal-budget-only",
      universal_all_metric_superiority_claimed: false,
      truth_role: "post-run-evaluation-only",
      smoke_results_are_formal_evidence: formal,
    },
    parameters,
    variant_ladder: variants,
    fairness_audit: fairnessRows,
    summary_rows: summaryRows,
    mechanism_delta_rows: deltaRows,
    causal_audit_rows: causalAuditRows,
    run_manifests: runManifests,
  };
  const markdown = buildMarkdown({ summaryRows, deltaRows, causalRows: causalAuditRows, fairnessRows, variants, parameters, formal });
  const html = buildHtml({ summaryRows, causalRows: causalAuditRows, fairnessRows, variants, parameters, formal });
  await Promise.all([
    writeJson(join(outputDir, "experiment12-results.json"), results),
    writeFile(join(outputDir, "experiment12-summary.csv"), rowsToCsv(summaryRows), "utf8"),
    writeFile(join(outputDir, "experiment12-mechanism-deltas.csv"), rowsToCsv(deltaRows), "utf8"),
    writeFile(join(outputDir, "experiment12-causal-audit.csv"), rowsToCsv(causalAuditRows), "utf8"),
    writeFile(join(outputDir, "EXPERIMENT_12_REPORT.md"), markdown, "utf8"),
    writeFile(join(outputDir, "index.html"), html, "utf8"),
  ]);
  console.log(JSON.stringify({
    status: "complete",
    output_dir: outputDir,
    profiles: profileIds,
    variants: variants.map((variant) => variant.id),
    fairness_passed: fairnessRows.every((row) => row.passed),
    causal_passed: causalAuditRows.every((row) => row.passed === true),
  }, null, 2));
  return results;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const profileIds = argValue(args, "--profiles", EXPERIMENT12_PROFILE_IDS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const legacyStressRate = argValue(args, "--stress-rate", "");
  const stressRates = (legacyStressRate || argValue(args, "--stress-rates", "0,0.1,0.25"))
    .split(",")
    .map((value) => numberValue(value, NaN))
    .filter(Number.isFinite);
  const variantIds = argValue(args, "--variants", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  await runExperiment12({
    profileIds,
    variantIds,
    sourceRoot: resolve(argValue(args, "--source-root", DEFAULT_SOURCE_ROOT)),
    stressRoot: resolve(argValue(args, "--stress-root", DEFAULT_STRESS_ROOT)),
    outputDir: resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR)),
    stressRates,
    sliceCount: Math.max(2, Math.floor(numberValue(argValue(args, "--slices", "48"), 48))),
    formal: boolValue(argValue(args, "--formal", "true"), true),
    resume: boolValue(argValue(args, "--resume", "true"), true),
    neutralPass1Planner: argValue(args, "--neutral-pass1-planner", "legacy"),
  });
}
