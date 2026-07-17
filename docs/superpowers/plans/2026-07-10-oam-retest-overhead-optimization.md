# OAM Retest Overhead Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Reduce enhanced LEO-INT-MC OAM retest telemetry bytes below the native INT-MC level for all three constellation sizes while keeping four MAEs within 1% of the current enhanced result and both accuracy metrics within 0.1 percentage point.

**Architecture:** Keep the existing two-pass Experiment 2 pipeline and its feedback inputs. Add marginal OAM target accounting to the path selector, emit a target-aware metadata profile for mandatory retest paths, and make the probe runner collect full records at mandatory targets while using lightweight forwarding records elsewhere. A strict acceptance verifier compares every new run with both the native baseline and the frozen current-enhanced reference.

**Tech Stack:** Node.js ES modules, CSV/JSON experiment artifacts, existing LEO-INT-MC selector/runner/reconstructor tools, assertion-based Node test scripts, Vite/TypeScript.

## Global Constraints

- Do not modify Stage 1 Walker/TLE-SGP4, traffic, routing, node-state, link-state, or energy truth generation.
- Preserve reports/experiment2-int-mc-energy-physics-final as the current-enhanced reference.
- Preserve reports/experiment2-native-baseline-rerun-final as the native baseline source.
- Use the same 48 slices, truth data, candidate paths, sampling rate, path cap, rank, iterations, and feedback input.
- Require new enhanced bytes/node/slice to be no greater than the before row for all three constellations.
- Require CPU, queue, energy, and link-utilization MAE to be no greater than 1.01 times the current enhanced value.
- Require node-mode and link-status accuracy to be no less than current enhanced accuracy minus 0.001.
- The shared checkout contains existing uncommitted work required by this implementation. Do not stage unrelated files or make broad commits containing pre-existing changes.
- Write every calibration run to a new directory and never overwrite a reference run.

---

### Task 1: Add A Failing Marginal OAM Target Test

**Files:**
- Modify: scripts/testIntMcAdaptiveBehavior.mjs

**Interfaces:**
- Consumes: the existing mandatory OAM selector fixture and probe-summary-int-mc.csv.
- Produces: assertions for unique mandatory-target coverage and duplicate-target suppression.

- [ ] Extend the mandatory OAM fixture with two candidates that hit the same target and one candidate that hits a second target.
- [ ] Add assertions that both unique targets are covered and that oam_duplicate_target_only_suppressed_paths is at least one.
- [ ] Run npm run test:int-mc-adaptive.
- [ ] Verify RED: the test fails because target-only duplicate suppression is not implemented.

The new assertion must use this behavior:

~~~js
const selectedTargetHits = mandatoryOamRows.flatMap((row) =>
  String(row.oam_feedback_mandatory_target_ids || "")
    .split(" > ")
    .filter(Boolean),
);
assert.ok(selectedTargetHits.includes(targetLink));
assert.ok(selectedTargetHits.includes(secondTargetLink));
assert.ok(
  numberValue(mandatoryOamSummary.oam_duplicate_target_only_suppressed_paths) >= 1,
);
~~~

### Task 2: Implement Marginal Mandatory-Target Selection

**Files:**
- Modify: stage2-int/tools/int-mc-path-selector.mjs
- Test: scripts/testIntMcAdaptiveBehavior.mjs

**Interfaces:**
- Consumes: OAM feedback/control mandatory_target_ids and greedy selection state.
- Produces: marginal_new_oam_target_count, marginal_new_oam_target_ids, oam_duplicate_target_only_suppressed_paths, and unique_mandatory_oam_targets_covered.

