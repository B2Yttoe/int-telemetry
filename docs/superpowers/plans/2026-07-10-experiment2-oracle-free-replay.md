# Experiment 2 Oracle-Free Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove truth-error feedback and hidden node/link state from the formal Experiment 2 planner, then rerun the same 48-slice comparison as an explicitly labeled oracle-free replay.

**Architecture:** Introduce a planner-view sanitizer that exposes only predictable contact fields plus prior Ground OAM estimates. Replace truth-error completion feedback with deployable uncertainty feedback, and make the comparison runner feed only that file into the enhanced pass. Keep Stage 1 truth available only to simulation execution and final evaluation; strict online per-slice orchestration remains a follow-up.

**Tech Stack:** Node.js ES modules, CSV/JSON artifacts, existing INT-MC CLI tools and npm verification scripts.

## Global Constraints

- Do not modify Stage 1 Walker/TLE, traffic, energy, or link simulation logic.
- The formal enhanced pass must not use truth error values as probe feedback.
- Planner-visible CPU, queue, energy, utilization, congestion, drop, and PER values must come from prior Ground OAM estimates, not Stage 1 truth rows.
- Truth error rows remain evaluation-only artifacts and must never be converted into probe feedback.
- Preserve existing CLI behavior unless `--observability-mode oam-only` is supplied.

---

### Task 1: Planner-view field boundary

**Files:**
- Create: `stage2-int/tools/int-mc-observability.mjs`
- Create: `scripts/testIntMcOracleFreePlannerView.mjs`
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `buildObservablePlanningLinks()`, `buildObservablePlanningNodes()`, and `buildObservableRoutes()`.
- `int-mc-path-selector.mjs` consumes these helpers when `--observability-mode oam-only` is active.

- [ ] **Step 1: Write the failing test**

Create two truth fixtures with identical predictable fields and OAM estimates but different hidden CPU/utilization values. Assert that all sanitized planner rows and selected oracle-free paths are identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/testIntMcOracleFreePlannerView.mjs`

Expected: FAIL because `int-mc-observability.mjs` and the observability CLI do not exist.

- [ ] **Step 3: Implement the field allowlist**

Expose contact geometry and static fields from the predicted contact plan, overlay dynamic values only from `ground-reconstructed-links.csv` and `ground-reconstructed-nodes.csv`, sanitize route rows, and export observability provenance fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/testIntMcOracleFreePlannerView.mjs`

Expected: PASS with identical planner output under hidden-truth perturbation.

### Task 2: Deployable completion feedback

**Files:**
- Create: `scripts/testIntMcDeployableFeedbackBoundary.mjs`
- Modify: `stage2-int/tools/int-mc-reconstructor.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `int-mc-deployable-priority-retest.csv` from confidence, disagreement, context risk, and state age only.
- Keeps `int-mc-priority-retest.csv` as a compatibility alias of the deployable artifact.

- [ ] **Step 1: Write the failing test**

Run the reconstructor twice with the same observations and different hidden truth metric values. Assert deployable feedback is unchanged and contains no `high-simulation-validation-error`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/testIntMcDeployableFeedbackBoundary.mjs`

Expected: FAIL because deployable and oracle feedback are not separated.

- [ ] **Step 3: Split feedback generation**

Generate inferred-target priorities from OAM confidence and reconstructive uncertainty without reading error rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/testIntMcDeployableFeedbackBoundary.mjs`

Expected: PASS.

### Task 3: Oracle-free Experiment 2 runner

**Files:**
- Modify: `scripts/runExperiment2IntMcEnhancementComparison.mjs`
- Create: `scripts/testExperiment2OracleFreeBoundary.mjs`
- Modify: `package.json`

**Interfaces:**
- Baseline pass uses predictable contact data without hidden metrics.
- Enhanced pass additionally consumes pass-1 Ground OAM estimates and deployable feedback.
- Comparison JSON records `observability_mode`, feedback source counts, and truth-error feedback exclusion.

- [ ] **Step 1: Write the failing integration test**

Run an Iridium-only comparison and assert the enhanced manifest uses `oam-only`, merges no validation-error rows, and records the deployable feedback path.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/testExperiment2OracleFreeBoundary.mjs`

Expected: FAIL because the runner still merges `int-mc-priority-retest.csv` containing validation errors.

- [ ] **Step 3: Wire sanitized planner inputs and deployable feedback**

Pass the previous Ground OAM node/link estimates to the enhanced selector, set `--observability-mode oam-only`, disable truth-powered node energy propagation in the formal oracle-free pass, and export boundary metadata.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/testExperiment2OracleFreeBoundary.mjs`

Expected: PASS.

### Task 4: Rerun and evaluate

**Files:**
- Generate: `reports/experiment2-int-mc-oracle-free-replay/`
- Generate: `reports/experiment2-baseline-comparison-oracle-free-replay/`

**Interfaces:**
- Produces a three-scale 48-slice oracle-free replay and comprehensive HTML/CSV/JSON reports.

- [ ] **Step 1: Run focused tests**

Run the three new oracle-free tests plus existing adaptive, OAM, multi-objective, and report tests.

- [ ] **Step 2: Run the Iridium smoke experiment**

Run Experiment 2 with `--profiles iridium-next-small` and inspect feedback provenance and metric regressions.

- [ ] **Step 3: Run the three-scale formal replay**

Run all three profiles into `reports/experiment2-int-mc-oracle-free-replay`.

- [ ] **Step 4: Generate comprehensive reports and verify**

Generate the baseline and Pareto reports, run `npm run build`, `npm run verify:goal`, and `git diff --check`.
