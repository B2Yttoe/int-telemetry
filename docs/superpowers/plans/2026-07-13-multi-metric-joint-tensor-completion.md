# Multi-metric Joint Tensor Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add node/link multi-metric CP completion and a physics-projected variant, then compare both with independent 2D low-rank completion under identical telemetry observations and overhead.

**Architecture:** A focused tensor module consumes prior estimates plus per-cell observed/active masks, learns shared time/object/metric factors from delivered observations only, and writes completed estimates back into the existing Ground OAM maps. The reconstructor keeps scalar initialization and output schemas, while a dedicated experiment runner verifies fingerprints, errors, consistency violations and compute cost.

**Tech Stack:** Node.js ESM, deterministic CP-SGD, existing Ground OAM CSV/JSON artifacts, HTML/SVG reports.

## Global Constraints

- Do not modify stage-one simulation or INT sampling.
- Hidden target values are evaluation-only.
- Normalize each metric from directly observed values only.
- Lock direct observations and topology-down cells.
- Keep categorical mode/status outside the continuous tensor.
- Run bounded smoke validation before any 48-slice completion replay.

---

### Task 1: Joint Tensor Core

**Files:**
- Create: `stage2-int/tools/int-mc-joint-tensor-completion.mjs`
- Test: `scripts/testIntMcJointTensorCompletion.mjs`

- [ ] Test per-metric normalization, observation locking, active-mask locking and deterministic output.
- [ ] Test that changing an observed auxiliary metric changes a missing target metric prediction.
- [ ] Implement CP factors, observed-only SGD, temporal/orbit regularization and conservative prior blending.
- [ ] Export diagnostics for shape, observed cells, parameters, loss and wall-clock time.

### Task 2: Reconstructor Integration

**Files:**
- Modify: `stage2-int/tools/int-mc-reconstructor.mjs`
- Modify: `stage2-int/tools/run-int-experiment.mjs`
- Test: `scripts/testIntMcJointTensorBackendRegistry.mjs`

- [ ] Register `joint-cp` and `joint-cp-physics` with aliases and CLI parameters.
- [ ] Initialize scalar metrics with `prior-only`, then jointly replace inferred estimates.
- [ ] Enable existing conservative node/link consistency projection only for the physics variant.
- [ ] Export joint tensor diagnostics and preserve existing backend behavior.

### Task 3: Fair Comparison Experiment

**Files:**
- Create: `scripts/runExperiment3JointTensorComparison.mjs`
- Create: `scripts/testExperiment3JointTensorComparison.mjs`
- Modify: `package.json`

- [ ] Reuse one Ground OAM observation per constellation for all three methods.
- [ ] Hash input files and metric-level masks and fail on any mismatch.
- [ ] Compute per-metric error, macro normalized error, mode/status accuracy and physical-consistency violations.
- [ ] Record telemetry bytes/energy, completion time and output size.
- [ ] Generate CSV, JSON, Markdown and Chinese HTML with error and consistency charts.

### Task 4: Smoke, Conservative Tuning and Verification

**Files:**
- Generate: `reports/_scratch/experiment3-joint-tensor-smoke/`
- Generate: `reports/experiment3-joint-tensor-completion/`
- Modify: `stage2-int/ML_INT_MC_BACKENDS.md`
- Modify: `stage2-int/config/int-mc-policy.json`

- [ ] Run eight-slice Iridium smoke on all three methods.
- [ ] If joint completion materially regresses macro error, lower the fixed prior blend without truth-driven per-scale tuning.
- [ ] Run completion-only replay from existing observations, not the satellite/INT pipeline.
- [ ] Verify report artifacts, legacy tests, build and visual layout.
