import type { NetworkSlice, SatelliteLink, SatelliteNode } from "../simulation/types";

export type IntTelemetryMode = "probe-int" | "traffic-int";
export type IntObservationScope = "forwarding-hop" | "local-adjacent-link";
export type IntReportStatus = "downlinked" | "queued" | "dropped";

export interface IntHopObservation {
  packetId: string;
  probeId: string;
  sliceIndex: number;
  time: string;
  hopIndex: number;
  nodeId: string;
  role: "source" | "transit" | "sink" | "local";
  previousHop: string;
  nextHop: string;
  ingressLinkId: string;
  egressLinkId: string;
  observationScope: IntObservationScope;
  localPortPeer: string;
  observedLinkId: string;
  observedNodeMode: string;
  observedCpuPercent: number;
  observedQueueDepth: number;
  observedQueuedTrafficMb: number;
  observedEnergyPercent: number;
  observedLinkStatus: string;
  observedLinkActive: boolean | "";
  observedLinkUtilizationPercent: number;
  observedLinkLatencyMs: number;
  observedLinkCapacityMbps: number;
  observedLinkCongestionPercent: number;
}

export interface IntProbePath {
  probeId: string;
  source: string;
  sink: string;
  path: string[];
  mode: IntTelemetryMode;
  coveredNodeCount: number;
  coveredLinkCount: number;
}

export interface IntReport {
  reportId: string;
  packetId: string;
  probeId: string;
  sliceIndex: number;
  source: string;
  sink: string;
  recordCount: number;
  reportSizeBytes: number;
  directLinkedSatellite: string;
  reportingPath: string[];
  reportingHops: number;
  reportingLatencyMs: number;
  status: IntReportStatus;
  dropReason: string;
}

export interface IntNodeObservation {
  nodeId: string;
  label: string;
  plane: number;
  slot: number;
  observed: boolean;
  mode: string;
  cpuPercent: number;
  queueDepth: number;
  energyPercent: number;
  telemetryBufferMb: number;
  sourceReports: number;
  transitReports: number;
  sinkReports: number;
}

export interface IntNodeValidation {
  nodeId: string;
  label: string;
  observed: boolean;
  truthMode: string;
  observedMode: string;
  modeMatch: boolean | "";
  truthCpuPercent: number;
  observedCpuPercent: number | "";
  cpuErrorPercent: number | "";
  truthQueueDepth: number;
  observedQueueDepth: number | "";
  queueDepthError: number | "";
  truthEnergyPercent: number;
  observedEnergyPercent: number | "";
  energyErrorPercent: number | "";
}

export interface IntLinkObservation {
  linkId: string;
  source: string;
  target: string;
  kind: string;
  observed: boolean;
  scope: IntObservationScope | "unknown";
  status: string;
  active: boolean | "";
  utilizationPercent: number;
  latencyMs: number;
  capacityMbps: number;
  congestionPercent: number;
  restrictionReason: string;
}

export interface IntTelemetrySlice {
  sliceIndex: number;
  time: string;
  minute: number;
  mode: IntTelemetryMode;
  probePaths: IntProbePath[];
  hopRecords: IntHopObservation[];
  reports: IntReport[];
  deliveredReports: IntReport[];
  queuedReports: IntReport[];
  observedNodes: IntNodeObservation[];
  observedLinks: IntLinkObservation[];
  nodeValidation: IntNodeValidation[];
  nodeCoverage: number;
  linkCoverage: number;
  activeLinkCoverage: number;
  nodeCpuMae: number;
  nodeEnergyMae: number;
  nodeQueueMae: number;
  nodeModeAccuracy: number;
  unknownNodeCount: number;
  totalNodes: number;
  totalLinks: number;
  totalActiveLinks: number;
  observedNodeCount: number;
  observedLinkCount: number;
  observedActiveLinkCount: number;
  downlinkBudgetBytes: number;
  reportBytes: number;
  telemetryComplete: boolean;
}

