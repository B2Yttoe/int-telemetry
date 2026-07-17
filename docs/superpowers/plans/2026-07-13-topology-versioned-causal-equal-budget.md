# Topology-Versioned Strict-Causal Equal-Budget Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Experiment 12 to isolate the marginal contribution of topology class reuse, topology versioning, local repair, and forecast risk under equal telemetry budgets and strict causal OAM replay on medium and large LEO constellations.

**Architecture:** A pure experiment-definition module owns the cumulative mechanism ladder and causal audit. A separate runner reuses the existing two-pass INT-MC pipeline, freezes the completion stack and byte budgets, produces machine-readable summaries, and renders a Chinese Markdown/HTML report. Smoke mode truncates existing Experiment 8 stress truth without changing the production simulator.

**Tech Stack:** Node.js ESM, existing CSV/JSON experiment utilities, existing INT-MC two-pass pipeline, HTML/SVG report generation.

## Global Constraints

- Only `telesat-1015-medium` and `starlink-main-large` belong to the core experiment scope.
- Every variant uses the same candidate paths, truth snapshot, OAM pass-1 output, completion stack, and hard telemetry byte budget.
- All planner-visible OAM rows satisfy `source_slice_index < slice_index` with a minimum lag of one slice.
- Stage-1 truth is evaluation-only and must not enter planning or completion feedback.
- Smoke execution must remain short and must not launch the previous full multi-seed acceptance run.

---

### Task 1: Mechanism Ladder Contract

**Files:**
- Create: `scripts/experiments/topologyVersionedCausalExperiment.mjs`
- Create: `scripts/testExperiment12VariantDefinitions.mjs`

**Interfaces:**
- Produces: `buildExperiment12Variants({ mode })`, `validateVariantLadder(variants)`, `EXPERIMENT12_PROFILE_IDS`, and `EXPERIMENT12_PROFILE_BUDGETS`.

- [ ] **Step 1: Write the failing variant-definition test**

Assert that the cumulative ladder contains five ordered variants and that each adjacent pair changes exactly one of `adaptiveReuse`, `topologyVersionedObjective`, `incrementalTopologyRepair`, and `forecastRiskScoring`.

- [ ] **Step 2: Run the test to verify RED**

Run: `node scripts/testExperiment12VariantDefinitions.mjs`

Expected: module-not-found failure for `topologyVersionedCausalExperiment.mjs`.

- [ ] **Step 3: Implement the minimal immutable variant builder**

Keep all completion and physical-prior flags fixed and disabled in this experiment so the mechanism delta cannot be attributed to reconstruction changes.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node scripts/testExperiment12VariantDefinitions.mjs`

Expected: `Experiment 12 variant definition tests passed.`

### Task 2: Strict Causal Audit

**Files:**
- Modify: `scripts/experiments/topologyVersionedCausalExperiment.mjs`
- Create: `scripts/testExperiment12CausalAudit.mjs`

**Interfaces:**
- Produces: `auditStrictCausalReplay({ manifest, selectorReport, feedbackRows, plannerRows })` returning `{ passed, violations, checks }`.

- [ ] **Step 1: Write failing tests for lag, truth feedback, and future-row rejection**

Cover one valid replay, one `source_slice_index === slice_index` violation, and one `truth_error_feedback_enabled === true` violation.

- [ ] **Step 2: Run the test to verify RED**

Run: `node scripts/testExperiment12CausalAudit.mjs`

Expected: missing export failure.

- [ ] **Step 3: Implement the causal audit**

Treat blank source slices as non-feedback rows, require lag at least one, inspect selector-reported violations, and return named checks suitable for CSV/HTML reporting.

- [ ] **Step 4: Run both Experiment 12 tests**

Run: `node scripts/testExperiment12VariantDefinitions.mjs && node scripts/testExperiment12CausalAudit.mjs`

Expected: both pass.

### Task 3: Experiment Runner and Smoke Fixture

**Files:**
- Create: `scripts/runExperiment12TopologyVersionedCausal.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Experiment 8 stress truth, Experiment 2 path-balance candidates, `runTwoPassVariant`, and the Task 1/2 module.
- Produces: `runExperiment12(options)` plus CLI commands `experiment12:topology-causal` and `experiment12:smoke`.

- [ ] **Step 1: Add an artifact-contract test before the runner implementation**

Create `scripts/testExperiment12Artifacts.mjs` that expects summary, mechanism delta, causal audit, JSON, Markdown, and HTML files with both profile IDs and all five variants.

- [ ] **Step 2: Run the artifact test to verify RED**

Run: `node scripts/testExperiment12Artifacts.mjs --input reports/_scratch/experiment12-topology-causal-smoke`

Expected: missing results JSON failure.

- [ ] **Step 3: Implement fixture truncation and shared pass-1 execution**

Copy only rows whose `slice_index` is below the smoke limit, update `metadata.json`, and reuse one pass-1 Ground OAM run per profile across all five variants.

- [ ] **Step 4: Enforce equal budgets and frozen completion flags**

Pass `telemetryByteBudgetPerNodeSlice`, `telemetryByteBudgetPadToCap: true`, `feedbackLagSlices: 1`, and identical completion mechanisms to every variant.

- [ ] **Step 5: Generate summary, adjacent deltas, and causal audits**

Read the existing selector report and planner-visible OAM artifacts, call `auditStrictCausalReplay`, and fail the run if any causal or equal-budget check fails.

### Task 4: Chinese Result Report

**Files:**
- Modify: `scripts/runExperiment12TopologyVersionedCausal.mjs`

**Interfaces:**
- Produces: `EXPERIMENT_12_REPORT.md` and `index.html` with mechanism ladder, fairness table, causal audit, planning-cost chart, coverage/invalid-path chart, and reconstruction-error chart.

- [ ] **Step 1: Add report assertions to the artifact test**

Assert that the report contains the phrases `中大型动态 LEO`, `严格时间因果`, `相同遥测字节预算`, and `不追求全指标全面胜出`.

- [ ] **Step 2: Run the artifact test to verify RED**

Run: `node scripts/testExperiment12Artifacts.mjs --input reports/_scratch/experiment12-topology-causal-smoke`

Expected: report assertion failure until rendering is implemented.

- [ ] **Step 3: Implement Markdown and HTML rendering**

Use only measured rows for conclusions. Mark smoke outputs as preliminary and include explicit proven/not-proven boundaries.

### Task 5: Smoke Verification

**Files:**
- Generated: `reports/_scratch/experiment12-topology-causal-smoke/**`

- [ ] **Step 1: Run the two-profile smoke experiment**

Run: `npm run experiment12:smoke`

Expected: five variants for Telesat and Starlink complete with equal byte budgets and zero causal violations.

- [ ] **Step 2: Run the artifact contract**

Run: `node scripts/testExperiment12Artifacts.mjs --input reports/_scratch/experiment12-topology-causal-smoke`

Expected: pass.

- [ ] **Step 3: Run regression checks**

Run: `npm run test:int-mc-causal-observability`

Run: `npm run test:int-mc-topology-versioned-objective`

Run: `npm run build`

Expected: all commands pass.

- [ ] **Step 4: Inspect and report measured smoke deltas**

Summarize which mechanism reduced planning cost, invalid paths, or reconstruction error under equal bytes, and explicitly avoid promoting smoke observations to formal statistical conclusions.
