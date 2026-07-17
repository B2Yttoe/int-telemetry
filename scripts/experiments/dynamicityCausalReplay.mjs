function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function linkIds(row) {
  return String(row.link_ids ?? row.linkIds ?? "")
    .split(" > ")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildControlledOutageSchedule(links = []) {
  const bySlice = new Map();
  links.forEach((row) => {
    if (row.restriction_reason !== "experiment8-controlled-dynamicity") return;
    const slice = String(row.slice_index);
    const ids = bySlice.get(slice) ?? new Set();
    ids.add(String(row.link_id));
    bySlice.set(slice, ids);
  });
  return {
    schema_version: "int-telemetry-controlled-link-outage/v1",
    reason: "experiment8-controlled-dynamicity",
    forced_down_link_ids_by_slice: Object.fromEntries(
      [...bySlice.entries()]
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([slice, ids]) => [slice, [...ids].sort()]),
    ),
  };
}

function invalidPathRows(rows, activeBySliceAndId) {
  return rows.filter((row) => {
    if (String(row.status ?? "").toLowerCase() !== "routed") return false;
    return linkIds(row).some((linkId) => activeBySliceAndId.get(`${row.slice_index}|${linkId}`) !== true);
  });
}

export function auditCausalReplay({ links = [], routes = [], taskTraces = [] } = {}) {
  const activeBySliceAndId = new Map(
    links.map((row) => [`${row.slice_index}|${row.link_id}`, String(row.is_active).toLowerCase() === "true"]),
  );
  const forcedDown = links.filter((row) => row.restriction_reason === "experiment8-controlled-dynamicity");
  const forcedDownNonzero = forcedDown.filter((row) => [
    "carried_traffic_mbps",
    "demand_traffic_mbps",
    "utilization_percent",
    "effective_capacity_mbps",
  ].some((field) => row[field] !== undefined && row[field] !== "" && Math.abs(numberValue(row[field])) > 1e-9));
  const invalidRoutes = invalidPathRows(routes, activeBySliceAndId);
  const invalidTaskTraces = invalidPathRows(taskTraces, activeBySliceAndId);
  const violations = [
    invalidRoutes.length ? `${invalidRoutes.length} routed rows traverse inactive links` : "",
    invalidTaskTraces.length ? `${invalidTaskTraces.length} task traces traverse inactive links` : "",
    forcedDownNonzero.length ? `${forcedDownNonzero.length} forced-down links retain traffic or capacity` : "",
    forcedDown.length === 0 ? "controlled outage schedule affected no links" : "",
  ].filter(Boolean);
  return {
    ok: violations.length === 0,
    violations,
    forced_down_link_rows: forcedDown.length,
    invalid_route_count: invalidRoutes.length,
    invalid_task_trace_count: invalidTaskTraces.length,
    forced_down_nonzero_count: forcedDownNonzero.length,
  };
}

function changedRatio(baselineRows, replayRows, keyFields, valueFields) {
  const baseline = new Map(baselineRows.map((row) => [keyFields.map((field) => row[field]).join("|"), row]));
  let comparable = 0;
  let changed = 0;
  replayRows.forEach((row) => {
    const before = baseline.get(keyFields.map((field) => row[field]).join("|"));
    if (!before) return;
    comparable += 1;
    if (valueFields.some((field) => String(before[field] ?? "") !== String(row[field] ?? ""))) changed += 1;
  });
  return comparable > 0 ? changed / comparable : 0;
}

export function compareCausalResponse({
  baselineNodes = [], replayNodes = [], baselineLinks = [], replayLinks = [], baselineRoutes = [], replayRoutes = [],
} = {}) {
  return {
    changed_node_ratio: changedRatio(
      baselineNodes,
      replayNodes,
      ["slice_index", "node_id"],
      ["cpu_utilization", "queue_depth", "queued_traffic_mb", "energy_wh", "mode"],
    ),
    changed_link_ratio: changedRatio(
      baselineLinks,
      replayLinks,
      ["slice_index", "link_id"],
      ["status", "is_active", "utilization_percent", "carried_traffic_mbps", "queued_traffic_mb"],
    ),
    changed_route_ratio: changedRatio(
      baselineRoutes,
      replayRoutes,
      ["slice_index", "task_id"],
      ["status", "link_ids", "carried_traffic_mbps", "queued_traffic_mb", "dropped_traffic_mb"],
    ),
  };
}
