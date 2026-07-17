function finite(value) {
  return Number.isFinite(Number(value));
}

function identity(row) {
  return String(
    row.server_id ?? row.server_hostname ?? row.measurement_target_id ??
    row.anchor_id ?? row.target_hostname ?? "",
  ).trim();
}

export function uniqueTopologyTimes(nodeRows) {
  const bySlice = new Map();
  for (const row of nodeRows) {
    const slice = Number(row.slice_index);
    const time = new Date(row.time).getTime();
    if (Number.isInteger(slice) && Number.isFinite(time) && !bySlice.has(slice)) {
      bySlice.set(slice, { slice_index: slice, time: new Date(time).toISOString(), timestamp_ms: time });
    }
  }
  return [...bySlice.values()].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
}

export function nearestTopologyTime(topologyTimes, testTime) {
  const timestamp = new Date(testTime).getTime();
  if (!Number.isFinite(timestamp) || !topologyTimes.length) return null;
  let best = topologyTimes[0];
  let bestDistance = Math.abs(timestamp - best.timestamp_ms);
  for (let index = 1; index < topologyTimes.length; index += 1) {
    const candidate = topologyTimes[index];
    const distance = Math.abs(timestamp - candidate.timestamp_ms);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return { ...best, offset_seconds: bestDistance / 1000 };
}

export function classifyStrictExternalPair(row, topologyTimes, policy) {
  const nearest = nearestTopologyTime(topologyTimes, row.test_time ?? row.time);
  const start = topologyTimes[0]?.timestamp_ms;
  const end = topologyTimes.at(-1)?.timestamp_ms;
  const timestamp = new Date(row.test_time ?? row.time).getTime();
  const withinWindow = Number.isFinite(timestamp) && Number.isFinite(start) && Number.isFinite(end) &&
    timestamp >= start && timestamp <= end;
  const directClient = finite(row.client_latitude_deg ?? row.lat ?? row.probe_latitude_deg) &&
    finite(row.client_longitude_deg ?? row.lon ?? row.probe_longitude_deg);
  const directServer = finite(row.server_latitude_deg) && finite(row.server_longitude_deg) &&
    row.server_location_source === policy.required.server_location_source;
  const serverIdentity = identity(row);
  const checks = {
    modeled: row.status === policy.required.modeled_status,
    exact_topology_window: row.temporal_pairing === policy.required.temporal_pairing && withinWindow,
    time_offset: Boolean(nearest && nearest.offset_seconds <= policy.maximum_topology_time_offset_seconds),
    direct_client_location: directClient,
    direct_server_location: directServer,
    server_identity: !policy.required.server_identity_present || serverIdentity.length > 0,
  };
  const rejectionReasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ...row,
    strict_pair: rejectionReasons.length === 0,
    strict_pair_rejection_reasons: rejectionReasons.join("|"),
    nearest_slice_index: nearest?.slice_index ?? "",
    nearest_slice_time: nearest?.time ?? "",
    topology_time_offset_seconds: nearest?.offset_seconds ?? "",
    client_location_source: directClient ? "direct-measurement-coordinate" : "missing-or-derived",
    server_identity: serverIdentity,
  };
}

export function summarizeStrictExternalPairs(rows, sourceId, policy) {
  const strict = rows.filter((row) => row.strict_pair === true);
  const rejected = rows.filter((row) => row.strict_pair !== true);
  const rejectionCounts = {};
  for (const row of rejected) {
    for (const reason of String(row.strict_pair_rejection_reasons ?? "unknown").split("|").filter(Boolean)) {
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
  }
  const minimum = Number(policy.minimum_pairs[sourceId] ?? 0);
  return {
    source_id: sourceId,
    total_rows: rows.length,
    strict_pairs: strict.length,
    rejected_rows: rejected.length,
    strict_pair_ratio: rows.length ? strict.length / rows.length : 0,
    minimum_required_pairs: minimum,
    passed: strict.length >= minimum,
    rejection_counts: rejectionCounts,
  };
}
