# Importance-Aware Selective LEO INT Design

## Objective

Extend the existing oracle-free LEO-INT-MC pipeline so that, relative to the
current enhanced method, it reduces actual telemetry bytes while keeping global
reconstruction MAE approximately unchanged, reducing error on critical nodes,
improving anomaly recall, and bounding maximum state Age of Information (AoI).

Stage 1 remains an immutable truth-generating black box. Runtime planning may
consume only lagged Ground OAM estimates, task routes known to the controller,
and predictable orbital/contact information. Stage 1 node/link metrics remain
available only to the evaluator.

## Architecture

1. A pure importance module scores every observable node and link from lagged
   OAM confidence, AoI, rolling volatility, route workload, predictable topology
   risk, and starvation protection.
2. The module materializes explicit per-slice node/link target sets. OAM
   mandatory retests and overdue objects are hard targets; high-score objects
   are soft budgeted targets; a deterministic exploration quota prevents blind
   spots.
3. Existing topology-versioned path selection remains the base planner. Target
   coverage is added as marginal information gain, and the legacy candidate is
   retained as a conservative fallback.
4. Each selected path carries an explicit per-hop metadata mask. Important
   nodes write full node metadata, important links write full link metadata,
   unique non-target path links write lightweight link metadata, and pure
   transit/duplicate observations write no OAM metadata.
5. Probe forwarding events and OAM observations are separated. A hop that
   writes no metadata still incurs forwarding/control overhead but must not
   appear as a direct node/link observation at Ground OAM.
6. Ground OAM treats absent fields as unknown, never numeric zero. Confidence
   decay, stale carry-over, completion and next-slice feedback handle the
   resulting partial observations.

## Importance Model

For node `v` at slice `t`:

\[
S_v(t)=w_uU_v(t)+w_aA_v(t)+w_sV_v(t)+w_bB_v(t)+w_rR_v(t)+w_fF_v(t)
\]

The components are normalized to `[0,1]` without constellation-name-specific
branches:

- `U`: one minus lagged OAM confidence, plus observable model disagreement.
- `A`: state age divided by the configured maximum AoI.
- `V`: robust rolling absolute change of CPU, queue and energy estimates.
- `B`: normalized source/transit task traffic known from routed tasks.
- `R`: predictable incident-link outage/contact scarcity and power risk.
- `F`: deterministic exploration/starvation credit.

Links use the same structure with utilization/queue/status volatility and
predicted contact-transition risk replacing node-specific terms.

The selected target set is:

\[
M_t=\operatorname{TopK}(S_t)\cup M_{OAM}\cup M_{AoI}\cup M_{risk}
\]

It is recomputed from a rolling causal window. Warm-up observations bootstrap
the history but never permanently freeze the target set.

## Metadata Profiles

The implementation uses explicit field presence rather than merely lowering a
nominal byte counter:

- `node-full`: path identity, complete node state and required link state.
- `link-full`: path identity and complete selected-link state.
- `link-light`: link identity, activity/status, utilization and queue signal.
- `forward-only`: forwarding/control accounting only; no OAM observation row.

Field byte sizes are defined in telemetry configuration. Packet instruction
and target-mask bytes are counted independently, so omitted metadata cannot be
reported as free forwarding.

## Conservative Gates

- Mandatory OAM targets, topology-down masks and invalid-path handling remain
  hard constraints.
- A node or link whose AoI reaches the configured maximum becomes mandatory.
- Target-set hysteresis avoids per-slice churn.
- The first rollout keeps the selected probe paths unchanged and changes only
  metadata masks. Target-driven path reranking is enabled only after the mask
  semantics pass byte and quality tests.
- If observable confidence debt, model disagreement or maximum AoI exceeds its
  threshold, the next slice restores broader/full metadata without reading
  truth error.

## Evidence And Acceptance

The implementation must export actual, not estimated, values for metadata,
probe-base, target-mask, report/downlink, forwarding-processing and energy
overhead. It must also export direct/effective coverage, per-object AoI,
critical-object error and anomaly recall.

The short pilot gate compares the current enhanced method with the selective
method on identical Stage 1 truth and deterministic paths:

- actual telemetry bytes decrease;
- CPU, queue, energy and link-utilization global MAE do not regress by more
  than 1%;
- node-mode and link-status accuracy do not fall by more than 0.5 percentage
  points;
- critical-node aggregate MAE decreases or remains non-inferior;
- anomaly recall increases or remains non-inferior;
- maximum AoI does not exceed the configured bound;
- changing hidden Stage 1 metrics while holding OAM history fixed does not
  change targets, masks or selected paths.

## Non-Goals

- No P4/Tofino or packet-accurate physical-layer implementation.
- No replacement of the existing completion backends.
- No use of truth-derived error for runtime target selection.
- No constellation-name-specific thresholds or metric-specific result tuning.
