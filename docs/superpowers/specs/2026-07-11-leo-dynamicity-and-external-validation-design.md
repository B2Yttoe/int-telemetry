# LEO Dynamicity Causality And External Validation Design

## 1. Objective

This work adds two INFOCOM-oriented evidence chains without changing the frozen Stage-1 satellite-network model:

1. A controlled dynamicity experiment that tests whether native INT-MC degrades as LEO topology variation increases, while LEO-INT-MC remains more stable under the same telemetry budget.
2. A multi-epoch external-validation experiment that separates public observables from simulator-internal latent state and prevents the same orbital snapshot from serving as both model input and validation target.

The experiments must report negative results. They must not tune a method against current-slice truth or claim that simulated CPU, battery, or queue state is operator-internal Starlink truth.

## 2. Scope And Boundaries

### 2.1 In scope

- Three existing constellation profiles: Iridium NEXT 6x11, Telesat-1015 27x13, and Starlink 72x22.
- Forty-eight time slices per formal controlled-dynamicity run.
- Additional inter-plane stress targets of 5%, 10%, 15%, 20%, and 25%; absolute Jaccard dynamicity is measured as an outcome.
- Native INT-MC and full enhanced LEO-INT-MC under an identical fixed direct-observation budget.
- Node reconstruction, link reconstruction, path validity, reporting interruption, replanning, telemetry bytes, planning time, and completion time.
- Public CelesTrak orbital data, Cloudflare Radar traffic shape, and RIPE Atlas user-side measurements.
- Raw-source provenance, retrieval timestamp, content hash, and build/validation independence checks.

### 2.2 Out of scope

- Changing Walker/TLE propagation, link budget, energy, routing, or workload equations in Stage 1.
- Claiming packet-level or hardware-level INT fidelity.
- Claiming that latent node states are measured operator data.
- Using current hidden truth to select probes, trigger OAM feedback, or tune completion parameters.
- Adding ns-3, Hypatia, or P4/BMv2 in this iteration. These remain subsequent independent-platform extensions.

## 3. Alternatives Considered

### 3.1 Reconfigure Stage-1 physical thresholds

Changing polar latitude and inter-plane distance thresholds produces physically interpretable variation, but cannot reliably hit exact target dynamicity levels and would reopen the frozen Stage-1 model.

### 3.2 Controlled experiment-layer trace transformation

This is the selected approach. A deterministic transformer operates on exported Stage-1 truth before either telemetry method runs. It changes only eligible inter-plane links and reporting availability, preserves intra-plane links and node degree constraints, and records every mutation. Both methods consume the same transformed fingerprint.

This is a causal stress experiment, not an external-truth dataset. Its purpose is to isolate the effect of topology dynamics.

### 3.3 Select naturally dynamic windows

Selecting naturally volatile windows avoids injected changes but confounds topology variation with orbital phase, business load, and ground-station visibility. It may be used as a supplementary observational experiment, not the primary causal experiment.

## 4. Controlled Dynamicity Experiment

### 4.1 Stress dose and dynamicity definition

The controlled independent variable is the fraction of physically active inter-plane links whose experiment-controlled membership changes between consecutive slices. A fixed 25% stress pool keeps mean link density comparable across all levels. For eligible active inter-plane links \(A_t\), controlled-down sets \(M_{t-1}\) and \(M_t\), and controlled swap count \(Q_t\):

\[
R_t=\frac{|M_t\triangle M_{t-1}|}{|A_t|}\approx\frac{2Q_t}{|A_t|}.
\]

Formal churn targets are \(R\in\{0.05,0.10,0.15,0.20,0.25\}\). The cumulative achieved controlled churn rate must be within \(0.01\) of the requested rate. This distinction is necessary because a real LEO trace may already have more than 5% natural topology dynamicity; reducing it to an absolute 5% would require forcing physically unavailable links up. Holding stress-pool density fixed also prevents high-dynamicity scenarios from becoming harder merely because fewer links remain available.

For consecutive active-link sets \(E_{t-1}\) and \(E_t\), topology similarity is:

\[
J_t = \frac{|E_t \cap E_{t-1}|}{|E_t \cup E_{t-1}|}.
\]

Topology dynamicity is:

\[
D_t = 1 - J_t.
\]

Requested stress rate, achieved stress rate, and absolute Jaccard dynamicity are all reported. Error and overhead curves use achieved stress rate as the controlled x-axis and include absolute dynamicity as a secondary x-axis.

