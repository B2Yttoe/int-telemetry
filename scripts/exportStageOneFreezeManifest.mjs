import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function artifactStatus(path) {
  try {
    const file = await stat(path);
    return {
      path,
      exists: true,
      bytes: file.size,
      updated_at: file.mtime.toISOString(),
    };
  } catch {
    return {
      path,
      exists: false,
      bytes: 0,
      updated_at: "",
    };
  }
}

function allTrue(value) {
  if (!value || typeof value !== "object") return Boolean(value);
  return Object.values(value).every((entry) => (typeof entry === "object" ? allTrue(entry) : Boolean(entry)));
}

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function manifestMarkdown(manifest) {
  const lines = [
    "# 第一阶段可复现实验冻结清单",
    "",
    `生成时间：${manifest.generated_at}`,
    "",
    `总体结论：${manifest.overall_ready ? "可作为第二阶段 INT 对照底座" : "尚不建议冻结为对照底座"}`,
    "",
    `配置指纹：${manifest.fingerprints.config}`,
    "",
    `标准上传数据集指纹：${manifest.fingerprints.standard_uploaded_dataset}`,
    "",
    `标准上传真值指纹：${manifest.fingerprints.standard_uploaded_truth}`,
    "",
    `成熟度得分：${manifest.assessment.score}/${manifest.assessment.max_score}`,
    "",
    "## 冻结检查",
    "",
    markdownTableRow(["检查项", "结果"]),
    markdownTableRow(["---", "---"]),
    ...Object.entries(manifest.freeze_checks).map(([name, passed]) =>
      markdownTableRow([name, passed ? "通过" : "未通过"]),
    ),
    "",
    "## 场景指纹",
    "",
    markdownTableRow(["场景", "数据集指纹", "真值指纹"]),
    markdownTableRow(["---", "---", "---"]),
    ...manifest.scenario_fingerprints.map((scenario) =>
      markdownTableRow([scenario.profile, scenario.dataset_fingerprint, scenario.truth_fingerprint]),
    ),
    "",
    "## 关键命令",
    "",
    ...manifest.reproduce_commands.map((command) => `- \`${command}\``),
    "",
    "## 关键产物",
    "",
    markdownTableRow(["路径", "存在", "字节"]),
    markdownTableRow(["---", "---", "---"]),
    ...manifest.artifacts.map((artifact) =>
      markdownTableRow([artifact.path, artifact.exists ? "是" : "否", String(artifact.bytes)]),
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const manifestJsonPath = `${reportDir}/stage1-freeze-manifest.json`;
const manifestMdPath = `${reportDir}/stage1-freeze-manifest.md`;

const packageJson = await readJson("package.json");
const acceptance = await readJson(`${reportDir}/stage1-acceptance.json`);
const assessment = await readJson(`${reportDir}/stage1-model-assessment.json`);
const baseline = await readJson(`${reportDir}/stage1-parameter-baseline.json`);
const scenarioMatrix = await readJson(`${reportDir}/stage1-scenario-matrix.json`);
const businessTrace = await readJson(`${reportDir}/stage1-business-trace.json`);

const requiredArtifacts = [
  `${reportDir}/stage1-acceptance.json`,
  `${reportDir}/stage1-acceptance.md`,
  `${reportDir}/stage1-model-assessment.json`,
  `${reportDir}/stage1-model-assessment.md`,
  `${reportDir}/stage1-parameter-baseline.json`,
  `${reportDir}/stage1-parameter-baseline.md`,
  `${reportDir}/stage1-scenario-matrix.json`,
  `${reportDir}/stage1-scenario-matrix.csv`,
  `${reportDir}/stage1-scenario-matrix.md`,
  `${reportDir}/stage1-business-trace.json`,
  `${reportDir}/stage1-business-task-trace.csv`,
  `${reportDir}/stage1-business-link-impact.csv`,
  `${reportDir}/stage1-business-node-impact.csv`,
  `${reportDir}/stage1-dashboard-audit.json`,
  `${reportDir}/stage1-dashboard-audit.md`,
  "schemas/task-dataset-file.schema.json",
  "schemas/task-dataset.schema.json",
  "examples/datasets/stage1-standard-traffic.csv",
  "examples/datasets/stage1-standard-traffic.json",
  "examples/datasets/templates/manifest.json",
];

const artifacts = await Promise.all(requiredArtifacts.map((path) => artifactStatus(path)));
const scenarioFingerprints = scenarioMatrix.scenarios.map((scenario) => ({
  profile: scenario.profile,
  dataset_name: scenario.dataset_name,
  dataset_fingerprint: scenario.metadata.dataset_fingerprint,
  truth_fingerprint: scenario.metadata.truth_fingerprint,
}));
const uploadedScenario = scenarioMatrix.scenarios.find((scenario) => scenario.profile === "uploaded");
const configFingerprints = [
  baseline.config_fingerprint,
  assessment.parameter_baseline.config_fingerprint,
  businessTrace.metadata.config_fingerprint,
  ...scenarioMatrix.scenarios.map((scenario) => scenario.metadata.config_fingerprint),
];

const freezeChecks = {
  acceptance_passed: acceptance.overall_passed === true,
  assessment_passed: assessment.overall_acceptance_passed === true && assessment.score >= 85,
  all_assessment_criteria_passed: assessment.criteria.every((criterion) => criterion.passed),
  config_fingerprint_consistent: new Set(configFingerprints).size === 1,
  scenario_matrix_checks_passed: allTrue(scenarioMatrix.response_checks),
  business_trace_checks_passed: allTrue(businessTrace.checks),
  standard_dataset_formats_equivalent:
    acceptance.uploadedDataset?.formatEquivalence?.metricsEqual === true &&
    acceptance.uploadedDataset?.formatEquivalence?.truthFingerprintEqual === true,
  alias_dataset_normalizes:
    acceptance.aliasDataset?.normalized?.errors === 0 &&
    acceptance.aliasDataset?.normalized?.routedTasks === 1 &&
    acceptance.aliasDataset?.normalized?.localTasks === 1,
  power_saving_nodes_block_business_routing:
    acceptance.powerSavingRoutingGate?.routesBlockedByPower === true &&
    acceptance.powerSavingRoutingGate?.routedRoutes === 0 &&
    acceptance.powerSavingRoutingGate?.activePhysicalLinks > 0,
  priority_scheduling_affects_congested_routes:
    acceptance.priorityScheduling?.commonPath === true &&
    acceptance.priorityScheduling?.highPriority > acceptance.priorityScheduling?.lowPriority &&
    acceptance.priorityScheduling?.highCarriedMbps > acceptance.priorityScheduling?.lowCarriedMbps,
  task_type_effects_drive_telemetry:
    acceptance.businessCausalityChecks?.checkedTaskTelemetryEffects > 0 &&
    acceptance.businessCausalityChecks?.taskTelemetryGeneratedMb > 0,
  uploaded_dataset_fingerprint_consistent:
    Boolean(uploadedScenario) &&
    uploadedScenario.metadata.dataset_fingerprint === businessTrace.metadata.dataset_fingerprint,
  uploaded_truth_fingerprint_consistent:
    Boolean(uploadedScenario) &&
    uploadedScenario.metadata.truth_fingerprint === businessTrace.metadata.truth_fingerprint,
  required_artifacts_exist: artifacts.every((artifact) => artifact.exists && artifact.bytes > 0),
};

const manifest = {
  generated_at: new Date().toISOString(),
  manifest_schema_version: "stage1-freeze-manifest-v1",
  intended_use:
    "第一阶段 Walker/LEO 网络级仿真真值底座，用于第二阶段 INT 遥测设计前的配置、数据集和真值对照冻结。",
  overall_ready: allTrue(freezeChecks),
  project: {
    package_name: packageJson.name,
    package_version: packageJson.version,
  },
  fingerprints: {
    config: baseline.config_fingerprint,
    standard_uploaded_dataset: businessTrace.metadata.dataset_fingerprint,
    standard_uploaded_truth: businessTrace.metadata.truth_fingerprint,
  },
  schemas: {
    task_dataset_file: "schemas/task-dataset-file.schema.json",
    task_record: "schemas/task-dataset.schema.json",
    parameter_baseline: baseline.baseline_schema_version,
    scenario_matrix: scenarioMatrix.matrix_schema_version,
    business_trace: businessTrace.trace_schema_version,
  },
  assessment: {
    readiness: assessment.readiness,
    score: assessment.score,
    max_score: assessment.max_score,
    criteria: assessment.criteria.map((criterion) => ({
      id: criterion.id,
      weight: criterion.weight,
      score: criterion.score,
      passed: criterion.passed,
    })),
  },
  business_trace: {
    path: `${reportDir}/stage1-business-trace.json`,
    counts: businessTrace.counts,
    checks: businessTrace.checks,
  },
  standard_dataset_format_equivalence: acceptance.uploadedDataset?.formatEquivalence ?? null,
  alias_dataset: acceptance.aliasDataset ?? null,
  power_saving_routing_gate: acceptance.powerSavingRoutingGate ?? null,
  priority_scheduling: acceptance.priorityScheduling ?? null,
  scenario_fingerprints: scenarioFingerprints,
  freeze_checks: freezeChecks,
  reproduce_commands: [
    "npm run verify:stage1",
    "npm run assess:stage1",
    "npm run trace:stage1",
    "npm run audit:exports",
    "npm run export:scenario -- --profile uploaded --tasks examples/datasets/stage1-standard-traffic.csv --orbit tle-sgp4 --out exports/stage1-standard-uploaded",
  ],
  artifacts,
};

await mkdir(reportDir, { recursive: true });
await writeFile(manifestJsonPath, JSON.stringify(manifest, null, 2), "utf8");
await writeFile(manifestMdPath, manifestMarkdown(manifest), "utf8");

console.log(
  JSON.stringify(
    {
      overall_ready: manifest.overall_ready,
      files: [manifestJsonPath, manifestMdPath],
      fingerprints: manifest.fingerprints,
      freeze_checks: manifest.freeze_checks,
    },
    null,
    2,
  ),
);

if (!manifest.overall_ready) {
  process.exitCode = 1;
}
