const DEFAULT_IMPORTANCE_WEIGHTS = Object.freeze({
  uncertainty: 0.3,
  age: 0.22,
  volatility: 0.18,
  business: 0.12,
  risk: 0.12,
  fairness: 0.06,
  criticality: 0.18,
});

const NODE_FULL_FIELDS = Object.freeze([
  "node_id",
  "mode",
  "cpu_percent",
  "queue_depth",
  "queued_traffic_mb",
  "cache_used_mb",
  "energy_percent",
  "can_accept_tasks",
]);

const NODE_CORE_FIELDS = Object.freeze([
  "mode",
  "cpu_percent",
  "queue_depth",
  "queued_traffic_mb",
  "cache_used_mb",
  "energy_percent",
  "can_accept_tasks",
]);

const LINK_FULL_FIELDS = Object.freeze([
  "link_id",
  "status",
  "is_active",
  "utilization_percent",
  "latency_ms",
  "queue_latency_ms",
  "effective_capacity_mbps",
  "queued_traffic_mb",
  "dropped_traffic_mb",
  "congestion_percent",
  "packet_error_rate",
]);

const LINK_LIGHT_FIELDS = Object.freeze([
  "link_id",
  "status",
  "is_active",
  "utilization_percent",
  "queue_latency_ms",
]);

const LINK_CORE_FIELDS = Object.freeze([
  "link_id",
  "status",
  "is_active",
  "utilization_percent",
  "latency_ms",
  "queue_latency_ms",
  "effective_capacity_mbps",
  "queued_traffic_mb",
  "dropped_traffic_mb",
  "congestion_percent",
  "packet_error_rate",
]);

export const DEFAULT_SELECTIVE_METADATA_PROFILE = Object.freeze({
  schema_version: "stage2-selective-metadata-profile-v1",
  instruction_header_bytes: 4,
  profile_bits_per_hop: 3,
  node_full_bytes: 96,
  node_core_bytes: 32,
  link_full_bytes: 48,
  link_core_bytes: 48,
  link_light_bytes: 20,
  forward_only_bytes: 0,
  node_full_fields: NODE_FULL_FIELDS,
  node_core_fields: NODE_CORE_FIELDS,
  link_full_fields: LINK_FULL_FIELDS,
  link_core_fields: LINK_CORE_FIELDS,
  link_light_fields: LINK_LIGHT_FIELDS,
});

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, numberValue(value)));
}

function round(value, digits = 6) {
  return Number(numberValue(value).toFixed(digits));
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function splitPath(value) {
  return String(value ?? "")
    .split(/\s+>\s+|\s*\|\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function groupBy(rows, keyFn) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });
  return grouped;
}

function normalizeWeights(weights = {}) {
  const merged = { ...DEFAULT_IMPORTANCE_WEIGHTS, ...weights };
  const total = Object.values(merged).reduce((sum, value) => sum + Math.max(0, numberValue(value)), 0) || 1;
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, Math.max(0, numberValue(value)) / total]),
  );
}

function sourceSliceFor(row) {
  return optionalNumber(
    row?.planner_state_source_slice_index ??
    row?.source_slice_index ??
    row?.control_source_slice_index,
  );
}

function stateAgeAtTarget(row, sliceIndex) {
  const sourceSlice = sourceSliceFor(row);
  const explicitAge = optionalNumber(row?.state_age_slices);
  if (explicitAge !== undefined) {
    return Math.max(0, explicitAge + (sourceSlice === undefined ? 0 : sliceIndex - sourceSlice));
  }
  const lastObservedSlice = optionalNumber(row?.last_observed_slice);
  if (lastObservedSlice !== undefined) return Math.max(0, sliceIndex - lastObservedSlice);
  const observationSource = String(row?.oam_observation_source ?? row?.observation_source ?? "").toLowerCase();
  if ([
    "unknown",
    "inferred",
    "prior-estimate",
    "oam-prior-estimate",
    "predictable-context-only",
    "predictable-contact-only",
  ].includes(observationSource)) {
    return sliceIndex + 1;
  }
  return sourceSlice === undefined ? sliceIndex + 1 : Math.max(0, sliceIndex - sourceSlice);
}

function hasDirectObservationHistory(row) {
  if (optionalNumber(row?.state_age_slices) !== undefined) return true;
  if (optionalNumber(row?.last_observed_slice) !== undefined) return true;
  const source = String(row?.oam_observation_source ?? row?.observation_source ?? "").toLowerCase();
  return source === "observed" || source === "stale-carryover";
}

function causalRowsForSlice(rows, sliceIndex, rejectedCounter) {
  return rows.filter((row) => {
    const rowSlice = numberValue(row.slice_index, -1);
    if (rowSlice > sliceIndex) return false;
    const sourceSlice = sourceSliceFor(row);
    if (sourceSlice !== undefined && sourceSlice >= sliceIndex) {
      rejectedCounter.count += 1;
      return false;
    }
    return true;
  });
}

function latestRowsById(rows, idField) {
  const grouped = groupBy(rows, (row) => String(row[idField] ?? ""));
  const result = new Map();
  grouped.forEach((items, id) => {
    if (!id) return;
    const ordered = [...items].sort((left, right) =>
      numberValue(left.slice_index, -1) - numberValue(right.slice_index, -1) ||
      numberValue(sourceSliceFor(left), -1) - numberValue(sourceSliceFor(right), -1)
    );
    result.set(id, ordered[ordered.length - 1]);
  });
  return result;
}

function normalizedMeanAbsoluteChange(rows, fields) {
  if (rows.length < 2) return 0;
  const ordered = [...rows].sort((left, right) => numberValue(left.slice_index) - numberValue(right.slice_index));
  const changes = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    fields.forEach(({ name, scale }) => {
      const left = optionalNumber(previous[name]);
      const right = optionalNumber(current[name]);
      if (left === undefined || right === undefined) return;
      changes.push(clamp(Math.abs(right - left) / Math.max(scale, 1e-9)));
    });
  }
  if (changes.length === 0) return 0;
  return clamp(changes.reduce((sum, value) => sum + value, 0) / changes.length);
}

function routeWorkloadForSlice(routes, sliceIndex) {
  const nodeTraffic = new Map();
  const linkTraffic = new Map();
  routes
    .filter((route) => numberValue(route.slice_index, -1) === sliceIndex)
    .forEach((route) => {
      const traffic = Math.max(0, numberValue(route.traffic_mbps));
      splitPath(route.path).forEach((nodeId) => nodeTraffic.set(nodeId, numberValue(nodeTraffic.get(nodeId)) + traffic));
      splitPath(route.link_ids).forEach((linkId) => linkTraffic.set(linkId, numberValue(linkTraffic.get(linkId)) + traffic));
    });
  const maxNodeTraffic = Math.max(0, ...nodeTraffic.values());
  const maxLinkTraffic = Math.max(0, ...linkTraffic.values());
  return {
    node: new Map([...nodeTraffic].map(([id, value]) => [id, maxNodeTraffic > 0 ? value / maxNodeTraffic : 0])),
    link: new Map([...linkTraffic].map(([id, value]) => [id, maxLinkTraffic > 0 ? value / maxLinkTraffic : 0])),
  };
}

function linkRisk(row) {
  const availabilityRisk = 1 - clamp(row.p_available ?? row.availability_factor, 0, 1);
  const stateRisk = !boolValue(row.is_active ?? true) || String(row.status ?? "up").toLowerCase() === "down" ? 1 : 0;
  const conflictRisk = clamp(row.conflict_severity ?? row.oam_conflict_severity);
  return clamp(availabilityRisk * 0.65 + stateRisk * 0.25 + conflictRisk * 0.1);
}

function targetReason(components, {
  mandatory,
  overdue = mandatory,
  refreshDue = false,
  lowAvailability = false,
  mode = "",
} = {}) {
  const reasons = [];
  if (overdue) reasons.push(mandatory ? "aoi-overdue-mandatory" : "aoi-overdue-fairness");
  else if (refreshDue) reasons.push("aoi-predeadline-refresh");
  if (components.uncertainty >= 0.45) reasons.push("low-confidence");
  if (components.volatility >= 0.15) reasons.push("state-volatility");
  if (components.business >= 0.5) reasons.push("business-path");
  if (components.risk >= 0.45 || lowAvailability) reasons.push("predictable-risk");
  if (components.criticality >= 0.7) reasons.push("causal-critical-state");
  if (["warning", "power-saving", "offline"].includes(String(mode).toLowerCase())) reasons.push("node-mode-risk");
  return reasons.join(" > ") || "rolling-importance";
}

