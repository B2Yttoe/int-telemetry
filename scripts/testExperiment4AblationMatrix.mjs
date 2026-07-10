import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildExperiment4Variants,
  runExperiment4,
} from "./runExperiment4Ablation.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

const variants = buildExperiment4Variants();
assert.equal(variants.length, 6);
assert.equal(new Set(variants.map((row) => row.id)).size, 6);
assert.deepEqual(variants.map((row) => row.id), [
  "full",
  "no-topology-adaptation",
  "no-oam-feedback",
  "no-adaptive-overhead",
  "no-orbit-priors",
  "no-state-coupling",
]);

const full = variants.find((row) => row.id === "full");
assert.ok(full);
assert.equal(full.useOamFeedback, true);

const expectedDiffs = {
  "no-topology-adaptation": ["adaptiveReuse", "incrementalTopologyRepair"],
  "no-oam-feedback": ["useOamFeedback", "oamQualityFeedback"],
  "no-adaptive-overhead": ["adaptiveProbeBudget", "multiObjectiveBudget", "oamTargetAwareMetadata"],
  "no-orbit-priors": ["forecastRiskScoring", "orbitGraphRegularization", "orbitPeriodicPrior"],
  "no-state-coupling": [
    "jointStateCoupling",
    "metricTensorCoupling",
    "nodeEnergyPhysicsPrior",
    "nodeStateCoupling",
    "stateTensorJointCompletion",
  ],
};

function flattenedFlags(variant) {
  return {
    useOamFeedback: variant.useOamFeedback,
    ...variant.mechanisms,
  };
}

for (const variant of variants.filter((row) => row.id !== "full")) {
  const fullFlags = flattenedFlags(full);
  const variantFlags = flattenedFlags(variant);
  assert.deepEqual(Object.keys(variantFlags).sort(), Object.keys(fullFlags).sort());
  const changed = Object.keys(fullFlags)
    .filter((key) => fullFlags[key] !== variantFlags[key])
    .sort();
  assert.deepEqual(changed, expectedDiffs[variant.id].slice().sort(), `${variant.id} changed unexpected flags`);
  assert.ok(changed.every((key) => variantFlags[key] === false), `${variant.id} must only disable mechanisms`);
}

const smokeOutputDir = resolve("reports/tmp-experiment4-ablation-smoke");
if (!smokeOutputDir.endsWith("tmp-experiment4-ablation-smoke")) {
  throw new Error(`refusing to clean unexpected smoke directory: ${smokeOutputDir}`);
}
if (existsSync(smokeOutputDir)) rmSync(smokeOutputDir, { recursive: true, force: true });
const smokeRootReport = resolve(smokeOutputDir, "EXPERIMENT_4_ABLATION_REPORT.md");
const smokeResult = await runExperiment4({
  profiles: [{
    id: "fixture-small",
    short_label: "Fixture 64",
    scale: "test",
    node_count: 64,
    truthDir: resolve("exports/tmp-highload-check"),
    candidatePathsPath: resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv"),
  }],
  variants: variants.filter((row) => ["full", "no-oam-feedback"].includes(row.id)),
  outputDir: smokeOutputDir,
  rootReportPath: smokeRootReport,
  parameters: {
    samplingRate: 0.15,
    targetActiveLinkSamplingRate: 0.15,
    rank: 2,
    windowSize: 6,
    warmupSlices: 2,
    iterations: 1,
    downlinkBudgetBytes: 1_000_000_000,
    maxPathsPerSlice: 2,
    observabilityMode: "oam-only",
    feedbackLagSlices: 1,
  },
  resume: true,
  formal: false,
});
assert.equal(smokeResult.summaryRows.length, 2);
assert.equal(smokeResult.bySliceRows.length, 48);
assert.equal(new Set(smokeResult.runManifests.map((row) => row.pass1_fingerprint)).size, 1);
assert.ok(smokeResult.summaryRows.every((row) => row.slice_count === 24));
assert.ok(smokeResult.summaryRows.every((row) => row.feedback_lag_slices === 1));
assert.ok(smokeResult.summaryRows.every((row) => row.causal_feedback_violations === 0));

const expectedFiles = [
  smokeRootReport,
  resolve(smokeOutputDir, "experiment4-ablation-summary.csv"),
  resolve(smokeOutputDir, "experiment4-ablation-by-slice.csv"),
  resolve(smokeOutputDir, "experiment4-ablation-summary.json"),
  resolve(smokeOutputDir, "experiment4-ablation-report.html"),
  resolve(smokeOutputDir, "experiment4-manifest.json"),
];
assert.ok(expectedFiles.every(existsSync));
const persistedRows = parseCsv(await readFile(expectedFiles[1], "utf8"));
assert.equal(persistedRows.length, 2);
const markdown = await readFile(smokeRootReport, "utf8");
assert.match(markdown, /实验做了什么/);
assert.match(markdown, /实验结果/);
assert.match(markdown, /证明了什么/);
assert.match(markdown, /不能证明什么/);
const html = await readFile(resolve(smokeOutputDir, "experiment4-ablation-report.html"), "utf8");
assert.match(html, /<meta charset="UTF-8">/);
assert.match(html, /实验 4：LEO-INT-MC 消融实验/);
assert.ok(!html.includes("�"));

console.log(JSON.stringify({
  ok: true,
  variant_count: variants.length,
  variants: variants.map((row) => ({
    id: row.id,
    disabled_flags: expectedDiffs[row.id] ?? [],
  })),
  smoke_summary_rows: smokeResult.summaryRows.length,
  smoke_by_slice_rows: smokeResult.bySliceRows.length,
  shared_pass1_fingerprint: smokeResult.runManifests[0].pass1_fingerprint,
}, null, 2));
