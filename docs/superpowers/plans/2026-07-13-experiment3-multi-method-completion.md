# Experiment 3 Multi-method Matrix Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand experiment 3 into a fair six-backend single-metric matrix-completion comparison without rerunning the expensive telemetry pipeline.

**Architecture:** Add three dependency-free completion algorithms behind a focused module and route them through the existing Ground OAM reconstructor backend switch. Upgrade the experiment runner to fingerprint shared observations, report computation cost, and produce six-method artifacts while reusing existing probe/report observations.

**Tech Stack:** Node.js ESM, existing CSV/JSON experiment artifacts, dependency-free matrix operations, HTML/SVG reports.

## Global Constraints

- Do not modify stage-one truth generation or INT sampling behavior.
- Keep `low-rank`, `st-gnn`, and `costco` behavior unchanged.
- Truth is evaluation-only; completion consumes delivered Ground OAM observations and structural identifiers.
- Lock observed entries and force inactive link cells to zero for every backend.
- Use short smoke runs before any 48-slice completion-only replay.

---

### Task 1: Additional Completion Backends

**Files:**
- Create: `stage2-int/tools/int-mc-additional-completion-backends.mjs`
- Test: `scripts/testIntMcAdditionalCompletionBackends.mjs`

**Interfaces:**
- Produces: `ADDITIONAL_COMPLETION_BACKENDS`, `completeWithAdditionalBackend(options)`.
- Consumes normalized `matrix`, `activeMask`, `observedMask`, row-neighbor indexes and completion options.

- [ ] Write failing tests for prior-only identity, observed locking, inactive-mask locking, Soft-Impute shrinkage and graph-neighbor smoothing.
- [ ] Run `node scripts/testIntMcAdditionalCompletionBackends.mjs` and verify the missing-module failure.
- [ ] Implement `prior-only`, `soft-impute`, and `graph-regularized` without external dependencies.
- [ ] Run the test and verify all invariants pass.

### Task 2: Ground OAM Backend Integration

**Files:**
- Modify: `stage2-int/tools/int-mc-reconstructor.mjs`
- Test: `scripts/testIntMcCompletionBackendRegistry.mjs`

**Interfaces:**
- CLI accepts `--completion-backend prior-only|low-rank|soft-impute|graph-regularized|st-gnn|costco`.
- CLI accepts Soft-Impute and graph regularization weights and writes diagnostics to matrix summaries.

- [ ] Write a registry test that checks all six names, aliases and documented CLI options.
- [ ] Run the registry test and verify it fails before integration.
- [ ] Import the additional backend module, extend normalization/family labels and dispatch.
- [ ] Measure backend wall-clock duration and export backend-specific diagnostics.
- [ ] Run registry and existing reconstructor behavior tests.

### Task 3: Experiment 3 Fairness and Reporting

**Files:**
- Modify: `scripts/runExperiment3CpuCompletionComparison.mjs`
- Modify: `stage2-int/config/int-mc-policy.json`
- Modify: `stage2-int/ML_INT_MC_BACKENDS.md`
- Test: `scripts/testExperiment3MultiMethodMatrix.mjs`

**Interfaces:**
- Experiment summary schema becomes `experiment3-cpu-single-metric-completion-v2`.
- Every result row contains shared-input hashes, backend diagnostics and completion wall-clock cost.

- [ ] Write a report-contract test for six methods, shared-mask fingerprints and evaluation-only truth boundaries.
- [ ] Extend backend metadata and argument propagation.
- [ ] Hash probe plans, Ground OAM observations and an ordered observation-mask projection.
- [ ] Add runtime/error charts, method ranking and explicit statistical-limit wording.
- [ ] Update policy and backend documentation.
- [ ] Run report-contract and JSON parse tests.

### Task 4: Lightweight Validation and Artifact Refresh

**Files:**
- Create: `scripts/runExperiment3MultiMethodSmoke.mjs`
- Modify: `package.json`
- Generate: `reports/_scratch/experiment3-multi-method-smoke/`
- Refresh: `reports/experiment3-cpu-single-metric-completion/`

**Interfaces:**
- `npm run test:experiment3` runs backend and report-contract tests.
- `npm run experiment3:smoke` evaluates all six methods on a bounded existing observation fixture.

- [ ] Add a bounded smoke runner that filters existing Iridium observations to eight slices.
- [ ] Verify all six methods consume the same mask hash and preserve observed values.
- [ ] Run the smoke experiment and inspect method metrics and durations.
- [ ] Reuse the existing 48-slice telemetry observations to run only the three new completion backends.
- [ ] Regenerate the experiment 3 CSV/JSON/HTML and run `npm run build` plus `git diff --check`.