function scoreComponents(components, weights) {
  return round(Object.entries(weights).reduce(
    (total, [key, weight]) => total + clamp(components[key]) * weight,
    0,
  ));
}

function targetQuota(count, ratio) {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(count, Math.ceil(count * clamp(ratio, 0, 1))));
}

function orbitalCoordinate(id) {
  const match = String(id ?? "").match(/P(\d+)-S(\d+)/i);
  return match
    ? { plane: Number(match[1]) - 1, slot: Number(match[2]) - 1 }
    : { plane: undefined, slot: undefined };
}

export function buildRotatingPlaneRepresentatives({
  nodes = [],
  sliceIndex = 0,
  representativeRatio = 0,
} = {}) {
  const byPlane = new Map();
  nodes.forEach((node) => {
    const nodeId = String(node.node_id ?? node.id ?? "");
    if (!nodeId) return;
    const parsed = orbitalCoordinate(nodeId);
    const plane = parsed.plane ?? optionalNumber(node.plane_id ?? node.plane);
    const slot = parsed.slot ?? optionalNumber(node.slot_id ?? node.slot) ?? 0;
    if (plane === undefined) return;
    const key = Number(plane);
    if (!byPlane.has(key)) byPlane.set(key, []);
    byPlane.get(key).push({ nodeId, slot: Number(slot) });
  });
  const representatives = new Set();
  [...byPlane.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([plane, planeNodes], planePosition) => {
      const ordered = [...planeNodes].sort((left, right) =>
        left.slot - right.slot || left.nodeId.localeCompare(right.nodeId)
      );
      if (ordered.length === 0) return;
      const representativeCount = representativeRatio > 0
        ? Math.max(1, Math.min(ordered.length, Math.ceil(ordered.length * clamp(representativeRatio))))
        : 1;
      const start = ((Math.floor(numberValue(sliceIndex)) + planePosition + plane) % ordered.length + ordered.length) % ordered.length;
      for (let index = 0; index < representativeCount; index += 1) {
        const offset = Math.floor(index * ordered.length / representativeCount);
        representatives.add(ordered[(start + offset) % ordered.length].nodeId);
      }
    });
  return representatives;
}

function refreshGroupForTarget(candidate) {
  if (candidate.target_type === "node") {
    const parsed = orbitalCoordinate(candidate.target_id);
    const slot = optionalNumber(candidate.slot) ?? parsed.slot;
    if (slot !== undefined) return `node-slot:${slot}`;
  }
  if (candidate.target_type === "link") {
    const source = orbitalCoordinate(candidate.source);
    const target = orbitalCoordinate(candidate.target);
    if (source.plane !== undefined && source.plane === target.plane) return `link-plane:${source.plane}`;
    if (source.slot !== undefined && source.slot === target.slot) return `link-slot:${source.slot}`;
  }
  return `${candidate.target_type}:${candidate.target_id}`;
}

function withCyclicRefreshSchedule(candidates, sliceIndex, maxAoISlices) {
  const cycle = Math.max(1, Math.floor(numberValue(maxAoISlices, 1)));
  const groupKeys = [...new Set(candidates.map(refreshGroupForTarget))].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
  const bucketByGroup = new Map(groupKeys.map((group, index) => [group, index % cycle]));
  const activeBucket = ((sliceIndex % cycle) + cycle) % cycle;
  return candidates.map((candidate) => {
    const refreshGroup = refreshGroupForTarget(candidate);
    const refreshBucket = bucketByGroup.get(refreshGroup) ?? 0;
    const refreshDue = refreshBucket === activeBucket;
    return {
      ...candidate,
      refresh_due: refreshDue,
      refresh_group: refreshGroup,
      refresh_bucket: refreshBucket,
      refresh_cycle_slices: cycle,
      coverage_required: candidate.coverage_required || refreshDue,
      reason: targetReason(candidate.components, {
        mandatory: candidate.mandatory,
        overdue: numberValue(candidate.aoi_debt_severity) > 0,
        refreshDue,
        lowAvailability: candidate.low_availability,
        mode: candidate.mode,
      }),
    };
  });
}

function selectTargets({ candidates, quota, explorationRatio, groupField, includeAllCoverageRequired = false }) {
  const ordered = [...candidates].sort((left, right) =>
    Number(right.mandatory) - Number(left.mandatory) ||
    Number(right.coverage_required) - Number(left.coverage_required) ||
    numberValue(right.aoi_debt_severity) - numberValue(left.aoi_debt_severity) ||
    Number(right.refresh_due) - Number(left.refresh_due) ||
    right.importance_score - left.importance_score ||
    String(left.target_id).localeCompare(String(right.target_id))
  );
  const mandatory = ordered.filter((item) => item.mandatory);
  const effectiveQuota = Math.max(quota, mandatory.length);
  const required = includeAllCoverageRequired
    ? ordered.filter((item) => item.coverage_required && !item.mandatory)
    : [];
  const selected = [...mandatory, ...required];
  const selectedIds = new Set(selected.map((item) => item.target_id));
  ordered
    .filter((item) => item.refresh_due && !selectedIds.has(item.target_id))
    .slice(0, Math.max(0, effectiveQuota - selected.length))
    .forEach((item) => {
      selected.push({
        ...item,
        target_class: "exploration",
        reason: `${item.reason} > orbit-cohort-refresh`,
      });
      selectedIds.add(item.target_id);
    });
  const remainingSlots = Math.max(0, effectiveQuota - selected.length);
  const explorationSlots = groupField && remainingSlots > 0
    ? Math.min(remainingSlots, Math.ceil(effectiveQuota * clamp(explorationRatio)))
    : 0;
  const prioritySlots = Math.max(0, remainingSlots - explorationSlots);

  ordered
    .filter((item) =>
      !item.mandatory &&
      !selectedIds.has(item.target_id) &&
      (item.coverage_required || item.importance_score >= item.minimum_score)
    )
    .slice(0, prioritySlots)
    .forEach((item) => {
      const refreshExploration = item.refresh_due && numberValue(item.aoi_debt_severity) <= 0;
      selected.push({
        ...item,
        target_class: refreshExploration ? "exploration" : "priority",
        reason: refreshExploration ? `${item.reason} > cyclic-exploration` : item.reason,
      });
      selectedIds.add(item.target_id);
    });

  if (explorationSlots > 0) {
    const representedGroups = new Set(selected.map((item) => String(item[groupField] ?? "")));
    const exploration = ordered
      .filter((item) => !selectedIds.has(item.target_id))
      .filter((item) => !representedGroups.has(String(item[groupField] ?? "")))
      .sort((left, right) =>
        right.components.fairness - left.components.fairness ||
        right.importance_score - left.importance_score ||
        String(left.target_id).localeCompare(String(right.target_id))
      )
      .slice(0, explorationSlots);
    exploration.forEach((item) => {
      selected.push({ ...item, target_class: "exploration", reason: `${item.reason} > plane-exploration` });
      selectedIds.add(item.target_id);
      representedGroups.add(String(item[groupField] ?? ""));
    });
  }

  if (selected.length < effectiveQuota) {
    ordered
      .filter((item) =>
        !selectedIds.has(item.target_id) && (item.coverage_required || item.importance_score >= item.minimum_score)
      )
      .slice(0, effectiveQuota - selected.length)
      .forEach((item) => {
        const refreshExploration = item.refresh_due && numberValue(item.aoi_debt_severity) <= 0;
        selected.push({
          ...item,
          target_class: refreshExploration ? "exploration" : "priority",
          reason: refreshExploration ? `${item.reason} > cyclic-exploration` : item.reason,
        });
      });
  }
  return selected;
}

