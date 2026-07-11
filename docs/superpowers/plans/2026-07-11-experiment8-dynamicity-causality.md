# Experiment 8 Dynamicity Causality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fixed-budget causal experiment that raises additional inter-plane stress from 5% to 25%, measures resulting Jaccard topology dynamicity, and compares native INT-MC with enhanced LEO-INT-MC on reconstruction error, invalid paths, replanning cost, and telemetry overhead.

**Architecture:** Add an experiment-only deterministic trace transformer that produces audited Stage-1 stress inputs while preserving intra-plane links and degree limits. Run both methods through the existing shared INT-MC experiment core, enforce matching input and budget fingerprints, then generate CSV/JSON/HTML/Markdown evidence.

**Tech Stack:** Node.js ESM, existing CSV helpers, existing INT-MC experiment core, SHA-256, HTML/SVG reports.

## Global Constraints

- Do not modify Stage-1 Walker/TLE, link-budget, energy, routing, or workload equations.
- Formal additional-stress targets are exactly `0.05,0.10,0.15,0.20,0.25` with tolerance `0.01`; absolute Jaccard dynamicity is an outcome.
- Formal runs use all three constellation profiles, 48 slices, and fixed direct-observation budgets.
- Intra-plane links are immutable and no node may exceed four active ISLs.
- Current-slice hidden truth is evaluation-only and never enters planner feedback.
- Negative and non-significant results remain in every report.

---

### Task 1: Dynamicity Metric And Deterministic Transformer

**Files:**
- Create: `scripts/experiments/dynamicityStress.mjs`
- Create: `scripts/testExperiment8DynamicityStress.mjs`

**Interfaces:**
- Produces: `topologyDynamicity(previousRows, currentRows): {jaccard_similarity:number,dynamicity:number}`
- Produces: `transformDynamicityTrace({links, targetStressRate, seed, tolerance}): {links,mutations,bySlice,summary}`
- Consumes: parsed `links.csv` rows from `reportUtils.mjs`.

- [ ] **Step 1: Write failing metric and invariants tests**

```js
import assert from "node:assert/strict";
import { topologyDynamicity, transformDynamicityTrace } from "./experiments/dynamicityStress.mjs";

const previous = [{ link_id: "a", is_active: "true" }, { link_id: "b", is_active: "true" }];
const current = [{ link_id: "b", is_active: "true" }, { link_id: "c", is_active: "true" }];
assert.deepEqual(topologyDynamicity(previous, current), {
  jaccard_similarity: 1 / 3,
  dynamicity: 2 / 3,
});

const links = buildFixtureWithStableIntraPlaneAndMutableInterPlaneLinks();
const first = transformDynamicityTrace({ links, targetStressRate: 0.25, seed: "exp8", tolerance: 0.01 });
const second = transformDynamicityTrace({ links, targetStressRate: 0.25, seed: "exp8", tolerance: 0.01 });
assert.deepEqual(first, second);
assert.ok(Math.abs(first.summary.achieved_stress_rate - 0.25) <= 0.01);
assert.equal(first.links.filter((row) => row.kind === "intra-plane").map(JSON.stringify).join("\n"), links.filter((row) => row.kind === "intra-plane").map(JSON.stringify).join("\n"));
assert.ok(maximumActiveDegree(first.links) <= 4);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment8DynamicityStress.mjs`

Expected: failure because `scripts/experiments/dynamicityStress.mjs` does not exist.

- [ ] **Step 3: Implement the transformer**

Implement active-set Jaccard calculation, stable SHA-256 ordering, inter-plane-only mutations, per-slice degree checking, mutation audit rows, and target calibration. A down mutation sets `status=down`, `is_active=false`, `restriction_reason=experiment8-controlled-dynamicity`, zero carried traffic/effective capacity, and records original values. Reject traces outside tolerance.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node scripts/testExperiment8DynamicityStress.mjs`

Expected: `Experiment 8 dynamicity stress tests passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/experiments/dynamicityStress.mjs scripts/testExperiment8DynamicityStress.mjs
git commit -m "feat: add controlled LEO dynamicity transformer"
```

### Task 2: Fixed-Budget Pairing And Path-Failure Accounting

**Files:**
- Create: `scripts/experiments/dynamicityExperimentMetrics.mjs`
- Create: `scripts/testExperiment8FairnessAndMetrics.mjs`
- Modify: `scripts/experiments/intMcExperimentCore.mjs`

**Interfaces:**
- Produces: `auditFixedBudgetPair(nativeRun, enhancedRun): {ok:boolean,violations:string[],fingerprint:string}`
- Produces: `calculatePathValidity({probeRows, linkRows}): Array<PathValidityRow>`
- Extends `collectIntMcMetrics` with planning/reuse/replan and path-validity fields without changing existing names.

- [ ] **Step 1: Write failing fairness and invalid-path tests**

```js
import assert from "node:assert/strict";
import { auditFixedBudgetPair, calculatePathValidity } from "./experiments/dynamicityExperimentMetrics.mjs";

const audit = auditFixedBudgetPair(
  fixtureRun({ samplingRate: 0.25, maxPaths: 12, truthHash: "same" }),
  fixtureRun({ samplingRate: 0.25, maxPaths: 12, truthHash: "same" }),
);
assert.equal(audit.ok, true);
assert.equal(auditFixedBudgetPair(
  fixtureRun({ samplingRate: 0.20, maxPaths: 12, truthHash: "same" }),
  fixtureRun({ samplingRate: 0.25, maxPaths: 12, truthHash: "same" }),
).ok, false);

