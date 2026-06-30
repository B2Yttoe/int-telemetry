import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Download,
  FileText,
  Network,
  RadioTower,
  Route,
  Satellite,
  Send,
  Upload,
  Workflow,
} from "lucide-react";
import {
  buildIntTelemetryRun,
  type IntHopObservation,
  type IntLinkObservation,
  type IntNodeValidation,
  type IntNodeObservation,
  type IntReport,
  type IntTelemetryMode,
  type IntTelemetrySlice,
} from "../telemetry/intTelemetry";
import type { NetworkSlice } from "../simulation/types";

type TelemetrySelection =
  | { type: "node"; id: string }
  | { type: "link"; id: string }
  | { type: "report"; id: string };

type ImportedExperimentAccuracy = {
  node_sample_coverage?: number;
  link_sample_coverage?: number;
  active_link_sample_coverage?: number;
  cpu_mae?: number;
  queue_depth_mae?: number;
  energy_percent_mae?: number;
  mode_accuracy?: number;
  link_status_accuracy?: number;
  congestion_recall_global?: number;
  unknown_node_samples?: number;
  unknown_link_samples?: number;
  full_time_step_pass?: boolean;
  passed_slices?: number;
  failed_slices?: number;
};

type ImportedExperimentManifest = {
  schema_version?: string;
  generated_at?: string;
  run_dir?: string;
  objective?: string;
  input?: Record<string, unknown>;
  stage1?: {
    out_dir?: string;
    fingerprints?: Record<string, unknown>;
    validation?: {
      accepted?: number;
      warnings?: unknown[];
      errors?: unknown[];
    };
    counts?: Record<string, unknown>;
    files?: unknown[];
  };
  int_pipeline?: {
    traffic_int?: Record<string, unknown>;
    probe_planning?: {
      algorithms?: Record<string, Record<string, unknown>>;
    };
    reporting?: Record<string, unknown>;
    probe_int?: Record<string, unknown>;
    traffic_ground_oam?: Record<string, unknown>;
    probe_ground_oam?: Record<string, unknown>;
    full_coverage_audit?: Record<string, unknown>;
  };
  accuracy?: {
    traffic_int?: ImportedExperimentAccuracy;
    probe_int?: ImportedExperimentAccuracy;
  };
  verification?: {
    schema_version?: string;
    verified_at?: string;
    pass?: boolean;
    checks?: number;
    passed?: number;
    failed?: number;
    thresholds?: Record<string, unknown>;
    report_json?: string;
    report_md?: string;
    file_index_json?: string;
    file_index_md?: string;
  };
  boundary?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

type IntProcessProbe = {
  probe_id: string;
  planning_algorithm: string;
  source: string;
  sink: string;
  path_node_count: number;
  path_link_count: number;
  covered_link_count: number;
  path: string[];
  link_ids: string[];
};

type IntProcessHopEvent = {
  packet_id: string;
  probe_id: string;
  slice_index: number;
  time: string;
  hop_index: number;
  node_id: string;
  role: string;
  previous_hop: string;
  next_hop: string;
  ingress_link_id: string;
  egress_link_id: string;
  observation_scope: string;
  local_port_peer: string;
  observed_node_mode: string;
  observed_cpu_percent: number;
  observed_queue_depth: number;
  observed_queued_traffic_mb: number;
  observed_cache_used_mb: number;
  observed_energy_percent: number;
  observed_can_accept_tasks: boolean | "";
  observed_link_id: string;
  observed_link_status: string;
  observed_link_active: boolean | "";
  observed_link_utilization_percent: number;
  observed_link_latency_ms: number;
  observed_link_capacity_mbps: number;
  observed_link_congestion_percent: number;
  carried_traffic_mbps: number;
  demand_traffic_mbps: number;
};

type IntProcessReportEvent = {
  report_id: string;
  packet_id: string;
  task_id: string;
  probe_id: string;
  probe_type: string;
  planning_algorithm: string;
  slice_index: number;
  time: string;
  sink_node: string;
  ground_station: string;
  direct_linked_satellite: string;
  reporting_status: string;
  reporting_hops: number;
  reporting_latency_ms: number;
  reporting_path: string[];
  reporting_link_ids: string[];
  record_count: number;
  report_size_bytes: number;
  status: string;
  drop_reason: string;
  downlinked_slice: string;
  delivery_delay_slices: string;
};

type IntProcessNode = {
  node_id: string;
  label: string;
  plane: number;
  slot: number;
  observed: boolean;
  last_observed_slice: string;
  mode_estimate: string;
  cpu_percent_estimate: number;
  queue_depth_estimate: number;
  queued_traffic_mb_estimate: number;
  cache_used_mb_estimate: number;
  energy_percent_estimate: number;
  confidence: number;
};

type IntProcessLink = {
  link_id: string;
  source: string;
  target: string;
  kind: string;
  observed: boolean;
  last_observed_slice: string;
  status_estimate: string;
  active_estimate: boolean | "";
  utilization_percent_estimate: number;
  latency_ms_estimate: number;
  capacity_mbps_estimate: number;
  congestion_percent_estimate: number;
  confidence: number;
};

type IntProcessCoverage = {
  truth_node_samples: number;
  observed_node_samples: number;
  node_sample_coverage: number;
  missing_node_samples: number;
  truth_link_samples: number;
  observed_link_samples: number;
  link_sample_coverage: number;
  missing_link_samples: number;
  pass: boolean;
};

type IntProcessSlice = {
  slice_index: number;
  time: string;
  probes: IntProcessProbe[];
  hop_events: IntProcessHopEvent[];
  report_events: IntProcessReportEvent[];
  oam_reconstruction: {
    nodes: IntProcessNode[];
    links: IntProcessLink[];
    node_observed_count: number;
    link_observed_count: number;
    node_unknown_count: number;
    link_unknown_count: number;
  };
  coverage: IntProcessCoverage;
};

type IntProcessVisualization = {
  schema_version: "stage2-int-process-visualization-v1";
  generated_at: string;
  run_dir: string;
  mode: string;
  algorithm: string;
  boundary?: Record<string, unknown>;
  source_files?: Record<string, string>;
  summary: {
    slices: number;
    probes: number;
    hop_events: number;
    report_events: number;
    node_sample_coverage: number;
    link_sample_coverage: number;
    active_link_sample_coverage: number;
    full_time_step_pass: boolean;
  };
  slices: IntProcessSlice[];
};

type ProcessStageKey = "plan" | "hop" | "report" | "oam" | "validate";

const telemetryModeLabel: Record<IntTelemetryMode, string> = {
  "probe-int": "全网 probe-int",
  "traffic-int": "业务 traffic-int",
};

const processStageLabel: Record<ProcessStageKey, string> = {
  plan: "探测规划",
  hop: "逐跳采集",
  report: "报告回传",
  oam: "OAM 重构",
  validate: "检验",
};

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function compactBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function compactUnknown(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  return String(value);
}

function metricNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : compactUnknown(value);
}

function pctUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? pct(value) : "-";
}

function csvEscape(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "int-telemetry"
  );
}

function statusText(status: string) {
  if (status === "up") return "连通";
  if (status === "warning") return "告警";
  if (status === "down") return "断开";
  return "未知";
}

function scopeText(scope: string) {
  if (scope === "forwarding-hop") return "逐跳转发";
  if (scope === "local-adjacent-link") return "本地端口";
  return "未观测";
}

function isImportedExperimentManifest(value: unknown): value is ImportedExperimentManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ImportedExperimentManifest;
  return (
    candidate.schema_version === "stage2-int-experiment-run-v1" &&
    Boolean(candidate.accuracy?.probe_int) &&
    Boolean(candidate.int_pipeline?.probe_int) &&
    Boolean(candidate.stage1?.fingerprints)
  );
}

function isIntProcessVisualization(value: unknown): value is IntProcessVisualization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as IntProcessVisualization;
  return candidate.schema_version === "stage2-int-process-visualization-v1" && Array.isArray(candidate.slices);
}

