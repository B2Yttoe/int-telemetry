import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const runner = resolve(root, "scripts/runExperiment14BRelocationRecovery.mjs");
const verification = spawnSync(process.execPath, [runner, "--phase", "verify"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(verification.status, 0, verification.stderr || verification.stdout);

const report = resolve(root, "reports/experiment14b-prospective-external-validation");
const collection = JSON.parse(await readFile(resolve(report, "collection-status.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(report, "source-lifecycle/orbit-input-lock.json"), "utf8"));
assert.equal(lock.refresh_allowed, false);
assert.equal(lock.validity_window.end_age_gate_passed, true);
if (collection.sources.orbit_input?.locked) {
  assert.equal(collection.sources.orbit_input.input_ready, true);
  assert.equal(collection.sources.orbit_input.model_input_source, lock.model_input_source);
}

console.log("Experiment 14B relocation recovery tests passed.");
