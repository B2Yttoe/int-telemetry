import assert from "node:assert/strict";
import { buildImportanceAwareTargetPlan } from "../stage2-int/tools/importance-aware-telemetry.mjs";

function nodeRow({ slice, sourceSlice, id, plane, cpu, queue, energy, confidence, age, mode = "normal" }) {
  return {
    slice_index: slice,
    planner_state_source_slice_index: sourceSlice,
    node_id: id,
    plane,
    cpu_percent: cpu,
    queue_depth: queue,
    energy_percent: energy,
    planner_state_confidence: confidence,
    state_age_slices: age,
    mode,
  };
}

function linkRow({ slice, sourceSlice, id, source, target, utilization, confidence, age, availability = 1 }) {
  return {
    slice_index: slice,
    planner_state_source_slice_index: sourceSlice,
    link_id: id,
    source,
    target,
    utilization_percent: utilization,
    queue_latency_ms: utilization / 5,
    status: "up",
    is_active: true,
    p_available: availability,
    planner_state_confidence: confidence,
    state_age_slices: age,
  };
}

const causalNodes = [
  nodeRow({ slice: 1, sourceSlice: 0, id: "P01-S01", plane: 1, cpu: 10, queue: 2, energy: 92, confidence: 0.95, age: 0 }),
  nodeRow({ slice: 2, sourceSlice: 1, id: "P01-S01", plane: 1, cpu: 11, queue: 2, energy: 91, confidence: 0.95, age: 0 }),
  nodeRow({ slice: 3, sourceSlice: 2, id: "P01-S01", plane: 1, cpu: 10, queue: 2, energy: 90, confidence: 0.95, age: 0 }),

  nodeRow({ slice: 1, sourceSlice: 0, id: "P01-S02", plane: 1, cpu: 12, queue: 2, energy: 90, confidence: 0.72, age: 1 }),
  nodeRow({ slice: 2, sourceSlice: 1, id: "P01-S02", plane: 1, cpu: 88, queue: 72, energy: 84, confidence: 0.58, age: 1 }),
  nodeRow({ slice: 3, sourceSlice: 2, id: "P01-S02", plane: 1, cpu: 18, queue: 8, energy: 80, confidence: 0.55, age: 1 }),

  nodeRow({ slice: 1, sourceSlice: 0, id: "P02-S01", plane: 2, cpu: 20, queue: 4, energy: 72, confidence: 0.5, age: 2 }),
  nodeRow({ slice: 2, sourceSlice: 1, id: "P02-S01", plane: 2, cpu: 21, queue: 5, energy: 70, confidence: 0.35, age: 3 }),
  nodeRow({ slice: 3, sourceSlice: 2, id: "P02-S01", plane: 2, cpu: 22, queue: 5, energy: 68, confidence: 0.2, age: 6 }),

  nodeRow({ slice: 1, sourceSlice: 0, id: "P03-S01", plane: 3, cpu: 8, queue: 1, energy: 95, confidence: 0.92, age: 0 }),
  nodeRow({ slice: 2, sourceSlice: 1, id: "P03-S01", plane: 3, cpu: 8, queue: 1, energy: 94, confidence: 0.92, age: 1 }),
  nodeRow({ slice: 3, sourceSlice: 2, id: "P03-S01", plane: 3, cpu: 9, queue: 1, energy: 93, confidence: 0.9, age: 2 }),
];

const causalLinks = [
  linkRow({ slice: 1, sourceSlice: 0, id: "L-stable", source: "P01-S01", target: "P01-S02", utilization: 10, confidence: 0.95, age: 0 }),
  linkRow({ slice: 2, sourceSlice: 1, id: "L-stable", source: "P01-S01", target: "P01-S02", utilization: 11, confidence: 0.95, age: 0 }),
  linkRow({ slice: 3, sourceSlice: 2, id: "L-stable", source: "P01-S01", target: "P01-S02", utilization: 10, confidence: 0.95, age: 0 }),
  linkRow({ slice: 1, sourceSlice: 0, id: "L-risk", source: "P02-S01", target: "P03-S01", utilization: 25, confidence: 0.6, age: 2, availability: 0.6 }),
  linkRow({ slice: 2, sourceSlice: 1, id: "L-risk", source: "P02-S01", target: "P03-S01", utilization: 70, confidence: 0.4, age: 3, availability: 0.3 }),
  linkRow({ slice: 3, sourceSlice: 2, id: "L-risk", source: "P02-S01", target: "P03-S01", utilization: 35, confidence: 0.2, age: 6, availability: 0.1 }),
];

