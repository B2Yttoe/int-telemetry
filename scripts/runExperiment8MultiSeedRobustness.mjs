import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_CATALOG } from "./experiments/intMcExperimentCore.mjs";
import { calculatePathValidity, summarizePathValidity } from "./experiments/dynamicityExperimentMetrics.mjs";
import { transformDynamicityTrace } from "./experiments/dynamicityStress.mjs";
import { EXPERIMENT8_STRESS_RATES } from "./runExperiment8DynamicityCausality.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

export function summarizeConfidenceInterval(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return { count: 0, mean: 0, standard_deviation: 0, ci95_low: 0, ci95_high: 0 };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.length > 1
    ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const halfWidth = 1.96 * standardDeviation / Math.sqrt(finite.length);
  return {
    count: finite.length,
    mean: round(mean),
    standard_deviation: round(standardDeviation),
    ci95_low: round(mean - halfWidth),
    ci95_high: round(mean + halfWidth),
  };
}

export function buildMultiSeedMatrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT8_STRESS_RATES,
  seedCount = 30,
} = {}) {
  const seeds = Array.from({ length: seedCount }, (_, index) => `seed-${String(index).padStart(2, "0")}`);
  return profileIds.flatMap((profileId) => stressRates.flatMap((stressRate) => seeds.map((seed) => ({
    profile_id: profileId,
    stress_rate: Number(stressRate),
    seed,
  }))));
}

export function addPairedBaselineDeltas(rows = []) {
  const baselineByPair = new Map(
    rows
      .filter((row) => numberValue(row.stress_rate) === 0)
      .map((row) => [`${row.profile_id}|${row.seed}`, numberValue(row.path_failure_ratio)]),
  );
  return rows.map((row) => ({
    ...row,
    excess_path_failure_ratio: round(
      numberValue(row.path_failure_ratio) - numberValue(baselineByPair.get(`${row.profile_id}|${row.seed}`)),
    ),
  }));
}

function aggregate(rawRows) {
  const result = [];
  for (const profileId of [...new Set(rawRows.map((row) => row.profile_id))]) {
    for (const stressRate of [...new Set(rawRows.filter((row) => row.profile_id === profileId).map((row) => row.stress_rate))].sort((a, b) => a - b)) {
      const rows = rawRows.filter((row) => row.profile_id === profileId && row.stress_rate === stressRate);
      const profile = PROFILE_CATALOG.find((candidate) => candidate.id === profileId);
      const path = summarizeConfidenceInterval(rows.map((row) => row.path_failure_ratio));
      const excessPath = summarizeConfidenceInterval(rows.map((row) => row.excess_path_failure_ratio));
      const dynamicity = summarizeConfidenceInterval(rows.map((row) => row.mean_dynamicity));
      const jaccard = summarizeConfidenceInterval(rows.map((row) => row.mean_jaccard_similarity));
      result.push({
        profile_id: profileId,
        constellation_label: profile?.short_label ?? profileId,
        stress_rate: stressRate,
        seeds: rows.length,
        path_failure_mean: path.mean,
        path_failure_std: path.standard_deviation,
        path_failure_ci95_low: path.ci95_low,
        path_failure_ci95_high: path.ci95_high,
        excess_path_failure_mean: excessPath.mean,
        excess_path_failure_std: excessPath.standard_deviation,
        excess_path_failure_ci95_low: excessPath.ci95_low,
        excess_path_failure_ci95_high: excessPath.ci95_high,
        dynamicity_mean: dynamicity.mean,
        dynamicity_ci95_low: dynamicity.ci95_low,
        dynamicity_ci95_high: dynamicity.ci95_high,
        jaccard_mean: jaccard.mean,
        jaccard_ci95_low: jaccard.ci95_low,
        jaccard_ci95_high: jaccard.ci95_high,
        forced_down_fraction_mean: round(rows.reduce((sum, row) => sum + row.mean_forced_down_fraction, 0) / Math.max(rows.length, 1)),
      });
    }
  }
  return result;
}