- [ ] Add mandatoryOamTargetIds(item) and uncoveredMandatoryOamTargetIds(item, coveredTargets).
- [ ] Maintain coveredMandatoryOamTargets beside the existing covered-link set.
- [ ] Give the large mandatory boost only to targets not already covered by selected paths.
- [ ] Allow byte-budget override only for a new mandatory target, current link coverage need, critical local risk, or near outage.
- [ ] Suppress a path that adds no new links, no new OAM targets, and no critical risk.
- [ ] Export per-path marginal target IDs and aggregate suppression/coverage counters.
- [ ] Run npm run test:int-mc-adaptive and verify GREEN.

Required helper shape:

~~~js
function mandatoryOamTargetIds(item) {
  return unique([
    ...splitPath(item?.oamFeedback?.mandatory_target_ids),
    ...splitPath(item?.oamControl?.mandatory_target_ids),
  ]);
}

function uncoveredMandatoryOamTargetIds(item, coveredTargets) {
  return mandatoryOamTargetIds(item)
    .filter((targetId) => !coveredTargets.has(targetId));
}
~~~

### Task 3: Add A Failing Target-Aware Runner Test

**Files:**
- Modify: scripts/testIntMcAdaptiveMetadataProfileBehavior.mjs

**Interfaces:**
- Consumes: probe path target IDs and target/transit byte fields.
- Produces: a target-neighborhood probe fixture with 96-byte target records and 88-byte transit records.

- [ ] Add an oam-target-aware-probe over three nodes with the middle node and first link marked mandatory.
- [ ] Assert target records use 96 B and transit records use 88 B.
- [ ] Assert local-adjacent-link records occur only at the mandatory node or for an explicitly mandatory link.
- [ ] Assert report size equals 128 plus the sum of actual per-record metadata bytes.
- [ ] Run npm run test:int-mc-adaptive-metadata.
- [ ] Verify RED: the current runner applies one byte size and one observation mode to the whole path.

The fixture fields are:

~~~js
adaptive_metadata_profile: "oam-target-aware",
adaptive_link_observation_mode: "target-neighborhood",
target_hop_metadata_bytes: 96,
transit_hop_metadata_bytes: 88,
oam_feedback_mandatory_node_target_ids: "P01-S02",
oam_feedback_mandatory_link_target_ids: "intra-plane:P01-S01->P01-S02",
~~~

### Task 4: Implement Target-Aware Probe Execution

**Files:**
- Modify: stage2-int/tools/probe-int-runner.mjs
- Test: scripts/testIntMcAdaptiveMetadataProfileBehavior.mjs

**Interfaces:**
- Consumes: mandatory node/link target IDs and target/transit byte values.
- Produces: variable-size hop records and target-neighborhood scans.

- [ ] Parse feedback and control node/link target IDs into four sets, then merge each type.
- [ ] Mark a forwarding record as a target when its node, ingress link, or egress link is mandatory.
- [ ] Use target_hop_metadata_bytes for target records and transit_hop_metadata_bytes for transit records.
- [ ] In target-neighborhood mode, scan adjacent links only at mandatory node targets and retain explicitly mandatory links.
- [ ] Preserve existing all-adjacent and path-only behavior unchanged.
- [ ] Export oam_target_record and oam_transit_record per hop.
- [ ] Add runner totals for target-aware paths, target/transit records, retained target-neighborhood records, suppressed scans, and bytes saved.
- [ ] Run npm run test:int-mc-adaptive-metadata and npm run test:int-mc-adaptive.
- [ ] Verify both commands pass.

### Task 5: Make The Selector Emit And Estimate Target-Aware Profiles

**Files:**
- Modify: stage2-int/tools/int-mc-path-selector.mjs
- Modify: scripts/testIntMcAdaptiveMetadataProfileBehavior.mjs
- Modify: scripts/runExperiment2IntMcEnhancementComparison.mjs

**Interfaces:**
- Consumes: mandatory node/link hits from OAM feedback and control.
- Produces: target-aware selected path rows whose estimated generated bytes match runner accounting.