function processSliceFromTelemetry(slice: IntTelemetrySlice): IntProcessSlice {
  return {
    slice_index: slice.sliceIndex,
    time: slice.time,
    probes: slice.probePaths.map((probe) => ({
      probe_id: probe.probeId,
      planning_algorithm: slice.mode,
      source: probe.source,
      sink: probe.sink,
      path_node_count: probe.path.length,
      path_link_count: Math.max(probe.path.length - 1, 0),
      covered_link_count: probe.coveredLinkCount,
      path: probe.path,
      link_ids: slice.hopRecords
        .filter((record) => record.probeId === probe.probeId && record.observationScope === "forwarding-hop" && record.observedLinkId)
        .map((record) => record.observedLinkId),
    })),
    hop_events: slice.hopRecords.map((record) => ({
      packet_id: record.packetId,
      probe_id: record.probeId,
      slice_index: record.sliceIndex,
      time: record.time,
      hop_index: record.hopIndex,
      node_id: record.nodeId,
      role: record.role,
      previous_hop: record.previousHop,
      next_hop: record.nextHop,
      ingress_link_id: record.ingressLinkId,
      egress_link_id: record.egressLinkId,
      observation_scope: record.observationScope,
      local_port_peer: record.localPortPeer,
      observed_node_mode: record.observedNodeMode,
      observed_cpu_percent: record.observedCpuPercent,
      observed_queue_depth: record.observedQueueDepth,
      observed_queued_traffic_mb: record.observedQueuedTrafficMb,
      observed_cache_used_mb: 0,
      observed_energy_percent: record.observedEnergyPercent,
      observed_can_accept_tasks: "",
      observed_link_id: record.observedLinkId,
      observed_link_status: record.observedLinkStatus,
      observed_link_active: record.observedLinkActive,
      observed_link_utilization_percent: record.observedLinkUtilizationPercent,
      observed_link_latency_ms: record.observedLinkLatencyMs,
      observed_link_capacity_mbps: record.observedLinkCapacityMbps,
      observed_link_congestion_percent: record.observedLinkCongestionPercent,
      carried_traffic_mbps: 0,
      demand_traffic_mbps: 0,
    })),
    report_events: slice.reports.map((report) => ({
      report_id: report.reportId,
      packet_id: report.packetId,
      task_id: report.probeId,
      probe_id: report.probeId,
      probe_type: slice.mode,
      planning_algorithm: slice.mode,
      slice_index: report.sliceIndex,
      time: slice.time,
      sink_node: report.sink,
      ground_station: "",
      direct_linked_satellite: report.directLinkedSatellite,
      reporting_status: report.reportingPath.length ? "planned" : "blocked",
      reporting_hops: report.reportingHops,
      reporting_latency_ms: report.reportingLatencyMs,
      reporting_path: report.reportingPath,
      reporting_link_ids: [],
      record_count: report.recordCount,
      report_size_bytes: report.reportSizeBytes,
      status: report.status,
      drop_reason: report.dropReason,
      downlinked_slice: report.status === "downlinked" ? String(report.sliceIndex) : "",
      delivery_delay_slices: report.status === "downlinked" ? "0" : "",
    })),
    oam_reconstruction: {
      nodes: slice.observedNodes.map((node) => ({
        node_id: node.nodeId,
        label: node.label,
        plane: node.plane,
        slot: node.slot,
        observed: node.observed,
        last_observed_slice: node.observed ? String(slice.sliceIndex) : "",
        mode_estimate: node.mode,
        cpu_percent_estimate: node.cpuPercent,
        queue_depth_estimate: node.queueDepth,
        queued_traffic_mb_estimate: 0,
        cache_used_mb_estimate: node.telemetryBufferMb,
        energy_percent_estimate: node.energyPercent,
        confidence: node.observed ? 1 : 0,
      })),
      links: slice.observedLinks.map((link) => ({
        link_id: link.linkId,
        source: link.source,
        target: link.target,
        kind: link.kind,
        observed: link.observed,
        last_observed_slice: link.observed ? String(slice.sliceIndex) : "",
        status_estimate: link.status,
        active_estimate: link.active,
        utilization_percent_estimate: link.utilizationPercent,
        latency_ms_estimate: link.latencyMs,
        capacity_mbps_estimate: link.capacityMbps,
        congestion_percent_estimate: link.congestionPercent,
        confidence: link.observed ? 1 : 0,
      })),
      node_observed_count: slice.observedNodeCount,
      link_observed_count: slice.observedLinkCount,
      node_unknown_count: slice.totalNodes - slice.observedNodeCount,
      link_unknown_count: slice.totalLinks - slice.observedLinkCount,
    },
    coverage: {
      truth_node_samples: slice.totalNodes,
      observed_node_samples: slice.observedNodeCount,
      node_sample_coverage: slice.nodeCoverage,
      missing_node_samples: slice.totalNodes - slice.observedNodeCount,
      truth_link_samples: slice.totalLinks,
      observed_link_samples: slice.observedLinkCount,
      link_sample_coverage: slice.linkCoverage,
      missing_link_samples: slice.totalLinks - slice.observedLinkCount,
      pass: slice.telemetryComplete,
    },
  };
}

function processToTelemetrySlice(processSlice: IntProcessSlice, fallback: IntTelemetrySlice): IntTelemetrySlice {
  return {
    ...fallback,
    sliceIndex: processSlice.slice_index,
    time: processSlice.time || fallback.time,
    probePaths: processSlice.probes.map((probe) => ({
      probeId: probe.probe_id,
      source: probe.source,
      sink: probe.sink,
      path: probe.path,
      mode: "probe-int",
      coveredNodeCount: probe.path_node_count,
      coveredLinkCount: probe.covered_link_count,
    })),
    hopRecords: processSlice.hop_events.map((event) => ({
      packetId: event.packet_id,
      probeId: event.probe_id,
      sliceIndex: event.slice_index,
      time: event.time,
      hopIndex: event.hop_index,
      nodeId: event.node_id,
      role: event.role as IntHopObservation["role"],
      previousHop: event.previous_hop,
      nextHop: event.next_hop,
      ingressLinkId: event.ingress_link_id,
      egressLinkId: event.egress_link_id,
      observationScope: event.observation_scope as IntHopObservation["observationScope"],
      localPortPeer: event.local_port_peer,
      observedLinkId: event.observed_link_id,
      observedNodeMode: event.observed_node_mode,
      observedCpuPercent: event.observed_cpu_percent,
      observedQueueDepth: event.observed_queue_depth,
      observedQueuedTrafficMb: event.observed_queued_traffic_mb,
      observedEnergyPercent: event.observed_energy_percent,
      observedLinkStatus: event.observed_link_status,
      observedLinkActive: event.observed_link_active,
      observedLinkUtilizationPercent: event.observed_link_utilization_percent,
      observedLinkLatencyMs: event.observed_link_latency_ms,
      observedLinkCapacityMbps: event.observed_link_capacity_mbps,
      observedLinkCongestionPercent: event.observed_link_congestion_percent,
    })),
    reports: processSlice.report_events.map((event) => ({
      reportId: event.report_id,
      packetId: event.packet_id,
      probeId: event.probe_id,
      sliceIndex: event.slice_index,
      source: processSlice.probes.find((probe) => probe.probe_id === event.probe_id)?.source ?? "",
      sink: event.sink_node,
      recordCount: event.record_count,
      reportSizeBytes: event.report_size_bytes,
      directLinkedSatellite: event.direct_linked_satellite,
      reportingPath: event.reporting_path,
      reportingHops: event.reporting_hops,
      reportingLatencyMs: event.reporting_latency_ms,
      status: event.status === "downlinked" ? "downlinked" : event.status === "dropped" ? "dropped" : "queued",
      dropReason: event.drop_reason,
    })),
    deliveredReports: processSlice.report_events
      .filter((event) => event.status === "downlinked")
      .map((event) => ({
        reportId: event.report_id,
        packetId: event.packet_id,
        probeId: event.probe_id,
        sliceIndex: event.slice_index,
        source: processSlice.probes.find((probe) => probe.probe_id === event.probe_id)?.source ?? "",
        sink: event.sink_node,
        recordCount: event.record_count,
        reportSizeBytes: event.report_size_bytes,
        directLinkedSatellite: event.direct_linked_satellite,
        reportingPath: event.reporting_path,
        reportingHops: event.reporting_hops,
        reportingLatencyMs: event.reporting_latency_ms,
        status: "downlinked",
        dropReason: event.drop_reason,
      })),
    queuedReports: processSlice.report_events
      .filter((event) => event.status !== "downlinked")
      .map((event) => ({
        reportId: event.report_id,
        packetId: event.packet_id,
        probeId: event.probe_id,
        sliceIndex: event.slice_index,
        source: processSlice.probes.find((probe) => probe.probe_id === event.probe_id)?.source ?? "",
        sink: event.sink_node,
        recordCount: event.record_count,
        reportSizeBytes: event.report_size_bytes,
        directLinkedSatellite: event.direct_linked_satellite,
        reportingPath: event.reporting_path,
        reportingHops: event.reporting_hops,
        reportingLatencyMs: event.reporting_latency_ms,
        status: event.status === "dropped" ? "dropped" : "queued",
        dropReason: event.drop_reason,
      })),
    observedNodes: processSlice.oam_reconstruction.nodes.map((node) => ({
      nodeId: node.node_id,
      label: node.label,
      plane: node.plane,
      slot: node.slot,
      observed: node.observed,
      mode: node.mode_estimate,
      cpuPercent: node.cpu_percent_estimate,
      queueDepth: node.queue_depth_estimate,
      energyPercent: node.energy_percent_estimate,
      telemetryBufferMb: node.cache_used_mb_estimate,
      sourceReports: processSlice.hop_events.filter((event) => event.node_id === node.node_id && event.role === "source").length,
      transitReports: processSlice.hop_events.filter((event) => event.node_id === node.node_id && event.role === "transit").length,
      sinkReports: processSlice.hop_events.filter((event) => event.node_id === node.node_id && event.role === "sink").length,
    })),
    observedLinks: processSlice.oam_reconstruction.links.map((link) => ({
      linkId: link.link_id,
      source: link.source,
      target: link.target,
      kind: link.kind,
      observed: link.observed,
      scope: link.observed ? "local-adjacent-link" : "unknown",
      status: link.status_estimate,
      active: link.active_estimate,
      utilizationPercent: link.utilization_percent_estimate,
      latencyMs: link.latency_ms_estimate,
      capacityMbps: link.capacity_mbps_estimate,
      congestionPercent: link.congestion_percent_estimate,
      restrictionReason: "",
    })),
    nodeCoverage: processSlice.coverage.node_sample_coverage,
    linkCoverage: processSlice.coverage.link_sample_coverage,
    observedNodeCount: processSlice.coverage.observed_node_samples,
    observedLinkCount: processSlice.coverage.observed_link_samples,
    totalNodes: processSlice.coverage.truth_node_samples,
    totalLinks: processSlice.coverage.truth_link_samples,
    reportBytes: processSlice.report_events.reduce((total, report) => total + report.report_size_bytes, 0),
    telemetryComplete: processSlice.coverage.pass,
  };
}

function TelemetryMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <section className={`telemetry-metric ${tone ?? ""}`}>
      <div className="telemetry-metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function OfflineExperimentPanel({
  manifest,
  manifestName,
  error,
  process,
  processName,
  processError,
  onUpload,
  onClear,
  onProcessUpload,
  onProcessClear,
}: {
  manifest: ImportedExperimentManifest | null;
  manifestName: string;
  error: string;
  process: IntProcessVisualization | null;
  processName: string;
  processError: string;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  onProcessUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onProcessClear: () => void;
}) {
  const trafficAccuracy = manifest?.accuracy?.traffic_int;
  const probeAccuracy = manifest?.accuracy?.probe_int;
  const trafficPipeline = manifest?.int_pipeline?.traffic_int;
  const probePipeline = manifest?.int_pipeline?.probe_int;
  const reporting = manifest?.int_pipeline?.reporting;
  const audit = manifest?.int_pipeline?.full_coverage_audit;
  const pathBalance = manifest?.int_pipeline?.probe_planning?.algorithms?.["path-balance"];
  const fingerprints = manifest?.stage1?.fingerprints ?? {};
  const counts = manifest?.stage1?.counts ?? {};
  const boundary = manifest?.boundary ?? {};
  const verification = manifest?.verification;
  const verificationPassed = verification?.pass === true;

  return (
    <section className="telemetry-manifest-panel module-section">
      <div className="telemetry-manifest-header">
        <div>
          <span className="section-kicker">Offline Experiment</span>
          <h2>离线 INT 实验结果导入</h2>
          <p>导入 `npm run int:experiment` 生成的 manifest，展示正式实验的全网感知覆盖率和真值检验结果。</p>
        </div>
        <div className="telemetry-manifest-actions">
          <label className="telemetry-manifest-upload">
            <Upload size={16} />
            导入 Manifest
            <input type="file" accept=".json,application/json" onChange={onUpload} />
          </label>
          <label className="telemetry-manifest-upload">
            <Upload size={16} />
            导入过程包
            <input type="file" accept=".json,application/json" onChange={onProcessUpload} />
          </label>
          {manifest ? (
            <>
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `int-experiment-${safeFilePart(manifestName || "manifest")}.json`,
                    JSON.stringify(manifest, null, 2),
                    "application/json",
                  )
                }
              >
                <Download size={16} />
                下载副本
              </button>
              <button type="button" onClick={onClear}>
                清除
              </button>
            </>
          ) : null}
          {process ? (
            <button type="button" onClick={onProcessClear}>
              清除过程包
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="telemetry-manifest-error">{error}</div> : null}
      {processError ? <div className="telemetry-manifest-error">{processError}</div> : null}

      {manifest ? (
        <>
          <div className="telemetry-manifest-summary">
            <div>
              <span>实验文件</span>
              <strong>{manifestName}</strong>
            </div>
            <div>
              <span>业务数据集</span>
              <strong>{compactUnknown(manifest.input?.tasks_snapshot_path ?? manifest.input?.tasks_path)}</strong>
            </div>
            <div>
              <span>轨道 / 模式 / 算法</span>
              <strong>
                {compactUnknown(manifest.input?.orbit)} / {compactUnknown(manifest.input?.mode)} / {compactUnknown(manifest.input?.algorithm)}
              </strong>
            </div>
            <div>
              <span>生成时间</span>
              <strong>{compactUnknown(manifest.generated_at)}</strong>
            </div>
            <div>
              <span>过程包</span>
              <strong>{process ? processName : "未导入"}</strong>
            </div>
          </div>

          <div className="telemetry-manifest-grid">
            <TelemetryMetric icon={<FileText size={20} />} label="Traffic 报告" value={metricNumber(trafficPipeline?.reports)} />
            <TelemetryMetric icon={<Workflow size={20} />} label="Traffic Hop" value={metricNumber(trafficPipeline?.hopRecords)} />
            <TelemetryMetric icon={<FileText size={20} />} label="Probe 报告" value={metricNumber(probePipeline?.reports)} tone="good" />
            <TelemetryMetric icon={<Workflow size={20} />} label="Probe Hop" value={metricNumber(probePipeline?.hopRecords)} tone="good" />
            <TelemetryMetric icon={<Route size={20} />} label="Probe Paths" value={metricNumber(probePipeline?.probePaths)} />
            <TelemetryMetric icon={<Send size={20} />} label="回传阻塞路径" value={metricNumber(reporting?.blockedReportingPaths)} tone={reporting?.blockedReportingPaths === 0 ? "good" : "warn"} />
            <TelemetryMetric icon={<RadioTower size={20} />} label="Path-balance 覆盖" value={pctUnknown(pathBalance?.linkCoverage)} tone={pathBalance?.linkCoverage === 1 ? "good" : "warn"} />
            <TelemetryMetric icon={<CheckCircle2 size={20} />} label="逐时间片审计" value={`${compactUnknown(audit?.passedSlices)}/${compactUnknown(audit?.slices)}`} tone={audit?.pass ? "good" : "warn"} />
            <TelemetryMetric
              icon={<CheckCircle2 size={20} />}
              label="实验验收"
              value={verification ? `${verificationPassed ? "通过" : "未通过"} ${compactUnknown(verification.passed)}/${compactUnknown(verification.checks)}` : "未写入"}
              tone={verification ? (verificationPassed ? "good" : "bad") : "warn"}
            />
            <TelemetryMetric
              icon={<Workflow size={20} />}
              label="过程包时间片"
              value={process ? `${process.summary.slices}` : "未导入"}
              tone={process ? "good" : "warn"}
            />
          </div>

          <div className="telemetry-manifest-body">
            <div className="telemetry-manifest-card">
              <h3>第一阶段真值指纹</h3>
              <dl>
                <dt>config</dt>
                <dd>{compactUnknown(fingerprints.config)}</dd>
                <dt>dataset</dt>
                <dd>{compactUnknown(fingerprints.dataset)}</dd>
                <dt>truth</dt>
                <dd>{compactUnknown(fingerprints.truth)}</dd>
                <dt>节点 / 链路 / 路由</dt>
                <dd>
                  {compactUnknown(counts.nodes)} / {compactUnknown(counts.links)} / {compactUnknown(counts.routes)}
                </dd>
              </dl>
            </div>

            <div className="telemetry-manifest-card">
              <h3>边界约束</h3>
              <dl>
                <dt>运行时使用真值</dt>
                <dd>{compactUnknown(boundary.stage1_truth_used_for_runtime)}</dd>
                <dt>真值仅用于检验</dt>
                <dd>{compactUnknown(boundary.truth_used_only_for_validation)}</dd>
                <dt>OAM 只用已下传报告</dt>
                <dd>{compactUnknown(boundary.ground_oam_uses_only_delivered_reports)}</dd>
                <dt>unknown 不补齐</dt>
                <dd>{compactUnknown(boundary.unknown_not_filled_from_truth)}</dd>
              </dl>
            </div>

            <div className="telemetry-manifest-card">
              <h3>实验验收</h3>
              <dl>
                <dt>验收状态</dt>
                <dd>{verification ? (verificationPassed ? "通过" : "未通过") : "manifest 未写入验收摘要"}</dd>
                <dt>检查项</dt>
                <dd>
                  {compactUnknown(verification?.passed)} / {compactUnknown(verification?.checks)}
                </dd>
                <dt>验收时间</dt>
                <dd>{compactUnknown(verification?.verified_at)}</dd>
                <dt>验收报告</dt>
                <dd>{compactUnknown(verification?.report_md ?? manifest.outputs?.verification_md)}</dd>
                <dt>文件索引</dt>
                <dd>{compactUnknown(verification?.file_index_md ?? manifest.outputs?.file_index_md)}</dd>
              </dl>
            </div>
          </div>

          <div className="table-wrap telemetry-manifest-table">
            <table>
              <thead>
                <tr>
                  <th>模式</th>
                  <th>节点覆盖</th>
                  <th>链路覆盖</th>
                  <th>活动链路覆盖</th>
                  <th>CPU MAE</th>
                  <th>队列 MAE</th>
                  <th>电量 MAE</th>
                  <th>模式准确率</th>
                  <th>链路状态准确率</th>
                  <th>Unknown 节点</th>
                  <th>Unknown 链路</th>
                  <th>逐时间片</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["traffic-int", trafficAccuracy],
                  ["probe-int", probeAccuracy],
                ].map(([label, accuracy]) => {
                  const item = accuracy as ImportedExperimentAccuracy | undefined;
                  return (
                    <tr key={String(label)}>
                      <td>{String(label)}</td>
                      <td>{pctUnknown(item?.node_sample_coverage)}</td>
                      <td>{pctUnknown(item?.link_sample_coverage)}</td>
                      <td>{pctUnknown(item?.active_link_sample_coverage)}</td>
                      <td>{compactUnknown(item?.cpu_mae)}</td>
                      <td>{compactUnknown(item?.queue_depth_mae)}</td>
                      <td>{compactUnknown(item?.energy_percent_mae)}</td>
                      <td>{pctUnknown(item?.mode_accuracy)}</td>
                      <td>{pctUnknown(item?.link_status_accuracy)}</td>
                      <td>{compactUnknown(item?.unknown_node_samples)}</td>
                      <td>{compactUnknown(item?.unknown_link_samples)}</td>
                      <td>
                        {item?.full_time_step_pass === undefined
                          ? "-"
                          : `${item.full_time_step_pass ? "通过" : "未通过"} ${compactUnknown(item.passed_slices)}/${compactUnknown(
                              (item.passed_slices ?? 0) + (item.failed_slices ?? 0),
                            )}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="telemetry-manifest-paths">
            <span>输出目录</span>
            <code>{compactUnknown(manifest.outputs?.stage2_int_dir)}</code>
            <span>Probe OAM</span>
            <code>{compactUnknown(manifest.outputs?.probe_ground_oam_dir)}</code>
            <span>业务快照</span>
            <code>{compactUnknown(manifest.input?.tasks_snapshot_path ?? manifest.input?.tasks_path)}</code>
            <span>原始路径</span>
            <code>{compactUnknown(manifest.input?.original_tasks_path)}</code>
            <span>输入校验</span>
            <code>{compactUnknown(manifest.outputs?.input_validation_md ?? manifest.outputs?.input_validation_json)}</code>
            <span>实验说明</span>
            <code>{compactUnknown(manifest.outputs?.readme_md)}</code>
            <span>交付清单</span>
            <code>{compactUnknown(manifest.outputs?.deliverables_md ?? manifest.outputs?.deliverables_json)}</code>
            <span>准确率报告</span>
            <code>{compactUnknown(manifest.outputs?.accuracy_report_md ?? manifest.outputs?.accuracy_report_json)}</code>
            <span>文件索引</span>
            <code>{compactUnknown(manifest.outputs?.file_index_md ?? verification?.file_index_md)}</code>
            <span>过程包</span>
            <code>{compactUnknown(manifest.outputs?.process_visualization_json)}</code>
          </div>

          {!process ? (
            <div className="telemetry-manifest-empty">
              <Workflow size={22} />
              <span>已导入 manifest。若要查看正式离线实验的逐 probe、逐 hop、Ground OAM 重构过程，请继续导入同一 run 目录下的 int-process-visualization.json。</span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="telemetry-manifest-empty">
          <FileText size={22} />
          <span>尚未导入离线实验 manifest。页面上方仍展示浏览器实时生成的 INT 演示结果。</span>
        </div>
      )}
    </section>
  );
}

function downloadTelemetryDataset(
  kind: "hops" | "reports" | "nodes" | "links" | "validation" | "evaluation-json" | "probe-plan" | "coverage" | "process-json",
  run: ReturnType<typeof buildIntTelemetryRun>,
  datasetName: string,
  process?: IntProcessVisualization | null,
) {
  const baseName = `int-${run.mode}-${safeFilePart(datasetName)}`;
  const processSlices = process?.slices ?? run.slices.map(processSliceFromTelemetry);

  if (kind === "process-json") {
    const processJson =
      process ??
      ({
        schema_version: "stage2-int-process-visualization-v1",
        generated_at: new Date().toISOString(),
        run_dir: "dashboard-live",
        mode: run.mode,
        algorithm: run.mode,
        boundary: {
          process_view_uses_truth_for_state: false,
          truth_used_only_for_validation: true,
        },
        summary: {
          slices: processSlices.length,
          probes: processSlices.reduce((total, slice) => total + slice.probes.length, 0),
          hop_events: processSlices.reduce((total, slice) => total + slice.hop_events.length, 0),
          report_events: processSlices.reduce((total, slice) => total + slice.report_events.length, 0),
          node_sample_coverage: run.nodeSampleCoverage,
          link_sample_coverage: run.linkSampleCoverage,
          active_link_sample_coverage: run.activeLinkSampleCoverage,
          full_time_step_pass: run.failedSlices === 0,
        },
        slices: processSlices,
      } satisfies IntProcessVisualization);
    downloadTextFile(`${baseName}-process-visualization.json`, JSON.stringify(processJson, null, 2), "application/json");
    return;
  }

  if (kind === "probe-plan") {
    const rows = processSlices.flatMap((slice) =>
      slice.probes.map((probe) => ({
        slice_index: slice.slice_index,
        time: slice.time,
        probe_id: probe.probe_id,
        planning_algorithm: probe.planning_algorithm,
        source: probe.source,
        sink: probe.sink,
        path_node_count: probe.path_node_count,
        path_link_count: probe.path_link_count,
        covered_link_count: probe.covered_link_count,
        path: probe.path.join(" > "),
        link_ids: probe.link_ids.join(" > "),
      })),
    );
    downloadTextFile(`${baseName}-probe-plan.csv`, rowsToCsv(rows), "text/csv");
    return;
  }

  if (kind === "coverage") {
    const rows = processSlices.map((slice) => ({
      slice_index: slice.slice_index,
      time: slice.time,
      node_sample_coverage: slice.coverage.node_sample_coverage,
      link_sample_coverage: slice.coverage.link_sample_coverage,
      missing_node_samples: slice.coverage.missing_node_samples,
      missing_link_samples: slice.coverage.missing_link_samples,
      pass: slice.coverage.pass,
      probes: slice.probes.length,
      hop_events: slice.hop_events.length,
      reports: slice.report_events.length,
    }));
    downloadTextFile(`${baseName}-coverage-by-slice.csv`, rowsToCsv(rows), "text/csv");
    return;
  }

  if (kind === "evaluation-json") {
    downloadTextFile(
      `${baseName}-evaluation.json`,
      JSON.stringify(
        {
          schema_version: "dashboard-int-telemetry-evaluation-v1",
          mode: run.mode,
          generated_at: new Date().toISOString(),
          boundary: {
            telemetry_runtime_view: "delivered INT reports and OAM reconstruction",
            truth_used_only_for_validation: true,
          },
          summary: {
            total_reports: run.totalReports,
            delivered_reports: run.deliveredReports,
            total_hop_records: run.totalHopRecords,
            total_report_bytes: run.totalReportBytes,
            node_sample_coverage: run.nodeSampleCoverage,
            link_sample_coverage: run.linkSampleCoverage,
            active_link_sample_coverage: run.activeLinkSampleCoverage,
            node_cpu_mae: run.nodeCpuMae,
            node_energy_mae: run.nodeEnergyMae,
            node_queue_mae: run.nodeQueueMae,
            node_mode_accuracy: run.nodeModeAccuracy,
            unknown_node_samples: run.unknownNodeSamples,
            complete_slices: run.completeSlices,
            failed_slices: run.failedSlices,
          },
          slices: run.slices.map((slice) => ({
            slice_index: slice.sliceIndex,
            time: slice.time,
            node_coverage: slice.nodeCoverage,
            link_coverage: slice.linkCoverage,
            node_cpu_mae: slice.nodeCpuMae,
            node_energy_mae: slice.nodeEnergyMae,
            node_queue_mae: slice.nodeQueueMae,
            node_mode_accuracy: slice.nodeModeAccuracy,
            unknown_node_count: slice.unknownNodeCount,
          })),
        },
        null,
        2,
      ),
      "application/json",
    );
    return;
  }

  const rows =
    kind === "hops"
      ? run.slices.flatMap((slice) =>
          slice.hopRecords.map((record) => ({
            packet_id: record.packetId,
            probe_id: record.probeId,
            slice_index: record.sliceIndex,
            time: record.time,
            hop_index: record.hopIndex,
            node_id: record.nodeId,
            role: record.role,
            previous_hop: record.previousHop,
            next_hop: record.nextHop,
            observation_scope: record.observationScope,
            observed_link_id: record.observedLinkId,
            observed_cpu_percent: record.observedCpuPercent,
            observed_queue_depth: record.observedQueueDepth,
            observed_energy_percent: record.observedEnergyPercent,
            observed_link_status: record.observedLinkStatus,
            observed_link_active: record.observedLinkActive,
            observed_link_utilization_percent: record.observedLinkUtilizationPercent,
          })),
        )
      : kind === "reports"
        ? run.slices.flatMap((slice) =>
            slice.reports.map((report) => ({
              report_id: report.reportId,
              packet_id: report.packetId,
              probe_id: report.probeId,
              slice_index: report.sliceIndex,
              source: report.source,
              sink: report.sink,
              record_count: report.recordCount,
              report_size_bytes: report.reportSizeBytes,
              direct_linked_satellite: report.directLinkedSatellite,
              reporting_hops: report.reportingHops,
              reporting_latency_ms: report.reportingLatencyMs,
              status: report.status,
              reporting_path: report.reportingPath.join(" > "),
            })),
          )
        : kind === "nodes"
          ? run.slices.flatMap((slice) =>
              slice.observedNodes.map((node) => ({
                slice_index: slice.sliceIndex,
                time: slice.time,
                node_id: node.nodeId,
                observed: node.observed,
                mode_estimate: node.mode,
                cpu_percent_estimate: node.cpuPercent,
                queue_depth_estimate: node.queueDepth,
                energy_percent_estimate: node.energyPercent,
                telemetry_buffer_mb_estimate: node.telemetryBufferMb,
                source_reports: node.sourceReports,
                transit_reports: node.transitReports,
                sink_reports: node.sinkReports,
              })),
            )
          : kind === "links"
            ? run.slices.flatMap((slice) =>
                slice.observedLinks.map((link) => ({
                  slice_index: slice.sliceIndex,
                  time: slice.time,
                  link_id: link.linkId,
                  source: link.source,
                  target: link.target,
                  observed: link.observed,
                  observation_scope: link.scope,
                  status_estimate: link.status,
                  active_estimate: link.active,
                  utilization_percent_estimate: link.utilizationPercent,
                  latency_ms_estimate: link.latencyMs,
                  capacity_mbps_estimate: link.capacityMbps,
                  congestion_percent_estimate: link.congestionPercent,
                  restriction_reason: link.restrictionReason,
                })),
              )
            : run.slices.flatMap((slice) =>
                slice.nodeValidation.map((entry) => ({
                  slice_index: slice.sliceIndex,
                  time: slice.time,
                  node_id: entry.nodeId,
                  observed: entry.observed,
                  truth_mode: entry.truthMode,
                  observed_mode: entry.observedMode,
                  mode_match: entry.modeMatch,
                  truth_cpu_percent: entry.truthCpuPercent,
                  observed_cpu_percent: entry.observedCpuPercent,
                  cpu_error_percent: entry.cpuErrorPercent,
                  truth_queue_depth: entry.truthQueueDepth,
                  observed_queue_depth: entry.observedQueueDepth,
                  queue_depth_error: entry.queueDepthError,
                  truth_energy_percent: entry.truthEnergyPercent,
                  observed_energy_percent: entry.observedEnergyPercent,
                  energy_error_percent: entry.energyErrorPercent,
                })),
              );

  const suffix =
    kind === "hops"
      ? "hop-records"
      : kind === "reports"
        ? "reports"
        : kind === "nodes"
          ? "oam-reconstructed-nodes"
          : kind === "links"
            ? "oam-reconstructed-links"
            : "node-truth-validation";
  downloadTextFile(`${baseName}-${suffix}.csv`, rowsToCsv(rows), "text/csv");
}

function TelemetryDownloadPanel({
  run,
  datasetName,
  process,
}: {
  run: ReturnType<typeof buildIntTelemetryRun>;
  datasetName: string;
  process: IntProcessVisualization | null;
}) {
  return (
    <section className="telemetry-download-panel module-section">
      <div>
        <span className="section-kicker">Export</span>
        <h2>遥测结果数据集下载</h2>
      </div>
      <div className="telemetry-download-actions">
        <button type="button" onClick={() => downloadTelemetryDataset("probe-plan", run, datasetName, process)}>
          <Download size={16} />Probe Plan
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("hops", run, datasetName, process)}>
          <Download size={16} />Hop Records
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("reports", run, datasetName, process)}>
          <Download size={16} />INT Reports
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("nodes", run, datasetName, process)}>
          <Download size={16} />OAM 节点
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("links", run, datasetName, process)}>
          <Download size={16} />OAM 链路
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("coverage", run, datasetName, process)}>
          <Download size={16} />覆盖率
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("process-json", run, datasetName, process)}>
          <Download size={16} />过程 JSON
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("validation", run, datasetName, process)}>
          <Download size={16} />节点真值对照
        </button>
        <button type="button" onClick={() => downloadTelemetryDataset("evaluation-json", run, datasetName, process)}>
          <Download size={16} />评估 JSON
        </button>
      </div>
    </section>
  );
}

function NodeValidationPanel({
  run,
  telemetrySlice,
}: {
  run: ReturnType<typeof buildIntTelemetryRun>;
  telemetrySlice: IntTelemetrySlice;
}) {
  const rows = telemetrySlice.nodeValidation;
  return (
    <section className="telemetry-validation-panel module-section">
      <div className="section-title-row">
        <div>
          <span className="section-kicker">Validation</span>
          <h2>第一阶段真值对照检验</h2>
        </div>
        <div className="section-status">真值仅用于实验后评估，不进入 INT 运行视角</div>
      </div>
      <div className="telemetry-validation-grid">
        <TelemetryMetric icon={<Cpu size={20} />} label="全局 CPU MAE" value={`${run.nodeCpuMae.toFixed(3)}%`} tone={run.nodeCpuMae === 0 ? "good" : "warn"} />
        <TelemetryMetric icon={<Activity size={20} />} label="全局队列 MAE" value={run.nodeQueueMae.toFixed(3)} tone={run.nodeQueueMae === 0 ? "good" : "warn"} />
        <TelemetryMetric icon={<Satellite size={20} />} label="模式准确率" value={pct(run.nodeModeAccuracy)} tone={run.nodeModeAccuracy === 1 ? "good" : "warn"} />
        <TelemetryMetric icon={<CircleDashed size={20} />} label="未知节点样本" value={run.unknownNodeSamples.toLocaleString()} tone={run.unknownNodeSamples === 0 ? "good" : "warn"} />
      </div>
      <div className="telemetry-validation-current">
        <strong>T{telemetrySlice.sliceIndex.toString().padStart(2, "0")} 当前片检验</strong>
        <span>
          CPU MAE {telemetrySlice.nodeCpuMae.toFixed(3)}% / 电量 MAE {telemetrySlice.nodeEnergyMae.toFixed(3)}% / 队列 MAE{" "}
          {telemetrySlice.nodeQueueMae.toFixed(3)} / 模式准确率 {pct(telemetrySlice.nodeModeAccuracy)} / unknown{" "}
          {telemetrySlice.unknownNodeCount}
        </span>
      </div>
      <div className="table-wrap telemetry-validation-table">
        <table>
          <thead>
            <tr>
              <th>节点</th>
              <th>观测</th>
              <th>模式 真值/遥测</th>
              <th>CPU 真值/遥测/误差</th>
              <th>电量 真值/遥测/误差</th>
              <th>队列 真值/遥测/误差</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 16).map((entry: IntNodeValidation) => (
              <tr key={entry.nodeId}>
                <td>{entry.nodeId}</td>
                <td>{entry.observed ? "observed" : "unknown"}</td>
                <td>
                  {entry.truthMode} / {entry.observedMode}
                </td>
                <td>
                  {entry.truthCpuPercent.toFixed(1)} / {entry.observedCpuPercent === "" ? "-" : Number(entry.observedCpuPercent).toFixed(1)} /{" "}
                  {entry.cpuErrorPercent === "" ? "-" : Number(entry.cpuErrorPercent).toFixed(3)}
                </td>
                <td>
                  {entry.truthEnergyPercent.toFixed(1)} /{" "}
                  {entry.observedEnergyPercent === "" ? "-" : Number(entry.observedEnergyPercent).toFixed(1)} /{" "}
                  {entry.energyErrorPercent === "" ? "-" : Number(entry.energyErrorPercent).toFixed(3)}
                </td>
                <td>
                  {entry.truthQueueDepth} / {entry.observedQueueDepth === "" ? "-" : entry.observedQueueDepth} /{" "}
                  {entry.queueDepthError === "" ? "-" : Number(entry.queueDepthError).toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TelemetryProcess({ slice }: { slice: IntTelemetrySlice }) {
  const stages = [
    {
      icon: <Route size={18} />,
      label: "路径规划",
      value: `${slice.probePaths.length} 条`,
      detail: `T${String(slice.sliceIndex).padStart(2, "0")} 拓扑快照`,
      tone: "good" as const,
    },
    {
      icon: <Workflow size={18} />,
      label: "逐跳采集",
      value: `${slice.hopRecords.length} 条记录`,
      detail: `${slice.observedNodeCount}/${slice.totalNodes} 节点`,
      tone: slice.nodeCoverage === 1 ? "good" as const : "warn" as const,
    },
    {
      icon: <FileText size={18} />,
      label: "Sink 报告",
      value: `${slice.reports.length} 份`,
      detail: compactBytes(slice.reportBytes),
      tone: "good" as const,
    },
    {
      icon: <Send size={18} />,
      label: "报告回传",
      value: `${slice.deliveredReports.length}/${slice.reports.length}`,
      detail: `${compactBytes(slice.downlinkBudgetBytes)} 预算`,
      tone: slice.queuedReports.length === 0 ? "good" as const : "warn" as const,
    },
    {
      icon: <CheckCircle2 size={18} />,
      label: "OAM 重构",
      value: `${pct(slice.linkCoverage)}`,
      detail: `${slice.observedLinkCount}/${slice.totalLinks} 链路`,
      tone: slice.telemetryComplete ? "good" as const : "warn" as const,
    },
  ];

  return (
    <section className="telemetry-process">
      {stages.map((stage, index) => (
        <div key={stage.label} className={`telemetry-stage ${stage.tone}`}>
          <div className="telemetry-stage-icon">{stage.icon}</div>
          <div>
            <span>{stage.label}</span>
            <strong>{stage.value}</strong>
            <small>{stage.detail}</small>
          </div>
          {index < stages.length - 1 ? <i aria-hidden="true" /> : null}
        </div>
      ))}
    </section>
  );
}

function ProcessStageTimeline({
  processSlice,
  currentStage,
  onStageChange,
}: {
  processSlice: IntProcessSlice;
  currentStage: ProcessStageKey;
  onStageChange: (stage: ProcessStageKey) => void;
}) {
  const stages: { key: ProcessStageKey; icon: React.ReactNode; value: string; detail: string; tone: "good" | "warn" }[] = [
    {
      key: "plan",
      icon: <Route size={18} />,
      value: `${processSlice.probes.length} 条 probe`,
      detail: `${processSlice.probes.reduce((total, probe) => total + probe.covered_link_count, 0)} 条覆盖链路`,
      tone: processSlice.probes.length > 0 ? "good" : "warn",
    },
    {
      key: "hop",
      icon: <Workflow size={18} />,
      value: `${processSlice.hop_events.length} 条 hop`,
      detail: `${processSlice.hop_events.filter((event) => event.observation_scope === "local-adjacent-link").length} 条本地端口扫描`,
      tone: processSlice.hop_events.length > 0 ? "good" : "warn",
    },
    {
      key: "report",
      icon: <FileText size={18} />,
      value: `${processSlice.report_events.filter((report) => report.status === "downlinked").length}/${processSlice.report_events.length}`,
      detail: "已下传 / 已生成",
      tone: processSlice.report_events.every((report) => report.status === "downlinked") ? "good" : "warn",
    },
    {
      key: "oam",
      icon: <Send size={18} />,
      value: `${processSlice.oam_reconstruction.node_observed_count}/${processSlice.coverage.truth_node_samples}`,
      detail: `${processSlice.oam_reconstruction.link_observed_count}/${processSlice.coverage.truth_link_samples} 链路`,
      tone: processSlice.coverage.pass ? "good" : "warn",
    },
    {
      key: "validate",
      icon: <CheckCircle2 size={18} />,
      value: processSlice.coverage.pass ? "通过" : "缺失",
      detail: `节点 ${pct(processSlice.coverage.node_sample_coverage)} / 链路 ${pct(processSlice.coverage.link_sample_coverage)}`,
      tone: processSlice.coverage.pass ? "good" : "warn",
    },
  ];

  return (
    <section className="process-timeline module-section">
      <div className="section-title-row">
        <div>
          <span className="section-kicker">INT Process</span>
          <h2>T{String(processSlice.slice_index).padStart(2, "0")} 遥测过程时间线</h2>
        </div>
        <div className="section-status">当前阶段：{processStageLabel[currentStage]}</div>
      </div>
      <div className="process-stage-track">
        {stages.map((stage) => (
          <button
            key={stage.key}
            type="button"
            className={`process-stage-card ${stage.tone} ${currentStage === stage.key ? "active" : ""}`}
            onClick={() => onStageChange(stage.key)}
          >
            <span className="telemetry-stage-icon">{stage.icon}</span>
            <span>{processStageLabel[stage.key]}</span>
            <strong>{stage.value}</strong>
            <small>{stage.detail}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function CoverageHeatmap({
  slices,
  currentSliceIndex,
  onSelect,
}: {
  slices: IntProcessSlice[];
  currentSliceIndex: number;
  onSelect: (sliceIndex: number) => void;
}) {
  return (
    <section className="coverage-heatmap module-section">
      <div className="section-title-row">
        <div>
          <span className="section-kicker">Coverage</span>
          <h2>逐时间片覆盖率热力图</h2>
        </div>
        <div className="section-status">绿色表示该时间片 Ground OAM 已完成全网重构</div>
      </div>
      <div className="coverage-grid" role="list">
        {slices.map((slice) => {
          const coverage = Math.min(slice.coverage.node_sample_coverage, slice.coverage.link_sample_coverage);
          const tone = coverage >= 1 ? "good" : coverage >= 0.8 ? "warn" : "bad";
          return (
            <button
              key={slice.slice_index}
              type="button"
              className={`coverage-cell ${tone} ${slice.slice_index === currentSliceIndex ? "active" : ""}`}
              onClick={() => onSelect(slice.slice_index)}
            >
              <strong>T{String(slice.slice_index).padStart(2, "0")}</strong>
              <span>{pct(coverage)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProbeProcessPanel({
  processSlice,
  selectedProbeId,
  selectedHopKey,
  onProbeSelect,
  onHopSelect,
}: {
  processSlice: IntProcessSlice;
  selectedProbeId: string;
  selectedHopKey: string;
  onProbeSelect: (probeId: string) => void;
  onHopSelect: (event: IntProcessHopEvent) => void;
}) {
  const selectedProbe = processSlice.probes.find((probe) => probe.probe_id === selectedProbeId) ?? processSlice.probes[0];
  const hopEvents = processSlice.hop_events
    .filter((event) => !selectedProbe || event.probe_id === selectedProbe.probe_id)
    .slice(0, 80);
  const selectedHop = processSlice.hop_events.find((event) => `${event.probe_id}-${event.hop_index}-${event.observation_scope}-${event.observed_link_id}` === selectedHopKey) ?? hopEvents[0];

  return (
    <section className="process-detail-grid">
      <div className="process-card">
        <div className="section-heading">
          <Route size={18} />
          <h2>Probe 探测路径</h2>
        </div>
        <div className="probe-list">
          {processSlice.probes.slice(0, 16).map((probe) => (
            <button
              key={probe.probe_id}
              type="button"
              className={selectedProbe?.probe_id === probe.probe_id ? "active" : ""}
              onClick={() => onProbeSelect(probe.probe_id)}
            >
              <strong>{probe.probe_id}</strong>
              <span>{`${probe.source} -> ${probe.sink}`}</span>
              <small>{probe.path_node_count} 节点 / {probe.covered_link_count} 链路</small>
            </button>
          ))}
        </div>
      </div>

      <div className="process-card">
        <div className="section-heading">
          <Workflow size={18} />
          <h2>逐跳 INT Metadata</h2>
        </div>
        {selectedProbe ? (
          <div className="probe-path-text">
            <strong>{selectedProbe.probe_id}</strong>
            <span>{selectedProbe.path.join(" -> ")}</span>
          </div>
        ) : null}
        <div className="hop-event-list">
          {hopEvents.map((event) => {
            const key = `${event.probe_id}-${event.hop_index}-${event.observation_scope}-${event.observed_link_id}`;
            return (
              <button key={key} type="button" className={selectedHopKey === key ? "active" : ""} onClick={() => onHopSelect(event)}>
                <strong>Hop {event.hop_index} / {event.node_id}</strong>
                <span>{scopeText(event.observation_scope)} / {event.role}</span>
                <small>
                  CPU {event.observed_cpu_percent.toFixed(1)}% / 电量 {event.observed_energy_percent.toFixed(1)}% / 链路 {event.observed_link_status || "unknown"}
                </small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="process-card">
        <div className="section-heading">
          <Activity size={18} />
          <h2>当前 Hop 写入字段</h2>
        </div>
        {selectedHop ? (
          <dl className="process-hop-dl">
            <dt>节点</dt>
            <dd>{selectedHop.node_id}</dd>
            <dt>角色</dt>
            <dd>{selectedHop.role}</dd>
            <dt>上一跳 / 下一跳</dt>
            <dd>{selectedHop.previous_hop || "-"} / {selectedHop.next_hop || "-"}</dd>
            <dt>采集范围</dt>
            <dd>{scopeText(selectedHop.observation_scope)}</dd>
            <dt>节点状态</dt>
            <dd>{selectedHop.observed_node_mode} / CPU {selectedHop.observed_cpu_percent.toFixed(1)}% / 队列 {selectedHop.observed_queue_depth}</dd>
            <dt>能量</dt>
            <dd>{selectedHop.observed_energy_percent.toFixed(1)}%</dd>
            <dt>观测链路</dt>
            <dd>{selectedHop.observed_link_id || "-"}</dd>
            <dt>链路状态</dt>
            <dd>{selectedHop.observed_link_status || "unknown"} / {selectedHop.observed_link_utilization_percent.toFixed(1)}% / {selectedHop.observed_link_latency_ms.toFixed(1)} ms</dd>
            <dt>容量</dt>
            <dd>{selectedHop.observed_link_capacity_mbps.toLocaleString()} Mbps</dd>
          </dl>
        ) : (
          <div className="telemetry-manifest-empty">当前 probe 没有 hop event。</div>
        )}
      </div>
    </section>
  );
}

function OamReconstructionPanel({ processSlice }: { processSlice: IntProcessSlice }) {
  const downlinkedReports = processSlice.report_events.filter((report) => report.status === "downlinked").length;
  const reportBytes = processSlice.report_events.reduce((total, report) => total + report.report_size_bytes, 0);
  return (
    <section className="oam-reconstruction-panel module-section">
      <div className="section-title-row">
        <div>
          <span className="section-kicker">Ground OAM</span>
          <h2>地面 OAM 重构快照</h2>
        </div>
        <div className="section-status">只使用已下传 INT reports 合并状态</div>
      </div>
      <div className="oam-grid">
        <TelemetryMetric icon={<FileText size={20} />} label="已下传报告" value={`${downlinkedReports}/${processSlice.report_events.length}`} tone={downlinkedReports === processSlice.report_events.length ? "good" : "warn"} />
        <TelemetryMetric icon={<Download size={20} />} label="报告体量" value={compactBytes(reportBytes)} />
        <TelemetryMetric icon={<Satellite size={20} />} label="重构节点" value={`${processSlice.oam_reconstruction.node_observed_count}/${processSlice.coverage.truth_node_samples}`} tone={processSlice.coverage.node_sample_coverage === 1 ? "good" : "warn"} />
        <TelemetryMetric icon={<RadioTower size={20} />} label="重构链路" value={`${processSlice.oam_reconstruction.link_observed_count}/${processSlice.coverage.truth_link_samples}`} tone={processSlice.coverage.link_sample_coverage === 1 ? "good" : "warn"} />
      </div>
    </section>
  );
}

function TelemetryTopology({
  telemetrySlice,
  selected,
  highlightNodeIds,
  highlightLinkIds,
  showUnknownLinks,
  onSelect,
}: {
  telemetrySlice: IntTelemetrySlice;
  selected: TelemetrySelection;
  highlightNodeIds: Set<string>;
  highlightLinkIds: Set<string>;
  showUnknownLinks: boolean;
  onSelect: (selection: TelemetrySelection) => void;
}) {
  const width = 900;
  const height = 440;
  const maxPlane = Math.max(...telemetrySlice.observedNodes.map((node) => node.plane), 0);
  const maxSlot = Math.max(...telemetrySlice.observedNodes.map((node) => node.slot), 0);
  const positions = new Map<string, { x: number; y: number }>();

  telemetrySlice.observedNodes.forEach((node) => {
    positions.set(node.nodeId, {
      x: 58 + (node.plane / Math.max(maxPlane, 1)) * (width - 116),
      y: 48 + (node.slot / Math.max(maxSlot, 1)) * (height - 96),
    });
  });

  return (
    <section className="telemetry-topology-panel">
      <div className="section-heading">
        <Network size={18} />
        <h2>OAM 观测拓扑</h2>
      </div>
      <svg className="telemetry-topology" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="INT 遥测观测拓扑">
        {Array.from({ length: maxPlane + 1 }).map((_, plane) => {
          const x = 58 + (plane / Math.max(maxPlane, 1)) * (width - 116);
          return (
            <g key={plane}>
              <line className="telemetry-plane-line" x1={x} y1={34} x2={x} y2={height - 34} />
              <text className="telemetry-plane-label" x={x} y={22} textAnchor="middle">
                P{String(plane + 1).padStart(2, "0")}
              </text>
            </g>
          );
        })}
        {telemetrySlice.observedLinks.filter((link) => showUnknownLinks || link.observed).map((link) => {
          const source = positions.get(link.source);
          const target = positions.get(link.target);
          if (!source || !target) return null;
          const selectedLink = selected.type === "link" && selected.id === link.linkId;
          const highlighted = highlightLinkIds.has(link.linkId);
          return (
            <line
              key={link.linkId}
              className={`telemetry-link-line ${link.observed ? "observed" : "unknown"} ${link.status} ${selectedLink ? "selected" : ""} ${highlighted ? "highlighted" : ""}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              onClick={() => onSelect({ type: "link", id: link.linkId })}
            >
              <title>{`${link.source} -> ${link.target} / ${statusText(link.status)} / ${scopeText(link.scope)}`}</title>
            </line>
          );
        })}
        {telemetrySlice.observedNodes.map((node) => {
          const position = positions.get(node.nodeId);
          if (!position) return null;
          const selectedNode = selected.type === "node" && selected.id === node.nodeId;
          const highlighted = highlightNodeIds.has(node.nodeId);
          return (
            <g
              key={node.nodeId}
              className={`telemetry-node-dot ${node.observed ? "observed" : "unknown"} ${node.mode} ${selectedNode ? "selected" : ""} ${highlighted ? "highlighted" : ""}`}
              onClick={() => onSelect({ type: "node", id: node.nodeId })}
              tabIndex={0}
            >
              <circle cx={position.x} cy={position.y} r={selectedNode ? 8 : 6} />
              <text x={position.x} y={position.y - 11} textAnchor="middle">
                {node.nodeId}
              </text>
              <title>{`${node.nodeId} / ${node.observed ? "已观测" : "未知"} / CPU ${node.cpuPercent.toFixed(1)}%`}</title>
            </g>
          );
        })}
      </svg>
      <div className="telemetry-legend">
        <span><i className="up" />已观测连通</span>
        <span><i className="down" />已观测断开</span>
        <span><i className="unknown" />未观测</span>
        <span><i className="probe" />当前 probe 路径</span>
      </div>
    </section>
  );
}

