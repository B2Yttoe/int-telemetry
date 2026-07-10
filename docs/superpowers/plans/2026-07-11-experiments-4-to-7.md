# Experiments 4 Through 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run four reproducible, three-scale, 48-slice studies covering LEO-INT-MC ablation, overhead decomposition, sampling sensitivity, and no-truth-leakage legality, with Chinese root reports and detailed HTML/CSV/JSON evidence.

**Architecture:** Extract the existing Experiment 2 orchestration into a shared experiment core that enforces an OAM-only, one-slice causal boundary and records per-stage timings. Experiment-specific runners define only their variant matrix and report calculations. Runs are resumable and retain evidence-level artifacts by default so the large parameter sweeps remain reproducible without recreating tens of gigabytes of disposable hop data.

**Tech Stack:** Node.js ESM, existing CSV/JSON simulation artifacts, existing Stage 2 INT/OAM tools, inline SVG/HTML reports, SHA-256 provenance manifests, npm scripts.

## Global Constraints

- Formal constellations are exactly Iridium NEXT 66, Telesat 1015/Hypatia 351, and Starlink main shell 1584.
- Every formal run uses exactly 48 time slices and the frozen Experiment 2 Stage 1 truth/candidate-path inputs.
- Default low-rank parameters are sampling 0.25, target active-link sampling 0.25, rank 5, window 12, warmup 6, iterations 12, and maximum 12 paths per slice.
- Path planning uses `observability_mode=oam-only`; Stage 1 truth is available only after planning and reconstruction for evaluation.
- At slice `t`, dynamic OAM state and feedback must originate from slices no later than `t-1`.
- Reports are UTF-8 Chinese; HTML uses local inline SVG and no online chart dependency.
- Existing user changes in the dirty worktree must be preserved.

---

### Task 1: Add causal scheduling to the observable planner boundary

**Files:**
- Modify: `stage2-int/tools/int-mc-observability.mjs`
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`
- Create: `scripts/testIntMcCausalObservability.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `scheduleObservableRows(rows, { lagSlices, sourceFieldCandidates, targetFieldCandidates })`
- Extends: `buildObservablePlanningLinks({ truthLinks, predictedPlan, oamLinks, mode, stateLagSlices })`
- Extends: `buildObservablePlanningNodes({ truthNodes, oamNodes, mode, stateLagSlices })`
- CLI: `--feedback-lag-slices <integer>`, default `1` under `oam-only`, `0` under `oracle`

- [ ] **Step 1: Write the failing causal-boundary test**

Create `scripts/testIntMcCausalObservability.mjs` with fixtures for OAM link state, node state, Ground OAM retest feedback, deployable feedback, and control actions. Assert the following exact behavior:

```js
assert.equal(scheduleObservableRows([{ slice_index: 4, target_id: "L1" }], {
  lagSlices: 1,
})[0].slice_index, 5);

assert.equal(scheduleObservableRows([{
  source_slice_index: 4,
  slice_index: 5,
  target_id: "L2",
}], { lagSlices: 1 })[0].slice_index, 5);

assert.equal(planningLinksAtSlice5[0].planner_state_source_slice_index, 4);
assert.equal(planningNodesAtSlice5[0].planner_state_source_slice_index, 4);
assert.equal(planningLinksAtSlice0[0].planner_state_source, "predicted-contact-plan");
assert.ok(planningLinks.every((row) =>
  row.planner_state_source_slice_index === "" ||
  Number(row.planner_state_source_slice_index) < Number(row.slice_index)
));
```

- [ ] **Step 2: Run the test and confirm the missing API failure**

Run: `node scripts/testIntMcCausalObservability.mjs`

Expected: FAIL because `scheduleObservableRows` and `stateLagSlices` do not yet exist.

- [ ] **Step 3: Implement causal row scheduling**

Add an exported helper that derives the source slice from `source_slice_index`, `control_source_slice_index`, or `slice_index`; derives any declared target from `next_slice_index`, `target_slice_index`, or `slice_index`; then writes the effective target as. Add `firstPresent(row, fields)` as `fields.map((field) => row[field]).find((value) => value !== undefined && value !== "")`:

