# Importance-Aware Selective LEO INT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce actual LEO-INT-MC telemetry bytes with causal importance-aware targets and real per-hop metadata omission while preserving global reconstruction quality and bounding AoI.

**Architecture:** Add a pure importance/metadata-policy module, feed its explicit targets into the existing topology-versioned selector, execute field-presence masks in the probe runner, and make Ground OAM reconstruct only fields that were actually delivered. Keep the current enhanced path set as a conservative fallback and validate each mechanism independently before a short end-to-end pilot.

**Tech Stack:** Node.js ES modules, CSV/JSON experiment artifacts, existing Stage 2 INT/OAM tools, `node:assert` executable tests.

**Implementation status (2026-07-13):** Completed and verified for the scoped short pilots. The executable checklist below is retained as the implementation history; final evidence and claim boundaries are recorded in `project-docs/IMPORTANCE_AWARE_SELECTIVE_TELEMETRY_PILOT.md`. Formal 48-slice, multi-seed validation remains future experimental work rather than an implementation blocker.

## Global Constraints

- Stage 1 truth generation is not modified.
- Runtime target selection uses only lagged Ground OAM, known task routes and predicted orbit/contact state.
- Hidden Stage 1 metrics are evaluation-only.
- Missing telemetry fields remain unknown and are never coerced to zero.
- No constellation-name-specific branches.
- Actual target-mask/control bytes and forwarding work are included in overhead.
- First rollout preserves existing selected paths; path reranking is a separately gated step.

---

### Task 1: Causal Importance Target Model

**Files:**
- Create: `stage2-int/tools/importance-aware-telemetry.mjs`
- Create: `scripts/testImportanceAwareTelemetryTargets.mjs`
- Modify: `stage2-int/tools/int-mc-observability.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildImportanceAwareTargetPlan({ slices, nodes, links, routes, options })` returning `{ rows, bySlice, summary }`.
- Produces: target rows containing `slice_index`, `source_slice_index`, `target_type`, `target_id`, component scores, `importance_score`, `target_class`, `mandatory`, and `reason`.

- [ ] Write a failing executable test proving low-confidence, volatile and AoI-overdue nodes outrank stable nodes; plane exploration prevents starvation; and no row with `source_slice_index >= slice_index` influences a target.
- [ ] Run `node scripts/testImportanceAwareTelemetryTargets.mjs` and confirm failure because the module does not exist.
- [ ] Implement normalized rolling scores, deterministic quotas, mandatory overdue targets and hysteresis without truth fields.
- [ ] Extend observable node/link rows with OAM age, confidence-state and conflict/model-disagreement fields while retaining the existing one-slice lag.
- [ ] Run the target test and `npm run test:int-mc-oracle-free-planner` and confirm both pass.

### Task 2: Real Per-Hop Metadata Masks

**Files:**
- Modify: `stage2-int/tools/importance-aware-telemetry.mjs`
- Create: `scripts/testImportanceAwareMetadataMasks.mjs`
- Modify: `stage2-int/config/telemetry-fields.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildPathMetadataPlan({ pathNodes, pathLinks, nodeTargets, linkTargets, observedNodes, observedLinks, fieldProfile })`.
- Each hop decision contains `profile`, `node_fields_present`, `link_fields_present`, `metadata_bytes`, `writes_observation`, and `reason`.

- [ ] Write a failing test proving a target node gets `node-full`, a selected link gets `link-full`, a first unique non-target path link gets `link-light`, and duplicate/pure transit hops get `forward-only`.
- [ ] Assert exact byte totals include per-packet target-mask bytes and are lower than all-full metadata for the same path.
- [ ] Run the test and confirm failure because mask planning is absent.
- [ ] Add field byte sizes and implement deterministic field-presence/byte accounting.
- [ ] Run the mask test and confirm it passes.

### Task 3: Probe Runner Field Semantics

**Files:**
- Modify: `stage2-int/tools/probe-int-runner.mjs`
- Modify: `scripts/testIntMcAdaptiveMetadataProfileBehavior.mjs`
- Create: `scripts/testProbeSelectiveMetadataSemantics.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes path CSV columns `metadata_hop_profiles`, `metadata_hop_bytes`, `metadata_node_field_masks`, `metadata_link_field_masks`, and `target_mask_bytes`.
- Produces forwarding accounting for every hop and OAM hop records only when at least one telemetry field is present.

- [ ] Write a failing fixture where a three-hop path has one full target, one link-light hop and one forward-only hop.
- [ ] Assert the forward-only hop does not expose node/link state, actual report size equals delivered fields, and forwarding/control overhead remains non-zero.
- [ ] Run the test and confirm the current runner incorrectly exposes full state on transit hops.
- [ ] Implement mask parsing, nullable field emission, separate forwarding counters and exact report/target-mask accounting.
- [ ] Run selective-metadata and existing adaptive-metadata tests and confirm they pass.

### Task 4: Ground OAM Partial-Field Reconstruction

**Files:**
- Modify: `stage2-int/tools/ground-oam-reconstructor.mjs`
- Create: `scripts/testGroundOamPartialMetadata.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes `node_fields_present` and `link_fields_present` from delivered hop records.
- Produces metric-specific observation masks, confidence/AoI updates and unknown values for omitted fields.