- [ ] Export mandatory_link_target_ids and mandatory_node_target_ids separately from both OAM profiles.
- [ ] Add CLI flags --oam-target-aware-metadata, --oam-target-hop-bytes, and --oam-transit-hop-bytes.
- [ ] For an enhanced path hitting a mandatory target, emit profile oam-target-aware and mode target-neighborhood.
- [ ] Keep target records at 96 B and set transit records to the configured 88 B.
- [ ] Extend estimatePathTelemetryCost to accept a per-hop byte array and calculate prefix-growth forwarding bytes.
- [ ] Enable target-aware fields only in the enhanced pass; keep the before pass unchanged.
- [ ] Extend the metadata fixture to verify selector output and estimated byte reduction.
- [ ] Run npm run test:int-mc-adaptive-metadata and npm run test:int-mc-adaptive.

The profile must be:

~~~js
{
  profile: "oam-target-aware",
  observation_mode: "target-neighborhood",
  target_hop_metadata_bytes: 96,
  transit_hop_metadata_bytes: 88,
  policy: "oam-target-full-transit-light",
}
~~~

### Task 6: Add A Strict Experiment 2 Acceptance Verifier

**Files:**
- Create: scripts/verifyExperiment2OamOptimizationGoal.mjs
- Create: scripts/testExperiment2OamOptimizationGoal.mjs
- Modify: package.json

**Interfaces:**
- Consumes: a frozen reference comparison JSON and a candidate comparison JSON.
- Produces: nonzero exit status for any byte, MAE, or accuracy violation.

- [ ] Write temporary three-profile fixtures for one passing candidate and failures for bytes, MAE, and accuracy.
- [ ] Run node scripts/testExperiment2OamOptimizationGoal.mjs.
- [ ] Verify RED because the verifier does not exist.
- [ ] Implement matching by constellation_profile_id and version.
- [ ] Compare candidate after against candidate before for bytes.
- [ ] Compare candidate after against reference after for quality.
- [ ] Add npm scripts test:experiment2-oam-goal and verify:experiment2-oam-goal.
- [ ] Run npm run test:experiment2-oam-goal and verify GREEN.

Exact fields:

~~~js
const maeFields = [
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "link_utilization_mae",
];
const accuracyFields = ["node_mode_accuracy", "link_status_accuracy"];
~~~

### Task 7: Extend Experiment Artifacts And Reports

**Files:**
- Modify: scripts/runExperiment2IntMcEnhancementComparison.mjs
- Modify: scripts/testExperiment2EnhancedReportFields.mjs
- Modify: scripts/writeExperiment2BaselineComparison.mjs

**Interfaces:**
- Consumes: selector and runner target-aware metrics.
- Produces: CSV/JSON/HTML fields explaining OAM savings and quality gates.

- [ ] Add failing report assertions for duplicate suppression, target-aware paths, target/transit records, target-neighborhood records, suppressed scans, and target-aware bytes saved.
- [ ] Run npm run test:experiment2-report and verify RED.
- [ ] Collect the new selector/runner fields in comparison rows and generated CSV/JSON.
- [ ] Add two concise HTML mechanism groups: OAM target deduplication and target-aware collection.
- [ ] Add ordinary/OAM path and byte conclusions to the comprehensive report.
- [ ] Do not state all-scale success unless the strict verifier passes.
- [ ] Run npm run test:experiment2-report and verify GREEN.

### Task 8: Run And Calibrate Starlink For 48 Slices

**Files:**
- Generate: reports/experiment2-int-mc-oam-optimized-starlink-round1/
- Reference: reports/experiment2-int-mc-energy-physics-final/experiment2-int-mc-enhancement-comparison.json

**Interfaces:**
- Consumes: frozen Starlink truth and candidate paths.
- Produces: a Starlink candidate run and strict gate result.

- [ ] Run:

~~~powershell
npm run experiment:int-mc-enhancement -- --profiles starlink-main-large --old-root reports/experiment2-native-baseline-rerun-final --out reports/experiment2-int-mc-oam-optimized-starlink-round1 --int-mc-sampling-rate 0.25 --int-mc-target-active-link-sampling-rate 0.25 --int-mc-iterations 12 --int-mc-window-size 12 --int-mc-warmup-slices 6 --int-mc-max-paths-per-slice 12
~~~