```js
const sourceSlice = numberValue(firstPresent(row, sourceFieldCandidates), 0);
const declaredTarget = numberValue(firstPresent(row, targetFieldCandidates), sourceSlice);
const effectiveTarget = Math.max(declaredTarget, sourceSlice + lagSlices);
return {
  ...row,
  source_slice_index: sourceSlice,
  slice_index: effectiveTarget,
  causal_feedback_lag_slices: effectiveTarget - sourceSlice,
};
```

For planning links/nodes, index OAM rows at `sourceSlice + stateLagSlices` while retaining `planner_state_source_slice_index=sourceSlice`. Slice 0 must use predictable contact/static orbital context rather than future OAM values.

- [ ] **Step 4: Wire the selector CLI and provenance fields**

Parse the lag with:

```js
const feedbackLagSlices = Math.max(
  0,
  Math.floor(numberArg(args, "--feedback-lag-slices", observabilityMode === "oam-only" ? 1 : 0)),
);
```

Apply it to planner OAM links, planner OAM nodes, priority feedback, and controls before building per-slice maps. Add these report fields:

```js
report.method.feedback_lag_slices = feedbackLagSlices;
report.method.causal_oam_boundary_enabled = feedbackLagSlices >= 1;
report.coverage.causal_feedback_rows = observableOamPriorityRetests.length;
report.coverage.causal_feedback_violations = observableOamPriorityRetests.filter((row) =>
  Number(row.source_slice_index) >= Number(row.slice_index)
).length;
```

- [ ] **Step 5: Run causal and existing boundary tests**

Run:

```powershell
node scripts/testIntMcCausalObservability.mjs
npm run test:int-mc-oracle-free-planner
npm run test:int-mc-deployable-feedback
```

Expected: all PASS.

- [ ] **Step 6: Register the npm test and commit**

Add `"test:int-mc-causal-observability": "node scripts/testIntMcCausalObservability.mjs"` to `package.json`.

Commit:

```powershell
git add stage2-int/tools/int-mc-observability.mjs stage2-int/tools/int-mc-path-selector.mjs scripts/testIntMcCausalObservability.mjs package.json
git commit -m "fix: enforce causal OAM planning boundary"
```

---

### Task 2: Extract a shared, timed, resumable experiment core

**Files:**
- Create: `scripts/experiments/intMcExperimentCore.mjs`
- Create: `scripts/experiments/reportUtils.mjs`
- Create: `scripts/fixtures/printJson.mjs`
- Create: `scripts/testIntMcExperimentCore.mjs`
- Modify: `scripts/runExperiment2IntMcEnhancementComparison.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `PROFILE_CATALOG`, `FORMAL_DEFAULTS`
- Produces: `runCommandTimed({ label, script, args, cwd }) -> { result, timing }`
- Produces: `runIntMcPass(options) -> { metrics, timings, artifacts }`
- Produces: `runTwoPassVariant(options) -> { before, after, manifest }`
- Produces: `collectIntMcMetrics({ truthDir, stage2Dir, groundDir })`
- Produces: `canonicalProbePlanHash(rows)` and `sha256File(path)`
- Produces report helpers: `parseCsv`, `rowsToCsv`, `escapeHtml`, `writeJson`, `writeUtf8`, `inlineBarChart`, `inlineLineChart`, `inlineHeatmap`

- [ ] **Step 1: Write a failing core smoke test**

Create `scripts/testIntMcExperimentCore.mjs` and assert:

```js
assert.deepEqual(PROFILE_CATALOG.map((row) => row.node_count), [66, 351, 1584]);
assert.equal(FORMAL_DEFAULTS.slice_count, 48);
assert.equal(FORMAL_DEFAULTS.feedback_lag_slices, 1);

const timed = await runCommandTimed({
  label: "json-smoke",
  script: "scripts/fixtures/printJson.mjs",
  args: [],
  cwd: process.cwd(),
});
assert.equal(timed.result.ok, true);
assert.ok(timed.timing.wall_time_ms >= 0);

assert.equal(canonicalProbePlanHash([{ slice_index: 0, probe_id: "P", path: "A>B" }]),
  canonicalProbePlanHash([{ path: "A>B", probe_id: "P", slice_index: 0 }]));