export function buildImportanceAwareTargetPlan({
  slices = [],
  nodes = [],
  links = [],
  routes = [],
  options = {},
} = {}) {
  const settings = {
    windowSize: Math.max(2, Math.floor(numberValue(options.windowSize, 6))),
    nodeTargetRatio: clamp(options.nodeTargetRatio ?? 0.25),
    linkTargetRatio: clamp(options.linkTargetRatio ?? 0.25),
    maxAoISlices: Math.max(1, Math.floor(numberValue(options.maxAoISlices, 6))),
    explorationRatio: clamp(options.explorationRatio ?? 0.08),
    minimumScore: clamp(options.minimumScore ?? 0.12),
    weights: normalizeWeights(options.weights),
  };
  const requestedSlices = [...new Set(slices.map((value) => numberValue(value)))].sort((left, right) => left - right);
  const rows = [];
  const bySlice = new Map();
  const rejectedCounter = { count: 0 };

  requestedSlices.forEach((sliceIndex) => {
    const causalNodes = causalRowsForSlice(nodes, sliceIndex, rejectedCounter);
    const causalLinks = causalRowsForSlice(links, sliceIndex, rejectedCounter);
    const causalRoutes = causalRowsForSlice(routes, sliceIndex, rejectedCounter);
    const windowStart = sliceIndex - settings.windowSize + 1;
    const windowNodes = causalNodes.filter((row) => numberValue(row.slice_index, -1) >= windowStart);
    const windowLinks = causalLinks.filter((row) => numberValue(row.slice_index, -1) >= windowStart);
    const nodeHistory = groupBy(windowNodes, (row) => String(row.node_id ?? ""));
    const linkHistory = groupBy(windowLinks, (row) => String(row.link_id ?? ""));
    const latestNodes = latestRowsById(causalNodes, "node_id");
    const latestLinks = latestRowsById(causalLinks, "link_id");
    const workload = routeWorkloadForSlice(causalRoutes, sliceIndex);
    const incidentRisk = new Map();
    latestLinks.forEach((link) => {
      const risk = linkRisk(link);
      [link.source, link.target].filter(Boolean).forEach((nodeId) => {
        incidentRisk.set(nodeId, Math.max(numberValue(incidentRisk.get(nodeId)), risk));
      });
    });

    const nodeCandidates = withCyclicRefreshSchedule([...latestNodes.values()].map((node) => {
      const id = String(node.node_id);
      const confidence = clamp(node.planner_state_confidence ?? node.confidence, 0, 1);
      const ageSlices = stateAgeAtTarget(node, sliceIndex);
      const mode = String(node.mode ?? node.mode_estimate ?? "unknown").toLowerCase();
      const powerRisk = clamp((35 - numberValue(node.energy_percent, 100)) / 35);
      const modeRisk = ["warning", "power-saving", "offline"].includes(mode) ? 1 : 0;
      const stateCriticality = Math.max(
        clamp(numberValue(node.cpu_percent) / 100),
        clamp(numberValue(node.queue_depth) / 100),
        clamp(numberValue(node.queued_traffic_mb) / 1024),
        modeRisk,
      );
      const components = {
        uncertainty: clamp(1 - confidence + clamp(node.conflict_severity ?? node.oam_conflict_severity) * 0.2),
        age: clamp(ageSlices / settings.maxAoISlices),
        volatility: normalizedMeanAbsoluteChange(nodeHistory.get(id) ?? [], [
          { name: "cpu_percent", scale: 100 },
          { name: "queue_depth", scale: 100 },
          { name: "energy_percent", scale: 100 },
        ]),
        business: clamp(workload.node.get(id)),
        risk: clamp(numberValue(incidentRisk.get(id)) * 0.55 + powerRisk * 0.25 + modeRisk * 0.2),
        fairness: clamp(ageSlices / settings.maxAoISlices),
        criticality: stateCriticality,
      };
      const overdue = ageSlices >= settings.maxAoISlices;
      const mandatory = overdue && hasDirectObservationHistory(node);
      return {
        slice_index: sliceIndex,
        source_slice_index: numberValue(sourceSliceFor(node), sliceIndex - 1),
        target_type: "node",
        target_id: id,
        plane: node.plane ?? node.plane_id ?? "",
        slot: node.slot ?? node.slot_id ?? "",
        mode,
        mandatory,
        coverage_required: overdue,
        state_age_slices: ageSlices,
        aoi_debt_severity: overdue ? round(ageSlices / settings.maxAoISlices) : 0,
        target_class: mandatory ? "mandatory" : "priority",
        minimum_score: settings.minimumScore,
        components,
        importance_score: scoreComponents(components, settings.weights),
        reason: targetReason(components, { mandatory, overdue, mode }),
      };
    }), sliceIndex, settings.maxAoISlices);

    const linkCandidates = withCyclicRefreshSchedule([...latestLinks.values()].map((link) => {
      const id = String(link.link_id);
      const confidence = clamp(link.planner_state_confidence ?? link.confidence, 0, 1);
      const ageSlices = stateAgeAtTarget(link, sliceIndex);
      const predictableRisk = linkRisk(link);
      const stateCriticality = Math.max(
        clamp(numberValue(link.utilization_percent) / 100),
        clamp(numberValue(link.congestion_percent) / 100),
        clamp(numberValue(link.queue_latency_ms) / 200),
        !boolValue(link.is_active ?? true) || String(link.status ?? "up").toLowerCase() === "down" ? 1 : 0,
      );
      const components = {
        uncertainty: clamp(1 - confidence + clamp(link.conflict_severity ?? link.oam_conflict_severity) * 0.2),
        age: clamp(ageSlices / settings.maxAoISlices),
        volatility: normalizedMeanAbsoluteChange(linkHistory.get(id) ?? [], [
          { name: "utilization_percent", scale: 100 },
          { name: "queue_latency_ms", scale: 200 },
        ]),
        business: clamp(workload.link.get(id)),
        risk: predictableRisk,
        fairness: clamp(ageSlices / settings.maxAoISlices),
        criticality: stateCriticality,
      };
      const overdue = ageSlices >= settings.maxAoISlices;
      const mandatory = overdue && hasDirectObservationHistory(link) || predictableRisk >= 0.8;
      return {
        slice_index: sliceIndex,
        source_slice_index: numberValue(sourceSliceFor(link), sliceIndex - 1),
        target_type: "link",
        target_id: id,
        source: link.source ?? "",
        target: link.target ?? "",
        low_availability: predictableRisk >= 0.8,
        mandatory,
        coverage_required: overdue,
        state_age_slices: ageSlices,
        aoi_debt_severity: overdue ? round(ageSlices / settings.maxAoISlices) : 0,
        target_class: mandatory ? "mandatory" : "priority",
        minimum_score: settings.minimumScore,
        components,
        importance_score: scoreComponents(components, settings.weights),
        reason: targetReason(components, {
          mandatory,
          overdue,
          lowAvailability: predictableRisk >= 0.8,
        }),
      };
    }), sliceIndex, settings.maxAoISlices);

    const selectedNodes = selectTargets({
      candidates: nodeCandidates,
      quota: targetQuota(nodeCandidates.length, settings.nodeTargetRatio),
      explorationRatio: settings.explorationRatio,
      groupField: "plane",
    });
    const selectedLinks = selectTargets({
      candidates: linkCandidates,
      quota: targetQuota(linkCandidates.length, settings.linkTargetRatio),
      explorationRatio: 0,
      groupField: "",
    });
    const selected = [...selectedNodes, ...selectedLinks].map((item) => ({
      slice_index: item.slice_index,
      source_slice_index: item.source_slice_index,
      target_type: item.target_type,
      target_id: item.target_id,
      importance_score: item.importance_score,
      uncertainty_score: round(item.components.uncertainty),
      age_score: round(item.components.age),
      volatility_score: round(item.components.volatility),
      business_score: round(item.components.business),
      predictable_risk_score: round(item.components.risk),
      fairness_score: round(item.components.fairness),
      criticality_score: round(item.components.criticality),
      target_class: item.target_class,
      mandatory: item.mandatory,
      coverage_required: item.coverage_required,
      refresh_due: item.refresh_due,
      refresh_group: item.refresh_group,
      refresh_bucket: item.refresh_bucket,
      refresh_cycle_slices: item.refresh_cycle_slices,
      state_age_slices: round(item.state_age_slices),
      aoi_debt_severity: round(item.aoi_debt_severity),
      reason: item.reason,
      plane: item.plane ?? "",
      source: item.source ?? "",
      target: item.target ?? "",
    }));
    selected.sort((left, right) =>
      String(left.target_type).localeCompare(String(right.target_type)) ||
      Number(right.mandatory) - Number(left.mandatory) ||
      right.importance_score - left.importance_score ||
      String(left.target_id).localeCompare(String(right.target_id))
    );
    bySlice.set(sliceIndex, selected);
    rows.push(...selected);
  });

  return {
    rows,
    bySlice,
    summary: {
      slice_count: requestedSlices.length,
      target_count: rows.length,
      node_target_count: rows.filter((row) => row.target_type === "node").length,
      link_target_count: rows.filter((row) => row.target_type === "link").length,
      mandatory_target_count: rows.filter((row) => row.mandatory).length,
      coverage_required_target_count: rows.filter((row) => row.coverage_required).length,
      refresh_due_target_count: rows.filter((row) => row.refresh_due).length,
      exploration_target_count: rows.filter((row) => row.target_class === "exploration").length,
      rejected_noncausal_rows: rejectedCounter.count,
      options: settings,
      causal_boundary: "source_slice_index < target_slice_index",
    },
  };
}

