import assert from "node:assert/strict";
import { selectBudgetAdmittedProbeIds } from "../stage2-int/tools/telemetry-byte-budget.mjs";

const probes = [
  { probe_id: "P0-A", slice_index: 0 },
  { probe_id: "P0-B", slice_index: 0 },
  { probe_id: "P1-A", slice_index: 1 },
];
const hopRecords = [
  { probe_id: "P0-A", slice_index: 0, hop_metadata_bytes: 10 },
  { probe_id: "P0-A", slice_index: 0, hop_metadata_bytes: 10 },
  { probe_id: "P0-B", slice_index: 0, hop_metadata_bytes: 20 },
  { probe_id: "P1-A", slice_index: 1, hop_metadata_bytes: 10 },
];
const reports = [
  { probe_id: "P0-A", slice_index: 0, report_size_bytes: 30 },
  { probe_id: "P0-B", slice_index: 0, report_size_bytes: 20 },
  { probe_id: "P1-A", slice_index: 1, report_size_bytes: 20 },
];

const disabled = selectBudgetAdmittedProbeIds({
  probes,
  hopRecords,
  reports,
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: 0,
});
assert.deepEqual([...disabled.admittedProbeIds], ["P0-A", "P0-B", "P1-A"]);
assert.equal(disabled.rejectedProbeIds.size, 0);
assert.equal(disabled.enabled, false);

const exactBoundary = selectBudgetAdmittedProbeIds({
  probes,
  hopRecords,
  reports,
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: 110,
});
assert.deepEqual([...exactBoundary.admittedProbeIds], ["P0-A", "P0-B", "P1-A"]);
assert.equal(exactBoundary.bySlice.find((row) => row.slice_index === 0).actual_bytes, 110);
assert.equal(exactBoundary.bySlice.find((row) => row.slice_index === 0).budget_utilization, 1);

const limited = selectBudgetAdmittedProbeIds({
  probes,
  hopRecords,
  reports,
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: 100,
});
assert.deepEqual([...limited.admittedProbeIds], ["P0-A", "P1-A"]);
assert.deepEqual([...limited.rejectedProbeIds], ["P0-B"]);
assert.deepEqual(limited.decisions.map((row) => [row.probe_id, row.decision, row.probe_generated_bytes]), [
  ["P0-A", "admitted", 60],
  ["P0-B", "rejected-prefix-budget", 50],
  ["P1-A", "admitted", 40],
]);
assert.deepEqual(limited.bySlice.map((row) => [row.slice_index, row.actual_bytes, row.rejected_probes]), [
  [0, 60, 1],
  [1, 40, 0],
]);
assert.equal(limited.capViolations, 0);

const rejectedPrefix = selectBudgetAdmittedProbeIds({
  probes,
  hopRecords,
  reports,
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: 55,
});
assert.deepEqual([...rejectedPrefix.admittedProbeIds], ["P1-A"]);
assert.deepEqual([...rejectedPrefix.rejectedProbeIds], ["P0-A", "P0-B"]);
assert.equal(
  rejectedPrefix.decisions.find((row) => row.probe_id === "P0-B").decision,
  "rejected-after-prefix-closed",
);

const perSliceBudgets = selectBudgetAdmittedProbeIds({
  probes,
  hopRecords,
  reports,
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: new Map([[0, 110], [1, 30]]),
});
assert.deepEqual([...perSliceBudgets.admittedProbeIds], ["P0-A", "P0-B"]);
assert.deepEqual([...perSliceBudgets.rejectedProbeIds], ["P1-A"]);
assert.deepEqual(perSliceBudgets.bySlice.map((row) => [row.slice_index, row.budget_bytes]), [[0, 110], [1, 30]]);

const targetMaskBoundary = selectBudgetAdmittedProbeIds({
  probes: [{ probe_id: "P-mask", slice_index: 0, target_mask_bytes: 5 }],
  hopRecords: [{ probe_id: "P-mask", slice_index: 0, hop_metadata_bytes: 10 }],
  reports: [{ probe_id: "P-mask", slice_index: 0, report_size_bytes: 20 }],
  probePacketBaseBytes: 10,
  perSliceBudgetBytes: 44,
});
assert.deepEqual([...targetMaskBoundary.rejectedProbeIds], ["P-mask"], "target-mask bytes must consume the real telemetry budget");
assert.equal(targetMaskBoundary.decisions[0].probe_generated_bytes, 45);

console.log("Telemetry byte budget tests passed.");
