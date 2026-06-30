import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const skipAudit = hasArg(args, "--no-audit");
const acceptancePath = `${reportDir}/stage1-acceptance.json`;
const baselinePath = `${reportDir}/stage1-parameter-baseline.json`;
const scenarioMatrixPath = `${reportDir}/stage1-scenario-matrix.json`;
const businessTracePath = `${reportDir}/stage1-business-trace.json`;
const assessmentJsonPath = `${reportDir}/stage1-model-assessment.json`;
const assessmentMdPath = `${reportDir}/stage1-model-assessment.md`;

function acceptanceById(report, id) {
  return report.acceptance_items.find((item) => item.id === id);
}

function allTrue(value) {
  if (!value || typeof value !== "object") return Boolean(value);
  return Object.values(value).every((entry) => (typeof entry === "object" ? allTrue(entry) : Boolean(entry)));
}

function criterion(id, title, weight, passed, evidence, riskWhenMissing) {
  return {
    id,
    title,
    weight,
    passed: Boolean(passed),
    score: passed ? weight : 0,
    evidence,
    riskWhenMissing,
  };
}

function buildAssessment(report, baseline, scenarioMatrix, businessTrace) {
  const item1 = acceptanceById(report, 1);
  const item3 = acceptanceById(report, 3);
  const item4 = acceptanceById(report, 4);
  const item5 = acceptanceById(report, 5);
  const item6 = acceptanceById(report, 6);
  const item7 = acceptanceById(report, 7);
  const normalMetrics = report.scenarioMetrics.normal;
  const highLoadMetrics = report.scenarioMetrics["high-load"];
  const uploaded = report.uploadedDataset;

  const criteria = [
    criterion(
      "orbit_topology",
      "Walker/TLE-SGP4 拓扑动力学与断链约束",
      16,
      item4?.passed &&
        normalMetrics.activeLinkSamples > 0 &&
        normalMetrics.linkBudgetSamples > 0 &&
        normalMetrics.polarBlockedSamples > 0 &&
        allTrue(report.routeDynamics),
      {
        activeLinkSamples: normalMetrics.activeLinkSamples,
        linkBudgetSamples: normalMetrics.linkBudgetSamples,
        polarBlockedSamples: normalMetrics.polarBlockedSamples,
        routeDynamics: report.routeDynamics,
      },
      "如果这一项失败，说明拓扑变化、极区断链或动态重路由不能可靠驱动网络状态。",
    ),
    criterion(
      "link_physics",
      "链路预算、容量、拥塞和业务承载",
      14,
      normalMetrics.linkBudgetSamples > 0 &&
        highLoadMetrics.maxLinkDemandMbps > normalMetrics.maxLinkDemandMbps &&
        highLoadMetrics.maxCommunicationPowerW > normalMetrics.maxCommunicationPowerW,
      {
        normalMaxLinkDemandMbps: normalMetrics.maxLinkDemandMbps,
        highLoadMaxLinkDemandMbps: highLoadMetrics.maxLinkDemandMbps,
        normalMaxCommunicationPowerW: normalMetrics.maxCommunicationPowerW,
        highLoadMaxCommunicationPowerW: highLoadMetrics.maxCommunicationPowerW,
        highLoadMaxLinkCongestionPercent: highLoadMetrics.maxLinkCongestionPercent,
      },
      "如果这一项失败，说明业务流量没有明显影响链路需求、容量或通信功耗。",
    ),
    criterion(
      "traffic_coupling",
      "业务数据集输入到路由、节点和链路状态的耦合",
      16,
      uploaded.validation.errors.length === 0 &&
        uploaded.metrics.routedTasks > 0 &&
        uploaded.metrics.maxCpuPercent > 0 &&
        uploaded.metrics.maxForwardingLoadMbps > 0 &&
        uploaded.metrics.maxLinkDemandMbps > 0 &&
        allTrue(uploaded.invariants) &&
        report.priorityScheduling?.highCarriedMbps > report.priorityScheduling?.lowCarriedMbps &&
        report.priorityScheduling?.commonPath === true &&
        report.powerSavingRoutingGate?.routesBlockedByPower &&
        report.powerSavingRoutingGate?.routedRoutes === 0 &&
        report.powerSavingRoutingGate?.activePhysicalLinks > 0 &&
        report.businessCausalityChecks?.checkedTaskTelemetryEffects > 0 &&
        report.businessCausalityChecks?.taskTelemetryGeneratedMb > 0 &&
        allTrue(scenarioMatrix.response_checks),
      {
        acceptedRows: uploaded.validation.accepted,
        validationErrors: uploaded.validation.errors.length,
        routedTasks: uploaded.metrics.routedTasks,
        maxCpuPercent: uploaded.metrics.maxCpuPercent,
        maxForwardingLoadMbps: uploaded.metrics.maxForwardingLoadMbps,
        maxLinkDemandMbps: uploaded.metrics.maxLinkDemandMbps,
        invariants: uploaded.invariants,
        taskTypeTelemetryEffects: {
          checkedTaskTelemetryEffects: report.businessCausalityChecks?.checkedTaskTelemetryEffects ?? 0,
          taskTelemetryGeneratedMb: report.businessCausalityChecks?.taskTelemetryGeneratedMb ?? 0,
        },
        priorityScheduling: report.priorityScheduling,
        powerSavingRoutingGate: report.powerSavingRoutingGate,
        scenarioMatrixChecks: scenarioMatrix.response_checks,
      },
      "如果这一项失败，说明外部业务数据无法稳定投喂模型并改变网络状态。",
    ),
    criterion(
      "resource_energy",
      "节点资源、电池、光照和遥测缓存公式响应",
      14,
      item1?.passed &&
        item3?.passed &&
        highLoadMetrics.maxLoadPowerW > normalMetrics.maxLoadPowerW &&
        highLoadMetrics.maxNetworkComputePowerW > normalMetrics.maxNetworkComputePowerW,
      {
        emptyEnergyWh: {
          min: report.scenarioMetrics.empty.minEnergyWh,
          max: report.scenarioMetrics.empty.maxEnergyWh,
        },
        normalMaxLoadPowerW: normalMetrics.maxLoadPowerW,
        highLoadMaxLoadPowerW: highLoadMetrics.maxLoadPowerW,
        normalMaxNetworkComputePowerW: normalMetrics.maxNetworkComputePowerW,
        highLoadMaxNetworkComputePowerW: highLoadMetrics.maxNetworkComputePowerW,
      },
      "如果这一项失败，说明节点状态还不能由业务、光照和网络压力可靠驱动。",
    ),
    criterion(
      "determinism",
      "相同配置与相同业务输入可复现",
      12,
      item5?.passed &&
        report.determinism.highLoadTruthFingerprintStable &&
        report.determinism.uploadedTruthFingerprintStable,
      report.determinism,
      "如果这一项失败，后续 INT 实验无法将观测结果和真值层稳定对齐。",
    ),
    criterion(
      "truth_layer",
      "全知真值层可按时间片支撑第二阶段 INT 对照",
      10,
      item6?.passed &&
        uploaded.metrics.slices > 0 &&
        uploaded.metrics.nodes > 0 &&
        uploaded.metrics.links > 0 &&
        uploaded.metrics.maxTelemetryBufferMb > 0,
      {
        slices: uploaded.metrics.slices,
        nodes: uploaded.metrics.nodes,
        links: uploaded.metrics.links,
        maxTelemetryBufferMb: uploaded.metrics.maxTelemetryBufferMb,
        maxTelemetryDownlinkedMb: uploaded.metrics.maxTelemetryDownlinkedMb,
      },
      "如果这一项失败，仪表盘/导出层不足以作为 INT 遥测结果的全知对照。",
    ),
    criterion(
      "business_trace",
      "标准业务响应追踪可解释任务到链路/节点状态",
      10,
      allTrue(businessTrace.checks) &&
        businessTrace.counts.task_trace_rows > 0 &&
        businessTrace.counts.link_impact_rows > 0 &&
        businessTrace.counts.node_impact_rows > 0 &&
        businessTrace.counts.task_type_telemetry_trace_rows > 0 &&
        businessTrace.counts.task_type_telemetry_generated_mb > 0 &&
        businessTrace.metadata.config_fingerprint === baseline.config_fingerprint &&
        businessTrace.metadata.dataset_task_count === uploaded.validation.accepted,
      {
        traceSchemaVersion: businessTrace.trace_schema_version,
        taskTraceRows: businessTrace.counts.task_trace_rows,
        linkImpactRows: businessTrace.counts.link_impact_rows,
        nodeImpactRows: businessTrace.counts.node_impact_rows,
        routedTaskTraceRows: businessTrace.counts.routed_task_trace_rows,
        taskTypeTelemetryTraceRows: businessTrace.counts.task_type_telemetry_trace_rows ?? 0,
        taskTypeTelemetryGeneratedMb: businessTrace.counts.task_type_telemetry_generated_mb ?? 0,
        maxTaskPathHops: businessTrace.counts.max_task_path_hops,
        maxObservedLinkUtilizationPercent: businessTrace.counts.max_observed_link_utilization_percent,
        maxObservedPathCpuPercent: businessTrace.counts.max_observed_path_cpu_percent,
        checks: businessTrace.checks,
        configFingerprint: businessTrace.metadata.config_fingerprint,
        datasetFingerprint: businessTrace.metadata.dataset_fingerprint,
        truthFingerprint: businessTrace.metadata.truth_fingerprint,
      },
      "如果这一项失败，说明标准业务虽然可能改变了状态，但缺少可追溯的任务-路径-链路-节点解释产物。",
    ),
    criterion(
      "dataset_interface",
      "数据集校验、错误拒绝和场景模板",
      8,
        item7?.passed &&
        report.invalidDataset.validation.errors.length >= 4 &&
        report.aliasDataset?.normalized?.errors === 0 &&
        report.aliasDataset?.normalized?.routedTasks === 1 &&
        report.aliasDataset?.normalized?.localTasks === 1 &&
        uploaded.formatEquivalence?.metricsEqual &&
        uploaded.formatEquivalence?.truthFingerprintEqual &&
        report.scenarioTemplates.every(
          (template) =>
            template.directValidation.errors.length === 0 &&
            template.roundTripValidation.errors.length === 0 &&
            template.generatedTasks === template.parsedTasks,
        ),
      {
        invalidDatasetErrors: report.invalidDataset.validation.errors.length,
        aliasDataset: report.aliasDataset?.normalized,
        scenarioTemplateCount: report.scenarioTemplates.length,
        standardDatasetFormatEquivalence: uploaded.formatEquivalence,
      },
      "如果这一项失败，后续实验数据投喂和复现实验入口还不够稳。",
    ),
  ];

  const score = criteria.reduce((total, item) => total + item.score, 0);
  const readiness =
    report.overall_passed && score >= 85
      ? "第一阶段可用，可作为第二阶段 INT 设计的真值底座"
      : score >= 70
        ? "第一阶段基本可用，但进入 INT 前应修复未通过项"
        : "第一阶段尚不建议进入 INT 遥测实验";

  const retainedScope = [
    "第一阶段允许仪表盘直接读取全网真值，不要求通过 INT 报文采集状态。",
    "模型重点保持 Walker/LEO 拓扑动态、链路预算、业务负载、节点资源、电池光照和遥测缓存之间的可解释耦合。",
    "当前不追求完整通信链路级仿真，暂不展开 MAC、FEC、热控结构、电池老化和真实硬件射频链路细节。",
  ];

  const remainingGaps = [
    "仍使用 synthetic-walker TLE 风格轨道数据，后续应接入 CelesTrak 或 Space-Track 等公开 TLE 数据源进行校准。",
    "业务数据集接口已经可用，但仍需要用更贴近研究场景的流量矩阵、任务时长和地面站回传需求做外部验证。",
    "链路、能耗和节点资源参数具备可解释公式，但还需要根据目标论文、星座资料或实验假设进行参数表固化。",
    "第二阶段开始前应冻结一版配置、数据集 schema、真值导出字段和验收报告，作为 INT 观测误差的对照基线。",
  ];

  return {
    generated_at: new Date().toISOString(),
    based_on: acceptancePath,
    parameter_baseline: {
      path: baselinePath,
      config_fingerprint: baseline.config_fingerprint,
      baseline_schema_version: baseline.baseline_schema_version,
    },
    scenario_matrix: {
      path: scenarioMatrixPath,
      matrix_schema_version: scenarioMatrix.matrix_schema_version,
      scenario_count: scenarioMatrix.scenarios.length,
      response_checks: scenarioMatrix.response_checks,
    },
    business_trace: {
      path: businessTracePath,
      trace_schema_version: businessTrace.trace_schema_version,
      counts: businessTrace.counts,
      checks: businessTrace.checks,
      fingerprints: {
        config: businessTrace.metadata.config_fingerprint,
        dataset: businessTrace.metadata.dataset_fingerprint,
        truth: businessTrace.metadata.truth_fingerprint,
      },
    },
    score,
    max_score: 100,
    readiness,
    overall_acceptance_passed: report.overall_passed,
    criteria,
    retained_scope: retainedScope,
    remaining_gaps: remainingGaps,
  };
}

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function assessmentMarkdown(assessment) {
  const lines = [
    "# 第一阶段模型成熟度评估",
    "",
    `生成时间：${assessment.generated_at}`,
    "",
    `结论：${assessment.readiness}`,
    "",
    `成熟度得分：${assessment.score}/${assessment.max_score}`,
    "",
    `第一阶段自动验收：${assessment.overall_acceptance_passed ? "通过" : "未通过"}`,
    "",
    `参数基线：${assessment.parameter_baseline.path}`,
    "",
    `配置指纹：${assessment.parameter_baseline.config_fingerprint}`,
    "",
    `场景矩阵：${assessment.scenario_matrix.path}`,
    "",
    `业务响应追踪：${assessment.business_trace.path}`,
    "",
    `追踪真值指纹：${assessment.business_trace.fingerprints.truth}`,
    "",
    "## 分项评估",
    "",
    markdownTableRow(["项目", "权重", "得分", "结果"]),
    markdownTableRow(["---", "---", "---", "---"]),
    ...assessment.criteria.map((item) =>
      markdownTableRow([item.title, String(item.weight), String(item.score), item.passed ? "通过" : "未通过"]),
    ),
    "",
    "## 阶段边界",
    "",
    ...assessment.retained_scope.map((item) => `- ${item}`),
    "",
    "## 进入第二阶段前仍需注意",
    "",
    ...assessment.remaining_gaps.map((item) => `- ${item}`),
    "",
    "## 未通过项风险说明",
    "",
    ...assessment.criteria
      .filter((item) => !item.passed)
      .map((item) => `- ${item.title}：${item.riskWhenMissing}`),
    "",
  ];

  if (assessment.criteria.every((item) => item.passed)) {
    lines.push("- 无未通过项。");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

if (!skipAudit) {
  await execFileAsync("node", ["scripts/auditStageOne.mjs", "--report-dir", reportDir], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  await execFileAsync("node", ["scripts/exportStageOneBaseline.mjs", "--report-dir", reportDir], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  await execFileAsync("node", ["scripts/exportStageOneScenarioMatrix.mjs", "--report-dir", reportDir], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  await execFileAsync("node", ["scripts/exportStageOneBusinessTrace.mjs", "--report-dir", reportDir], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

const report = JSON.parse(await readFile(acceptancePath, "utf8"));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const scenarioMatrix = JSON.parse(await readFile(scenarioMatrixPath, "utf8"));
const businessTrace = JSON.parse(await readFile(businessTracePath, "utf8"));
const assessment = buildAssessment(report, baseline, scenarioMatrix, businessTrace);

await mkdir(reportDir, { recursive: true });
await writeFile(assessmentJsonPath, JSON.stringify(assessment, null, 2), "utf8");
await writeFile(assessmentMdPath, assessmentMarkdown(assessment), "utf8");

console.log(JSON.stringify(assessment, null, 2));

if (!assessment.overall_acceptance_passed || assessment.score < 85) {
  process.exitCode = 1;
}