function idSet(value) {
  if (value instanceof Set) return new Set(value);
  if (value instanceof Map) return new Set(value.keys());
  if (Array.isArray(value)) {
    return new Set(value.map((item) => typeof item === "object" ? item.target_id ?? item.id : item).filter(Boolean));
  }
  return new Set();
}

export function buildPathMetadataPlan({
  pathNodes = [],
  pathLinks = [],
  nodeTargets = new Set(),
  linkTargets = new Set(),
  observedNodes = new Set(),
  observedLinks = new Set(),
  representativeNodes = new Set(),
  fieldProfile = DEFAULT_SELECTIVE_METADATA_PROFILE,
  preserveCoreNodeCoverage = false,
  preserveCoreLinkMetrics = false,
  preserveNonTargetLinks = true,
} = {}) {
  const nodes = Array.isArray(pathNodes) ? pathNodes.map(String) : splitPath(pathNodes);
  const links = Array.isArray(pathLinks) ? pathLinks.map(String) : splitPath(pathLinks);
  const requiredNodes = idSet(nodeTargets);
  const requiredLinks = idSet(linkTargets);
  const representativeNodeIds = idSet(representativeNodes);
  const seenNodes = idSet(observedNodes);
  const seenLinks = idSet(observedLinks);
  const profile = { ...DEFAULT_SELECTIVE_METADATA_PROFILE, ...(fieldProfile ?? {}) };
  const nonTargetLinkFields = preserveCoreLinkMetrics ? profile.link_core_fields : profile.link_light_fields;
  const nonTargetLinkBytes = preserveCoreLinkMetrics
    ? numberValue(profile.link_core_bytes, 48)
    : numberValue(profile.link_light_bytes, 20);
  const nonTargetLinkProfile = preserveCoreLinkMetrics ? "link-core" : "link-light";
  const hops = nodes.map((nodeId, hopIndex) => {
    const ingressLinkId = hopIndex > 0 ? links[hopIndex - 1] ?? "" : "";
    const egressLinkId = hopIndex < links.length ? links[hopIndex] ?? "" : "";
    const needsNode = requiredNodes.has(nodeId) && !seenNodes.has(nodeId);
    const needsCoreNode = (representativeNodeIds.has(nodeId) || preserveCoreNodeCoverage) && !seenNodes.has(nodeId);
    const needsFullLink = Boolean(egressLinkId) && requiredLinks.has(egressLinkId) && !seenLinks.has(egressLinkId);
    const needsLightLink = preserveNonTargetLinks && Boolean(egressLinkId) && !seenLinks.has(egressLinkId);
    let metadataProfile = "forward-only";
    let nodeFields = [];
    let linkFields = [];
    let metadataBytes = numberValue(profile.forward_only_bytes);
    let reason = "already-covered-or-pure-transit";

    if (needsNode) {
      metadataProfile = "node-full";
      nodeFields = [...profile.node_full_fields];
      linkFields = needsFullLink
        ? [...profile.link_full_fields]
        : needsLightLink
          ? [...nonTargetLinkFields]
          : [];
      metadataBytes = numberValue(profile.node_full_bytes, 96);
      reason = needsFullLink ? "important-node-and-link" : "important-node";
      seenNodes.add(nodeId);
      if (egressLinkId && linkFields.length > 0) seenLinks.add(egressLinkId);
    } else if (needsCoreNode) {
      metadataProfile = needsFullLink
        ? "node-core-link-full"
        : needsLightLink
          ? `node-core-${nonTargetLinkProfile}`
          : "node-core";
      nodeFields = [...profile.node_core_fields];
      linkFields = needsFullLink
        ? [...profile.link_full_fields]
        : needsLightLink
          ? [...nonTargetLinkFields]
          : [];
      metadataBytes = numberValue(profile.node_core_bytes, 32) + (
        needsFullLink
          ? numberValue(profile.link_full_bytes, 48)
          : needsLightLink
            ? nonTargetLinkBytes
            : 0
      );
      const representativeReason = representativeNodeIds.has(nodeId) ? "rotating-plane-representative" : "opportunistic-core-node";
      reason = needsFullLink
        ? `${representativeReason}-and-important-link`
        : needsLightLink
          ? `${representativeReason}-and-first-link`
          : representativeReason;
      seenNodes.add(nodeId);
      if (egressLinkId && linkFields.length > 0) seenLinks.add(egressLinkId);
    } else if (needsFullLink) {
      metadataProfile = "link-full";
      linkFields = [...profile.link_full_fields];
      metadataBytes = numberValue(profile.link_full_bytes, 48);
      reason = "important-link";
      seenLinks.add(egressLinkId);
    } else if (needsLightLink) {
      metadataProfile = nonTargetLinkProfile;
      linkFields = [...nonTargetLinkFields];
      metadataBytes = nonTargetLinkBytes;
      reason = "first-path-link-observation";
      seenLinks.add(egressLinkId);
    }

    return {
      hop_index: hopIndex,
      node_id: nodeId,
      ingress_link_id: ingressLinkId,
      egress_link_id: egressLinkId,
      profile: metadataProfile,
      node_fields_present: nodeFields,
      link_fields_present: linkFields,
      metadata_bytes: round(metadataBytes),
      writes_observation: nodeFields.length > 0 || linkFields.length > 0,
      reason,
    };
  });
  const targetMaskBytes = Math.max(0, Math.ceil(
    numberValue(profile.instruction_header_bytes, 4) +
    nodes.length * numberValue(profile.profile_bits_per_hop, 2) / 8,
  ));
  const metadataBytes = round(hops.reduce((sum, hop) => sum + hop.metadata_bytes, 0));
  const totalPayloadBytes = round(metadataBytes + targetMaskBytes);
  const allFullPayloadBytes = round(nodes.length * numberValue(profile.node_full_bytes, 96) + targetMaskBytes);
  return {
    hops,
    target_mask_bytes: targetMaskBytes,
    metadata_bytes: metadataBytes,
    total_payload_bytes: totalPayloadBytes,
    all_full_payload_bytes: allFullPayloadBytes,
    saved_payload_bytes: round(Math.max(0, allFullPayloadBytes - totalPayloadBytes)),
    observed_node_ids: [...seenNodes],
    observed_link_ids: [...seenLinks],
  };
}

function normalizeTargetRows(targets = [], mandatoryTargets = {}) {
  const normalized = new Map();
  targets.forEach((target) => {
    const type = String(target.target_type ?? target.type ?? "").toLowerCase();
    const id = String(target.target_id ?? target.id ?? "");
    if (!id || (type !== "node" && type !== "link")) return;
    normalized.set(`${type}|${id}`, {
      ...target,
      target_type: type,
      target_id: id,
      importance_score: clamp(target.importance_score ?? target.priority_score ?? 0.5),
      mandatory: boolValue(target.mandatory),
      coverage_required: boolValue(target.coverage_required) || numberValue(target.age_score) >= 1,
      explicit_aoi_debt_severity: Math.max(0, numberValue(target.aoi_debt_severity)),
      aoi_debt_severity: Math.max(
        boolValue(target.coverage_required) ? 1 : 0,
        numberValue(target.aoi_debt_severity, numberValue(target.age_score)),
      ),
    });
  });
  const mandatoryNodes = idSet(mandatoryTargets?.nodes);
  const mandatoryLinks = idSet(mandatoryTargets?.links);
  [["node", mandatoryNodes], ["link", mandatoryLinks]].forEach(([type, ids]) => {
    ids.forEach((id) => {
      const key = `${type}|${id}`;
      const current = normalized.get(key);
      normalized.set(key, {
        ...(current ?? {}),
        target_type: type,
        target_id: id,
        importance_score: Math.max(0.75, numberValue(current?.importance_score)),
        mandatory: true,
      });
    });
  });
  return [...normalized.values()];
}

