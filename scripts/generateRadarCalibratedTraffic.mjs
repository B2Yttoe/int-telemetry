import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function mod(value, size) {
  return ((value % size) + size) % size;
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function nodeId(plane, slot, planes, slots) {
  return `P${String(mod(plane, planes) + 1).padStart(2, "0")}-S${String(mod(slot, slots) + 1).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeShare(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNumberArg(args, name) {
  const raw = argValue(args, name, "");
  if (raw === "") return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : Number.NaN;
}

function resample(values, count) {
  if (!values.length || count <= 0) return [];
  if (values.length === count) return values;
  if (count === 1) return [average(values)];
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const position = (index / (count - 1)) * (values.length - 1);
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const ratio = position - left;
    result.push(values[left] * (1 - ratio) + values[right] * ratio);
  }
  return result;
}

function normalize01(values) {
  const clean = values.filter(Number.isFinite);
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return values.map(() => 0.5);
  if (Math.abs(max - min) < 1e-9) return values.map(() => 0.5);
  return values.map((value) => (Number.isFinite(value) ? (value - min) / (max - min) : 0.5));
}

function extractRadarSeriesFromPayload(payload) {
  const candidates = [];
  function visit(value, path = []) {
    if (Array.isArray(value)) {
      const numericRows = value
        .map((item, index) => {
          if (typeof item === "number") return { index, value: item, time: String(index), source_path: path.join(".") };
          if (item && typeof item === "object") {
            const keys = Object.keys(item);
            const valueKey = keys.find((key) => /value|requests|traffic|bytes|count/i.test(key));
            const timeKey = keys.find((key) => /time|date|timestamp/i.test(key));
            if (valueKey && Number.isFinite(Number(item[valueKey]))) {
              return {
                index,
                value: Number(item[valueKey]),
                time: item[timeKey] ?? String(index),
                source_path: path.join("."),
              };
            }
          }
          return null;
        })
        .filter(Boolean);
      if (numericRows.length >= 4) candidates.push({ path: path.join("."), rows: numericRows });
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value && typeof value === "object") {
      if (Array.isArray(value.timestamps) && Array.isArray(value.values)) {
        const numericRows = value.values
          .map((entry, index) => ({
            index,
            value: Number(entry),
            time: value.timestamps[index] ?? String(index),
            source_path: path.join("."),
          }))
          .filter((row) => Number.isFinite(row.value));
        if (numericRows.length >= 4) candidates.push({ path: path.join("."), rows: numericRows });
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  }
  visit(payload);
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  return candidates[0] ?? { path: "", rows: [] };
}

function selectRadarWindow(rows, count, windowMode) {
  if (!rows.length || count <= 0) return [];
  if (rows.length < count || windowMode === "resample") {
    const values = resample(rows.map((row) => row.value), count);
    return values.map((value, index) => ({
      index,
      value,
      time: rows[Math.min(rows.length - 1, Math.round((index / Math.max(1, count - 1)) * (rows.length - 1)))]?.time ?? String(index),
      source_index: index,
      selection_mode: "resample",
    }));
  }
  if (windowMode === "earliest") return rows.slice(0, count).map((row) => ({ ...row, selection_mode: "earliest" }));
  const startMatch = /^start:(\d+)$/i.exec(windowMode);
  if (startMatch) {
    const start = clamp(Number(startMatch[1]), 0, Math.max(0, rows.length - count));
    return rows.slice(start, start + count).map((row) => ({ ...row, selection_mode: windowMode }));
  }
  return rows.slice(rows.length - count).map((row) => ({ ...row, selection_mode: "latest" }));
}

function buildRadarDrivenProfile({ profile, radarSeries, radarPath, slices, windowMode, minWeightArg, maxWeightArg, keepAnomalies }) {
  const baseWeights = (profile.time_series ?? []).map((point) => Number(point.traffic_weight)).filter(Number.isFinite);
  const minWeight = Number.isFinite(minWeightArg) ? minWeightArg : Math.min(...baseWeights, 0.5);
  const maxWeight = Number.isFinite(maxWeightArg) ? maxWeightArg : Math.max(...baseWeights, 1.5);
  if (!(maxWeight > minWeight)) fail("--radar-max-weight must be greater than --radar-min-weight");

  const selectedRows = selectRadarWindow(radarSeries.rows, slices, windowMode);
  if (selectedRows.length !== slices) {
    fail(`Radar series could not be aligned to ${slices} slices; selected ${selectedRows.length} points.`);
  }
  const normalized = normalize01(selectedRows.map((row) => Number(row.value)));
  const timeSeries = selectedRows.map((row, index) => {
    const base = profileTimePoint(profile, index);
    return {
      ...base,
      slice: index,
      traffic_weight: round(minWeight + normalized[index] * (maxWeight - minWeight), 5),
      radar_time: row.time,
      radar_value: round(Number(row.value), 8),
      radar_normalized: round(normalized[index], 8),
    };
  });

  return {
    profile: {
      ...profile,
      data_mode: "external-cloudflare-radar-timeseries-driven",
      not_raw_cloudflare_export: false,
      time_series: timeSeries,
      anomalies: keepAnomalies ? profile.anomalies ?? [] : [],
    },
    metadata: {
      enabled: true,
      source_path: radarPath,
      extracted_path: radarSeries.path,
      original_points: radarSeries.rows.length,
      selected_points: selectedRows.length,
      window_mode: selectedRows[0]?.selection_mode ?? windowMode,
      requested_window_mode: windowMode,
      min_weight: round(minWeight, 5),
      max_weight: round(maxWeight, 5),
      first_selected_time: selectedRows[0]?.time ?? null,
      last_selected_time: selectedRows.at(-1)?.time ?? null,
      profile_anomalies_applied: keepAnomalies,
      note:
        "Cloudflare Radar AS14593 aggregate values drive per-slice traffic_weight after min-max normalization; comparison is shape-level, not raw Mbps equality.",
      selected_time_series: timeSeries.map((point) => ({
        slice: point.slice,
        radar_time: point.radar_time,
        radar_value: point.radar_value,
        radar_normalized: point.radar_normalized,
        traffic_weight: point.traffic_weight,
      })),
    },
  };
}

function anomalyMultiplier(profile, slice, regionId, classId) {
  let multiplier = 1;
  for (const anomaly of profile.anomalies ?? []) {
    const start = Number(anomaly.start_slice ?? 0);
    const duration = Math.max(1, Number(anomaly.duration_slices ?? 1));
    const inWindow = slice >= start && slice < start + duration;
    const regionMatches = !Array.isArray(anomaly.regions) || anomaly.regions.includes(regionId);
    const classMatches = !Array.isArray(anomaly.classes) || anomaly.classes.includes(classId);
    if (inWindow && regionMatches && classMatches) {
      multiplier *= Number(anomaly.traffic_multiplier ?? 1);
    }
  }
  return multiplier;
}

function profileTimePoint(profile, slice) {
  const points = Array.isArray(profile.time_series) ? profile.time_series : [];
  if (points.length === 0) {
    return { slice, traffic_weight: 1, human_share: 0.75, api_share: 0.18, bot_share: 0.07 };
  }
  return points[slice % points.length];
}

function validateProfile(profile) {
  const errors = [];
  if (!Array.isArray(profile.time_series) || profile.time_series.length === 0) errors.push("profile.time_series is required");
  if (!Array.isArray(profile.regions) || profile.regions.length === 0) errors.push("profile.regions is required");
  if (!Array.isArray(profile.traffic_classes) || profile.traffic_classes.length === 0) {
    errors.push("profile.traffic_classes is required");
  }
  const regionIds = new Set((profile.regions ?? []).map((region) => region.id));
  for (const region of profile.regions ?? []) {
    if (!region.id) errors.push("each region requires id");
    if (region.target_region && !regionIds.has(region.target_region)) {
      errors.push(`region ${region.id} target_region does not exist: ${region.target_region}`);
    }
  }
  for (const trafficClass of profile.traffic_classes ?? []) {
    if (!trafficClass.id) errors.push("each traffic class requires id");
    if (!trafficClass.task_type) errors.push(`traffic class ${trafficClass.id} requires task_type`);
  }
  return errors;
}

const args = process.argv.slice(2);
const snapshotPath = resolve(argValue(args, "--snapshot", "data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json"));
const profilePath = resolve(argValue(args, "--profile", "traffic-calibration/cloudflare-radar-profile.json"));
const outPath = resolve(argValue(args, "--out", "examples/datasets/radar-calibrated-starlink-main-47x14-48-traffic.csv"));
const metadataOutPath = resolve(argValue(args, "--metadata-out", outPath.replace(/\.csv$/i, ".metadata.json")));
const slices = Number(argValue(args, "--slices", "48"));
const radarJsonArg = argValue(args, "--radar-json", "");
const radarJsonPath = radarJsonArg ? resolve(radarJsonArg) : "";
const radarWindow = argValue(args, "--radar-window", "latest");
const radarMinWeightArg = optionalNumberArg(args, "--radar-min-weight");
const radarMaxWeightArg = optionalNumberArg(args, "--radar-max-weight");
const keepRadarProfileAnomalies = hasArg(args, "--radar-keep-profile-anomalies");

if (!Number.isFinite(slices) || slices < 1) fail("--slices must be a positive number");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const profile = JSON.parse(await readFile(profilePath, "utf8"));
let generationProfile = profile;
let radarCalibration = { enabled: false };
if (radarJsonPath) {
  const radarPayload = JSON.parse(await readFile(radarJsonPath, "utf8"));
  const radarSeries = extractRadarSeriesFromPayload(radarPayload);
  if (!radarSeries.rows.length) fail(`No numeric Radar time series found in ${radarJsonPath}`);
  const radarDriven = buildRadarDrivenProfile({
    profile,
    radarSeries,
    radarPath: radarJsonPath,
    slices,
    windowMode: radarWindow,
    minWeightArg: radarMinWeightArg,
    maxWeightArg: radarMaxWeightArg,
    keepAnomalies: keepRadarProfileAnomalies,
  });
  generationProfile = radarDriven.profile;
  radarCalibration = radarDriven.metadata;
}
const profileErrors = validateProfile(generationProfile);
if (profileErrors.length > 0) fail(`Invalid calibration profile:\n- ${profileErrors.join("\n- ")}`);

const planes = Number(snapshot.layout?.planes);
const slots = Number(snapshot.layout?.satellites_per_plane);
if (!Number.isFinite(planes) || !Number.isFinite(slots) || planes < 1 || slots < 1) {
  fail("Snapshot layout must include positive planes and satellites_per_plane");
}

const regions = generationProfile.regions;
const regionsById = new Map(regions.map((region) => [region.id, region]));
const classes = generationProfile.traffic_classes;
const rows = [];

function add(row) {
  const startSlice = clamp(Math.floor(row.start_slice), 0, slices - 1);
  const requestedDurationSlices = Math.max(1, Math.floor(row.duration_slices));
  const durationSlices = Math.max(1, Math.min(requestedDurationSlices, slices - startSlice));
  let source = row.source ?? "";
  let target = row.target ?? "";
  if (source && target && source === target) {
    const match = /^P(\d+)-S(\d+)$/i.exec(target);
    if (match) target = nodeId(Number(match[1]) - 1, Number(match[2]), planes, slots);
  }
  rows.push({
    task_id: row.task_id,
    calibration_class_id: row.calibration_class_id ?? "",
    calibration_region_id: row.calibration_region_id ?? "",
    time: `T${String(startSlice).padStart(2, "0")}`,
    start_slice: startSlice,
    duration_slices: durationSlices,
    source,
    target,
    node_id: row.node_id ?? "",
    compute_units: round(row.compute_units ?? 0, 2),
    gpu_units: round(row.gpu_units ?? 0, 2),
    memory_gb: round(row.memory_gb ?? 0, 2),
    storage_gb: round(row.storage_gb ?? 0, 2),
    traffic_mbps: round(row.traffic_mbps ?? 0, 2),
    priority: row.priority ?? 3,
    task_type: row.task_type,
  });
}

function regionAnchor(region, slice, lane) {
  const basePlane = Math.round(Number(region.plane_fraction ?? 0) * Math.max(0, planes - 1));
  const plane = basePlane + slice + lane * 3;
  const slot = Number(region.slot_offset ?? 0) + Math.floor(slice / 2) + lane * 2;
  return { plane: mod(plane, planes), slot: mod(slot, slots) };
}

function routedEndpoints(region, trafficClass, slice, lane) {
  const sourceAnchor = regionAnchor(region, slice, lane);
  const targetRegion = regionsById.get(region.target_region) ?? regions[mod(lane + 1, regions.length)];
  const targetAnchor = regionAnchor(targetRegion, slice + 3 + lane, lane + 2);
  const classShift = classes.findIndex((item) => item.id === trafficClass.id) + 1;
  return {
    source: nodeId(sourceAnchor.plane, sourceAnchor.slot, planes, slots),
    target: nodeId(targetAnchor.plane + classShift, targetAnchor.slot + classShift * 2, planes, slots),
  };
}

if (generationProfile.backbone_flows?.enabled !== false) {
  regions.forEach((region, index) => {
    const trafficWeight =
      generationProfile.time_series.reduce((sum, point) => sum + normalizeShare(point.traffic_weight, 1), 0) /
      generationProfile.time_series.length;
    const endpoints = routedEndpoints(region, { id: "backbone" }, 0, index);
    const regionWeight = normalizeShare(region.demand_weight, 1);
    add({
      task_id: `RADAR-BACKBONE-${String(index + 1).padStart(2, "0")}`,
      calibration_class_id: "backbone",
      calibration_region_id: region.id,
      start_slice: 0,
      duration_slices: Math.min(slices, Number(generationProfile.backbone_flows.duration_slices ?? slices)),
      ...endpoints,
      compute_units: Number(generationProfile.backbone_flows.compute_units ?? 12) * regionWeight,
      memory_gb: Number(generationProfile.backbone_flows.memory_gb ?? 3),
      storage_gb: Number(generationProfile.backbone_flows.storage_gb ?? 16),
      traffic_mbps: Number(generationProfile.backbone_flows.base_mbps ?? 200) * trafficWeight * regionWeight,
      priority: 2,
      task_type: "background",
    });
  });
}

for (let slice = 0; slice < slices; slice += 1) {
  const point = profileTimePoint(generationProfile, slice);
  const trafficWeight = normalizeShare(point.traffic_weight, 1);

  regions.forEach((region, regionIndex) => {
    const regionWeight = normalizeShare(region.demand_weight, 1);

    classes.forEach((trafficClass, classIndex) => {
      const interval = Math.max(1, Number(trafficClass.interval_slices ?? 1));
      const phase = Number(trafficClass.phase ?? 0);
      if (mod(slice + regionIndex + phase, interval) !== 0) return;

      const share = normalizeShare(point[trafficClass.share_key] ?? trafficClass.share ?? 1, 1);
      const multiplier = anomalyMultiplier(generationProfile, slice, region.id, trafficClass.id);
      const endpoints = routedEndpoints(region, trafficClass, slice, regionIndex + classIndex);
      const classScale = 0.72 + share;
      const trafficMbps = Number(trafficClass.base_mbps ?? 100) * trafficWeight * regionWeight * classScale * multiplier;
      const loadScale = trafficWeight * regionWeight * Math.max(0.7, multiplier);

      add({
        task_id: `RADAR-${String(slice).padStart(2, "0")}-${region.id}-${trafficClass.id}`,
        calibration_class_id: trafficClass.id,
        calibration_region_id: region.id,
        start_slice: slice,
        duration_slices: Number(trafficClass.duration_slices ?? 1),
        ...endpoints,
        compute_units: Number(trafficClass.compute_units ?? 0) * loadScale,
        memory_gb: Number(trafficClass.memory_gb ?? 0) * Math.max(0.8, regionWeight),
        storage_gb: Number(trafficClass.storage_gb ?? 0) * Math.max(0.8, regionWeight),
        traffic_mbps: trafficMbps,
        priority: Number(trafficClass.priority ?? 3),
        task_type: trafficClass.task_type,
      });
    });

    const local = generationProfile.local_compute;
    if (local && mod(slice + regionIndex, Math.max(1, Number(local.interval_slices ?? 4))) === 0) {
      const anchor = regionAnchor(region, slice, regionIndex + 5);
      add({
        task_id: `RADAR-COMPUTE-${String(slice).padStart(2, "0")}-${region.id}`,
        calibration_class_id: "local-compute",
        calibration_region_id: region.id,
        start_slice: slice,
        duration_slices: Number(local.duration_slices ?? 3),
        node_id: nodeId(anchor.plane, anchor.slot, planes, slots),
        compute_units: Number(local.base_compute_units ?? 20) * trafficWeight * regionWeight,
        gpu_units: regionWeight > 1 ? 1 : 0,
        memory_gb: Number(local.base_memory_gb ?? 8) * Math.max(0.8, regionWeight),
        storage_gb: Number(local.base_storage_gb ?? 32) * Math.max(0.8, regionWeight),
        priority: 2,
        task_type: "compute",
      });
    }
  });
}

for (const anomaly of generationProfile.anomalies ?? []) {
  const start = clamp(Number(anomaly.start_slice ?? 0), 0, slices - 1);
  const duration = Math.max(1, Number(anomaly.duration_slices ?? 1));
  const regionIds = Array.isArray(anomaly.regions) ? anomaly.regions : regions.map((region) => region.id);
  regionIds.forEach((regionId, index) => {
    const region = regionsById.get(regionId);
    if (!region) return;
    const endpoints = routedEndpoints(region, { id: anomaly.id }, start, index + 11);
    add({
      task_id: `RADAR-ANOMALY-${anomaly.id}-${region.id}`,
      calibration_class_id: `anomaly:${anomaly.id}`,
      calibration_region_id: region.id,
      start_slice: start,
      duration_slices: duration,
      ...endpoints,
      compute_units: 30 * normalizeShare(region.demand_weight, 1) * Number(anomaly.traffic_multiplier ?? 1),
      memory_gb: 8,
      storage_gb: 20,
      traffic_mbps: 420 * normalizeShare(region.demand_weight, 1) * Number(anomaly.traffic_multiplier ?? 1),
      priority: Number(anomaly.traffic_multiplier ?? 1) > 1 ? 4 : 1,
      task_type: Number(anomaly.traffic_multiplier ?? 1) > 1 ? "burst" : "mixed",
    });
  });
}

const header = [
  "task_id",
  "calibration_class_id",
  "calibration_region_id",
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

const csv = [header.join(","), ...rows.map((row) => header.map((key) => row[key] ?? "").join(","))].join("\n");

const routedTasks = rows.filter((row) => row.source && row.target).length;
const localTasks = rows.filter((row) => row.node_id).length;
const totalTrafficMbps = round(rows.reduce((sum, row) => sum + Number(row.traffic_mbps || 0), 0), 2);
const totalComputeUnits = round(rows.reduce((sum, row) => sum + Number(row.compute_units || 0), 0), 2);
const timeWeights = Array.from({ length: slices }, (_, slice) =>
  normalizeShare(profileTimePoint(generationProfile, slice).traffic_weight, 1),
);
const countBy = (key) =>
  rows.reduce((counts, row) => {
    const value = String(row[key] || "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
const trafficMbpsByClass = rows.reduce((counts, row) => {
  const value = String(row.calibration_class_id || "unknown");
  counts[value] = round((counts[value] ?? 0) + Number(row.traffic_mbps || 0), 2);
  return counts;
}, {});
const metadata = {
  schema: "int-telemetry-radar-calibrated-traffic-metadata/v1",
  generated_at: new Date().toISOString(),
  generator: "scripts/generateRadarCalibratedTraffic.mjs",
  snapshot: {
    path: snapshotPath,
    source: snapshot.source,
    group: snapshot.group,
    fingerprint: snapshot.fingerprint,
    selected_count: snapshot.selected_count,
    planes,
    satellites_per_plane: slots,
  },
  calibration_profile: {
    path: profilePath,
    profile_id: profile.profile_id,
    data_mode: generationProfile.data_mode,
    original_data_mode: profile.data_mode,
    not_raw_cloudflare_export: Boolean(profile.not_raw_cloudflare_export),
    effective_not_raw_cloudflare_export: Boolean(generationProfile.not_raw_cloudflare_export),
    radar_entity: profile.radar_entity ?? null,
    observed_dimensions: profile.observed_dimensions ?? [],
    calibration_mapping: profile.calibration_mapping ?? {},
    quality_model: profile.quality_model ?? null,
    source_references: profile.source_references,
  },
  radar_calibration: radarCalibration,
  output: {
    csv: outPath,
    metadata: metadataOutPath,
    slices,
    rows: rows.length,
    routed_tasks: routedTasks,
    local_tasks: localTasks,
    total_traffic_mbps: totalTrafficMbps,
    total_compute_units: totalComputeUnits,
    min_time_weight: round(Math.min(...timeWeights), 3),
    max_time_weight: round(Math.max(...timeWeights), 3),
    anomaly_count: generationProfile.anomalies?.length ?? 0,
    task_type_counts: countBy("task_type"),
    calibration_class_counts: countBy("calibration_class_id"),
    calibration_region_counts: countBy("calibration_region_id"),
    traffic_mbps_by_calibration_class: trafficMbpsByClass,
    realism_boundary: {
      cloudflare_data_scope: "AS14593 public aggregate Radar dimensions",
      not_operator_internal_trace: true,
      not_satellite_internal_isl_trace: true,
      synthetic_mapping: true,
    },
  },
};

await mkdir(dirname(outPath), { recursive: true });
await mkdir(dirname(metadataOutPath), { recursive: true });
await writeFile(outPath, `${csv}\n`, "utf8");
await writeFile(metadataOutPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ok: true, ...metadata.output }, null, 2));
