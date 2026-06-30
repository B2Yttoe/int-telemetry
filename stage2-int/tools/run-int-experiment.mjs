import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { spawn } from "node:child_process";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function safePart(value) {
  return (
    String(value)
      .trim()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 72) || "int-experiment"
  );
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runNode(script, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ stdout, stderr, code });
    });
  });
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`${label} produced no stdout`);
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1000)}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  const text = String(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return "";
}

function splitList(value) {
  return String(value || "")
    .split(">")
    .map((item) => item.trim())
    .filter(Boolean);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function nodePlaneSlot(nodeId) {
  const match = /^P(\d+)-S(\d+)$/.exec(String(nodeId));
  if (!match) return { plane: 0, slot: 0 };
  return { plane: Number(match[1]) - 1, slot: Number(match[2]) - 1 };
}

function compactLinkCatalog(truthLinks) {
  const catalog = new Map();
  truthLinks.forEach((link) => {
    if (!catalog.has(link.link_id)) {
      catalog.set(link.link_id, {
        link_id: link.link_id,
        source: link.source,
        target: link.target,
        kind: link.kind,
      });
    }
  });
  return catalog;
}

function buildProcessVisualizationMarkdown(process) {
  return [
    "# INT 遥测过程可视化数据包",
    "",
    "本数据包用于网页端按时间片展示 probe-int 如何规划探测路径、逐跳写入 INT metadata、生成 report、回传到 Ground OAM，并由 Ground OAM 重构全网节点和链路状态。",
    "",
    "## 边界说明",
    "",
    "- 过程视角只展示 INT 报告和 Ground OAM 重构得到的状态。",
    "- 第一阶段真值不参与过程视角的状态填充，只用于实验结束后的准确率检验。",
    "- 链路端点和轨道面/槽位作为拓扑布局目录使用，不作为链路状态真值展示。",
    "",
    "## 摘要",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("时间片", process.summary.slices),
    reportLine("probe 数", process.summary.probes),
    reportLine("hop events", process.summary.hop_events),
    reportLine("report events", process.summary.report_events),
    reportLine("节点样本覆盖", formatPercent(process.summary.node_sample_coverage)),
    reportLine("链路样本覆盖", formatPercent(process.summary.link_sample_coverage)),
    reportLine("全时间片通过", process.summary.full_time_step_pass),
    "",
    "## 使用方式",
    "",
    "启动网页端后进入 `遥测仿真` 页面，导入本目录下的 `int-process-visualization.json`，即可查看逐时间片、逐 probe、逐 hop 的 INT 捕获过程。",
    "",
  ].join("\n");
}

async function buildProcessVisualization(manifest) {
  const algorithm = manifest.input.algorithm;
  const stage1Dir = manifest.outputs.stage1_truth_dir;
  const stage2Dir = manifest.outputs.stage2_int_dir;
  const probeGroundDir = manifest.outputs.probe_ground_oam_dir;
  const pathsCsv = join(stage2Dir, `probe-paths-${algorithm}.csv`);
  const hopsCsv = join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`);
  const reportsCsv = join(stage2Dir, `probe-int-reports-${algorithm}.csv`);
  const deliveredReportsCsv = join(probeGroundDir, "ground-delivered-reports.csv");
  const reconstructedNodesCsv = join(probeGroundDir, "ground-reconstructed-nodes.csv");
  const reconstructedLinksCsv = join(probeGroundDir, "ground-reconstructed-links.csv");
  const coverageAuditJson = join(probeGroundDir, "full-telemetry-coverage-audit.json");

  const [truthNodes, truthLinks, probePaths, hopRows, reportRows, deliveredReports, reconstructedNodes, reconstructedLinks, coverageAudit] =
    await Promise.all([
      readCsv(join(stage1Dir, "nodes.csv")),
      readCsv(join(stage1Dir, "links.csv")),
      readCsv(pathsCsv),
      readCsv(hopsCsv),
      readCsv(reportsCsv),
      readCsv(deliveredReportsCsv),
      readCsv(reconstructedNodesCsv),
      readCsv(reconstructedLinksCsv),
      readJson(coverageAuditJson),
    ]);

  const linkCatalog = compactLinkCatalog(truthLinks);
  const truthNodesBySlice = groupBy(truthNodes, (row) => row.slice_index);
  const pathsBySlice = groupBy(probePaths, (row) => row.slice_index);
  const hopsBySlice = groupBy(hopRows, (row) => row.slice_index);
  const reportsBySlice = groupBy(reportRows, (row) => row.slice_index);
  const deliveredByReportId = new Map(deliveredReports.map((row) => [row.report_id, row]));
  const reconstructedNodesBySlice = groupBy(reconstructedNodes, (row) => row.slice_index);
  const reconstructedLinksBySlice = groupBy(reconstructedLinks, (row) => row.slice_index);
  const auditBySlice = new Map((coverageAudit.slices ?? []).map((row) => [String(row.slice_index), row]));
  const sliceKeys = [...new Set([...truthNodesBySlice.keys(), ...pathsBySlice.keys(), ...hopsBySlice.keys()])].sort((a, b) => Number(a) - Number(b));

  const slices = sliceKeys.map((sliceIndex) => {
    const nodeRows = truthNodesBySlice.get(sliceIndex) ?? [];
    const probeRows = pathsBySlice.get(sliceIndex) ?? [];
    const hopEvents = (hopsBySlice.get(sliceIndex) ?? []).map((row) => ({
      packet_id: row.packet_id,
      probe_id: row.probe_id,
      probe_type: row.probe_type,
      planning_algorithm: row.planning_algorithm,
      task_id: row.task_id,
      slice_index: numberValue(row.slice_index),
      time: row.time,
      hop_index: numberValue(row.hop_index),
      node_id: row.node_id,
      role: row.role,
      previous_hop: row.previous_hop,
      next_hop: row.next_hop,
      ingress_link_id: row.ingress_link_id,
      egress_link_id: row.egress_link_id,
      observation_scope: row.observation_scope,
      local_port_peer: row.local_port_peer,
      observed_node_mode: row.observed_node_mode,
      observed_cpu_percent: numberValue(row.observed_cpu_percent),
      observed_queue_depth: numberValue(row.observed_queue_depth),
      observed_queued_traffic_mb: numberValue(row.observed_queued_traffic_mb),
      observed_cache_used_mb: numberValue(row.observed_cache_used_mb),
      observed_energy_percent: numberValue(row.observed_energy_percent),
      observed_can_accept_tasks: boolValue(row.observed_can_accept_tasks),
      observed_link_id: row.observed_link_id,
      observed_link_status: row.observed_link_status,
      observed_link_active: boolValue(row.observed_link_active),
      observed_link_utilization_percent: numberValue(row.observed_link_utilization_percent),
      observed_link_latency_ms: numberValue(row.observed_link_latency_ms),
      observed_link_capacity_mbps: numberValue(row.observed_link_capacity_mbps),
      observed_link_congestion_percent: numberValue(row.observed_link_congestion_percent),
      carried_traffic_mbps: numberValue(row.carried_traffic_mbps),
      demand_traffic_mbps: numberValue(row.demand_traffic_mbps),
    }));

    const reportEvents = (reportsBySlice.get(sliceIndex) ?? []).map((row) => {
      const delivered = deliveredByReportId.get(row.report_id);
      return {
        report_id: row.report_id,
        packet_id: row.packet_id,
        task_id: row.task_id,
        probe_id: row.probe_id,
        probe_type: row.probe_type,
        planning_algorithm: row.planning_algorithm,
        slice_index: numberValue(row.slice_index),
        time: row.time,
        sink_node: row.sink_node,
        ground_station: row.ground_station,
        direct_linked_satellite: row.direct_linked_satellite,
        reporting_status: row.reporting_status,
        reporting_hops: numberValue(row.reporting_hops),
        reporting_latency_ms: numberValue(row.reporting_latency_ms),
        reporting_path: splitList(row.reporting_path),
        reporting_link_ids: splitList(row.reporting_link_ids),
        record_count: numberValue(row.record_count),
        report_size_bytes: numberValue(row.report_size_bytes),
        status: delivered?.ground_status ?? row.status,
        drop_reason: delivered?.drop_reason ?? row.drop_reason,
        downlinked_slice: delivered?.downlinked_slice ?? "",
        delivery_delay_slices: delivered?.delivery_delay_slices ?? "",
      };
    });

    const nodes = (reconstructedNodesBySlice.get(sliceIndex) ?? []).map((row) => {
      const fallback = nodePlaneSlot(row.node_id);
      const truth = nodeRows.find((item) => item.node_id === row.node_id);
      return {
        node_id: row.node_id,
        label: truth?.label ?? row.node_id,
        plane: numberValue(truth?.plane, fallback.plane),
        slot: numberValue(truth?.slot, fallback.slot),
        observed: boolValue(row.observed) === true,
        last_observed_slice: row.last_observed_slice,
        mode_estimate: row.mode_estimate,
        cpu_percent_estimate: numberValue(row.cpu_percent_estimate),
        queue_depth_estimate: numberValue(row.queue_depth_estimate),
        queued_traffic_mb_estimate: numberValue(row.queued_traffic_mb_estimate),
        cache_used_mb_estimate: numberValue(row.cache_used_mb_estimate),
        energy_percent_estimate: numberValue(row.energy_percent_estimate),
        confidence: numberValue(row.confidence),
      };
    });

    const links = (reconstructedLinksBySlice.get(sliceIndex) ?? []).map((row) => {
      const catalog = linkCatalog.get(row.link_id) ?? {};
      return {
        link_id: row.link_id,
        source: catalog.source ?? "",
        target: catalog.target ?? "",
        kind: catalog.kind ?? "",
        observed: boolValue(row.observed) === true,
        last_observed_slice: row.last_observed_slice,
        status_estimate: row.status_estimate,
        active_estimate: boolValue(row.active_estimate),
        utilization_percent_estimate: numberValue(row.utilization_percent_estimate),
        latency_ms_estimate: numberValue(row.latency_ms_estimate),
        capacity_mbps_estimate: numberValue(row.capacity_mbps_estimate),
        congestion_percent_estimate: numberValue(row.congestion_percent_estimate),
        confidence: numberValue(row.confidence),
      };
    });

    const audit = auditBySlice.get(String(sliceIndex));
    return {
      slice_index: numberValue(sliceIndex),
      time: nodeRows[0]?.time ?? probeRows[0]?.time ?? hopEvents[0]?.time ?? reportEvents[0]?.time ?? "",
      probes: probeRows.map((row) => ({
        probe_id: row.probe_id,
        planning_algorithm: row.planning_algorithm,
        source: row.source,
        sink: row.sink,
        path_node_count: numberValue(row.path_node_count),
        path_link_count: numberValue(row.path_link_count),
        covered_link_count: numberValue(row.covered_link_count),
        path: splitList(row.path),
        link_ids: splitList(row.link_ids),
      })),
      hop_events: hopEvents,
      report_events: reportEvents,
      oam_reconstruction: {
        nodes,
        links,
        node_observed_count: nodes.filter((node) => node.observed).length,
        link_observed_count: links.filter((link) => link.observed).length,
        node_unknown_count: nodes.filter((node) => !node.observed).length,
        link_unknown_count: links.filter((link) => !link.observed).length,
      },
      coverage: {
        truth_node_samples: numberValue(audit?.truth_node_samples, nodes.length),
        observed_node_samples: numberValue(audit?.observed_node_samples, nodes.filter((node) => node.observed).length),
        node_sample_coverage: numberValue(audit?.node_sample_coverage, nodes.length ? nodes.filter((node) => node.observed).length / nodes.length : 0),
        missing_node_samples: numberValue(audit?.missing_node_samples, nodes.filter((node) => !node.observed).length),
        truth_link_samples: numberValue(audit?.truth_link_samples, links.length),
        observed_link_samples: numberValue(audit?.observed_link_samples, links.filter((link) => link.observed).length),
        link_sample_coverage: numberValue(audit?.link_sample_coverage, links.length ? links.filter((link) => link.observed).length / links.length : 0),
        missing_link_samples: numberValue(audit?.missing_link_samples, links.filter((link) => !link.observed).length),
        pass: audit?.pass === true,
      },
    };
  });

  return {
    schema_version: "stage2-int-process-visualization-v1",
    generated_at: new Date().toISOString(),
    run_dir: manifest.run_dir,
    mode: "probe-int",
    algorithm,
    boundary: {
      ...manifest.boundary,
      process_view_uses_truth_for_state: false,
      layout_uses_stage1_catalog_for_node_and_link_identifiers: true,
    },
    source_files: {
      probe_paths_csv: pathsCsv,
      hop_records_csv: hopsCsv,
      reports_csv: reportsCsv,
      delivered_reports_csv: deliveredReportsCsv,
      reconstructed_nodes_csv: reconstructedNodesCsv,
      reconstructed_links_csv: reconstructedLinksCsv,
      coverage_audit_json: coverageAuditJson,
    },
    summary: {
      slices: slices.length,
      probes: slices.reduce((total, slice) => total + slice.probes.length, 0),
      hop_events: slices.reduce((total, slice) => total + slice.hop_events.length, 0),
      report_events: slices.reduce((total, slice) => total + slice.report_events.length, 0),
      node_sample_coverage: manifest.accuracy.probe_int.node_sample_coverage,
      link_sample_coverage: manifest.accuracy.probe_int.link_sample_coverage,
      active_link_sample_coverage: manifest.accuracy.probe_int.active_link_sample_coverage,
      full_time_step_pass: manifest.accuracy.probe_int.full_time_step_pass,
    },
    slices,
  };
}

async function writeProcessVisualization(manifest) {
  const process = await buildProcessVisualization(manifest);
  await writeFile(manifest.outputs.process_visualization_json, JSON.stringify(process, null, 2), "utf8");
  await writeFile(manifest.outputs.process_visualization_md, buildProcessVisualizationMarkdown(process), "utf8");
  return process;
}

function reportLine(label, value) {
  return `| ${label} | ${value} |`;
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

function buildRunReadme(manifest, verification = null) {
  const verificationSummary = verification?.summary ?? null;
  const verificationText = verificationSummary
    ? `${verificationSummary.pass ? "通过" : "未通过"}，检查项 ${verificationSummary.passed}/${verificationSummary.checks}`
    : "本次 run 尚未写入验收摘要；可执行 int:verify 进行复验。";

  return [
    "# INT 遥测实验包",
    "",
    "本目录保存了一次完整的第二阶段离线 INT 遥测实验：业务数据集输入、第一阶段卫星网络真值快照、traffic-int/probe-int 带内遥测记录、地面 OAM 重建结果、准确率检验报告和文件完整性索引。",
    "",
    "## 快速复验",
    "",
    "在项目根目录执行：",
    "",
    "```powershell",
    `npm run int:verify -- --run "${manifest.run_dir}"`,
    "```",
    "",
    "网页查看方式：启动 `npm run dev`，进入仪表盘右上角的 `遥测仿真` 页面，在 `离线 INT 实验结果导入` 面板选择本目录下的 `int-experiment-manifest.json`。",
    "",
    "## 输入与边界",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("业务数据集快照", formatValue(manifest.input.tasks_snapshot_path ?? manifest.input.tasks_path)),
    reportLine("原始业务数据集", formatValue(manifest.input.original_tasks_path)),
    reportLine("轨道模式", formatValue(manifest.input.orbit)),
    reportLine("运行模式", formatValue(manifest.input.mode)),
    reportLine("路由算法", formatValue(manifest.input.routing)),
    reportLine("INT 探测算法", formatValue(manifest.input.algorithm)),
    reportLine("真值是否参与运行", formatValue(manifest.boundary.stage1_truth_used_for_runtime)),
    reportLine("真值是否仅用于检验", formatValue(manifest.boundary.truth_used_only_for_validation)),
    reportLine("unknown 是否用真值补齐", formatValue(!manifest.boundary.unknown_not_filled_from_truth)),
    "",
    "## 核心指标",
    "",
    "| 模式 | 节点覆盖 | 链路覆盖 | 活动链路覆盖 | 链路状态准确率 | unknown 节点 | unknown 链路 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    `| traffic-int | ${formatPercent(manifest.accuracy.traffic_int.node_sample_coverage)} | ${formatPercent(manifest.accuracy.traffic_int.link_sample_coverage)} | ${formatPercent(manifest.accuracy.traffic_int.active_link_sample_coverage)} | ${formatPercent(manifest.accuracy.traffic_int.link_status_accuracy)} | ${formatValue(manifest.accuracy.traffic_int.unknown_node_samples)} | ${formatValue(manifest.accuracy.traffic_int.unknown_link_samples)} |`,
    `| probe-int | ${formatPercent(manifest.accuracy.probe_int.node_sample_coverage)} | ${formatPercent(manifest.accuracy.probe_int.link_sample_coverage)} | ${formatPercent(manifest.accuracy.probe_int.active_link_sample_coverage)} | ${formatPercent(manifest.accuracy.probe_int.link_status_accuracy)} | ${formatValue(manifest.accuracy.probe_int.unknown_node_samples)} | ${formatValue(manifest.accuracy.probe_int.unknown_link_samples)} |`,
    "",
    "## 全网逐时间步覆盖",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("probe-int 全时间步通过", formatValue(manifest.accuracy.probe_int.full_time_step_pass)),
    reportLine("通过时间片", formatValue(manifest.accuracy.probe_int.passed_slices)),
    reportLine("失败时间片", formatValue(manifest.accuracy.probe_int.failed_slices)),
    reportLine("验收状态", verificationText),
    "",
    "## 关键文件",
    "",
    "| 文件 | 用途 |",
    "|---|---|",
    reportLine("int-experiment-manifest.json", "实验总清单，可导入网页端"),
    reportLine("input-dataset-validation.json / .md", "输入业务数据集校验报告"),
    reportLine("int-telemetry-accuracy-report.json / .md", "INT 全网感知准确率报告"),
    reportLine("int-experiment-report.md", "实验结果摘要"),
    reportLine("int-experiment-verification.json / .md", "自动验收结果"),
    reportLine("int-experiment-file-index.json / .md", "关键输出文件 SHA-256 完整性索引"),
    reportLine("input/", "外部业务数据集快照"),
    reportLine("stage1-truth/nodes.csv", "第一阶段每个时间片的节点真值"),
    reportLine("stage1-truth/links.csv", "第一阶段每个时间片的链路真值"),
    reportLine("stage1-truth/routes.csv", "第一阶段业务路由真值"),
    reportLine("stage2-int/int-hop-records.csv", "traffic-int 沿业务路径采集的 hop 记录"),
    reportLine(`stage2-int/probe-int-hop-records-${manifest.input.algorithm}.csv`, "probe-int 主动探测采集的 hop 记录"),
    reportLine(`stage2-int/ground-probe-${manifest.input.algorithm}/ground-reconstructed-nodes.csv`, "地面 OAM 基于 probe-int 重建的节点状态"),
    reportLine(`stage2-int/ground-probe-${manifest.input.algorithm}/ground-reconstructed-links.csv`, "地面 OAM 基于 probe-int 重建的链路状态"),
    reportLine("int-process-visualization.json", "网页端 INT 过程可视化数据包"),
    "",
  ].join("\n");
}

