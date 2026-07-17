import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  BatteryMedium,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Cpu,
  Download,
  Gauge,
  Layers2,
  Lock,
  Orbit,
  RadioTower,
  Satellite,
  Thermometer,
  Unlock,
} from "lucide-react";
import {
  constellationProfiles,
  defaultConstellationProfileId,
  getConstellationProfile,
  type ConstellationProfileId,
} from "./config/constellationProfiles";
import OrbitalScene from "./components/OrbitalScene";
import PlanarTopology from "./components/PlanarTopology";
import TelemetrySimulationPage from "./components/TelemetrySimulationPage";
import { generateWalkerNetwork } from "./simulation/walker";
import {
  businessLinkImpactRows,
  businessNodeImpactRows,
  experimentJson,
  experimentMetadata,
  linkSnapshotRows,
  networkMetricRows,
  nodeSnapshotRows,
  routeSnapshotRows,
  rowsToCsv,
  taskTraceRows,
} from "./simulation/export";
import { effectiveTrafficTasks, parseTaskDataset, validateTaskDataset } from "./simulation/traffic";
import type {
  InterPlaneDirection,
  LinkKind,
  LinkRestrictionReason,
  LinkStatus,
  NetworkSlice,
  NodeMode,
  NodeType,
  OrbitModel,
  RoutedTaskPath,
  RoutingAlgorithm,
  SimulationMode,
  TaskTrafficRecord,
  TrafficProfile,
  WalkerNetworkConfig,
} from "./simulation/types";

const nodeStatusLabel: Record<NodeMode, string> = {
  nominal: "正常",
  warning: "告警",
  degraded: "降级",
};

const linkStatusLabel: Record<LinkStatus, string> = {
  up: "连通",
  warning: "告警",
  down: "断开",
};

const simulationModeLabel: Record<SimulationMode, string> = {
  autonomous: "自主模拟",
  operational: "真实运行",
};

const routingAlgorithmLabel: Record<RoutingAlgorithm, string> = {
  "shortest-path": "最短路径",
  "congestion-aware-shortest-path": "拥塞感知最短路径",
};

const orbitModelLabel: Record<OrbitModel, string> = {
  "analytic-walker": "解析 Walker",
  "tle-sgp4": "TLE + SGP4",
  "real-tle-sgp4": "真实 TLE + SGP4",
};

const routeStatusLabel: Record<RoutedTaskPath["status"], string> = {
  routed: "已路由",
  unroutable: "不可达",
  local: "本地任务",
  "not-requested": "未请求",
};

const trafficProfileLabel: Record<TrafficProfile, string> = {
  empty: "空业务",
  "low-load": "低负载",
  normal: "正常业务",
  "high-load": "高负载",
  hotspot: "热点业务",
  burst: "突发业务",
  "long-duration": "长时业务",
  uploaded: "上传数据",
};

const trafficProfiles: TrafficProfile[] = [
  "empty",
  "low-load",
  "normal",
  "high-load",
  "hotspot",
  "burst",
  "long-duration",
  "uploaded",
];

const nodeTypeLabel: Record<NodeType, string> = {
  satellite: "卫星",
  HAPS: "高空平台",
  ground: "地面节点",
};

const linkKindLabel: Record<LinkKind, string> = {
  "intra-plane": "轨内链路",
  "inter-plane": "轨间链路",
};

const interPlaneDirectionLabel: Record<InterPlaneDirection, string> = {
  left: "左侧相邻轨道面",
  right: "右侧相邻轨道面",
  none: "轨内",
};

type Selection =
  | { type: "node"; id: string }
  | { type: "link"; id: string };

type PanelKey = "overview" | "topology" | "details" | "tables";
type PageKey = "dashboard" | "telemetry";

const DASHBOARD_MEDIUM_PROFILE_SLICE_LIMIT = 12;
const DASHBOARD_LARGE_PROFILE_SLICE_LIMIT = 4;

function restrictionReasonText(reason: LinkRestrictionReason) {
  if (reason === "distance-threshold") return "距离超过阈值";
  if (reason === "polar-region") return "极地区域限制";
  if (reason === "antenna-range") return "超过天线通信距离";
  if (reason === "pointing-switch") return "天线切换未完成";
  if (reason === "doppler-shift") return "多普勒频移超限";
  if (reason === "solar-interference") return "太阳规避角触发";
  if (reason === "link-budget") return "链路预算不足";
  if (reason === "capacity-limit") return "容量低于门限";
  if (reason === "experiment8-controlled-dynamicity") return "实验受控断链";
  return "地球遮挡";
}

function antennaRoleText(role: string) {
  if (role === "front") return "轨内前向";
  if (role === "back") return "轨内后向";
  if (role === "left") return "左侧轨间";
  if (role === "right") return "右侧轨间";
  if (role === "earth-facing") return "星地地向";
  return "用户链路";
}

function antennaStateText(state: string) {
  if (state === "occupied") return "占用";
  if (state === "switching") return "切换";
  if (state === "fault") return "故障";
  return "空闲";
}

function routeRoleForNode(route: RoutedTaskPath, nodeId: string) {
  if (route.source === nodeId && route.target === nodeId) return "本地";
  if (route.source === nodeId) return "源端";
  if (route.target === nodeId) return "目的端";
  if (route.path.includes(nodeId)) return "中继";
  return "关联";
}

function routeHopText(route: RoutedTaskPath, nodeId: string) {
  const index = route.path.indexOf(nodeId);
  if (index === -1) return "未进入路径";
  const previousHop = index > 0 ? route.path[index - 1] : "";
  const nextHop = index < route.path.length - 1 ? route.path[index + 1] : "";
  if (!previousHop && !nextHop) return "本地处理";
  if (!previousHop) return `下一跳 ${nextHop}`;
  if (!nextHop) return `上一跳 ${previousHop} / 已到达`;
  return `上一跳 ${previousHop} / 下一跳 ${nextHop}`;
}

function routeEndpointText(route: RoutedTaskPath) {
  if (route.source && route.target) return `${route.source} -> ${route.target}`;
  if (route.source) return `${route.source} 本地任务`;
  return "未指定端点";
}

function taskParticipationForNode(slice: NetworkSlice, nodeId: string) {
  const activeRoutes = slice.routes.filter((route) => route.status !== "not-requested");
  const sourceRoutes = activeRoutes.filter((route) => route.source === nodeId);
  const throughRoutes = activeRoutes.filter((route) => route.source !== nodeId && route.path.includes(nodeId));
  return { sourceRoutes, throughRoutes, routes: [...sourceRoutes, ...throughRoutes] };
}

function TaskParticipationDetail({ slice, nodeId }: { slice: NetworkSlice; nodeId: string }) {
  const participation = taskParticipationForNode(slice, nodeId);
  const visibleRoutes = participation.routes.slice(0, 8);
  const hiddenCount = participation.routes.length - visibleRoutes.length;

  return (
    <span className="task-participation" tabIndex={0}>
      <span className="task-participation-value">
        {participation.sourceRoutes.length}/{participation.throughRoutes.length}
      </span>
      <span className="task-participation-tooltip" role="tooltip">
        <strong>T{slice.index.toString().padStart(2, "0")} 参与任务明细</strong>
        {visibleRoutes.length > 0 ? (
          visibleRoutes.map((route) => (
            <span key={`${route.task_id}-${route.source ?? ""}-${route.target ?? ""}`} className="task-participation-row">
              <b>{route.task_id}</b>
              <span>{routeRoleForNode(route, nodeId)} / {routeStatusLabel[route.status]}</span>
              <span>{routeEndpointText(route)}</span>
              <span>{routeHopText(route, nodeId)}</span>
              <span>
                {route.carriedTrafficMbps.toFixed(1)} / {route.trafficMbps.toFixed(1)} Mbps
              </span>
            </span>
          ))
        ) : (
          <em>当前时间片没有源端或经过该节点的业务路径</em>
        )}
        {hiddenCount > 0 ? <small>还有 {hiddenCount} 条任务未展开</small> : null}
      </span>
    </span>
  );
}

function groundWindowReasonText(reason?: string) {
  if (reason === "below-elevation") return "仰角不足";
  if (reason === "antenna-range") return "超过天线距离";
  if (reason === "antenna-occupied") return "地向天线已占用";
  if (reason === "pointing-switch") return "天线切换未完成";
  if (reason === "doppler-shift") return "多普勒频移超限";
  if (reason === "solar-interference") return "太阳规避角触发";
  if (reason === "link-budget") return "链路预算不足";
  if (reason === "capacity-limit") return "容量低于门限";
  return "-";
}

