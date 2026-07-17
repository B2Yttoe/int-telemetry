function numberValue(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function aggregateOrbitEpochComparisons(comparisons = []) {
  if (!comparisons.length) throw new Error("At least one orbit epoch comparison is required.");
  const rows = comparisons.flatMap((comparison) =>
    (comparison.result?.rows ?? []).map((row) => ({
      validation_id: comparison.validation_id,
      validation_sha256: comparison.validation_sha256,
      ...row,
    })),
  );
  const values = (field, absolute = false) => rows
    .map((row) => numberValue(row[field]))
    .filter(Number.isFinite)
    .map((value) => absolute ? Math.abs(value) : value);
  const separation = values("epoch_separation_hours");
  const eci = values("eci_position_error_km", true);
  const matchedPerEpoch = comparisons.map((row) => numberValue(row.result?.summary?.matched_satellites, 0));
  const summary = {
    validation_epoch_count: comparisons.length,
    matched_satellites: Math.min(...matchedPerEpoch),
    minimum_matched_satellites_per_epoch: Math.min(...matchedPerEpoch),
    matched_satellite_epoch_pairs: rows.length,
    successful_propagations: comparisons.reduce((sum, row) => sum + numberValue(row.result?.summary?.successful_propagations, 0), 0),
    propagation_failures: comparisons.reduce((sum, row) => sum + numberValue(row.result?.summary?.propagation_failures, 0), 0),
    epoch_separation_mean_hours: round(mean(separation)),
    epoch_separation_p50_hours: round(quantile(separation, 0.5)),
    epoch_separation_p95_hours: round(quantile(separation, 0.95)),
    epoch_separation_min_hours: round(Math.min(...separation)),
    epoch_separation_max_hours: round(Math.max(...separation)),
    positive_epoch_separation_ratio: round(separation.filter((value) => value > 0).length / Math.max(separation.length, 1)),
    eci_position_mae_km: round(mean(eci)),
    eci_position_p50_km: round(quantile(eci, 0.5)),
    eci_position_p95_km: round(quantile(eci, 0.95)),
    radial_mae_km: round(mean(values("radial_error_km", true))),
    along_track_mae_km: round(mean(values("along_track_error_km", true))),
    cross_track_mae_km: round(mean(values("cross_track_error_km", true))),
    inclination_mae_deg: round(mean(values("inclination_difference_deg", true))),
    raan_mae_deg: round(mean(values("raan_difference_deg", true))),
    eccentricity_mae: round(mean(values("eccentricity_difference", true)), 9),
    mean_motion_mae_rev_day: round(mean(values("mean_motion_difference_rev_day", true)), 9),
  };
  return {
    rows,
    summary,
    per_epoch: comparisons.map((comparison) => ({
      validation_id: comparison.validation_id,
      validation_sha256: comparison.validation_sha256,
      ...comparison.result.summary,
    })),
  };
}
