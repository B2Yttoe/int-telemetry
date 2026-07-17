function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

function nextSliceForFeedback(sliceIndex, orderedSlices) {
  const numericSlices = [...new Set((orderedSlices ?? []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const index = numericSlices.indexOf(Number(sliceIndex));
  if (index >= 0 && index < numericSlices.length - 1) return numericSlices[index + 1];
  return Number(sliceIndex);
}

function uncertaintyPressure(row, type) {
  if (type === "link") {
    return clamp(Math.max(
      numberValue(row.state_tensor_joint_completion_pressure),
      numberValue(row.joint_state_coupling_pressure),
      numberValue(row.metric_tensor_coupling_pressure),
      numberValue(row.orbit_graph_regularization_strength),
    ));
  }
  const tensorNeighborScarcity = 1 / Math.max(numberValue(row.tensor_neighbor_count) + 1, 1);
  return clamp(
    numberValue(row.node_state_coupling_pressure) * 0.78 +
      tensorNeighborScarcity * 0.22,
  );
}

function inferredRetestRow({ row, type, sliceIndexes }) {
  const confidencePressure = clamp(1 - numberValue(row.confidence, 0.25));
  const contextRisk = clamp(numberValue(row.context_prior_risk));
  const disagreement = uncertaintyPressure(row, type);
  const hotspot = type === "link" ? clamp(numberValue(row.business_hotspot_score)) : 0;
  const priority = clamp(
    confidencePressure * 0.68 +
      disagreement * 0.16 +
      contextRisk * 0.12 +
      hotspot * 0.04,
  );
  if (priority < 0.18) return null;
  return {
    slice_index: nextSliceForFeedback(row.slice_index, sliceIndexes),
    source_slice_index: row.slice_index,
    target_type: type,
    target_id: type === "link" ? row.link_id : row.node_id,
    priority_score: round(priority),
    confidence: row.confidence,
    completion_error_score: "",
    confidence_pressure: round(confidencePressure),
    uncertainty_pressure: round(disagreement),
    context_risk: round(contextRisk),
    observation_source: row.observation_source,
    feedback_basis: "observable-uncertainty",
    reason: [
      confidencePressure > 0.35 ? "low-completion-confidence" : "",
      disagreement > 0.35 ? "completion-model-disagreement" : "",
      contextRisk > 0.4 ? type === "link" ? "risky-satellite-context" : "risky-node-context" : "",
      hotspot > 0.35 ? "business-hotspot" : "",
    ].filter(Boolean).join(" > ") || "completion-uncertainty-feedback",
  };
}

function observedRetestRow({ row, type, sliceIndexes }) {
  const confidencePressure = clamp(1 - numberValue(row.confidence, 1));
  const conflict = clamp(numberValue(row.oam_conflict_severity));
  const contextRisk = clamp(numberValue(row.context_prior_risk));
  const hotspot = type === "link" ? clamp(numberValue(row.business_hotspot_score)) : 0;
  const priority = clamp(
    confidencePressure * 0.62 +
      conflict * 0.26 +
      contextRisk * 0.08 +
      hotspot * 0.04,
  );
  if (priority < 0.18) return null;
  return {
    slice_index: nextSliceForFeedback(row.slice_index, sliceIndexes),
    source_slice_index: row.slice_index,
    target_type: type,
    target_id: type === "link" ? row.link_id : row.node_id,
    priority_score: round(priority),
    confidence: row.confidence,
    completion_error_score: "",
    confidence_pressure: round(confidencePressure),
    uncertainty_pressure: round(conflict),
    context_risk: round(contextRisk),
    observation_source: row.observation_source,
    feedback_basis: "observable-uncertainty",
    reason: [
      confidencePressure > 0.35 ? "low-oam-observation-confidence" : "",
      conflict > 0.2 ? "conflicting-oam-observation-reports" : "",
      contextRisk > 0.4 ? type === "link" ? "risky-satellite-context" : "risky-node-context" : "",
      hotspot > 0.35 ? "business-hotspot" : "",
    ].filter(Boolean).join(" > ") || "oam-quality-feedback",
  };
}

export function buildDeployableCompletionPriorityRetests({
  reconstructionRows = [],
  nodeReconstructionRows = [],
  sliceIndexes = [],
  maxPerSlice = 24,
  oamQualityFeedbackEnabled = false,
} = {}) {
  const rows = [];
  reconstructionRows.forEach((row) => {
    if (row.observation_source === "inferred") {
      const candidate = inferredRetestRow({ row, type: "link", sliceIndexes });
      if (candidate) rows.push(candidate);
    } else if (oamQualityFeedbackEnabled && row.observation_source === "observed") {
      const candidate = observedRetestRow({ row, type: "link", sliceIndexes });
      if (candidate) rows.push(candidate);
    }
  });
  nodeReconstructionRows.forEach((row) => {
    if (row.observation_source === "inferred") {
      const candidate = inferredRetestRow({ row, type: "node", sliceIndexes });
      if (candidate) rows.push(candidate);
    } else if (oamQualityFeedbackEnabled && row.observation_source === "observed") {
      const candidate = observedRetestRow({ row, type: "node", sliceIndexes });
      if (candidate) rows.push(candidate);
    }
  });

  const bySlice = groupBy(rows, (row) => String(row.slice_index));
  return [...bySlice.values()].flatMap((sliceRows) =>
    sliceRows
      .sort((left, right) => numberValue(right.priority_score) - numberValue(left.priority_score) || String(left.target_id).localeCompare(String(right.target_id)))
      .slice(0, Math.max(1, maxPerSlice)),
  );
}