function verificationSummaryFrom(manifest, verification = null) {
  if (manifest.verification) return manifest.verification;
  if (!verification?.summary) return null;
  return {
    schema_version: verification.schema_version,
    verified_at: verification.generated_at,
    pass: verification.summary.pass,
    checks: verification.summary.checks,
    passed: verification.summary.passed,
    failed: verification.summary.failed,
    thresholds: verification.thresholds,
  };
}

function buildDeliverables(manifest, verification = null) {
  const algorithm = manifest.input.algorithm;
  const stage1Dir = manifest.outputs.stage1_truth_dir;
  const stage2Dir = manifest.outputs.stage2_int_dir;
  const trafficGroundDir = manifest.outputs.traffic_ground_oam_dir;
  const probeGroundDir = manifest.outputs.probe_ground_oam_dir;

  return {
    schema_version: "stage2-int-telemetry-deliverables-v1",
    generated_at: new Date().toISOString(),
    run_dir: manifest.run_dir,
    purpose: "INT telemetry-derived network-wide state dataset with validation against stage-one truth",
    input: {
      task_dataset_snapshot: manifest.input.tasks_snapshot_path ?? manifest.input.tasks_path,
      original_task_dataset: manifest.input.original_tasks_path,
      tle_snapshot: manifest.input.tle_snapshot_path,
      original_tle_snapshot: manifest.input.original_tle_snapshot_path,
      orbit: manifest.input.orbit,
      mode: manifest.input.mode,
      routing: manifest.input.routing,
      int_algorithm: algorithm,
      sample_rate: manifest.input.sample_rate,
      downlink_budget_bytes: manifest.input.downlink_budget_bytes,
      input_validation_json: manifest.outputs.input_validation_json,
      input_validation_md: manifest.outputs.input_validation_md,
    },
    primary_int_state_dataset: {
      scope: "probe-int full-network per-time-step reconstruction",
      node_state_csv: join(probeGroundDir, "ground-reconstructed-nodes.csv"),
      link_state_csv: join(probeGroundDir, "ground-reconstructed-links.csv"),
      delivered_reports_csv: join(probeGroundDir, "ground-delivered-reports.csv"),
      coverage: {
        node_sample_coverage: manifest.accuracy.probe_int.node_sample_coverage,
        link_sample_coverage: manifest.accuracy.probe_int.link_sample_coverage,
        active_link_sample_coverage: manifest.accuracy.probe_int.active_link_sample_coverage,
        full_time_step_pass: manifest.accuracy.probe_int.full_time_step_pass,
        passed_slices: manifest.accuracy.probe_int.passed_slices,
        failed_slices: manifest.accuracy.probe_int.failed_slices,
        unknown_node_samples: manifest.accuracy.probe_int.unknown_node_samples,
        unknown_link_samples: manifest.accuracy.probe_int.unknown_link_samples,
      },
    },
    traffic_path_telemetry_dataset: {
      scope: "traffic-int business-path observations; intentionally partial",
      hop_records_csv: join(stage2Dir, "int-hop-records.csv"),
      reports_csv: join(stage2Dir, "int-reports.csv"),
      reconstructed_nodes_csv: join(trafficGroundDir, "ground-reconstructed-nodes.csv"),
      reconstructed_links_csv: join(trafficGroundDir, "ground-reconstructed-links.csv"),
      coverage: manifest.accuracy.traffic_int,
    },
    probe_telemetry_sources: {
      probe_paths_csv: join(stage2Dir, `probe-paths-${algorithm}.csv`),
      reporting_paths_csv: join(stage2Dir, `reporting-paths-${algorithm}.csv`),
      hop_records_csv: join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
      reports_csv: join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
      run_report_json: join(stage2Dir, `probe-int-run-report-${algorithm}.json`),
    },
    process_visualization: {
      scope: "probe-int process playback package for dashboard visualization",
      visualization_json: manifest.outputs.process_visualization_json,
      visualization_md: manifest.outputs.process_visualization_md,
      contains: [
        "probe plans by slice",
        "hop metadata events",
        "reporting events",
        "Ground OAM reconstruction snapshots",
        "coverage by slice",
      ],
    },
    validation: {
      truth_boundary: manifest.boundary,
      truth_dataset: {
        nodes_csv: join(stage1Dir, "nodes.csv"),
        links_csv: join(stage1Dir, "links.csv"),
        routes_csv: join(stage1Dir, "routes.csv"),
        metrics_csv: join(stage1Dir, "metrics.csv"),
        counts: manifest.stage1.counts,
        fingerprints: manifest.stage1.fingerprints,
      },
      accuracy_report_json: join(probeGroundDir, "ground-oam-evaluation.json"),
      full_coverage_audit_json: join(probeGroundDir, "full-telemetry-coverage-audit.json"),
      final_accuracy_report_json: manifest.outputs.accuracy_report_json,
      final_accuracy_report_md: manifest.outputs.accuracy_report_md,
      experiment_report_md: manifest.outputs.report_md,
      experiment_verification_json: manifest.outputs.verification_json,
      experiment_verification_md: manifest.outputs.verification_md,
      verification_summary: verificationSummaryFrom(manifest, verification),
    },
    integrity: {
      file_index_json: manifest.outputs.file_index_json,
      file_index_md: manifest.outputs.file_index_md,
      manifest_json: manifest.outputs.manifest_json,
      readme_md: manifest.outputs.readme_md,
    },
  };
}

