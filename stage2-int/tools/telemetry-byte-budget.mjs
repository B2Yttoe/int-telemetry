function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function addBytesByProbe(rows, field) {
  const totals = new Map();
  for (const row of rows ?? []) {
    const probeId = String(row.probe_id ?? "");
    if (!probeId) continue;
    totals.set(probeId, (totals.get(probeId) ?? 0) + Math.max(0, numberValue(row[field])));
  }
  return totals;
}

function budgetForSlice(specification, sliceIndex) {
  if (specification instanceof Map) return Math.max(0, numberValue(specification.get(sliceIndex)));
  if (typeof specification === "function") return Math.max(0, numberValue(specification(sliceIndex)));
  if (specification && typeof specification === "object") {
    return Math.max(0, numberValue(specification[sliceIndex] ?? specification[String(sliceIndex)]));
  }
  return Math.max(0, numberValue(specification));
}

function budgetSpecificationEnabled(specification) {
  if (specification instanceof Map) return [...specification.values()].some((value) => numberValue(value) > 0);
  if (typeof specification === "function") return true;
  if (specification && typeof specification === "object") {
    return Object.values(specification).some((value) => numberValue(value) > 0);
  }
  return numberValue(specification) > 0;
}

export function selectBudgetAdmittedProbeIds({
  probes = [],
  hopRecords = [],
  reports = [],
  probePacketBaseBytes = 0,
  perSliceBudgetBytes = 0,
} = {}) {
  const enabled = budgetSpecificationEnabled(perSliceBudgetBytes);
  const metadataByProbe = addBytesByProbe(hopRecords, "hop_metadata_bytes");
  const reportByProbe = addBytesByProbe(reports, "report_size_bytes");
  const admittedProbeIds = new Set();
  const rejectedProbeIds = new Set();
  const sliceState = new Map();
  const decisions = [];

  for (const probe of probes) {
    const probeId = String(probe.probe_id ?? "");
    const sliceIndex = numberValue(probe.slice_index);
    const sliceBudget = budgetForSlice(perSliceBudgetBytes, sliceIndex);
    const sliceBudgetEnabled = sliceBudget > 0;
    const state = sliceState.get(sliceIndex) ?? {
      slice_index: sliceIndex,
      budget_bytes: sliceBudgetEnabled ? sliceBudget : 0,
      actual_bytes: 0,
      admitted_probes: 0,
      rejected_probes: 0,
      prefix_closed: false,
    };
    const probeGeneratedBytes = Math.max(0, numberValue(probePacketBaseBytes))
      + (metadataByProbe.get(probeId) ?? 0)
      + (reportByProbe.get(probeId) ?? 0)
      + Math.max(0, numberValue(probe.target_mask_bytes));
    let decision = "admitted";

    if (sliceBudgetEnabled && state.prefix_closed) {
      decision = "rejected-after-prefix-closed";
    } else if (sliceBudgetEnabled && state.actual_bytes + probeGeneratedBytes > sliceBudget) {
      decision = "rejected-prefix-budget";
      state.prefix_closed = true;
    }

    if (decision === "admitted") {
      admittedProbeIds.add(probeId);
      state.actual_bytes += probeGeneratedBytes;
      state.admitted_probes += 1;
    } else {
      rejectedProbeIds.add(probeId);
      state.rejected_probes += 1;
    }
    decisions.push({
      slice_index: sliceIndex,
      probe_id: probeId,
      probe_generated_bytes: probeGeneratedBytes,
      decision,
      cumulative_admitted_bytes: state.actual_bytes,
      budget_bytes: state.budget_bytes,
    });
    sliceState.set(sliceIndex, state);
  }

  const bySlice = [...sliceState.values()]
    .sort((left, right) => left.slice_index - right.slice_index)
    .map(({ prefix_closed: _prefixClosed, ...row }) => ({
      ...row,
      budget_utilization: row.budget_bytes > 0 ? row.actual_bytes / row.budget_bytes : 0,
      budget_headroom_bytes: row.budget_bytes > 0 ? Math.max(0, row.budget_bytes - row.actual_bytes) : 0,
      cap_violation: row.budget_bytes > 0 && row.actual_bytes > row.budget_bytes,
    }));

  return {
    enabled,
    perSliceBudgetBytes: typeof perSliceBudgetBytes === "number" ? Math.max(0, perSliceBudgetBytes) : null,
    admittedProbeIds,
    rejectedProbeIds,
    decisions,
    bySlice,
    capViolations: bySlice.filter((row) => row.cap_violation).length,
  };
}