```

Create `scripts/fixtures/printJson.mjs` with `console.log(JSON.stringify({ ok: true }));`. Use a temporary directory under `reports/tmp-int-mc-experiment-core-test` and verify cleanup protection checks the resolved path contains that exact basename.

- [ ] **Step 2: Run the test and confirm imports fail**

Run: `node scripts/testIntMcExperimentCore.mjs`

Expected: FAIL because the experiment modules do not exist.

- [ ] **Step 3: Implement report utilities and deterministic hashes**

Move the robust quoted CSV parser/writer and HTML escaping logic from the existing Experiment 2 scripts into `reportUtils.mjs`. Implement probe-plan hashing by sorting normalized rows on slice, probe ID, source, sink, path, and metadata profile before `createHash("sha256")`.

- [ ] **Step 4: Implement timed child-process execution**

Use `performance.now()` and `process.resourceUsage()` around `spawn`. Return:

```js
{
  result: parseLastJson(stdout, label),
  timing: {
    label,
    wall_time_ms: round(end - start, 3),
    parent_user_cpu_ms: round((after.userCPUTime - before.userCPUTime) / 1000, 3),
    parent_system_cpu_ms: round((after.systemCPUTime - before.systemCPUTime) / 1000, 3),
    exit_code: code,
  },
}
```

Wall time is the authoritative component runtime; parent CPU values are diagnostic because child CPU is not portable through Node's `spawn` API.

- [ ] **Step 5: Extract the pass runner and metric collector**

Move `runIntMcPass` and `collectEnhancedMetrics` from `runExperiment2IntMcEnhancementComparison.mjs` into the shared core. Add mechanism options with explicit booleans:

```js
{
  adaptiveReuse,
  incrementalTopologyRepair,
  forecastRiskScoring,
  adaptiveProbeBudget,
  metricTensorCoupling,
  nodeStateCoupling,
  nodeEnergyPhysicsPrior,
  jointStateCoupling,
  orbitGraphRegularization,
  orbitPeriodicPrior,
  oamQualityFeedback,
  stateTensorJointCompletion,
  multiObjectiveBudget,
  oamTargetAwareMetadata,
  feedbackLagSlices,
}
```

Collect the six stage timings under fixed keys: `contact_prediction`, `path_selection`, `reporting_plan`, `probe_execution`, `ground_oam`, `matrix_completion`.

- [ ] **Step 6: Implement resumable manifests and evidence retention**

For every run, hash the truth metadata, candidate paths, parameters, and mechanism flags. Reuse a completed run only when `run-manifest.json` has `status="complete"` and the same `input_fingerprint`. Support `artifactLevel="evidence"` by retaining coverage/report/evaluation/summary/planning CSVs while deleting only explicitly listed regenerable bulk files such as full hop-record CSVs after their aggregate hashes and row counts are recorded.

- [ ] **Step 7: Update Experiment 2 to import the shared core**

Preserve its CLI and current output schema. Pass `feedbackLagSlices=1` for formal `oam-only` runs and add the lag to the JSON manifest.

- [ ] **Step 8: Run core and Experiment 2 boundary tests**

Run:

```powershell
node scripts/testIntMcExperimentCore.mjs
npm run test:experiment2-oracle-free
```

Expected: PASS and Experiment 2 manifest reports a one-slice causal boundary.

- [ ] **Step 9: Register the npm test and commit**

Add `"test:int-mc-experiment-core": "node scripts/testIntMcExperimentCore.mjs"`.

Commit the five files with `git commit -m "refactor: add shared INT-MC experiment core"`.

---

### Task 3: Add non-overlapping mechanism switches for ablation

**Files:**
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`
- Modify: `scripts/experiments/intMcExperimentCore.mjs`
- Create: `scripts/testIntMcAblationSwitches.mjs`
- Modify: `package.json`

**Interfaces:**
- CLI: `--incremental-topology-repair true|false`
- CLI: `--forecast-risk-scoring true|false`
- Existing CLI reused: `--adaptive-reuse`, `--adaptive-probe-budget`, `--adaptive-metadata-profile`, `--multi-objective-budget`
- Produces selector report field `method.mechanism_flags`

- [ ] **Step 1: Write failing switch-isolation tests**