function buildDeliverablesMarkdown(deliverables) {
  const primary = deliverables.primary_int_state_dataset;
  const traffic = deliverables.traffic_path_telemetry_dataset;
  const validation = deliverables.validation;
  const verification = validation.verification_summary;

  return [
    "# INT 遥测最终交付数据集",
    "",
    "本文件说明本次实验中哪些文件是由 INT 遥测得到的全网状态数据，哪些文件只是第一阶段真值检验材料。",
    "",
    "## 主输出：INT 全网感知状态",
    "",
    "| 项目 | 文件或数值 |",
    "|---|---|",
    reportLine("节点状态 CSV", primary.node_state_csv),
    reportLine("链路状态 CSV", primary.link_state_csv),
    reportLine("已下传 probe reports", primary.delivered_reports_csv),
    reportLine("过程可视化 JSON", deliverables.process_visualization.visualization_json),
    reportLine("过程可视化说明", deliverables.process_visualization.visualization_md),
    reportLine("节点覆盖率", formatPercent(primary.coverage.node_sample_coverage)),
    reportLine("链路覆盖率", formatPercent(primary.coverage.link_sample_coverage)),
    reportLine("活动链路覆盖率", formatPercent(primary.coverage.active_link_sample_coverage)),
    reportLine("逐时间片通过", `${primary.coverage.full_time_step_pass} (${primary.coverage.passed_slices}/${primary.coverage.passed_slices + primary.coverage.failed_slices})`),
    reportLine("unknown 节点 / 链路", `${primary.coverage.unknown_node_samples} / ${primary.coverage.unknown_link_samples}`),
    "",
    "## 业务流随路遥测",
    "",
    "| 项目 | 文件或数值 |",
    "|---|---|",
    reportLine("traffic-int hop records", traffic.hop_records_csv),
    reportLine("traffic-int reports", traffic.reports_csv),
    reportLine("traffic-int 节点覆盖率", formatPercent(traffic.coverage.node_sample_coverage)),
    reportLine("traffic-int 链路覆盖率", formatPercent(traffic.coverage.link_sample_coverage)),
    "",
    "## 检验材料",
    "",
    "| 项目 | 文件或数值 |",
    "|---|---|",
    reportLine("第一阶段节点真值", validation.truth_dataset.nodes_csv),
    reportLine("第一阶段链路真值", validation.truth_dataset.links_csv),
    reportLine("准确率报告 JSON", validation.accuracy_report_json),
    reportLine("根目录准确率报告", validation.final_accuracy_report_md),
    reportLine("全覆盖审计 JSON", validation.full_coverage_audit_json),
    reportLine("实验验收 JSON", validation.experiment_verification_json),
    reportLine("实验验收 Markdown", validation.experiment_verification_md),
    reportLine("验收状态", verification ? `${verification.pass ? "通过" : "未通过"} ${verification.passed}/${verification.checks}` : "未写入"),
    "",
    "## 边界声明",
    "",
    "- 第二阶段运行时不读取第一阶段真值。",
    "- 第一阶段真值只在实验结束后的准确率检验阶段使用。",
    "- Ground OAM 只基于成功下传的 INT reports 重建状态。",
    "- 未被遥测观测到的样本保持 unknown，不使用真值补齐。",
    "",
  ].join("\n");
}