function TelemetryInspector({
  telemetrySlice,
  selection,
}: {
  telemetrySlice: IntTelemetrySlice;
  selection: TelemetrySelection;
}) {
  if (selection.type === "link") {
    const link = telemetrySlice.observedLinks.find((item) => item.linkId === selection.id) ?? telemetrySlice.observedLinks[0];
    return (
      <section className="telemetry-inspector">
        <div className="section-heading">
          <RadioTower size={18} />
          <h2>链路遥测记录</h2>
        </div>
        <h3>{link ? `${link.source} -> ${link.target}` : "-"}</h3>
        {link ? (
          <dl>
            <dt>观测状态</dt>
            <dd>{link.observed ? "已观测" : "unknown"}</dd>
            <dt>采集来源</dt>
            <dd>{scopeText(link.scope)}</dd>
            <dt>链路状态</dt>
            <dd><span className={`status-pill ${link.status}`}>{statusText(link.status)}</span></dd>
            <dt>类型</dt>
            <dd>{link.kind === "intra-plane" ? "轨内链路" : "轨间链路"}</dd>
            <dt>可承载</dt>
            <dd>{link.active === "" ? "unknown" : link.active ? "是" : "否"}</dd>
            <dt>利用率</dt>
            <dd>{link.utilizationPercent.toFixed(1)}%</dd>
            <dt>时延</dt>
            <dd>{link.latencyMs.toFixed(1)} ms</dd>
            <dt>容量</dt>
            <dd>{link.capacityMbps.toLocaleString()} Mbps</dd>
            <dt>拥塞</dt>
            <dd>{link.congestionPercent.toFixed(1)}%</dd>
            <dt>限制原因</dt>
            <dd>{link.restrictionReason || "-"}</dd>
          </dl>
        ) : null}
      </section>
    );
  }

  if (selection.type === "report") {
    const report = telemetrySlice.reports.find((item) => item.reportId === selection.id) ?? telemetrySlice.reports[0];
    return (
      <section className="telemetry-inspector">
        <div className="section-heading">
          <FileText size={18} />
          <h2>报告回传记录</h2>
        </div>
        <h3>{report?.probeId ?? "-"}</h3>
        {report ? (
          <dl>
            <dt>状态</dt>
            <dd>{report.status === "downlinked" ? "已下传" : report.status === "queued" ? "排队" : "丢弃"}</dd>
            <dt>源 / Sink</dt>
            <dd>{report.source} / {report.sink}</dd>
            <dt>记录数</dt>
            <dd>{report.recordCount}</dd>
            <dt>大小</dt>
            <dd>{compactBytes(report.reportSizeBytes)}</dd>
            <dt>直连卫星</dt>
            <dd>{report.directLinkedSatellite || "-"}</dd>
            <dt>回传跳数</dt>
            <dd>{report.reportingHops}</dd>
            <dt>回传时延</dt>
            <dd>{report.reportingLatencyMs.toFixed(1)} ms</dd>
            <dt>回传路径</dt>
            <dd>{report.reportingPath.length ? report.reportingPath.join(" -> ") : "-"}</dd>
          </dl>
        ) : null}
      </section>
    );
  }

  const node = telemetrySlice.observedNodes.find((item) => item.nodeId === selection.id) ?? telemetrySlice.observedNodes[0];
  return (
    <section className="telemetry-inspector">
      <div className="section-heading">
        <Satellite size={18} />
        <h2>节点遥测记录</h2>
      </div>
      <h3>{node?.label ?? "-"}</h3>
      {node ? (
        <dl>
          <dt>观测状态</dt>
          <dd>{node.observed ? "已观测" : "unknown"}</dd>
          <dt>轨道面 / 槽位</dt>
          <dd>{node.plane + 1} / {node.slot + 1}</dd>
          <dt>节点模式</dt>
          <dd>{node.mode}</dd>
          <dt>CPU</dt>
          <dd>{node.cpuPercent.toFixed(1)}%</dd>
          <dt>队列深度</dt>
          <dd>{node.queueDepth}</dd>
          <dt>电量</dt>
          <dd>{node.energyPercent.toFixed(1)}%</dd>
          <dt>遥测缓存</dt>
          <dd>{node.telemetryBufferMb.toFixed(1)} MB</dd>
          <dt>源端 / 经过 / Sink</dt>
          <dd>{node.sourceReports} / {node.transitReports} / {node.sinkReports}</dd>
        </dl>
      ) : null}
    </section>
  );
}