Build a small two-slice fixture with a reusable topology, an OAM delta target, and forecast risk. Invoke the selector under full and one-switch-disabled configurations. Assert:

```js
assert.ok(full.coverage.reused_slice_plans > 0);
assert.equal(noReuse.coverage.reused_slice_plans, 0);
assert.equal(noIncremental.coverage.incremental_delta_candidate_paths, 0);
assert.equal(noForecast.method.mechanism_flags.forecast_risk_scoring, false);
assert.deepEqual(noForecast.method.mechanism_flags, {
  ...full.method.mechanism_flags,
  forecast_risk_scoring: false,
});
```

- [ ] **Step 2: Run the test and confirm unsupported flags**

Run: `node scripts/testIntMcAblationSwitches.mjs`

Expected: FAIL because the new flags are not reported or enforced.

- [ ] **Step 3: Implement the switches**

When incremental repair is false, reused plans must not append OAM delta candidates. When forecast scoring is false, `forecast_priority_score`, near-outage bonus, contact-scarcity bonus, and drift-risk bonus contribute zero to path score, but the predicted active mask remains available for physical path validity. This distinction prevents the no-orbit-prior group from accidentally enabling impossible links.

- [ ] **Step 4: Persist exact mechanism flags**

Write every switch into selector JSON, run manifests, and comparison rows. The report must be able to prove two variants differ only in the intended group.

- [ ] **Step 5: Run switch and existing adaptive tests**

Run:

```powershell
node scripts/testIntMcAblationSwitches.mjs
npm run test:int-mc-adaptive
npm run test:int-mc-adaptive-metadata
```

Expected: all PASS.

- [ ] **Step 6: Register and commit**

Add `"test:int-mc-ablation-switches": "node scripts/testIntMcAblationSwitches.mjs"` and commit with `git commit -m "feat: expose LEO INT-MC ablation switches"`.

---

### Task 4: Implement Experiment 4 grouped ablation and reports

**Files:**
- Create: `scripts/runExperiment4Ablation.mjs`
- Create: `scripts/testExperiment4AblationMatrix.mjs`
- Create at runtime: `EXPERIMENT_4_ABLATION_REPORT.md`
- Create at runtime: `reports/experiment4-leo-int-mc-ablation/experiment4-ablation-summary.csv`
- Create at runtime: `reports/experiment4-leo-int-mc-ablation/experiment4-ablation-by-slice.csv`
- Create at runtime: `reports/experiment4-leo-int-mc-ablation/experiment4-ablation-summary.json`
- Create at runtime: `reports/experiment4-leo-int-mc-ablation/experiment4-ablation-report.html`
- Create at runtime: `reports/experiment4-leo-int-mc-ablation/experiment4-manifest.json`
- Modify: `package.json`

**Interfaces:**
- CLI: `--profiles`, `--variants`, `--out`, `--resume`, `--artifact-level`, and all formal numeric parameters
- Variants: `full`, `no-topology-adaptation`, `no-oam-feedback`, `no-adaptive-overhead`, `no-orbit-priors`, `no-state-coupling`

- [ ] **Step 1: Write a failing experiment-matrix test**

Import `buildExperiment4Variants()` and assert six variants, unique IDs, and exact flag differences. For each ablation, compare against `full` and assert only these fields differ:

```js
const expectedDiffs = {
  "no-topology-adaptation": ["adaptiveReuse", "incrementalTopologyRepair"],
  "no-oam-feedback": ["useOamFeedback", "oamQualityFeedback"],
  "no-adaptive-overhead": ["adaptiveProbeBudget", "multiObjectiveBudget", "oamTargetAwareMetadata"],
  "no-orbit-priors": ["orbitGraphRegularization", "orbitPeriodicPrior", "forecastRiskScoring"],
  "no-state-coupling": ["metricTensorCoupling", "nodeStateCoupling", "nodeEnergyPhysicsPrior", "jointStateCoupling", "stateTensorJointCompletion"],
};
```

- [ ] **Step 2: Run the test and confirm missing runner failure**

Run: `node scripts/testExperiment4AblationMatrix.mjs`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement pass-1 sharing and variant execution**