async function writeDeliverables(manifest, verification = null) {
  const deliverables = buildDeliverables(manifest, verification);
  await writeFile(manifest.outputs.deliverables_json, JSON.stringify(deliverables, null, 2), "utf8");
  await writeFile(manifest.outputs.deliverables_md, buildDeliverablesMarkdown(deliverables), "utf8");
}

function buildInputValidationReport(manifest, rawDatasetValidation = null) {
  const stage1Validation = manifest.stage1.validation ?? { accepted: 0, warnings: [], errors: [] };
  const rawErrors = rawDatasetValidation?.errors ?? [];
  const stage1Errors = stage1Validation.errors ?? [];
  return {
    schema_version: "stage2-int-input-dataset-validation-v1",
    generated_at: new Date().toISOString(),
    run_dir: manifest.run_dir,
    input: {
      task_dataset_snapshot: manifest.input.tasks_snapshot_path ?? manifest.input.tasks_path,
      original_task_dataset: manifest.input.original_tasks_path,
      profile: manifest.input.profile,
      effective_profile: manifest.input.effective_profile,
      orbit: manifest.input.orbit,
      mode: manifest.input.mode,
      routing: manifest.input.routing,
    },
    status: {
      pass: rawErrors.length === 0 && stage1Errors.length === 0,
      raw_dataset_errors: rawErrors.length,
      raw_dataset_warnings: rawDatasetValidation?.warnings?.length ?? 0,
      stage1_effective_errors: stage1Errors.length,
      stage1_effective_warnings: stage1Validation.warnings?.length ?? 0,
    },
    raw_dataset_validation: rawDatasetValidation,
    stage1_effective_validation: stage1Validation,
    fingerprints: {
      raw_dataset: rawDatasetValidation?.datasetFingerprint ?? null,
      stage1_dataset: manifest.stage1.fingerprints.dataset,
      stage1_truth: manifest.stage1.fingerprints.truth,
      config: manifest.stage1.fingerprints.config,
    },
    stage1_counts: manifest.stage1.counts,
  };
}

