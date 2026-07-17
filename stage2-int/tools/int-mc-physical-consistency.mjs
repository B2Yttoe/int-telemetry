function finiteNumber(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number(finiteNumber(value, 0).toFixed(digits));
}

function result(checks, violations, formula) {
  return {
    checks,
    violations,
    violation_rate: round(violations / Math.max(checks, 1)),
    formula,
  };
}

function inferredRows(rows) {
  return rows.filter((row) => String(row.observation_source) === "inferred");
}

export function projectNodePhysicalConsistency(estimates, {
  previousInferredEnergyPercent = NaN,
  energyDeltaLimitPercentPerSlice = 5,
} = {}) {
  const output = { ...(estimates ?? {}) };
  const updates = [];
  const queueDepth = finiteNumber(output.queue_depth);
  let queuedTraffic = finiteNumber(output.queued_traffic_mb);
  let cacheUsed = finiteNumber(output.cache_used_mb);
  if (Number.isFinite(queueDepth) && queueDepth > 1e-9 && (!Number.isFinite(queuedTraffic) || queuedTraffic <= 1e-9)) {
    queuedTraffic = 1e-6;
    output.queued_traffic_mb = queuedTraffic;
    updates.push("positive-queue-traffic-floor");
  }
  if (Number.isFinite(queuedTraffic) && Number.isFinite(cacheUsed) && cacheUsed < queuedTraffic) {
    cacheUsed = queuedTraffic;
    output.cache_used_mb = cacheUsed;
    updates.push("cache-covers-queued-traffic");
  }
  const energy = finiteNumber(output.energy_percent);
  const previousEnergy = finiteNumber(previousInferredEnergyPercent);
  const limit = Math.max(0, finiteNumber(energyDeltaLimitPercentPerSlice, 5));
  if (Number.isFinite(energy) && Number.isFinite(previousEnergy) && Math.abs(energy - previousEnergy) > limit) {
    output.energy_percent = Math.max(0, Math.min(100, previousEnergy + Math.sign(energy - previousEnergy) * limit));
    updates.push("adjacent-energy-rate-bound");
  }
  return {
    estimates: output,
    applied: updates.length > 0,
    metrics: updates,
    hidden_truth_used: false,
  };
}

export function projectLinkPhysicalConsistency(estimates, { routeTrafficMbps = 0 } = {}) {
  const output = { ...(estimates ?? {}) };
  const updates = [];
  const queuedTraffic = finiteNumber(output.queued_traffic_mb);
  const queueLatency = finiteNumber(output.queue_latency_ms);
  if (Number.isFinite(queuedTraffic) && queuedTraffic > 1e-9 && (!Number.isFinite(queueLatency) || queueLatency <= 1e-9)) {
    output.queue_latency_ms = 1e-6;
    updates.push("positive-queued-traffic-latency-floor");
  }
  const traffic = finiteNumber(routeTrafficMbps);
  const capacity = finiteNumber(output.capacity_mbps);
  const utilization = finiteNumber(output.utilization_percent);
  if (Number.isFinite(traffic) && traffic > 0 && Number.isFinite(capacity) && capacity > 0 && Number.isFinite(utilization)) {
    const utilizationFloor = Math.min(100, (traffic / capacity) * 100);
    if (utilization < utilizationFloor) {
      output.utilization_percent = utilizationFloor;
      updates.push("route-load-utilization-floor");
    }
  }
  const packetErrorRate = finiteNumber(output.packet_error_rate);
  if (Number.isFinite(packetErrorRate) && (packetErrorRate < 0 || packetErrorRate > 1)) {
    output.packet_error_rate = Math.max(0, Math.min(1, packetErrorRate));
    updates.push("packet-error-probability-bound");
  }
  return {
    estimates: output,
    applied: updates.length > 0,
    metrics: updates,
    hidden_truth_used: false,
  };
}