function reportHtml(summaryRows) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验8 多种子鲁棒性</title><style>body{font-family:"Microsoft YaHei",Arial,sans-serif;background:#f4f7f8;color:#17242b;margin:0}main{max-width:1300px;margin:auto;padding:28px}.band{background:#fff;border-left:5px solid #047857;padding:18px;margin:16px 0}table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}th,td{border:1px solid #d7e0e3;padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#e8f0f2}</style></head><body><main><h1>实验 8：参考计划失效的多种子鲁棒性</h1><div class="band">每个星座、每个扰动档位使用 30 个后续交换 seed；T00 初始 mask、自然物理拓扑、业务和参考 probe plan 固定。主要统计量是同一 seed 相对 0% 组的额外失效比例，用配对差消除轻量 mask 与完整 Stage-1 回放之间的固定偏移。</div><table><thead><tr><th>星座</th><th>扰动率</th><th>seed</th><th>额外失效均值</th><th>额外失效 95% CI</th><th>原始失效均值</th><th>动态性均值</th><th>Jaccard 均值</th><th>forced-down 密度</th></tr></thead><tbody>${summaryRows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${(row.stress_rate*100).toFixed(0)}%</td><td>${row.seeds}</td><td>${(row.excess_path_failure_mean*100).toFixed(2)}%</td><td>[${(row.excess_path_failure_ci95_low*100).toFixed(2)}%, ${(row.excess_path_failure_ci95_high*100).toFixed(2)}%]</td><td>${(row.path_failure_mean*100).toFixed(2)}%</td><td>${(row.dynamicity_mean*100).toFixed(2)}%</td><td>${row.jaccard_mean.toFixed(4)}</td><td>${(row.forced_down_fraction_mean*100).toFixed(2)}%</td></tr>`).join("")}</tbody></table><h2>边界</h2><p>该快速多种子分析只验证“拓扑扰动 → 参考计划失效”的统计稳定性。重构误差仍来自完整因果 Stage-1 回放实验，不用后处理拓扑替代节点、队列或能耗真值。</p></main></body></html>`;
}

function reportMarkdown(summaryRows) {
  return `# 实验 8：参考计划失效的多种子鲁棒性\n\n每个组合 30 个 seed，固定 T00 初始 mask，只改变后续受控交换顺序。主要统计同一 seed 相对 0% 组的额外失效比例。\n\n| 星座 | 扰动率 | 额外失效均值 | 额外失效 95% CI | 原始失效均值 | Jaccard | forced-down 密度 |\n|---|---:|---:|---:|---:|---:|---:|\n${summaryRows.map((row) => `| ${row.constellation_label} | ${(row.stress_rate*100).toFixed(0)}% | ${(row.excess_path_failure_mean*100).toFixed(2)}% | [${(row.excess_path_failure_ci95_low*100).toFixed(2)}%, ${(row.excess_path_failure_ci95_high*100).toFixed(2)}%] | ${(row.path_failure_mean*100).toFixed(2)}% | ${row.jaccard_mean} | ${(row.forced_down_fraction_mean*100).toFixed(2)}% |`).join("\n")}\n\n该分析只支持拓扑到路径失效的鲁棒性结论；节点和链路重构误差使用完整因果回放结果。\n`;
}