export interface IntTelemetryRun {
  mode: IntTelemetryMode;
  slices: IntTelemetrySlice[];
  totalReports: number;
  deliveredReports: number;
  totalHopRecords: number;
  totalReportBytes: number;
  nodeSampleCoverage: number;
  linkSampleCoverage: number;
  activeLinkSampleCoverage: number;
  nodeCpuMae: number;
  nodeEnergyMae: number;
  nodeQueueMae: number;
  nodeModeAccuracy: number;
  unknownNodeSamples: number;
  completeSlices: number;
  failedSlices: number;
}

const hopBytes = 96;
const reportHeaderBytes = 128;

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function roleForHop(path: string[], index: number) {
  if (path.length <= 1) return "local" as const;
  if (index === 0) return "source" as const;
  if (index === path.length - 1) return "sink" as const;
  return "transit" as const;
}

function sortedNodes(nodes: SatelliteNode[]) {
  return [...nodes].sort((a, b) => a.plane - b.plane || a.slot - b.slot || a.id.localeCompare(b.id));
}

function byId<T extends { id: string }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

function activeAdjacency(slice: NetworkSlice) {
  const adjacency = new Map<string, { next: string; link: SatelliteLink }[]>();
  slice.nodes.forEach((node) => adjacency.set(node.id, []));
  slice.links.forEach((link) => {
    if (!link.state.isActive) return;
    adjacency.get(link.source)?.push({ next: link.target, link });
    adjacency.get(link.target)?.push({ next: link.source, link });
  });
  return adjacency;
}

function allAdjacentLinks(slice: NetworkSlice) {
  const adjacency = new Map<string, SatelliteLink[]>();
  slice.nodes.forEach((node) => adjacency.set(node.id, []));
  slice.links.forEach((link) => {
    adjacency.get(link.source)?.push(link);
    adjacency.get(link.target)?.push(link);
  });
  return adjacency;
}

function activeGroundSatellites(slice: NetworkSlice) {
  return [...new Set(slice.groundLinks.filter((window) => window.status === "available").map((window) => window.satellite_id))];
}

function shortestPathToAnyGroundCandidate(slice: NetworkSlice, source: string) {
  const targets = new Set(activeGroundSatellites(slice));
  if (targets.size === 0) return { path: [] as string[], linkIds: [] as string[], latencyMs: 0, directLinkedSatellite: "" };
  if (targets.has(source)) return { path: [source], linkIds: [] as string[], latencyMs: 0, directLinkedSatellite: source };

  const adjacency = activeAdjacency(slice);
  const queue = [source];
  const visited = new Set([source]);
  const previous = new Map<string, { node: string; link: SatelliteLink }>();
  let target = "";

  while (queue.length > 0 && !target) {
    const current = queue.shift() ?? "";
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.next)) continue;
      visited.add(edge.next);
      previous.set(edge.next, { node: current, link: edge.link });
      if (targets.has(edge.next)) {
        target = edge.next;
        break;
      }
      queue.push(edge.next);
    }
  }

  if (!target) return { path: [] as string[], linkIds: [] as string[], latencyMs: 0, directLinkedSatellite: "" };

  const path = [target];
  const linkIds: string[] = [];
  let cursor = target;
  while (cursor !== source) {
    const step = previous.get(cursor);
    if (!step) break;
    linkIds.unshift(step.link.id);
    path.unshift(step.node);
    cursor = step.node;
  }

  const linksById = byId(slice.links);
  const latencyMs = linkIds.reduce((total, id) => total + (linksById.get(id)?.state.latencyMs ?? 0), 0);
  return { path, linkIds, latencyMs, directLinkedSatellite: target };
}