const rows = calculatePathValidity({
  probeRows: [{ slice_index: "0", probe_id: "p", path: "A>B>C" }],
  linkRows: [{ slice_index: "0", source: "A", target: "B", is_active: "true" }, { slice_index: "0", source: "B", target: "C", is_active: "false" }],
});
assert.equal(rows[0].invalid, true);
assert.equal(rows[0].failed_hop, "B>C");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment8FairnessAndMetrics.mjs`

Expected: failure because the metrics module is missing.

- [ ] **Step 3: Implement fairness and path-validity metrics**

Compare truth hash, candidate-path hash, sampling rate, active-link sampling rate, path cap, telemetry fields, downlink budget, rank, window, iterations, observability mode, and feedback lag. Parse each path into directed hops and validate it against the active set for the same slice. Add selector planning/reuse/replan fields to the shared collector by reading existing selector and contact-plan reports.

- [ ] **Step 4: Run related tests**

Run: `node scripts/testExperiment8FairnessAndMetrics.mjs`

Expected: PASS.

Run: `npm run test:int-mc-experiment-core`

Expected: PASS with existing fields unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/experiments/dynamicityExperimentMetrics.mjs scripts/testExperiment8FairnessAndMetrics.mjs scripts/experiments/intMcExperimentCore.mjs
git commit -m "feat: audit fixed-budget dynamicity comparisons"
```

### Task 3: Experiment 8 Runner And Artifacts

**Files:**
- Create: `scripts/runExperiment8DynamicityCausality.mjs`
- Create: `scripts/testExperiment8MatrixAndArtifacts.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildExperiment8Matrix({profiles, targets, methods})`
- Produces: `runExperiment8(options)` and the six artifacts specified by the design.
- Consumes: `PROFILE_CATALOG`, `FORMAL_DEFAULTS`, `runTwoPassVariant`, transformer, fairness auditor, report utilities.

- [ ] **Step 1: Write failing matrix and smoke-artifact tests**

```js
import assert from "node:assert/strict";
import { buildExperiment8Matrix, runExperiment8 } from "./runExperiment8DynamicityCausality.mjs";

assert.equal(buildExperiment8Matrix({
  profiles: ["a", "b", "c"],
  targets: [0.05, 0.10, 0.15, 0.20, 0.25],
  methods: ["native", "enhanced"],
}).length, 30);

const result = await runExperiment8(smokeFixtureOptions());
assert.equal(result.summaryRows.length, 2);
assert.ok(result.bySliceRows.length > 0);
assert.ok(result.pathValidityRows.length > 0);
assert.equal(result.fairnessAudits.every((row) => row.ok), true);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment8MatrixAndArtifacts.mjs`

Expected: failure because the runner is missing.

- [ ] **Step 3: Implement runner and CLI**

Use baseline Stage-1 truth and candidate paths from `reports/experiment2-native-baseline-rerun-final`. Create one transformed truth directory per profile/target/seed, preserving metadata and nodes while replacing audited links. Run native and enhanced variants with identical fixed parameters. Export summary, per-slice, mutation, JSON, manifest, HTML, and root Markdown files. Calculate error-dynamicity slopes from achieved values.

- [ ] **Step 4: Register scripts and run smoke test**

Add:

```json
"experiment8:dynamicity": "node scripts/runExperiment8DynamicityCausality.mjs",
"test:experiment8:stress": "node scripts/testExperiment8DynamicityStress.mjs",
"test:experiment8:fairness": "node scripts/testExperiment8FairnessAndMetrics.mjs",
"test:experiment8": "node scripts/testExperiment8MatrixAndArtifacts.mjs"
```

Run all three tests and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/runExperiment8DynamicityCausality.mjs scripts/testExperiment8MatrixAndArtifacts.mjs package.json
git commit -m "feat: add LEO topology dynamicity causality experiment"
```

### Task 4: Formal Run And Verification

**Files:**
- Generate: `reports/experiment8-dynamicity-causality/*`
- Generate: `EXPERIMENT_8_DYNAMICITY_CAUSALITY_REPORT.md`

**Interfaces:**
- Produces final formal evidence only; no new API.

- [ ] **Step 1: Run a one-profile, two-level acceptance rehearsal**

Run: `npm run experiment8:dynamicity -- --profiles iridium-next-small --targets 0.05,0.25 --resume false --out reports/experiment8-dynamicity-smoke`

Expected: four method-level rows, achieved targets within tolerance, fairness audits PASS.

- [ ] **Step 2: Run the formal matrix**

Run: `npm run experiment8:dynamicity`

Expected: 30 summary rows, 1,440 method-slice rows, non-empty mutation/path-validity rows, and six formal artifacts.

- [ ] **Step 3: Verify regressions**

Run: `npm run build`

Run: `npm run verify:goal`

Run all Experiment 7 no-truth tests.

Expected: all PASS.

- [ ] **Step 4: Commit formal reports**

```bash
git add EXPERIMENT_8_DYNAMICITY_CAUSALITY_REPORT.md
git commit -m "docs: report LEO dynamicity causality experiment"
```
