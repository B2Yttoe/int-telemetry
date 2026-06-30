import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profiles = ["empty", "low-load", "normal", "high-load", "hotspot", "burst", "long-duration"];
const headers = [
  "task_id",
  "time",
  "start_slice",
  "duration_slices",
  "source",
  "target",
  "node_id",
  "compute_units",
  "gpu_units",
  "memory_gb",
  "storage_gb",
  "traffic_mbps",
  "priority",
  "task_type",
];

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tasksToCsv(tasks) {
  const lines = [
    headers.join(","),
    ...tasks.map((task) =>
      headers
        .map((header) => {
          if (header === "time") return csvEscape(task.time ?? `T${String(task.start_slice).padStart(2, "0")}`);
          if (header === "node_id") return csvEscape(task.node_id ?? "");
          if (header === "gpu_units") return csvEscape(task.gpu_units ?? 0);
          return csvEscape(task[header] ?? "");
        })
        .join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function tasksToJsonDataset(profile, tasks) {
  return `${JSON.stringify(
    {
      dataset_id: `stage1-${profile}`,
      schema_version: "stage1-task-dataset-file-v1",
      profile,
      tasks,
    },
    null,
    2,
  )}\n`;
}

const args = process.argv.slice(2);
const outDir = resolve(argValue(args, "--out", "examples/datasets/templates"));

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { taskDatasetFingerprint } from "./src/simulation/export.ts";
  import { scenarioTrafficTasks, validateTaskDataset } from "./src/simulation/traffic.ts";

  export function createTemplates(profiles) {
    return profiles.map((profile) => {
      const tasks = profile === "empty" ? [] : scenarioTrafficTasks(walkerNetworkConfig, profile);
      const validation = validateTaskDataset(tasks, walkerNetworkConfig);
      const datasetFingerprint = taskDatasetFingerprint(profile, tasks);
      return {
        profile,
        tasks,
        validation,
        datasetFingerprint,
        totals: {
          tasks: tasks.length,
          trafficMbps: tasks.reduce((total, task) => total + (task.traffic_mbps ?? 0), 0),
          computeUnits: tasks.reduce((total, task) => total + task.compute_units, 0),
          memoryGb: tasks.reduce((total, task) => total + (task.memory_gb ?? 0), 0),
          storageGb: tasks.reduce((total, task) => total + (task.storage_gb ?? 0), 0),
        },
      };
    });
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "dataset-template-export.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = ".tmp/dataset-template-export.mjs";
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { createTemplates } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

await mkdir(outDir, { recursive: true });
const templates = createTemplates(profiles);
const files = [];

for (const template of templates) {
  const csvFileName = `${template.profile}.csv`;
  const jsonFileName = `${template.profile}.json`;
  await writeFile(resolve(outDir, csvFileName), tasksToCsv(template.tasks), "utf8");
  await writeFile(resolve(outDir, jsonFileName), tasksToJsonDataset(template.profile, template.tasks), "utf8");
  files.push(csvFileName, jsonFileName);
}

await writeFile(
  resolve(outDir, "manifest.json"),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      dataset_schema: "schemas/task-dataset-file.schema.json",
      task_schema: "schemas/task-dataset.schema.json",
      csv_header: headers,
      profiles: templates.map((template) => ({
        profile: template.profile,
        file: `${template.profile}.csv`,
        csv_file: `${template.profile}.csv`,
        json_file: `${template.profile}.json`,
        dataset_fingerprint: template.datasetFingerprint,
        validation: template.validation,
        totals: template.totals,
      })),
    },
    null,
    2,
  ),
  "utf8",
);

console.log(
  JSON.stringify(
    {
      outDir,
      files: [...files, "manifest.json"],
      profiles: templates.map((template) => ({
        profile: template.profile,
        accepted: template.validation.accepted,
        warnings: template.validation.warnings.length,
        errors: template.validation.errors.length,
        trafficMbps: template.totals.trafficMbps,
        computeUnits: template.totals.computeUnits,
      })),
    },
    null,
    2,
  ),
);

if (templates.some((template) => template.validation.errors.length > 0)) {
  process.exitCode = 1;
}