function buildInputValidationMarkdown(report) {
  const raw = report.raw_dataset_validation;
  const stage1 = report.stage1_effective_validation ?? {};
  const status = report.status;
  const summary = raw?.summary ?? {};

  return [
    "# 输入业务数据集校验报告",
    "",
    "本报告记录本次 INT 实验实际使用的业务数据集快照，以及它进入第一阶段仿真前后的校验结果。",
    "",
    "## 结论",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("校验状态", status.pass ? "通过" : "未通过"),
    reportLine("输入快照", formatValue(report.input.task_dataset_snapshot)),
    reportLine("原始路径", formatValue(report.input.original_task_dataset)),
    reportLine("raw errors / warnings", `${status.raw_dataset_errors} / ${status.raw_dataset_warnings}`),
    reportLine("stage1 errors / warnings", `${status.stage1_effective_errors} / ${status.stage1_effective_warnings}`),
    reportLine("raw dataset fingerprint", formatValue(report.fingerprints.raw_dataset)),
    reportLine("stage1 dataset fingerprint", formatValue(report.fingerprints.stage1_dataset)),
    "",
    "## 负载摘要",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("accepted tasks", formatValue(raw?.accepted ?? stage1.accepted)),
    reportLine("routed tasks", formatValue(summary.routedTasks)),
    reportLine("local tasks", formatValue(summary.localTasks)),
    reportLine("total traffic Mbps", formatValue(summary.totalTrafficMbps)),
    reportLine("total compute units", formatValue(summary.totalComputeUnits)),
    reportLine("first active slice", formatValue(summary.firstActiveSlice)),
    reportLine("last active slice", formatValue(summary.lastActiveSlice)),
    "",
    "## 说明",
    "",
    "- raw dataset validation 来自 `npm run validate:dataset -- --json` 使用的同一套解析与校验逻辑。",
    "- stage1 effective validation 是第一阶段导出真值快照时实际进入仿真的有效任务校验结果。",
    "- 如果存在 errors，本次实验不应作为有效 INT 遥测实验使用。",
    "",
  ].join("\n");
}

async function writeInputValidationReport(manifest, rawDatasetValidation = null) {
  const report = buildInputValidationReport(manifest, rawDatasetValidation);
  await writeFile(manifest.outputs.input_validation_json, JSON.stringify(report, null, 2), "utf8");
  await writeFile(manifest.outputs.input_validation_md, buildInputValidationMarkdown(report), "utf8");
}

function coverageAuditSummaryFrom(audit) {
  if (!audit) return null;
  if (audit.summary) return audit.summary;
  return {
    slices: audit.slices ?? null,
    passed_slices: audit.passedSlices ?? null,
    failed_slices: audit.failedSlices ?? null,
    node_sample_coverage: audit.nodeSampleCoverage ?? null,
    link_sample_coverage: audit.linkSampleCoverage ?? null,
    pass: audit.pass ?? null,
  };
}

function buildAccuracyReport(manifest, verification = null) {
  const probe = manifest.accuracy.probe_int;
  const traffic = manifest.accuracy.traffic_int;
  const audit = manifest.int_pipeline.full_coverage_audit ?? {};
  const auditSummary = coverageAuditSummaryFrom(audit);
  const pass =
    probe.node_sample_coverage === 1 &&
    probe.link_sample_coverage === 1 &&
    probe.active_link_sample_coverage === 1 &&
    probe.mode_accuracy === 1 &&
    probe.link_status_accuracy === 1 &&
    probe.unknown_node_samples === 0 &&
    probe.unknown_link_samples === 0 &&
    probe.full_time_step_pass === true;

  return {
    schema_version: "stage2-int-telemetry-accuracy-report-v1",
    generated_at: new Date().toISOString(),
    run_dir: manifest.run_dir,
    conclusion: {
      pass,
      primary_mode: "probe-int",
      statement: pass
        ? "probe-int delivered a complete per-time-step network-wide reconstruction for this experiment."
        : "probe-int did not satisfy all full-network reconstruction criteria for this experiment.",
    },
    input: {
      task_dataset_snapshot: manifest.input.tasks_snapshot_path ?? manifest.input.tasks_path,
      original_task_dataset: manifest.input.original_tasks_path,
      input_validation_json: manifest.outputs.input_validation_json,
    },
    truth_reference: {
      stage1_truth_dir: manifest.outputs.stage1_truth_dir,
      counts: manifest.stage1.counts,
      fingerprints: manifest.stage1.fingerprints,
      used_only_for_validation: manifest.boundary.truth_used_only_for_validation,
    },
    telemetry_boundary: manifest.boundary,
    primary_probe_int: {
      scope: "network-wide per-time-step state reconstructed by ground OAM from delivered probe-int reports",
      node_state_csv: join(manifest.outputs.probe_ground_oam_dir, "ground-reconstructed-nodes.csv"),
      link_state_csv: join(manifest.outputs.probe_ground_oam_dir, "ground-reconstructed-links.csv"),
      delivered_reports_csv: join(manifest.outputs.probe_ground_oam_dir, "ground-delivered-reports.csv"),
      evaluation_json: join(manifest.outputs.probe_ground_oam_dir, "ground-oam-evaluation.json"),
      full_coverage_audit_json: join(manifest.outputs.probe_ground_oam_dir, "full-telemetry-coverage-audit.json"),
      metrics: probe,
      coverage_audit_summary: auditSummary,
      per_slice_coverage: Array.isArray(audit.slices) ? audit.slices : [],
    },
    traffic_int_reference: {
      scope: "business-path INT observations; intentionally partial and not expected to cover the whole network",
      evaluation_json: join(manifest.outputs.traffic_ground_oam_dir, "ground-oam-evaluation.json"),
      metrics: traffic,
    },
    verification: verificationSummaryFrom(manifest, verification),
  };
}

