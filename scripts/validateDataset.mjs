import { build } from "esbuild";
import { basename, resolve } from "node:path";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const datasetPath = argValue(args, "--tasks", args[0] ?? "");
const tleSnapshotPath = argValue(args, "--tle-snapshot", "");
const jsonOnly = args.includes("--json");

if (!datasetPath) {
  fail("Usage: npm run validate:dataset -- --tasks examples/datasets/stage1-standard-traffic.csv");
}

const resolvedDatasetPath = resolve(datasetPath);
const taskFileName = basename(resolvedDatasetPath);
const taskText = await readFile(resolvedDatasetPath, "utf8");
const tleSnapshotText = tleSnapshotPath ? await readFile(resolve(tleSnapshotPath), "utf8") : "";

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { taskDatasetFingerprint } from "./src/simulation/export.ts";
  import { parseTaskDataset, validateTaskDataset } from "./src/simulation/traffic.ts";
  import { verifyRealTleSnapshot } from "./src/simulation/realTleCatalog.ts";

  export function validateDataset(taskText, fileName, tleSnapshotText) {
    const tleCatalogSnapshot = tleSnapshotText ? JSON.parse(tleSnapshotText) : undefined;
    if (tleCatalogSnapshot) {
      const snapshotValidation = verifyRealTleSnapshot(tleCatalogSnapshot);
      if (!snapshotValidation.ok) {
        return {
          fileName,
          datasetSchema: "schemas/task-dataset-file.schema.json",
          taskSchema: "schemas/task-dataset.schema.json",
          datasetFingerprint: "",
          simulationSlices: walkerNetworkConfig.time.slices,
          accepted: 0,
          warnings: [],
          errors: snapshotValidation.errors,
          summary: {
            routedTasks: 0,
            localTasks: 0,
            totalTrafficMbps: 0,
            totalComputeUnits: 0,
            totalMemoryGb: 0,
            totalStorageGb: 0,
            firstActiveSlice: null,
            lastActiveSlice: null,
          },
        };
      }
    }
    const runtimeConfig = tleCatalogSnapshot
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
    const tasks = parseTaskDataset(taskText, fileName);
    const validation = validateTaskDataset(tasks, runtimeConfig);
    const datasetFingerprint = taskDatasetFingerprint("uploaded", tasks);
    const routedTasks = tasks.filter((task) => task.source && task.target).length;
    const localTasks = tasks.filter((task) => task.node_id && !(task.source && task.target)).length;
    const startSlices = tasks.map((task) => task.start_slice);
    const endSlices = tasks.map((task) => task.start_slice + Math.max(1, task.duration_slices) - 1);
    const totalTrafficMbps = tasks.reduce((total, task) => total + (task.traffic_mbps ?? 0), 0);
    const totalComputeUnits = tasks.reduce((total, task) => total + task.compute_units, 0);
    const totalMemoryGb = tasks.reduce((total, task) => total + (task.memory_gb ?? 0), 0);
    const totalStorageGb = tasks.reduce((total, task) => total + (task.storage_gb ?? 0), 0);

    return {
      fileName,
      datasetSchema: "schemas/task-dataset-file.schema.json",
      taskSchema: "schemas/task-dataset.schema.json",
      datasetFingerprint,
      simulationSlices: runtimeConfig.time.slices,
      tleSnapshot: tleCatalogSnapshot
        ? {
            source: tleCatalogSnapshot.source,
            group: tleCatalogSnapshot.group,
            fingerprint: tleCatalogSnapshot.fingerprint,
            selected_count: tleCatalogSnapshot.selected_count,
            planes: tleCatalogSnapshot.layout.planes,
            satellites_per_plane: tleCatalogSnapshot.layout.satellites_per_plane,
          }
        : null,
      accepted: validation.accepted,
      warnings: validation.warnings,
      errors: validation.errors,
      summary: {
        routedTasks,
        localTasks,
        totalTrafficMbps,
        totalComputeUnits,
        totalMemoryGb,
        totalStorageGb,
        firstActiveSlice: startSlices.length > 0 ? Math.min(...startSlices) : null,
        lastActiveSlice: endSlices.length > 0 ? Math.max(...endSlices) : null,
      },
    };
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "dataset-validation.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = `.tmp/dataset-validation-${process.pid}-${Date.now()}.mjs`;
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { validateDataset } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

const validation = validateDataset(taskText, taskFileName, tleSnapshotText);

if (jsonOnly) {
  console.log(JSON.stringify(validation, null, 2));
} else {
  console.log(`Dataset: ${validation.fileName}`);
  console.log(`Dataset schema: ${validation.datasetSchema}`);
  console.log(`Task schema: ${validation.taskSchema}`);
  console.log(`Dataset fingerprint: ${validation.datasetFingerprint}`);
  console.log(`Accepted tasks: ${validation.accepted}`);
  console.log(`Warnings: ${validation.warnings.length}`);
  console.log(`Errors: ${validation.errors.length}`);
  console.log(`Routed tasks: ${validation.summary.routedTasks}`);
  console.log(`Local tasks: ${validation.summary.localTasks}`);
  console.log(`Total traffic Mbps: ${validation.summary.totalTrafficMbps}`);
  console.log(`Total compute units: ${validation.summary.totalComputeUnits}`);
  if (validation.warnings.length > 0) {
    console.log("\nWarnings:");
    validation.warnings.forEach((warning) => console.log(`- ${warning}`));
  }
  if (validation.errors.length > 0) {
    console.log("\nErrors:");
    validation.errors.forEach((error) => console.log(`- ${error}`));
  }
}

if (validation.errors.length > 0) {
  process.exit(1);
}
