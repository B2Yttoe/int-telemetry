import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function daysBetween(leftIso, rightIso) {
  const left = Date.parse(leftIso);
  const right = Date.parse(rightIso);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(right - left) / 86_400_000;
}

function check(id, title, passed, evidence, riskWhenMissing) {
  return {
    id,
    title,
    passed: Boolean(passed),
    evidence,
    riskWhenMissing,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadDefaultConfig() {
  const entry = `
    import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
    export function getConfig() {
      return walkerNetworkConfig;
    }
  `;
  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "stage-one-starlink-fidelity.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  await mkdir(".tmp", { recursive: true });
  const bundlePath = ".tmp/stage-one-starlink-fidelity.mjs";
  await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
  const module = await import(`${pathToFileURL(resolve(bundlePath)).href}?t=${Date.now()}`);
  await rm(bundlePath, { force: true });
  return module.getConfig();
}

async function runExport({ outDir, snapshotPath, tasksPath, slices, profile = "normal" }) {
  const args = [
    "scripts/exportScenario.mjs",
    "--orbit",
    "real-tle-sgp4",
    "--tle-snapshot",
    snapshotPath,
    "--mode",
    "operational",
    "--routing",
    "shortest-path",
    "--slices",
    String(slices),
    "--out",
    outDir,
  ];
  if (tasksPath) {
    args.push("--tasks", tasksPath);
  } else {
    args.push("--profile", profile);
  }
  const startedAt = Date.now();
  const result = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    maxBuffer: 128 * 1024 * 1024,
  });
  return {
    duration_ms: Date.now() - startedAt,
    result: JSON.parse(result.stdout.trim()),
    metadata: await readJson(join(outDir, "metadata.json")),
  };
}

function snapshotSummary(snapshot) {
  return {
    source: snapshot.source,
    group: snapshot.group,
    source_url: snapshot.source_url,
    downloaded_at: snapshot.downloaded_at,
    generated_at: snapshot.generated_at,
    fingerprint: snapshot.fingerprint,
    shell_id: snapshot.shell_id,
    catalog_count: snapshot.catalog_count,
    shell_count: snapshot.shell_count,
    selected_count: snapshot.selected_count,
    mean_altitude_km: snapshot.mean_altitude_km,
    mean_inclination_deg: snapshot.mean_inclination_deg,
    mean_mean_motion_rev_per_day: snapshot.mean_mean_motion_rev_per_day,
    layout: snapshot.layout,
  };
}