function targetGainForPath({
  pathNodes,
  pathLinks,
  targets,
  coveredTargetKeys = new Set(),
  mandatoryBonus = 1,
  includeAdjacentLinkTargets = false,
}) {
  const nodeIds = new Set(pathNodes);
  const linkIds = new Set(pathLinks);
  const hits = targets.filter((target) =>
    !coveredTargetKeys.has(`${target.target_type}|${target.target_id}`) &&
    (target.target_type === "node"
      ? nodeIds.has(target.target_id)
      : linkIds.has(target.target_id) || includeAdjacentLinkTargets && (
        nodeIds.has(String(target.source ?? "")) || nodeIds.has(String(target.target ?? ""))
      ))
  );
  return {
    hits,
    gain: round(hits.reduce(
      (sum, target) => sum + numberValue(target.importance_score) + (target.mandatory ? mandatoryBonus : 0),
      0,
    )),
    mandatoryHits: hits.filter((target) => target.mandatory).length,
    coverageRequiredHits: hits.filter((target) => target.coverage_required).length,
    coverageRequiredSeverity: round(hits
      .filter((target) => target.coverage_required)
      .reduce((sum, target) => sum + numberValue(target.aoi_debt_severity, 1), 0)),
  };
}

export function currentSelectionImportanceRepairFields({
  row = {},
  selectedAsRepair = false,
} = {}) {
  const isCurrentRepair = selectedAsRepair === true;
  return {
    planning_importance_additive_repair: isCurrentRepair,
    planning_importance_repair_actual_bytes: isCurrentRepair
      ? row.planning_importance_repair_actual_bytes ?? ""
      : "",
    planning_importance_repair_target_ids: isCurrentRepair
      ? row.planning_importance_repair_target_ids ?? ""
      : "",
  };
}

function rowWithMetadataPlan({
  row,
  targets,
  observedNodes,
  observedLinks,
  coveredTargetKeys,
  representativeNodes,
  fieldProfile,
  preserveCoreNodeCoverage,
  preserveCoreLinkMetrics,
  preserveAdjacentLinkCoverage,
  preserveNonTargetLinks,
  preserveEndpointNodeCoverage = false,
  allowTargetNeighborhoodLinks = false,
}) {
  const pathNodes = splitPath(row.path);
  const pathLinks = splitPath(row.link_ids);
  const nodeTargets = new Set(targets
    .filter((target) => target.target_type === "node")
    .map((target) => target.target_id));
  const linkTargets = new Set(targets.filter((target) => target.target_type === "link").map((target) => target.target_id));
  const gain = targetGainForPath({
    pathNodes,
    pathLinks,
    targets,
    coveredTargetKeys,
    includeAdjacentLinkTargets: allowTargetNeighborhoodLinks,
  });
  const pathNodeIds = new Set(pathNodes);
  const pathLinkIds = new Set(pathLinks);
  const adjacentLinkTargetIds = gain.hits
    .filter((target) => target.target_type === "link" && !pathLinkIds.has(target.target_id))
    .filter((target) =>
      pathNodeIds.has(String(target.source ?? "")) || pathNodeIds.has(String(target.target ?? ""))
    )
    .map((target) => target.target_id);
  const targetedAdjacentLinkCoverage = allowTargetNeighborhoodLinks && adjacentLinkTargetIds.length > 0;
  const effectiveRepresentativeNodes = idSet(representativeNodes);
  if (preserveEndpointNodeCoverage && pathNodes.length > 0) {
    effectiveRepresentativeNodes.add(pathNodes[0]);
    effectiveRepresentativeNodes.add(pathNodes[pathNodes.length - 1]);
  }
  const metadataPlan = buildPathMetadataPlan({
    pathNodes,
    pathLinks,
    nodeTargets,
    linkTargets,
    observedNodes,
    observedLinks,
    representativeNodes: effectiveRepresentativeNodes,
    fieldProfile,
    preserveCoreNodeCoverage,
    preserveCoreLinkMetrics,
    preserveNonTargetLinks,
  });
  gain.hits.forEach((target) => coveredTargetKeys.add(`${target.target_type}|${target.target_id}`));
  const payloadKb = Math.max(metadataPlan.total_payload_bytes / 1024, 1 / 1024);
  return {
    ...row,
    adaptive_metadata_profile: "importance-selective",
    adaptive_metadata_profile_policy: "causal-importance-per-hop-field-mask",
    adaptive_metadata_profile_reason: gain.hits.length > 0 ? "importance-target-on-path" : "non-target-transit-compression",
    adaptive_link_observation_mode: targetedAdjacentLinkCoverage
      ? "target-neighborhood"
      : preserveAdjacentLinkCoverage ? "all-adjacent" : "path-only",
    adaptive_link_observation_policy: targetedAdjacentLinkCoverage
      ? "declared-field-mask-plus-nominated-local-link"
      : preserveAdjacentLinkCoverage
      ? "declared-path-mask-plus-core-adjacent-links"
      : "declared-field-mask-only",
    selective_adjacent_link_profile: targetedAdjacentLinkCoverage
      ? "link-core"
      : preserveAdjacentLinkCoverage
      ? preserveCoreLinkMetrics ? "link-core" : "link-light"
      : "disabled",
    importance_adjacent_link_target_ids: adjacentLinkTargetIds.join(" > "),
    importance_adjacent_link_target_count: adjacentLinkTargetIds.length,
    selective_metadata_enabled: true,
    selective_metadata_plan_json: JSON.stringify(metadataPlan.hops),
    metadata_hop_profiles: metadataPlan.hops.map((hop) => hop.profile).join(" > "),
    metadata_hop_bytes: metadataPlan.hops.map((hop) => hop.metadata_bytes).join(" > "),
    metadata_node_field_masks: JSON.stringify(metadataPlan.hops.map((hop) => hop.node_fields_present)),
    metadata_link_field_masks: JSON.stringify(metadataPlan.hops.map((hop) => hop.link_fields_present)),
    target_mask_bytes: metadataPlan.target_mask_bytes,
    selective_metadata_bytes: metadataPlan.metadata_bytes,
    selective_metadata_payload_bytes: metadataPlan.total_payload_bytes,
    selective_metadata_saved_bytes: metadataPlan.saved_payload_bytes,
    importance_new_target_count: gain.hits.length,
    importance_mandatory_target_hits: gain.mandatoryHits,
    importance_coverage_required_target_hits: gain.coverageRequiredHits,
    importance_coverage_required_severity: gain.coverageRequiredSeverity,
    importance_target_gain: gain.gain,
    importance_gain_per_kb: round(gain.gain / payloadKb),
    importance_target_ids: gain.hits.map((target) => `${target.target_type}:${target.target_id}`).join(" > "),
    plane_representative_hop_count: metadataPlan.hops.filter((hop) =>
      String(hop.reason ?? "").startsWith("rotating-plane-representative")
    ).length,
    forward_only_hop_count: metadataPlan.hops.filter((hop) => !hop.writes_observation).length,
    node_state_omitted_hop_count: metadataPlan.hops.filter((hop) => hop.node_fields_present.length === 0).length,
  };
}

