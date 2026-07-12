# Dynamic Equal-Budget Ablation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run Experiment 11, a three-scale, two-dynamicity, ten-seed, strict actual-byte-budget ablation of five LEO-INT-MC mechanism groups.

**Architecture:** Add a thin Experiment 11 orchestration layer over the existing `runExperiment8` pipeline. All six variants share each seed's Stage-1 dynamic truth, while existing hard-byte admission and non-informative padding enforce equal actual network load. Reuse Experiment 10 aggregation and paired-effect statistics, adding only the dynamicity-interaction calculation and Experiment 11 reporting.

**Tech Stack:** Node.js ES modules, existing Experiment 8/10 runners, CSV/JSON artifacts, inline SVG HTML reports, `node:assert`, PowerShell npm scripts.

## Global Constraints

- Do not modify Stage-1 orbit, topology, routing, traffic, link-budget, energy, or node-state logic.
- Formal matrix is exactly 3 profiles × 2 stress levels × 10 seeds × 6 variants = 360 rows.
- Stress levels are exactly `0` and `0.25`; all runs contain 48 slices.
- Every variant uses the frozen Experiment 10 per-profile byte cap and `telemetryByteBudgetPadToCap: true`.
- A formal fairness group passes only with all six variants present, zero cap violations, identical hard caps, and actual-byte spread no greater than `1e-4 B/node/slice`.
- All new behavior follows test-first RED-GREEN-REFACTOR.
- Formal reports preserve negative and statistically uncertain results.

---

### Task 1: Mechanism Variant Definitions

**Files:**
- Create: `scripts/experiments/dynamicAblationVariants.mjs`
- Test: `scripts/testExperiment11VariantDefinitions.mjs`

**Interfaces:**
- Produces: `EXPERIMENT11_FULL_METHOD_ID`, `EXPERIMENT11_VARIANT_IDS`, `buildExperiment11Variants()`.
- Consumed by: Experiment 11 orchestrator and artifact validator.

- [ ] **Step 1: Write the failing variant-definition test**

```js
import assert from "node:assert/strict";
import {
  EXPERIMENT11_FULL_METHOD_ID,
  EXPERIMENT11_VARIANT_IDS,
  buildExperiment11Variants,
} from "./experiments/dynamicAblationVariants.mjs";

const variants = buildExperiment11Variants();
assert.equal(EXPERIMENT11_FULL_METHOD_ID, "full-enhanced");
assert.equal(variants.length, 6);
assert.deepEqual(variants.map((row) => row.id), EXPERIMENT11_VARIANT_IDS);
assert.equal(new Set(variants.map((row) => row.id)).size, 6);
const full = variants[0].mechanisms;
assert.equal(full.adaptiveReuse, true);
assert.equal(full.businessHotspotMigrationPrior, true);
assert.equal(variants.find((row) => row.id === "without-topology-adaptation").mechanisms.adaptiveReuse, false);
assert.equal(variants.find((row) => row.id === "without-topology-adaptation").mechanisms.incrementalTopologyRepair, false);
assert.equal(variants.find((row) => row.id === "without-energy-physics-prior").mechanisms.nodeEnergyPhysicsPrior, false);
assert.ok(variants.slice(1).every((variant) => Object.keys(variant.mechanisms).some((key) => variant.mechanisms[key] !== full[key])));
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment11VariantDefinitions.mjs`

Expected: module-not-found failure for `dynamicAblationVariants.mjs`.

- [ ] **Step 3: Implement immutable variant definitions**

