import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  EXPERIMENT7_CHECK_IDS,
  auditReconstructionInvariants,
  buildObservablePlannerHash,
  perturbHiddenTruthRows,
  runExperiment7,
} from "./runExperiment7NoTruthLeakage.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

assert.deepEqual(EXPERIMENT7_CHECK_IDS, [
  "observable-schema",
  "illegal-feedback-rejection",
  "hidden-truth-invariance",
  "future-feedback-invariance",
  "causal-lag",
  "observed-value-lock",
  "inactive-mask-lock",
  "truth-use-audit",
]);

const truthLinks = [0, 1, 2].map((sliceIndex) => ({
  slice_index: sliceIndex,
  link_id: "L1",
  source: "N1",
  target: "N2",
  kind: "inter-plane",
  is_active: true,
  status: sliceIndex === 2 ? "warning" : "up",
  utilization_percent: 10 + sliceIndex,
  queue_latency_ms: 1 + sliceIndex,
  congestion_percent: sliceIndex,
}));
const truthNodes = [0, 1, 2].map((sliceIndex) => ({
  slice_index: sliceIndex,
  node_id: "N1",
  plane: 0,
  slot: 0,
  latitude: 10 + sliceIndex,
  longitude: 20 + sliceIndex,
  cpu_percent: 5 + sliceIndex,
  queue_depth: sliceIndex,
  energy_percent: 90 - sliceIndex,
  mode: "nominal",
}));
const predictedPlan = {
  entries: truthLinks.map((row) => ({
    slice_index: row.slice_index,
    link_id: row.link_id,
    source: row.source,
    target: row.target,
    kind: row.kind,
    predicted_active: true,
    capacity_mbps: 1000,
    distance_km: 1200,
  })),
};
const oamLinks = [0, 1].map((sliceIndex) => ({
  slice_index: sliceIndex,
  link_id: "L1",
  status_estimate: "up",
  utilization_percent_estimate: 40 + sliceIndex,
  queue_latency_ms_estimate: 3,
  confidence: 0.7,
  observation_source: "inferred",
}));
const oamNodes = [0, 1].map((sliceIndex) => ({
  slice_index: sliceIndex,
  node_id: "N1",
  cpu_percent_estimate: 30 + sliceIndex,
  queue_depth_estimate: 4,
  energy_percent_estimate: 70,
  mode_estimate: "nominal",
  confidence: 0.7,
  observation_source: "inferred",
}));
const feedback = [{
  source_slice_index: 0,
  slice_index: 1,
  target_type: "link",
  target_id: "L1",
  feedback_source: "int-mc-deployable",
  feedback_basis: "observable-uncertainty",
  reason: "low-completion-confidence",
  priority_score: 0.8,
  completion_error_score: "",
}];

const perturbedLinks = perturbHiddenTruthRows(truthLinks, "link");
const perturbedNodes = perturbHiddenTruthRows(truthNodes, "node");
assert.notEqual(perturbedLinks[0].utilization_percent, truthLinks[0].utilization_percent);
assert.notEqual(perturbedLinks[0].status, truthLinks[0].status);
assert.equal(perturbedLinks[0].link_id, truthLinks[0].link_id);
assert.equal(perturbedLinks[0].source, truthLinks[0].source);
assert.notEqual(perturbedNodes[0].cpu_percent, truthNodes[0].cpu_percent);
assert.notEqual(perturbedNodes[0].energy_percent, truthNodes[0].energy_percent);
assert.equal(perturbedNodes[0].node_id, truthNodes[0].node_id);

const originalHash = buildObservablePlannerHash({
  truthLinks,
  truthNodes,
  predictedPlan,
  oamLinks,
  oamNodes,
  feedback,
  stateLagSlices: 1,
  protectedThroughSlice: 2,
});
const perturbedHash = buildObservablePlannerHash({
  truthLinks: perturbedLinks,
  truthNodes: perturbedNodes,
  predictedPlan,
  oamLinks,
  oamNodes,
  feedback,
  stateLagSlices: 1,
  protectedThroughSlice: 2,
});
assert.equal(perturbedHash, originalHash, "hidden truth changes must not alter observable planner input hash");

