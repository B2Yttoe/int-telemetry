import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const reports = [
  {
    id: 4,
    root: "EXPERIMENT_4_ABLATION_REPORT.md",
    artifacts: [
      "reports/experiment4-leo-int-mc-ablation/experiment4-ablation-report.html",
      "reports/experiment4-leo-int-mc-ablation/experiment4-ablation-summary.csv",
      "reports/experiment4-leo-int-mc-ablation/experiment4-ablation-summary.json",
      "reports/experiment4-leo-int-mc-ablation/experiment4-manifest.json",
    ],
  },
  {
    id: 5,
    root: "EXPERIMENT_5_OVERHEAD_REPORT.md",
    artifacts: [
      "reports/experiment5-overhead-decomposition/experiment5-overhead-report.html",
      "reports/experiment5-overhead-decomposition/experiment5-overhead-summary.csv",
      "reports/experiment5-overhead-decomposition/experiment5-overhead-summary.json",
      "reports/experiment5-overhead-decomposition/experiment5-manifest.json",
    ],
  },
  {
    id: 6,
    root: "EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md",
    artifacts: [
      "reports/experiment6-sampling-sensitivity/experiment6-sampling-report.html",
      "reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.csv",
      "reports/experiment6-sampling-sensitivity/experiment6-sampling-summary.json",
      "reports/experiment6-sampling-sensitivity/experiment6-manifest.json",
    ],
  },
  {
    id: 7,
    root: "EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md",
    artifacts: [
      "reports/experiment7-no-truth-leakage/experiment7-report.html",
      "reports/experiment7-no-truth-leakage/experiment7-checks.csv",
      "reports/experiment7-no-truth-leakage/experiment7-summary.json",
      "reports/experiment7-no-truth-leakage/experiment7-manifest.json",
    ],
  },
];

for (const report of reports) {
  assert.ok(existsSync(resolve(report.root)), `Experiment ${report.id} root report must exist`);
  const markdown = await readFile(resolve(report.root), "utf8");
  for (const heading of ["实验做了什么", "实验结果", "证明了什么", "不能证明什么", "产物索引"]) {
    assert.match(markdown, new RegExp(heading), `Experiment ${report.id} must contain ${heading}`);
  }
  for (const artifact of report.artifacts) {
    assert.ok(existsSync(resolve(artifact)), `Experiment ${report.id} artifact must exist: ${artifact}`);
    assert.ok(markdown.includes(artifact), `Experiment ${report.id} root report must link ${artifact}`);
  }
}

console.log(JSON.stringify({ ok: true, reports: reports.length, linked_artifacts: reports.length * 4 }, null, 2));
