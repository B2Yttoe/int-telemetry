import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reconstructor = await readFile("stage2-int/tools/int-mc-reconstructor.mjs", "utf8");
const runner = await readFile("stage2-int/tools/run-int-experiment.mjs", "utf8");

assert.match(reconstructor, /int-mc-joint-tensor-completion\.mjs/);
assert.ok(reconstructor.includes('"joint-cp"'));
assert.ok(reconstructor.includes('"joint-cp-physics"'));
assert.match(reconstructor, /isJointTensorBackend/);
assert.match(reconstructor, /scalarCompletionBackend/);
assert.match(
  reconstructor,
  /scalarCompletionBackend\s*=\s*isJointTensorBackend\(completionBackend\)\s*\?\s*"low-rank"/,
  "joint completion must refine the independent low-rank baseline instead of replacing it with prior-only estimates",
);
assert.match(reconstructor, /applyJointTensorCompletion/);
assert.match(reconstructor, /joint_tensor_completion/);
assert.match(reconstructor, /jointTensorPhysicsProjectionEnabled/);
assert.match(reconstructor, /--joint-tensor-epochs", 60/);
assert.match(reconstructor, /--joint-tensor-learning-rate", 0\.05/);

for (const option of [
  "--joint-tensor-rank",
  "--joint-tensor-epochs",
  "--joint-tensor-learning-rate",
  "--joint-tensor-l2",
  "--joint-tensor-prediction-weight",
  "--joint-tensor-temporal-regularization",
  "--joint-tensor-orbit-regularization",
]) {
  assert.ok(reconstructor.includes(option), `reconstructor is missing ${option}`);
}

for (const option of [
  "--int-mc-joint-tensor-rank",
  "--int-mc-joint-tensor-epochs",
  "--int-mc-joint-tensor-learning-rate",
  "--int-mc-joint-tensor-prediction-weight",
]) {
  assert.ok(runner.includes(option), `run-int-experiment is missing ${option}`);
}

console.log(JSON.stringify({
  ok: true,
  joint_backends: ["joint-cp", "joint-cp-physics"],
  reconstructor_options: 7,
}, null, 2));
