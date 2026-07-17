import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseOrbitEpochUtcMs } from "./utcEpoch.mjs";

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function epochOf(record) {
  const value = record?.EPOCH ?? record?.epoch ?? record?.raw_omm?.EPOCH ?? record?.CREATION_DATE;
  return parseOrbitEpochUtcMs(value);
}

export function summarizeOrbitEpochAges(records, referenceTime = new Date()) {
  const referenceMs = new Date(referenceTime).getTime();
  if (!Number.isFinite(referenceMs)) throw new Error(`Invalid orbit age reference time: ${referenceTime}`);
  const epochs = records.map(epochOf).filter(Number.isFinite);
  if (!epochs.length) throw new Error("Orbit catalog does not contain parseable epochs");
  const ages = epochs.map((epoch) => (referenceMs - epoch) / 3_600_000);
  const sortedEpochs = [...epochs].sort((left, right) => left - right);
  return {
    reference_time: new Date(referenceMs).toISOString(),
    record_count: records.length,
    parseable_epoch_count: epochs.length,
    epoch_start: new Date(sortedEpochs[0]).toISOString(),
    epoch_end: new Date(sortedEpochs.at(-1)).toISOString(),
    epoch_median: new Date(quantile(sortedEpochs, 0.5)).toISOString(),
    age_min_hours: round(Math.min(...ages)),
    age_p50_hours: round(quantile(ages, 0.5)),
    age_p95_hours: round(quantile(ages, 0.95)),
    age_max_hours: round(Math.max(...ages)),
    future_epoch_ratio: round(ages.filter((age) => age < 0).length / ages.length),
  };
}

