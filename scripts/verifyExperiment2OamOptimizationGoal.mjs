import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function selectedProfiles(value, available) {
  const requested = String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return requested.length > 0 ? requested : available;
}

function rowMap(rows) {
  return new Map(rows.map((row) => [`${row.constellation_profile_id}|${row.version}`, row]));
}

function requireFinite(checks, { profile, field, candidate, limit, comparison }) {
  const candidateValue = numberValue(candidate);
  const limitValue = numberValue(limit);
  const finite = Number.isFinite(candidateValue) && Number.isFinite(limitValue);
  const pass = finite && (comparison === "max"
    ? candidateValue <= limitValue + 1e-12
    : candidateValue >= limitValue - 1e-12);
  checks.push({
    constellation_profile_id: profile,
    field,
    candidate: finite ? candidateValue : candidate,
    limit: Number.isFinite(limitValue) ? limitValue : limit,
    comparison,
    pass,
  });
}

const args = process.argv.slice(2);
const referencePath = resolve(argValue(args, "--reference"));
const candidatePath = resolve(argValue(args, "--candidate"));
if (!argValue(args, "--reference") || !argValue(args, "--candidate")) {
  throw new Error("usage: --reference <current-enhanced.json> --candidate <candidate.json> [--profiles id,id]");
}

const [reference, candidate] = await Promise.all([
  readFile(referencePath, "utf8").then(JSON.parse),
  readFile(candidatePath, "utf8").then(JSON.parse),
]);
const referenceRows = rowMap(reference.rows ?? []);
const candidateRows = rowMap(candidate.rows ?? []);
const availableProfiles = [...new Set((candidate.rows ?? []).map((row) => row.constellation_profile_id).filter(Boolean))];
const profiles = selectedProfiles(argValue(args, "--profiles", ""), availableProfiles);
const maeFields = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
const accuracyFields = ["node_mode_accuracy", "link_status_accuracy"];
const checks = [];

profiles.forEach((profile) => {
  const candidateBefore = candidateRows.get(`${profile}|before`);
  const candidateAfter = candidateRows.get(`${profile}|after`);
  const referenceAfter = referenceRows.get(`${profile}|after`);
  if (!candidateBefore || !candidateAfter || !referenceAfter) {
    checks.push({
      constellation_profile_id: profile,
      field: "required_rows",
      candidate: Boolean(candidateBefore && candidateAfter && referenceAfter),
      limit: true,
      comparison: "equal",
      pass: false,
    });
    return;
  }

  requireFinite(checks, {
    profile,
    field: "telemetry_bytes_per_node_slice",
    candidate: candidateAfter.telemetry_bytes_per_node_slice,
    limit: candidateBefore.telemetry_bytes_per_node_slice,
    comparison: "max",
  });
  maeFields.forEach((field) => requireFinite(checks, {
    profile,
    field,
    candidate: candidateAfter[field],
    limit: numberValue(referenceAfter[field]) * 1.01,
    comparison: "max",
  }));
  accuracyFields.forEach((field) => requireFinite(checks, {
    profile,
    field,
    candidate: candidateAfter[field],
    limit: numberValue(referenceAfter[field]) - 0.001,
    comparison: "min",
  }));
});

const failures = checks.filter((check) => !check.pass);
const result = {
  schema_version: "experiment2-oam-optimization-goal-v1",
  reference: referencePath,
  candidate: candidatePath,
  profiles,
  tolerances: {
    mae_relative_max: 0.01,
    accuracy_absolute_drop_max: 0.001,
    bytes_must_not_exceed_before: true,
  },
  passed: failures.length === 0,
  checks,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