const routes = [{
  slice_index: 3,
  source_slice_index: 2,
  task_id: "TASK-01",
  path: "P01-S02 > P02-S01 > P03-S01",
  link_ids: "L-stable > L-risk",
  traffic_mbps: 200,
}];

const options = {
  windowSize: 3,
  nodeTargetRatio: 0.75,
  linkTargetRatio: 0.5,
  maxAoISlices: 4,
  explorationRatio: 0.25,
  minimumScore: 0.05,
};

const baseline = buildImportanceAwareTargetPlan({
  slices: [3],
  nodes: causalNodes,
  links: causalLinks,
  routes,
  options,
});

const withHiddenCurrentStateChanged = buildImportanceAwareTargetPlan({
  slices: [3],
  nodes: [
    ...causalNodes,
    nodeRow({ slice: 3, sourceSlice: 3, id: "P01-S01", plane: 1, cpu: 100, queue: 100, energy: 1, confidence: 0.01, age: 99, mode: "warning" }),
  ],
  links: [
    ...causalLinks,
    linkRow({ slice: 3, sourceSlice: 3, id: "L-stable", source: "P01-S01", target: "P01-S02", utilization: 100, confidence: 0.01, age: 99, availability: 0 }),
  ],
  routes,
  options,
});

const canonical = (plan) => plan.rows.map((row) => ({
  slice_index: row.slice_index,
  target_type: row.target_type,
  target_id: row.target_id,
  target_class: row.target_class,
  mandatory: row.mandatory,
  importance_score: row.importance_score,
}));

assert.deepEqual(
  canonical(withHiddenCurrentStateChanged),
  canonical(baseline),
  "targets must be invariant to current hidden state when causal OAM history is unchanged",
);
assert.ok(
  baseline.rows.every((row) => Number(row.source_slice_index) < Number(row.slice_index)),
  "every target must be based on an earlier observable slice",
);

const nodeTargets = new Map(
  baseline.rows.filter((row) => row.target_type === "node").map((row) => [row.target_id, row]),
);
assert.equal(nodeTargets.get("P02-S01")?.mandatory, true, "AoI-overdue node should be mandatory");
assert.match(nodeTargets.get("P02-S01")?.reason ?? "", /aoi-overdue/, "mandatory node should explain its AoI reason");
assert.ok(nodeTargets.has("P01-S02"), "volatile low-confidence node should be selected");
assert.equal(nodeTargets.get("P03-S01")?.target_class, "exploration", "an uncovered plane should receive an exploration target");
assert.ok(!nodeTargets.has("P01-S01"), "stable redundant node should not displace higher-value targets");

const linkTargets = new Map(
  baseline.rows.filter((row) => row.target_type === "link").map((row) => [row.target_id, row]),
);
assert.equal(linkTargets.get("L-risk")?.mandatory, true, "low-availability AoI-overdue link should be mandatory");
assert.ok(!linkTargets.has("L-stable"), "stable link should not displace the risky link");

const inferredWithoutDirectHistory = buildImportanceAwareTargetPlan({
  slices: [5],
  nodes: [{
    slice_index: 5,
    planner_state_source_slice_index: 4,
    node_id: "P04-S01",
    plane: 4,
    planner_state_confidence: 0.4,
    state_age_slices: "",
    last_observed_slice: "",
    oam_observation_source: "inferred",
  }],
  links: [],
  routes: [],
  options: { ...options, nodeTargetRatio: 1, maxAoISlices: 6 },
});
assert.equal(
  inferredWithoutDirectHistory.rows[0]?.age_score,
  1,
  "a completion-only estimate must not reset AoI; never-observed age grows from the run start",
);
assert.equal(inferredWithoutDirectHistory.rows[0]?.state_age_slices, 6);
assert.equal(inferredWithoutDirectHistory.rows[0]?.aoi_debt_severity, 1);
assert.equal(
  inferredWithoutDirectHistory.rows[0]?.mandatory,
  false,
  "never-observed targets stay priority-ranked instead of exploding the mandatory budget",
);