function metricValue(slice: NetworkSlice) {
  const totalLinks = slice.links.length;
  const upLinks = slice.links.filter((link) => link.state.isActive).length;
  const degradedNodes = slice.nodes.filter((node) => node.state.mode === "degraded").length;
  const warningNodes = slice.nodes.filter((node) => node.state.mode === "warning").length;
  const activeTasks = slice.nodes.reduce((total, node) => total + node.taskLoad.taskCount, 0);
  const routedRoutes = slice.routes.filter((route) => route.status === "routed").length;
  const routeRequests = slice.routes.filter((route) => route.status !== "not-requested").length;
  const availableGroundLinks = slice.groundLinks.filter((window) => window.status === "available").length;
  const reportCapacityMbps = slice.groundLinks.reduce((total, window) => total + window.reportCapacityMbps, 0);
  const queuedTrafficMb = slice.nodes.reduce((total, node) => total + node.resources.queued_traffic_mb, 0);
  const forwardingLoadMbps = slice.nodes.reduce((total, node) => total + node.resources.forwarding_load_mbps, 0);
  const downlinkLoadMbps = slice.nodes.reduce((total, node) => total + node.resources.downlink_load_mbps, 0);
  const maxCommunicationPowerW = slice.nodes.reduce(
    (max, node) => Math.max(max, node.resources.communication_power_w),
    0,
  );
  const maxNodeLinkOccupancyPercent = slice.nodes.reduce(
    (max, node) => Math.max(max, node.resources.link_occupancy_percent),
    0,
  );
  const telemetryBufferMb = slice.nodes.reduce((total, node) => total + node.resources.telemetry_buffer_mb, 0);
  const telemetryDownlinkedMb = slice.nodes.reduce((total, node) => total + node.resources.telemetry_downlinked_mb, 0);
  const maxLinkCongestionPercent = Math.round(
    slice.links.reduce((max, link) => Math.max(max, link.state.congestionPercent), 0),
  );
  const congestedLinks = slice.links.filter((link) => link.state.congestionPercent > 0).length;
  const linkBudgets = slice.links.map((link) => link.state.linkBudget).filter((budget) => budget !== undefined);
  const minSinrDb = linkBudgets.length
    ? Math.min(...linkBudgets.map((budget) => budget.sinr_db))
    : 0;
  const interferenceAffectedLinks = linkBudgets.filter((budget) => budget.interference_count > 0).length;
  const adjacentInterferenceAffectedLinks = linkBudgets.filter((budget) => budget.adjacent_channel_interference_count > 0).length;
  const filteredChannelInterferenceLinks = linkBudgets.filter((budget) => budget.filtered_channel_interference_count > 0).length;
  const currentGroundWindows = slice.groundLinks.filter((window) => window.status === "available");
  const groundBudgetWindows = currentGroundWindows.length > 0 ? currentGroundWindows : slice.groundLinks;
  const groundBudgets = groundBudgetWindows.map((window) => window.linkBudget).filter((budget) => budget !== undefined);
  const maxSglAtmosphericLossDb = groundBudgets.length
    ? Math.max(...groundBudgets.map((budget) => budget.atmospheric_loss_db))
    : 0;
  const maxGroundRainRate = slice.groundLinks.length
    ? Math.max(...slice.groundLinks.map((window) => window.rainRateMmPerHour))
    : 0;
  const maxGroundCloudWater = slice.groundLinks.length
    ? Math.max(...slice.groundLinks.map((window) => window.cloudLiquidWaterKgPerM2))
    : 0;
  const sglInterferenceAffectedLinks = groundBudgets.filter((budget) => budget.interference_count > 0).length;
  const sglAdjacentInterferenceAffectedLinks = groundBudgets.filter(
    (budget) => budget.adjacent_channel_interference_count > 0,
  ).length;
  const maxSglInterferenceToNoiseDb = groundBudgets.length
    ? Math.max(...groundBudgets.map((budget) => budget.interference_to_noise_db))
    : -999;
  const allBudgets = [...linkBudgets, ...groundBudgets];
  const maxDynamicPointingLossDb = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.dynamic_pointing_loss_db))
    : 0;
  const maxEnvironmentalNoiseIncreaseDb = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.environmental_noise_increase_db))
    : 0;
  const maxSunNoiseTemperatureK = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.sun_noise_temperature_k))
    : 0;
  const minSunSeparationDeg = allBudgets.length
    ? Math.min(...allBudgets.map((budget) => budget.sun_separation_deg))
    : 180;
  const maxSolarInterferenceLossDb = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.solar_interference_loss_db))
    : 0;
  const minSolarExclusionMarginDeg = allBudgets.length
    ? Math.min(...allBudgets.map((budget) => budget.solar_exclusion_margin_deg))
    : 180;
  const solarInterferenceAffectedLinks = linkBudgets.filter(
    (budget) => budget.solar_interference_blocked || budget.solar_interference_loss_db > 0,
  ).length;
  const maxSwitchingDelayS = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.switching_delay_s))
    : 0;
  const minAvailabilityFactor = allBudgets.length
    ? Math.min(...allBudgets.map((budget) => budget.availability_factor))
    : 1;
  const maxDopplerShiftKhz = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => Math.abs(budget.doppler_shift_hz) / 1000))
    : 0;
  const maxDopplerResidualKhz = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => Math.abs(budget.doppler_residual_hz) / 1000))
    : 0;
  const maxDopplerLossDb = allBudgets.length
    ? Math.max(...allBudgets.map((budget) => budget.doppler_loss_db))
    : 0;
  const minDopplerTrackingMarginKhz = allBudgets.length
    ? Math.min(...allBudgets.map((budget) => budget.doppler_tracking_margin_hz / 1000))
    : 0;
  const avgLoad = Math.round(
    slice.nodes.reduce((total, node) => total + node.state.cpuLoadPercent, 0) / Math.max(slice.nodes.length, 1),
  );
  return {
    upLinks,
    totalLinks,
    degradedNodes,
    warningNodes,
    activeTasks,
    routedRoutes,
    routeRequests,
    availableGroundLinks,
    reportCapacityMbps,
    queuedTrafficMb,
    forwardingLoadMbps,
    downlinkLoadMbps,
    maxCommunicationPowerW,
    maxNodeLinkOccupancyPercent,
    telemetryBufferMb,
    telemetryDownlinkedMb,
    maxLinkCongestionPercent,
    congestedLinks,
    minSinrDb,
    interferenceAffectedLinks,
    adjacentInterferenceAffectedLinks,
    filteredChannelInterferenceLinks,
    maxSglAtmosphericLossDb,
    maxGroundRainRate,
    maxGroundCloudWater,
    sglInterferenceAffectedLinks,
    sglAdjacentInterferenceAffectedLinks,
    maxSglInterferenceToNoiseDb,
    maxDynamicPointingLossDb,
    maxEnvironmentalNoiseIncreaseDb,
    maxSunNoiseTemperatureK,
    minSunSeparationDeg,
    maxSolarInterferenceLossDb,
    minSolarExclusionMarginDeg,
    solarInterferenceAffectedLinks,
    maxSwitchingDelayS,
    minAvailabilityFactor,
    maxDopplerShiftKhz,
    maxDopplerResidualKhz,
    maxDopplerLossDb,
    minDopplerTrackingMarginKhz,
    avgLoad,
    availability: Math.round((upLinks / Math.max(totalLinks, 1)) * 100),
  };
}

function truthSummaryValue(slices: NetworkSlice[]) {
  const allRoutes = slices.flatMap((item) => item.routes.map((route) => ({ slice: item, route })));
  const routedRoutes = allRoutes.filter(({ route }) => route.status === "routed");
  const uniqueTaskCount = new Set(allRoutes.map(({ route }) => route.task_id)).size;
  const pathsByTask = new Map<string, Set<string>>();
  let inactiveLinkRouteSamples = 0;

  routedRoutes.forEach(({ slice: item, route }) => {
    const linksById = new Map(item.links.map((link) => [link.id, link]));
    const pathSet = pathsByTask.get(route.task_id) ?? new Set<string>();
    pathSet.add(route.linkIds.join("|"));
    pathsByTask.set(route.task_id, pathSet);
    if (route.linkIds.some((linkId) => !linksById.get(linkId)?.state.isActive)) {
      inactiveLinkRouteSamples += 1;
    }
  });

  const dynamicPathTasks = [...pathsByTask.values()].filter((paths) => paths.size > 1).length;
  const nodes = slices.flatMap((item) => item.nodes);
  const links = slices.flatMap((item) => item.links);
  const constrainedLinks = links.filter((link) => !link.state.isActive && Boolean(link.state.restrictionReason));
  const restrictionCounts = constrainedLinks.reduce<Record<string, number>>((counts, link) => {
    const reason = link.state.restrictionReason ? restrictionReasonText(link.state.restrictionReason) : "未知";
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});

  const energies = nodes.map((node) => node.resources.energy_wh);
  const maxCpuPercent = nodes.reduce((max, node) => Math.max(max, node.resources.cpu_utilization), 0);
  const maxForwardingLoadMbps = nodes.reduce((max, node) => Math.max(max, node.resources.forwarding_load_mbps), 0);
  const maxLinkCongestionPercent = links.reduce((max, link) => Math.max(max, link.state.congestionPercent), 0);
  const telemetryGeneratedMb = nodes.reduce((total, node) => total + node.resources.telemetry_generated_mb, 0);
  const telemetryDownlinkedMb = nodes.reduce((total, node) => total + node.resources.telemetry_downlinked_mb, 0);

  return {
    totalSlices: slices.length,
    nodesPerSlice: slices[0]?.nodes.length ?? 0,
    linksPerSlice: slices[0]?.links.length ?? 0,
    totalRouteSamples: allRoutes.length,
    routedRouteSamples: routedRoutes.length,
    uniqueTaskCount,
    dynamicPathTasks,
    inactiveLinkRouteSamples,
    constrainedLinkSamples: constrainedLinks.length,
    dominantRestriction:
      Object.entries(restrictionCounts).sort((a, b) => b[1] - a[1])[0]?.join(" ") ?? "无",
    minEnergyWh: energies.length ? Math.min(...energies) : 0,
    maxEnergyWh: energies.length ? Math.max(...energies) : 0,
    maxCpuPercent,
    maxForwardingLoadMbps,
    maxLinkCongestionPercent,
    telemetryGeneratedMb,
    telemetryDownlinkedMb,
  };
}

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <section className={`stat-tile ${tone ?? ""}`}>
      <div className="stat-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </section>
  );
}

