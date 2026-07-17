import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const VALID_ROLES = new Set(["model-input", "external-validation", "context-only"]);

function iso(value) {
  if (!value) return "";
  const text = String(value).trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function recordsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.satellites)) return value.satellites;
  if (Array.isArray(value?.records)) return value.records;
  return value && typeof value === "object" ? [value] : [];
}

function epochOf(record) {
  return iso(record?.epoch ?? record?.EPOCH ?? record?.tle_epoch ?? record?.time);
}

function epochRange(records) {
  const epochs = records.map(epochOf).filter(Boolean).sort();
  let epochMedian = "";
  if (epochs.length > 0) {
    const middle = Math.floor(epochs.length / 2);
    if (epochs.length % 2 === 1) {
      epochMedian = epochs[middle];
    } else {
      const left = new Date(epochs[middle - 1]).getTime();
      const right = new Date(epochs[middle]).getTime();
      epochMedian = new Date((left + right) / 2).toISOString();
    }
  }
  return {
    epoch_start: epochs[0] ?? "",
    epoch_end: epochs.at(-1) ?? "",
    epoch_median: epochMedian,
  };
}

export async function buildEpochRecord({
  name,
  url,
  path,
  role,
  parserVersion,
  retrievedAt = "",
} = {}) {
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid external evidence role: ${role}`);
  if (!name) throw new Error("External epoch name is required");
  if (!url) throw new Error(`External epoch URL is required for ${name}`);
  if (!path) throw new Error(`External epoch path is required for ${name}`);
  if (!parserVersion) throw new Error(`Parser version is required for ${name}`);
  const absolutePath = resolve(path);
  const [bytes, fileStat] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  const value = JSON.parse(bytes.toString("utf8"));
  const records = recordsFromJson(value);
  const range = epochRange(records);
  const retrieval = iso(
    retrievedAt || value?.downloaded_at || value?.generated_at || value?.retrieved_at || fileStat.mtime.toISOString(),
  );
  if (!retrieval) throw new Error(`Retrieval timestamp is required for ${name}`);
  return {
    name,
    url,
    role,
    local_path: absolutePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    retrieved_at: retrieval,
    epoch_start: range.epoch_start,
    epoch_end: range.epoch_end,
    epoch_median: range.epoch_median,
    record_count: records.length,
    parser_version: parserVersion,
  };
}

export function auditEpochIndependence(records = [], { minimumValidationEpochs = 1 } = {}) {
  const inputs = records.filter((record) => record.role === "model-input");
  const validations = records.filter((record) => record.role === "external-validation");
  const violations = [];
  const comparisons = [];
  if (inputs.length === 0) violations.push("No model-input epoch is registered.");
  if (validations.length === 0) violations.push("No external-validation epoch is registered.");
  if (validations.length < minimumValidationEpochs) {
    violations.push(`External validation requires at least ${minimumValidationEpochs} independent validation epochs.`);
  }
  for (let left = 0; left < validations.length; left += 1) {
    for (let right = left + 1; right < validations.length; right += 1) {
      if (validations[left].sha256 && validations[left].sha256 === validations[right].sha256) {
        violations.push(`${validations[left].name} and ${validations[right].name} validation epochs use the same SHA-256.`);
      }
    }
  }
  inputs.forEach((input) => {
    validations.forEach((validation) => {
      const sameHash = Boolean(input.sha256) && input.sha256 === validation.sha256;
      const inputEpoch = new Date(input.epoch_median || input.epoch_end || input.epoch_start).getTime();
      const validationEpoch = new Date(validation.epoch_median || validation.epoch_start || validation.epoch_end).getTime();
      const elapsedHours = Number.isFinite(inputEpoch) && Number.isFinite(validationEpoch)
        ? (validationEpoch - inputEpoch) / 3_600_000
        : null;
      comparisons.push({
        model_input_name: input.name,
        validation_name: validation.name,
        model_input_sha256: input.sha256,
        validation_sha256: validation.sha256,
        same_sha256: sameHash,
        elapsed_hours: elapsedHours,
      });
      if (sameHash) {
        violations.push(`${input.name} and ${validation.name} use the same SHA-256 and are not independent.`);
      }
      if (!input.epoch_start || !validation.epoch_start) {
        violations.push(`${input.name} or ${validation.name} has no parseable orbital epoch.`);
      }
      if (elapsedHours !== null && elapsedHours <= 0) {
        violations.push(`${validation.name} is not later than model input ${input.name}.`);
      }
    });
  });
  return {
    ok: violations.length === 0,
    violations,
    comparisons,
    model_input_count: inputs.length,
    external_validation_count: validations.length,
  };
}
