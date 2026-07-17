import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  runIntMcCompletion,
} from "./experiments/intMcExperimentCore.mjs";
import {
  EXPERIMENT8_STRESS_RATES,
  experiment8ImplementationFingerprint,
  methodDefinitions,
  refreshCompletionManifest,
} from "./runExperiment8DynamicityCausality.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function rateId(rate) {
  return `stress-${String(Math.round(Number(rate) * 100)).padStart(2, "0")}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertFixedBudget(before, after, context) {
  for (const field of [
    "selected_paths",
    "total_telemetry_generated_bytes",
    "hop_records",
    "report_count",
    "active_link_sampling_coverage",
  ]) {
    if (before?.[field] !== after?.[field]) {
      throw new Error(`${context}: completion refresh changed fixed-budget field ${field}: ${before?.[field]} -> ${after?.[field]}`);
    }
  }
}

export async function refreshExperiment8Completions({
  outputDir,
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT8_STRESS_RATES,
  methodIds = methodDefinitions().map((method) => method.id),
} = {}) {
  const implementationFingerprint = await experiment8ImplementationFingerprint();
  const methods = new Map(methodDefinitions().map((method) => [method.id, method]));
  const refreshed = [];

  for (const profileId of profileIds) {
    for (const stressRate of stressRates) {
      const stress = rateId(stressRate);
      const truthDir = join(outputDir, "inputs", profileId, stress);
      for (const methodId of methodIds) {
        const method = methods.get(methodId);
        if (!method) throw new Error(`Unknown Experiment 8 method: ${methodId}`);
        const methodDir = join(outputDir, "runs", profileId, stress, methodId);
        const manifestPath = join(methodDir, "run-manifest.json");
        if (!existsSync(manifestPath)) throw new Error(`Missing Experiment 8 run manifest: ${manifestPath}`);
        const manifest = await readJson(manifestPath);
        const stage2Dir = dirname(manifest.run.artifacts.probe_paths_csv);
        const groundDir = dirname(manifest.run.artifacts.evaluation_json);
        const completion = await runIntMcCompletion({
          label: `Experiment 8 refresh ${profileId} ${stress} ${methodId}`,
          truthDir,
          stage2Dir,
          groundDir,
          rank: manifest.parameters.rank,
          windowSize: manifest.parameters.windowSize,
          iterations: manifest.parameters.iterations,
          predictedContactPlanPath: manifest.run.artifacts.predicted_contact_plan_json,
          mechanisms: method.mechanisms,
        });
        assertFixedBudget(manifest.run.metrics, completion.metrics, `${profileId}/${stress}/${methodId}`);
        const updated = refreshCompletionManifest({
          manifest,
          completion,
          implementationFingerprint,
        });
        await writeFile(manifestPath, JSON.stringify(updated, null, 2), "utf8");
        refreshed.push({
          profile_id: profileId,
          stress_rate: Number(stressRate),
          method_id: methodId,
          matrix_completion_wall_time_ms: completion.timing.wall_time_ms,
          cpu_mae: completion.metrics.cpu_mae,
          queue_depth_mae: completion.metrics.queue_depth_mae,
          energy_percent_mae: completion.metrics.energy_percent_mae,
          link_utilization_mae: completion.metrics.link_utilization_mae,
          manifest: manifestPath,
        });
        console.log(JSON.stringify(refreshed.at(-1)));
      }
    }
  }
  return { implementation_fingerprint: implementationFingerprint, refreshed };
}

async function main() {
  const args = process.argv.slice(2);
  const outputDir = resolve(argValue(args, "--out", "reports/experiment8-dynamicity-causality"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const stressRates = listArg(args, "--stress-rates", EXPERIMENT8_STRESS_RATES).map(Number);
  const methodIds = listArg(args, "--methods", methodDefinitions().map((method) => method.id));
  const result = await refreshExperiment8Completions({ outputDir, profileIds, stressRates, methodIds });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
