import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_METRIC_DIRECTIONS,
  aggregateEqualBudgetRows,
  auditEqualBudgetFairness,
  validateEqualBudgetMatrix,
} from "./experiments/equalBudgetStatistics.mjs";
import {
  aggregateContributionSamples,
  buildContributionSamples,
  buildDynamicityInteractions,
} from "./experiments/dynamicAblationStatistics.mjs";
import {
  EXPERIMENT11_FULL_METHOD_ID,
  EXPERIMENT11_VARIANT_IDS,
  buildExperiment11Variants,
} from "./experiments/dynamicAblationVariants.mjs";
import { PROFILE_CATALOG, sha256File } from "./experiments/intMcExperimentCore.mjs";
import { rowsToCsv } from "./experiments/reportUtils.mjs";
import { DEFAULT_PROFILE_BUDGETS } from "./runExperiment10EqualBudgetDynamicity.mjs";
import {
  experiment8ImplementationFingerprint,
  runExperiment8,
} from "./runExperiment8DynamicityCausality.mjs";

export const EXPERIMENT11_STRESS_RATES = Object.freeze([0, 0.25]);
export const EXPERIMENT11_REPORTED_METRICS = Object.freeze([
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "node_mode_accuracy",
  "link_utilization_mae",
  "link_status_accuracy",
  "planning_wall_time_ms",
  "reconstruction_wall_time_ms",
  "telemetry_padding_bytes_per_node_slice",
  "invalid_probe_path_ratio",
]);

