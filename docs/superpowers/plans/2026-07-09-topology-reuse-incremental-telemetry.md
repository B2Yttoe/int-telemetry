# Topology Reuse Incremental Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen enhanced LEO INT-MC topology reuse so similar topology slices reuse cached probe plans, perform local delta/OAM retests, and reduce both planning cost and telemetry communication cost.

**Architecture:** Keep the current `int-mc-path-selector.mjs` pipeline, but change topology reuse from an all-or-nothing cache decision into a reuse-first path selection mode. OAM pressure should add mandatory local targets and compact low-risk reused paths instead of forcing full fresh replanning for the whole slice.

**Tech Stack:** Node.js ES modules, CSV/JSON experiment artifacts, existing INT-MC selector/reconstructor scripts, npm test scripts.

## Global Constraints

- Do not add a new experiment branch or rename experiment2 methods.
- Preserve current enhanced LEO-INT-MC output schema and append fields only when useful.
- First target: reduce `selected_paths` and telemetry bytes when topology reuse is confident.
- Minimum fallback target: produce positive topology cache hits and planning cost savings.
- Ground OAM may force coverage of specific low-confidence targets, but should not force whole-slice fresh replanning unless topology similarity is too low.

---

### Task 1: Update Regression Expectations For Local OAM Reuse

**Files:**
- Modify: `scripts/testIntMcAdaptiveBehavior.mjs`

**Interfaces:**
- Consumes: existing selector CLI and fixture helpers.
- Produces: failing expectations that OAM pressure preserves topology reuse when the topology is still similar.

- [ ] Change the OAM scenario assertions so slice 1 expects `candidate_source=topology-reuse-cache`, `oam_control_replan_triggered=false`, selected OAM target coverage, and positive `planning_cost_saving_ratio`.
- [ ] Run `npm run test:int-mc-adaptive`.
- [ ] Expected before implementation: FAIL because current selector still forces fresh replan on high OAM pressure.

### Task 2: Make OAM Break Reuse Locally Instead Of Globally

**Files:**
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`

**Interfaces:**
- Consumes: `oamMandatoryTargetsForSlice`, `oamControlForSlice`, `repairCandidatePath`.
- Produces: reuse cache slices that keep cached candidates and inject/retain paths covering OAM targets.

- [ ] Relax `oamReplanTriggered` so OAM pressure alone does not nullify `contactClass` when topology similarity is acceptable.
- [ ] Add a strict fresh-replan escape only when topology similarity is below threshold or repair cannot produce usable candidates.
- [ ] Ensure mandatory OAM target coverage can select repaired/new candidate paths inside a reused slice.
- [ ] Run `npm run test:int-mc-adaptive` and verify the OAM reuse assertions pass.

### Task 3: Convert Reuse Confidence Into Communication Savings

**Files:**
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`

**Interfaces:**
- Consumes: `candidateSource`, topology reuse confidence, adaptive budget scale, duplicate suppression.
- Produces: lower selected paths and telemetry bytes on reused stable slices.

- [ ] In reused slices, lower the effective max path cap when reuse confidence is high and local/OAM risk is low.
- [ ] Keep mandatory OAM/local-risk paths even when lowering caps.
- [ ] Count skipped stable duplicate paths in `reuse_duplicate_suppressed_paths`.
- [ ] Run `npm run test:int-mc-adaptive` and `npm run test:int-mc-adaptive-metadata`.

### Task 4: Verify Experiment2 Impact

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: experiment2 scripts and reports.
- Produces: refreshed report artifacts showing reuse hits and cost savings.

- [ ] Run `npm run experiment:int-mc-enhancement -- --old-root reports/experiment2-native-baseline-rerun-final --out reports/experiment2-int-mc-enhanced-comparison-current --int-mc-sampling-rate 0.25 --int-mc-target-active-link-sampling-rate 0.25 --int-mc-iterations 12 --int-mc-window-size 12 --int-mc-warmup-slices 6 --int-mc-max-paths-per-slice 12`.
- [ ] Run `node scripts/writeExperiment2BaselineComparison.mjs --old-root reports/experiment2-native-baseline-rerun-final --original-int-mc-root reports/_archive/experiment2-legacy-baselines/experiment2-constellation-comparison --enhanced-root reports/experiment2-int-mc-enhanced-comparison-current --out reports/experiment2-baseline-comparison-current`.
- [ ] Check reuse hit slices, planning cost saving ratio, selected paths, telemetry bytes, and MAE deltas.
- [ ] Run `npm run build`.