function buildAccuracyReportMarkdown(report) {
  const probe = report.primary_probe_int.metrics;
  const traffic = report.traffic_int_reference.metrics;
  const audit = report.primary_probe_int.coverage_audit_summary ?? {};
  const verification = report.verification;

  return [
    "# INT 遥测准确率报告",
    "",
    "本报告集中说明第二阶段 INT 遥测得到的全网状态数据与第一阶段真值快照的对照结果。第一阶段真值只在本报告和 OAM evaluation 阶段用于检验，不参与 INT 运行时重构。",
    "",
    "## 结论",
    "",
    "| 项目 | 值 |",
    "|---|---|",
    reportLine("主遥测模式", report.conclusion.primary_mode),
    reportLine("结论", report.conclusion.pass ? "通过" : "未通过"),
    reportLine("逐时间片审计", `${formatValue(probe.full_time_step_pass)} (${formatValue(probe.passed_slices)}/${formatValue((probe.passed_slices ?? 0) + (probe.failed_slices ?? 0))})`),
    reportLine("验收状态", verification ? `${verification.pass ? "通过" : "未通过"} ${verification.passed}/${verification.checks}` : "未写入"),
    "",
    "## probe-int 全网感知准确率",
    "",
    "| 指标 | 值 |",
    "|---|---:|",
    reportLine("节点覆盖率", formatPercent(probe.node_sample_coverage)),
    reportLine("链路覆盖率", formatPercent(probe.link_sample_coverage)),
    reportLine("活动链路覆盖率", formatPercent(probe.active_link_sample_coverage)),
    reportLine("模式准确率", formatPercent(probe.mode_accuracy)),
    reportLine("链路状态准确率", formatPercent(probe.link_status_accuracy)),
    reportLine("CPU MAE", formatValue(probe.cpu_mae)),
    reportLine("队列 MAE", formatValue(probe.queue_depth_mae)),
    reportLine("电量 MAE", formatValue(probe.energy_percent_mae)),
    reportLine("unknown 节点样本", formatValue(probe.unknown_node_samples)),
    reportLine("unknown 链路样本", formatValue(probe.unknown_link_samples)),
    "",
    "## 逐时间片覆盖审计",
    "",
    "| 指标 | 值 |",
    "|---|---:|",
    reportLine("时间片数量", formatValue(audit.slices)),
    reportLine("通过时间片", formatValue(audit.passed_slices)),
    reportLine("失败时间片", formatValue(audit.failed_slices)),
    reportLine("真值节点样本", formatValue(audit.total_truth_node_samples)),
    reportLine("观测节点样本", formatValue(audit.total_observed_node_samples)),
    reportLine("真值链路样本", formatValue(audit.total_truth_link_samples)),
    reportLine("观测链路样本", formatValue(audit.total_observed_link_samples)),
    "",
    "## traffic-int 参考",
    "",
    "| 指标 | 值 |",
    "|---|---:|",
    reportLine("节点覆盖率", formatPercent(traffic.node_sample_coverage)),
    reportLine("链路覆盖率", formatPercent(traffic.link_sample_coverage)),
    reportLine("活动链路覆盖率", formatPercent(traffic.active_link_sample_coverage)),
    reportLine("unknown 节点样本", formatValue(traffic.unknown_node_samples)),
    reportLine("unknown 链路样本", formatValue(traffic.unknown_link_samples)),
    "",
    "## 关键文件",
    "",
    "| 文件 | 用途 |",
    "|---|---|",
    reportLine(report.primary_probe_int.node_state_csv, "INT 重构节点状态主输出"),
    reportLine(report.primary_probe_int.link_state_csv, "INT 重构链路状态主输出"),
    reportLine(report.primary_probe_int.evaluation_json, "Ground OAM 详细准确率 JSON"),
    reportLine(report.primary_probe_int.full_coverage_audit_json, "逐时间片全覆盖审计 JSON"),
    "",
  ].join("\n");
}

async function writeAccuracyReport(manifest, verification = null) {
  const report = buildAccuracyReport(manifest, verification);
  await writeFile(manifest.outputs.accuracy_report_json, JSON.stringify(report, null, 2), "utf8");
  await writeFile(manifest.outputs.accuracy_report_md, buildAccuracyReportMarkdown(report), "utf8");
}

const args = process.argv.slice(2);
const tasksPath = argValue(args, "--tasks", "");
const profile = argValue(args, "--profile", tasksPath ? "uploaded" : "normal");
const orbit = argValue(args, "--orbit", "tle-sgp4");
const mode = argValue(args, "--mode", "operational");
const routing = argValue(args, "--routing", "shortest-path");
const tleSnapshotPath = argValue(args, "--tle-snapshot", "");
const algorithm = argValue(args, "--algorithm", "path-balance");
const sampleRate = argValue(args, "--sample-rate", "1");
const downlinkBudgetBytes = argValue(args, "--downlink-budget-bytes", "65536");
const carryOver = argValue(args, "--carry-over", "true");
const includeFullJson = hasArg(args, "--full-json");
const skipVerify = hasArg(args, "--skip-verify");

const originalTasksPath = tasksPath ? resolve(tasksPath) : "";
if (originalTasksPath && !existsSync(originalTasksPath)) {
  throw new Error(`Task dataset not found: ${originalTasksPath}`);
}
const originalTleSnapshotPath = tleSnapshotPath ? resolve(tleSnapshotPath) : "";
if (originalTleSnapshotPath && !existsSync(originalTleSnapshotPath)) {
  throw new Error(`TLE snapshot not found: ${originalTleSnapshotPath}`);
}

const datasetLabel = tasksPath ? safePart(basename(tasksPath)) : `scenario-${profile}`;
const runDir = resolve(argValue(args, "--out", `stage2-int/runs/${nowStamp()}-${datasetLabel}`));
const inputDir = join(runDir, "input");
const stage1Dir = join(runDir, "stage1-truth");
const stage2Dir = join(runDir, "stage2-int");
const trafficGroundDir = join(stage2Dir, "ground-traffic-int");
const probeGroundDir = join(stage2Dir, `ground-probe-${algorithm}`);

await mkdir(runDir, { recursive: true });
let taskSnapshotPath = "";
let tleSnapshotInputPath = "";
if (originalTasksPath || originalTleSnapshotPath) {
  await mkdir(inputDir, { recursive: true });
}
if (originalTasksPath) {
  taskSnapshotPath = join(inputDir, basename(originalTasksPath));
  await copyFile(originalTasksPath, taskSnapshotPath);
}
if (originalTleSnapshotPath) {
  tleSnapshotInputPath = join(inputDir, basename(originalTleSnapshotPath));
  await copyFile(originalTleSnapshotPath, tleSnapshotInputPath);
}

const rawDatasetValidation = taskSnapshotPath
  ? parseLastJson(
      (
        await runNode("scripts/validateDataset.mjs", [
          "--tasks",
          taskSnapshotPath,
          "--json",
        ])
      ).stdout,
      "input dataset validation",
    )
  : null;

const exportArgs = [
  "scripts/exportScenario.mjs",
  "--profile",
  profile,
  "--orbit",
  orbit,
  "--mode",
  mode,
  "--routing",
  routing,
  "--out",
  stage1Dir,
];
if (taskSnapshotPath) exportArgs.push("--tasks", taskSnapshotPath);
if (tleSnapshotInputPath) exportArgs.push("--tle-snapshot", tleSnapshotInputPath);
if (includeFullJson) exportArgs.push("--full-json");

const stage1Export = parseLastJson((await runNode(exportArgs[0], exportArgs.slice(1))).stdout, "stage1 export");

const trafficInt = parseLastJson(
  (
    await runNode("stage2-int/tools/offline-int-mvp.mjs", [
      "--input",
      stage1Dir,
      "--out",
      stage2Dir,
      "--sample-rate",
      sampleRate,
    ])
  ).stdout,
  "traffic-int",
);

const probePlanning = parseLastJson(
  (
    await runNode("stage2-int/tools/probe-path-planner.mjs", [
      "--input",
      stage1Dir,
      "--out",
      stage2Dir,
      "--algorithm",
      "both",
    ])
  ).stdout,
  "probe path planner",
);