function probePathsForSlice(slice: NetworkSlice): IntProbePath[] {
  const byPlane = new Map<number, SatelliteNode[]>();
  sortedNodes(slice.nodes).forEach((node) => {
    if (!byPlane.has(node.plane)) byPlane.set(node.plane, []);
    byPlane.get(node.plane)?.push(node);
  });

  return [...byPlane.entries()]
    .sort(([a], [b]) => a - b)
    .map(([plane, nodes]) => {
      const path = nodes.sort((a, b) => a.slot - b.slot).map((node) => node.id);
      return {
        probeId: `probe-int-T${String(slice.index).padStart(2, "0")}-P${String(plane + 1).padStart(2, "0")}`,
        source: path[0] ?? "",
        sink: path[path.length - 1] ?? path[0] ?? "",
        path,
        mode: "probe-int",
        coveredNodeCount: path.length,
        coveredLinkCount: slice.links.filter((link) => path.includes(link.source) || path.includes(link.target)).length,
      };
    });
}

function trafficPathsForSlice(slice: NetworkSlice): IntProbePath[] {
  return slice.routes
    .filter((route) => route.status === "routed" && route.path.length > 0)
    .map((route, index) => ({
      probeId: `traffic-int-T${String(slice.index).padStart(2, "0")}-${route.task_id}-${index}`,
      source: route.path[0],
      sink: route.path[route.path.length - 1],
      path: route.path,
      mode: "traffic-int",
      coveredNodeCount: route.path.length,
      coveredLinkCount: route.linkIds.length,
    }));
}

function linkBetween(slice: NetworkSlice, source: string, target: string) {
  return slice.links.find((link) => (link.source === source && link.target === target) || (link.source === target && link.target === source));
}

function buildHopRecord(
  slice: NetworkSlice,
  path: IntProbePath,
  node: SatelliteNode,
  hopIndex: number,
  observedLink: SatelliteLink | undefined,
  scope: IntObservationScope,
  localPortPeer = "",
): IntHopObservation {
  const previousHop = hopIndex > 0 ? path.path[hopIndex - 1] : "";
  const nextHop = hopIndex < path.path.length - 1 ? path.path[hopIndex + 1] : "";
  const ingressLink = previousHop ? linkBetween(slice, previousHop, node.id)?.id ?? "" : "";
  const egressLink = nextHop ? linkBetween(slice, node.id, nextHop)?.id ?? "" : "";
  const packetId = `PKT-${path.probeId}`;

  return {
    packetId,
    probeId: path.probeId,
    sliceIndex: slice.index,
    time: slice.time,
    hopIndex,
    nodeId: node.id,
    role: roleForHop(path.path, hopIndex),
    previousHop,
    nextHop,
    ingressLinkId: ingressLink,
    egressLinkId: egressLink,
    observationScope: scope,
    localPortPeer,
    observedLinkId: observedLink?.id ?? "",
    observedNodeMode: node.state.mode,
    observedCpuPercent: node.resources.cpu_utilization,
    observedQueueDepth: node.state.queueDepth,
    observedQueuedTrafficMb: node.resources.queued_traffic_mb,
    observedEnergyPercent: node.resources.energy,
    observedLinkStatus: observedLink?.state.status ?? "",
    observedLinkActive: observedLink ? observedLink.state.isActive : "",
    observedLinkUtilizationPercent: observedLink?.state.utilizationPercent ?? 0,
    observedLinkLatencyMs: observedLink?.state.latencyMs ?? 0,
    observedLinkCapacityMbps: observedLink?.state.linkBudget?.effective_capacity_mbps ?? observedLink?.state.bandwidthMbps ?? 0,
    observedLinkCongestionPercent: observedLink?.state.congestionPercent ?? 0,
  };
}

function reportBudgetBytes(slice: NetworkSlice) {
  const capacityMbps = slice.groundLinks
    .filter((window) => window.status === "available")
    .reduce((total, window) => total + window.reportCapacityMbps, 0);
  const inferredStepSeconds = 300;
  return Math.floor((capacityMbps * 1_000_000 * inferredStepSeconds) / 8);
}

