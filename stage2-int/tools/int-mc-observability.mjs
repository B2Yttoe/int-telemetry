function numberOr(value, fallback = "") {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

function indexBy(rows, keyFn) {
  return new Map((rows ?? []).map((row) => [keyFn(row), row]));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstPresent(row, fields) {
  return fields
    .map((field) => row?.[field])
    .find((value) => value !== undefined && value !== null && value !== "");
}

function copyDefined(target, source, fields) {
  fields.forEach((field) => {
    const value = source?.[field];
    if (value !== undefined && value !== null && value !== "") target[field] = value;
  });
  return target;
}

export function scheduleObservableRows(rows = [], {
  lagSlices = 1,
  sourceFieldCandidates = ["source_slice_index", "control_source_slice_index", "slice_index"],
  targetFieldCandidates = ["next_slice_index", "target_slice_index", "slice_index"],
} = {}) {
  const causalLag = Math.max(0, Math.floor(numberOr(lagSlices, 0)));
  return (rows ?? []).map((row) => {
    const sourceSlice = numberOr(firstPresent(row, sourceFieldCandidates), NaN);
    if (!Number.isFinite(sourceSlice)) return { ...row };
    const declaredTarget = numberOr(firstPresent(row, targetFieldCandidates), sourceSlice);
    const effectiveTarget = Math.max(declaredTarget, sourceSlice + causalLag);
    return {
      ...row,
      source_slice_index: sourceSlice,
      slice_index: effectiveTarget,
      causal_feedback_lag_slices: effectiveTarget - sourceSlice,
    };
  });
}

export function buildObservablePlanningLinks({
  truthLinks = [],
  predictedPlan = null,
  oamLinks = [],
  mode = "oracle",
  stateLagSlices = 0,
} = {}) {
  const truthByKey = indexBy(truthLinks, (row) => `${row.slice_index}|${row.link_id}`);
  const oamByKey = indexBy(oamLinks, (row) => `${row.slice_index}|${row.link_id}`);
  const sourceRows = predictedPlan?.entries?.length ? predictedPlan.entries : truthLinks;
  const causalStateLag = Math.max(0, Math.floor(numberOr(stateLagSlices, 0)));

  if (mode !== "oam-only") {
    return sourceRows.map((entry) => {
      const truth = truthByKey.get(`${entry.slice_index}|${entry.link_id}`) ?? {};
      return {
        ...truth,
        ...entry,
        is_active: entry.predicted_active ?? truth.is_active,
        status: boolValue(entry.predicted_active ?? truth.is_active) ? truth.status || "up" : "down",
        effective_capacity_mbps: firstDefined(entry.capacity_mbps, truth.effective_capacity_mbps, truth.capacity_mbps),
      };
    });
  }

  return sourceRows.map((entry) => {
    const key = `${entry.slice_index}|${entry.link_id}`;
    const physical = truthByKey.get(key) ?? {};
    const targetSliceIndex = numberOr(firstDefined(entry.slice_index, physical.slice_index), 0);
    const oamSourceSliceIndex = targetSliceIndex - causalStateLag;
    const oam = oamSourceSliceIndex >= 0
      ? oamByKey.get(`${oamSourceSliceIndex}|${firstDefined(entry.link_id, physical.link_id, "")}`)
      : undefined;
    const predictedActive = boolValue(firstDefined(entry.predicted_active, physical.is_active));
    const row = {
      slice_index: targetSliceIndex,
      time: firstDefined(entry.time, physical.time, ""),
      minute: numberOr(firstDefined(entry.minute, physical.minute), 0),
      link_id: firstDefined(entry.link_id, physical.link_id, ""),
      source: firstDefined(entry.source, physical.source, ""),
      target: firstDefined(entry.target, physical.target, ""),
      kind: firstDefined(entry.kind, physical.kind, ""),
      predicted_active: predictedActive,
      is_active: predictedActive,
      status: predictedActive ? firstDefined(oam?.status_estimate, "up") : "down",
      p_available: numberOr(firstDefined(entry.p_available, physical.p_available, physical.availability_factor), predictedActive ? 0.75 : 0.05),
      availability_factor: numberOr(firstDefined(entry.availability_factor, physical.availability_factor, entry.p_available), predictedActive ? 0.75 : 0.05),
      prediction_confidence: numberOr(entry.confidence, ""),
      planner_state_source: oam ? "ground-oam" : "predictable-contact-only",
      planner_state_source_slice_index: oam ? numberOr(oam.slice_index, oamSourceSliceIndex) : "",
      planner_state_confidence: numberOr(oam?.confidence, 0),
      planner_observability_mode: "oam-only",
    };
    copyDefined(row, { ...physical, ...entry }, [
      "design_candidate",
      "line_of_sight",
      "distance_km",
      "distance_threshold_km",
      "capacity_mbps",
      "sinr_db",
      "snr_db",
      "solar_interference_blocked",
      "restriction_reason",
      "predicted_reason",
    ]);
    row.effective_capacity_mbps = numberOr(firstDefined(entry.capacity_mbps, physical.capacity_mbps), 0);
    row.latency_ms = numberOr(
      oam?.latency_ms_estimate,
      numberOr(row.distance_km, 0) / 299.792458 + 0.5,
    );
    row.queue_latency_ms = numberOr(oam?.queue_latency_ms_estimate, 0);
    row.utilization_percent = numberOr(oam?.utilization_percent_estimate, 0);
    row.congestion_percent = numberOr(oam?.congestion_percent_estimate, 0);
    row.queued_traffic_mb = numberOr(oam?.queued_traffic_mb_estimate, 0);
    row.dropped_traffic_mb = numberOr(oam?.dropped_traffic_mb_estimate, 0);
    row.packet_error_rate = numberOr(oam?.packet_error_rate_estimate, 0);
    row.oam_observation_source = firstDefined(oam?.observation_source, "unknown");
    return row;
  });
}

export function buildObservablePlanningNodes({
  truthNodes = [],
  oamNodes = [],
  mode = "oracle",
  stateLagSlices = 0,
} = {}) {
  if (mode !== "oam-only") return truthNodes.map((row) => ({ ...row }));
  const oamByKey = indexBy(oamNodes, (row) => `${row.slice_index}|${row.node_id}`);
  const causalStateLag = Math.max(0, Math.floor(numberOr(stateLagSlices, 0)));
  return truthNodes.map((truth) => {
    const targetSliceIndex = numberOr(truth.slice_index, 0);
    const oamSourceSliceIndex = targetSliceIndex - causalStateLag;
    const oam = oamSourceSliceIndex >= 0
      ? oamByKey.get(`${oamSourceSliceIndex}|${truth.node_id}`)
      : undefined;
    const row = {
      slice_index: targetSliceIndex,
      time: truth.time ?? "",
      minute: numberOr(truth.minute, 0),
      node_id: truth.node_id,
      label: truth.label ?? truth.node_id,
      planner_state_source: oam ? "ground-oam" : "predictable-context-only",
      planner_state_source_slice_index: oam ? numberOr(oam.slice_index, oamSourceSliceIndex) : "",
      planner_state_confidence: numberOr(oam?.confidence, 0),
      planner_observability_mode: "oam-only",
      oam_observation_source: firstDefined(oam?.observation_source, "unknown"),
    };
    copyDefined(row, truth, [
      "plane",
      "slot",
      "shell_id",
      "latitude",
      "longitude",
      "altitude_km",
      "x",
      "y",
      "z",
      "in_sunlight",
      "solar_exposure",
      "solar_power_w",
      "battery_capacity_wh",
      "min_state_of_charge",
      "base_power_w",
    ]);
    row.cpu_percent = numberOr(oam?.cpu_percent_estimate, 0);
    row.queue_depth = numberOr(oam?.queue_depth_estimate, 0);
    row.queued_traffic_mb = numberOr(oam?.queued_traffic_mb_estimate, 0);
    row.cache_used_mb = numberOr(oam?.cache_used_mb_estimate, 0);
    row.energy_percent = numberOr(oam?.energy_percent_estimate, 100);
    row.mode = firstDefined(oam?.mode_estimate, "unknown");
    row.power_saving_mode = row.mode === "power-saving" || row.mode === "offline";
    return row;
  });
}

export function buildObservableRoutes({ routes = [], mode = "oracle" } = {}) {
  if (mode !== "oam-only") return routes.map((row) => ({ ...row }));
  return routes.map((route) => {
    const row = {};
    copyDefined(row, route, [
      "slice_index",
      "time",
      "minute",
      "task_id",
      "source",
      "target",
      "node_id",
      "link_ids",
      "path",
      "hop_count",
      "path_link_count",
      "status",
      "traffic_mbps",
      "priority",
      "created_slice",
    ]);
    row.planner_observability_mode = "oam-only";
    return row;
  });
}

export function buildObservableOamFeedback({ rows = [], mode = "oracle" } = {}) {
  if (mode !== "oam-only") return rows.map((row) => ({ ...row }));
  return rows
    .filter((row) => {
      const source = String(row.feedback_source ?? "").trim().toLowerCase();
      const basis = String(row.feedback_basis ?? "").trim().toLowerCase();
      const reason = String(row.reason ?? "").trim().toLowerCase();
      const completionError = String(row.completion_error_score ?? "").trim();
      return source !== "int-mc-completion" &&
        !basis.includes("truth") &&
        !basis.includes("simulation-validation") &&
        !reason.includes("simulation-validation-error") &&
        completionError === "";
    })
    .map((row) => ({
      ...row,
      completion_error_score: "",
      planner_observability_mode: "oam-only",
    }));
}