export function evaluateOrbitFreshness(records, referenceTime, policy) {
  const summary = summarizeOrbitEpochAges(records, referenceTime);
  const checks = {
    minimum_records: summary.record_count >= Number(policy.minimum_records ?? 1),
    median_age: summary.age_p50_hours <= Number(policy.maximum_median_age_hours),
    p95_age: summary.age_p95_hours <= Number(policy.maximum_p95_age_hours),
    future_epoch_ratio: summary.future_epoch_ratio <= Number(policy.maximum_future_epoch_ratio ?? 0.02),
  };
  return {
    ...summary,
    policy: {
      minimum_records: Number(policy.minimum_records ?? 1),
      maximum_median_age_hours: Number(policy.maximum_median_age_hours),
      maximum_p95_age_hours: Number(policy.maximum_p95_age_hours),
      maximum_future_epoch_ratio: Number(policy.maximum_future_epoch_ratio ?? 0.02),
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function seedOrbitCache({ cacheDirectory, sourceId, dataPath, metadata }) {
  const latestDataPath = join(cacheDirectory, `${sourceId}-latest.json`);
  const latestMetadataPath = join(cacheDirectory, `${sourceId}-latest.metadata.json`);
  if (await exists(latestDataPath)) return false;
  await mkdir(cacheDirectory, { recursive: true });
  await copyFile(resolve(dataPath), latestDataPath);
  const bytes = await readFile(latestDataPath);
  await writeJson(latestMetadataPath, {
    schema: "int-temerity-orbit-source-cache/v1",
    source_id: sourceId,
    source_url: metadata.source_url,
    acquired_at: new Date(metadata.acquired_at).toISOString(),
    sha256: sha256(bytes),
    records: JSON.parse(bytes.toString("utf8")).length,
    cache_origin: resolve(dataPath),
    fetch_status: "seeded-from-existing-audited-acquisition",
  });
  return true;
}

export async function acquireOrbitJson({
  url,
  sourceId,
  cacheDirectory,
  outputDirectory,
  minimumRecords,
  minimumDownloadIntervalHours = 2,
  requireAcquiredAfter = "",
  timeoutMs = 120_000,
  force = false,
}) {
  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const latestDataPath = join(cacheDirectory, `${sourceId}-latest.json`);
  const latestMetadataPath = join(cacheDirectory, `${sourceId}-latest.metadata.json`);
  const cachedMetadata = await exists(latestMetadataPath) ? await readJson(latestMetadataPath) : null;
  const cachedDataExists = await exists(latestDataPath);
  const now = Date.now();
  const acquiredMs = new Date(cachedMetadata?.acquired_at ?? 0).getTime();
  const cacheAgeHours = Number.isFinite(acquiredMs) ? (now - acquiredMs) / 3_600_000 : Infinity;
  const requiredAfterMs = requireAcquiredAfter ? new Date(requireAcquiredAfter).getTime() : Number.NEGATIVE_INFINITY;
  const cacheMeetsCausality = Number.isFinite(acquiredMs) && acquiredMs >= requiredAfterMs;
  const shouldRespectInterval = cachedDataExists && cacheAgeHours < minimumDownloadIntervalHours;

  let records;
  let acquisition;
  if (!force && shouldRespectInterval) {
    records = await readJson(latestDataPath);
    acquisition = {
      ...cachedMetadata,
      fetch_status: cacheMeetsCausality ? "cache-within-source-update-interval" : "pre-freeze-cache-waiting-for-next-source-update",
      cache_age_hours: round(cacheAgeHours),
      causality_eligible: cacheMeetsCausality,
      next_download_allowed_at: new Date(acquiredMs + minimumDownloadIntervalHours * 3_600_000).toISOString(),
    };
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "INT-Temerity-Experiment14B/1.0 research-validation",
        },
        signal: controller.signal,
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.toString("utf8", 0, 240)}`);
      records = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(records)) throw new Error("CelesTrak response is not a JSON array");
      if (records.length < minimumRecords) throw new Error(`CelesTrak response only contains ${records.length} records`);
      const acquiredAt = new Date().toISOString();
      const digest = sha256(body);
      const immutableName = `${sourceId}-${acquiredAt.replace(/[:.]/g, "-")}-${digest.slice(0, 12)}.json`;
      const immutablePath = join(outputDirectory, immutableName);
      await writeFile(immutablePath, body);
      await writeFile(latestDataPath, body);
      acquisition = {
        schema: "int-temerity-orbit-source-cache/v1",
        source_id: sourceId,
        source_url: url,
        acquired_at: acquiredAt,
        sha256: digest,
        records: records.length,
        immutable_path: resolve(immutablePath),
        fetch_status: `live-http-${response.status}`,
        cache_age_hours: 0,
        causality_eligible: new Date(acquiredAt).getTime() >= requiredAfterMs,
        next_download_allowed_at: new Date(new Date(acquiredAt).getTime() + minimumDownloadIntervalHours * 3_600_000).toISOString(),
      };
      await writeJson(latestMetadataPath, acquisition);
    } catch (error) {
      if (!cachedDataExists || !cachedMetadata) throw error;
      records = await readJson(latestDataPath);
      acquisition = {
        ...cachedMetadata,
        fetch_status: "cache-fallback-after-fetch-error",
        fetch_error: error.message,
        cache_age_hours: round(cacheAgeHours),
        causality_eligible: cacheMeetsCausality,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (!Array.isArray(records) || records.length < minimumRecords) {
    throw new Error(`${sourceId} cache/acquisition contains too few records: ${records?.length ?? 0}`);
  }
  const outputPath = join(outputDirectory, `${sourceId}-acquired.json`);
  const outputMetadataPath = join(outputDirectory, `${sourceId}-acquisition.json`);
  await writeJson(outputPath, records);
  await writeJson(outputMetadataPath, acquisition);
  return { records, acquisition, outputPath, outputMetadataPath };
}

async function loadCatalogBuilder() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "int-temerity-orbit-"));
  const bundlePath = join(temporaryDirectory, "catalog-builder.mjs");
  try {
    const result = await build({
      stdin: {
        contents: `
          import { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot } from ${JSON.stringify(resolve("src/simulation/realTleCatalog.ts"))};
          export { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot };
        `,
        resolveDir: process.cwd(),
        sourcefile: "experiment14b-catalog-builder.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
    return {
      module: await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`),
      cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function buildFreshWalkerSnapshot(records, options) {
  const loaded = await loadCatalogBuilder();
  try {
    const snapshot = loaded.module.buildRealTleSnapshotFromCelestrakJson(records, {
      source: "celestrak",
      group: options.group ?? "STARLINK",
      sourceUrl: options.sourceUrl,
      downloadedAt: options.downloadedAt,
      planes: options.planes,
      satellitesPerPlane: options.satellitesPerPlane,
      raanClusterThresholdDeg: options.raanClusterThresholdDeg,
      targetInclinationDeg: options.targetInclinationDeg,
      targetAltitudeKm: options.targetAltitudeKm,
    });
    const verification = loaded.module.verifyRealTleSnapshot(snapshot);
    if (!verification.ok) throw new Error(`Fresh Walker snapshot is invalid: ${verification.errors.join("; ")}`);
    return snapshot;
  } finally {
    await loaded.cleanup();
  }
}

export async function fileMetadata(path) {
  const absolutePath = resolve(path);
  const [bytes, info] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  return {
    path: absolutePath,
    filename: basename(absolutePath),
    bytes: bytes.length,
    sha256: sha256(bytes),
    modified_at: info.mtime.toISOString(),
  };
}
