# Experiment 9 Multi-Epoch External Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing external-realism evidence into a provenance-audited, multi-epoch validation that separates public orbit/traffic/RTT observables from simulator-internal CPU, battery, and queue state.

**Architecture:** Add a reusable epoch registry and independence audit, build a later CelesTrak snapshot in the report directory, compare common NORAD satellites across different snapshot hashes, and wrap the existing Radar/RIPE analysis into one experiment report with explicit claim boundaries.

**Tech Stack:** Node.js ESM, SHA-256, satellite.js/SGP4, existing CelesTrak snapshot builder, existing external-realism report, CSV/JSON/HTML/Markdown.

## Global Constraints

- A model-input artifact cannot also be an external-validation artifact.
- Every public artifact records exact URL, retrieval UTC time, epoch interval, raw path, SHA-256, record count, parser version, and role.
- Orbital validation may support orbit, position, propagation, shell, visibility, and contact claims only.
- Radar supports normalized aggregate traffic-shape claims only.
- RIPE Atlas supports user-side RTT, loss, and reachability claims only.
- CPU, battery, and queue remain equation-driven latent state and are never described as operator truth.
- Missing live sources produce explicit incomplete evidence, never silent template substitution.

---

### Task 1: Epoch Registry And Independence Audit

**Files:**
- Create: `scripts/experiments/externalEpochRegistry.mjs`
- Create: `scripts/testExperiment9EpochIndependence.mjs`

**Interfaces:**
- Produces: `buildEpochRecord({name,url,path,role,parserVersion}): Promise<EpochRecord>`
- Produces: `auditEpochIndependence(records): {ok:boolean,violations:string[],comparisons:Array}`

- [ ] **Step 1: Write failing provenance tests**

```js
import assert from "node:assert/strict";
import { buildEpochRecord, auditEpochIndependence } from "./experiments/externalEpochRegistry.mjs";

const input = await buildEpochRecord(fixture({ role: "model-input", content: "a" }));
const validation = await buildEpochRecord(fixture({ role: "external-validation", content: "b" }));
assert.equal(auditEpochIndependence([input, validation]).ok, true);
assert.equal(auditEpochIndependence([input, { ...validation, sha256: input.sha256 }]).ok, false);
assert.match(input.sha256, /^[a-f0-9]{64}$/);
assert.ok(input.retrieved_at);
assert.ok(input.epoch_start);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment9EpochIndependence.mjs`

Expected: missing-module failure.

- [ ] **Step 3: Implement registry and audit**

Hash raw bytes, infer epoch min/max from snapshot or CelesTrak GP JSON records, count records, normalize absolute path, and reject equal hashes across model-input/external-validation roles. Do not reject context-only documents.

- [ ] **Step 4: Run and verify GREEN**

Run: `node scripts/testExperiment9EpochIndependence.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/experiments/externalEpochRegistry.mjs scripts/testExperiment9EpochIndependence.mjs
git commit -m "feat: audit external validation epoch independence"
```

### Task 2: Cross-Epoch Orbit Comparison

**Files:**
- Create: `scripts/experiments/crossEpochOrbitValidation.mjs`
- Create: `scripts/testExperiment9CrossEpochOrbit.mjs`

**Interfaces:**
- Produces: `compareOrbitEpochs({modelSnapshot, validationSnapshot, comparisonTime}): {rows,summary}`
- Uses NORAD IDs and TLE/SGP4 propagation from `satellite.js`.

- [ ] **Step 1: Write failing exact-orbit and perturbation tests**

```js
import assert from "node:assert/strict";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";

const identical = compareOrbitEpochs({ modelSnapshot: fixtureSnapshot(), validationSnapshot: fixtureSnapshot(), comparisonTime: fixtureEpoch });
assert.equal(identical.summary.matched_satellites, 1);
assert.ok(identical.summary.eci_position_mae_km < 1e-6);

const shifted = compareOrbitEpochs({ modelSnapshot: fixtureSnapshot(), validationSnapshot: fixtureSnapshotWithMeanAnomalyOffset(), comparisonTime: fixtureEpoch });
assert.ok(shifted.summary.along_track_mae_km > 0);
assert.ok(Number.isFinite(shifted.rows[0].radial_error_km));
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/testExperiment9CrossEpochOrbit.mjs`

Expected: missing-module failure.

- [ ] **Step 3: Implement cross-epoch propagation**