export async function runMultiSeedRobustness({
  oldRoot,
  experiment8Dir,
  outputDir,
  rootReportPath,
  profiles = PROFILE_CATALOG,
  stressRates = EXPERIMENT8_STRESS_RATES,
  seedCount = 30,
  tolerance = 0.01,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const rawRows = [];
  const matrix = buildMultiSeedMatrix({ profileIds: profiles.map((profile) => profile.id), stressRates, seedCount });
  for (const profile of profiles) {
    const sourceLinks = await readCsv(join(oldRoot, profile.id, "stage1-truth", "links.csv"));
    const referencePlan = await readCsv(join(experiment8Dir, "runs", profile.id, "stress-00", "native", "stage2", "probe-paths-int-mc.csv"));
    for (const stressRate of stressRates) {
      for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
        const seed = `seed-${String(seedIndex).padStart(2, "0")}`;
        const transformed = transformDynamicityTrace({
          links: sourceLinks,
          targetStressRate: Number(stressRate),
          seed: `${seed}:${profile.id}`,
          initialMaskSeed: `experiment8-formal:${profile.id}`,
          tolerance,
        });
        const validity = summarizePathValidity(calculatePathValidity({ probeRows: referencePlan, linkRows: transformed.links }));
        rawRows.push({
          profile_id: profile.id,
          constellation_label: profile.short_label,
          stress_rate: Number(stressRate),
          seed,
          path_failure_ratio: validity.path_failure_ratio,
          invalidated_paths: validity.invalidated_paths,
          selected_paths: validity.selected_paths,
          achieved_stress_rate: transformed.summary.achieved_stress_rate,
          mean_dynamicity: transformed.summary.achieved_mean_dynamicity,
          mean_jaccard_similarity: transformed.summary.mean_jaccard_similarity,
          mean_forced_down_fraction: transformed.summary.mean_forced_down_fraction,
        });
      }
      console.log(JSON.stringify({ profile_id: profile.id, stress_rate: Number(stressRate), completed_seeds: seedCount }));
      if (typeof global.gc === "function") global.gc();
    }
  }
  if (rawRows.length !== matrix.length) throw new Error(`Expected ${matrix.length} multi-seed rows, got ${rawRows.length}`);
  const pairedRows = addPairedBaselineDeltas(rawRows);
  const summaryRows = aggregate(pairedRows);
  const outputs = {
    raw_csv: join(outputDir, "experiment8-multi-seed-raw.csv"),
    summary_csv: join(outputDir, "experiment8-multi-seed-summary.csv"),
    summary_json: join(outputDir, "experiment8-multi-seed-summary.json"),
    report_html: join(outputDir, "experiment8-multi-seed-report.html"),
    report_md: rootReportPath,
  };
  await Promise.all([
    writeFile(outputs.raw_csv, rowsToCsv(pairedRows), "utf8"),
    writeFile(outputs.summary_csv, rowsToCsv(summaryRows), "utf8"),
    writeFile(outputs.summary_json, `${JSON.stringify({ schema_version: "experiment8-multi-seed-path-robustness-v1", generated_at: new Date().toISOString(), seed_count: seedCount, raw_rows: rawRows.length, summary_rows: summaryRows }, null, 2)}\n`, "utf8"),
    writeFile(outputs.report_html, reportHtml(summaryRows), "utf8"),
    writeFile(outputs.report_md, reportMarkdown(summaryRows), "utf8"),
  ]);
  return { rawRows: pairedRows, summaryRows, outputs };
}

async function main() {
  const args = process.argv.slice(2);
  const profileIds = argValue(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id).join(",")).split(",").filter(Boolean);
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const result = await runMultiSeedRobustness({
    oldRoot: resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final")),
    experiment8Dir: resolve(argValue(args, "--experiment8", "reports/experiment8-dynamicity-causality")),
    outputDir: resolve(argValue(args, "--out", "reports/experiment8-multi-seed-robustness")),
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_8_MULTI_SEED_ROBUSTNESS_REPORT.md")),
    profiles,
    stressRates: argValue(args, "--targets", EXPERIMENT8_STRESS_RATES.join(",")).split(",").map(Number),
    seedCount: Math.max(2, Math.floor(numberValue(argValue(args, "--seed-count", "30"), 30))),
    tolerance: numberValue(argValue(args, "--tolerance", "0.01"), 0.01),
  });
  console.log(JSON.stringify({ ok: true, raw_rows: result.rawRows.length, summary_rows: result.summaryRows.length, report: relative(process.cwd(), result.outputs.report_html) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
