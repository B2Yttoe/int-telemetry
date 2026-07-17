function finiteNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Non-finite ${field}: ${value}`);
  return parsed;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
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
  if (degreesOfFreedom <= 60) return 2;
  if (degreesOfFreedom <= 120) return 1.98;
  return 1.96;
}

function summarize(values) {
  if (!values.length) throw new Error("Cannot summarize an empty sample");
  const center = mean(values);
  const std = sampleStandardDeviation(values);
  const halfWidth = values.length > 1 ? tCritical95(values.length - 1) * std / Math.sqrt(values.length) : 0;
  return {
    mean: round(center),
    std: round(std),
    ci95_low: round(center - halfWidth),
    ci95_high: round(center + halfWidth),
    cohen_dz: round(std > 0 ? center / std : 0),
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
  return `${row.profile_id}|${finiteNumber(row.stress_rate, "stress_rate")}|${row.seed}`;
}

export function buildContributionSamples(rows = [], {
  fullMethodId,
  ablationMethodIds = [],
  metricDirections = {},
} = {}) {
  if (!fullMethodId) throw new Error("fullMethodId is required");
  if (!ablationMethodIds.length) throw new Error("At least one ablation method is required");
  if (!Object.keys(metricDirections).length) throw new Error("At least one metric direction is required");

  const samples = [];
  for (const [key, scenarioRows] of groupBy(rows, scenarioKey)) {
    const full = scenarioRows.find((row) => row.method_id === fullMethodId);
    if (!full) throw new Error(`Missing full method in ablation pair: ${key}`);
    for (const ablationMethodId of ablationMethodIds) {
      const ablated = scenarioRows.find((row) => row.method_id === ablationMethodId);
      if (!ablated) throw new Error(`Missing ablation pair: ${key}|${ablationMethodId}`);
      for (const [metric, direction] of Object.entries(metricDirections)) {
        if (direction !== "lower" && direction !== "higher") {
          throw new Error(`Unsupported metric direction for ${metric}: ${direction}`);
        }
        const fullValue = finiteNumber(full[metric], `${fullMethodId}.${metric}`);
        const ablatedValue = finiteNumber(ablated[metric], `${ablationMethodId}.${metric}`);
        const contribution = direction === "higher"
          ? fullValue - ablatedValue
          : ablatedValue - fullValue;
        samples.push({
          profile_id: full.profile_id,
          constellation_label: full.constellation_label ?? "",
          stress_rate: finiteNumber(full.stress_rate, "stress_rate"),
          seed: full.seed,
          full_method_id: fullMethodId,
          ablation_method_id: ablationMethodId,
          metric,
          direction,
          full_value: fullValue,
          ablated_value: ablatedValue,
          contribution: round(contribution),
        });
      }
    }
  }
  return samples.sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.stress_rate - right.stress_rate
    || String(left.seed).localeCompare(String(right.seed))
    || left.ablation_method_id.localeCompare(right.ablation_method_id)
    || left.metric.localeCompare(right.metric));
}

export function aggregateContributionSamples(samples = []) {
  const groups = groupBy(
    samples,
    (row) => `${row.profile_id}|${row.stress_rate}|${row.ablation_method_id}|${row.metric}`,
  );
  return [...groups.values()].map((group) => {
    const first = group[0];
    const summary = summarize(group.map((row) => finiteNumber(row.contribution, "contribution")));
    return {
      profile_id: first.profile_id,
      constellation_label: first.constellation_label,
      stress_rate: first.stress_rate,
      full_method_id: first.full_method_id,
      ablation_method_id: first.ablation_method_id,
      metric: first.metric,
      direction: first.direction,
      sample_count: group.length,
      contribution_mean: summary.mean,
      contribution_std: summary.std,
      contribution_ci95_low: summary.ci95_low,
      contribution_ci95_high: summary.ci95_high,
      cohen_dz: summary.cohen_dz,
    };
  }).sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.stress_rate - right.stress_rate
    || left.ablation_method_id.localeCompare(right.ablation_method_id)
    || left.metric.localeCompare(right.metric));
}

export function buildDynamicityInteractions(samples = [], { lowStress = 0, highStress = 0.25 } = {}) {
  const pairedGroups = groupBy(
    samples,
    (row) => `${row.profile_id}|${row.seed}|${row.ablation_method_id}|${row.metric}`,
  );
  const interactionSamples = [];
  for (const [key, group] of pairedGroups) {
    const low = group.find((row) => Number(row.stress_rate) === Number(lowStress));
    const high = group.find((row) => Number(row.stress_rate) === Number(highStress));
    if (!low || !high) throw new Error(`Missing dynamicity pair: ${key}`);
    interactionSamples.push({
      profile_id: low.profile_id,
      constellation_label: low.constellation_label,
      seed: low.seed,
      full_method_id: low.full_method_id,
      ablation_method_id: low.ablation_method_id,
      metric: low.metric,
      direction: low.direction,
      low_stress_rate: Number(lowStress),
      high_stress_rate: Number(highStress),
      low_stress_contribution: low.contribution,
      high_stress_contribution: high.contribution,
      interaction: round(high.contribution - low.contribution),
    });
  }

  const groups = groupBy(
    interactionSamples,
    (row) => `${row.profile_id}|${row.ablation_method_id}|${row.metric}`,
  );
  return [...groups.values()].map((group) => {
    const first = group[0];
    const summary = summarize(group.map((row) => finiteNumber(row.interaction, "interaction")));
    return {
      profile_id: first.profile_id,
      constellation_label: first.constellation_label,
      full_method_id: first.full_method_id,
      ablation_method_id: first.ablation_method_id,
      metric: first.metric,
      direction: first.direction,
      low_stress_rate: first.low_stress_rate,
      high_stress_rate: first.high_stress_rate,
      sample_count: group.length,
      interaction_mean: summary.mean,
      interaction_std: summary.std,
      interaction_ci95_low: summary.ci95_low,
      interaction_ci95_high: summary.ci95_high,
      cohen_dz: summary.cohen_dz,
    };
  }).sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id)
    || left.ablation_method_id.localeCompare(right.ablation_method_id)
    || left.metric.localeCompare(right.metric));
}