- [ ] Verify:

~~~powershell
npm run verify:experiment2-oam-goal -- --profiles starlink-main-large --reference reports/experiment2-int-mc-energy-physics-final/experiment2-int-mc-enhancement-comparison.json --candidate reports/experiment2-int-mc-oam-optimized-starlink-round1/experiment2-int-mc-enhancement-comparison.json
~~~

- [ ] Require Starlink bytes at or below 23.9419 B/node/slice and all quality gates to pass.
- [ ] If bytes fail while quality passes, lower transit metadata from 88 B to 86 B without changing target observations.
- [ ] If quality fails, restore adjacent scans at mandatory targets and their target-link endpoints while keeping transit-only scans suppressed.
- [ ] If bytes still fail, add marginal multi-target scoring before changing mandatory thresholds.
- [ ] Do not add soft retest or cooldown unless those three adjustments fail.
- [ ] Put every calibration iteration in a new round directory and run the strict verifier after each.

### Task 9: Run The Full Three-Scale Experiment 2

**Files:**
- Generate: reports/experiment2-int-mc-oam-optimized-final/
- Generate: reports/experiment2-baseline-comparison-oam-optimized-final/

**Interfaces:**
- Consumes: accepted implementation and frozen native baseline.
- Produces: final three-profile comparison, comprehensive baseline report, and Pareto report.

- [ ] Run all profiles:

~~~powershell
npm run experiment:int-mc-enhancement -- --old-root reports/experiment2-native-baseline-rerun-final --out reports/experiment2-int-mc-oam-optimized-final --int-mc-sampling-rate 0.25 --int-mc-target-active-link-sampling-rate 0.25 --int-mc-iterations 12 --int-mc-window-size 12 --int-mc-warmup-slices 6 --int-mc-max-paths-per-slice 12
~~~

- [ ] Run the strict verifier against the frozen current-enhanced reference.
- [ ] Regenerate the comprehensive baseline report:

~~~powershell
node scripts/writeExperiment2BaselineComparison.mjs --old-root reports/experiment2-native-baseline-rerun-final --enhanced-root reports/experiment2-int-mc-oam-optimized-final --out reports/experiment2-baseline-comparison-oam-optimized-final
~~~

- [ ] Regenerate the Pareto report:

~~~powershell
npm run experiment2:pareto-report -- --input reports/experiment2-baseline-comparison-oam-optimized-final/experiment2-comprehensive-baseline-summary.csv --out reports/experiment2-baseline-comparison-oam-optimized-final/experiment2-multi-objective-pareto-report.html
~~~

### Task 10: Final Verification And Documentation

**Files:**
- Modify: project-docs/EXPERIMENT_2_FINAL_LOG.md
- Modify: stage2-int/planning/LEO_INT_MC_ADAPTIVE_PLANNING.md

**Interfaces:**
- Consumes: accepted final artifacts.
- Produces: reproducible commands, exact deltas, mechanism explanation, and limitations.

- [ ] Document OAM marginal deduplication, target-neighborhood metadata, exact byte decomposition, all quality deltas, and the oracle/OAM-only feedback distinction.
- [ ] Run npm run test:int-mc-adaptive.
- [ ] Run npm run test:int-mc-adaptive-metadata.
- [ ] Run npm run test:int-mc-multi-objective.
- [ ] Run npm run test:int-mc-oam-quality.
- [ ] Run npm run test:experiment2-report.
- [ ] Run npm run test:experiment2-oam-goal.
- [ ] Run npm run build.
- [ ] Run npm run verify:goal.
- [ ] Run git diff --check and inspect git status --short.
- [ ] Confirm reference runs remain unchanged and no calibration directory is presented as the formal result.