For each constellation and sampling configuration, run pass-1 once. Feed its causally shifted Ground OAM estimates into each pass-2 variant. Require all variants to use the same truth fingerprint, candidate-path fingerprint, feedback lag, rank/window/iterations, and pass-1 fingerprint.

- [ ] **Step 4: Compute mechanism contribution fields**

For every metric write absolute value, full value, absolute delta, and relative delta. For error metrics use `(ablation-full)/max(full,1e-9)`; for accuracy metrics use `full-ablation`; for cost metrics use `(ablation-full)/max(full,1e-9)`.

- [ ] **Step 5: Generate Chinese Markdown and HTML reports**

Include hypothesis, exact switch table, three-scale results, mechanism contribution heatmap, error bars, cost chart, non-significant/negative contributions, limitations, commands, and output index. The root Markdown must contain the explicit headings `实验做了什么`, `实验结果`, `证明了什么`, and `不能证明什么`.

- [ ] **Step 6: Run a one-profile two-variant smoke test**

Run:

```powershell
node scripts/runExperiment4Ablation.mjs --profiles iridium-next-small --variants full,no-oam-feedback --out reports/experiment4-smoke --artifact-level evidence
```

Expected: two summary rows, both 48 slices, causal lag 1, and all five output formats present.

- [ ] **Step 7: Register commands and commit**

Add:

```json
"experiment4:ablation": "node scripts/runExperiment4Ablation.mjs",
"test:experiment4": "node scripts/testExperiment4AblationMatrix.mjs"
```

Commit with `git commit -m "feat: add LEO INT-MC ablation experiment"`.

---

### Task 5: Implement Experiment 5 overhead decomposition

**Files:**
- Create: `scripts/runExperiment5OverheadDecomposition.mjs`
- Create: `scripts/testExperiment5OverheadAccounting.mjs`
- Create at runtime: `EXPERIMENT_5_OVERHEAD_REPORT.md`
- Create at runtime: `reports/experiment5-overhead-decomposition/experiment5-overhead-summary.csv`
- Create at runtime: `reports/experiment5-overhead-decomposition/experiment5-stage-timings.csv`
- Create at runtime: `reports/experiment5-overhead-decomposition/experiment5-overhead-summary.json`
- Create at runtime: `reports/experiment5-overhead-decomposition/experiment5-overhead-report.html`
- Create at runtime: `reports/experiment5-overhead-decomposition/experiment5-manifest.json`
- Modify: `package.json`

**Interfaces:**
- Consumes completed `before` and `full` runs from the shared core or Experiment 4 when fingerprints match
- Produces network, compute, planning-reuse, and normalized-efficiency sections

- [ ] **Step 1: Write failing accounting tests**

Use a synthetic metrics row and assert:

```js
assert.equal(parts.probe_base_bytes + parts.metadata_bytes + parts.report_bytes + parts.other_bytes,
  parts.total_generated_bytes);
assert.ok(parts.other_bytes >= 0);
assert.equal(parts.bytes_per_node_slice,
  parts.total_generated_bytes / (parts.node_count * parts.slice_count));
assert.equal(parts.bytes_per_effective_state,
  parts.total_generated_bytes / parts.effective_reconstructed_state_count);
assert.ok(Object.values(stageTimings).every((value) => value >= 0));
```

- [ ] **Step 2: Run the test and confirm missing calculator failure**

Run: `node scripts/testExperiment5OverheadAccounting.mjs`

Expected: FAIL because the overhead runner/calculator does not exist.

- [ ] **Step 3: Implement exact byte decomposition**

Use runtime fields already produced by probe INT. Define `other_bytes=max(0,total-probeBase-metadata-report)` and separately report `total_int_bytes` and cumulative `total_isl_telemetry_link_bytes` because the latter counts per-hop carriage and is not additive with generated bytes.

- [ ] **Step 4: Implement compute and topology-reuse decomposition**

Write per-stage wall times and percentages. Record `reused_slice_plans`, `fresh_slice_plans`, `estimated_full_replanning_avoided`, OAM-forced replans, local delta candidates, duplicate-suppressed paths, selected paths, and hop records. Compute:

```js
planning_avoidance_rate = reused_slice_plans / slice_count;
bytes_per_effective_link_state = total_generated_bytes /
  Math.max(active_link_effective_samples, 1);
error_cost_product = telemetry_bytes_per_node_slice * mean_normalized_error;
```

