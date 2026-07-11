import { json2satrec, propagate } from "satellite.js";

function numberValue(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function utcDate(value) {
  const text = String(value ?? "").trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  return new Date(normalized);
}

function vector(value) {
  return { x: numberValue(value?.x), y: numberValue(value?.y), z: numberValue(value?.z) };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function norm(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function unit(value) {
  const length = norm(value);
  if (!Number.isFinite(length) || length <= 0) throw new Error("Cannot normalize zero orbital vector");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function circularDifference(left, right) {
  const a = numberValue(left);
  const b = numberValue(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return ((a - b + 540) % 360) - 180;
}

function noradId(satellite) {
  return String(satellite?.norad_id ?? satellite?.NORAD_CAT_ID ?? satellite?.raw_omm?.NORAD_CAT_ID ?? "");
}

function omm(satellite) {
  if (satellite?.raw_omm) return satellite.raw_omm;
  return satellite;
}

function propagateSatellite(satellite, time) {
  const satrec = json2satrec(omm(satellite));
  const state = propagate(satrec, time);
  if (!state?.position || !state?.velocity || state.position === false || state.velocity === false) {
    throw new Error("SGP4 propagation returned no position/velocity");
  }
  return { position: vector(state.position), velocity: vector(state.velocity) };
}

function satellites(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return Array.isArray(snapshot?.satellites) ? snapshot.satellites : [];
}

function element(satellite, key, rawKey) {
  return numberValue(satellite?.[key] ?? satellite?.raw_omm?.[rawKey] ?? satellite?.[rawKey], null);
}

export function compareOrbitEpochs({ modelSnapshot, validationSnapshot, comparisonTime } = {}) {
  const time = utcDate(comparisonTime ?? validationSnapshot?.generated_at ?? validationSnapshot?.downloaded_at);
  if (!Number.isFinite(time.getTime())) throw new Error("A valid cross-epoch comparison time is required");
  const validationByNorad = new Map(
    satellites(validationSnapshot).map((satellite) => [noradId(satellite), satellite]).filter(([id]) => id),
  );
  const rows = [];
  let propagationFailures = 0;
  for (const model of satellites(modelSnapshot)) {
    const id = noradId(model);
    const validation = validationByNorad.get(id);
    if (!validation) continue;
    try {
      const modelState = propagateSatellite(model, time);
      const validationState = propagateSatellite(validation, time);
      const delta = subtract(modelState.position, validationState.position);
      const radialUnit = unit(validationState.position);
      const crossTrackUnit = unit(cross(validationState.position, validationState.velocity));
      const alongTrackUnit = unit(cross(crossTrackUnit, radialUnit));
      const radialError = dot(delta, radialUnit);
      const alongTrackError = dot(delta, alongTrackUnit);
      const crossTrackError = dot(delta, crossTrackUnit);
      const modelEpoch = utcDate(model.epoch ?? model.raw_omm?.EPOCH);
      const validationEpoch = utcDate(validation.epoch ?? validation.raw_omm?.EPOCH);
      rows.push({
        norad_id: id,
        satellite_name: validation.satellite_name ?? validation.OBJECT_NAME ?? validation.raw_omm?.OBJECT_NAME ?? "",
        model_satellite_id: model.satellite_id ?? "",
        validation_satellite_id: validation.satellite_id ?? "",
        model_epoch: Number.isFinite(modelEpoch.getTime()) ? modelEpoch.toISOString() : "",
        validation_epoch: Number.isFinite(validationEpoch.getTime()) ? validationEpoch.toISOString() : "",
        epoch_separation_hours: Number.isFinite(modelEpoch.getTime()) && Number.isFinite(validationEpoch.getTime())
          ? round((validationEpoch.getTime() - modelEpoch.getTime()) / 3_600_000)
          : null,
        comparison_time: time.toISOString(),
        eci_position_error_km: round(norm(delta)),
        radial_error_km: round(radialError),
        along_track_error_km: round(alongTrackError),
        cross_track_error_km: round(crossTrackError),
        altitude_difference_km: round(norm(modelState.position) - norm(validationState.position)),
        inclination_difference_deg: round(element(model, "inclination", "INCLINATION") - element(validation, "inclination", "INCLINATION")),
        raan_difference_deg: round(circularDifference(element(model, "raan", "RA_OF_ASC_NODE"), element(validation, "raan", "RA_OF_ASC_NODE"))),
        eccentricity_difference: round(element(model, "eccentricity", "ECCENTRICITY") - element(validation, "eccentricity", "ECCENTRICITY"), 9),
        mean_motion_difference_rev_day: round(element(model, "mean_motion", "MEAN_MOTION") - element(validation, "mean_motion", "MEAN_MOTION"), 9),
      });
    } catch (error) {
      propagationFailures += 1;
      rows.push({
        norad_id: id,
        model_satellite_id: model.satellite_id ?? "",
        validation_satellite_id: validation.satellite_id ?? "",
        comparison_time: time.toISOString(),
        propagation_error: error.message,
      });
    }
  }
  const successful = rows.filter((row) => Number.isFinite(row.eci_position_error_km));
  const absolute = (field) => successful.map((row) => Math.abs(numberValue(row[field])));
  const positionErrors = absolute("eci_position_error_km");
  return {
    rows,
    summary: {
      model_satellites: satellites(modelSnapshot).length,
      validation_satellites: satellites(validationSnapshot).length,
      matched_satellites: rows.length,
      successful_propagations: successful.length,
      propagation_failures: propagationFailures,
      comparison_time: time.toISOString(),
      eci_position_mae_km: round(mean(positionErrors)),
      eci_position_p50_km: round(quantile(positionErrors, 0.5)),
      eci_position_p95_km: round(quantile(positionErrors, 0.95)),
      radial_mae_km: round(mean(absolute("radial_error_km"))),
      along_track_mae_km: round(mean(absolute("along_track_error_km"))),
      cross_track_mae_km: round(mean(absolute("cross_track_error_km"))),
      inclination_mae_deg: round(mean(absolute("inclination_difference_deg"))),
      raan_mae_deg: round(mean(absolute("raan_difference_deg"))),
      eccentricity_mae: round(mean(absolute("eccentricity_difference")), 9),
      mean_motion_mae_rev_day: round(mean(absolute("mean_motion_difference_rev_day")), 9),
    },
  };
}
