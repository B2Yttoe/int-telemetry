import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("stage2-int/tools/int-mc-reconstructor.mjs", "utf8");
const experimentRunner = await readFile("stage2-int/tools/run-int-experiment.mjs", "utf8");

assert.match(
  source,
  /int-mc-additional-completion-backends\.mjs/,
  "the Ground OAM reconstructor must import the additional backend module",
);

for (const backend of [
  "prior-only",
  "low-rank",
  "soft-impute",
  "kalman-smoother",
  "graph-neighbor",
  "graph-regularized",
  "st-gnn",
  "costco",
]) {
  assert.ok(source.includes(`"${backend}"`), `backend registry is missing ${backend}`);
}

for (const option of [
  "--soft-impute-lambda-ratio",
  "--kalman-process-variance",
  "--kalman-measurement-variance",
  "--kalman-initial-variance",
  "--graph-regularization-weight",
  "--temporal-regularization-weight",
  "--prior-regularization-weight",
  "--low-rank-regularization-weight",
]) {
  assert.ok(source.includes(option), `reconstructor CLI is missing ${option}`);
}

for (const option of [
  "--int-mc-soft-impute-lambda-ratio",
  "--int-mc-kalman-process-variance",
  "--int-mc-kalman-measurement-variance",
  "--int-mc-kalman-initial-variance",
  "--int-mc-graph-regularization-weight",
  "--int-mc-temporal-regularization-weight",
  "--int-mc-prior-regularization-weight",
  "--int-mc-low-rank-regularization-weight",
]) {
  assert.ok(experimentRunner.includes(option), `run-int-experiment CLI is missing ${option}`);
}

assert.match(
  source,
  /completeWithAdditionalBackend\s*\(/,
  "additional backends must use the shared dispatcher",
);
assert.match(
  source,
  /completion_wall_clock_ms/,
  "each matrix summary must expose backend wall-clock cost",
);
assert.match(
  source,
  /prior-initialization|structural-prior/,
  "prior-only aliases must be documented in backend normalization",
);

console.log(JSON.stringify({
  ok: true,
  backend_count: 8,
  cli_regularization_options: 8,
}, null, 2));