Match by NORAD ID, propagate both TLEs at the validation comparison time, calculate ECI vector difference and radial/along-track/cross-track components from validation position/velocity unit vectors, then summarize MAE/P50/P95 and element differences. Record propagation failures instead of dropping them silently.

- [ ] **Step 4: Run and verify GREEN**

Run: `node scripts/testExperiment9CrossEpochOrbit.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/experiments/crossEpochOrbitValidation.mjs scripts/testExperiment9CrossEpochOrbit.mjs
git commit -m "feat: compare public TLE snapshots across epochs"
```

### Task 3: Experiment 9 Runner And Claim-Boundary Report

**Files:**
- Create: `scripts/runExperiment9ExternalValidation.mjs`
- Create: `scripts/testExperiment9ReportBoundaries.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `runExperiment9(options)` and all Experiment 9 artifacts.
- Consumes: existing `runExternalRealismExperiment.mjs` outputs, epoch registry, cross-epoch comparison, report utilities.

- [ ] **Step 1: Write failing report-boundary test**

```js
import assert from "node:assert/strict";
import { buildExperiment9Markdown } from "./runExperiment9ExternalValidation.mjs";

const markdown = buildExperiment9Markdown(fixtureReport());
assert.match(markdown, /CPU.*内部潜变量/);
assert.match(markdown, /电量.*内部潜变量/);
assert.match(markdown, /队列.*内部潜变量/);
assert.doesNotMatch(markdown, /CPU.*运营商真值/);
assert.match(markdown, /CelesTrak/);
assert.match(markdown, /RIPE Atlas/);
assert.match(markdown, /Cloudflare Radar/);
```

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/testExperiment9ReportBoundaries.mjs`

Expected: missing-runner failure.

- [ ] **Step 3: Implement runner**

Use the July 2 model-input snapshot and fetch/build a later 72x22 validation snapshot under `reports/experiment9-multi-epoch-external-validation/input`. Never overwrite tracked snapshot caches. Run or import the existing external-realism analysis for Radar and RIPE, build the epoch registry, enforce independence, compute cross-epoch orbit metrics, and write CSV/JSON/HTML/root Markdown outputs.

If live fetch fails, allow `--validation-snapshot` and mark live evidence unavailable. If fewer than two independent TLE epochs remain, set `evidence_status=incomplete` and exit nonzero only in formal mode.

- [ ] **Step 4: Register package scripts and verify report wording**

Add:

```json
"experiment9:external-validation": "node scripts/runExperiment9ExternalValidation.mjs",
"test:experiment9:epochs": "node scripts/testExperiment9EpochIndependence.mjs",
"test:experiment9:orbit": "node scripts/testExperiment9CrossEpochOrbit.mjs",
"test:experiment9": "node scripts/testExperiment9ReportBoundaries.mjs"
```

Run all Experiment 9 tests and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/runExperiment9ExternalValidation.mjs scripts/testExperiment9ReportBoundaries.mjs package.json
git commit -m "feat: add multi-epoch external validation experiment"
```

### Task 4: Formal External Validation And Verification

**Files:**
- Generate: `reports/experiment9-multi-epoch-external-validation/*`
- Generate: `EXPERIMENT_9_EXTERNAL_VALIDATION_REPORT.md`

**Interfaces:**
- Produces final formal evidence only.

- [ ] **Step 1: Fetch a validation epoch without overwriting tracked data**

Run:

```bash
node scripts/fetchRealTleSnapshot.mjs --planes 72 --satellites-per-plane 22 --target-inclination 43 --target-altitude 490 --raw-out reports/experiment9-multi-epoch-external-validation/input/celestrak-live-raw.json --out reports/experiment9-multi-epoch-external-validation/input/celestrak-live-72x22.json
```

Expected: valid snapshot, different SHA-256 from the July 2 model-input snapshot.

- [ ] **Step 2: Run formal external validation**

Run: `npm run experiment9:external-validation`

Expected: complete evidence status, two independent TLE epochs, non-empty common NORAD matches, Radar and RIPE source-status records, and explicit latent-state boundaries.

- [ ] **Step 3: Verify project regressions**

Run: `npm run build`

Run: `npm run verify:goal`

Run: `npm run experiment1:internal-plausibility`

Expected: all PASS; the existing Experiment 1 remains unchanged.

- [ ] **Step 4: Commit formal report**

```bash
git add EXPERIMENT_9_EXTERNAL_VALIDATION_REPORT.md
git commit -m "docs: report multi-epoch external validation"
```