const reporting = parseLastJson(
  (
    await runNode("stage2-int/tools/reporting-path-planner.mjs", [
      "--input",
      stage1Dir,
      "--stage2",
      stage2Dir,
      "--algorithm",
      algorithm,
    ])
  ).stdout,
  "reporting path planner",
);

const probeInt = parseLastJson(
  (
    await runNode("stage2-int/tools/probe-int-runner.mjs", [
      "--input",
      stage1Dir,
      "--stage2",
      stage2Dir,
      "--algorithm",
      algorithm,
    ])
  ).stdout,
  "probe-int runner",
);

const trafficGround = parseLastJson(
  (
    await runNode("stage2-int/tools/ground-oam-reconstructor.mjs", [
      "--input",
      stage1Dir,
      "--stage2",
      stage2Dir,
      "--out",
      trafficGroundDir,
      "--downlink-budget-bytes",
      downlinkBudgetBytes,
      "--carry-over",
      carryOver,
    ])
  ).stdout,
  "traffic ground OAM",
);

const probeGround = parseLastJson(
  (
    await runNode("stage2-int/tools/ground-oam-reconstructor.mjs", [
      "--input",
      stage1Dir,
      "--stage2",
      stage2Dir,
      "--hops",
      join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
      "--reports",
      join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
      "--out",
      probeGroundDir,
      "--downlink-budget-bytes",
      downlinkBudgetBytes,
      "--carry-over",
      carryOver,
    ])
  ).stdout,
  "probe ground OAM",
);

const fullCoverageAudit = parseLastJson(
  (
    await runNode("stage2-int/tools/audit-full-telemetry-coverage.mjs", [
      "--input",
      stage1Dir,
      "--ground",
      probeGroundDir,
    ], { allowFailure: true })
  ).stdout,
  "full telemetry coverage audit",
);

const trafficEvaluation = await readJson(join(trafficGroundDir, "ground-oam-evaluation.json"));
const probeEvaluation = await readJson(join(probeGroundDir, "ground-oam-evaluation.json"));
const coverageAudit = await readJson(join(probeGroundDir, "full-telemetry-coverage-audit.json"));

const manifest = {
  schema_version: "stage2-int-experiment-run-v1",
  generated_at: new Date().toISOString(),
  run_dir: runDir,
  objective: "external traffic dataset -> stage-one truth -> INT telemetry -> OAM reconstruction -> accuracy report",
  input: {
    tasks_path: taskSnapshotPath,
    original_tasks_path: originalTasksPath,
    tasks_snapshot_path: taskSnapshotPath,
    tle_snapshot_path: tleSnapshotInputPath,
    original_tle_snapshot_path: originalTleSnapshotPath,
    profile,
    effective_profile: stage1Export.profile,
    orbit,
    mode,
    routing,
    algorithm,
    sample_rate: Number(sampleRate),
    downlink_budget_bytes: Number(downlinkBudgetBytes),
    carry_over: carryOver !== "false",
    validation: {
      report_json: join(runDir, "input-dataset-validation.json"),
      report_md: join(runDir, "input-dataset-validation.md"),
      raw_accepted: rawDatasetValidation?.accepted ?? null,
      raw_errors: rawDatasetValidation?.errors?.length ?? 0,
      raw_warnings: rawDatasetValidation?.warnings?.length ?? 0,
    },
  },
  stage1: {
    out_dir: stage1Dir,
    fingerprints: stage1Export.fingerprints,
    validation: stage1Export.validation,
    counts: stage1Export.counts,
    files: stage1Export.files,
  },
  int_pipeline: {
    traffic_int: trafficInt,
    probe_planning: probePlanning,
    reporting,
    probe_int: probeInt,
    traffic_ground_oam: trafficGround,
    probe_ground_oam: probeGround,
    full_coverage_audit: fullCoverageAudit,
  },
  accuracy: {
    traffic_int: {
      node_sample_coverage: trafficEvaluation.node_reconstruction.node_sample_coverage,
      link_sample_coverage: trafficEvaluation.link_reconstruction.link_sample_coverage,
      active_link_sample_coverage: trafficEvaluation.link_reconstruction.active_link_sample_coverage,
      cpu_mae: trafficEvaluation.node_reconstruction.cpu_mae,
      queue_depth_mae: trafficEvaluation.node_reconstruction.queue_depth_mae,
      energy_percent_mae: trafficEvaluation.node_reconstruction.energy_percent_mae,
      mode_accuracy: trafficEvaluation.node_reconstruction.mode_accuracy,
      link_status_accuracy: trafficEvaluation.link_reconstruction.status_accuracy,
      congestion_recall_global: trafficEvaluation.link_reconstruction.congestion_recall_over_global_truth,
      unknown_node_samples: trafficEvaluation.node_reconstruction.unknown_node_samples,
      unknown_link_samples: trafficEvaluation.link_reconstruction.unknown_link_samples,
    },
    probe_int: {
      node_sample_coverage: probeEvaluation.node_reconstruction.node_sample_coverage,
      link_sample_coverage: probeEvaluation.link_reconstruction.link_sample_coverage,
      active_link_sample_coverage: probeEvaluation.link_reconstruction.active_link_sample_coverage,
      cpu_mae: probeEvaluation.node_reconstruction.cpu_mae,
      queue_depth_mae: probeEvaluation.node_reconstruction.queue_depth_mae,
      energy_percent_mae: probeEvaluation.node_reconstruction.energy_percent_mae,
      mode_accuracy: probeEvaluation.node_reconstruction.mode_accuracy,
      link_status_accuracy: probeEvaluation.link_reconstruction.status_accuracy,
      congestion_recall_global: probeEvaluation.link_reconstruction.congestion_recall_over_global_truth,
      unknown_node_samples: probeEvaluation.node_reconstruction.unknown_node_samples,
      unknown_link_samples: probeEvaluation.link_reconstruction.unknown_link_samples,
      full_time_step_pass: coverageAudit.summary.pass,
      passed_slices: coverageAudit.summary.passed_slices,
      failed_slices: coverageAudit.summary.failed_slices,
    },
  },
  boundary: {
    stage1_truth_used_for_runtime: false,
    truth_used_only_for_validation: true,
    ground_oam_uses_only_delivered_reports: true,
    unknown_not_filled_from_truth: true,
  },
  outputs: {
    stage1_truth_dir: stage1Dir,
    stage2_int_dir: stage2Dir,
    traffic_ground_oam_dir: trafficGroundDir,
    probe_ground_oam_dir: probeGroundDir,
    manifest_json: join(runDir, "int-experiment-manifest.json"),
    readme_md: join(runDir, "README.md"),
    input_validation_json: join(runDir, "input-dataset-validation.json"),
    input_validation_md: join(runDir, "input-dataset-validation.md"),
    deliverables_json: join(runDir, "int-telemetry-deliverables.json"),
    deliverables_md: join(runDir, "int-telemetry-deliverables.md"),
    process_visualization_json: join(runDir, "int-process-visualization.json"),
    process_visualization_md: join(runDir, "int-process-visualization.md"),
    accuracy_report_json: join(runDir, "int-telemetry-accuracy-report.json"),
    accuracy_report_md: join(runDir, "int-telemetry-accuracy-report.md"),
    report_md: join(runDir, "int-experiment-report.md"),
    verification_json: join(runDir, "int-experiment-verification.json"),
    verification_md: join(runDir, "int-experiment-verification.md"),
    file_index_json: join(runDir, "int-experiment-file-index.json"),
    file_index_md: join(runDir, "int-experiment-file-index.md"),
  },
};

