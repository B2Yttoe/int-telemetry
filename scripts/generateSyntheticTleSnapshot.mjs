import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function loadSnapshotTools() {
  const entry = `
    import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
    import { generateSyntheticWalkerTleCatalog } from "./src/simulation/tle.ts";
    import { verifyRealTleSnapshot } from "./src/simulation/realTleCatalog.ts";
    export { walkerNetworkConfig, generateSyntheticWalkerTleCatalog, verifyRealTleSnapshot };
  `;

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "generate-synthetic-tle-snapshot.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });

  await mkdir(".tmp", { recursive: true });
  const bundlePath = ".tmp/generate-synthetic-tle-snapshot.mjs";
  await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
  const mod = await import(`${pathToFileURL(resolve(bundlePath)).href}?t=${Date.now()}`);
  await rm(bundlePath, { force: true });
  return mod;
}

const args = process.argv.slice(2);
const planes = Number(argValue(args, "--planes", "27"));
const satellitesPerPlane = Number(argValue(args, "--satellites-per-plane", "13"));
const altitudeKm = Number(argValue(args, "--altitude", "1015"));
const inclinationDeg = Number(argValue(args, "--inclination", "98.98"));
const shellId = argValue(args, "--shell-id", "synthetic-walker-1015km-98deg");
const group = argValue(args, "--group", "SYNTHETIC-WALKER");
const satelliteNamePrefix = argValue(args, "--satellite-name-prefix", "WALKER-SAT");
const source = argValue(args, "--source", "synthetic-walker");
const sourceUrl = argValue(args, "--source-url", "https://github.com/snkas/hypatia");
const noradBaseId = Number(argValue(args, "--norad-base-id", "97000"));
const cosparLaunchNumber = Number(argValue(args, "--cospar-launch-number", "97"));
const outPath = resolve(
  argValue(args, "--out", `data/tle-snapshots/synthetic-${group.toLowerCase()}-walker-${planes}x${satellitesPerPlane}.json`),
);

if (!Number.isFinite(planes) || planes <= 0) fail("--planes must be a positive number");
if (!Number.isFinite(satellitesPerPlane) || satellitesPerPlane <= 0) {
  fail("--satellites-per-plane must be a positive number");
}
if (!Number.isFinite(altitudeKm) || altitudeKm <= 0) fail("--altitude must be a positive number");
if (!Number.isFinite(inclinationDeg) || inclinationDeg <= 0) fail("--inclination must be a positive number");
if (!Number.isFinite(noradBaseId) || noradBaseId <= 0) fail("--norad-base-id must be a positive number");
if (!Number.isFinite(cosparLaunchNumber) || cosparLaunchNumber <= 0) {
  fail("--cospar-launch-number must be a positive number");
}

const { walkerNetworkConfig, generateSyntheticWalkerTleCatalog, verifyRealTleSnapshot } = await loadSnapshotTools();
const generatedAt = new Date().toISOString();
const config = {
  ...walkerNetworkConfig,
  constellation: {
    ...walkerNetworkConfig.constellation,
    walkerType: "star",
    shellId,
    planes,
    satellitesPerPlane,
    altitudeKm,
    inclinationDeg,
  },
  orbit: {
    ...walkerNetworkConfig.orbit,
    model: "tle-sgp4",
    tleCatalog: {
      ...walkerNetworkConfig.orbit.tleCatalog,
      source,
      noradBaseId,
      satelliteNamePrefix,
      cosparLaunchNumber,
      eccentricity: 0.0002,
      bstar: 0.00001,
    },
  },
};

const satellites = generateSyntheticWalkerTleCatalog(config).map((record) => ({
  ...record,
  source,
  source_url: sourceUrl,
}));
const snapshotFingerprint = fingerprint({
  source,
  group,
  generated_at: generatedAt,
  shell_id: shellId,
  layout: [planes, satellitesPerPlane],
  satellites: satellites.map((record) => ({
    norad_id: record.norad_id,
    plane_id: record.plane_id,
    slot_id: record.slot_id,
    tle_line1: record.tle_line1,
    tle_line2: record.tle_line2,
  })),
});
const catalog = satellites.map((record) => ({
  ...record,
  catalog_fingerprint: snapshotFingerprint,
}));

const snapshot = {
  schema: "int-telemetry-real-tle-snapshot/v1",
  source,
  group,
  format: "tle",
  source_url: sourceUrl,
  downloaded_at: generatedAt,
  generated_at: generatedAt,
  fingerprint: snapshotFingerprint,
  shell_id: shellId,
  catalog_count: catalog.length,
  shell_count: catalog.length,
  selected_count: catalog.length,
  mean_altitude_km: round(altitudeKm, 2),
  mean_inclination_deg: round(inclinationDeg, 4),
  mean_mean_motion_rev_per_day: round(catalog.reduce((sum, record) => sum + record.mean_motion, 0) / catalog.length, 8),
  layout: {
    planes,
    satellites_per_plane: satellitesPerPlane,
    selection_strategy: "public-shell-design-synthetic-walker-tle",
    raan_cluster_threshold_deg: 180 / planes,
    target_inclination_deg: inclinationDeg,
    target_altitude_km: altitudeKm,
    selected_shell_key: `${inclinationDeg.toFixed(1)}deg-${Math.round(altitudeKm)}km`,
    target_shell_distance: 0,
  },
  satellites: catalog,
};

const verification = verifyRealTleSnapshot(snapshot);
if (!verification.ok) fail(`Generated snapshot is invalid:\n${verification.errors.join("\n")}`);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      out: outPath,
      group,
      shell_id: shellId,
      selected_count: snapshot.selected_count,
      layout: snapshot.layout,
      mean_altitude_km: snapshot.mean_altitude_km,
      mean_inclination_deg: snapshot.mean_inclination_deg,
      mean_mean_motion_rev_per_day: snapshot.mean_mean_motion_rev_per_day,
      fingerprint: snapshot.fingerprint,
    },
    null,
    2,
  ),
);