function ReportTable({
  reports,
  onSelect,
}: {
  reports: IntReport[];
  onSelect: (selection: TelemetrySelection) => void;
}) {
  return (
    <section className="telemetry-table-card">
      <div className="section-heading">
        <FileText size={18} />
        <h2>INT 报告</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Probe</th>
              <th>状态</th>
              <th>记录</th>
              <th>大小</th>
              <th>Sink</th>
              <th>回传路径</th>
            </tr>
          </thead>
          <tbody>
            {reports.slice(0, 12).map((report) => (
              <tr key={report.reportId} onClick={() => onSelect({ type: "report", id: report.reportId })}>
                <td>{report.probeId}</td>
                <td><span className={`status-pill ${report.status === "downlinked" ? "up" : "warning"}`}>{report.status === "downlinked" ? "已下传" : "排队"}</span></td>
                <td>{report.recordCount}</td>
                <td>{compactBytes(report.reportSizeBytes)}</td>
                <td>{report.sink}</td>
                <td>{report.reportingPath.length ? report.reportingPath.join(" -> ") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ObservedLinkTable({
  links,
  onSelect,
}: {
  links: IntLinkObservation[];
  onSelect: (selection: TelemetrySelection) => void;
}) {
  const orderedLinks = [...links].sort((a, b) => Number(b.observed) - Number(a.observed) || a.status.localeCompare(b.status));
  return (
    <section className="telemetry-table-card">
      <div className="section-heading">
        <RadioTower size={18} />
        <h2>OAM 链路重构</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>链路</th>
              <th>观测</th>
              <th>来源</th>
              <th>状态</th>
              <th>利用率</th>
              <th>拥塞</th>
            </tr>
          </thead>
          <tbody>
            {orderedLinks.slice(0, 14).map((link) => (
              <tr key={link.linkId} onClick={() => onSelect({ type: "link", id: link.linkId })}>
                <td>{`${link.source} -> ${link.target}`}</td>
                <td>{link.observed ? "observed" : "unknown"}</td>
                <td>{scopeText(link.scope)}</td>
                <td><span className={`status-pill ${link.status}`}>{statusText(link.status)}</span></td>
                <td>{link.utilizationPercent.toFixed(1)}%</td>
                <td>{link.congestionPercent.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ObservedNodeStrip({
  nodes,
  onSelect,
}: {
  nodes: IntNodeObservation[];
  onSelect: (selection: TelemetrySelection) => void;
}) {
  return (
    <section className="telemetry-node-strip">
      <div className="section-heading">
        <CircleDashed size={18} />
        <h2>OAM 节点重构</h2>
      </div>
      <div className="telemetry-node-grid">
        {nodes.map((node) => (
          <button
            key={node.nodeId}
            type="button"
            className={`telemetry-node-cell ${node.observed ? "observed" : "unknown"} ${node.mode}`}
            onClick={() => onSelect({ type: "node", id: node.nodeId })}
          >
            <strong>{node.nodeId}</strong>
            <span>{node.observed ? `${node.cpuPercent.toFixed(0)}% CPU` : "unknown"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function TelemetrySimulationPage({
  slices,
  sliceIndex,
  snapshotMode,
  datasetName,
  onTimeSelect,
  onResumeMotion,
  onBack,
}: {
  slices: NetworkSlice[];
  sliceIndex: number;
  snapshotMode: boolean;
  datasetName: string;
  onTimeSelect: (index: number) => void;
  onResumeMotion: () => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<IntTelemetryMode>("probe-int");
  const run = useMemo(() => buildIntTelemetryRun(slices, mode), [mode, slices]);
  const telemetrySlice = run.slices[sliceIndex] ?? run.slices[0];
  const liveProcessSlices = useMemo(() => run.slices.map(processSliceFromTelemetry), [run]);
  const [importedManifest, setImportedManifest] = useState<ImportedExperimentManifest | null>(null);
  const [importedManifestName, setImportedManifestName] = useState("");
  const [importedManifestError, setImportedManifestError] = useState("");
  const [importedProcess, setImportedProcess] = useState<IntProcessVisualization | null>(null);
  const [importedProcessName, setImportedProcessName] = useState("");
  const [importedProcessError, setImportedProcessError] = useState("");
  const [processStage, setProcessStage] = useState<ProcessStageKey>("plan");
  const [selectedProbeId, setSelectedProbeId] = useState("");
  const [selectedHopKey, setSelectedHopKey] = useState("");
  const [showUnknownLinks, setShowUnknownLinks] = useState(true);
  const processSlices = importedProcess?.slices ?? liveProcessSlices;
  const processSlice = processSlices.find((slice) => slice.slice_index === sliceIndex) ?? processSlices[0] ?? processSliceFromTelemetry(telemetrySlice);
  const displayTelemetrySlice = useMemo(() => processToTelemetrySlice(processSlice, telemetrySlice), [processSlice, telemetrySlice]);
  const selectedProbe = processSlice.probes.find((probe) => probe.probe_id === selectedProbeId) ?? processSlice.probes[0];
  const highlightedNodeIds = useMemo(() => new Set(selectedProbe?.path ?? []), [selectedProbe]);
  const highlightedLinkIds = useMemo(() => new Set(selectedProbe?.link_ids ?? []), [selectedProbe]);
  const [selection, setSelection] = useState<TelemetrySelection>({
    type: "node",
    id: displayTelemetrySlice?.observedNodes[0]?.nodeId ?? "",
  });

  async function handleManifestUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isImportedExperimentManifest(parsed)) {
        throw new Error("请选择 npm run int:experiment 生成的 int-experiment-manifest.json。");
      }
      setImportedManifest(parsed);
      setImportedManifestName(file.name);
      setImportedManifestError("");
    } catch (error) {
      setImportedManifest(null);
      setImportedManifestName("");
      setImportedManifestError(error instanceof Error ? error.message : "Manifest 解析失败。");
    } finally {
      event.target.value = "";
    }
  }

  async function handleProcessUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isIntProcessVisualization(parsed)) {
        throw new Error("请选择 int:experiment 生成的 int-process-visualization.json。");
      }
      setImportedProcess(parsed);
      setImportedProcessName(file.name);
      setImportedProcessError("");
      setMode("probe-int");
      setSelectedProbeId(parsed.slices[0]?.probes[0]?.probe_id ?? "");
    } catch (error) {
      setImportedProcess(null);
      setImportedProcessName("");
      setImportedProcessError(error instanceof Error ? error.message : "过程包解析失败。");
    } finally {
      event.target.value = "";
    }
  }

  useEffect(() => {
    if (selection.type === "node" && displayTelemetrySlice.observedNodes.some((node) => node.nodeId === selection.id)) return;
    if (selection.type === "link" && displayTelemetrySlice.observedLinks.some((link) => link.linkId === selection.id)) return;
    if (selection.type === "report" && displayTelemetrySlice.reports.some((report) => report.reportId === selection.id)) return;
    setSelection({ type: "node", id: displayTelemetrySlice.observedNodes[0]?.nodeId ?? "" });
  }, [selection, displayTelemetrySlice]);

  useEffect(() => {
    if (selectedProbeId && processSlice.probes.some((probe) => probe.probe_id === selectedProbeId)) return;
    setSelectedProbeId(processSlice.probes[0]?.probe_id ?? "");
  }, [processSlice, selectedProbeId]);

  return (
    <div className="telemetry-page">
      <section className="telemetry-hero module-section">
        <div className="telemetry-hero-main">
          <button type="button" className="telemetry-back" onClick={onBack}>
            <ArrowLeft size={16} />
            星座仪表盘
          </button>
          <div>
            <span className="section-kicker">INT Telemetry</span>
            <h2>遥测仿真</h2>
          </div>
          <p>当前页面只展示已生成并成功下传的 INT 遥测记录、报告和 OAM 重构结果。</p>
        </div>
        <div className="telemetry-hero-side">
          <strong>{datasetName}</strong>
          <span>{telemetryModeLabel[mode]}</span>
        </div>
      </section>

      <section className="telemetry-controls module-section">
        <div className="telemetry-control-row">
          <div className="mode-switch" aria-label="INT 遥测模式">
            <button type="button" className={mode === "probe-int" ? "active" : ""} onClick={() => setMode("probe-int")}>
              全网 probe-int
            </button>
            <button type="button" className={mode === "traffic-int" ? "active" : ""} onClick={() => setMode("traffic-int")}>
              业务 traffic-int
            </button>
          </div>
          <div className="snapshot-strip telemetry-snapshot-strip" aria-label="遥测时间片">
            <button type="button" className={`snapshot-chip ${!snapshotMode ? "active" : ""}`} onClick={onResumeMotion}>
              运动
            </button>
            {slices.map((slice) => (
              <button
                key={slice.index}
                type="button"
                className={`snapshot-chip ${slice.index === sliceIndex ? "active" : ""}`}
                onClick={() => onTimeSelect(slice.index)}
              >
                T{slice.index.toString().padStart(2, "0")}
              </button>
            ))}
          </div>
          <button type="button" className={`snapshot-chip ${showUnknownLinks ? "active" : ""}`} onClick={() => setShowUnknownLinks((value) => !value)}>
            {showUnknownLinks ? "显示 unknown 链路" : "隐藏 unknown 链路"}
          </button>
        </div>
      </section>

      <section className="telemetry-metrics-grid">
        <TelemetryMetric icon={<Satellite size={20} />} label="节点样本覆盖" value={pct(run.nodeSampleCoverage)} tone={run.nodeSampleCoverage === 1 ? "good" : "warn"} />
        <TelemetryMetric icon={<RadioTower size={20} />} label="全部链路覆盖" value={pct(run.linkSampleCoverage)} tone={run.linkSampleCoverage === 1 ? "good" : "warn"} />
        <TelemetryMetric icon={<Activity size={20} />} label="活动链路覆盖" value={pct(run.activeLinkSampleCoverage)} tone={run.activeLinkSampleCoverage === 1 ? "good" : "warn"} />
        <TelemetryMetric icon={<FileText size={20} />} label="报告下传" value={`${run.deliveredReports}/${run.totalReports}`} tone={run.deliveredReports === run.totalReports ? "good" : "warn"} />
        <TelemetryMetric icon={<Workflow size={20} />} label="Hop Records" value={run.totalHopRecords.toLocaleString()} />
        <TelemetryMetric icon={<CheckCircle2 size={20} />} label="完整时间片" value={`${run.completeSlices}/${run.slices.length}`} tone={run.failedSlices === 0 ? "good" : "warn"} />
      </section>

      <TelemetryProcess slice={displayTelemetrySlice} />
      <ProcessStageTimeline processSlice={processSlice} currentStage={processStage} onStageChange={setProcessStage} />

      <OfflineExperimentPanel
        manifest={importedManifest}
        manifestName={importedManifestName}
        error={importedManifestError}
        process={importedProcess}
        processName={importedProcessName}
        processError={importedProcessError}
        onUpload={handleManifestUpload}
        onProcessUpload={handleProcessUpload}
        onClear={() => {
          setImportedManifest(null);
          setImportedManifestName("");
          setImportedManifestError("");
        }}
        onProcessClear={() => {
          setImportedProcess(null);
          setImportedProcessName("");
          setImportedProcessError("");
          setSelectedProbeId("");
          setSelectedHopKey("");
        }}
      />

      <CoverageHeatmap slices={processSlices} currentSliceIndex={processSlice.slice_index} onSelect={onTimeSelect} />

      <ProbeProcessPanel
        processSlice={processSlice}
        selectedProbeId={selectedProbeId}
        selectedHopKey={selectedHopKey}
        onProbeSelect={(probeId) => {
          setSelectedProbeId(probeId);
          const probe = processSlice.probes.find((item) => item.probe_id === probeId);
          if (probe?.source) setSelection({ type: "node", id: probe.source });
        }}
        onHopSelect={(event) => {
          const key = `${event.probe_id}-${event.hop_index}-${event.observation_scope}-${event.observed_link_id}`;
          setSelectedHopKey(key);
          if (event.observed_link_id) setSelection({ type: "link", id: event.observed_link_id });
          else setSelection({ type: "node", id: event.node_id });
        }}
      />

      <OamReconstructionPanel processSlice={processSlice} />

      <NodeValidationPanel run={run} telemetrySlice={displayTelemetrySlice} />

      <section className="telemetry-workspace">
        <div className="telemetry-main-column">
          <TelemetryTopology
            telemetrySlice={displayTelemetrySlice}
            selected={selection}
            highlightNodeIds={highlightedNodeIds}
            highlightLinkIds={highlightedLinkIds}
            showUnknownLinks={showUnknownLinks}
            onSelect={setSelection}
          />
          <ObservedNodeStrip nodes={displayTelemetrySlice.observedNodes} onSelect={setSelection} />
        </div>
        <aside className="telemetry-side-column">
          <TelemetryInspector telemetrySlice={displayTelemetrySlice} selection={selection} />
        </aside>
      </section>

      <section className="telemetry-tables">
        <ReportTable reports={displayTelemetrySlice.reports} onSelect={setSelection} />
        <ObservedLinkTable links={displayTelemetrySlice.observedLinks} onSelect={setSelection} />
      </section>

      <TelemetryDownloadPanel run={run} datasetName={datasetName} process={importedProcess} />
    </div>
  );
}