function buildSliceTelemetry(slice: NetworkSlice, mode: IntTelemetryMode): IntTelemetrySlice {
  const nodes = byId(slice.nodes);
  const links = byId(slice.links);
  const adjacentLinks = allAdjacentLinks(slice);
  const paths = mode === "probe-int" ? probePathsForSlice(slice) : trafficPathsForSlice(slice);
  const hopRecords: IntHopObservation[] = [];
  const reports: IntReport[] = [];
  const scannedNodes = new Set<string>();

  paths.forEach((path) => {
    const pathHopRecords: IntHopObservation[] = [];

    path.path.forEach((nodeId, hopIndex) => {
      const node = nodes.get(nodeId);
      if (!node) return;
      const nextHop = hopIndex < path.path.length - 1 ? path.path[hopIndex + 1] : "";
      const forwardingLink = nextHop ? linkBetween(slice, nodeId, nextHop) : undefined;
      const forwardingRecord = buildHopRecord(slice, path, node, hopIndex, forwardingLink, "forwarding-hop");
      hopRecords.push(forwardingRecord);
      pathHopRecords.push(forwardingRecord);

      if (mode === "probe-int" && !scannedNodes.has(nodeId)) {
        scannedNodes.add(nodeId);
        (adjacentLinks.get(nodeId) ?? []).forEach((link) => {
          const peer = link.source === nodeId ? link.target : link.source;
          const localRecord = buildHopRecord(slice, path, node, hopIndex, link, "local-adjacent-link", peer);
          hopRecords.push(localRecord);
          pathHopRecords.push(localRecord);
        });
      }
    });

    const reporting = shortestPathToAnyGroundCandidate(slice, path.sink);
    const reportSizeBytes = reportHeaderBytes + pathHopRecords.length * hopBytes;
    reports.push({
      reportId: `REPORT-${path.probeId}`,
      packetId: `PKT-${path.probeId}`,
      probeId: path.probeId,
      sliceIndex: slice.index,
      source: path.source,
      sink: path.sink,
      recordCount: pathHopRecords.length,
      reportSizeBytes,
      directLinkedSatellite: reporting.directLinkedSatellite,
      reportingPath: reporting.path,
      reportingHops: Math.max(reporting.path.length - 1, 0),
      reportingLatencyMs: round(reporting.latencyMs, 2),
      status: reporting.path.length > 0 ? "downlinked" : "queued",
      dropReason: reporting.path.length > 0 ? "" : "no-reporting-path",
    });
  });

  let remainingBudgetBytes = reportBudgetBytes(slice);
  const deliveredReports: IntReport[] = [];
  const queuedReports: IntReport[] = [];
  reports.forEach((report) => {
    if (report.status !== "downlinked" || report.reportSizeBytes > remainingBudgetBytes) {
      queuedReports.push({ ...report, status: "queued", dropReason: report.dropReason || "downlink-budget-exhausted" });
      return;
    }
    remainingBudgetBytes -= report.reportSizeBytes;
    deliveredReports.push(report);
  });

  const deliveredPacketIds = new Set(deliveredReports.map((report) => report.packetId));
  const deliveredHopRecords = hopRecords.filter((record) => deliveredPacketIds.has(record.packetId));
  const nodeRecords = new Map<string, IntHopObservation>();
  const roleCounts = new Map<string, { source: number; transit: number; sink: number }>();
  deliveredHopRecords.forEach((record) => {
    nodeRecords.set(record.nodeId, record);
    if (!roleCounts.has(record.nodeId)) roleCounts.set(record.nodeId, { source: 0, transit: 0, sink: 0 });
    const counts = roleCounts.get(record.nodeId);
    if (!counts) return;
    if (record.role === "source") counts.source += 1;
    if (record.role === "transit") counts.transit += 1;
    if (record.role === "sink") counts.sink += 1;
  });

  const linkRecords = new Map<string, IntHopObservation>();
  deliveredHopRecords
    .filter((record) => record.observedLinkId)
    .forEach((record) => linkRecords.set(record.observedLinkId, record));

  const observedNodes: IntNodeObservation[] = sortedNodes(slice.nodes).map((node) => {
    const record = nodeRecords.get(node.id);
    const counts = roleCounts.get(node.id) ?? { source: 0, transit: 0, sink: 0 };
    return {
      nodeId: node.id,
      label: node.label,
      plane: node.plane,
      slot: node.slot,
      observed: Boolean(record),
      mode: record?.observedNodeMode ?? "unknown",
      cpuPercent: record?.observedCpuPercent ?? 0,
      queueDepth: record?.observedQueueDepth ?? 0,
      energyPercent: record?.observedEnergyPercent ?? 0,
      telemetryBufferMb: node.resources.telemetry_buffer_mb,
      sourceReports: counts.source,
      transitReports: counts.transit,
      sinkReports: counts.sink,
    };
  });

  const nodeValidation: IntNodeValidation[] = sortedNodes(slice.nodes).map((node) => {
    const record = nodeRecords.get(node.id);
    const observed = Boolean(record);
    return {
      nodeId: node.id,
      label: node.label,
      observed,
      truthMode: node.state.mode,
      observedMode: record?.observedNodeMode ?? "unknown",
      modeMatch: observed ? record?.observedNodeMode === node.state.mode : "",
      truthCpuPercent: node.resources.cpu_utilization,
      observedCpuPercent: observed ? record?.observedCpuPercent ?? 0 : "",
      cpuErrorPercent: observed ? Math.abs((record?.observedCpuPercent ?? 0) - node.resources.cpu_utilization) : "",
      truthQueueDepth: node.state.queueDepth,
      observedQueueDepth: observed ? record?.observedQueueDepth ?? 0 : "",
      queueDepthError: observed ? Math.abs((record?.observedQueueDepth ?? 0) - node.state.queueDepth) : "",
      truthEnergyPercent: node.resources.energy,
      observedEnergyPercent: observed ? record?.observedEnergyPercent ?? 0 : "",
      energyErrorPercent: observed ? Math.abs((record?.observedEnergyPercent ?? 0) - node.resources.energy) : "",
    };
  });

  const observedLinks: IntLinkObservation[] = [...slice.links]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .map((link) => {
      const record = linkRecords.get(link.id);
      return {
        linkId: link.id,
        source: link.source,
        target: link.target,
        kind: link.kind,
        observed: Boolean(record),
        scope: record?.observationScope ?? "unknown",
        status: record?.observedLinkStatus ?? "unknown",
        active: record?.observedLinkActive ?? "",
        utilizationPercent: record?.observedLinkUtilizationPercent ?? 0,
        latencyMs: record?.observedLinkLatencyMs ?? 0,
        capacityMbps: record?.observedLinkCapacityMbps ?? 0,
        congestionPercent: record?.observedLinkCongestionPercent ?? 0,
        restrictionReason: link.state.restrictionReason ?? "",
      };
    });

  const totalActiveLinks = slice.links.filter((link) => link.state.isActive).length;
  const observedNodeCount = observedNodes.filter((node) => node.observed).length;
  const observedValidation = nodeValidation.filter((entry) => entry.observed);
  const observedLinkCount = observedLinks.filter((link) => link.observed).length;
  const observedActiveLinkCount = observedLinks.filter((link) => link.observed && links.get(link.linkId)?.state.isActive).length;
  const reportBytes = reports.reduce((total, report) => total + report.reportSizeBytes, 0);

  return {
    sliceIndex: slice.index,
    time: slice.time,
    minute: slice.minute,
    mode,
    probePaths: paths,
    hopRecords: deliveredHopRecords,
    reports,
    deliveredReports,
    queuedReports,
    observedNodes,
    observedLinks,
    nodeValidation,
    nodeCoverage: round(observedNodeCount / Math.max(slice.nodes.length, 1)),
    linkCoverage: round(observedLinkCount / Math.max(slice.links.length, 1)),
    activeLinkCoverage: round(observedActiveLinkCount / Math.max(totalActiveLinks, 1)),
    nodeCpuMae: round(
      observedValidation.reduce((total, entry) => total + Number(entry.cpuErrorPercent || 0), 0) /
        Math.max(observedValidation.length, 1),
    ),
    nodeEnergyMae: round(
      observedValidation.reduce((total, entry) => total + Number(entry.energyErrorPercent || 0), 0) /
        Math.max(observedValidation.length, 1),
    ),
    nodeQueueMae: round(
      observedValidation.reduce((total, entry) => total + Number(entry.queueDepthError || 0), 0) /
        Math.max(observedValidation.length, 1),
    ),
    nodeModeAccuracy: round(
      observedValidation.filter((entry) => entry.modeMatch === true).length / Math.max(observedValidation.length, 1),
    ),
    unknownNodeCount: slice.nodes.length - observedNodeCount,
    totalNodes: slice.nodes.length,
    totalLinks: slice.links.length,
    totalActiveLinks,
    observedNodeCount,
    observedLinkCount,
    observedActiveLinkCount,
    downlinkBudgetBytes: reportBudgetBytes(slice),
    reportBytes,
    telemetryComplete: observedNodeCount === slice.nodes.length && observedLinkCount === slice.links.length,
  };
}

