import assert from "node:assert/strict";
import {
  REPORTING_INTERRUPTION_RATES,
  buildReportingSensitivityHtml,
  buildReportingSensitivityMatrix,
} from "./runExperiment8ReportingInterruptionSensitivity.mjs";

const matrix = buildReportingSensitivityMatrix({
  profileIds: ["small", "medium", "large"],
  methodIds: ["native", "enhanced"],
  rates: REPORTING_INTERRUPTION_RATES,
});
assert.equal(matrix.length, 30);
assert.deepEqual([...new Set(matrix.map((row) => row.reporting_interruption_rate))], [0, 0.05, 0.1, 0.15, 0.2]);

const html = buildReportingSensitivityHtml({
  rows: matrix.map((row) => ({
    ...row,
    constellation_label: row.profile_id,
    method_label: row.method_id,
    achieved_reporting_interruption_rate: row.reporting_interruption_rate,
    delivery_ratio: 1 - row.reporting_interruption_rate,
    cpu_mae: 1,
    queue_depth_mae: 2,
    energy_percent_mae: 3,
    link_utilization_mae: 4,
    link_status_accuracy: 0.9,
    selected_paths: 10,
    telemetry_bytes_per_node_slice: 100,
  })),
  parameters: { topology_stress_rate: 0.25 },
});
assert.match(html, /reporting path 中断率/);
assert.match(html, /固定 25% 拓扑扰动/);
assert.match(html, /交付率/);
assert.match(html, /链路利用率 MAE/);
assert.match(html, /固定采样预算/);

console.log("Experiment 8 reporting sensitivity tests passed.");