const fairRefreshNodes = [];
for (let slice = 0; slice < 6; slice += 1) {
  for (let nodeIndex = 0; nodeIndex < 12; nodeIndex += 1) {
    fairRefreshNodes.push({
      slice_index: slice,
      planner_state_source_slice_index: slice - 1,
      node_id: `P01-S${String(nodeIndex + 1).padStart(2, "0")}`,
      plane: 0,
      slot: nodeIndex,
      planner_state_confidence: 0.8,
      oam_observation_source: "inferred",
      cpu_percent: 10,
      queue_depth: 1,
      energy_percent: 90,
    });
  }
}
const fairRefreshPlan = buildImportanceAwareTargetPlan({
  slices: [0, 1, 2, 3, 4, 5],
  nodes: fairRefreshNodes,
  links: [],
  routes: [],
  options: {
    ...options,
    nodeTargetRatio: 0.25,
    maxAoISlices: 6,
    explorationRatio: 0,
    minimumScore: 0.95,
  },
});
const fairRefreshTargetsBySlice = [0, 1, 2, 3, 4, 5].map((slice) =>
  fairRefreshPlan.rows.filter((row) => row.slice_index === slice && row.target_type === "node")
);
assert.ok(
  fairRefreshTargetsBySlice.every((targets) => targets.length <= 3),
  "deadline protection must remain inside the configured per-slice target quota",
);
assert.ok(
  fairRefreshTargetsBySlice.every((targets) => new Set(targets.map((row) => row.target_id)).size === targets.length),
  "a refresh target must not consume the same slice quota twice",
);
assert.equal(
  new Set(fairRefreshTargetsBySlice.flat().map((row) => row.target_id)).size,
  12,
  "cyclic pre-deadline refresh must nominate every equally uncertain node within one AoI window",
);
assert.ok(
  fairRefreshTargetsBySlice.every((targets) => targets.some((row) => row.refresh_due)),
  "every slice should reserve target capacity for its deterministic refresh cohort",
);

const orbitGroupedRefreshPlan = buildImportanceAwareTargetPlan({
  slices: [0],
  nodes: [
    { slice_index: 0, planner_state_source_slice_index: -1, node_id: "P01-S01", plane: 0, slot: 0, planner_state_confidence: 0.8, oam_observation_source: "inferred" },
    { slice_index: 0, planner_state_source_slice_index: -1, node_id: "P02-S01", plane: 1, slot: 0, planner_state_confidence: 0.8, oam_observation_source: "inferred" },
    { slice_index: 0, planner_state_source_slice_index: -1, node_id: "P01-S02", plane: 0, slot: 1, planner_state_confidence: 0.8, oam_observation_source: "inferred" },
    { slice_index: 0, planner_state_source_slice_index: -1, node_id: "P02-S02", plane: 1, slot: 1, planner_state_confidence: 0.8, oam_observation_source: "inferred" },
  ],
  links: [],
  routes: [],
  options: { ...options, nodeTargetRatio: 1, maxAoISlices: 6, explorationRatio: 0 },
});
const refreshBucketByNode = new Map(
  orbitGroupedRefreshPlan.rows.map((row) => [row.target_id, row.refresh_bucket]),
);
assert.equal(
  refreshBucketByNode.get("P01-S01"),
  refreshBucketByNode.get("P02-S01"),
  "nodes in the same orbital slot should share a refresh cohort so one cross-plane path can cover them",
);

const criticalityPlan = buildImportanceAwareTargetPlan({
  slices: [2],
  nodes: [
    nodeRow({ slice: 2, sourceSlice: 1, id: "P01-S01", plane: 1, cpu: 10, queue: 2, energy: 90, confidence: 0.9, age: 0 }),
    nodeRow({ slice: 2, sourceSlice: 1, id: "P01-S99", plane: 1, cpu: 92, queue: 84, energy: 90, confidence: 0.9, age: 0 }),
  ],
  links: [
    linkRow({ slice: 2, sourceSlice: 1, id: "L-low", source: "P01-S01", target: "P01-S02", utilization: 8, confidence: 0.9, age: 0 }),
    linkRow({ slice: 2, sourceSlice: 1, id: "L-high", source: "P01-S99", target: "P01-S98", utilization: 94, confidence: 0.9, age: 0 }),
  ],
  routes: [],
  options: {
    ...options,
    nodeTargetRatio: 0.5,
    linkTargetRatio: 0.5,
    explorationRatio: 0,
    minimumScore: 0,
  },
});
assert.equal(
  criticalityPlan.rows.find((row) => row.target_type === "node")?.target_id,
  "P01-S99",
  "a causally observed high-load node must outrank an equally fresh and equally confident idle node",
);
assert.equal(
  criticalityPlan.rows.find((row) => row.target_type === "link")?.target_id,
  "L-high",
  "a causally observed high-utilization link must outrank an equally fresh and equally confident idle link",
);
assert.ok(
  Number(criticalityPlan.rows.find((row) => row.target_id === "P01-S99")?.criticality_score) >= 0.8,
  "the target plan must expose the causal state-criticality component",
);

console.log(JSON.stringify({
  ok: true,
  target_count: baseline.rows.length,
  node_targets: [...nodeTargets.keys()],
  link_targets: [...linkTargets.keys()],
  causal_rejections: baseline.summary.rejected_noncausal_rows,
}, null, 2));