const SEED_SCHEMA_VERSION = "experiment11-seed-result-v1";
const CONFIG_SCHEMA_VERSION = "experiment11-config-v1";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseSeeds(raw = "10", prefix = "experiment11-seed") {
  const count = Number(raw);
  if (Number.isInteger(count) && count > 0) {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`);
  }
  const seeds = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  if (!seeds.length) throw new Error("At least one Experiment 11 seed is required");
  return seeds;
}

export function buildExperiment11Matrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT11_STRESS_RATES,
  seeds = parseSeeds("10"),
  methodIds = EXPERIMENT11_VARIANT_IDS,
} = {}) {
  return profileIds.flatMap((profileId) =>
    stressRates.flatMap((stressRate) =>
      seeds.flatMap((seed) => methodIds.map((methodId) => ({
        profile_id: profileId,
        stress_rate: Number(stressRate),
        seed,
        method_id: methodId,
      })))))
  ;
}

export function normalizeExperiment11Row(row, { profile, stressRate, seed, hardBudget }) {
  return {
    profile_id: profile.id,
    constellation_label: profile.short_label,
    node_count: profile.node_count,
    stress_rate: numberValue(stressRate),
    achieved_stress_rate: numberValue(row.achieved_stress_rate),
    achieved_mean_dynamicity: numberValue(row.achieved_mean_dynamicity),
    seed,
    method_id: row.method_id,
    method_label: row.method_label,
    hard_budget_bytes_per_node_slice: hardBudget,
    telemetry_byte_budget_per_node_slice: numberValue(row.telemetry_byte_budget_per_node_slice, hardBudget),
    telemetry_byte_budget_cap_violations: numberValue(row.telemetry_byte_budget_cap_violations),
    telemetry_byte_budget_utilization: numberValue(row.telemetry_byte_budget_utilization),
    telemetry_byte_budget_rejected_probe_paths: numberValue(row.telemetry_byte_budget_rejected_probe_paths),
    telemetry_byte_budget_padding_bytes: numberValue(row.telemetry_byte_budget_padding_bytes),
    telemetry_padding_bytes_per_node_slice: numberValue(row.telemetry_padding_bytes_per_node_slice),
    selected_paths: numberValue(row.selected_paths),
    invalid_probe_path_ratio: numberValue(row.invalid_probe_path_ratio ?? row.path_failure_ratio),
    telemetry_bytes_per_node_slice: numberValue(row.telemetry_bytes_per_node_slice),
    total_telemetry_generated_bytes: numberValue(row.total_telemetry_generated_bytes),
    total_telemetry_energy_j: numberValue(row.total_telemetry_energy_j),
    cpu_mae: numberValue(row.cpu_mae),
    queue_depth_mae: numberValue(row.queue_depth_mae),
    energy_percent_mae: numberValue(row.energy_percent_mae),
    node_mode_accuracy: numberValue(row.node_mode_accuracy),
    link_utilization_mae: numberValue(row.link_utilization_mae),
    link_status_accuracy: numberValue(row.link_status_accuracy),
    planning_wall_time_ms: numberValue(row.planning_wall_time_ms),
    reconstruction_wall_time_ms: numberValue(row.matrix_completion_ms ?? row.reconstruction_wall_time_ms),
  };
}

export function buildExperiment11ConfigFingerprint(input) {
  return stableHash({ schema_version: CONFIG_SCHEMA_VERSION, ...input });
}

async function implementationFingerprint() {
  return stableHash({
    experiment8: await experiment8ImplementationFingerprint(),
    variants: await sha256File(resolve("scripts/experiments/dynamicAblationVariants.mjs")),
    statistics: await sha256File(resolve("scripts/experiments/dynamicAblationStatistics.mjs")),
    seed_schema_version: SEED_SCHEMA_VERSION,
  });
}

async function pruneSeedBulk(seedRoot) {
  const root = resolve(seedRoot);
  for (const child of [join(root, "dynamicity", "runs"), join(root, "dynamicity", "inputs")]) {
    const target = resolve(child);
    const separator = process.platform === "win32" ? "\\" : "/";
    if (!target.startsWith(`${root}${separator}`)) throw new Error(`Unsafe prune target: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
}

function assertFairness(fairnessRows, formal) {
  const absoluteSpreadFailures = fairnessRows.filter((row) => numberValue(row.actual_bytes_per_node_slice_spread) > 1e-4);
  if (formal && (fairnessRows.some((row) => !row.ok) || absoluteSpreadFailures.length)) {
    throw new Error(`Experiment 11 equal-budget fairness gate failed (${absoluteSpreadFailures.length} absolute-spread failures)`);
  }
}

export async function runExperiment11({
  profiles = PROFILE_CATALOG,
  stressRates = EXPERIMENT11_STRESS_RATES,
  seeds = parseSeeds("10"),
  budgets = DEFAULT_PROFILE_BUDGETS,
  oldRoot = resolve("reports/experiment2-native-baseline-rerun-final"),
  outputDir = resolve("reports/experiment11-dynamic-equal-budget-ablation"),
  rootReportPath = resolve("EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md"),
  resume = true,
  retainBulk = false,
  formal = true,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const variants = buildExperiment11Variants();
  const sourceHashes = {};
  for (const profile of profiles) {
    sourceHashes[profile.id] = {
      metadata_sha256: await sha256File(join(oldRoot, profile.id, "stage1-truth", "metadata.json")),
      candidate_paths_sha256: await sha256File(join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv")),
    };
  }
  const implementation = await implementationFingerprint();
  const configFingerprint = buildExperiment11ConfigFingerprint({
    profile_ids: profiles.map((profile) => profile.id),
    stress_rates: stressRates,
    seeds,
    budgets,
    source_hashes: sourceHashes,
    variant_ids: EXPERIMENT11_VARIANT_IDS,
    variant_mechanisms: variants.map((variant) => ({ id: variant.id, mechanisms: variant.mechanisms })),
    implementation_fingerprint: implementation,
    telemetry_byte_budget_pad_to_cap: true,
  });
  const rawRows = [];
  const seedManifests = [];

  for (const profile of profiles) {
    const hardBudget = numberValue(budgets[profile.id]);
    if (hardBudget <= 0) throw new Error(`Missing positive Experiment 11 hard budget for ${profile.id}`);
    for (const seed of seeds) {
      const seedRoot = join(outputDir, "runs", profile.id, seed);
      const seedConfigPath = join(seedRoot, "seed-config.json");
      const seedResultPath = join(seedRoot, "seed-result.json");
      let seedResult = null;
      if (resume && existsSync(seedResultPath)) {
        const cached = await readJson(seedResultPath);
        if (cached.status === "complete" && cached.config_fingerprint === configFingerprint) seedResult = cached;
      }
      if (!seedResult) {
        let retainPartial = false;
        if (resume && existsSync(seedConfigPath)) {
          const previousConfig = await readJson(seedConfigPath);
          retainPartial = previousConfig.config_fingerprint === configFingerprint;
        }
        if (!retainPartial) await rm(join(seedRoot, "dynamicity"), { recursive: true, force: true });
        await mkdir(seedRoot, { recursive: true });
        await writeJson(seedConfigPath, {
          schema_version: CONFIG_SCHEMA_VERSION,
          config_fingerprint: configFingerprint,
          profile_id: profile.id,
          seed,
          variants: variants.map((variant) => ({ id: variant.id, mechanisms: variant.mechanisms })),
        });
        const run = await runExperiment8({
          profiles: [profile],
          stressRates,
          methods: variants,
          oldRoot,
          outputDir: join(seedRoot, "dynamicity"),
          rootReportPath: join(seedRoot, "dynamicity-report.md"),
          seed: `experiment11:${seed}`,
          resume,
          formal,
          parameters: {
            telemetryByteBudgetPerNodeSlice: hardBudget,
            telemetryByteBudgetPadToCap: true,
            writeEstimateGraph: false,
          },
        });
        const rows = run.summaryRows.map((row) => normalizeExperiment11Row(row, {
          profile,
          stressRate: row.target_stress_rate,
          seed,
          hardBudget,
        }));
        seedResult = {
          schema_version: SEED_SCHEMA_VERSION,
          status: "complete",
          generated_at: new Date().toISOString(),
          config_fingerprint: configFingerprint,
          profile_id: profile.id,
          seed,
          hard_budget_bytes_per_node_slice: hardBudget,
          rows,
        };
        await writeJson(seedResultPath, seedResult);
        if (!retainBulk) await pruneSeedBulk(seedRoot);
      }
      rawRows.push(...seedResult.rows);
      seedManifests.push({ profile_id: profile.id, seed, result_json: seedResultPath });
    }
  }

  validateEqualBudgetMatrix(rawRows, {
    profileIds: profiles.map((profile) => profile.id),
    stressRates,
    seeds,
    methodIds: EXPERIMENT11_VARIANT_IDS,
  });
  const fairnessRows = auditEqualBudgetFairness(rawRows, {
    requiredMethods: EXPERIMENT11_VARIANT_IDS,
    primaryMatchedMethods: EXPERIMENT11_VARIANT_IDS,
    achievedBudgetToleranceRatio: 1e-7,
  });
  assertFairness(fairnessRows, formal);
  const aggregateRows = aggregateEqualBudgetRows(rawRows, { metrics: EXPERIMENT11_REPORTED_METRICS });
  const metricDirections = Object.fromEntries(
    EXPERIMENT11_REPORTED_METRICS.map((metric) => [metric, DEFAULT_METRIC_DIRECTIONS[metric]]),
  );
  const ablationMethodIds = EXPERIMENT11_VARIANT_IDS.filter((id) => id !== EXPERIMENT11_FULL_METHOD_ID);
  const contributionSamples = buildContributionSamples(rawRows, {
    fullMethodId: EXPERIMENT11_FULL_METHOD_ID,
    ablationMethodIds,
    metricDirections,
  });
  const contributionRows = aggregateContributionSamples(contributionSamples);
  const interactionRows = buildDynamicityInteractions(contributionSamples, {
    lowStress: Math.min(...stressRates),
    highStress: Math.max(...stressRates),
  });
  const outputs = {
    raw_csv: join(outputDir, "experiment11-ablation-by-seed.csv"),
    aggregate_csv: join(outputDir, "experiment11-ablation-aggregate.csv"),
    contribution_samples_csv: join(outputDir, "experiment11-contribution-samples.csv"),
    contribution_csv: join(outputDir, "experiment11-mechanism-contributions.csv"),
    interaction_csv: join(outputDir, "experiment11-dynamicity-interactions.csv"),
    fairness_csv: join(outputDir, "experiment11-budget-fairness.csv"),
    summary_json: join(outputDir, "experiment11-summary.json"),
    manifest_json: join(outputDir, "experiment11-manifest.json"),
    report_html: join(outputDir, "experiment11-dynamic-ablation-report.html"),
    root_report_md: rootReportPath,
  };
  const generatedAt = new Date().toISOString();
  const parameters = {
    profile_ids: profiles.map((profile) => profile.id),
    stress_rates: stressRates,
    seeds,
    seed_count: seeds.length,
    variant_ids: EXPERIMENT11_VARIANT_IDS,
    hard_budgets_bytes_per_node_slice: budgets,
    telemetry_byte_budget_pad_to_cap: true,
    retain_bulk: retainBulk,
  };
  const summary = {
    schema_version: "experiment11-dynamic-equal-budget-ablation-v1",
    generated_at: generatedAt,
    formal,
    status: "complete",
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementation,
    parameters,
    source_hashes: sourceHashes,
    raw_rows: rawRows,
    aggregate_rows: aggregateRows,
    contribution_rows: contributionRows,
    dynamicity_interaction_rows: interactionRows,
    fairness_rows: fairnessRows,
  };
  const manifest = {
    schema_version: "experiment11-manifest-v1",
    generated_at: generatedAt,
    status: "complete",
    formal,
    host: {
      platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown",
      logical_cpu_count: cpus().length, total_memory_bytes: totalmem(),
      free_memory_bytes_at_report: freemem(), node_version: process.version,
    },
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementation,
    row_counts: {
      raw: rawRows.length,
      aggregate: aggregateRows.length,
      contribution_samples: contributionSamples.length,
      contributions: contributionRows.length,
      interactions: interactionRows.length,
      fairness: fairnessRows.length,
    },
    outputs,
    seed_manifests: seedManifests,
  };
  await Promise.all([
    writeFile(outputs.raw_csv, rowsToCsv(rawRows), "utf8"),
    writeFile(outputs.aggregate_csv, rowsToCsv(aggregateRows), "utf8"),
    writeFile(outputs.contribution_samples_csv, rowsToCsv(contributionSamples), "utf8"),
    writeFile(outputs.contribution_csv, rowsToCsv(contributionRows), "utf8"),
    writeFile(outputs.interaction_csv, rowsToCsv(interactionRows), "utf8"),
    writeFile(outputs.fairness_csv, rowsToCsv(fairnessRows), "utf8"),
    writeJson(outputs.summary_json, summary),
    writeJson(outputs.manifest_json, manifest),
  ]);
  return {
    rawRows, aggregateRows, contributionSamples, contributionRows, interactionRows,
    fairnessRows, outputs, manifest,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const result = await runExperiment11({
    profiles,
    stressRates: listArg(args, "--targets", EXPERIMENT11_STRESS_RATES).map(Number),
    seeds: parseSeeds(argValue(args, "--seeds", "10"), argValue(args, "--seed-prefix", "experiment11-seed")),
    oldRoot: resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final")),
    outputDir: resolve(argValue(args, "--out", "reports/experiment11-dynamic-equal-budget-ablation")),
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md")),
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    retainBulk: argValue(args, "--retain-bulk", "false").toLowerCase() === "true",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({
    ok: true,
    rows: result.rawRows.length,
    aggregate_rows: result.aggregateRows.length,
    report: relative(process.cwd(), result.outputs.report_html),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
