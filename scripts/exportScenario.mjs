import { build } from "esbuild";
import { basename, resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const validProfiles = new Set(["empty", "low-load", "normal", "high-load", "hotspot", "burst", "long-duration", "uploaded"]);
const validOrbitModels = new Set(["analytic-walker", "tle-sgp4", "real-tle-sgp4"]);
const validModes = new Set(["autonomous", "operational"]);
const validRouting = new Set(["shortest-path"]);

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const profile = argValue(args, "--profile", "normal");
const orbitModel = argValue(args, "--orbit", "tle-sgp4");
const mode = argValue(args, "--mode", "operational");
const routingAlgorithm = argValue(args, "--routing", "shortest-path");
const tasksPath = argValue(args, "--tasks", "");
const tleSnapshotPath = argValue(args, "--tle-snapshot", "");
const slicesOverride = argValue(args, "--slices", "");
const outDir = resolve(argValue(args, "--out", `exports/${profile}-${orbitModel}`));
const includeFullJson = hasArg(args, "--full-json");

if (!validProfiles.has(profile)) fail(`Unknown --profile ${profile}`);
if (!validOrbitModels.has(orbitModel)) fail(`Unknown --orbit ${orbitModel}`);
if (!validModes.has(mode)) fail(`Unknown --mode ${mode}`);
if (!validRouting.has(routingAlgorithm)) fail(`Unknown --routing ${routingAlgorithm}`);

const taskFileName = tasksPath ? basename(tasksPath) : "";
const taskText = tasksPath ? await readFile(tasksPath, "utf8") : "";
const tleSnapshotText = tleSnapshotPath ? await readFile(tleSnapshotPath, "utf8") : "";
const timeSlices = slicesOverride ? Number(slicesOverride) : undefined;
const effectiveProfile = tasksPath ? "uploaded" : profile;
const datasetName = tasksPath ? `${taskFileName}` : `scenario:${profile}`;
const effectiveOrbitModel = tleSnapshotPath ? "real-tle-sgp4" : orbitModel;

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import {
    experimentJson,
    experimentMetadata,
    linkSnapshotRows,
    networkMetricRows,
    nodeSnapshotRows,
    routeSnapshotRows,
    rowsToCsv,
  } from "./src/simulation/export.ts";
  import { effectiveTrafficTasks, parseTaskDataset, validateTaskDataset } from "./src/simulation/traffic.ts";
  import { verifyRealTleSnapshot } from "./src/simulation/realTleCatalog.ts";

  export function createScenarioExport(options) {
    const tleCatalogSnapshot = options.tleSnapshotText ? JSON.parse(options.tleSnapshotText) : undefined;
    if (tleCatalogSnapshot) {
      const verification = verifyRealTleSnapshot(tleCatalogSnapshot);
      if (!verification.ok) {
        return { ok: false, validation: { accepted: 0, warnings: [], errors: verification.errors } };
      }
    }
    const baseRuntimeConfig = tleCatalogSnapshot
      ? {
          ...walkerNetworkConfig,
          constellation: {
            ...walkerNetworkConfig.constellation,
            shellId: tleCatalogSnapshot.shell_id,
            planes: tleCatalogSnapshot.layout.planes,
            satellitesPerPlane: tleCatalogSnapshot.layout.satellites_per_plane,
            altitudeKm: tleCatalogSnapshot.mean_altitude_km,
            inclinationDeg: tleCatalogSnapshot.mean_inclination_deg,
          },
          orbit: {
            ...walkerNetworkConfig.orbit,
            model: "real-tle-sgp4",
            tleCatalog: {
              ...walkerNetworkConfig.orbit.tleCatalog,
              source: tleCatalogSnapshot.source,
            },
          },
        }
      : walkerNetworkConfig;
    const runtimeConfig = options.timeSlices
      ? {
          ...baseRuntimeConfig,
          time: {
            ...baseRuntimeConfig.time,
            slices: options.timeSlices,
          },
        }
      : baseRuntimeConfig;
    const tasks = options.taskText
      ? parseTaskDataset(options.taskText, options.taskFileName)
      : [];
    const effectiveTasks = effectiveTrafficTasks(runtimeConfig, options.profile, tasks);
    const validation = validateTaskDataset(effectiveTasks, runtimeConfig);
    if (validation.errors.length > 0) {
      return { ok: false, validation };
    }
    const orbitModel = tleCatalogSnapshot ? "real-tle-sgp4" : options.orbitModel;
    const slices = generateWalkerNetwork(runtimeConfig, {
      mode: options.mode,
      tasks,
      trafficProfile: options.profile,
      orbitModel,
      routingAlgorithm: options.routingAlgorithm,
      tleCatalogSnapshot,
    });
    const context = {
      simulationMode: options.mode,
      trafficProfile: options.profile,
      orbitModel,
      routingAlgorithm: options.routingAlgorithm,
      datasetName: options.datasetName,
      configSnapshot: runtimeConfig,
      taskRecords: effectiveTasks,
      validationSummary: validation,
      tleCatalogSnapshot,
    };
    const nodes = nodeSnapshotRows(slices);
    const links = linkSnapshotRows(slices);
    const routes = routeSnapshotRows(slices);
    const metrics = networkMetricRows(slices);
    const metadata = experimentMetadata(context, slices);
    return {
      ok: true,
      validation,
      metadata,
      tleCatalogSnapshot,
      counts: {
        slices: slices.length,
        nodes: nodes.length,
        links: links.length,
        routes: routes.length,
        metrics: metrics.length,
      },
      files: {
        "metadata.json": JSON.stringify({ ...metadata, validation }, null, 2),
        "nodes.csv": rowsToCsv(nodes),
        "links.csv": rowsToCsv(links),
        "routes.csv": rowsToCsv(routes),
        "metrics.csv": rowsToCsv(metrics),
        ...(options.includeFullJson ? { "truth.json": experimentJson(context, slices) } : {}),
      },
    };
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "scenario-export.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = ".tmp/scenario-export.mjs";
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { createScenarioExport } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

const exported = createScenarioExport({
  mode,
  profile: effectiveProfile,
  orbitModel,
  tleSnapshotText,
  timeSlices,
  routingAlgorithm,
  taskText,
  taskFileName,
  datasetName,
  includeFullJson,
});

if (!exported.ok) {
  console.error(JSON.stringify(exported.validation, null, 2));
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
for (const [fileName, content] of Object.entries(exported.files)) {
  await writeFile(resolve(outDir, fileName), content, "utf8");
}

console.log(
  JSON.stringify(
    {
      outDir,
      profile: effectiveProfile,
      orbitModel: effectiveOrbitModel,
      tleSnapshot: tleSnapshotPath || undefined,
      mode,
      routingAlgorithm,
      datasetName,
      fingerprints: {
        config: exported.metadata.config_fingerprint,
        dataset: exported.metadata.dataset_fingerprint,
        truth: exported.metadata.truth_fingerprint,
      },
      validation: exported.validation,
      counts: exported.counts,
      files: Object.keys(exported.files),
    },
    null,
    2,
  ),
);