- [ ] **Step 5: Generate Chinese report and inline SVG charts**

Generate byte stack bars, stage timing waterfall, planning-mode proportions, and a table comparing enhanced-before/full by scale. State that wall time is machine-relative, not spacecraft hardware latency.

- [ ] **Step 6: Run accounting tests and a three-scale report-only pass**

Point the runner at fingerprint-compatible Experiment 4 artifacts. If absent, it may execute only `before` and `full`. Verify all byte identities and non-negative timing fields.

- [ ] **Step 7: Register and commit**

Add `experiment5:overhead` and `test:experiment5` npm scripts; commit with `git commit -m "feat: add INT overhead decomposition experiment"`.

---

### Task 6: Implement Experiment 6 sampling-rate sensitivity

**Files:**
- Create: `scripts/runExperiment6SamplingSensitivity.mjs`
- Create: `scripts/testExperiment6SamplingMatrix.mjs`
- Create at runtime: `EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.csv`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-sampling-by-slice.csv`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-pareto-front.csv`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.json`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-sampling-report.html`
- Create at runtime: `reports/experiment6-sampling-sensitivity/experiment6-manifest.json`
- Modify: `package.json`

**Interfaces:**
- CLI default rates: `0.05,0.10,0.15,0.20,0.25,0.30,0.40`
- Runs `before` and `full` for each profile/rate pair
- Produces Pareto membership, normalized ideal-point distance, and knee score

- [ ] **Step 1: Write failing matrix and Pareto tests**

Assert 42 formal rows (`3 profiles * 7 rates * 2 methods`), exact rates, no cross-rate pass-1 fingerprint reuse, and Pareto behavior for a synthetic set:

```js
assert.equal(buildExperiment6Matrix().length, 42);
assert.deepEqual([...new Set(buildExperiment6Matrix().map((row) => row.rate))],
  [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40]);
assert.equal(markPareto([
  { id: "a", cost: 1, error: 3 },
  { id: "b", cost: 2, error: 2 },
  { id: "c", cost: 3, error: 4 },
]).find((row) => row.id === "c").pareto, false);
```

- [ ] **Step 2: Run the test and confirm missing runner failure**

Run: `node scripts/testExperiment6SamplingMatrix.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement resumable rate/profile execution**

Create a separate pass-1 fingerprint for every profile/rate. Run before and full with identical truth, candidate paths, numeric parameters, and lag. Execute sequentially by default to avoid large-memory contention; support `--profiles`, `--rates`, and `--resume true` for partial formal runs.

- [ ] **Step 4: Compute per-slice stability statistics**

For coverage, bytes, and available errors, write mean, standard deviation, P5, P50, and P95. Quantile uses sorted linear interpolation at `(n-1)q` so all reports share one definition.

- [ ] **Step 5: Compute Pareto front and knee points**

Within each profile/method, normalize cost and each error to `[0,1]`. A row is dominated when another has no higher cost and no higher aggregate normalized error with one strict improvement. Report all non-dominated points. Select the descriptive knee by minimum Euclidean distance to `(cost=0,error=0)`; label it a recommended compromise, not a universal optimum.

- [ ] **Step 6: Generate Chinese reports and curves**

Include seven-point sampling/error curves for CPU, queue, energy, link utilization, node mode, and link status; sampling/overhead curves; direct/effective coverage; Pareto plots; knee table; and scale-specific interpretation.

- [ ] **Step 7: Run a two-rate smoke test**

Run:

```powershell
node scripts/runExperiment6SamplingSensitivity.mjs --profiles iridium-next-small --rates 0.10,0.25 --out reports/experiment6-smoke --artifact-level evidence
```

Expected: four method rows, 192 by-slice method rows, valid Pareto labels, and all report files.

- [ ] **Step 8: Register and commit**

Add `experiment6:sampling` and `test:experiment6`; commit with `git commit -m "feat: add INT-MC sampling sensitivity experiment"`.

---

### Task 7: Implement Experiment 7 counterfactual legality auditor

**Files:**
- Create: `scripts/runExperiment7NoTruthLeakage.mjs`
- Create: `scripts/testExperiment7NoTruthLeakage.mjs`
- Create at runtime: `EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md`
- Create at runtime: `reports/experiment7-no-truth-leakage/experiment7-checks.csv`
- Create at runtime: `reports/experiment7-no-truth-leakage/experiment7-plan-hashes.csv`
- Create at runtime: `reports/experiment7-no-truth-leakage/experiment7-summary.json`
- Create at runtime: `reports/experiment7-no-truth-leakage/experiment7-report.html`
- Create at runtime: `reports/experiment7-no-truth-leakage/experiment7-manifest.json`
- Modify: `package.json`

**Interfaces:**
- Check IDs: `observable-schema`, `illegal-feedback-rejection`, `hidden-truth-invariance`, `future-feedback-invariance`, `causal-lag`, `observed-value-lock`, `inactive-mask-lock`, `truth-use-audit`
- Every check writes `status`, `expected`, `observed`, `profile`, `protected_slice_range`, and evidence paths

- [ ] **Step 1: Write failing legality tests**

Test the check registry and two fixture-level counterfactuals. Hidden truth perturbations must change CPU/queue/energy/utilization/status truth values by large deterministic offsets while preserving topology identifiers, predicted contact plan, traffic requests, and OAM inputs. Assert equal plan hashes. Perturb feedback whose source slice is at or after cutoff `t` and assert equal hashes for slices `0..t`.

- [ ] **Step 2: Run the test and confirm missing auditor failure**

Run: `node scripts/testExperiment7NoTruthLeakage.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement schema and illegal-feedback checks**

