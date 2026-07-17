# Equal-Budget Dynamic Multi-Seed Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a three-method, three-constellation, three-dynamicity, multi-seed experiment that compares end-to-end reconstruction under the same hard cap on actual generated telemetry bytes.

**Architecture:** Enforce byte budgets in the probe runtime after exact per-probe metadata and report sizes are known, not in the path scorer. Reuse Experiment 8 causal Stage-1 replay and reference-plan replay, then aggregate per-seed metrics with paired confidence intervals and effect sizes into Experiment 10 reports.

**Tech Stack:** Node.js ES modules, existing CSV/JSON experiment utilities, Stage-1 causal replay, INT probe/OAM pipeline, HTML/SVG reports.

## Global Constraints

- Preserve the Stage-1 simulator and truth-generation formulas.
- The planner and budget controller must not read post-hoc truth errors.
- All methods in one profile/seed/stress scenario receive the same per-slice hard byte cap.
- A formal run uses Iridium 66, Telesat 351, Starlink 1584; stress 0%, 10%, 25%; 48 slices; 10 evaluation seeds.
- Report negative results and achieved budget utilization without hiding under-utilization.
- Keep bulk artifacts optional so a formal run does not multiply the existing Experiment 8 disk footprint by ten.

---

### Task 1: Exact Runtime Telemetry Budget

**Files:**
- Create: `stage2-int/tools/telemetry-byte-budget.mjs`
- Modify: `stage2-int/tools/probe-int-runner.mjs`
- Create: `scripts/testTelemetryByteBudget.mjs`

**Interfaces:**
- `selectBudgetAdmittedProbeIds({ probes, hopRecords, reports, probePacketBaseBytes, perSliceBudgetBytes })`
- Returns admitted/rejected probe IDs, per-slice exact bytes, utilization and violations.

- [ ] Write tests for disabled budgets, exact-boundary admission, prefix rejection and independent per-slice caps.
- [ ] Run the tests and confirm failure because the module does not exist.
- [ ] Implement exact per-probe accounting and deterministic prefix admission.
- [ ] Integrate filtering before reporting interruption and all coverage/overhead calculations.
- [ ] Emit `probe-int-byte-budget-<algorithm>.csv` and budget fields in the run report.
- [ ] Run budget, invalid-path and reporting-interruption regression tests.

### Task 2: Pipeline Propagation and Lightweight Artifacts

**Files:**
- Modify: `scripts/experiments/intMcExperimentCore.mjs`
- Modify: `scripts/runExperiment8DynamicityCausality.mjs`
- Modify: `scripts/runExperiment8StaticNativeBaseline.mjs`
- Modify: `stage2-int/tools/ground-oam-reconstructor.mjs`
- Create: `scripts/testEqualBudgetPipelinePropagation.mjs`

**Interfaces:**
- `runIntMcPass` and `runIntMcPostSelection` accept `telemetryByteBudgetPerNodeSlice` and `writeEstimateGraph`.
- Experiment 8 summaries expose cap, actual bytes, utilization, rejected paths and cap violations.

- [ ] Write a failing propagation test using the existing high-load fixture.
- [ ] Pass the budget CLI through native, enhanced and reference-replay pipelines.
- [ ] Disable estimate-graph output for repeated experiment runs.
- [ ] Add budget parameters to resume fingerprints/manifests.
- [ ] Verify identical caps and zero violations in a one-profile smoke run.

### Task 3: Multi-Seed Statistics

**Files:**
- Create: `scripts/experiments/equalBudgetStatistics.mjs`
- Create: `scripts/testEqualBudgetStatistics.mjs`

**Interfaces:**
- `aggregateEqualBudgetRows(rows, { confidenceLevel: 0.95 })`
- `buildPairedMethodEffects(rows, { treatment: "enhanced", controls: [...] })`
- Produces mean, standard deviation, 95% CI, paired delta, relative delta and standardized effect size.

- [ ] Write tests against hand-calculated fixtures.
- [ ] Implement deterministic grouping and Student/normal CI calculation documented in output metadata.
- [ ] Add fairness audits for identical caps, zero violations and actual budget utilization.
- [ ] Verify missing seed/method pairs fail formal validation.

### Task 4: Experiment 10 Orchestrator and Report

**Files:**
- Create: `scripts/runExperiment10EqualBudgetDynamicity.mjs`
- Create: `scripts/testExperiment10EqualBudgetMatrix.mjs`
- Modify: `package.json`
- Create: `EXPERIMENT_10_EQUAL_BUDGET_REPORT.md`

**Interfaces:**
- CLI supports `--profiles`, `--targets`, `--seeds`, `--budget-map`, `--resume`, `--retain-bulk`, `--formal`, and `--out`.
- Formal outputs include raw per-seed CSV, aggregate CSV, paired-effects CSV, fairness CSV, JSON manifest and HTML report.

- [ ] Write a failing matrix test for 270 formal method rows.
- [ ] Freeze a common hard cap at the maximum achieved B/node/slice from the excluded 0% calibration run and record its source hashes.
- [ ] Run native full-replan, enhanced LEO-INT-MC and reference-plan replay with identical caps.
- [ ] Aggregate all reconstruction, accuracy, byte, energy and planning-time metrics.
- [ ] Generate Chinese HTML with confidence bands, error/byte trade-offs, path failures and negative-result tables.
- [ ] Add package scripts for smoke, formal run and artifact verification.

### Task 5: Acceptance and Formal Run

**Files:**
- Create: `scripts/testExperiment10Artifacts.mjs`
- Generate: `reports/experiment10-equal-budget-dynamic-multiseed/*`

**Interfaces:**
- Formal gate requires 270 method rows, 27 aggregate rows, 10 seeds per profile/stress/method, identical caps and zero cap violations.

- [ ] Run a two-seed Iridium 0%/25% smoke experiment and inspect budget utilization.
- [ ] Correct any cap-accounting or path-validity defect with a failing regression test.
- [ ] Run the 10-seed, three-profile, three-stress formal experiment.
- [ ] Run 30 seeds for the 0% and 25% endpoint path-failure confirmation if the 10-seed full metrics are stable.
- [ ] Run artifact tests, existing Experiment 8/9 tests and `npm run build`.
- [ ] Record all positive and negative conclusions in the root report and readiness audit.