const reportMd = [
  "# INT 遥测实验报告",
  "",
  "## 实验输入",
  "",
  "| 项目 | 值 |",
  "|---|---|",
  reportLine("业务数据集", manifest.input.tasks_path || `内置场景 ${manifest.input.profile}`),
  ...(manifest.input.original_tasks_path ? [reportLine("原始业务数据集", manifest.input.original_tasks_path)] : []),
  reportLine("轨道模式", manifest.input.orbit),
  reportLine("运行模式", manifest.input.mode),
  reportLine("路由算法", manifest.input.routing),
  reportLine("INT 探测算法", manifest.input.algorithm),
  reportLine("配置指纹", manifest.stage1.fingerprints.config),
  reportLine("数据集指纹", manifest.stage1.fingerprints.dataset),
  reportLine("真值指纹", manifest.stage1.fingerprints.truth),
  "",
  "## 第一阶段真值导出",
  "",
  "| 项目 | 值 |",
  "|---|---|",
  reportLine("时间片", manifest.stage1.counts.metrics),
  reportLine("节点样本", manifest.stage1.counts.nodes),
  reportLine("链路样本", manifest.stage1.counts.links),
  reportLine("路由样本", manifest.stage1.counts.routes),
  reportLine("数据集校验错误", manifest.stage1.validation.errors.length),
  "",
  "## INT 管线结果",
  "",
  "| 项目 | 值 |",
  "|---|---|",
  reportLine("traffic-int reports", manifest.int_pipeline.traffic_int.reports),
  reportLine("traffic-int hop records", manifest.int_pipeline.traffic_int.hopRecords),
  reportLine("probe-int reports", manifest.int_pipeline.probe_int.reports),
  reportLine("probe-int hop records", manifest.int_pipeline.probe_int.hopRecords),
  reportLine("probe path count", manifest.int_pipeline.probe_int.probePaths),
  reportLine("reporting blocked paths", manifest.int_pipeline.reporting.blockedReportingPaths),
  reportLine("过程可视化包", manifest.outputs.process_visualization_json),
  "",
  "## 准确率与覆盖率",
  "",
  "| 模式 | 节点覆盖 | 全链路覆盖 | 活动链路覆盖 | CPU MAE | 队列 MAE | 电量 MAE | 模式准确率 | 链路状态准确率 | 全局拥塞召回 | Unknown 节点 | Unknown 链路 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  `| traffic-int | ${manifest.accuracy.traffic_int.node_sample_coverage} | ${manifest.accuracy.traffic_int.link_sample_coverage} | ${manifest.accuracy.traffic_int.active_link_sample_coverage} | ${manifest.accuracy.traffic_int.cpu_mae} | ${manifest.accuracy.traffic_int.queue_depth_mae} | ${manifest.accuracy.traffic_int.energy_percent_mae} | ${manifest.accuracy.traffic_int.mode_accuracy} | ${manifest.accuracy.traffic_int.link_status_accuracy} | ${manifest.accuracy.traffic_int.congestion_recall_global} | ${manifest.accuracy.traffic_int.unknown_node_samples} | ${manifest.accuracy.traffic_int.unknown_link_samples} |`,
  `| probe-int | ${manifest.accuracy.probe_int.node_sample_coverage} | ${manifest.accuracy.probe_int.link_sample_coverage} | ${manifest.accuracy.probe_int.active_link_sample_coverage} | ${manifest.accuracy.probe_int.cpu_mae} | ${manifest.accuracy.probe_int.queue_depth_mae} | ${manifest.accuracy.probe_int.energy_percent_mae} | ${manifest.accuracy.probe_int.mode_accuracy} | ${manifest.accuracy.probe_int.link_status_accuracy} | ${manifest.accuracy.probe_int.congestion_recall_global} | ${manifest.accuracy.probe_int.unknown_node_samples} | ${manifest.accuracy.probe_int.unknown_link_samples} |`,
  "",
  "## 全网逐时间步审计",
  "",
  "| 项目 | 值 |",
  "|---|---|",
  reportLine("审计通过", manifest.accuracy.probe_int.full_time_step_pass),
  reportLine("通过时间片", manifest.accuracy.probe_int.passed_slices),
  reportLine("失败时间片", manifest.accuracy.probe_int.failed_slices),
  "",
  "## 边界说明",
  "",
  "- INT 运行时只使用沿路径采集并成功下传的报告。",
  "- 第一阶段真值只在实验结束后的 accuracy/evaluation 阶段读取。",
  "- 未被遥测观测的节点或链路保持 unknown，不用真值补齐。",
  "",
].join("\n");

await writeProcessVisualization(manifest);
await writeFile(join(runDir, "int-experiment-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
await writeFile(join(runDir, "int-experiment-report.md"), reportMd, "utf8");
await writeFile(join(runDir, "README.md"), buildRunReadme(manifest), "utf8");
await writeInputValidationReport(manifest, rawDatasetValidation);
await writeAccuracyReport(manifest);
await writeDeliverables(manifest);

let verification = null;
if (!skipVerify) {
  verification = parseLastJson(
    (
      await runNode("stage2-int/tools/verify-int-experiment.mjs", [
        "--run",
        runDir,
      ])
    ).stdout,
    "int experiment verification",
  );
  manifest.verification = {
    schema_version: verification.schema_version,
    verified_at: verification.generated_at,
    pass: verification.summary.pass,
    checks: verification.summary.checks,
    passed: verification.summary.passed,
    failed: verification.summary.failed,
    thresholds: verification.thresholds,
    report_json: verification.outputs?.verification_json ?? manifest.outputs.verification_json,
    report_md: verification.outputs?.verification_md ?? manifest.outputs.verification_md,
    file_index_json: verification.outputs?.file_index_json ?? manifest.outputs.file_index_json,
    file_index_md: verification.outputs?.file_index_md ?? manifest.outputs.file_index_md,
  };
  await writeFile(join(runDir, "int-experiment-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(runDir, "README.md"), buildRunReadme(manifest, verification), "utf8");
  await writeInputValidationReport(manifest, rawDatasetValidation);
  await writeAccuracyReport(manifest, verification);
  await writeDeliverables(manifest, verification);
  verification = parseLastJson(
    (
      await runNode("stage2-int/tools/verify-int-experiment.mjs", [
        "--run",
        runDir,
      ])
    ).stdout,
    "final int experiment verification",
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      verified: verification?.summary?.pass ?? false,
      runDir,
      dataset: manifest.input.tasks_path || manifest.input.profile,
      fingerprints: manifest.stage1.fingerprints,
      trafficInt: manifest.accuracy.traffic_int,
      probeInt: manifest.accuracy.probe_int,
      readme: manifest.outputs.readme_md,
      deliverables: manifest.outputs.deliverables_json,
      processVisualization: manifest.outputs.process_visualization_json,
      accuracyReport: manifest.outputs.accuracy_report_json,
      report: manifest.outputs.report_md,
      manifest: manifest.outputs.manifest_json,
      verification: verification?.outputs?.verification_json ?? "",
    },
    null,
    2,
  ),
);