Create a full mechanism object matching the current `ENHANCED_MECHANISMS` in `runExperiment8DynamicityCausality.mjs`. Implement a helper that clones the full object and disables only the requested flags. Export exactly six variants with the IDs in the design specification.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node scripts/testExperiment11VariantDefinitions.mjs`

Expected: `Experiment 11 variant definition tests passed.`

- [ ] **Step 5: Commit the task**

```powershell
git add scripts/experiments/dynamicAblationVariants.mjs scripts/testExperiment11VariantDefinitions.mjs
git commit -m "test: define dynamic ablation variants"
```

### Task 2: Dynamicity Interaction Statistics

**Files:**
- Create: `scripts/experiments/dynamicAblationStatistics.mjs`
- Test: `scripts/testDynamicAblationStatistics.mjs`

**Interfaces:**
- Consumes: method-level rows containing profile, stress, seed, method, and metric values.
- Produces: `buildContributionSamples()`, `aggregateContributionSamples()`, `buildDynamicityInteractions()`.

- [ ] **Step 1: Write failing tests for metric direction and interaction**

Use two seeds, a full method, and one ablation at stress 0 and 0.25. Assert that for lower-is-better CPU MAE, `contribution = ablated - full`; for higher-is-better accuracy, `contribution = full - ablated`; and interaction equals high-stress contribution minus low-stress contribution.

```js
const rows = [
  { profile_id: "p", stress_rate: 0, seed: "s0", method_id: "full-enhanced", cpu_mae: 1, link_status_accuracy: 0.9 },
  { profile_id: "p", stress_rate: 0, seed: "s0", method_id: "without-x", cpu_mae: 2, link_status_accuracy: 0.8 },
  { profile_id: "p", stress_rate: 0.25, seed: "s0", method_id: "full-enhanced", cpu_mae: 1, link_status_accuracy: 0.9 },
  { profile_id: "p", stress_rate: 0.25, seed: "s0", method_id: "without-x", cpu_mae: 4, link_status_accuracy: 0.6 },
];
const samples = buildContributionSamples(rows, {
  fullMethodId: "full-enhanced",
  ablationMethodIds: ["without-x"],
  metricDirections: { cpu_mae: "lower", link_status_accuracy: "higher" },
});
assert.equal(samples.find((row) => row.metric === "cpu_mae" && row.stress_rate === 0).contribution, 1);
assert.equal(samples.find((row) => row.metric === "link_status_accuracy" && row.stress_rate === 0.25).contribution, 0.3);
assert.equal(buildDynamicityInteractions(samples, { lowStress: 0, highStress: 0.25 }).find((row) => row.metric === "cpu_mae").interaction_mean, 2);
```

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/testDynamicAblationStatistics.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement paired samples and Student-t summaries**

Implement local numeric helpers matching Experiment 10's sample standard deviation and Student-t 95% CI. Throw if a required full/ablation pair or low/high stress pair is missing; do not silently drop incomplete samples.

- [ ] **Step 4: Run and verify GREEN**

Run: `node scripts/testDynamicAblationStatistics.mjs`

Expected: `Dynamic ablation statistics tests passed.`

- [ ] **Step 5: Commit the task**

```powershell
git add scripts/experiments/dynamicAblationStatistics.mjs scripts/testDynamicAblationStatistics.mjs
git commit -m "feat: add dynamic ablation statistics"
```

### Task 3: Experiment 11 Orchestrator

**Files:**
- Create: `scripts/runExperiment11DynamicEqualBudgetAblation.mjs`
- Create: `scripts/testExperiment11Matrix.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PROFILE_CATALOG`, Experiment 10 budgets, Experiment 8 runner, Experiment 11 variants and statistics.
- Produces: `runExperiment11()`, `buildExperiment11Matrix()`, `normalizeExperiment11Row()`, configuration and implementation fingerprints.

- [ ] **Step 1: Write a failing matrix and normalization test**

Assert that 3 profiles × 2 stresses × 10 seeds × 6 variants creates 360 unique keys. Assert that normalization preserves budget, padding, node/link metrics, planning time, and mechanism ID.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/testExperiment11Matrix.mjs`

Expected: missing Experiment 11 module export.

- [ ] **Step 3: Implement the orchestrator**

For each profile and seed, call `runExperiment8` once with both stresses and all six variants:

