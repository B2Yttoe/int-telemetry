import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

function argValue(args, name, fallback = "") {
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

function runNode(args, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        label,
        command: `node ${args.join(" ")}`,
        code,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      };
      if (code !== 0) {
        reject(new Error(`${label} failed with code ${code}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function parseLastJson(stdout, label) {
  const text = stdout.trim();
  if (!text) throw new Error(`${label} produced no stdout`);
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(text.slice(starts[index]));
    } catch {
      // Try the previous JSON-looking segment.
    }
  }
  throw new Error(`${label} did not contain parseable JSON`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function rel(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function markdown(manifest) {
  const lines = [
    "# 第一阶段真实化数据集生成清单",
    "",
    `生成时间：${manifest.generated_at}`,
    "",
    "## 输入",
    "",
    `- TLE 快照：${manifest.inputs.tle_snapshot.path}`,
    `- 壳层：${manifest.inputs.tle_snapshot.shell_id}`,
    `- 卫星数：${manifest.inputs.tle_snapshot.selected_count}`,
    `- 均值高度/倾角：${manifest.inputs.tle_snapshot.mean_altitude_km} km / ${manifest.inputs.tle_snapshot.mean_inclination_deg} deg`,
    `- 业务校准 profile：${manifest.inputs.traffic_calibration.path}`,
    `- 业务数据模式：${manifest.inputs.traffic_calibration.data_mode}`,
    "",
    "## 输出",
    "",
    `- 业务 CSV：${manifest.outputs.traffic_csv}`,
    `- 业务元数据：${manifest.outputs.traffic_metadata_json}`,
    `- 第一阶段真值目录：${manifest.outputs.truth_dir}`,
    `- 节点真值：${manifest.outputs.nodes_csv}`,
    `- 链路真值：${manifest.outputs.links_csv}`,
    `- 路由真值：${manifest.outputs.routes_csv}`,
    `- 任务性能追踪：${manifest.outputs.task_traces_csv}`,
    `- 指标真值：${manifest.outputs.metrics_csv}`,
    "",
    "## 数据规模",
    "",
    "| 项 | 值 |",
    "|---|---:|",
    `| 时间片 | ${manifest.truth.counts.slices} |`,
    `| 节点样本 | ${manifest.truth.counts.nodes} |`,
    `| 链路样本 | ${manifest.truth.counts.links} |`,
    `| 路由样本 | ${manifest.truth.counts.routes} |`,
    `| 业务任务 | ${manifest.traffic.rows} |`,
    "",
    "## 真实性边界",
    "",
    ...manifest.boundaries.map((item) => `- ${item}`),
    "",
    "## 复现实验命令",
    "",
    "```bash",
    ...manifest.commands.map((item) => item.command),
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const snapshotPath = resolve(
  argValue(args, "--snapshot", "data/tle-snapshots/celestrak-starlink-real-walker-72x22.json"),
);
const calibrationProfilePath = resolve(
  argValue(args, "--calibration-profile", "traffic-calibration/cloudflare-radar-profile.json"),
);
const slices = Number(argValue(args, "--slices", "48"));
const outRoot = resolve(argValue(args, "--out", "exports/stage1-realistic-72x22-48"));
const trafficCsvPath = resolve(argValue(args, "--traffic-out", join(outRoot, "traffic", "tasks.csv")));
const trafficMetadataPath = resolve(
  argValue(args, "--traffic-metadata-out", join(outRoot, "traffic", "metadata.json")),
);
const truthOutDir = resolve(argValue(args, "--truth-out", join(outRoot, "truth")));
const manifestJsonPath = resolve(argValue(args, "--manifest", join(outRoot, "stage1-realistic-dataset-manifest.json")));
const manifestMdPath = resolve(argValue(args, "--manifest-md", join(outRoot, "stage1-realistic-dataset-manifest.md")));
const includeFullJson = hasArg(args, "--full-json");

if (!Number.isFinite(slices) || slices < 1) fail("--slices must be a positive number");
if (!existsSync(snapshotPath)) fail(`TLE snapshot not found: ${snapshotPath}`);
if (!existsSync(calibrationProfilePath)) fail(`Calibration profile not found: ${calibrationProfilePath}`);

await mkdir(dirname(trafficCsvPath), { recursive: true });
await mkdir(truthOutDir, { recursive: true });
await mkdir(dirname(manifestJsonPath), { recursive: true });
await mkdir(dirname(manifestMdPath), { recursive: true });

const trafficRun = await runNode(
  [
    "scripts/generateRadarCalibratedTraffic.mjs",
    "--snapshot",
    snapshotPath,
    "--profile",
    calibrationProfilePath,
    "--slices",
    String(slices),
    "--out",
    trafficCsvPath,
    "--metadata-out",
    trafficMetadataPath,
  ],
  "generate calibrated traffic",
);

const exportArgs = [
  "scripts/exportScenario.mjs",
  "--tasks",
  trafficCsvPath,
  "--orbit",
  "real-tle-sgp4",
  "--tle-snapshot",
  snapshotPath,
  "--mode",
  "operational",
  "--routing",
  "congestion-aware-shortest-path",
  "--slices",
  String(slices),
  "--out",
  truthOutDir,
];
if (includeFullJson) exportArgs.push("--full-json");
const truthRun = await runNode(exportArgs, "export stage-one truth");

const snapshot = await readJson(snapshotPath);
const calibrationProfile = await readJson(calibrationProfilePath);
const trafficMetadata = await readJson(trafficMetadataPath);
const truthMetadata = await readJson(join(truthOutDir, "metadata.json"));
const trafficResult = parseLastJson(trafficRun.stdout, trafficRun.label);
const truthResult = parseLastJson(truthRun.stdout, truthRun.label);

const manifest = {
  schema: "int-telemetry-stage1-realistic-dataset-manifest/v1",
  generated_at: new Date().toISOString(),
  purpose: "Generate first-stage node/link/route truth data from public Starlink TLE snapshots and calibrated task traffic for INT replay and ML prediction experiments.",
  inputs: {
    tle_snapshot: {
      path: rel(snapshotPath),
      source: snapshot.source,
      source_url: snapshot.source_url,
      downloaded_at: snapshot.downloaded_at,
      fingerprint: snapshot.fingerprint,
      shell_id: snapshot.shell_id,
      selected_count: snapshot.selected_count,
      mean_altitude_km: snapshot.mean_altitude_km,
      mean_inclination_deg: snapshot.mean_inclination_deg,
      layout: snapshot.layout,
    },
    traffic_calibration: {
      path: rel(calibrationProfilePath),
      profile_id: calibrationProfile.profile_id,
      data_mode: calibrationProfile.data_mode,
      not_raw_cloudflare_export: Boolean(calibrationProfile.not_raw_cloudflare_export),
      source_references: calibrationProfile.source_references,
    },
  },
  traffic: {
    rows: trafficMetadata.output.rows,
    routed_tasks: trafficMetadata.output.routed_tasks,
    local_tasks: trafficMetadata.output.local_tasks,
    total_traffic_mbps: trafficMetadata.output.total_traffic_mbps,
    total_compute_units: trafficMetadata.output.total_compute_units,
    min_time_weight: trafficMetadata.output.min_time_weight,
    max_time_weight: trafficMetadata.output.max_time_weight,
    anomaly_count: trafficMetadata.output.anomaly_count,
  },
  truth: {
    orbit_model: truthMetadata.orbit_model,
    routing_algorithm: truthMetadata.routing_algorithm,
    simulation_mode: truthMetadata.simulation_mode,
    counts: truthResult.counts,
    fingerprints: truthResult.fingerprints,
    validation: truthResult.validation,
  },
  outputs: {
    root: rel(outRoot),
    traffic_csv: rel(trafficCsvPath),
    traffic_metadata_json: rel(trafficMetadataPath),
    truth_dir: rel(truthOutDir),
    truth_metadata_json: rel(join(truthOutDir, "metadata.json")),
    nodes_csv: rel(join(truthOutDir, "nodes.csv")),
    links_csv: rel(join(truthOutDir, "links.csv")),
    routes_csv: rel(join(truthOutDir, "routes.csv")),
    task_traces_csv: rel(join(truthOutDir, "task-traces.csv")),
    metrics_csv: rel(join(truthOutDir, "metrics.csv")),
    truth_json: includeFullJson ? rel(join(truthOutDir, "truth.json")) : null,
    manifest_json: rel(manifestJsonPath),
    manifest_md: rel(manifestMdPath),
  },
  commands: [
    {
      label: trafficRun.label,
      command: trafficRun.command,
      duration_ms: trafficRun.duration_ms,
    },
    {
      label: truthRun.label,
      command: truthRun.command,
      duration_ms: truthRun.duration_ms,
    },
  ],
  boundaries: [
    "TLE comes from public CelesTrak GP/OMM-style data and is propagated by SGP4; it is not proprietary operator ephemeris.",
    "Traffic is generated from a deterministic Cloudflare Radar-inspired calibration profile; it is not raw operator traffic trace.",
    "Link budget and node resource formulas are network-level research abstractions, not hardware-grade RF or thermal simulation.",
    "The output is first-stage omniscient truth for model validation, INT replay, and ML labels; it is not what a deployed INT collector directly knows.",
  ],
};

await writeFile(manifestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(manifestMdPath, markdown(manifest), "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      manifest: manifest.outputs.manifest_json,
      snapshot: manifest.inputs.tle_snapshot,
      traffic: manifest.traffic,
      truth: manifest.truth,
      outputs: manifest.outputs,
    },
    null,
    2,
  ),
);
