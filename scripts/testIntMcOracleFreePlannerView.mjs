import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildObservablePlanningLinks,
  buildObservablePlanningNodes,
  buildObservableOamFeedback,
  buildObservableRoutes,
} from "../stage2-int/tools/int-mc-observability.mjs";

const predictedPlan = {
  entries: [
    {
      slice_index: 0,
      time: "2026-07-10T00:00:00.000Z",
      link_id: "inter-plane:P01-S01->P02-S01",
      source: "P01-S01",
      target: "P02-S01",
      kind: "inter-plane",
      predicted_active: true,
      p_available: 0.94,
      confidence: 0.88,
      distance_km: 2100,
      capacity_mbps: 4200,
      sinr_db: 12.5,
      availability_factor: 0.94,
      line_of_sight: true,
    },
  ],
};

function truthFixture({ utilization, congestion, cpu, queue, energy, queueDelay }) {
  return {
    links: [
      {
        ...predictedPlan.entries[0],
        is_active: true,
        status: congestion > 0 ? "warning" : "up",
        utilization_percent: utilization,
        congestion_percent: congestion,
        queue_latency_ms: queueDelay,
        dropped_traffic_mb: congestion,
        packet_error_rate: congestion / 1000,
      },
    ],
    nodes: [
      {
        slice_index: 0,
        time: "2026-07-10T00:00:00.000Z",
        node_id: "P01-S01",
        plane: 0,
        slot: 0,
        latitude: 12,
        longitude: 34,
        altitude_km: 550,
        in_sunlight: true,
        solar_exposure: 0.8,
        battery_capacity_wh: 1200,
        cpu_percent: cpu,
        queue_depth: queue,
        queued_traffic_mb: queue * 2,
        energy_percent: energy,
        mode: cpu > 80 ? "busy" : "nominal",
        net_power_w: energy > 50 ? 140 : -240,
      },
    ],
    routes: [
      {
        slice_index: 0,
        task_id: "TASK-001",
        source: "P01-S01",
        target: "P02-S01",
        link_ids: "inter-plane:P01-S01->P02-S01",
        status: "routed",
        traffic_mbps: 120,
        queue_delay_ms: queueDelay,
        carried_traffic_mbps: utilization * 10,
      },
    ],
  };
}

const lowTruth = truthFixture({ utilization: 8, congestion: 0, cpu: 2, queue: 0, energy: 96, queueDelay: 1 });
const highTruth = truthFixture({ utilization: 97, congestion: 88, cpu: 99, queue: 100, energy: 4, queueDelay: 9000 });
const oamLinks = [
  {
    slice_index: 0,
    link_id: "inter-plane:P01-S01->P02-S01",
    observation_source: "inferred",
    status_estimate: "up",
    utilization_percent_estimate: 43,
    congestion_percent_estimate: 7,
    queue_latency_ms_estimate: 12,
    confidence: 0.61,
    state_age_slices: 3,
    confidence_state: "stale",
    conflict_severity: 0.17,
  },
];
const oamNodes = [
  {
    slice_index: 0,
    node_id: "P01-S01",
    observation_source: "inferred",
    mode_estimate: "nominal",
    cpu_percent_estimate: 31,
    queue_depth_estimate: 5,
    queued_traffic_mb_estimate: 9,
    energy_percent_estimate: 72,
    confidence: 0.58,
    state_age_slices: 2,
    confidence_state: "inferred",
    conflict_severity: 0.11,
  },
];

function observable(fixture) {
  return {
    links: buildObservablePlanningLinks({
      truthLinks: fixture.links,
      predictedPlan,
      oamLinks,
      mode: "oam-only",
    }),
    nodes: buildObservablePlanningNodes({
      truthNodes: fixture.nodes,
      oamNodes,
      mode: "oam-only",
    }),
    routes: buildObservableRoutes({ routes: fixture.routes, mode: "oam-only" }),
  };
}

const lowObservable = observable(lowTruth);
const highObservable = observable(highTruth);
assert.deepEqual(
  highObservable,
  lowObservable,
  "oam-only planner view must be invariant to hidden Stage 1 metric changes",
);

const experimentRunnerSource = await readFile("stage2-int/tools/run-int-experiment.mjs", "utf8");
assert.ok(
  experimentRunnerSource.includes('argValue(args, "--int-mc-observability-mode", "oam-only")'),
  "the public INT experiment entry point must default to the deployable OAM-only planner view",
);
assert.ok(
  experimentRunnerSource.includes('"--observability-mode",\n          intMcObservabilityMode'),
  "the public INT experiment entry point must propagate observability mode to the selector",
);

const link = lowObservable.links[0];
assert.equal(link.utilization_percent, 43);
assert.equal(link.congestion_percent, 7);
assert.equal(link.planner_state_source, "ground-oam");
assert.equal(link.state_age_slices, 3);
assert.equal(link.confidence_state, "stale");
assert.equal(link.conflict_severity, 0.17);
assert.equal(link.truth_utilization_percent, undefined);

const node = lowObservable.nodes[0];
assert.equal(node.cpu_percent, 31);
assert.equal(node.queue_depth, 5);
assert.equal(node.energy_percent, 72);
assert.equal(node.net_power_w, undefined);
assert.equal(node.planner_state_source, "ground-oam");
assert.equal(node.state_age_slices, 2);
assert.equal(node.confidence_state, "inferred");
assert.equal(node.conflict_severity, 0.11);

const route = lowObservable.routes[0];
assert.equal(route.traffic_mbps, 120);
assert.equal(route.queue_delay_ms, undefined);
assert.equal(route.carried_traffic_mbps, undefined);

const observableFeedback = buildObservableOamFeedback({
  mode: "oam-only",
  rows: [
    {
      slice_index: 1,
      target_type: "link",
      target_id: "safe-link",
      priority_score: 0.7,
      feedback_source: "int-mc-deployable",
      feedback_basis: "observable-uncertainty",
      completion_error_score: "",
      reason: "low-completion-confidence",
    },
    {
      slice_index: 1,
      target_type: "link",
      target_id: "oracle-link",
      priority_score: 1,
      feedback_source: "int-mc-completion",
      completion_error_score: 0.99,
      reason: "high-simulation-validation-error",
    },
  ],
});
assert.deepEqual(
  observableFeedback.map((row) => row.target_id),
  ["safe-link"],
  "oam-only planner must reject legacy truth-error feedback rows",
);

console.log(JSON.stringify({
  ok: true,
  observable_link_fields: Object.keys(link).length,
  observable_node_fields: Object.keys(node).length,
  route_fields: Object.keys(route).length,
}, null, 2));