```js
const run = await runExperiment8({
  profiles: [profile],
  stressRates: [0, 0.25],
  methods: buildExperiment11Variants(),
  oldRoot,
  outputDir: dynamicityDir,
  rootReportPath: join(seedRoot, "dynamicity-report.md"),
  seed: `experiment11:${seed}`,
  resume,
  formal,
  parameters: {
    telemetryByteBudgetPerNodeSlice: hardBudget,
    telemetryByteBudgetPadToCap: true,
    writeEstimateGraph: false,
  },
});
```

Normalize `run.summaryRows`, write `seed-result.json`, then prune `dynamicity/runs` and `dynamicity/inputs` only after the seed result is complete. Include source hashes, implementation fingerprint, schema version, profile, seed, budgets, stresses, and variant IDs in the cache fingerprint.

- [ ] **Step 4: Enforce matrix and fairness gates**

Use `validateEqualBudgetMatrix()` with all six variants. Use `auditEqualBudgetFairness()` with all six variants as both required and primary-matched methods and a ratio stricter than `1e-7`; additionally assert absolute spread `<= 1e-4`.

- [ ] **Step 5: Add npm commands**

```json
"experiment11:dynamic-ablation": "node --expose-gc scripts/runExperiment11DynamicEqualBudgetAblation.mjs",
"experiment11:smoke": "node --expose-gc scripts/runExperiment11DynamicEqualBudgetAblation.mjs --profiles iridium-next-small --targets 0,0.25 --seeds 1 --formal false --out reports/_scratch/experiment11-dynamic-ablation-smoke",
"test:experiment11": "node scripts/testExperiment11VariantDefinitions.mjs && node scripts/testDynamicAblationStatistics.mjs && node scripts/testExperiment11Matrix.mjs"
```

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npm run test:experiment11`

Expected: all three test scripts pass.

- [ ] **Step 7: Commit the task**

```powershell
git add package.json scripts/runExperiment11DynamicEqualBudgetAblation.mjs scripts/testExperiment11Matrix.mjs
git commit -m "feat: orchestrate dynamic equal-budget ablation"
```

### Task 4: Report and Artifact Validation

**Files:**
- Modify: `scripts/runExperiment11DynamicEqualBudgetAblation.mjs`
- Create: `scripts/testExperiment11Artifacts.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces all CSV/JSON/HTML/Markdown paths listed in the design.
- Validates formal and smoke row counts independently.

- [ ] **Step 1: Write the failing artifact test**