export function attachImportanceAwareMetadataPlans({
  rows = [],
  targetsBySlice = new Map(),
  mandatoryTargetsBySlice = new Map(),
  representativeNodesBySlice = new Map(),
  fieldProfile = DEFAULT_SELECTIVE_METADATA_PROFILE,
  preserveCoreNodeCoverage = true,
  preserveCoreLinkMetrics = true,
  preserveAdjacentLinkCoverage = true,
  preserveNonTargetLinks = true,
  preserveEndpointNodeCoverage = false,
} = {}) {
  const observedNodesBySlice = new Map();
  const observedLinksBySlice = new Map();
  const coveredTargetsBySlice = new Map();
  const outputRows = rows.map((row) => {
    const sliceIndex = numberValue(row.slice_index);
    if (!observedNodesBySlice.has(sliceIndex)) observedNodesBySlice.set(sliceIndex, new Set());
    if (!observedLinksBySlice.has(sliceIndex)) observedLinksBySlice.set(sliceIndex, new Set());
    if (!coveredTargetsBySlice.has(sliceIndex)) coveredTargetsBySlice.set(sliceIndex, new Set());
    const targets = normalizeTargetRows(
      targetsBySlice.get(sliceIndex) ?? targetsBySlice.get(String(sliceIndex)) ?? [],
      mandatoryTargetsBySlice.get(sliceIndex) ?? mandatoryTargetsBySlice.get(String(sliceIndex)) ?? {},
    );
    const additiveRepair = boolValue(row.planning_importance_additive_repair);
    return rowWithMetadataPlan({
      row,
      targets,
      observedNodes: observedNodesBySlice.get(sliceIndex),
      observedLinks: observedLinksBySlice.get(sliceIndex),
      coveredTargetKeys: coveredTargetsBySlice.get(sliceIndex),
      representativeNodes: representativeNodesBySlice.get(sliceIndex) ??
        representativeNodesBySlice.get(String(sliceIndex)) ?? new Set(),
      fieldProfile,
      preserveCoreNodeCoverage: additiveRepair ? true : preserveCoreNodeCoverage,
      preserveCoreLinkMetrics: additiveRepair ? true : preserveCoreLinkMetrics,
      preserveAdjacentLinkCoverage: additiveRepair ? false : preserveAdjacentLinkCoverage,
      preserveNonTargetLinks,
      preserveEndpointNodeCoverage,
      allowTargetNeighborhoodLinks: additiveRepair,
    });
  });
  return {
    rows: outputRows,
    summary: {
      path_count: outputRows.length,
      metadata_bytes: round(outputRows.reduce((sum, row) => sum + numberValue(row.selective_metadata_bytes), 0)),
      target_mask_bytes: round(outputRows.reduce((sum, row) => sum + numberValue(row.target_mask_bytes), 0)),
      saved_payload_bytes: round(outputRows.reduce((sum, row) => sum + numberValue(row.selective_metadata_saved_bytes), 0)),
      target_hits: outputRows.reduce((sum, row) => sum + numberValue(row.importance_new_target_count), 0),
      mandatory_target_hits: outputRows.reduce((sum, row) => sum + numberValue(row.importance_mandatory_target_hits), 0),
      coverage_required_target_hits: outputRows.reduce(
        (sum, row) => sum + numberValue(row.importance_coverage_required_target_hits),
        0,
      ),
      coverage_required_severity: round(outputRows.reduce(
        (sum, row) => sum + numberValue(row.importance_coverage_required_severity),
        0,
      )),
      plane_representative_hops: outputRows.reduce(
        (sum, row) => sum + numberValue(row.plane_representative_hop_count),
        0,
      ),
      forward_only_hops: outputRows.reduce(
        (sum, row) => sum + numberValue(row.forward_only_hop_count),
        0,
      ),
      node_state_omitted_hops: outputRows.reduce(
        (sum, row) => sum + numberValue(row.node_state_omitted_hop_count),
        0,
      ),
    },
  };
}

export function rankPathsByImportanceEfficiency({
  rows = [],
  targets = [],
  mandatoryTargets = {},
  fieldProfile = DEFAULT_SELECTIVE_METADATA_PROFILE,
  preserveCoreNodeCoverage = true,
  preserveCoreLinkMetrics = true,
} = {}) {
  const normalizedTargets = normalizeTargetRows(targets, mandatoryTargets);
  return rows
    .map((row) => rowWithMetadataPlan({
      row,
      targets: normalizedTargets,
      observedNodes: new Set(),
      observedLinks: new Set(),
      coveredTargetKeys: new Set(),
      fieldProfile,
      preserveCoreNodeCoverage,
      preserveCoreLinkMetrics,
      preserveAdjacentLinkCoverage: true,
      preserveNonTargetLinks: true,
      allowTargetNeighborhoodLinks: false,
    }))
    .sort((left, right) =>
      numberValue(right.importance_mandatory_target_hits) - numberValue(left.importance_mandatory_target_hits) ||
      numberValue(right.importance_coverage_required_target_hits) - numberValue(left.importance_coverage_required_target_hits) ||
      numberValue(right.importance_coverage_required_severity) - numberValue(left.importance_coverage_required_severity) ||
      numberValue(right.importance_gain_per_kb) - numberValue(left.importance_gain_per_kb) ||
      String(left.probe_id ?? "").localeCompare(String(right.probe_id ?? ""))
    );
}

function repairPathKey(row) {
  return `${String(row?.slice_index ?? "")}|${String(row?.path ?? "")}|${String(row?.link_ids ?? "")}`;
}

function repairCandidateEvidence({
  row,
  targets,
  coveredTargetKeys,
  observedNodes,
  observedLinks,
  fieldProfile,
  probePacketBaseBytes,
  reportHeaderBytes,
  criticalityThreshold,
}) {
  const pathNodes = splitPath(row.path);
  const pathLinks = splitPath(row.link_ids);
  const gain = targetGainForPath({
    pathNodes,
    pathLinks,
    targets,
    coveredTargetKeys,
    includeAdjacentLinkTargets: true,
  });
  if (gain.hits.length === 0) return null;
  const nodeTargets = new Set(gain.hits
    .filter((target) => target.target_type === "node")
    .map((target) => target.target_id));
  const linkTargets = new Set(gain.hits
    .filter((target) => target.target_type === "link")
    .map((target) => target.target_id));
  const metadataPlan = buildPathMetadataPlan({
    pathNodes,
    pathLinks,
    nodeTargets,
    linkTargets,
    observedNodes,
    observedLinks,
    fieldProfile,
    preserveCoreNodeCoverage: true,
    preserveCoreLinkMetrics: true,
    preserveNonTargetLinks: true,
  });
  const criticalHits = gain.hits.filter(
    (target) => numberValue(target.criticality_score) >= criticalityThreshold,
  );
  const aoiDebtSeverity = gain.hits.reduce(
    (sum, target) => sum + numberValue(target.explicit_aoi_debt_severity),
    0,
  );
  const criticalityGain = criticalHits.reduce(
    (sum, target) => sum + numberValue(target.criticality_score),
    0,
  );
  const pathNodeIds = new Set(pathNodes);
  const pathLinkIds = new Set(pathLinks);
  const adjacentLinkTargetIds = gain.hits
    .filter((target) => target.target_type === "link" && !pathLinkIds.has(target.target_id))
    .filter((target) =>
      pathNodeIds.has(String(target.source ?? "")) || pathNodeIds.has(String(target.target ?? ""))
    )
    .map((target) => target.target_id);
  const adjacentLinkMetadataBytes = adjacentLinkTargetIds.length * numberValue(fieldProfile.link_core_bytes, 48);
  const actualGeneratedBytes = Math.max(0,
    numberValue(probePacketBaseBytes, 64) +
    numberValue(reportHeaderBytes, 128) +
    metadataPlan.target_mask_bytes +
    (metadataPlan.metadata_bytes + adjacentLinkMetadataBytes) * 2,
  );
  const priorityGain = gain.mandatoryHits * 2 + aoiDebtSeverity + criticalityGain + gain.gain;
  return {
    row,
    pathNodes,
    pathLinks,
    gain,
    metadataPlan,
    actualGeneratedBytes: round(actualGeneratedBytes),
    criticalTargetCount: criticalHits.length,
    criticalityGain: round(criticalityGain),
    aoiDebtSeverity: round(aoiDebtSeverity),
    adjacentLinkTargetIds,
    adjacentLinkMetadataBytes: round(adjacentLinkMetadataBytes),
    priorityGain: round(priorityGain),
    priorityPerKb: round(priorityGain / Math.max(actualGeneratedBytes / 1024, 1 / 1024)),
  };
}