function TruthSummaryPanel({
  datasetName,
  datasetMessage,
  metadata,
  summary,
  config,
}: {
  datasetName: string;
  datasetMessage: string;
  metadata: ReturnType<typeof experimentMetadata>;
  summary: ReturnType<typeof truthSummaryValue>;
  config: WalkerNetworkConfig;
}) {
  const items = [
    {
      label: "时间片 / 节点 / 链路",
      value: `${summary.totalSlices} / ${summary.nodesPerSlice} / ${summary.linksPerSlice}`,
      tone: "good",
    },
    {
      label: "路由样本",
      value: `${summary.routedRouteSamples}/${summary.totalRouteSamples}`,
      tone: summary.totalRouteSamples > 0 && summary.routedRouteSamples === 0 ? "warn" : "good",
    },
    {
      label: "业务任务",
      value: `${summary.uniqueTaskCount} 个`,
      tone: summary.uniqueTaskCount > 0 ? "good" : undefined,
    },
    {
      label: "动态换路任务",
      value: `${summary.dynamicPathTasks} 个`,
      tone: summary.dynamicPathTasks > 0 ? "good" : "warn",
    },
    {
      label: "不可用链路误用",
      value: `${summary.inactiveLinkRouteSamples} 次`,
      tone: summary.inactiveLinkRouteSamples === 0 ? "good" : "bad",
    },
    {
      label: "约束断链样本",
      value: `${summary.constrainedLinkSamples} / ${summary.dominantRestriction}`,
      tone: summary.constrainedLinkSamples > 0 ? "warn" : undefined,
    },
    {
      label: "电池能量范围",
      value: `${summary.minEnergyWh.toFixed(0)}-${summary.maxEnergyWh.toFixed(0)} Wh`,
      tone: summary.minEnergyWh > config.operationalModel.minStateOfCharge * config.operationalModel.batteryCapacityWh ? "good" : "warn",
    },
    {
      label: "最大 CPU / 转发",
      value: `${summary.maxCpuPercent.toFixed(0)}% / ${summary.maxForwardingLoadMbps.toFixed(0)} Mbps`,
      tone: summary.maxCpuPercent > 80 ? "warn" : "good",
    },
    {
      label: "最大链路拥塞",
      value: `${summary.maxLinkCongestionPercent.toFixed(1)}%`,
      tone: summary.maxLinkCongestionPercent > 50 ? "bad" : summary.maxLinkCongestionPercent > 0 ? "warn" : "good",
    },
    {
      label: "遥测生成 / 下传",
      value: `${summary.telemetryGeneratedMb.toFixed(0)} / ${summary.telemetryDownlinkedMb.toFixed(0)} MB`,
      tone: summary.telemetryGeneratedMb > 0 ? "good" : undefined,
    },
  ];

  return (
    <section className="truth-panel">
      <div className="truth-panel-header">
        <div className="section-heading">
          <Activity size={18} />
          <h2>第一阶段真值概览</h2>
        </div>
        <div className="truth-dataset">
          <strong>{datasetName}</strong>
          <span>{datasetMessage}</span>
        </div>
      </div>
      <div className="truth-summary-grid">
        <div className="truth-summary-item baseline">
          <span>配置指纹</span>
          <strong>{metadata.config_fingerprint || "未记录"}</strong>
        </div>
        <div className="truth-summary-item baseline">
          <span>数据集指纹</span>
          <strong>{metadata.dataset_fingerprint}</strong>
        </div>
        <div className="truth-summary-item baseline">
          <span>真值指纹</span>
          <strong>{metadata.truth_fingerprint}</strong>
        </div>
        {items.map((item) => (
          <div key={item.label} className={`truth-summary-item ${item.tone ?? ""}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatScientific(value: number) {
  if (value === 0) return "0";
  if (!Number.isFinite(value)) return "-";
  if (value >= 0.001) return value.toFixed(4);
  return value.toExponential(2);
}

function formatFrequencyOffset(valueHz: number) {
  const absValue = Math.abs(valueHz);
  if (!Number.isFinite(valueHz)) return "-";
  if (absValue >= 1e9) return `${(valueHz / 1e9).toFixed(2)} GHz`;
  if (absValue >= 1e6) return `${(valueHz / 1e6).toFixed(2)} MHz`;
  if (absValue >= 1e3) return `${(valueHz / 1e3).toFixed(2)} kHz`;
  return `${valueHz.toFixed(1)} Hz`;
}

function safeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "walker"
  );
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

function Inspector({ slice, selection }: { slice: NetworkSlice; selection: Selection }) {
  if (selection.type === "link") {
    const link = slice.links.find((item) => item.id === selection.id) ?? slice.links[0];
    return (
      <section className="inspector">
        <div className="section-heading">
          <RadioTower size={18} />
          <h2>链路状态</h2>
        </div>
        <h3>{`${link.source} -> ${link.target}`}</h3>
        <dl>
          <dt>候选 / 当前</dt>
          <dd>{link.designCandidate ? "候选" : "非候选"} / {link.state.isActive ? "已连接" : "已断开"}</dd>
          <dt>轨间方向</dt>
          <dd>{interPlaneDirectionLabel[link.interPlaneDirection]}</dd>
          <dt>源端天线</dt>
          <dd>{link.sourceAntennaId ?? "-"}</dd>
          <dt>目的端天线</dt>
          <dd>{link.targetAntennaId ?? "-"}</dd>
          <dt>视距可达</dt>
          <dd>{link.state.lineOfSight ? "是" : "否"}</dd>
          <dt>链路类型</dt>
          <dd>{linkKindLabel[link.kind]}</dd>
          <dt>链路状态</dt>
          <dd className={`text-${link.state.status}`}>{linkStatusLabel[link.state.status]}</dd>
          <dt>距离</dt>
          <dd>{link.state.distanceKm.toLocaleString()} km</dd>
          <dt>时延</dt>
          <dd>{link.state.latencyMs} ms</dd>
          <dt>带宽</dt>
          <dd>{link.state.bandwidthMbps.toLocaleString()} Mbps</dd>
          {link.state.linkBudget ? (
            <>
              <dt>频率</dt>
              <dd>{link.state.linkBudget.frequency_ghz.toLocaleString()} GHz</dd>
              <dt>频率复用信道</dt>
              <dd>
                CH-{link.state.linkBudget.channel_id} / {link.state.linkBudget.channel_offset_mhz.toFixed(0)} MHz
              </dd>
              <dt>多普勒频移</dt>
              <dd>
                {formatFrequencyOffset(link.state.linkBudget.doppler_shift_hz)} / 径向速度{" "}
                {link.state.linkBudget.relative_radial_velocity_km_s.toFixed(4)} km/s
              </dd>
              <dt>多普勒残差</dt>
              <dd>
                {formatFrequencyOffset(link.state.linkBudget.doppler_residual_hz)} / 裕量{" "}
                {formatFrequencyOffset(link.state.linkBudget.doppler_residual_margin_hz)}
              </dd>
              <dt>多普勒损耗</dt>
              <dd>
                {link.state.linkBudget.doppler_loss_db.toFixed(4)} dB / 跟踪裕量{" "}
                {formatFrequencyOffset(link.state.linkBudget.doppler_tracking_margin_hz)}
              </dd>
              <dt>自由空间损耗</dt>
              <dd>{link.state.linkBudget.free_space_path_loss_db.toFixed(1)} dB</dd>
              <dt>指向损耗</dt>
              <dd>
                {link.state.linkBudget.pointing_loss_db.toFixed(2)} dB / 动态{" "}
                {link.state.linkBudget.dynamic_pointing_loss_db.toFixed(3)} dB
              </dd>
              <dt>切换 / 可用</dt>
              <dd>
                {link.state.linkBudget.switching_delay_s.toFixed(2)} s /{" "}
                {(link.state.linkBudget.availability_factor * 100).toFixed(1)}%
              </dd>
              <dt>指向误差</dt>
              <dd>
                源 {link.state.linkBudget.source_pointing_error_deg.toFixed(3)}° / 目的{" "}
                {link.state.linkBudget.target_pointing_error_deg.toFixed(3)}°
              </dd>
              <dt>接收功率</dt>
              <dd>{link.state.linkBudget.received_power_dbm.toFixed(1)} dBm</dd>
              <dt>噪声功率</dt>
              <dd>{link.state.linkBudget.noise_power_dbm.toFixed(1)} dBm</dd>
              <dt>环境噪声</dt>
              <dd>
                +{link.state.linkBudget.environmental_noise_increase_db.toFixed(3)} dB / 太阳噪声{" "}
                {link.state.linkBudget.sun_noise_temperature_k.toFixed(1)} K
              </dd>
              <dt>太阳夹角</dt>
              <dd>
                {link.state.linkBudget.sun_separation_deg.toFixed(2)}° / 系统噪声温度{" "}
                {link.state.linkBudget.system_noise_temperature_k.toFixed(1)} K
              </dd>
              <dt>太阳规避</dt>
              <dd>
                {link.state.linkBudget.solar_interference_loss_db.toFixed(3)} dB / 裕量{" "}
                {link.state.linkBudget.solar_exclusion_margin_deg.toFixed(2)}° /{" "}
                {link.state.linkBudget.solar_interference_blocked ? "闭锁" : "通过"}
              </dd>
              <dt>SNR / 裕量</dt>
              <dd>
                {link.state.linkBudget.snr_db.toFixed(1)} dB / {link.state.linkBudget.link_margin_db.toFixed(1)} dB
              </dd>
              <dt>SINR / 裕量</dt>
              <dd>
                {link.state.linkBudget.sinr_db.toFixed(1)} dB / {link.state.linkBudget.sinr_margin_db.toFixed(1)} dB
              </dd>
              <dt>MCS / 码率</dt>
              <dd>{link.state.linkBudget.mcs_id} / {link.state.linkBudget.code_rate.toFixed(2)}</dd>
              <dt>BER / PER</dt>
              <dd>
                {formatScientific(link.state.linkBudget.bit_error_rate)} / {formatScientific(link.state.linkBudget.packet_error_rate)}
              </dd>
              <dt>干扰功率 / I/N</dt>
              <dd>
                {link.state.linkBudget.interference_count > 0
                  ? `${link.state.linkBudget.interference_power_dbm.toFixed(1)} dBm / ${link.state.linkBudget.interference_to_noise_db.toFixed(1)} dB`
                  : "无有效同频干扰"}
              </dd>
              <dt>干扰源</dt>
              <dd>
                {link.state.linkBudget.interference_count > 0
                  ? `${link.state.linkBudget.interference_count} 条 / 同频 ${link.state.linkBudget.co_channel_interference_count} / 邻频 ${link.state.linkBudget.adjacent_channel_interference_count} / ${link.state.linkBudget.dominant_interferer_id ?? "-"}`
                  : "-"}
              </dd>
              <dt>频率滤除</dt>
              <dd>
                {link.state.linkBudget.filtered_channel_interference_count} 条潜在干扰 / 主干扰 ΔCH{" "}
                {link.state.linkBudget.dominant_interferer_channel_delta ?? "-"}
              </dd>
              <dt>Shannon 容量</dt>
              <dd>
                {link.state.linkBudget.interference_limited_capacity_mbps.toLocaleString()} Mbps
                {" / 噪声受限 "}
                {link.state.linkBudget.shannon_capacity_mbps.toLocaleString()} Mbps
              </dd>
              <dt>有效容量</dt>
              <dd>
                {link.state.linkBudget.effective_capacity_mbps.toLocaleString()} Mbps / 原始 MCS{" "}
                {link.state.linkBudget.raw_mcs_capacity_mbps.toLocaleString()} Mbps
              </dd>
            </>
          ) : null}
          <dt>利用率</dt>
          <dd>{link.state.utilizationPercent}%</dd>
          <dt>需求/承载</dt>
          <dd>{link.state.demandTrafficMbps.toFixed(1)} / {link.state.carriedTrafficMbps.toFixed(1)} Mbps</dd>
          <dt>链路队列/丢弃</dt>
          <dd>{link.state.queuedTrafficMb.toFixed(1)} MB / {link.state.droppedTrafficMb.toFixed(1)} MB</dd>
          <dt>拥塞程度</dt>
          <dd>{link.state.congestionPercent.toFixed(1)}%</dd>
          {link.state.restrictionReason ? (
            <>
              <dt>断开原因</dt>
              <dd className="text-down">{restrictionReasonText(link.state.restrictionReason)}</dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }

  const node = slice.nodes.find((item) => item.id === selection.id) ?? slice.nodes[0];
  return (
    <section className="inspector">
      <div className="section-heading">
        <Satellite size={18} />
        <h2>节点状态</h2>
      </div>
      <h3>{node.label}</h3>
      <dl>
        <dt>轨道模型</dt>
        <dd>{orbitModelLabel[node.orbit.orbitModel]}</dd>
        {node.orbit.noradId ? (
          <>
            <dt>NORAD / 名称</dt>
            <dd>{node.orbit.noradId} / {node.orbit.satelliteName}</dd>
            <dt>COSPAR ID</dt>
            <dd>{node.orbit.cosparId}</dd>
          </>
        ) : null}
        <dt>运行模式</dt>
        <dd>{simulationModeLabel[node.operationMode]}</dd>
        <dt>节点编号</dt>
        <dd>{node.resources.node_id}</dd>
        <dt>节点类型</dt>
        <dd>{nodeTypeLabel[node.resources.node_type]}</dd>
        <dt>可接收任务</dt>
        <dd>{node.resources.can_accept_tasks ? "是" : "否"}</dd>
        <dt>参与任务（源端/经过）</dt>
        <dd><TaskParticipationDetail slice={slice} nodeId={node.id} /></dd>
        <dt>光照状态</dt>
        <dd>{node.timeState.inSunlight ? "正面受光 / 充电" : "背面阴影 / 放电"} ({Math.round(node.timeState.solarExposure * 100)}%)</dd>
        <dt>东西向漂移</dt>
        <dd>{node.timeState.eastWestDriftDeg.toFixed(2)} 度</dd>
        <dt>CPU 算力</dt>
        <dd>{node.resources.cpu_capacity.toLocaleString()} GOPS</dd>
        <dt>GPU 算力</dt>
        <dd>{node.resources.gpu_capacity === undefined ? "-" : `${node.resources.gpu_capacity.toLocaleString()} TOPS`}</dd>
        <dt>内存</dt>
        <dd>{node.resources.memory.toLocaleString()} GB / 已用 {node.resources.memory_utilization}%</dd>
        <dt>存储</dt>
        <dd>{node.resources.storage.toLocaleString()} GB / 已用 {node.resources.storage_utilization}%</dd>
        <dt>电量</dt>
        <dd>{node.resources.energy}% / {node.resources.energy_wh.toFixed(0)} Wh</dd>
        <dt>电池容量</dt>
        <dd>{node.resources.battery_capacity_wh.toLocaleString()} Wh</dd>
        <dt>SoC</dt>
        <dd>{(node.resources.state_of_charge * 100).toFixed(1)}%</dd>
        <dt>节能模式</dt>
        <dd className={node.resources.power_saving_mode ? "text-warning" : "text-up"}>
          {node.resources.power_saving_mode ? "已进入" : "未进入"} / 阈值{" "}
          {(node.resources.min_state_of_charge * 100).toFixed(0)}%
        </dd>
        <dt>太阳翼功率</dt>
        <dd>{node.resources.solar_power_w.toFixed(0)} W</dd>
        <dt>负载功率</dt>
        <dd>{node.resources.load_power_w.toFixed(0)} W</dd>
        <dt>电池净功率</dt>
        <dd className={node.resources.net_power_w >= 0 ? "text-up" : "text-down"}>
          {node.resources.net_power_w >= 0 ? "+" : ""}
          {node.resources.net_power_w.toFixed(0)} W
        </dd>
        <dt>CPU 利用率</dt>
        <dd>{node.resources.cpu_utilization}%</dd>
        <dt>CPU 贡献拆解</dt>
        <dd>
          计算 {node.resources.compute_cpu_percent.toFixed(1)}% / 业务{" "}
          {node.resources.task_traffic_cpu_percent.toFixed(1)}% / 转发{" "}
          {node.resources.forwarding_cpu_percent.toFixed(1)}% / 队列{" "}
          {node.resources.queue_cpu_percent.toFixed(1)}%
        </dd>
        <dt>GPU 利用率</dt>
        <dd>{node.resources.gpu_utilization === undefined ? "-" : `${node.resources.gpu_utilization}%`}</dd>
        <dt>任务负载</dt>
        <dd>{node.resources.workload_cpu_percent}% CPU / {node.resources.workload_gpu_percent}% GPU</dd>
        <dt>任务内存/存储</dt>
        <dd>{node.resources.workload_memory_gb} GB / {node.resources.workload_storage_gb} GB</dd>
        <dt>总内存/存储</dt>
        <dd>
          {node.resources.memory_used_gb.toFixed(2)} GB / {node.resources.storage_used_gb.toFixed(2)} GB
        </dd>
        <dt>业务流量</dt>
        <dd>
          入 {node.resources.ingress_traffic_mbps.toFixed(1)} / 出 {node.resources.egress_traffic_mbps.toFixed(1)} / 转发{" "}
          {node.resources.transit_traffic_mbps.toFixed(1)} Mbps
        </dd>
        <dt>链路占用</dt>
        <dd>
          ISL {node.resources.active_isl_links} / SGL {node.resources.active_sgl_links} /{" "}
          {node.resources.link_occupancy_percent.toFixed(1)}%
        </dd>
        <dt>转发负载</dt>
        <dd>{node.resources.forwarding_load_mbps.toFixed(1)} Mbps</dd>
        <dt>星地下传</dt>
        <dd>{node.resources.downlink_load_mbps.toFixed(1)} Mbps</dd>
        <dt>通信附加功耗</dt>
        <dd>{node.resources.communication_power_w.toFixed(1)} W</dd>
        <dt>功耗贡献拆解</dt>
        <dd>
          基础 {node.resources.base_power_w.toFixed(0)} W / 载荷 {node.resources.payload_power_w.toFixed(0)} W / 任务计算{" "}
          {node.resources.task_compute_power_w.toFixed(1)} W / 网络计算{" "}
          {node.resources.network_compute_power_w.toFixed(1)} W
        </dd>
        <dt>业务队列/丢弃</dt>
        <dd>{node.resources.queued_traffic_mb.toFixed(1)} MB / {node.resources.dropped_traffic_mb.toFixed(1)} MB</dd>
        <dt>缓存占用</dt>
        <dd>{node.resources.cache_used_mb.toFixed(1)} MB / {node.resources.cache_utilization.toFixed(1)}%</dd>
        <dt>遥测生成</dt>
        <dd>{node.resources.telemetry_generated_mb.toFixed(1)} MB</dd>
        <dt>遥测缓存</dt>
        <dd>{node.resources.telemetry_buffer_mb.toFixed(1)} MB</dd>
        <dt>遥测下传/丢弃</dt>
        <dd>{node.resources.telemetry_downlinked_mb.toFixed(1)} MB / {node.resources.telemetry_dropped_mb.toFixed(1)} MB</dd>
      </dl>
      <details className="static-orbit-details" open>
        <summary>天线与星地窗口</summary>
        <dl>
          <dt>ISL 天线</dt>
          <dd>
            {node.antennas.filter((antenna) => antenna.type === "ISL").map((antenna) =>
              `${antennaRoleText(antenna.role)}:${antennaStateText(antenna.state)}`
            ).join(" / ")}
          </dd>
          <dt>SGL 天线</dt>
          <dd>
            {node.antennas.filter((antenna) => antenna.type === "SGL").map((antenna) =>
              `${antenna.band} ${antennaStateText(antenna.state)} ${antenna.bandwidth_mbps} Mbps`
            ).join(" / ")}
          </dd>
          <dt>最佳地面站</dt>
          <dd>
            {node.groundLinkWindows.find((window) => window.status === "available")
              ? `${node.groundLinkWindows.find((window) => window.status === "available")?.ground_station_name} / 仰角 ${node.groundLinkWindows.find((window) => window.status === "available")?.elevationDeg.toFixed(1)}°`
              : "当前无可用窗口"}
          </dd>
          <dt>上报容量</dt>
          <dd>
            {node.groundLinkWindows
              .filter((window) => window.status === "available")
              .reduce((total, window) => total + window.reportCapacityMbps, 0)
              .toLocaleString()} Mbps
          </dd>
          <dt>窗口约束</dt>
          <dd>
            {node.groundLinkWindows.slice(0, 3).map((window) =>
              `${window.ground_station_name}:${window.visible ? `${window.elevationDeg.toFixed(1)}°` : groundWindowReasonText(window.reason)}`
            ).join(" / ")}
          </dd>
        </dl>
      </details>
      <details className="static-orbit-details">
        <summary>轨道静态参数</summary>
        <dl>
          <dt>壳层</dt>
          <dd>{node.orbit.shellId}</dd>
          <dt>Walker 类型</dt>
          <dd>{node.orbit.walkerType}</dd>
          <dt>半长轴</dt>
          <dd>{node.orbit.semiMajorAxisKm.toFixed(1)} km</dd>
          <dt>倾角 / RAAN</dt>
          <dd>{node.orbit.inclinationDeg.toFixed(2)} / {node.orbit.raanDeg.toFixed(2)} 度</dd>
          <dt>平均近点角</dt>
          <dd>{node.orbit.meanAnomalyDegAtEpoch.toFixed(2)} 度</dd>
          <dt>平均运动</dt>
          <dd>
            {node.orbit.meanMotionRadPerSec.toFixed(6)} rad/s
            {node.orbit.meanMotionRevPerDay ? ` / ${node.orbit.meanMotionRevPerDay.toFixed(8)} rev/day` : ""}
          </dd>
          {node.orbit.tleLine1 && node.orbit.tleLine2 ? (
            <>
              <dt>TLE Line 1</dt>
              <dd className="tle-line">{node.orbit.tleLine1}</dd>
              <dt>TLE Line 2</dt>
              <dd className="tle-line">{node.orbit.tleLine2}</dd>
            </>
          ) : null}
          <dt>周期 / 速度</dt>
          <dd>{node.orbit.orbitalPeriodMinutes.toFixed(2)} 分钟 / {node.timeState.orbitalVelocityKmS.toFixed(3)} km/s</dd>
        </dl>
      </details>
      <dl>
        <dt>时间</dt>
        <dd>{new Date(node.timeState.time).toLocaleString()}</dd>
        <dt>ECI 坐标</dt>
        <dd>{node.timeState.eci.x.toFixed(1)} / {node.timeState.eci.y.toFixed(1)} / {node.timeState.eci.z.toFixed(1)} km</dd>
        <dt>ECEF 坐标</dt>
        <dd>{node.timeState.ecef.x.toFixed(1)} / {node.timeState.ecef.y.toFixed(1)} / {node.timeState.ecef.z.toFixed(1)} km</dd>
        <dt>ECI 速度</dt>
        <dd>{node.timeState.velocityEci.vx.toFixed(3)} / {node.timeState.velocityEci.vy.toFixed(3)} / {node.timeState.velocityEci.vz.toFixed(3)} km/s</dd>
        <dt>星下点</dt>
        <dd>{node.timeState.groundTrack.longitudeDeg.toFixed(2)} / {node.timeState.groundTrack.latitudeDeg.toFixed(2)} 度</dd>
        <dt>轨道面 / 槽位</dt>
        <dd>{node.plane + 1} / {node.slot + 1}</dd>
        <dt>健康状态</dt>
        <dd className={`text-${node.state.mode}`}>{nodeStatusLabel[node.state.mode]}</dd>
        <dt>温度</dt>
        <dd>{node.state.temperatureC} °C</dd>
        <dt>队列深度</dt>
        <dd>{node.state.queueDepth}</dd>
      </dl>
    </section>
  );
}

function LinkTable({ slice, onSelect }: { slice: NetworkSlice; onSelect: (selection: Selection) => void }) {
  const orderedLinks = [...slice.links].sort((a, b) => {
    const order = { down: 0, warning: 1, up: 2 };
    return order[a.state.status] - order[b.state.status] || b.state.distanceKm - a.state.distanceKm;
  });

  return (
    <section className="table-panel">
      <div className="section-heading">
        <Activity size={18} />
        <h2>全部链路</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>链路</th>
              <th>类型</th>
              <th>状态</th>
              <th>原因</th>
              <th>距离</th>
              <th>利用率</th>
            </tr>
          </thead>
          <tbody>
            {orderedLinks.map((link) => (
              <tr key={link.id} onClick={() => onSelect({ type: "link", id: link.id })}>
                <td>{`${link.source} -> ${link.target}`}</td>
                <td>{linkKindLabel[link.kind]}</td>
                <td><span className={`status-pill ${link.state.status}`}>{linkStatusLabel[link.state.status]}</span></td>
                <td>{link.state.restrictionReason ? restrictionReasonText(link.state.restrictionReason) : "-"}</td>
                <td>{link.state.distanceKm.toLocaleString()} km</td>
                <td>{link.state.utilizationPercent}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RouteTable({ slice }: { slice: NetworkSlice }) {
  return (
    <section className="table-panel">
      <div className="section-heading">
        <Activity size={18} />
        <h2>任务路由</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>任务</th>
              <th>算法</th>
              <th>源节点</th>
              <th>目标节点</th>
              <th>状态</th>
              <th>优先级</th>
              <th>需求/承载</th>
              <th>排队/丢弃</th>
              <th>遥测增量</th>
              <th>跳数</th>
              <th>时延</th>
              <th>路径</th>
            </tr>
          </thead>
          <tbody>
            {slice.routes.length === 0 ? (
              <tr>
                <td colSpan={12}>当前时间片没有需要路由的任务</td>
              </tr>
            ) : (
              slice.routes.map((route) => (
                <tr key={`${route.task_id}:${route.source ?? "-"}:${route.target ?? "-"}`}>
                  <td>{route.task_id}</td>
                  <td>{routingAlgorithmLabel[route.algorithm]}</td>
                  <td>{route.source ?? "-"}</td>
                  <td>{route.target ?? "-"}</td>
                  <td><span className={`status-pill ${route.status === "routed" || route.status === "local" ? "up" : "down"}`}>{routeStatusLabel[route.status]}</span></td>
                  <td>{route.priority}</td>
                  <td>{route.trafficMbps.toFixed(1)} / {route.carriedTrafficMbps.toFixed(1)} Mbps</td>
                  <td>{route.queuedTrafficMb.toFixed(1)} / {route.droppedTrafficMb.toFixed(1)} MB</td>
                  <td>
                    {route.taskTelemetryGeneratedMb > 0
                      ? `${route.taskTelemetryGeneratedMb.toFixed(1)} MB @ ${route.taskTelemetryNodeId ?? "-"}`
                      : "-"}
                  </td>
                  <td>{route.hopCount}</td>
                  <td>{route.latencyMs} ms</td>
                  <td>{route.path.length ? route.path.join(" -> ") : route.reason ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GroundLinkTable({ slice }: { slice: NetworkSlice }) {
  const orderedWindows = [...slice.groundLinks]
    .sort((a, b) => {
      const order = { available: 0, occupied: 1, blocked: 2 };
      return order[a.status] - order[b.status] || b.elevationDeg - a.elevationDeg;
    })
    .slice(0, 40);

  return (
    <section className="table-panel">
      <div className="section-heading">
        <RadioTower size={18} />
        <h2>星地窗口</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>卫星</th>
              <th>地面站</th>
              <th>状态</th>
              <th>仰角</th>
              <th>距离</th>
              <th>SNR</th>
              <th>信道</th>
              <th>噪声</th>
              <th>雨强</th>
              <th>大气损耗</th>
              <th>雨衰</th>
              <th>指向/可用</th>
              <th>多普勒</th>
              <th>干扰/I/N</th>
              <th>MCS</th>
              <th>PER</th>
              <th>上报容量</th>
            </tr>
          </thead>
          <tbody>
            {orderedWindows.map((window) => (
              <tr key={window.id}>
                <td>{window.satellite_id}</td>
                <td>{window.ground_station_name}</td>
                <td>
                  <span className={`status-pill ${window.status === "available" ? "up" : window.status === "occupied" ? "warning" : "down"}`}>
                    {window.status === "available" ? "可用" : window.status === "occupied" ? "天线占用" : groundWindowReasonText(window.reason)}
                  </span>
                </td>
                <td>{window.elevationDeg.toFixed(1)}°</td>
                <td>{window.slantRangeKm.toLocaleString()} km</td>
                <td>{window.linkBudget ? `${window.linkBudget.snr_db.toFixed(1)} dB` : "-"}</td>
                <td>{window.linkBudget ? `CH-${window.linkBudget.channel_id}` : "-"}</td>
                <td>{window.linkBudget ? `+${window.linkBudget.environmental_noise_increase_db.toFixed(3)} dB` : "-"}</td>
                <td>{window.rainRateMmPerHour.toFixed(2)} mm/h</td>
                <td>{window.linkBudget ? `${window.linkBudget.atmospheric_loss_db.toFixed(1)} dB` : "-"}</td>
                <td>{window.linkBudget ? `${window.linkBudget.rain_attenuation_db.toFixed(1)} dB` : "-"}</td>
                <td>
                  {window.linkBudget
                    ? `${window.linkBudget.dynamic_pointing_loss_db.toFixed(3)} dB / ${(window.linkBudget.availability_factor * 100).toFixed(1)}%`
                    : "-"}
                </td>
                <td>
                  {window.linkBudget
                    ? `${formatFrequencyOffset(window.linkBudget.doppler_shift_hz)} / ${window.linkBudget.doppler_loss_db.toFixed(3)} dB`
                    : "-"}
                </td>
                <td>
                  {window.linkBudget && window.linkBudget.interference_count > 0
                    ? `${window.linkBudget.co_channel_interference_count}+${window.linkBudget.adjacent_channel_interference_count} / ${window.linkBudget.interference_to_noise_db.toFixed(1)} dB`
                    : "-"}
                </td>
                <td>{window.linkBudget ? window.linkBudget.mcs_id : "-"}</td>
                <td>{window.linkBudget ? formatScientific(window.linkBudget.packet_error_rate) : "-"}</td>
                <td>{window.reportCapacityMbps.toLocaleString()} Mbps</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NodeMatrix({ slice, onSelect }: { slice: NetworkSlice; onSelect: (selection: Selection) => void }) {
  return (
    <section className="node-matrix">
      <div className="section-heading">
        <CircleDashed size={18} />
        <h2>星座节点</h2>
      </div>
      <div className="matrix-grid">
        {slice.nodes.map((node) => (
          <button
            key={node.id}
            className={`matrix-node ${node.state.mode}`}
            onClick={() => onSelect({ type: "node", id: node.id })}
            title={`${node.label} ${nodeStatusLabel[node.state.mode]}`}
          >
            <span>{node.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [page, setPage] = useState<PageKey>("dashboard");
  const [constellationProfileId, setConstellationProfileId] =
    useState<ConstellationProfileId>(defaultConstellationProfileId);
  const [simulationMode, setSimulationMode] = useState<SimulationMode>("operational");
  const [orbitModel, setOrbitModel] = useState<OrbitModel>("real-tle-sgp4");
  const defaultProfile = getConstellationProfile(defaultConstellationProfileId);
  const [routingAlgorithm, setRoutingAlgorithm] = useState<RoutingAlgorithm>(defaultProfile.config.routing.algorithm);
  const [trafficProfile, setTrafficProfile] = useState<TrafficProfile>("normal");
  const [tasks, setTasks] = useState<TaskTrafficRecord[]>([]);
  const [datasetName, setDatasetName] = useState("场景：正常业务");
  const [datasetMessage, setDatasetMessage] = useState("使用内置确定性业务模板");
  const constellationProfile = useMemo(() => getConstellationProfile(constellationProfileId), [constellationProfileId]);
  const dashboardSliceLimit =
    constellationProfile.scale === "large"
      ? DASHBOARD_LARGE_PROFILE_SLICE_LIMIT
      : constellationProfile.scale === "medium"
        ? DASHBOARD_MEDIUM_PROFILE_SLICE_LIMIT
        : constellationProfile.config.time.slices;
  const dashboardPreviewLimited = constellationProfile.config.time.slices > dashboardSliceLimit;
  const activeConfig = useMemo<WalkerNetworkConfig>(() => {
    if (!dashboardPreviewLimited) return constellationProfile.config;
    return {
      ...constellationProfile.config,
      time: {
        ...constellationProfile.config.time,
        slices: dashboardSliceLimit,
      },
    };
  }, [constellationProfile, dashboardPreviewLimited, dashboardSliceLimit]);
  const tleCatalogSnapshot = orbitModel === "real-tle-sgp4" ? constellationProfile.snapshot : undefined;
  const slices = useMemo(
    () =>
      generateWalkerNetwork(activeConfig, {
        mode: simulationMode,
        tasks,
        trafficProfile,
        orbitModel,
        routingAlgorithm,
        tleCatalogSnapshot,
      }),
    [activeConfig, simulationMode, tasks, trafficProfile, orbitModel, routingAlgorithm, tleCatalogSnapshot],
  );
  const [snapshotIndex, setSnapshotIndex] = useState<number | null>(null);
  const [motionSliceIndex, setMotionSliceIndex] = useState(0);
  const [showOrbitPlanes, setShowOrbitPlanes] = useState(true);
  const [showNodes, setShowNodes] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [controlDrawerOpen, setControlDrawerOpen] = useState(true);
  const [controlDrawerPinned, setControlDrawerPinned] = useState(true);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<PanelKey, boolean>>({
    overview: false,
    topology: false,
    details: false,
    tables: false,
  });
  const [selection, setSelection] = useState<Selection>({ type: "node", id: slices[0].nodes[0].id });
  const sliceIndex = snapshotIndex ?? motionSliceIndex;
  const slice = slices[sliceIndex];
  const metrics = metricValue(slice);
  const truthSummary = useMemo(() => truthSummaryValue(slices), [slices]);
  const snapshotMode = snapshotIndex !== null;
  const effectiveTasks = useMemo(
    () => effectiveTrafficTasks(activeConfig, trafficProfile, tasks),
    [activeConfig, tasks, trafficProfile],
  );
  const exportContext = useMemo(
    () => ({
      simulationMode,
      trafficProfile,
      orbitModel,
      routingAlgorithm,
      datasetName,
      configSnapshot: activeConfig,
      taskRecords: effectiveTasks,
      tleCatalogSnapshot,
    }),
    [activeConfig, datasetName, effectiveTasks, orbitModel, routingAlgorithm, simulationMode, trafficProfile, tleCatalogSnapshot],
  );
  const exportMetadata = useMemo(() => experimentMetadata(exportContext, slices), [exportContext, slices]);
  const exportBaseName = `walker-${safeFilePart(constellationProfile.shortLabel)}-${safeFilePart(trafficProfileLabel[trafficProfile])}-${safeFilePart(orbitModelLabel[orbitModel])}-${safeFilePart(datasetName)}`;

  const handleExport = (
    kind: "json" | "nodes" | "links" | "routes" | "metrics" | "task-trace" | "link-impact" | "node-impact",
  ) => {
    if (kind === "json") {
      downloadTextFile(`${exportBaseName}-truth.json`, experimentJson(exportContext, slices), "application/json");
      return;
    }

    const rows =
      kind === "nodes"
        ? nodeSnapshotRows(slices)
        : kind === "links"
          ? linkSnapshotRows(slices)
          : kind === "routes"
            ? routeSnapshotRows(slices)
            : kind === "metrics"
              ? networkMetricRows(slices)
              : kind === "task-trace"
                ? taskTraceRows(slices, effectiveTasks)
                : kind === "link-impact"
                  ? businessLinkImpactRows(slices, effectiveTasks)
                  : businessNodeImpactRows(slices, effectiveTasks);

    downloadTextFile(`${exportBaseName}-${kind}.csv`, rowsToCsv(rows), "text/csv");
  };

  const selectTrafficProfile = (profile: TrafficProfile) => {
    setTrafficProfile(profile);
    if (profile !== "uploaded") {
      setTasks([]);
      setDatasetName(profile === "empty" ? "场景：空业务" : `场景：${trafficProfileLabel[profile]}`);
      setDatasetMessage(profile === "empty" ? "无业务输入，用于验证空载状态" : "使用内置确定性业务模板");
    } else if (tasks.length === 0) {
      setDatasetName("等待上传数据集");
      setDatasetMessage("支持 CSV/JSON 标准任务数据");
    }
  };

  const handleDatasetUpload = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    try {
      const parsedTasks = parseTaskDataset(text, file.name);
      const validation = validateTaskDataset(parsedTasks, constellationProfile.config);
      if (validation.errors.length > 0) {
        setTasks([]);
        setDatasetName("校验失败");
        setDatasetMessage(validation.errors[0]);
        return;
      }
      setTasks(parsedTasks);
      setDatasetName(`${file.name} (${validation.accepted} 条)`);
      setDatasetMessage(validation.warnings.length > 0 ? `${validation.warnings.length} 条警告：${validation.warnings[0]}` : "数据集校验通过");
      setSimulationMode("operational");
      setTrafficProfile("uploaded");
      setSnapshotIndex(0);
      setMotionSliceIndex(0);
    } catch {
      setTasks([]);
      setDatasetName("解析失败");
      setDatasetMessage("请检查 CSV/JSON 格式");
    }
  };

  useEffect(() => {
    if (snapshotMode) return undefined;
    const timer = window.setInterval(() => {
      setMotionSliceIndex((index) => (index + 1) % slices.length);
    }, 1600);
    return () => window.clearInterval(timer);
  }, [snapshotMode, slices.length]);

  useEffect(() => {
    const selectionExists =
      selection.type === "node"
        ? slice.nodes.some((node) => node.id === selection.id)
        : slice.links.some((link) => link.id === selection.id);
    if (!selectionExists && slice.nodes[0]) {
      setSelection({ type: "node", id: slice.nodes[0].id });
    }
  }, [selection, slice]);

  const handleTimeSelect = (index: number) => {
    setSnapshotIndex(index);
    setMotionSliceIndex(index);
  };

  const handleResumeMotion = () => {
    setSnapshotIndex(null);
    setMotionSliceIndex(slice.index);
  };

  const togglePanel = (panel: PanelKey) => {
    setCollapsedPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const navItems = [
    { href: "#controls", label: "控制" },
    { href: "#overview", label: "总览" },
    { href: "#topology", label: "拓扑" },
    { href: "#details", label: "详情" },
    { href: "#tables", label: "数据" },
  ];

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-line">
            <Orbit size={24} />
            <span>Walker 卫星网络</span>
          </div>
          <h1>动态拓扑全网感知仪表盘</h1>
        </div>
        <nav className="dashboard-nav" aria-label="仪表盘导航">
          <button type="button" className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>
            星座仪表盘
          </button>
          <button type="button" className={page === "telemetry" ? "active" : ""} onClick={() => setPage("telemetry")}>
            遥测仿真
          </button>
          {page === "dashboard"
            ? navItems.map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))
            : null}
        </nav>
      </header>

      {page === "telemetry" ? (
        <TelemetrySimulationPage
          slices={slices}
          sliceIndex={sliceIndex}
          snapshotMode={snapshotMode}
          datasetName={datasetName}
          onTimeSelect={handleTimeSelect}
          onResumeMotion={handleResumeMotion}
          onBack={() => setPage("dashboard")}
        />
      ) : (
      <>
      <section
        id="controls"
        className={`dashboard-section controls-section drawer-section ${controlDrawerOpen ? "is-open" : "is-collapsed"} ${
          controlDrawerPinned ? "is-pinned" : ""
        }`}
      >
        <div className="section-title-row drawer-title-row">
          <div>
            <span className="section-kicker">Control</span>
            <h2>控制台</h2>
          </div>
          <div className="section-tools">
            <div className="section-status">
              {constellationProfile.shortLabel} · {simulationModeLabel[simulationMode]} · {trafficProfileLabel[trafficProfile]} · {orbitModelLabel[orbitModel]}
            </div>
            <button
              type="button"
              className={`icon-action ${controlDrawerPinned ? "active" : ""}`}
              onClick={() => setControlDrawerPinned((value) => !value)}
              title={controlDrawerPinned ? "取消固定控制台" : "固定控制台"}
              aria-pressed={controlDrawerPinned}
            >
              {controlDrawerPinned ? <Lock size={16} /> : <Unlock size={16} />}
            </button>
            <button
              type="button"
              className="icon-action"
              onClick={() => setControlDrawerOpen((value) => !value)}
              title={controlDrawerOpen ? "收起控制台" : "展开控制台"}
              aria-expanded={controlDrawerOpen}
            >
              {controlDrawerOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>
        </div>
        <div className="drawer-body time-control control-card">
          <label htmlFor="slice">
            {snapshotMode ? "快照" : "运动"} T{slice.index.toString().padStart(2, "0")} · +{slice.minute} 分钟
          </label>
          <input
            id="slice"
            type="range"
            min="0"
            max={slices.length - 1}
            value={sliceIndex}
            onChange={(event) => setSnapshotIndex(Number(event.target.value))}
          />
          <div className="snapshot-strip" aria-label="时间片">
            <button
              type="button"
              className={`snapshot-chip ${!snapshotMode ? "active" : ""}`}
              onClick={() => {
                setSnapshotIndex(null);
                setMotionSliceIndex(slice.index);
              }}
            >
              运动
            </button>
            {slices.map((item) => (
              <button
                type="button"
                key={item.index}
                className={`snapshot-chip ${snapshotIndex === item.index ? "active" : ""}`}
                onClick={() => setSnapshotIndex(item.index)}
              >
                T{item.index.toString().padStart(2, "0")}
              </button>
            ))}
          </div>
          <div className="display-settings" aria-label="显示设置">
            <div className="mode-switch constellation-switch" aria-label="星座模型">
              {constellationProfiles.map((profile) => (
                <button
                  type="button"
                  key={profile.id}
                  className={constellationProfileId === profile.id ? "active" : ""}
                  title={`${profile.sourceSummary} ${profile.architectureSummary}`}
                  onClick={() => {
                    setConstellationProfileId(profile.id);
                    setOrbitModel("real-tle-sgp4");
                    setSnapshotIndex(0);
                    setMotionSliceIndex(0);
                  }}
                >
                  {profile.label}
                </button>
              ))}
            </div>
            <div className="profile-note">
              <strong>{constellationProfile.operator}</strong>
              <span>{constellationProfile.sourceSummary}</span>
              <span>{constellationProfile.experimentUse}</span>
              {dashboardPreviewLimited ? (
                <span>网页预览限制为前 {dashboardSliceLimit} 个时间片；完整 48 片请使用实验脚本导出。</span>
              ) : null}
            </div>
            <div className="mode-switch" aria-label="仿真模式">
              <button
                type="button"
                className={simulationMode === "autonomous" ? "active" : ""}
                onClick={() => setSimulationMode("autonomous")}
              >
                自主模拟
              </button>
              <button
                type="button"
                className={simulationMode === "operational" ? "active" : ""}
                onClick={() => setSimulationMode("operational")}
              >
                真实运行
              </button>
            </div>
            <div className="mode-switch" aria-label="路由算法">
              <button
                type="button"
                className={routingAlgorithm === "congestion-aware-shortest-path" ? "active" : ""}
                onClick={() => setRoutingAlgorithm("congestion-aware-shortest-path")}
              >
                拥塞感知
              </button>
              <button
                type="button"
                className={routingAlgorithm === "shortest-path" ? "active" : ""}
                onClick={() => setRoutingAlgorithm("shortest-path")}
              >
                最短路径
              </button>
            </div>
            <div className="mode-switch" aria-label="业务流量">
              {trafficProfiles.map((profile) => (
                <button
                  type="button"
                  key={profile}
                  className={trafficProfile === profile ? "active" : ""}
                  onClick={() => selectTrafficProfile(profile)}
                >
                  {trafficProfileLabel[profile]}
                </button>
              ))}
            </div>
            <div className="mode-switch" aria-label="轨道模型">
              <button
                type="button"
                className={orbitModel === "analytic-walker" ? "active" : ""}
                onClick={() => setOrbitModel("analytic-walker")}
              >
                解析 Walker
              </button>
              <button
                type="button"
                className={orbitModel === "tle-sgp4" ? "active" : ""}
                onClick={() => setOrbitModel("tle-sgp4")}
              >
                TLE + SGP4
              </button>
              <button
                type="button"
                className={orbitModel === "real-tle-sgp4" ? "active" : ""}
                onClick={() => setOrbitModel("real-tle-sgp4")}
              >
                真实 TLE + SGP4
              </button>
            </div>
            <label className="dataset-upload">
              <input
                type="file"
                accept=".json,.csv,application/json,text/csv"
                onChange={(event) => handleDatasetUpload(event.target.files?.[0])}
              />
              <span>数据集：{datasetName}</span>
              <small>{datasetMessage}</small>
            </label>
            <div className="export-actions" aria-label="真值导出">
              <span><Download size={16} />导出真值</span>
              <button type="button" onClick={() => handleExport("json")}>完整 JSON</button>
              <button type="button" onClick={() => handleExport("nodes")}>节点 CSV</button>
              <button type="button" onClick={() => handleExport("links")}>链路 CSV</button>
              <button type="button" onClick={() => handleExport("routes")}>路由 CSV</button>
              <button type="button" onClick={() => handleExport("metrics")}>指标 CSV</button>
              <button type="button" onClick={() => handleExport("task-trace")}>任务追踪</button>
              <button type="button" onClick={() => handleExport("link-impact")}>链路影响</button>
              <button type="button" onClick={() => handleExport("node-impact")}>节点影响</button>
            </div>
            <label className="toggle-control">
              <input
                type="checkbox"
                checked={showOrbitPlanes}
                onChange={(event) => setShowOrbitPlanes(event.target.checked)}
              />
              <span><Layers2 size={16} />轨道面</span>
            </label>
            <label className="toggle-control">
              <input
                type="checkbox"
                checked={showNodes}
                onChange={(event) => setShowNodes(event.target.checked)}
              />
              <span><Satellite size={16} />节点</span>
            </label>
            <label className="toggle-control">
              <input
                type="checkbox"
                checked={showLinks}
                onChange={(event) => setShowLinks(event.target.checked)}
              />
              <span><RadioTower size={16} />链路</span>
            </label>
          </div>
        </div>
        <button
          type="button"
          className="drawer-pull"
          onClick={() => setControlDrawerOpen((value) => !value)}
          aria-expanded={controlDrawerOpen}
        >
          {controlDrawerOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {controlDrawerOpen ? "上拉收起控制台" : "下拉展开控制台"}
        </button>
      </section>

      <section id="overview" className={`dashboard-section module-section ${collapsedPanels.overview ? "is-collapsed" : ""}`}>
        <div className="section-title-row">
          <div>
            <span className="section-kicker">Overview</span>
            <h2>全网总览</h2>
          </div>
          <div className="section-tools">
            <div className="section-status">
              T{slice.index.toString().padStart(2, "0")} · +{slice.minute} 分钟
            </div>
            <button
              type="button"
              className="icon-action"
              onClick={() => togglePanel("overview")}
              title={collapsedPanels.overview ? "展开全网总览" : "收起全网总览"}
              aria-expanded={!collapsedPanels.overview}
            >
              {collapsedPanels.overview ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
        </div>
      <div className="module-body">
      <section className="stats-grid">
        <StatTile icon={<Satellite size={20} />} label="卫星数量" value={`${slice.nodes.length}`} tone="good" />
        <StatTile icon={<RadioTower size={20} />} label="链路可用率" value={`${metrics.availability}%`} tone={metrics.availability > 85 ? "good" : "warn"} />
        <StatTile icon={<Gauge size={20} />} label="平均负载" value={`${metrics.avgLoad}%`} />
        <StatTile icon={<Thermometer size={20} />} label="异常节点" value={`${metrics.warningNodes + metrics.degradedNodes}`} tone={metrics.degradedNodes ? "bad" : metrics.warningNodes ? "warn" : "good"} />
        <StatTile icon={<BatteryMedium size={20} />} label="活跃链路" value={`${metrics.upLinks}/${metrics.totalLinks}`} />
        <StatTile icon={<RadioTower size={20} />} label="星地窗口" value={`${metrics.availableGroundLinks}`} tone={metrics.availableGroundLinks ? "good" : "warn"} />
        <StatTile icon={<RadioTower size={20} />} label="SGL 大气损耗" value={`${metrics.maxSglAtmosphericLossDb.toFixed(1)} dB`} tone={metrics.maxSglAtmosphericLossDb > 8 ? "warn" : "good"} />
        <StatTile
          icon={<RadioTower size={20} />}
          label="最大雨强"
          value={`${metrics.maxGroundRainRate.toFixed(1)} mm/h`}
          tone={metrics.maxGroundRainRate > 10 ? "warn" : "good"}
        />
        <StatTile
          icon={<RadioTower size={20} />}
          label="环境噪声"
          value={`+${metrics.maxEnvironmentalNoiseIncreaseDb.toFixed(3)} dB`}
          tone={metrics.maxEnvironmentalNoiseIncreaseDb > 1 ? "warn" : "good"}
        />
        <StatTile
          icon={<RadioTower size={20} />}
          label="太阳夹角"
          value={`${metrics.minSunSeparationDeg.toFixed(1)}° / ${Math.round(metrics.maxSunNoiseTemperatureK)} K`}
          tone={metrics.maxEnvironmentalNoiseIncreaseDb > 1 ? "warn" : "good"}
        />
        <StatTile
          icon={<RadioTower size={20} />}
          label="太阳规避"
          value={`${metrics.solarInterferenceAffectedLinks} 条 / ${metrics.minSolarExclusionMarginDeg.toFixed(1)}°`}
          tone={metrics.solarInterferenceAffectedLinks > 0 ? "warn" : "good"}
        />
        <StatTile
          icon={<RadioTower size={20} />}
          label="太阳损耗"
          value={`${metrics.maxSolarInterferenceLossDb.toFixed(3)} dB`}
          tone={metrics.maxSolarInterferenceLossDb > 0 ? "warn" : "good"}
        />
        <StatTile icon={<RadioTower size={20} />} label="指向损耗" value={`${metrics.maxDynamicPointingLossDb.toFixed(3)} dB`} tone={metrics.maxDynamicPointingLossDb > 1 ? "warn" : "good"} />
        <StatTile icon={<RadioTower size={20} />} label="天线可用比" value={`${(metrics.minAvailabilityFactor * 100).toFixed(1)}%`} tone={metrics.minAvailabilityFactor < 0.96 ? "warn" : "good"} />
        <StatTile icon={<RadioTower size={20} />} label="切换时延" value={`${metrics.maxSwitchingDelayS.toFixed(1)} s`} tone={metrics.maxSwitchingDelayS > 12 ? "warn" : undefined} />
        <StatTile icon={<RadioTower size={20} />} label="最大多普勒" value={formatFrequencyOffset(metrics.maxDopplerShiftKhz * 1000)} tone={metrics.minDopplerTrackingMarginKhz < 0 ? "bad" : "good"} />
        <StatTile icon={<RadioTower size={20} />} label="多普勒残差" value={formatFrequencyOffset(metrics.maxDopplerResidualKhz * 1000)} tone={metrics.maxDopplerLossDb > 0.5 ? "warn" : "good"} />
        <StatTile icon={<Activity size={20} />} label="上报容量" value={`${Math.round(metrics.reportCapacityMbps).toLocaleString()} Mbps`} />
        <StatTile icon={<Activity size={20} />} label="业务队列" value={`${Math.round(metrics.queuedTrafficMb).toLocaleString()} MB`} tone={metrics.queuedTrafficMb > 500 ? "warn" : undefined} />
        <StatTile icon={<Activity size={20} />} label="转发负载" value={`${Math.round(metrics.forwardingLoadMbps).toLocaleString()} Mbps`} tone={metrics.forwardingLoadMbps > 2000 ? "warn" : undefined} />
        <StatTile icon={<RadioTower size={20} />} label="下传负载" value={`${Math.round(metrics.downlinkLoadMbps).toLocaleString()} Mbps`} tone={metrics.downlinkLoadMbps > 200 ? "good" : undefined} />
        <StatTile icon={<RadioTower size={20} />} label="端口占用" value={`${metrics.maxNodeLinkOccupancyPercent.toFixed(1)}%`} tone={metrics.maxNodeLinkOccupancyPercent > 80 ? "warn" : undefined} />
        <StatTile icon={<BatteryMedium size={20} />} label="通信功耗" value={`${metrics.maxCommunicationPowerW.toFixed(1)} W`} tone={metrics.maxCommunicationPowerW > 80 ? "warn" : undefined} />
        <StatTile icon={<Activity size={20} />} label="链路拥塞" value={`${metrics.maxLinkCongestionPercent}% / ${metrics.congestedLinks} 条`} tone={metrics.maxLinkCongestionPercent > 50 ? "bad" : metrics.maxLinkCongestionPercent > 0 ? "warn" : undefined} />
        <StatTile icon={<RadioTower size={20} />} label="最小 SINR" value={`${metrics.minSinrDb.toFixed(1)} dB / ${metrics.interferenceAffectedLinks} 条`} tone={metrics.minSinrDb < 10 ? "warn" : "good"} />
        <StatTile
          icon={<RadioTower size={20} />}
          label="频率复用"
          value={`邻频 ${metrics.adjacentInterferenceAffectedLinks} / 滤除 ${metrics.filteredChannelInterferenceLinks}`}
          tone={metrics.adjacentInterferenceAffectedLinks ? "warn" : "good"}
        />
        <StatTile
          icon={<RadioTower size={20} />}
          label="SGL 干扰"
          value={`${metrics.maxSglInterferenceToNoiseDb > -900 ? metrics.maxSglInterferenceToNoiseDb.toFixed(1) : "-"} dB / ${metrics.sglInterferenceAffectedLinks} 条 / 邻频 ${metrics.sglAdjacentInterferenceAffectedLinks}`}
          tone={metrics.sglInterferenceAffectedLinks ? "warn" : "good"}
        />
        <StatTile icon={<RadioTower size={20} />} label="遥测缓存" value={`${Math.round(metrics.telemetryBufferMb).toLocaleString()} MB`} tone={metrics.telemetryBufferMb > 1000 ? "warn" : undefined} />
        <StatTile icon={<RadioTower size={20} />} label="本片下传" value={`${Math.round(metrics.telemetryDownlinkedMb).toLocaleString()} MB`} tone={metrics.telemetryDownlinkedMb ? "good" : undefined} />
        <StatTile
          icon={<Cpu size={20} />}
          label="任务负载"
          value={`${metrics.activeTasks}/${truthSummary.uniqueTaskCount}`}
          tone={simulationMode === "operational" && metrics.activeTasks ? "warn" : undefined}
        />
        <StatTile icon={<Satellite size={20} />} label="星座模型" value={constellationProfile.shortLabel} />
        <StatTile icon={<Orbit size={20} />} label="轨道模型" value={orbitModelLabel[slice.orbitModel]} />
        <StatTile icon={<Activity size={20} />} label="路由算法" value={routingAlgorithmLabel[slice.routingAlgorithm]} />
        <StatTile icon={<Activity size={20} />} label="业务模式" value={trafficProfileLabel[trafficProfile]} />
        <StatTile icon={<RadioTower size={20} />} label="路由路径" value={`${metrics.routedRoutes}/${metrics.routeRequests}`} tone={metrics.routeRequests && metrics.routedRoutes < metrics.routeRequests ? "warn" : undefined} />
      </section>

      <TruthSummaryPanel
        datasetName={datasetName}
        datasetMessage={datasetMessage}
        metadata={exportMetadata}
        summary={truthSummary}
        config={activeConfig}
      />

      </div>
      </section>

      <section id="topology" className={`dashboard-section module-section ${collapsedPanels.topology ? "is-collapsed" : ""}`}>
        <div className="section-title-row">
          <div>
            <span className="section-kicker">Topology</span>
            <h2>拓扑视图</h2>
          </div>
          <div className="section-tools">
            <div className="section-status">
              {snapshotMode ? `快照 T${slice.index.toString().padStart(2, "0")}` : "运动模式"}
            </div>
            <button
              type="button"
              className="icon-action"
              onClick={() => togglePanel("topology")}
              title={collapsedPanels.topology ? "展开拓扑视图" : "收起拓扑视图"}
              aria-expanded={!collapsedPanels.topology}
            >
              {collapsedPanels.topology ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
        </div>

      <div className="module-body workspace">
        <div className="visual-stack">
          <OrbitalScene
            slice={slice}
            config={activeConfig}
            selection={selection}
            snapshotMode={snapshotMode}
            showOrbitPlanes={showOrbitPlanes}
            showNodes={showNodes}
            showLinks={showLinks}
            onSelect={setSelection}
          />
          <PlanarTopology
            slices={slices}
            slice={slice}
            config={activeConfig}
            snapshotMode={snapshotMode}
            selection={selection}
            onSelect={setSelection}
            onTimeSelect={handleTimeSelect}
            onResumeMotion={handleResumeMotion}
          />
        </div>
        <aside
          id="details"
          className={`anchor-panel detail-drawer ${collapsedPanels.details ? "is-collapsed" : ""}`}
        >
          <div className="detail-drawer-header">
            <div>
              <span className="section-kicker">Inspect</span>
              <h2>节点与链路</h2>
            </div>
            <button
              type="button"
              className="icon-action"
              onClick={() => togglePanel("details")}
              title={collapsedPanels.details ? "展开节点与链路" : "收起节点与链路"}
              aria-expanded={!collapsedPanels.details}
            >
              {collapsedPanels.details ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
          <div className="detail-drawer-body">
            <Inspector slice={slice} selection={selection} />
            <NodeMatrix slice={slice} onSelect={setSelection} />
          </div>
        </aside>
      </div>

      </section>

      <section id="tables" className={`dashboard-section module-section ${collapsedPanels.tables ? "is-collapsed" : ""}`}>
        <div className="section-title-row">
          <div>
            <span className="section-kicker">Data</span>
            <h2>数据表</h2>
          </div>
          <div className="section-tools">
            <div className="section-status">
              链路 · 路由 · 星地窗口
            </div>
            <button
              type="button"
              className="icon-action"
              onClick={() => togglePanel("tables")}
              title={collapsedPanels.tables ? "展开数据表" : "收起数据表"}
              aria-expanded={!collapsedPanels.tables}
            >
              {collapsedPanels.tables ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
        </div>
      <div className="module-body lower-grid">
        <LinkTable slice={slice} onSelect={setSelection} />
        <RouteTable slice={slice} />
        <GroundLinkTable slice={slice} />
      </div>
      </section>
      </>
      )}
    </main>
  );
}
