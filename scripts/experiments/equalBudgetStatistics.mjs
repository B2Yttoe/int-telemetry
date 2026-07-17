const DEFAULT_METRIC_DIRECTIONS = Object.freeze({
  telemetry_bytes_per_node_slice: "lower",
  telemetry_padding_bytes_per_node_slice: "lower",
  total_telemetry_energy_j: "lower",
  planning_wall_time_ms: "lower",
  reconstruction_wall_time_ms: "lower",
  invalid_probe_path_ratio: "lower",
  cpu_mae: "lower",
  queue_depth_mae: "lower",
  energy_percent_mae: "lower",
  link_utilization_mae: "lower",
  node_mode_accuracy: "higher",
  link_status_accuracy: "higher",
});

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1));
}

function tCritical95(degreesOfFreedom) {
  const table = [
    0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (degreesOfFreedom <= 0) return 0;
  if (degreesOfFreedom < table.length) return table[degreesOfFreedom];
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2.000;
  if (degreesOfFreedom <= 120) return 1.980;
  return 1.960;
}

function confidenceSummary(values) {
  const center = mean(values);
  const std = sampleStandardDeviation(values);
  const halfWidth = values.length > 1 ? tCritical95(values.length - 1) * std / Math.sqrt(values.length) : 0;
  return {
    mean: round(center),
    std: round(std),
    ci95_low: round(center - halfWidth),
    ci95_high: round(center + halfWidth),
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function scenarioKey(row) {
  return `${row.profile_id}|${numberValue(row.stress_rate)}|${row.seed}`;
}

export function aggregateEqualBudgetRows(rows = [], { metrics = Object.keys(DEFAULT_METRIC_DIRECTIONS) } = {}) {
  const groups = groupBy(rows, (row) => `${row.profile_id}|${numberValue(row.stress_rate)}|${row.method_id}`);
  return [...groups.values()].map((group) => {
    const first = group[0];
    const result = {
      profile_id: first.profile_id,
      constellation_label: first.constellation_label ?? "",
      stress_rate: numberValue(first.stress_rate),
      method_id: first.method_id,
      method_label: first.method_label ?? "",
      sample_count: group.length,
    };
    for (const metric of metrics) {
      const summary = confidenceSummary(group.map((row) => numberValue(row[metric])));
      result[`${metric}_mean`] = summary.mean;
      result[`${metric}_std`] = summary.std;
      result[`${metric}_ci95_low`] = summary.ci95_low;
      result[`${metric}_ci95_high`] = summary.ci95_high;
    }
    return result;
  }).sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.stress_rate - right.stress_rate
    || left.method_id.localeCompare(right.method_id));
}

export function buildPairedMethodEffects(rows = [], {
  treatment = "enhanced",
  controls = ["native-full-replan", "native-reference-replay"],
  metricDirections = DEFAULT_METRIC_DIRECTIONS,
} = {}) {
  const byScenario = groupBy(rows, scenarioKey);
  const paired = [];
  for (const scenarioRows of byScenario.values()) {
    const treatmentRow = scenarioRows.find((row) => row.method_id === treatment);
    if (!treatmentRow) continue;
    for (const controlMethod of controls) {
      const controlRow = scenarioRows.find((row) => row.method_id === controlMethod);
      if (!controlRow) continue;
      for (const [metric, direction] of Object.entries(metricDirections)) {
        const treatmentValue = numberValue(treatmentRow[metric]);
        const controlValue = numberValue(controlRow[metric]);
        const improvement = direction === "higher"
          ? treatmentValue - controlValue
          : controlValue - treatmentValue;
        paired.push({
          profile_id: treatmentRow.profile_id,
          constellation_label: treatmentRow.constellation_label ?? "",
          stress_rate: numberValue(treatmentRow.stress_rate),
          seed: treatmentRow.seed,
          treatment_method_id: treatment,
          control_method_id: controlMethod,
          metric,
          direction,
          treatment_value: treatmentValue,
          control_value: controlValue,
          improvement,
        });
      }
    }
  }

  const groups = groupBy(paired, (row) => `${row.profile_id}|${row.stress_rate}|${row.control_method_id}|${row.metric}`);
  return [...groups.values()].map((group) => {
    const first = group[0];
    const values = group.map((row) => row.improvement);
    const summary = confidenceSummary(values);
    const rawStd = sampleStandardDeviation(values);
    const controlMean = mean(group.map((row) => row.control_value));
    return {
      profile_id: first.profile_id,
      constellation_label: first.constellation_label,
      stress_rate: first.stress_rate,
      treatment_method_id: first.treatment_method_id,
      control_method_id: first.control_method_id,
      metric: first.metric,
      direction: first.direction,
      paired_samples: values.length,
      improvement_mean: summary.mean,
      improvement_std: summary.std,
      improvement_ci95_low: summary.ci95_low,
      improvement_ci95_high: summary.ci95_high,
      relative_improvement: round(summary.mean / Math.max(Math.abs(controlMean), 1e-12)),
      cohen_dz: round(rawStd > 0 ? mean(values) / rawStd : 0),
    };
  }).sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.stress_rate - right.stress_rate
    || left.control_method_id.localeCompare(right.control_method_id)
    || left.metric.localeCompare(right.metric));
}

export function auditEqualBudgetFairness(rows = [], {
  requiredMethods = ["native-full-replan", "enhanced", "native-reference-replay"],
  primaryMatchedMethods = ["native-full-replan", "enhanced"],
  achievedBudgetToleranceRatio = 0.05,
} = {}) {
  const groups = groupBy(rows, scenarioKey);
  return [...groups.values()].map((group) => {
    const first = group[0];
    const methods = new Set(group.map((row) => row.method_id));
    const caps = group.map((row) => numberValue(row.telemetry_byte_budget_per_node_slice));
    const actual = group.map((row) => numberValue(row.telemetry_bytes_per_node_slice));
    const violations = group.reduce((total, row) => total + numberValue(row.telemetry_byte_budget_cap_violations), 0);
    const hardCapSpread = Math.max(...caps) - Math.min(...caps);
    const actualSpread = Math.max(...actual) - Math.min(...actual);
    const primaryRows = group.filter((row) => primaryMatchedMethods.includes(row.method_id));
    const primaryActual = primaryRows.map((row) => numberValue(row.telemetry_bytes_per_node_slice));
    const primaryActualSpread = primaryActual.length
      ? Math.max(...primaryActual) - Math.min(...primaryActual)
      : Number.POSITIVE_INFINITY;
    const primaryActualSpreadRatio = primaryActualSpread / Math.max(caps[0] ?? 0, 1e-12);
    const primaryMatchOk = primaryRows.length === primaryMatchedMethods.length
      && primaryActualSpreadRatio <= achievedBudgetToleranceRatio;
    const missingMethods = requiredMethods.filter((method) => !methods.has(method));
    return {
      profile_id: first.profile_id,
      constellation_label: first.constellation_label ?? "",
      stress_rate: numberValue(first.stress_rate),
      seed: first.seed,
      method_count: methods.size,
      required_method_count: requiredMethods.length,
      missing_methods: missingMethods.join(" > "),
      hard_cap_bytes_per_node_slice: caps[0] ?? 0,
      hard_cap_spread: round(hardCapSpread),
      actual_bytes_per_node_slice_min: round(Math.min(...actual)),
      actual_bytes_per_node_slice_max: round(Math.max(...actual)),
      actual_bytes_per_node_slice_spread: round(actualSpread),
      primary_matched_methods: primaryMatchedMethods.join(" > "),
      primary_method_actual_spread: round(primaryActualSpread),
      primary_method_actual_spread_ratio: round(primaryActualSpreadRatio),
      primary_achieved_budget_tolerance_ratio: achievedBudgetToleranceRatio,
      primary_achieved_budget_match_ok: primaryMatchOk,
      cap_violations: violations,
      ok: missingMethods.length === 0 && hardCapSpread <= 1e-9 && violations === 0 && primaryMatchOk,
    };
  }).sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.stress_rate - right.stress_rate
    || String(left.seed).localeCompare(String(right.seed)));
}

export function validateEqualBudgetMatrix(rows = [], {
  profileIds = [],
  stressRates = [],
  seeds = [],
  methodIds = [],
} = {}) {
  const expected = [];
  for (const profileId of profileIds) {
    for (const stressRate of stressRates) {
      for (const seed of seeds) {
        for (const methodId of methodIds) expected.push(`${profileId}|${Number(stressRate)}|${seed}|${methodId}`);
      }
    }
  }
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.profile_id}|${numberValue(row.stress_rate)}|${row.seed}|${row.method_id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = expected.filter((key) => !counts.has(key));
  const duplicates = [...counts.entries()].filter(([, count]) => count !== 1).map(([key]) => key);
  if (missing.length || duplicates.length) {
    throw new Error(`Equal-budget matrix missing combinations=${missing.length}, duplicate combinations=${duplicates.length}`);
  }
  return { ok: true, expected_rows: expected.length, actual_rows: rows.length };
}

export { DEFAULT_METRIC_DIRECTIONS };