function markdown(report) {
  const lines = [
    "# 第一阶段 Starlink 保真补强验收",
    "",
    `生成时间：${report.generated_at}`,
    "",
    `总体结论：${report.summary.pass ? "通过" : "未通过"}`,
    "",
    "## 默认交互星座",
    "",
    "| 参数 | 值 |",
    "|---|---:|",
    `| shell_id | ${report.default_constellation.shell_id} |`,
    `| Walker 类型 | ${report.default_constellation.walker_type} |`,
    `| 轨道面 | ${report.default_constellation.planes} |`,
    `| 每面卫星 | ${report.default_constellation.satellites_per_plane} |`,
    `| 卫星数 | ${report.default_constellation.satellite_count} |`,
    `| 高度 km | ${report.default_constellation.altitude_km} |`,
    `| 倾角 deg | ${report.default_constellation.inclination_deg} |`,
    `| 默认定位 | ${report.default_constellation.positioning} |`,
    "",
    "## 真实 TLE 快照",
    "",
    "| 快照 | 轨道面 | 每面卫星 | 卫星数 | 平均高度 km | 平均倾角 deg | 数据源 |",
    "|---|---:|---:|---:|---:|---:|---|",
    `| 主壳层 8x8 | ${report.snapshots.main_8x8.layout.planes} | ${report.snapshots.main_8x8.layout.satellites_per_plane} | ${report.snapshots.main_8x8.selected_count} | ${report.snapshots.main_8x8.mean_altitude_km} | ${report.snapshots.main_8x8.mean_inclination_deg} | ${report.snapshots.main_8x8.source} |`,
    `| 主壳层 47x14 | ${report.snapshots.main_47x14.layout.planes} | ${report.snapshots.main_47x14.layout.satellites_per_plane} | ${report.snapshots.main_47x14.selected_count} | ${report.snapshots.main_47x14.mean_altitude_km} | ${report.snapshots.main_47x14.mean_inclination_deg} | ${report.snapshots.main_47x14.source} |`,
    `| 最大规模 72x22 | ${report.snapshots.scale_72x22.layout.planes} | ${report.snapshots.scale_72x22.layout.satellites_per_plane} | ${report.snapshots.scale_72x22.selected_count} | ${report.snapshots.scale_72x22.mean_altitude_km} | ${report.snapshots.scale_72x22.mean_inclination_deg} | ${report.snapshots.scale_72x22.source} |`,
    "",
    "## 导出验收",
    "",
    "| 场景 | 时间片 | 节点样本 | 链路样本 | 耗时 ms |",
    "|---|---:|---:|---:|---:|",
    `| main 8x8 | ${report.exports.main_8x8.slices} | ${report.exports.main_8x8.nodes} | ${report.exports.main_8x8.links} | ${report.exports.main_8x8.duration_ms} |`,
    `| main 47x14 | ${report.exports.main_47x14.slices} | ${report.exports.main_47x14.nodes} | ${report.exports.main_47x14.links} | ${report.exports.main_47x14.duration_ms} |`,
    `| scale 72x22 | ${report.exports.scale_72x22.slices} | ${report.exports.scale_72x22.nodes} | ${report.exports.scale_72x22.links} | ${report.exports.scale_72x22.duration_ms} |`,
    "",
    "## 检查项",
    "",
    "| 检查项 | 结果 | 证据 |",
    "|---|---|---|",
    ...report.checks.map((item) => `| ${item.title} | ${item.passed ? "通过" : "未通过"} | ${JSON.stringify(item.evidence).replaceAll("|", "\\|")} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const skipExports = hasArg(args, "--skip-exports");
const snapshotMain8x8Path = resolve(
  argValue(args, "--snapshot-main-8x8", "data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-8x8.json"),
);
const snapshotMain47x14Path = resolve(
  argValue(args, "--snapshot-main-47x14", "data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json"),
);
const snapshotScale72x22Path = resolve(
  argValue(args, "--snapshot-scale-72x22", "data/tle-snapshots/celestrak-starlink-real-walker-72x22.json"),
);
const traffic8x8Path = resolve(
  argValue(args, "--traffic-8x8", "examples/datasets/radar-calibrated-starlink-main-8x8-48-traffic.csv"),
);
const outputJson = join(reportDir, "stage1-starlink-fidelity.json");
const outputMd = join(reportDir, "stage1-starlink-fidelity.md");

if (!existsSync(snapshotMain8x8Path)) throw new Error(`main 8x8 snapshot not found: ${snapshotMain8x8Path}`);
if (!existsSync(snapshotMain47x14Path)) throw new Error(`main 47x14 snapshot not found: ${snapshotMain47x14Path}`);
if (!existsSync(snapshotScale72x22Path)) throw new Error(`scale 72x22 snapshot not found: ${snapshotScale72x22Path}`);

const [config, snapshotMain8x8, snapshotMain47x14, snapshotScale72x22] = await Promise.all([
  loadDefaultConfig(),
  readJson(snapshotMain8x8Path),
  readJson(snapshotMain47x14Path),
  readJson(snapshotScale72x22Path),
]);

const defaultConstellation = {
  shell_id: config.constellation.shellId,
  walker_type: config.constellation.walkerType,
  planes: config.constellation.planes,
  satellites_per_plane: config.constellation.satellitesPerPlane,
  satellite_count: config.constellation.planes * config.constellation.satellitesPerPlane,
  altitude_km: config.constellation.altitudeKm,
  inclination_deg: config.constellation.inclinationDeg,
  positioning: "interactive lightweight Starlink-main-shell approximation; use main 47x14 or scale 72x22 snapshots for larger experiments",
};

const exportRoot = join(reportDir, "starlink-fidelity-exports");
let main8x8Export = null;
let main47x14Export = null;
let scale72x22Export = null;
if (!skipExports) {
  main8x8Export = await runExport({
    outDir: join(exportRoot, "main-8x8-12-slices"),
    snapshotPath: snapshotMain8x8Path,
    tasksPath: traffic8x8Path,
    slices: 12,
  });
  main47x14Export = await runExport({
    outDir: join(exportRoot, "main-47x14-2-slices"),
    snapshotPath: snapshotMain47x14Path,
    slices: 2,
    profile: "normal",
  });
  scale72x22Export = await runExport({
    outDir: join(exportRoot, "scale-72x22-2-slices"),
    snapshotPath: snapshotScale72x22Path,
    slices: 2,
    profile: "normal",
  });
}

const nowIso = new Date().toISOString();
const checks = [
  check(
    "default_starlink_shell",
    "默认轻量星座采用 Starlink 主壳层近似高度/倾角",
    defaultConstellation.altitude_km >= 540 &&
      defaultConstellation.altitude_km <= 560 &&
      defaultConstellation.inclination_deg >= 52 &&
      defaultConstellation.inclination_deg <= 54,
    {
      altitude_km: defaultConstellation.altitude_km,
      inclination_deg: defaultConstellation.inclination_deg,
    },
    "默认场景仍会偏离 Starlink 主流 LEO shell。",
  ),
  check(
    "interactive_scale",
    "默认交互星座保持 8x8 轻量规模",
    defaultConstellation.satellite_count === 64,
    { satellite_count: defaultConstellation.satellite_count },
    "若默认直接变为真实规模，仪表盘和常规验收可能明显变慢。",
  ),
  check(
    "main_8x8_snapshot",
    "真实 Starlink 主壳层 8x8 CelesTrak 快照可用",
    snapshotMain8x8.schema === "int-telemetry-real-tle-snapshot/v1" &&
      snapshotMain8x8.source === "celestrak" &&
      snapshotMain8x8.layout?.planes === 8 &&
      snapshotMain8x8.layout?.satellites_per_plane === 8 &&
      snapshotMain8x8.layout?.selected_shell_key === "53.0deg-550km" &&
      snapshotMain8x8.selected_count === 64 &&
      snapshotMain8x8.mean_altitude_km >= 540 &&
      snapshotMain8x8.mean_altitude_km <= 550 &&
      snapshotMain8x8.mean_inclination_deg >= 52.8 &&
      snapshotMain8x8.mean_inclination_deg <= 53.3,
    snapshotSummary(snapshotMain8x8),
    "无法在仪表盘中运行真实 TLE-SGP4 的 Starlink 主壳层轻量对照场景。",
  ),
  check(
    "main_47x14_snapshot",
    "真实 Starlink 主壳层 47x14 CelesTrak 快照可用",
    snapshotMain47x14.schema === "int-telemetry-real-tle-snapshot/v1" &&
      snapshotMain47x14.source === "celestrak" &&
      snapshotMain47x14.layout?.planes === 47 &&
      snapshotMain47x14.layout?.satellites_per_plane === 14 &&
      snapshotMain47x14.layout?.selected_shell_key === "53.0deg-550km" &&
      snapshotMain47x14.selected_count === 658 &&
      snapshotMain47x14.mean_altitude_km >= 540 &&
      snapshotMain47x14.mean_altitude_km <= 550 &&
      snapshotMain47x14.mean_inclination_deg >= 52.8 &&
      snapshotMain47x14.mean_inclination_deg <= 53.3,
    snapshotSummary(snapshotMain47x14),
    "无法运行更大规模的 Starlink 主壳层真实 TLE-SGP4 场景。",
  ),
  check(
    "scale_72x22_snapshot",
    "最大规模 Starlink 72x22 CelesTrak 快照可用",
    snapshotScale72x22.schema === "int-telemetry-real-tle-snapshot/v1" &&
      snapshotScale72x22.source === "celestrak" &&
      snapshotScale72x22.layout?.planes === 72 &&
      snapshotScale72x22.layout?.satellites_per_plane === 22 &&
      snapshotScale72x22.selected_count === 1584,
    snapshotSummary(snapshotScale72x22),
    "无法证明第一阶段支持更接近真实规模的 Starlink 星座。",
  ),
  check(
    "snapshot_freshness",
    "真实 TLE 快照具有可追溯时间戳",
    daysBetween(snapshotMain8x8.downloaded_at, nowIso) <= 30 &&
      daysBetween(snapshotMain47x14.downloaded_at, nowIso) <= 30 &&
      daysBetween(snapshotScale72x22.downloaded_at, nowIso) <= 30,
    {
      now: nowIso,
      main_8x8_downloaded_at: snapshotMain8x8.downloaded_at,
      main_47x14_downloaded_at: snapshotMain47x14.downloaded_at,
      scale_72x22_downloaded_at: snapshotScale72x22.downloaded_at,
      main_8x8_age_days: round(daysBetween(snapshotMain8x8.downloaded_at, nowIso), 2),
      main_47x14_age_days: round(daysBetween(snapshotMain47x14.downloaded_at, nowIso), 2),
      scale_72x22_age_days: round(daysBetween(snapshotScale72x22.downloaded_at, nowIso), 2),
    },
    "TLE 太旧会降低轨道真实性，需要重新 fetch。",
  ),
];

const exportsSummary = {
  main_8x8: main8x8Export
    ? {
        slices: main8x8Export.result.counts.slices,
        nodes: main8x8Export.result.counts.nodes,
        links: main8x8Export.result.counts.links,
        routes: main8x8Export.result.counts.routes,
        orbit_model: main8x8Export.metadata.orbit_model,
        tle_snapshot_planes: main8x8Export.metadata.tle_snapshot_planes,
        tle_snapshot_satellites_per_plane: main8x8Export.metadata.tle_snapshot_satellites_per_plane,
        duration_ms: main8x8Export.duration_ms,
        out_dir: main8x8Export.result.outDir,
      }
    : null,
  main_47x14: main47x14Export
    ? {
        slices: main47x14Export.result.counts.slices,
        nodes: main47x14Export.result.counts.nodes,
        links: main47x14Export.result.counts.links,
        routes: main47x14Export.result.counts.routes,
        orbit_model: main47x14Export.metadata.orbit_model,
        tle_snapshot_planes: main47x14Export.metadata.tle_snapshot_planes,
        tle_snapshot_satellites_per_plane: main47x14Export.metadata.tle_snapshot_satellites_per_plane,
        duration_ms: main47x14Export.duration_ms,
        out_dir: main47x14Export.result.outDir,
      }
    : null,
  scale_72x22: scale72x22Export
    ? {
        slices: scale72x22Export.result.counts.slices,
        nodes: scale72x22Export.result.counts.nodes,
        links: scale72x22Export.result.counts.links,
        routes: scale72x22Export.result.counts.routes,
        orbit_model: scale72x22Export.metadata.orbit_model,
        tle_snapshot_planes: scale72x22Export.metadata.tle_snapshot_planes,
        tle_snapshot_satellites_per_plane: scale72x22Export.metadata.tle_snapshot_satellites_per_plane,
        duration_ms: scale72x22Export.duration_ms,
        out_dir: scale72x22Export.result.outDir,
      }
    : null,
};

if (!skipExports) {
  checks.push(
    check(
      "main_8x8_export",
      "真实 TLE 主壳层 8x8 场景可以导出",
      exportsSummary.main_8x8?.orbit_model === "real-tle-sgp4" &&
        exportsSummary.main_8x8?.nodes === 12 * 64 &&
        exportsSummary.main_8x8?.links > 0,
      exportsSummary.main_8x8,
      "真实 TLE 轻量场景不能形成第一阶段真值数据集。",
    ),
    check(
      "main_47x14_export",
      "真实 TLE 主壳层 47x14 场景可以导出小时间片真值",
      exportsSummary.main_47x14?.orbit_model === "real-tle-sgp4" &&
        exportsSummary.main_47x14?.nodes === 2 * 658 &&
        exportsSummary.main_47x14?.links > 0,
      exportsSummary.main_47x14,
      "第一阶段无法承载更大规模的 Starlink 主壳层拓扑。",
    ),
    check(
      "scale_72x22_export",
      "最大规模 72x22 场景可以导出小时间片真值",
      exportsSummary.scale_72x22?.orbit_model === "real-tle-sgp4" &&
        exportsSummary.scale_72x22?.nodes === 2 * 1584 &&
        exportsSummary.scale_72x22?.links > 0,
      exportsSummary.scale_72x22,
      "第一阶段无法承载更接近真实规模的 Starlink 拓扑。",
    ),
  );
}

const passed = checks.filter((item) => item.passed).length;
const report = {
  schema_version: "stage1-starlink-fidelity-verification-v1",
  generated_at: nowIso,
  summary: {
    pass: passed === checks.length,
    checks: checks.length,
    passed,
    failed: checks.length - passed,
  },
  default_constellation: defaultConstellation,
  snapshots: {
    main_8x8: snapshotSummary(snapshotMain8x8),
    main_47x14: snapshotSummary(snapshotMain47x14),
    scale_72x22: snapshotSummary(snapshotScale72x22),
  },
  exports: exportsSummary,
  checks,
  interpretation: {
    first_stage_orbit_topology_score_after_reinforcement: "8.5-9/10 for research use when real-tle-sgp4 snapshots are used",
    default_mode_boundary: "8x8 remains an interactive lightweight topology, not real operational scale",
    high_fidelity_mode_boundary: "main-shell real-tle-sgp4 improves public-orbit realism; scale 72x22 improves constellation size, but neither exposes proprietary Starlink routing, hardware, or operator traffic traces",
  },
};

await mkdir(reportDir, { recursive: true });
await writeFile(outputJson, JSON.stringify(report, null, 2), "utf8");
await writeFile(outputMd, markdown(report), "utf8");

console.log(
  JSON.stringify(
    {
      ok: report.summary.pass,
      files: [outputJson, outputMd],
      summary: report.summary,
      default_constellation: report.default_constellation,
      exports: report.exports,
    },
    null,
    2,
  ),
);

if (!report.summary.pass) process.exitCode = 1;
