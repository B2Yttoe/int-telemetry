import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectIntMcMetrics } from "./experiments/intMcExperimentCore.mjs";
import { parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

function boolValue(value) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findRunManifests(root) {
  if (!existsSync(root)) return [];
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "run-manifest.json") result.push(path);
    }
  }
  await visit(root);
  return result;
}

async function migratePhase({ phase, truthDir, migratedGroundDirs }) {
  const groundLinksPath = phase?.artifacts?.ground_links_csv;
  const evaluationPath = phase?.artifacts?.evaluation_json;
  const stage2Dir = phase?.artifacts?.selector_report_json ? resolve(phase.artifacts.selector_report_json, "..") : "";
  const groundDir = evaluationPath ? resolve(evaluationPath, "..") : "";
  if (!groundLinksPath || !evaluationPath || !existsSync(groundLinksPath) || !existsSync(evaluationPath)) {
    return { phase, changedRows: 0, skipped: true };
  }
  let changedRows = 0;
  if (!migratedGroundDirs.has(groundDir)) {
    const rows = parseCsv(await readFile(groundLinksPath, "utf8"));
    rows.forEach((row) => {
      if (!boolValue(row.topology_down) || String(row.status_estimate).toLowerCase() === "down") return;
      row.status_estimate = "down";
      row.active_estimate = "false";
      changedRows += 1;
    });
    if (changedRows > 0) await writeFile(groundLinksPath, rowsToCsv(rows), "utf8");

    const truthRows = parseCsv(await readFile(join(truthDir, "links.csv"), "utf8"));
    const truthByKey = new Map(truthRows.map((row) => [`${row.slice_index}|${row.link_id}`, row]));
    let statusMatches = 0;
    rows.forEach((row) => {
      const truth = truthByKey.get(`${row.slice_index}|${row.link_id}`);
      if (truth && String(row.status_estimate) === String(truth.status)) statusMatches += 1;
    });
    const evaluation = await readJson(evaluationPath);
    evaluation.reconstruction.status_accuracy_all_links = round(statusMatches / Math.max(rows.length, 1));
    evaluation.artifact_migration = {
      id: "topology-down-status-lock-v1",
      migrated_at: new Date().toISOString(),
      changed_rows: changedRows,
      invariant: "topology_down implies active_estimate=false and status_estimate=down",
    };
    await writeJson(evaluationPath, evaluation);
    migratedGroundDirs.add(groundDir);
  }
  const metrics = await collectIntMcMetrics({ truthDir, stage2Dir, groundDir });
  return { phase: { ...phase, metrics }, changedRows, skipped: false };
}

export async function migrateTopologyDownArtifacts({ roots, baselineRoot }) {
  const manifests = (await Promise.all(roots.map(findRunManifests))).flat();
  const migratedGroundDirs = new Set();
  const summary = [];
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    if (manifest.status !== "complete" || !manifest.profile_id) continue;
    const truthDir = join(baselineRoot, manifest.profile_id, "stage1-truth");
    const before = await migratePhase({ phase: manifest.before, truthDir, migratedGroundDirs });
    const after = await migratePhase({ phase: manifest.after, truthDir, migratedGroundDirs });
    manifest.before = before.phase;
    manifest.after = after.phase;
    manifest.artifact_migrations = [
      ...(manifest.artifact_migrations ?? []).filter((row) => row.id !== "topology-down-status-lock-v1"),
      {
        id: "topology-down-status-lock-v1",
        migrated_at: new Date().toISOString(),
        before_changed_rows: before.changedRows,
        after_changed_rows: after.changedRows,
      },
    ];
    await writeJson(manifestPath, manifest);
    summary.push({
      manifest: manifestPath,
      profile: manifest.profile_id,
      variant: manifest.variant_id ?? "",
      before_changed_rows: before.changedRows,
      after_changed_rows: after.changedRows,
      before_status_accuracy: manifest.before?.metrics?.link_status_accuracy,
      after_status_accuracy: manifest.after?.metrics?.link_status_accuracy,
    });
  }
  return { manifests: summary.length, unique_ground_dirs: migratedGroundDirs.size, rows: summary };
}

async function main() {
  const result = await migrateTopologyDownArtifacts({
    roots: [
      resolve("reports/experiment4-leo-int-mc-ablation/runs"),
      resolve("reports/experiment6-sampling-sensitivity/runs"),
    ],
    baselineRoot: resolve("reports/experiment2-native-baseline-rerun-final"),
  });
  console.log(JSON.stringify({
    ok: true,
    manifests: result.manifests,
    unique_ground_dirs: result.unique_ground_dirs,
    changed_rows: result.rows.reduce((sum, row) => sum + row.before_changed_rows + row.after_changed_rows, 0),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