export function auditNodePhysicalConsistency(rows, { energyDeltaLimitPercentPerSlice = 5 } = {}) {
  const inferred = inferredRows(Array.isArray(rows) ? rows : []);
  let cacheChecks = 0;
  let cacheViolations = 0;
  let queueChecks = 0;
  let queueViolations = 0;

  inferred.forEach((row) => {
    const queuedTraffic = finiteNumber(row.queued_traffic_mb_estimate);
    const cacheUsed = finiteNumber(row.cache_used_mb_estimate);
    if (Number.isFinite(queuedTraffic) && Number.isFinite(cacheUsed)) {
      cacheChecks += 1;
      if (cacheUsed + 1e-9 < queuedTraffic) cacheViolations += 1;
    }
    const queueDepth = finiteNumber(row.queue_depth_estimate);
    if (Number.isFinite(queueDepth) && queueDepth > 1e-9) {
      queueChecks += 1;
      if (!Number.isFinite(queuedTraffic) || queuedTraffic <= 1e-9) queueViolations += 1;
    }
  });

  const rowsByNode = new Map();
  inferred.forEach((row) => {
    const nodeId = String(row.node_id || "");
    if (!rowsByNode.has(nodeId)) rowsByNode.set(nodeId, []);
    rowsByNode.get(nodeId).push(row);
  });
  let energyChecks = 0;
  let energyViolations = 0;
  for (const nodeRows of rowsByNode.values()) {
    nodeRows.sort((left, right) => finiteNumber(left.slice_index, 0) - finiteNumber(right.slice_index, 0));
    for (let index = 1; index < nodeRows.length; index += 1) {
      const previous = nodeRows[index - 1];
      const current = nodeRows[index];
      const sliceGap = finiteNumber(current.slice_index) - finiteNumber(previous.slice_index);
      const previousEnergy = finiteNumber(previous.energy_percent_estimate);
      const currentEnergy = finiteNumber(current.energy_percent_estimate);
      if (sliceGap !== 1 || !Number.isFinite(previousEnergy) || !Number.isFinite(currentEnergy)) continue;
      energyChecks += 1;
      if (Math.abs(currentEnergy - previousEnergy) > energyDeltaLimitPercentPerSlice + 1e-9) {
        energyViolations += 1;
      }
    }
  }

  const totalChecks = cacheChecks + queueChecks + energyChecks;
  const totalViolations = cacheViolations + queueViolations + energyViolations;
  return {
    scope: "node",
    inferred_samples: inferred.length,
    cache_covers_queued_traffic: result(cacheChecks, cacheViolations, "cache_used_mb >= queued_traffic_mb"),
    positive_queue_has_traffic: result(queueChecks, queueViolations, "queue_depth > 0 => queued_traffic_mb > 0"),
    energy_rate_bound: result(
      energyChecks,
      energyViolations,
      `abs(delta energy_percent) <= ${energyDeltaLimitPercentPerSlice} per adjacent slice`,
    ),
    total_checks: totalChecks,
    total_violations: totalViolations,
    overall_violation_rate: round(totalViolations / Math.max(totalChecks, 1)),
    energy_delta_limit_percent_per_slice: energyDeltaLimitPercentPerSlice,
    hidden_truth_fields_used: false,
  };
}

export function auditLinkPhysicalConsistency(rows) {
  const inferredActive = inferredRows(Array.isArray(rows) ? rows : []).filter((row) =>
    String(row.contact_state) === "active",
  );
  let queueChecks = 0;
  let queueViolations = 0;
  let utilizationChecks = 0;
  let utilizationViolations = 0;
  let packetErrorChecks = 0;
  let packetErrorViolations = 0;

  inferredActive.forEach((row) => {
    const queuedTraffic = finiteNumber(row.queued_traffic_mb_estimate);
    const queueLatency = finiteNumber(row.queue_latency_ms_estimate);
    if (Number.isFinite(queuedTraffic) && queuedTraffic > 1e-9) {
      queueChecks += 1;
      if (!Number.isFinite(queueLatency) || queueLatency <= 1e-9) queueViolations += 1;
    }

    const routeTraffic = finiteNumber(row.route_traffic_mbps);
    const capacity = finiteNumber(row.capacity_mbps_estimate);
    const utilization = finiteNumber(row.utilization_percent_estimate);
    if (Number.isFinite(routeTraffic) && routeTraffic > 0 && Number.isFinite(capacity) && capacity > 0 && Number.isFinite(utilization)) {
      utilizationChecks += 1;
      const utilizationFloor = Math.min(100, (routeTraffic / capacity) * 100);
      if (utilization + 1e-6 < utilizationFloor) utilizationViolations += 1;
    }

    const packetErrorRate = finiteNumber(row.packet_error_rate_estimate);
    if (Number.isFinite(packetErrorRate)) {
      packetErrorChecks += 1;
      if (packetErrorRate < 0 || packetErrorRate > 1) packetErrorViolations += 1;
    }
  });

  const totalChecks = queueChecks + utilizationChecks + packetErrorChecks;
  const totalViolations = queueViolations + utilizationViolations + packetErrorViolations;
  return {
    scope: "link",
    inferred_active_samples: inferredActive.length,
    queued_traffic_has_queue_latency: result(queueChecks, queueViolations, "queued_traffic_mb > 0 => queue_latency_ms > 0"),
    route_load_utilization_floor: result(
      utilizationChecks,
      utilizationViolations,
      "utilization_percent >= min(100, route_traffic_mbps / capacity_mbps * 100)",
    ),
    packet_error_probability_bound: result(packetErrorChecks, packetErrorViolations, "0 <= packet_error_rate <= 1"),
    total_checks: totalChecks,
    total_violations: totalViolations,
    overall_violation_rate: round(totalViolations / Math.max(totalChecks, 1)),
    hidden_truth_fields_used: false,
  };
}
