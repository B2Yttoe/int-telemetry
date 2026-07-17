import assert from "node:assert/strict";
import { resolvePass1Mechanisms } from "./experiments/intMcExperimentCore.mjs";

const variant = {
  mechanisms: {
    adaptiveReuse: true,
    importanceAwareTargets: true,
    importanceSelectiveMetadata: true,
    importancePathScoring: true,
  },
};

assert.deepEqual(
  resolvePass1Mechanisms({ variant, selfFeedbackPass1: true }),
  variant.mechanisms,
  "self-feedback replay must generate pass1 OAM with the candidate's own telemetry policy",
);
assert.deepEqual(
  resolvePass1Mechanisms({ variant, selfFeedbackPass1: false }),
  { adaptiveReuse: true },
  "legacy equal-input replay must retain the neutral shared-pass policy",
);

console.log(JSON.stringify({ ok: true, policy: "variant-self-oam" }, null, 2));