Inspect planner-view row keys and fail on forbidden dynamic truth fields. Inject one row for each forbidden source/basis/reason/score and require the accepted set to exclude all injected IDs while preserving a deployable uncertainty-based control row.

- [ ] **Step 4: Implement counterfactual plan-hash checks**

Run the selector on original and perturbed fixtures with identical OAM-only inputs. Normalize selected paths and compute SHA-256. For future feedback, compare a per-slice cumulative hash and require equality through the protected cutoff.

- [ ] **Step 5: Implement reconstruction invariants**

Join direct observations to completed rows and count numeric/string mismatches. Join predicted inactive mask rows to completed links and count any reconstructed `up` state. Both counts must be zero.

- [ ] **Step 6: Implement truth-use audit**

Audit formal manifests and source-level dataflow allowlists. Truth files may be passed to contact prediction for predictable geometry and to final evaluation, but hidden dynamic fields must be removed by the observable builders before scoring. Report the exact allowed stages and reject any feedback marked truth/simulation-validation.

- [ ] **Step 7: Generate report and pass/fail exit code**

Write all evidence before exiting. Exit 0 only when all required checks pass. The root report must distinguish `无真值数值泄漏`, `时间因果合法`, and `真值仅用于事后评估` as separate claims.

- [ ] **Step 8: Run fixture and three-profile formal audits**

Run:

```powershell
node scripts/testExperiment7NoTruthLeakage.mjs
node scripts/runExperiment7NoTruthLeakage.mjs --profiles iridium-next-small,telesat-1015-medium,starlink-main-large
```

Expected: all eight checks PASS for every applicable profile, zero causal violations, zero observed-value changes, and zero inactive-mask violations.

- [ ] **Step 9: Register and commit**

Add `experiment7:legality` and `test:experiment7`; commit with `git commit -m "feat: add no-truth-leakage legality experiment"`.

---

### Task 8: Run Experiment 4 formal matrix

**Files:**
- Generate/update: `EXPERIMENT_4_ABLATION_REPORT.md`
- Generate: `reports/experiment4-leo-int-mc-ablation/**`

- [ ] **Step 1: Run all six variants on all three profiles**

Run:

```powershell
npm run experiment4:ablation -- --profiles iridium-next-small,telesat-1015-medium,starlink-main-large --variants full,no-topology-adaptation,no-oam-feedback,no-adaptive-overhead,no-orbit-priors,no-state-coupling --out reports/experiment4-leo-int-mc-ablation --resume true --artifact-level evidence
```

Expected: 18 summary rows and `18 * 48 = 864` by-slice rows.