- [ ] Write a failing test proving omitted CPU/energy/link-utilization fields remain unknown rather than becoming zero or direct observations.
- [ ] Assert link-light metadata observes only its declared link metrics and stale confidence/AoI advance for omitted node state.
- [ ] Run the test and confirm current aggregation treats every hop row as a complete observation.
- [ ] Implement field-aware aggregation and metric-specific observed flags while preserving legacy rows without masks.
- [ ] Run the partial-field test and existing OAM quality/feedback tests.

### Task 5: Selector Integration And Conservative Fallback

**Files:**
- Modify: `stage2-int/tools/int-mc-path-selector.mjs`
- Modify: `stage2-int/tools/topology-versioned-active-telemetry.mjs`
- Create: `scripts/testImportanceAwarePathSelection.mjs`
- Modify: `scripts/experiments/intMcExperimentCore.mjs`
- Modify: `stage2-int/config/int-mc-policy.json`
- Modify: `package.json`

**Interfaces:**
- Adds CLI switches `--importance-aware-targets`, `--importance-target-ratio`, `--importance-max-aoi-slices`, `--importance-exploration-ratio`, and `--importance-metadata-only`.
- Adds target-plan CSV/JSON artifacts and per-hop mask columns to `probe-paths-int-mc.csv`.

- [ ] Write a failing test proving target gain prefers a path covering more high-score uncovered targets per actual byte, while mandatory OAM targets and the legacy shadow guard remain enforced.
- [ ] Assert metadata-only mode preserves the canonical probe path identities exactly.
- [ ] Run the test and confirm failure because explicit target plans are not integrated.
- [ ] Build causal target plans from observable planner rows, merge hard OAM targets, compute per-candidate masks/costs and add bounded target gain to the existing objective.
- [ ] Implement metadata-only mode and conservative fallback when confidence/AoI debt crosses the restore threshold.
- [ ] Run target, topology-versioned objective, oracle-free planner and byte-budget tests.

### Task 6: Short End-to-End Quality Gate

**Files:**
- Create: `scripts/runImportanceAwareTelemetryPilot.mjs`
- Create: `scripts/testImportanceAwareTelemetryPilotArtifacts.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `importance-aware-pilot-summary.csv/json/md` with actual overhead, global/critical errors, anomaly recall and AoI.

- [ ] Add a pilot runner with variants `enhanced-current`, `importance-mask-only`, `importance-path-full-metadata`, and `importance-path-selective` on shared Stage 1 truth.
- [ ] Define critical nodes causally for planning but evaluate critical-node error against Stage 1 truth only after reconstruction; record this boundary in the manifest.
- [ ] Export actual metadata, target-mask, report/downlink, forwarding-processing, energy, path-count, global MAE, critical MAE, anomaly precision/recall/F1 and AoI p50/p95/max.
- [ ] Run an 8-slice Iridium test fixture, then a 12-slice Telesat pilot if the fixture passes.
- [ ] Enforce the pilot gate: fewer actual bytes; global numeric MAE regression at most 1%; categorical accuracy loss at most 0.5 percentage points; critical error/anomaly recall non-inferior; maximum AoI within the configured bound.
- [ ] If a gate fails, retain the current enhanced fallback and adjust only generic confidence/AoI thresholds before rerunning the short pilot.

### Task 7: Verification And Documentation

**Files:**
- Modify: `stage2-int/planning/LEO_INT_MC_ADAPTIVE_PLANNING.md`
- Modify: `project-docs/EXPERIMENT_2_FINAL_LOG.md`

**Interfaces:**
- Documents the deployable causal boundary, formulas, byte accounting and scope of demonstrated claims.

- [ ] Run all new tests plus `npm run build`.
- [ ] Run `npm run test:experiment2-oracle-free`, `npm run test:int-mc-deployable-feedback`, `npm run test:int-mc-adaptive-metadata`, and `npm run test:telemetry-byte-budget`.
- [ ] Inspect `git diff --check` and the pilot artifacts for missing values or truth leakage.
- [ ] Document only claims proven by the pilot; label longer 48-slice and multi-seed validation as pending until executed.