const futureFeedback = [...feedback, {
  source_slice_index: 2,
  slice_index: 3,
  target_type: "node",
  target_id: "N1",
  feedback_source: "int-mc-deployable",
  feedback_basis: "observable-uncertainty",
  reason: "future-only",
  priority_score: 1,
  completion_error_score: "",
}];
assert.equal(buildObservablePlannerHash({
  truthLinks,
  truthNodes,
  predictedPlan,
  oamLinks,
  oamNodes,
  feedback: futureFeedback,
  stateLagSlices: 1,
  protectedThroughSlice: 2,
}), originalHash, "feedback sourced at the cutoff must not change planning through the cutoff");

const invariantAudit = auditReconstructionInvariants({
  observedNodes: [{ slice_index: 0, node_id: "N1", cpu_percent: 30, mode: "nominal" }],
  completedNodes: [{ slice_index: 0, node_id: "N1", cpu_percent_estimate: 30, mode_estimate: "nominal" }],
  observedLinks: [{ slice_index: 0, link_id: "L1", utilization_percent: 40, status: "up" }],
  completedLinks: [
    { slice_index: 0, link_id: "L1", utilization_percent_estimate: 40, status_estimate: "up" },
    { slice_index: 1, link_id: "L1", utilization_percent_estimate: 0, status_estimate: "down" },
  ],
  predictedPlan: { entries: [{ slice_index: 1, link_id: "L1", predicted_active: false }] },
});
assert.equal(invariantAudit.observed_value_mismatches, 0);
assert.equal(invariantAudit.inactive_mask_violations, 0);

const maskedObservationAudit = auditReconstructionInvariants({
  observedLinks: [{
    slice_index: 0,
    link_id: "L-masked",
    observed: true,
    utilization_percent_estimate: 0,
    status_estimate: "up",
  }],
  completedLinks: [{
    slice_index: 0,
    link_id: "L-masked",
    observed: true,
    topology_down: true,
    utilization_percent_estimate: "",
    status_estimate: "down",
    active_estimate: false,
  }],
  predictedPlan: { entries: [{ slice_index: 0, link_id: "L-masked", predicted_active: false }] },
});
assert.equal(
  maskedObservationAudit.observed_value_mismatches,
  0,
  "topology-down mask takes precedence over direct value locking",
);
assert.equal(maskedObservationAudit.inactive_mask_violations, 0);

const outputDir = resolve("reports/tmp-experiment7-legality-smoke");
if (!outputDir.endsWith("tmp-experiment7-legality-smoke")) {
  throw new Error(`refusing to clean unexpected test directory: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
const rootReportPath = resolve(outputDir, "EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md");
const result = await runExperiment7({
  profiles: [{ id: "fixture", short_label: "Fixture", scale: "test", node_count: 1 }],
  outputDir,
  rootReportPath,
  fixtureOnly: true,
});
assert.equal(result.checkRows.length, 8);
assert.ok(result.checkRows.every((row) => row.status === "PASS"));
assert.ok(result.planHashRows.length >= 2);

const expectedFiles = [
  rootReportPath,
  resolve(outputDir, "experiment7-checks.csv"),
  resolve(outputDir, "experiment7-plan-hashes.csv"),
  resolve(outputDir, "experiment7-summary.json"),
  resolve(outputDir, "experiment7-report.html"),
  resolve(outputDir, "experiment7-manifest.json"),
];
assert.ok(expectedFiles.every(existsSync));
assert.equal(parseCsv(await readFile(expectedFiles[1], "utf8")).length, 8);
const markdown = await readFile(rootReportPath, "utf8");
assert.match(markdown, /实验做了什么/);
assert.match(markdown, /无真值数值泄漏/);
assert.match(markdown, /时间因果合法/);
assert.match(markdown, /真值仅用于事后评估/);
const html = await readFile(expectedFiles[4], "utf8");
assert.match(html, /<meta charset="UTF-8">/);
assert.ok(!html.includes("�"));

console.log(JSON.stringify({
  ok: true,
  checks: result.checkRows.length,
  plan_hash_rows: result.planHashRows.length,
}, null, 2));