export function selectBoundedImportanceRepairRows({
  baseRows = [],
  candidateRows = [],
  targets = [],
  maxAdditionalPaths = 0,
  maxAdditionalBytes = Number.POSITIVE_INFINITY,
  probePacketBaseBytes = 64,
  reportHeaderBytes = 128,
  fieldProfile = DEFAULT_SELECTIVE_METADATA_PROFILE,
  criticalityThreshold = 0.65,
  requireStrongEvidence = false,
} = {}) {
  const base = [...baseRows];
  const normalizedTargets = normalizeTargetRows(targets, {});
  const coveredTargetKeys = new Set();
  const observedNodes = new Set();
  const observedLinks = new Set();
  const baseKeys = new Set(base.map(repairPathKey));
  base.forEach((row) => {
    const pathNodes = splitPath(row.path);
    const pathLinks = splitPath(row.link_ids);
    targetGainForPath({ pathNodes, pathLinks, targets: normalizedTargets, coveredTargetKeys }).hits
      .forEach((target) => coveredTargetKeys.add(`${target.target_type}|${target.target_id}`));
    pathNodes.forEach((id) => observedNodes.add(id));
    pathLinks.forEach((id) => observedLinks.add(id));
  });

  const remaining = candidateRows
    .filter((row) => !baseKeys.has(repairPathKey(row)))
    .map((row, index) => ({ ...row, __repair_order: index }));
  const repairRows = [];
  let estimatedAdditionalBytes = 0;
  const pathLimit = Math.max(0, Math.floor(numberValue(maxAdditionalPaths)));
  const byteLimit = Number.isFinite(Number(maxAdditionalBytes))
    ? Math.max(0, Number(maxAdditionalBytes))
    : Number.POSITIVE_INFINITY;

  while (repairRows.length < pathLimit && remaining.length > 0) {
    const ranked = remaining
      .map((row) => repairCandidateEvidence({
        row,
        targets: normalizedTargets,
        coveredTargetKeys,
        observedNodes,
        observedLinks,
        fieldProfile,
        probePacketBaseBytes,
        reportHeaderBytes,
        criticalityThreshold,
      }))
      .filter(Boolean)
      .filter((item) => !requireStrongEvidence ||
        item.gain.mandatoryHits > 0 ||
        item.aoiDebtSeverity > 0 ||
        item.criticalTargetCount > 0
      )
      .filter((item) => estimatedAdditionalBytes + item.actualGeneratedBytes <= byteLimit)
      .sort((left, right) =>
        right.gain.mandatoryHits - left.gain.mandatoryHits ||
        right.priorityPerKb - left.priorityPerKb ||
        right.criticalTargetCount - left.criticalTargetCount ||
        right.criticalityGain - left.criticalityGain ||
        right.aoiDebtSeverity - left.aoiDebtSeverity ||
        left.row.__repair_order - right.row.__repair_order
      );
    if (ranked.length === 0) break;
    const selected = ranked[0];
    const selectedOrder = selected.row.__repair_order;
    const remainingIndex = remaining.findIndex((row) => row.__repair_order === selectedOrder);
    if (remainingIndex >= 0) remaining.splice(remainingIndex, 1);
    selected.gain.hits.forEach((target) => coveredTargetKeys.add(`${target.target_type}|${target.target_id}`));
    selected.pathNodes.forEach((id) => observedNodes.add(id));
    selected.pathLinks.forEach((id) => observedLinks.add(id));
    estimatedAdditionalBytes += selected.actualGeneratedBytes;
    repairRows.push({
      ...selected.row,
      importance_repair_actual_bytes: selected.actualGeneratedBytes,
      importance_repair_target_count: selected.gain.hits.length,
      importance_repair_mandatory_target_count: selected.gain.mandatoryHits,
      importance_repair_critical_target_count: selected.criticalTargetCount,
      importance_repair_criticality_gain: selected.criticalityGain,
      importance_repair_aoi_debt_severity: selected.aoiDebtSeverity,
      importance_repair_adjacent_link_target_count: selected.adjacentLinkTargetIds.length,
      importance_repair_adjacent_link_metadata_bytes: selected.adjacentLinkMetadataBytes,
      importance_repair_adjacent_link_target_ids: selected.adjacentLinkTargetIds.join(" > "),
      importance_repair_priority_per_kb: selected.priorityPerKb,
      importance_repair_target_ids: selected.gain.hits
        .map((target) => `${target.target_type}|${target.target_id}`)
        .join(" > "),
    });
  }

  return {
    base_rows: base,
    repair_rows: repairRows.map(({ __repair_order, ...row }) => row),
    rows: [...base, ...repairRows.map(({ __repair_order, ...row }) => row)],
    estimated_additional_bytes: round(estimatedAdditionalBytes),
    covered_target_count: coveredTargetKeys.size,
  };
}

function importanceBudgetBytes(row) {
  return Math.max(0, numberValue(
    row.importance_budget_bytes,
    numberValue(row.estimated_generated_telemetry_bytes, row.selective_metadata_payload_bytes),
  ));
}

function importanceBaseValue(row) {
  return Math.max(0, numberValue(
    row.importance_base_value,
    numberValue(row.marginal_information_gain, numberValue(row.score)),
  ));
}

function normalizedTargetKey(target) {
  return `${target.target_type}|${target.target_id}`;
}

function targetWeight(target) {
  return Math.max(0.01,
    numberValue(target.importance_score, 0.5) +
    (target.mandatory ? 2 : 0) +
    (target.coverage_required ? 1 + numberValue(target.aoi_debt_severity, 1) : 0)
  );
}

function targetKeysForBudgetRow(row, targets) {
  const gain = targetGainForPath({
    pathNodes: splitPath(row.path),
    pathLinks: splitPath(row.link_ids),
    targets,
    includeAdjacentLinkTargets: true,
  });
  return new Set(gain.hits.map(normalizedTargetKey));
}

function targetCoverageCounts(rows, targets) {
  const counts = new Map();
  rows.forEach((row) => {
    targetKeysForBudgetRow(row, targets).forEach((key) => {
      counts.set(key, numberValue(counts.get(key)) + 1);
    });
  });
  return counts;
}

function directCoverageCounts(rows, field) {
  const counts = new Map();
  rows.forEach((row) => {
    const values = field === "path" ? splitPath(row.path) : splitPath(row.link_ids);
    new Set(values).forEach((value) => {
      counts.set(value, numberValue(counts.get(value)) + 1);
    });
  });
  return counts;
}

function weightedTargetCoverage(counts, targetsByKey) {
  let total = 0;
  counts.forEach((count, key) => {
    if (count > 0) total += targetWeight(targetsByKey.get(key) ?? {});
  });
  return round(total);
}

