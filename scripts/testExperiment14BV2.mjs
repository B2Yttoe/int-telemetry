import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const output = resolve(root, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const runner = resolve(root, "scripts/runExperiment14BProspectiveValidationV2.mjs");
const verify = spawnSync(process.execPath, [runner, "--phase", "verify", "--out", output], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(verify.status, 0, verify.stderr || verify.stdout);
const freeze = JSON.parse(await readFile(resolve(output, "freeze-manifest.json"), "utf8"));
assert.equal(freeze.causality.allow_external_test_values_for_fit, false);
assert.ok(new Date(freeze.windows.gp0_not_before) > new Date(freeze.frozen_at));
assert.notEqual(freeze.baseline_sources.standard.sha256, freeze.baseline_sources.supplemental.sha256);

const early = spawnSync(process.execPath, [runner, "--phase", "gp0", "--out", output], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(early.status, 0, early.stderr || early.stdout);
const earlyResult = JSON.parse(early.stdout);
if (!earlyResult.lock) assert.match(earlyResult.status, /^pending-/);

console.log("Experiment 14B v2 freeze and early-window tests passed.");
