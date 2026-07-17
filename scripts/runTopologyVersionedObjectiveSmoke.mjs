import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

const PROFILES = [
  { id: "iridium-next-small", label: "Iridium 66" },
  { id: "telesat-1015-medium", label: "Telesat 351" },
  { id: "starlink-main-large", label: "Starlink 1584" },
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number(numberValue(value).toFixed(digits));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function writeCsv(path, rows) {
  await writeFile(path, rowsToCsv(rows), "utf8");
}

async function runNode(script, args) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) accept();
      else reject(new Error(`${script} exited ${code}\n${stderr}`));
    });
  });
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + numberValue(row[field]), 0);
}

function mean(rows, field) {
  return rows.length ? sum(rows, field) / rows.length : 0;
}

function pathKey(row) {
  return `${row.slice_index}|${row.source_candidate_probe_id || row.probe_id}|${row.path}`;
}

function jaccard(leftRows, rightRows) {
  const left = new Set(leftRows.map(pathKey));
  const right = new Set(rightRows.map(pathKey));
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const key of left) if (right.has(key)) intersection += 1;
  return intersection / union.size;
}

async function prepareFixture({ profile, sourceRoot, fixtureRoot, slices }) {
  const sourceProfile = join(sourceRoot, profile.id);
  const truthSource = join(sourceProfile, "stage1-truth");
  const candidateSource = join(sourceProfile, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv");
  if (!existsSync(join(truthSource, "links.csv")) || !existsSync(candidateSource)) {
    throw new Error(`missing formal source data for ${profile.id}`);
  }
  const [links, nodes, routes, candidates, metadata] = await Promise.all([
    readCsv(join(truthSource, "links.csv")),
    readCsv(join(truthSource, "nodes.csv")),
    readCsv(join(truthSource, "routes.csv")),
    readCsv(candidateSource),
    readFile(join(truthSource, "metadata.json"), "utf8").then(JSON.parse),
  ]);
  const selectedSlices = [...new Set(links.map((row) => numberValue(row.slice_index)))]
    .sort((left, right) => left - right)
    .slice(0, slices);
  const selected = new Set(selectedSlices.map(String));
  const truthDir = join(fixtureRoot, "truth");
  await mkdir(truthDir, { recursive: true });
  await Promise.all([
    writeCsv(join(truthDir, "links.csv"), links.filter((row) => selected.has(String(row.slice_index)))),
    writeCsv(join(truthDir, "nodes.csv"), nodes.filter((row) => selected.has(String(row.slice_index)))),
    writeCsv(join(truthDir, "routes.csv"), routes.filter((row) => selected.has(String(row.slice_index)))),
    writeCsv(join(fixtureRoot, "candidate-paths.csv"), candidates.filter((row) => selected.has(String(row.slice_index)))),
    writeFile(join(truthDir, "metadata.json"), `${JSON.stringify({
      ...metadata,
      slice_count: selectedSlices.length,
      smoke_source: "formal-experiment2-shared-input",
      smoke_slice_indexes: selectedSlices,
    }, null, 2)}\n`, "utf8"),
  ]);
  return { truthDir, candidatePath: join(fixtureRoot, "candidate-paths.csv"), selectedSlices };
}

async function runSelectorVariant({ truthDir, candidatePath, outputDir, enabled }) {
  await mkdir(outputDir, { recursive: true });
  await runNode("stage2-int/tools/int-mc-path-selector.mjs", [
    "--input", truthDir,
    "--stage2", outputDir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", candidatePath,
    "--sampling-rate", "0.25",
    "--target-active-link-sampling-rate", "0.25",
    "--warmup-slices", "2",
    "--window-size", "4",
    "--rank", "5",
    "--max-paths-per-slice", "12",
    "--observability-mode", "oam-only",
    "--feedback-lag-slices", "1",
    "--adaptive-reuse", "true",
    "--incremental-topology-repair", "true",
    "--forecast-risk-scoring", "true",
    "--topology-versioned-objective", String(enabled),
  ]);
  return {
    paths: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    slices: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
    report: JSON.parse(await readFile(join(outputDir, "probe-coverage-int-mc.json"), "utf8")),
  };
}

function compare(profile, baseline, treatment, slices) {
  const baselineCoverage = numberValue(baseline.report.coverage.active_link_sampling_coverage);
  const treatmentCoverage = numberValue(treatment.report.coverage.active_link_sampling_coverage);
  const baselineBytes = sum(baseline.slices, "estimated_total_telemetry_bytes");
  const treatmentBytes = sum(treatment.slices, "estimated_total_telemetry_bytes");
  const baselineEnergy = sum(baseline.slices, "estimated_total_telemetry_energy_j");
  const treatmentEnergy = sum(treatment.slices, "estimated_total_telemetry_energy_j");
  const coverageDelta = treatmentCoverage - baselineCoverage;
  const byteDeltaRatio = baselineBytes > 0 ? (treatmentBytes - baselineBytes) / baselineBytes : 0;
  const energyDeltaRatio = baselineEnergy > 0 ? (treatmentEnergy - baselineEnergy) / baselineEnergy : 0;
  const coverageGuardPassed = coverageDelta >= -0.02;
  const bytesGuardPassed = byteDeltaRatio <= 0.01;
  const energyGuardPassed = energyDeltaRatio <= 0.01;
  return {
    profile_id: profile.id,
    constellation: profile.label,
    slices,
    baseline_selected_paths: baseline.paths.length,
    treatment_selected_paths: treatment.paths.length,
    selected_path_jaccard: round(jaccard(baseline.paths, treatment.paths)),
    changed_path_ratio: round(1 - jaccard(baseline.paths, treatment.paths)),
    baseline_active_link_coverage: round(baselineCoverage),
    treatment_active_link_coverage: round(treatmentCoverage),
    coverage_delta: round(coverageDelta),
    baseline_estimated_bytes: round(baselineBytes),
    treatment_estimated_bytes: round(treatmentBytes),
    estimated_byte_delta_ratio: round(byteDeltaRatio),
    baseline_estimated_energy_j: round(baselineEnergy),
    treatment_estimated_energy_j: round(treatmentEnergy),
    estimated_energy_delta_ratio: round(energyDeltaRatio),
    baseline_planning_cost_units: round(sum(baseline.slices, "planning_actual_cost_units")),
    treatment_planning_cost_units: round(sum(treatment.slices, "planning_actual_cost_units")),
    treatment_mean_objective: round(mean(treatment.slices, "mean_topology_versioned_objective")),
    treatment_mean_expected_error_reduction: round(mean(treatment.slices, "mean_topology_versioned_expected_error_reduction")),
    treatment_mean_expected_aoi_reduction: round(mean(treatment.slices, "mean_topology_versioned_expected_aoi_reduction")),
    treatment_mean_score_adjustment: round(mean(treatment.slices, "mean_topology_versioned_score_adjustment")),
    treatment_promoted_paths: sum(treatment.slices, "topology_versioned_promoted_paths"),
    treatment_demoted_paths: sum(treatment.slices, "topology_versioned_demoted_paths"),
    treatment_fallback_paths: sum(treatment.slices, "topology_versioned_legacy_fallback_paths"),
    coverage_guard_passed: coverageGuardPassed,
    bytes_guard_passed: bytesGuardPassed,
    energy_guard_passed: energyGuardPassed,
    conservative_guards_passed: coverageGuardPassed && bytesGuardPassed && energyGuardPassed,
  };
}

const args = process.argv.slice(2);
const slices = Math.max(2, Math.floor(numberValue(argValue(args, "--slices", "4"), 4)));
const sourceRoot = resolve(argValue(args, "--source", "reports/experiment2-native-baseline-rerun-final"));
const outputRoot = resolve(argValue(args, "--out", "reports/_scratch/topology-versioned-objective-smoke"));
const retainFixtures = argValue(args, "--retain-fixtures", "false").toLowerCase() === "true";
const requestedProfiles = new Set(argValue(args, "--profiles", PROFILES.map((profile) => profile.id).join(",")).split(",").map((value) => value.trim()));
const profiles = PROFILES.filter((profile) => requestedProfiles.has(profile.id));
if (!profiles.length) throw new Error("no recognized profiles selected");
if (existsSync(outputRoot)) await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const rows = [];
for (const profile of profiles) {
  const profileRoot = join(outputRoot, profile.id);
  const fixtureRoot = join(profileRoot, "fixture");
  const fixture = await prepareFixture({ profile, sourceRoot, fixtureRoot, slices });
  const baseline = await runSelectorVariant({
    ...fixture,
    outputDir: join(profileRoot, "baseline"),
    enabled: false,
  });
  const treatment = await runSelectorVariant({
    ...fixture,
    outputDir: join(profileRoot, "treatment"),
    enabled: true,
  });
  rows.push(compare(profile, baseline, treatment, fixture.selectedSlices.length));
  if (!retainFixtures) await rm(fixtureRoot, { recursive: true, force: true });
}

const summary = {
  schema_version: "topology-versioned-objective-smoke-v1",
  generated_at: new Date().toISOString(),
  formal_experiment: false,
  purpose: "Fast conservative A/B gate before any full telemetry/completion experiment",
  parameters: { slices, profiles: profiles.map((profile) => profile.id), retain_fixtures: retainFixtures },
  all_conservative_guards_passed: rows.every((row) => row.conservative_guards_passed),
  rows,
};
await Promise.all([
  writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
  writeCsv(join(outputRoot, "summary.csv"), rows),
]);
console.log(JSON.stringify(summary, null, 2));
