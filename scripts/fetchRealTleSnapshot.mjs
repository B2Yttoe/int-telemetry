import { build } from "esbuild";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function loadRealTleCatalogModule() {
  const entry = `
    import {
      buildRealTleSnapshotFromCelestrakJson,
      verifyRealTleSnapshot,
    } from "./src/simulation/realTleCatalog.ts";

    export { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot };
  `;

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "fetch-real-tle-snapshot.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });

  await mkdir(".tmp", { recursive: true });
  const bundlePath = ".tmp/fetch-real-tle-snapshot.mjs";
  await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
  const mod = await import(`${pathToFileURL(resolve(bundlePath)).href}?t=${Date.now()}`);
  await rm(bundlePath, { force: true });
  return mod;
}

const args = process.argv.slice(2);
const group = argValue(args, "--group", "STARLINK").toUpperCase();
const source = argValue(args, "--source", "celestrak");
const planes = Number(argValue(args, "--planes", "72"));
const satellitesPerPlane = Number(argValue(args, "--satellites-per-plane", "22"));
const targetInclination = argValue(args, "--target-inclination", "");
const targetAltitude = argValue(args, "--target-altitude", "");
const raanThreshold = Number(argValue(args, "--raan-threshold", "2.5"));
const downloadedAt = new Date().toISOString();
const defaultUrl =
  group === "STARLINK"
    ? "https://celestrak.org/NORAD/elements/gp.php?NAME=STARLINK&FORMAT=JSON"
    : `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`;
const sourceUrl = argValue(args, "--url", defaultUrl);
const outPath = resolve(
  argValue(
    args,
    "--out",
    `data/tle-snapshots/celestrak-${group.toLowerCase()}-real-walker-${planes}x${satellitesPerPlane}.json`,
  ),
);
const rawOutPath = resolve(
  argValue(args, "--raw-out", `data/tle-snapshots/celestrak-${group.toLowerCase()}-raw-gp.json`),
);
const useCacheOnly = hasArg(args, "--cache-only");

if (!Number.isFinite(planes) || planes <= 0) fail("--planes must be a positive number");
if (!Number.isFinite(satellitesPerPlane) || satellitesPerPlane <= 0) {
  fail("--satellites-per-plane must be a positive number");
}
if (!Number.isFinite(raanThreshold) || raanThreshold <= 0) fail("--raan-threshold must be a positive number");
if (source !== "celestrak") fail("Only --source celestrak is currently supported");

let rawRecords;
let fetchStatus = "not-requested";
let downloadedFrom = sourceUrl;

if (!useCacheOnly) {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "INT-Temerity/0.1 real-tle-snapshot",
      accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
    },
  });
  const text = await response.text();
  fetchStatus = `${response.status} ${response.statusText}`.trim();

  if (response.ok) {
    rawRecords = JSON.parse(text);
    await mkdir(dirname(rawOutPath), { recursive: true });
    await writeFile(rawOutPath, JSON.stringify(rawRecords, null, 2), "utf8");
  } else if (await exists(rawOutPath)) {
    rawRecords = JSON.parse(await readFile(rawOutPath, "utf8"));
    downloadedFrom = `${rawOutPath} (cache fallback after ${fetchStatus})`;
  } else {
    fail(`Unable to download ${sourceUrl}: ${fetchStatus}\n${text.slice(0, 300)}`);
  }
} else {
  if (!(await exists(rawOutPath))) fail(`--cache-only was set but raw cache does not exist: ${rawOutPath}`);
  rawRecords = JSON.parse(await readFile(rawOutPath, "utf8"));
  fetchStatus = "cache-only";
  downloadedFrom = rawOutPath;
}

if (!Array.isArray(rawRecords)) fail("CelesTrak response/cache is not a JSON array");

const { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot } = await loadRealTleCatalogModule();
const snapshot = buildRealTleSnapshotFromCelestrakJson(rawRecords, {
  source: "celestrak",
  group,
  sourceUrl,
  downloadedAt,
  planes,
  satellitesPerPlane,
  raanClusterThresholdDeg: raanThreshold,
  targetInclinationDeg: targetInclination ? Number(targetInclination) : undefined,
  targetAltitudeKm: targetAltitude ? Number(targetAltitude) : undefined,
});
const verification = verifyRealTleSnapshot(snapshot);
if (!verification.ok) fail(`Generated snapshot is invalid:\n${verification.errors.join("\n")}`);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      source,
      group,
      fetch_status: fetchStatus,
      downloaded_from: downloadedFrom,
      raw_out: rawOutPath,
      out: outPath,
      catalog_count: snapshot.catalog_count,
      shell_count: snapshot.shell_count,
      selected_count: snapshot.selected_count,
      layout: snapshot.layout,
      mean_altitude_km: snapshot.mean_altitude_km,
      mean_inclination_deg: snapshot.mean_inclination_deg,
      fingerprint: snapshot.fingerprint,
    },
    null,
    2,
  ),
);