- [ ] **Step 2: Validate manifests and report conclusions**

Check every row uses lag 1, truth error feedback false, 48 slices, matching profile fingerprints, and exact switch differences. Verify the root report names positive, neutral, and negative mechanism contributions instead of claiming universal improvement.

- [ ] **Step 3: Commit formal Experiment 4 summaries and report**

Do not commit disposable bulk artifacts. Commit root report, HTML/CSV/JSON summaries, manifest, and by-slice summary with `git commit -m "experiment: complete LEO INT-MC ablation study"`.

---

### Task 9: Run Experiment 5 formal decomposition

**Files:**
- Generate/update: `EXPERIMENT_5_OVERHEAD_REPORT.md`
- Generate: `reports/experiment5-overhead-decomposition/**`

- [ ] **Step 1: Generate three-scale overhead decomposition**

Run: `npm run experiment5:overhead -- --profiles iridium-next-small,telesat-1015-medium,starlink-main-large --resume true`

Expected: before/full rows for all profiles, six component timing rows per method/profile, and complete topology-reuse counters.

- [ ] **Step 2: Verify byte identities and timing provenance**

Run `npm run test:experiment5`. Confirm generated-byte components close exactly, ISL-carried bytes are separately labeled, and host/Node/git metadata is present.

- [ ] **Step 3: Commit Experiment 5 evidence**

Commit the root report and detailed summary artifacts with `git commit -m "experiment: complete INT overhead decomposition"`.

---

### Task 10: Run Experiment 6 formal sweep

**Files:**
- Generate/update: `EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md`
- Generate: `reports/experiment6-sampling-sensitivity/**`

- [ ] **Step 1: Run the seven-rate three-scale sweep sequentially**

Run:

```powershell
npm run experiment6:sampling -- --profiles iridium-next-small,telesat-1015-medium,starlink-main-large --rates 0.05,0.10,0.15,0.20,0.25,0.30,0.40 --out reports/experiment6-sampling-sensitivity --resume true --artifact-level evidence
```

Expected: 42 summary rows and `42 * 48 = 2016` by-slice rows.

- [ ] **Step 2: Validate rate completeness and Pareto output**

Verify every profile/method has seven unique rates, all runs share non-rate parameters, no pass-1 fingerprint is reused across rates, and every profile/method has at least one Pareto point.

- [ ] **Step 3: Commit Experiment 6 evidence**

Commit the root report and summary artifacts with `git commit -m "experiment: complete INT-MC sampling sensitivity study"`.

---

### Task 11: Run Experiment 7 formal legality audit and final verification

**Files:**
- Generate/update: `EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md`
- Generate: `reports/experiment7-no-truth-leakage/**`
- Modify: `README.md`

- [ ] **Step 1: Run the formal legality audit after Experiments 4-6**

Run: `npm run experiment7:legality -- --profiles iridium-next-small,telesat-1015-medium,starlink-main-large`

Expected: all required checks PASS. If any fail, mark Experiments 4-6 provisional, fix the boundary, and rerun affected formal combinations.

- [ ] **Step 2: Run all new regression tests**

Run:

```powershell
npm run test:int-mc-causal-observability
npm run test:int-mc-experiment-core
npm run test:int-mc-ablation-switches
npm run test:experiment4
npm run test:experiment5
npm run test:experiment6
npm run test:experiment7
npm run test:experiment2-oracle-free
```

Expected: all PASS.

- [ ] **Step 3: Run project build and repository checks**

Run:

```powershell
npm run build
git diff --check
git status --short
```

Expected: build PASS, no whitespace errors, and no unintended generated bulk files staged.

- [ ] **Step 4: Audit explicit deliverables**

Assert the four root Markdown reports exist and each links to an HTML, CSV, JSON, and manifest. Assert Experiment 4 has 18 rows, Experiment 5 has both methods across three profiles, Experiment 6 has 42 rows, and Experiment 7 has no failed required check.

- [ ] **Step 5: Update README experiment index**

Add a concise table linking Experiments 4-7, their purpose, root report, detailed HTML, and reproduction command. Do not rewrite unrelated README content.

- [ ] **Step 6: Commit final index and verification evidence**

Commit with `git commit -m "docs: index experiments 4 through 7"`.