### 4.2 Deterministic mutation policy

The transformer receives a seed, target dynamicity, and per-factor weights. Candidate changes are restricted to inter-plane links. Intra-plane links are immutable. A stable hash of seed, slice, and link ID determines selection order, making every run reproducible.

Each selected inter-plane mutation must satisfy:

- no duplicate link is created;
- no node exceeds four active ISLs;
- a down link is excluded from routes and probe/report paths;
- link status, active flag, capacity, utilization, and failure reason remain internally consistent;
- every mutation records its cause and before/after state.

The transformer cumulatively calibrates controlled inter-plane swaps against the requested churn rate while holding the forced-down pool near 25% of eligible inter-plane links. It fails instead of silently accepting a churn dose outside tolerance. It never forces a physically down link up.

### 4.3 Controlled factors

Each formal dynamicity level combines five recorded factors:

1. Polar-region inter-plane disconnection ratio.
2. Inter-plane link switching ratio.
3. Topology Jaccard similarity.
4. Business-hotspot migration speed.
5. Reporting-path interruption ratio.

The combined sweep is the main experiment. One-factor-at-a-time supplementary sweeps isolate whether a result is dominated by polar disconnection, hotspot movement, or reporting interruption.

Business-hotspot migration changes task endpoint regions according to a deterministic orbit-plane/slot schedule while preserving total offered traffic. Reporting interruption marks selected reporting opportunities unavailable without changing the underlying node/link truth.

### 4.4 Fairness contract

For each constellation, seed, and dynamicity level:

- native INT-MC and LEO-INT-MC read the same Stage-1 transformed artifact fingerprint;
- both receive the same sampling rate, target active-link sampling rate, path cap, telemetry fields, and reporting budget;
- pass-1 direct observations are shared where method semantics permit;
- neither method accesses current-slice unobserved truth;
- completion evaluation reads truth only after planning, probing, reporting, and reconstruction finish;
- hyperparameter defaults are frozen before formal runs.

### 4.5 Metrics

The summary and per-slice artifacts include:

- active-link topology dynamicity and Jaccard similarity;
- polar disconnection and inter-plane switching ratios;
- hotspot migration speed;
- reporting interruption and reporting success ratios;
- selected probe paths and invalidated probe paths;
- probe-plan failure ratio;
- fresh replan, local repair, and topology-reuse counts;
- planning, telemetry, reporting, reconstruction, and total wall-clock time;
- telemetry bytes per node per slice;
- CPU, queue, and battery MAE;
- node-mode accuracy;
- link-utilization MAE and link-status accuracy;
- direct coverage and reconstruction coverage.

Method stability is measured by the slope of error against achieved dynamicity:

\[
\beta_m = \frac{\operatorname{Cov}(D,L_m)}{\operatorname{Var}(D)},
\]

where lower positive \(\beta_m\) means that method \(m\) is less sensitive to increasing dynamics. The report does not assume LEO-INT-MC has the lower slope; it computes and reports the result.

### 4.6 Artifacts

The experiment produces:

- `experiment8-dynamicity-summary.csv`
- `experiment8-dynamicity-by-slice.csv`
- `experiment8-dynamicity-mutations.csv`
- `experiment8-dynamicity-summary.json`
- `experiment8-dynamicity-manifest.json`
- `experiment8-dynamicity-report.html`
- root-level `EXPERIMENT_8_DYNAMICITY_CAUSALITY_REPORT.md`

The HTML report includes dynamicity-error curves, dynamicity-path-failure curves, dynamicity-replanning-cost curves, a fixed-budget audit, and a table of negative or non-significant results.

## 5. Multi-Epoch External Validation

### 5.1 Evidence classes

External observables and internal latent state are explicitly separated:

| Evidence | Permitted claim |
|---|---|
| CelesTrak GP/TLE | orbit elements, propagated position, shell distribution, visibility/contact geometry |
| RIPE Atlas Starlink probes | user-side RTT, packet loss, reachability magnitude |
| Cloudflare Radar AS14593 | normalized aggregate traffic-shape similarity |
| simulated CPU, battery, and queue | equation-driven latent state with internal plausibility and response consistency only |

No external score aggregates latent-state plausibility into a claim of operator truth.

### 5.2 Epoch registry and provenance

Every external source entry contains:

- source name and exact URL;
- retrieval timestamp in UTC;
- observation/epoch interval;
- local immutable raw path;
- SHA-256 hash;
- record count;
- parser version;
- source role: `model-input`, `external-validation`, or `context-only`.

The registry rejects a comparison when the model-input and validation artifacts have the same content hash. It also reports the elapsed time between epochs.

### 5.3 Orbital cross-epoch comparison

For satellites matched by NORAD ID, the model-input epoch is propagated to the validation epoch. The propagated state is compared with the later public GP/TLE-derived state using:

- altitude absolute error;
- inclination, RAAN, eccentricity, and mean-motion differences;
- three-dimensional ECI position error;
- along-track, cross-track, and radial position errors;
- shell membership retention;
- predicted-versus-observed contact-state agreement where common pairs are available.

The report must disclose that TLE/SGP4 cross-epoch error includes both propagation error and catalog updates. It is validation of public-orbit consistency, not precise orbit-determination accuracy.

### 5.4 Traffic and network comparison

Cloudflare Radar and model traffic are aligned only after recording their time windows. Comparisons use normalized shape metrics: Pearson correlation, Spearman correlation, normalized MAE, peak-time displacement, and short-period variability. Aggregate Radar traffic is not interpreted as a per-satellite flow trace.

RIPE Atlas comparison uses model user-to-satellite-to-gateway RTT, not internal task-routing delay. It reports P50, P95, mean, packet-loss ratio, sample count, probe count, region coverage, and the ratio between model and public RTT.

### 5.5 Artifacts

The enhanced external-validation run produces:

- `external-epoch-registry.csv`
- `external-independence-audit.json`
- `orbit-cross-epoch-comparison.csv`
- `orbit-cross-epoch-summary.json`
- `traffic-external-comparison.csv`
- `network-performance-external-comparison.csv`
- `external-validation-report.html`
- root-level `EXPERIMENT_9_EXTERNAL_VALIDATION_REPORT.md`

When only one independent epoch is available, the experiment exits with an explicit incomplete-evidence status instead of describing the result as multi-epoch validation.

## 6. Architecture

The implementation adds experiment-only modules:

- a dynamicity trace transformer and metric calculator;
- an Experiment 8 runner built on the shared INT-MC experiment core;
- an external epoch registry and independence auditor;
- an Experiment 9 runner that reuses existing external-realism parsers where possible;
- report writers and tests for both experiments.

The Stage-1 simulator and Stage-2 reconstruction algorithms remain unchanged unless a test exposes an existing violation of the fairness or provenance contract. Any such defect requires a separate regression test before correction.

## 7. Error Handling

Formal runs fail when:

- achieved controlled churn rate is outside tolerance;
- transformed links violate degree or intra-plane stability constraints;
- compared methods have different input fingerprints or telemetry budgets;
- current hidden truth appears in planner inputs;
- a model-input artifact is reused as external validation data;
- an external artifact lacks retrieval time, source URL, or SHA-256 hash;
- a report labels CPU, battery, or queue as externally observed truth.

Unavailable network sources produce a source-status artifact and an incomplete-evidence result. They do not silently fall back to a local calibration template as external truth.

## 8. Test Strategy

Tests are written before production code and cover:

1. Dynamicity calculation for known edge sets.
2. Deterministic mutation under a fixed seed.
3. Target-tolerance calibration.
4. Intra-plane stability and four-link degree limits.
5. Fixed-budget and shared-input fairness.
6. No-truth planner boundary reuse from Experiment 7.
7. Path invalidation and replanning accounting.
8. Epoch-role and SHA-256 independence rejection.
9. Cross-epoch NORAD matching and position-error decomposition.
10. Report language separating external observables from latent state.
11. Smoke runs for all three constellations.
12. Build and end-to-end goal verification after both experiments.

## 9. Acceptance Criteria

- Five requested inter-plane churn levels are represented for all three constellations and both methods.
- Achieved cumulative controlled churn rate is within 0.01 of each target; mean forced-down density and actual Jaccard dynamicity are reported separately.
- Fixed-budget and shared-input audits pass for every pair.
- Per-slice path failure and replanning data are non-empty.
- Node and link reconstruction metrics are present for every method-level combination.
- At least two independent public TLE epochs are registered and have different hashes.
- External validation reports orbital, traffic-shape, and user-RTT evidence separately.
- CPU, battery, and queue are explicitly labeled as simulator-internal latent state.
- All new tests, the existing related test suite, `npm run build`, and `npm run verify:goal` pass.