export function buildIntTelemetryRun(slices: NetworkSlice[], mode: IntTelemetryMode): IntTelemetryRun {
  const telemetrySlices = slices.map((slice) => buildSliceTelemetry(slice, mode));
  const totalReports = telemetrySlices.reduce((total, slice) => total + slice.reports.length, 0);
  const deliveredReports = telemetrySlices.reduce((total, slice) => total + slice.deliveredReports.length, 0);
  const totalHopRecords = telemetrySlices.reduce((total, slice) => total + slice.hopRecords.length, 0);
  const totalReportBytes = telemetrySlices.reduce((total, slice) => total + slice.reportBytes, 0);
  const totalNodeSamples = telemetrySlices.reduce((total, slice) => total + slice.totalNodes, 0);
  const observedNodeSamples = telemetrySlices.reduce((total, slice) => total + slice.observedNodeCount, 0);
  const totalLinkSamples = telemetrySlices.reduce((total, slice) => total + slice.totalLinks, 0);
  const observedLinkSamples = telemetrySlices.reduce((total, slice) => total + slice.observedLinkCount, 0);
  const totalActiveLinkSamples = telemetrySlices.reduce((total, slice) => total + slice.totalActiveLinks, 0);
  const observedActiveLinkSamples = telemetrySlices.reduce((total, slice) => total + slice.observedActiveLinkCount, 0);
  const validationRows = telemetrySlices.flatMap((slice) => slice.nodeValidation).filter((entry) => entry.observed);
  const completeSlices = telemetrySlices.filter((slice) => slice.telemetryComplete).length;

  return {
    mode,
    slices: telemetrySlices,
    totalReports,
    deliveredReports,
    totalHopRecords,
    totalReportBytes,
    nodeSampleCoverage: round(observedNodeSamples / Math.max(totalNodeSamples, 1)),
    linkSampleCoverage: round(observedLinkSamples / Math.max(totalLinkSamples, 1)),
    activeLinkSampleCoverage: round(observedActiveLinkSamples / Math.max(totalActiveLinkSamples, 1)),
    nodeCpuMae: round(
      validationRows.reduce((total, entry) => total + Number(entry.cpuErrorPercent || 0), 0) /
        Math.max(validationRows.length, 1),
    ),
    nodeEnergyMae: round(
      validationRows.reduce((total, entry) => total + Number(entry.energyErrorPercent || 0), 0) /
        Math.max(validationRows.length, 1),
    ),
    nodeQueueMae: round(
      validationRows.reduce((total, entry) => total + Number(entry.queueDepthError || 0), 0) /
        Math.max(validationRows.length, 1),
    ),
    nodeModeAccuracy: round(
      validationRows.filter((entry) => entry.modeMatch === true).length / Math.max(validationRows.length, 1),
    ),
    unknownNodeSamples: totalNodeSamples - observedNodeSamples,
    completeSlices,
    failedSlices: telemetrySlices.length - completeSlices,
  };
}
