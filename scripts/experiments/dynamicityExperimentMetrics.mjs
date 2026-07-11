import { createHash } from "node:crypto";

const FAIRNESS_FIELDS = Object.freeze([
  "truth_metadata_sha256",
  "truth_links_sha256",
  "candidate_paths_sha256",
  "parameters.samplingRate",
  "parameters.targetActiveLinkSamplingRate",
  "parameters.maxPathsPerSlice",
  "parameters.downlinkBudgetBytes",
  "parameters.rank",
  "parameters.windowSize",
  "parameters.warmupSlices",
  "parameters.iterations",
  "parameters.observabilityMode",
  "parameters.feedbackLagSlices",
  "parameters.telemetryFieldsHash",
]);

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function canonicalValue(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function hashObject(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function auditFixedBudgetPair(nativeRun = {}, enhancedRun = {}) {
  const comparisons = FAIRNESS_FIELDS.map((field) => ({
    field,
    native_value: canonicalValue(valueAt(nativeRun, field)),
    enhanced_value: canonicalValue(valueAt(enhancedRun, field)),
  }));
  const violations = comparisons
    .filter((row) => JSON.stringify(row.native_value) !== JSON.stringify(row.enhanced_value))
    .map((row) => `${row.field} differs: native=${JSON.stringify(row.native_value)} enhanced=${JSON.stringify(row.enhanced_value)}`);
  return {
    ok: violations.length === 0,
    violations,
    comparisons,
    fingerprint: hashObject(comparisons),
  };
}

function isActive(row) {
  return String(row?.is_active ?? "").toLowerCase() === "true";
}

function splitList(value) {
  return String(value ?? "")
    .split(/\s+>\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sliceKey(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeTopologyBySlice(linkRows) {
  const result = new Map();
  linkRows.forEach((row) => {
    const slice = sliceKey(row.slice_index);
    const topology = result.get(slice) ?? { ids: new Set(), directed: new Set(), undirected: new Set() };
    if (isActive(row)) {
      const id = String(row.link_id ?? "");
      const source = String(row.source ?? "");
      const target = String(row.target ?? "");
      if (id) topology.ids.add(id);
      if (source && target) {
        topology.directed.add(`${source}>${target}`);
        topology.undirected.add([source, target].sort().join(">"));
      }
    }
    result.set(slice, topology);
  });
  return result;
}

function pathHops(path) {
  const nodes = splitList(path);
  return nodes.slice(0, -1).map((source, index) => ({ source, target: nodes[index + 1] }));
}

export function calculatePathValidity({ probeRows = [], linkRows = [] } = {}) {
  const bySlice = activeTopologyBySlice(linkRows);
  return probeRows.map((probe) => {
    const slice = sliceKey(probe.slice_index);
    const topology = bySlice.get(slice) ?? { ids: new Set(), directed: new Set(), undirected: new Set() };
    const linkIds = splitList(probe.link_ids);
    const hops = pathHops(probe.path);
    let failedLinkId = "";
    let failedHop = "";
    if (linkIds.length > 0) {
      const failedIndex = linkIds.findIndex((id) => !topology.ids.has(id));
      if (failedIndex >= 0) {
        failedLinkId = linkIds[failedIndex];
        const hop = hops[failedIndex];
        failedHop = hop ? `${hop.source}>${hop.target}` : "";
      }
    } else {
      const failed = hops.find(({ source, target }) =>
        !topology.directed.has(`${source}>${target}`) &&
        !topology.undirected.has([source, target].sort().join(">")),
      );
      if (failed) failedHop = `${failed.source}>${failed.target}`;
    }
    const invalid = Boolean(failedLinkId || failedHop);
    return {
      slice_index: slice,
      time: probe.time ?? "",
      probe_id: probe.probe_id ?? "",
      source: probe.source ?? "",
      sink: probe.sink ?? probe.target ?? "",
      path_link_count: linkIds.length || hops.length,
      invalid,
      failed_link_id: failedLinkId,
      failed_hop: failedHop,
    };
  });
}

export function calculateCarryoverPathValidity({ probeRows = [], linkRows = [] } = {}) {
  const availableSlices = new Set(linkRows.map((row) => sliceKey(row.slice_index)));
  const shifted = probeRows.flatMap((probe) => {
    const planSlice = sliceKey(probe.slice_index);
    const evaluationSlice = planSlice + 1;
    if (!availableSlices.has(evaluationSlice)) return [];
    return [{
      ...probe,
      slice_index: String(evaluationSlice),
      plan_slice_index: planSlice,
      evaluation_slice_index: evaluationSlice,
    }];
  });
  return calculatePathValidity({ probeRows: shifted, linkRows }).map((row, index) => ({
    ...row,
    plan_slice_index: shifted[index].plan_slice_index,
    evaluation_slice_index: shifted[index].evaluation_slice_index,
  }));
}

export function summarizePathValidity(rows = []) {
  const total = rows.length;
  const invalid = rows.filter((row) => row.invalid).length;
  return {
    selected_paths: total,
    invalidated_paths: invalid,
    path_failure_ratio: total > 0 ? invalid / total : 0,
  };
}