export function selectBudgetNeutralImportanceReplacements({
  baseRows = [],
  candidateRows = [],
  targets = [],
  maxTotalBytes = Number.POSITIVE_INFINITY,
  maxReplacements = 0,
  maxBaseValueLossRatio = 0.02,
  preserveDirectNodeCoverage = true,
  preserveDirectLinkCoverage = true,
} = {}) {
  const normalizedTargets = normalizeTargetRows(targets, {});
  const targetsByKey = new Map(normalizedTargets.map((target) => [normalizedTargetKey(target), target]));
  const selected = baseRows.map((row) => ({ ...row }));
  const selectedKeys = new Set(selected.map(repairPathKey));
  const pending = candidateRows
    .filter((row) => !selectedKeys.has(repairPathKey(row)))
    .map((row, index) => ({ ...row, __replacement_order: index }));
  const replacementLimit = Math.max(0, Math.min(
    selected.length,
    Math.floor(numberValue(maxReplacements)),
  ));
  const byteLimit = Number.isFinite(Number(maxTotalBytes))
    ? Math.max(0, Number(maxTotalBytes))
    : Number.POSITIVE_INFINITY;
  const beforeBytes = round(selected.reduce((sum, row) => sum + importanceBudgetBytes(row), 0));
  const beforeCoverage = targetCoverageCounts(selected, normalizedTargets);
  const replacements = [];
  let currentBytes = beforeBytes;

  while (replacements.length < replacementLimit && pending.length > 0 && selected.length > 0) {
    const coverageCounts = targetCoverageCounts(selected, normalizedTargets);
    const directNodeCoverage = directCoverageCounts(selected, "path");
    const directLinkCoverage = directCoverageCounts(selected, "link_ids");
    let best = null;
    for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
      const removed = selected[selectedIndex];
      const removedKeys = targetKeysForBudgetRow(removed, normalizedTargets);
      const removedBaseValue = importanceBaseValue(removed);
      const minimumCandidateValue = removedBaseValue * (1 - clamp(maxBaseValueLossRatio, 0, 1));
      for (let candidateIndex = 0; candidateIndex < pending.length; candidateIndex += 1) {
        const added = pending[candidateIndex];
        const addedBaseValue = importanceBaseValue(added);
        if (addedBaseValue + 1e-12 < minimumCandidateValue) continue;
        const nextBytes = currentBytes - importanceBudgetBytes(removed) + importanceBudgetBytes(added);
        if (nextBytes > byteLimit + 1e-9 || nextBytes > currentBytes + 1e-9) continue;
        const addedKeys = targetKeysForBudgetRow(added, normalizedTargets);
        const addedNodeIds = new Set(splitPath(added.path));
        const addedLinkIds = new Set(splitPath(added.link_ids));
        const lostDirectNodeIds = preserveDirectNodeCoverage
          ? [...new Set(splitPath(removed.path))].filter((nodeId) =>
              numberValue(directNodeCoverage.get(nodeId)) <= 1 && !addedNodeIds.has(nodeId)
            )
          : [];
        const lostDirectLinkIds = preserveDirectLinkCoverage
          ? [...new Set(splitPath(removed.link_ids))].filter((linkId) =>
              numberValue(directLinkCoverage.get(linkId)) <= 1 && !addedLinkIds.has(linkId)
            )
          : [];
        if (lostDirectNodeIds.length > 0 || lostDirectLinkIds.length > 0) continue;
        const gainedKeys = [...addedKeys].filter((key) => numberValue(coverageCounts.get(key)) <= 0);
        const lostKeys = [...removedKeys].filter((key) =>
          numberValue(coverageCounts.get(key)) <= 1 && !addedKeys.has(key)
        );
        const losesProtectedTarget = lostKeys.some((key) => {
          const target = targetsByKey.get(key) ?? {};
          return target.mandatory || target.coverage_required;
        });
        if (losesProtectedTarget) continue;
        const gainedWeight = gainedKeys.reduce((sum, key) => sum + targetWeight(targetsByKey.get(key) ?? {}), 0);
        const lostWeight = lostKeys.reduce((sum, key) => sum + targetWeight(targetsByKey.get(key) ?? {}), 0);
        const targetDelta = gainedWeight - lostWeight;
        if (gainedKeys.length === 0 || targetDelta <= 1e-9) continue;
        const baseDeltaRatio = removedBaseValue > 0
          ? (addedBaseValue - removedBaseValue) / removedBaseValue
          : addedBaseValue;
        const score = targetDelta + Math.min(0.25, baseDeltaRatio * 0.25) +
          Math.max(0, importanceBudgetBytes(removed) - importanceBudgetBytes(added)) / 4096;
        const proposal = {
          selectedIndex,
          candidateIndex,
          removed,
          added,
          nextBytes,
          gainedKeys,
          lostKeys,
          lostDirectNodeIds,
          lostDirectLinkIds,
          targetDelta,
          score,
        };
        if (!best ||
          proposal.score > best.score + 1e-12 ||
          Math.abs(proposal.score - best.score) <= 1e-12 &&
            (proposal.nextBytes < best.nextBytes - 1e-9 ||
              Math.abs(proposal.nextBytes - best.nextBytes) <= 1e-9 &&
                String(proposal.added.probe_id ?? "").localeCompare(String(best.added.probe_id ?? "")) < 0)
        ) {
          best = proposal;
        }
      }
    }
    if (!best) break;
    const [added] = pending.splice(best.candidateIndex, 1);
    const removed = selected[best.selectedIndex];
    selectedKeys.delete(repairPathKey(removed));
    selectedKeys.add(repairPathKey(added));
    selected[best.selectedIndex] = {
      ...added,
      planning_importance_budget_neutral_replacement: true,
      planning_importance_replaced_probe_id: removed.probe_id ?? "",
      planning_importance_replacement_target_ids: best.gainedKeys.join(" > "),
      planning_importance_replacement_target_gain: round(best.targetDelta),
    };
    currentBytes = best.nextBytes;
    replacements.push({
      removed_probe_id: removed.probe_id ?? "",
      added_probe_id: added.probe_id ?? "",
      before_bytes: importanceBudgetBytes(removed),
      after_bytes: importanceBudgetBytes(added),
      gained_target_ids: best.gainedKeys,
      lost_target_ids: best.lostKeys,
      lost_direct_node_ids: best.lostDirectNodeIds,
      lost_direct_link_ids: best.lostDirectLinkIds,
      weighted_target_gain: round(best.targetDelta),
      removed_base_value: round(importanceBaseValue(removed)),
      added_base_value: round(importanceBaseValue(added)),
    });
  }

  const cleanedRows = selected.map(({ __replacement_order, ...row }) => row);
  const afterCoverage = targetCoverageCounts(cleanedRows, normalizedTargets);
  return {
    rows: cleanedRows,
    replacements,
    before_bytes: beforeBytes,
    after_bytes: round(currentBytes),
    before_target_coverage: beforeCoverage.size,
    after_target_coverage: afterCoverage.size,
    before_weighted_target_coverage: weightedTargetCoverage(beforeCoverage, targetsByKey),
    after_weighted_target_coverage: weightedTargetCoverage(afterCoverage, targetsByKey),
    budget_bytes: Number.isFinite(byteLimit) ? round(byteLimit) : "",
    path_count_preserved: cleanedRows.length === baseRows.length,
    direct_node_coverage_preserved: preserveDirectNodeCoverage,
    direct_link_coverage_preserved: preserveDirectLinkCoverage,
  };
}

export function shouldUseAoIDebtOverride({
  promotionAvailable = false,
  objective = {},
  legacy = {},
  informationFloor = 0.95,
} = {}) {
  if (!promotionAvailable) return false;
  const objectiveMax = numberValue(objective.maxSeverity);
  const legacyMax = numberValue(legacy.maxSeverity);
  const objectiveOldest = numberValue(objective.oldestTargets);
  const legacyOldest = numberValue(legacy.oldestTargets);
  const objectiveDebt = numberValue(objective.debtSeverity);
  const legacyDebt = numberValue(legacy.debtSeverity);
  const hasHigherAoIPriority = objectiveMax > legacyMax ||
    (objectiveMax === legacyMax && objectiveOldest > legacyOldest) ||
    (objectiveMax === legacyMax && objectiveOldest === legacyOldest && objectiveDebt > legacyDebt);
  if (!hasHigherAoIPriority) return false;
  return numberValue(objective.informationGain) >=
    numberValue(legacy.informationGain) * clamp(informationFloor, 0.9, 1);
}

export function computeAoIAdjustedPathCount({
  requestedPathCount = 0,
  aoiRepairPathLimit = 0,
  selectedLimit = 0,
} = {}) {
  return Math.max(0, Math.min(
    Math.floor(numberValue(selectedLimit)),
    Math.floor(numberValue(requestedPathCount)) + Math.floor(numberValue(aoiRepairPathLimit)),
  ));
}

export function computeBoundedAdditiveRepairPathLimit({
  basePathCount = 0,
  ratio = 0.1,
  remainingCandidateCount = 0,
  minimumPathCount = 0,
} = {}) {
  const base = Math.max(0, Math.floor(numberValue(basePathCount)));
  const remaining = Math.max(0, Math.floor(numberValue(remainingCandidateCount)));
  if (base === 0 || remaining === 0) return 0;
  const minimum = Math.max(0, Math.floor(numberValue(minimumPathCount)));
  return Math.min(remaining, Math.max(minimum, 1, Math.round(base * clamp(ratio, 0, 0.5))));
}

export function compareAoIRepairGains(left = {}, right = {}) {
  return numberValue(right.aoi_debt_max_severity) - numberValue(left.aoi_debt_max_severity) ||
    numberValue(right.aoi_debt_oldest_target_count) - numberValue(left.aoi_debt_oldest_target_count) ||
    numberValue(right.aoi_debt_severity) - numberValue(left.aoi_debt_severity) ||
    numberValue(right.aoi_debt_target_count) - numberValue(left.aoi_debt_target_count) ||
    numberValue(right.gain_per_kb) - numberValue(left.gain_per_kb);
}

export function resolveImportanceSelectionPhase({
  enabled = false,
  selectedPathCount = 0,
  requestedPathCount = 0,
  adjustedPathCount = 0,
} = {}) {
  if (!enabled || numberValue(selectedPathCount) < numberValue(requestedPathCount)) {
    return "conservative-base";
  }
  if (numberValue(selectedPathCount) < numberValue(adjustedPathCount)) return "aoi-repair";
  return "complete";
}

export function buildTargetPreservingRepair({
  graph,
  source,
  sink,
  originalNodes = [],
  requiredNodeIds = new Set(),
  shortestPath,
} = {}) {
  if (typeof shortestPath !== "function") return null;
  const required = idSet(requiredNodeIds);
  const candidates = [...new Set(originalNodes.map(String))].filter((nodeId) => required.has(nodeId));
  let best = null;
  for (const targetId of candidates) {
    const before = shortestPath(graph, source, targetId);
    const after = shortestPath(graph, targetId, sink);
    if (!before || !after) continue;
    const nodes = [...before.nodes, ...after.nodes.slice(1)];
    const linkIds = [...before.linkIds, ...after.linkIds];
    if (linkIds.length === 0) continue;
    const preservedTargetIds = candidates.filter((id) => nodes.includes(id));
    const candidate = {
      nodes,
      linkIds,
      cost: numberValue(before.cost) + numberValue(after.cost),
      preservedTargetIds,
    };
    if (!best ||
      candidate.preservedTargetIds.length > best.preservedTargetIds.length ||
      (candidate.preservedTargetIds.length === best.preservedTargetIds.length && candidate.cost < best.cost) ||
      (candidate.preservedTargetIds.length === best.preservedTargetIds.length && candidate.cost === best.cost && candidate.linkIds.length < best.linkIds.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

export { DEFAULT_IMPORTANCE_WEIGHTS };