The test reads manifest, summary, raw, aggregate, contribution, interaction, fairness, and HTML files. For formal mode assert 360 raw rows, 36 aggregate rows, 60 fairness rows, 300 contribution rows for 5 ablations × 3 profiles × 2 stresses × 10 metrics, and 150 interaction rows for 5 ablations × 3 profiles × 10 metrics. Assert 60/60 fairness rows pass, zero cap violations, and HTML contains `主要结论`, `动态性交互效应`, `负结果与边界`, no `\uFFFD`, and no mojibake marker.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/testExperiment11Artifacts.mjs --input reports/_scratch/experiment11-dynamic-ablation-smoke`

Expected: missing artifact failure.

- [ ] **Step 3: Implement CSV/JSON writers and HTML**

Create inline SVG CI charts for CPU, energy, utilization, and planning time; a contribution heatmap; and an interaction table. State that positive contribution means removal harms the result and positive interaction means the mechanism is more valuable at 25% churn.

- [ ] **Step 4: Add artifact test commands**

```json
"test:experiment11:smoke-artifacts": "node scripts/testExperiment11Artifacts.mjs --input reports/_scratch/experiment11-dynamic-ablation-smoke",
"test:experiment11:artifacts": "node scripts/testExperiment11Artifacts.mjs --input reports/experiment11-dynamic-equal-budget-ablation"
```

- [ ] **Step 5: Run report unit tests**

Run: `npm run test:experiment11`

Expected: PASS.

- [ ] **Step 6: Commit the task**

```powershell
git add package.json scripts/runExperiment11DynamicEqualBudgetAblation.mjs scripts/testExperiment11Artifacts.mjs
git commit -m "feat: report dynamic ablation results"
```

### Task 5: Smoke Experiment

**Files:**
- Generated: `reports/_scratch/experiment11-dynamic-ablation-smoke/**`

- [ ] **Step 1: Run one-seed Iridium smoke**

Run: `npm run experiment11:smoke`

Expected: 12 raw rows, 12 aggregate rows, 2 fairness rows, zero cap violations.

- [ ] **Step 2: Validate artifacts**

Run: `npm run test:experiment11:smoke-artifacts`

Expected: PASS.

- [ ] **Step 3: Inspect actual-byte equality and mechanism propagation**

Check that all six variants have identical actual B/node/slice within `1e-4`, padding remains non-negative, and each run manifest records the expected disabled flags.

- [ ] **Step 4: Fix any discovered defect through a new failing test**

Do not patch smoke failures directly. Add a minimal reproducer to the relevant test, verify RED, implement the fix, and rerun smoke.

### Task 6: Formal 360-Scenario Experiment

**Files:**
- Generated: `reports/experiment11-dynamic-equal-budget-ablation/**`
- Generated: `EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md`

- [ ] **Step 1: Run formal experiment**

Run: `npm run experiment11:dynamic-ablation`

Expected: checkpointed execution producing 30 complete seed results and final 360-row report.

- [ ] **Step 2: Validate formal artifacts**

Run: `npm run test:experiment11:artifacts`

Expected: PASS with 360 raw, 36 aggregate, and 60 fairness rows.

- [ ] **Step 3: Run implementation tests and build**

```powershell
npm run test:experiment11
npm run build
git diff --check
```

Expected: all tests pass; Vite may retain only the known large-chunk warning.

- [ ] **Step 4: Preserve negative results**

Verify the report classifies each contribution and interaction CI as positive, negative, or uncertain without filtering any category.

### Task 7: Evidence-Chain Documentation and Archive

**Files:**
- Modify: `7.11工作日志.md`
- Modify: `INFOCOM_READINESS_AUDIT.md`
- Modify and extend the current formal experiment index to `EXPERIMENTS_2_TO_11_INDEX.md`
- Modify: `README.md`
- Create: `reports/_archive/experiment11-development-20260712/README.md`

- [ ] **Step 1: Add Experiment 11 methodology and conclusions to the work log**

Document why 0%/25% were selected, how equal actual bytes were enforced, how contributions and interactions are computed, runtime behavior, and final positive/negative findings.

- [ ] **Step 2: Update the INFOCOM audit**

Mark dynamic equal-budget ablation as closed only if the formal artifact gate passes. Re-rank remaining gaps, with Experiment 3 statistical strengthening and independent packet-level validation as the next priorities.

- [ ] **Step 3: Update root result index and README links**

Rename the index to Experiment 2-11 and add the formal Experiment 11 directory and report.

- [ ] **Step 4: Archive smoke/pilot outputs**

Move Experiment 11 development-only outputs under `reports/_archive/experiment11-development-20260712`. Keep only the formal Experiment 11 directory at `reports/` top level.

- [ ] **Step 5: Final verification**

Check UTF-8 encoding, root links, no stale prior-index references, no running experiment process, formal manifest status, and all commands from Task 6.

- [ ] **Step 6: Commit documentation**

```powershell
git add 7.11工作日志.md INFOCOM_READINESS_AUDIT.md EXPERIMENTS_2_TO_11_INDEX.md README.md EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md reports/_archive/experiment11-development-20260712/README.md
git commit -m "docs: report dynamic equal-budget ablation"
```

## Self-Review

- Spec coverage: all design requirements map to Tasks 1-7.
- Matrix arithmetic is consistent: 360 raw, 36 aggregate, 60 fairness rows.
- Ten reported metrics imply 300 contribution aggregates and 150 interaction aggregates; per-seed contribution samples are stored separately if needed for traceability.
- No Stage-1 source file is modified.
- Smoke and formal outputs are separated.
- Cache and fairness gates fail closed on incomplete or stale results.
