import type {
  NetworkSlice,
  OrbitModel,
  RealTleCatalogSnapshot,
  RoutingAlgorithm,
  SimulationMode,
  TaskTrafficRecord,
  TrafficProfile,
} from "./types";

export interface ExperimentExportContext {
  simulationMode: SimulationMode;
  trafficProfile: TrafficProfile;
  orbitModel: OrbitModel;
  routingAlgorithm: RoutingAlgorithm;
  datasetName: string;
  configSnapshot?: unknown;
  taskRecords?: unknown[];
  validationSummary?: unknown;
  tleCatalogSnapshot?: RealTleCatalogSnapshot;
}

type Scalar = string | number | boolean | null | undefined;
type ExportRow = Record<string, Scalar>;

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const csvEscape = (value: Scalar) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const maxOf = (values: number[]) => (values.length > 0 ? Math.max(...values) : 0);
const minOf = (values: number[]) => (values.length > 0 ? Math.min(...values) : 0);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function estimateQueueLatencyMs(queuedTrafficMb: number, capacityMbps: number) {
  if (!Number.isFinite(queuedTrafficMb) || !Number.isFinite(capacityMbps) || queuedTrafficMb <= 0 || capacityMbps <= 0) return 0;
  return (queuedTrafficMb * 8 * 1000) / capacityMbps;
}

function taskActiveInSlice(task: TaskTrafficRecord, sliceIndex: number) {
  const duration = Math.max(1, task.duration_slices || 1);
  return sliceIndex >= task.start_slice && sliceIndex < task.start_slice + duration;
}

function routeRole(route: NetworkSlice["routes"][number], nodeId: string, task?: TaskTrafficRecord) {
  if (task?.node_id && !task.source && !task.target) return "local";
  if (nodeId === route.source) return "source";
  if (nodeId === route.target) return "target";
  return "transit";
}

function routeLinkSummary(route: NetworkSlice["routes"][number], linksById: Map<string, NetworkSlice["links"][number]>) {
  const links = route.linkIds.map((linkId) => linksById.get(linkId)).filter(Boolean) as NetworkSlice["links"];
  const bottleneck = links.reduce<NetworkSlice["links"][number] | undefined>((best, link) => {
    if (!best) return link;
    if (link.state.utilizationPercent > best.state.utilizationPercent) return link;
    if (link.state.utilizationPercent === best.state.utilizationPercent && link.state.bandwidthMbps < best.state.bandwidthMbps) {
      return link;
    }
    return best;
  }, undefined);

  return {
    links,
    bottleneck,
    maxDemandMbps: maxOf(links.map((link) => link.state.demandTrafficMbps)),
    maxCarriedMbps: maxOf(links.map((link) => link.state.carriedTrafficMbps)),
    maxUtilizationPercent: maxOf(links.map((link) => link.state.utilizationPercent)),
    maxCongestionPercent: maxOf(links.map((link) => link.state.congestionPercent)),
    maxQueuedMb: maxOf(links.map((link) => link.state.queuedTrafficMb)),
    maxDroppedMb: maxOf(links.map((link) => link.state.droppedTrafficMb)),
  };
}

function taskDeliveryState(route: NetworkSlice["routes"][number], task?: TaskTrafficRecord) {
  if (route.status === "unroutable") return "unroutable";
  if (route.status === "not-requested") return task?.node_id ? "local-compute" : "not-requested";
  if (route.status === "local") return "local";
  if (route.droppedTrafficMb > 0 && route.carriedTrafficMbps <= 0) return "dropped";
  if (route.droppedTrafficMb > 0) return "partial-with-drop";
  if (route.queuedTrafficMb > 0 && route.carriedTrafficMbps < route.trafficMbps) return "partial-queued";
  if (route.queuedTrafficMb > 0) return "queued";
  if (route.carriedTrafficMbps > 0 || route.trafficMbps <= 0) return "delivered";
  return "blocked";
}

function taskLatencyMetrics(route: NetworkSlice["routes"][number] | undefined, task?: TaskTrafficRecord) {
  if (!route) {
    return {
      routeLatencyMs: 0,
      queueDelayMs: 0,
      queueBacklogDelayMs: 0,
      latencyCapped: false,
      timeoutMs: 0,
      estimatedEndToEndLatencyMs: 0,
      deliveryRatio: 0,
      deliveryState: "missing",
      delivered: false,
      dropped: false,
    };
  }

  const trafficMbps = Math.max(route.trafficMbps, task?.traffic_mbps ?? 0, 0);
  const carriedMbps = Math.max(route.carriedTrafficMbps, 0);
  const serviceMbps = Math.max(carriedMbps, trafficMbps, 1);
  const deliveryRatio =
    trafficMbps > 0
      ? clamp(carriedMbps / trafficMbps, 0, 1)
      : route.status === "unroutable"
        ? 0
        : 1;
  const deliveryState = taskDeliveryState(route, task);
  const fallbackQueueBacklogDelayMs =
    route.status === "routed" && route.queuedTrafficMb > 0
      ? (Math.max(route.queuedTrafficMb, 0) * 8 * 1000) / serviceMbps
      : 0;
  const timeoutMs = route.timeoutMs || 30000;
  const queueBacklogDelayMs = route.queueBacklogDelayMs ?? fallbackQueueBacklogDelayMs;
  const queueDelayMs = Math.min(route.queueDelayMs ?? queueBacklogDelayMs, timeoutMs);
  const latencyCapped =
    Boolean(route.latencyCapped) ||
    queueBacklogDelayMs > queueDelayMs ||
    deliveryState === "dropped" ||
    deliveryState === "partial-with-drop" ||
    deliveryState === "partial-queued";

  return {
    routeLatencyMs: route.latencyMs,
    queueDelayMs: round(queueDelayMs, 4),
    queueBacklogDelayMs: round(queueBacklogDelayMs, 4),
    latencyCapped,
    timeoutMs,
    estimatedEndToEndLatencyMs: round(route.latencyMs + queueDelayMs, 4),
    deliveryRatio: round(deliveryRatio, 4),
    deliveryState,
    delivered: deliveryState === "delivered" || deliveryState === "local" || deliveryState === "local-compute",
    dropped: route.droppedTrafficMb > 0 || deliveryState === "dropped",
  };
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '"__non_finite_number__"';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function fnv1a32(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableFingerprint(value: unknown) {
  return fnv1a32(stableStringify(value));
}

function canonicalTaskRecord(task: unknown) {
  const record = task && typeof task === "object" ? (task as Record<string, unknown>) : {};
  const numberValue = (key: string, fallback = 0) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const textValue = (key: string) => {
    const value = record[key];
    return typeof value === "string" ? value : "";
  };

  return {
    task_id: textValue("task_id"),
    start_slice: numberValue("start_slice"),
    duration_slices: numberValue("duration_slices", 1),
    source: textValue("source"),
    target: textValue("target"),
    node_id: textValue("node_id"),
    compute_units: numberValue("compute_units"),
    gpu_units: numberValue("gpu_units"),
    memory_gb: numberValue("memory_gb"),
    storage_gb: numberValue("storage_gb"),
    traffic_mbps: numberValue("traffic_mbps"),
    priority: numberValue("priority"),
    task_type: textValue("task_type"),
  };
}

export function taskDatasetFingerprint(trafficProfile: TrafficProfile, taskRecords: unknown[] | undefined) {
  return stableFingerprint({
    trafficProfile,
    taskRecords: (taskRecords ?? []).map(canonicalTaskRecord),
  });
}

function taskDatasetSummary(taskRecords: unknown[] | undefined) {
  const tasks = taskRecords ?? [];
  const numeric = (task: unknown, key: string) => {
    if (!task || typeof task !== "object") return 0;
    const value = (task as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const text = (task: unknown, key: string) => {
    if (!task || typeof task !== "object") return "";
    const value = (task as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };

  return {
    task_count: tasks.length,
    routed_task_count: tasks.filter((task) => text(task, "source") && text(task, "target")).length,
    local_task_count: tasks.filter((task) => text(task, "node_id")).length,
    total_traffic_mbps: round(tasks.reduce<number>((total, task) => total + numeric(task, "traffic_mbps"), 0), 3),
    total_compute_units: round(tasks.reduce<number>((total, task) => total + numeric(task, "compute_units"), 0), 3),
    total_memory_gb: round(tasks.reduce<number>((total, task) => total + numeric(task, "memory_gb"), 0), 3),
    total_storage_gb: round(tasks.reduce<number>((total, task) => total + numeric(task, "storage_gb"), 0), 3),
  };
}

export function rowsToCsv(rows: ExportRow[]) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

export function truthFingerprintForSlices(slices: NetworkSlice[]) {
  return stableFingerprint({
    metrics: networkMetricRows(slices),
    nodes: nodeSnapshotRows(slices),
    links: linkSnapshotRows(slices),
    routes: routeSnapshotRows(slices),
  });
}

export function experimentMetadata(context: ExperimentExportContext, slices: NetworkSlice[]) {
  const datasetSummary = taskDatasetSummary(context.taskRecords);
  return {
    export_schema_version: "stage1-truth-v1",
    exported_at: new Date().toISOString(),
    simulation_mode: context.simulationMode,
    traffic_profile: context.trafficProfile,
    orbit_model: context.orbitModel,
    routing_algorithm: context.routingAlgorithm,
    dataset_name: context.datasetName,
    dataset_fingerprint: taskDatasetFingerprint(context.trafficProfile, context.taskRecords),
    config_fingerprint: context.configSnapshot ? stableFingerprint(context.configSnapshot) : "",
    truth_fingerprint: truthFingerprintForSlices(slices),
    dataset_task_count: datasetSummary.task_count,
    dataset_routed_task_count: datasetSummary.routed_task_count,
    dataset_local_task_count: datasetSummary.local_task_count,
    dataset_total_traffic_mbps: datasetSummary.total_traffic_mbps,
    dataset_total_compute_units: datasetSummary.total_compute_units,
    dataset_total_memory_gb: datasetSummary.total_memory_gb,
    dataset_total_storage_gb: datasetSummary.total_storage_gb,
    validation_summary: context.validationSummary ?? null,
    tle_snapshot_schema: context.tleCatalogSnapshot?.schema ?? "",
    tle_snapshot_source: context.tleCatalogSnapshot?.source ?? "",
    tle_snapshot_group: context.tleCatalogSnapshot?.group ?? "",
    tle_snapshot_fingerprint: context.tleCatalogSnapshot?.fingerprint ?? "",
    tle_snapshot_selected_count: context.tleCatalogSnapshot?.selected_count ?? "",
    tle_snapshot_catalog_count: context.tleCatalogSnapshot?.catalog_count ?? "",
    tle_snapshot_planes: context.tleCatalogSnapshot?.layout.planes ?? "",
    tle_snapshot_satellites_per_plane: context.tleCatalogSnapshot?.layout.satellites_per_plane ?? "",
    tle_snapshot_mean_altitude_km: context.tleCatalogSnapshot?.mean_altitude_km ?? "",
    tle_snapshot_mean_inclination_deg: context.tleCatalogSnapshot?.mean_inclination_deg ?? "",
    slice_count: slices.length,
    node_count: slices[0]?.nodes.length ?? 0,
    link_count: slices[0]?.links.length ?? 0,
  };
}

export function networkMetricRows(slices: NetworkSlice[]): ExportRow[] {
  return slices.map((slice) => {
    const activeLinks = slice.links.filter((link) => link.state.isActive).length;
    const warningNodes = slice.nodes.filter((node) => node.state.mode === "warning").length;
    const degradedNodes = slice.nodes.filter((node) => node.state.mode === "degraded").length;
    const routedTasks = slice.routes.filter((route) => route.status === "routed").length;
    const unroutableTasks = slice.routes.filter((route) => route.status === "unroutable").length;
    const totalCpu = slice.nodes.reduce((total, node) => total + node.resources.cpu_utilization, 0);
    const totalEnergyWh = slice.nodes.reduce((total, node) => total + node.resources.energy_wh, 0);
    const totalQueueMb = slice.nodes.reduce((total, node) => total + node.resources.queued_traffic_mb, 0);
    const totalDropMb = slice.nodes.reduce((total, node) => total + node.resources.dropped_traffic_mb, 0);
    const totalForwardingMbps = slice.nodes.reduce((total, node) => total + node.resources.forwarding_load_mbps, 0);
    const totalDownlinkMbps = slice.nodes.reduce((total, node) => total + node.resources.downlink_load_mbps, 0);
    const totalTelemetryBufferMb = slice.nodes.reduce((total, node) => total + node.resources.telemetry_buffer_mb, 0);
    const totalTelemetryDownlinkedMb = slice.nodes.reduce(
      (total, node) => total + node.resources.telemetry_downlinked_mb,
      0,
    );
    const maxLinkCongestionPercent = slice.links.reduce(
      (max, link) => Math.max(max, link.state.congestionPercent),
      0,
    );
    const maxCommunicationPowerW = slice.nodes.reduce(
      (max, node) => Math.max(max, node.resources.communication_power_w),
      0,
    );

    return {
      slice_index: slice.index,
      time: slice.time,
      minute: slice.minute,
      orbit_model: slice.orbitModel,
      routing_algorithm: slice.routingAlgorithm,
      nodes: slice.nodes.length,
      links: slice.links.length,
      active_links: activeLinks,
      link_availability_percent: round((activeLinks / Math.max(slice.links.length, 1)) * 100, 2),
      warning_nodes: warningNodes,
      degraded_nodes: degradedNodes,
      active_tasks: slice.routes.length,
      routed_tasks: routedTasks,
      unroutable_tasks: unroutableTasks,
      avg_cpu_percent: round(totalCpu / Math.max(slice.nodes.length, 1), 2),
      avg_energy_wh: round(totalEnergyWh / Math.max(slice.nodes.length, 1), 2),
      total_queue_mb: round(totalQueueMb, 2),
      total_drop_mb: round(totalDropMb, 2),
      total_forwarding_mbps: round(totalForwardingMbps, 2),
      total_downlink_mbps: round(totalDownlinkMbps, 2),
      total_telemetry_buffer_mb: round(totalTelemetryBufferMb, 2),
      total_telemetry_downlinked_mb: round(totalTelemetryDownlinkedMb, 2),
      max_link_congestion_percent: round(maxLinkCongestionPercent, 2),
      max_communication_power_w: round(maxCommunicationPowerW, 2),
      available_ground_windows: slice.groundLinks.filter((window) => window.status === "available").length,
    };
  });
}

export function nodeSnapshotRows(slices: NetworkSlice[]): ExportRow[] {
  return slices.flatMap((slice) =>
    slice.nodes.map((node) => ({
      slice_index: slice.index,
      time: slice.time,
      minute: slice.minute,
      node_id: node.id,
      label: node.label,
      plane: node.plane,
      slot: node.slot,
      mode: node.state.mode,
      latitude_deg: round(node.timeState.latitudeDeg, 6),
      longitude_deg: round(node.timeState.longitudeDeg, 6),
      altitude_km: round(node.timeState.altitudeKm, 3),
      x_eci_km: round(node.timeState.eci.x, 3),
      y_eci_km: round(node.timeState.eci.y, 3),
      z_eci_km: round(node.timeState.eci.z, 3),
      vx_km_s: round(node.timeState.velocityEci.vx, 6),
      vy_km_s: round(node.timeState.velocityEci.vy, 6),
      vz_km_s: round(node.timeState.velocityEci.vz, 6),
      in_sunlight: node.timeState.inSunlight,
      solar_exposure: round(node.timeState.solarExposure, 4),
      cpu_percent: node.resources.cpu_utilization,
      gpu_percent: node.resources.gpu_utilization ?? "",
      memory_percent: node.resources.memory_utilization,
      storage_percent: node.resources.storage_utilization,
      memory_used_gb: node.resources.memory_used_gb,
      storage_used_gb: node.resources.storage_used_gb,
      temperature_c: node.state.temperatureC,
      queue_depth: node.state.queueDepth,
      energy_percent: node.resources.energy,
      energy_wh: node.resources.energy_wh,
      state_of_charge: node.resources.state_of_charge,
      solar_power_w: node.resources.solar_power_w,
      load_power_w: node.resources.load_power_w,
      net_power_w: node.resources.net_power_w,
      power_saving_mode: node.resources.power_saving_mode,
      can_accept_tasks: node.resources.can_accept_tasks,
      compute_cpu_percent: node.resources.compute_cpu_percent,
      task_traffic_cpu_percent: node.resources.task_traffic_cpu_percent,
      forwarding_cpu_percent: node.resources.forwarding_cpu_percent,
      queue_cpu_percent: node.resources.queue_cpu_percent,
      base_power_w: node.resources.base_power_w,
      payload_power_w: node.resources.payload_power_w,
      task_compute_power_w: node.resources.task_compute_power_w,
      network_compute_power_w: node.resources.network_compute_power_w,
      assigned_task_count: node.resources.assigned_task_count,
      workload_cpu_percent: node.resources.workload_cpu_percent,
      workload_gpu_percent: node.resources.workload_gpu_percent,
      workload_memory_gb: node.resources.workload_memory_gb,
      workload_storage_gb: node.resources.workload_storage_gb,
      ingress_traffic_mbps: node.resources.ingress_traffic_mbps,
      egress_traffic_mbps: node.resources.egress_traffic_mbps,
      transit_traffic_mbps: node.resources.transit_traffic_mbps,
      forwarding_load_mbps: node.resources.forwarding_load_mbps,
      downlink_load_mbps: node.resources.downlink_load_mbps,
      active_isl_links: node.resources.active_isl_links,
      active_sgl_links: node.resources.active_sgl_links,
      link_occupancy_percent: node.resources.link_occupancy_percent,
      communication_power_w: node.resources.communication_power_w,
      queued_traffic_mb: node.resources.queued_traffic_mb,
      dropped_traffic_mb: node.resources.dropped_traffic_mb,
      cache_used_mb: node.resources.cache_used_mb,
      telemetry_generated_mb: node.resources.telemetry_generated_mb,
      telemetry_buffer_mb: node.resources.telemetry_buffer_mb,
      telemetry_downlinked_mb: node.resources.telemetry_downlinked_mb,
      telemetry_dropped_mb: node.resources.telemetry_dropped_mb,
    })),
  );
}

export function linkSnapshotRows(slices: NetworkSlice[]): ExportRow[] {
  return slices.flatMap((slice) =>
    slice.links.map((link) => ({
      slice_index: slice.index,
      time: slice.time,
      minute: slice.minute,
      link_id: link.id,
      source: link.source,
      target: link.target,
      kind: link.kind,
      inter_plane_direction: link.interPlaneDirection,
      design_candidate: link.designCandidate,
      source_antenna_id: link.sourceAntennaId,
      target_antenna_id: link.targetAntennaId,
      status: link.state.status,
      is_active: link.state.isActive,
      restriction_reason: link.state.restrictionReason ?? "",
      line_of_sight: link.state.lineOfSight,
      distance_km: round(link.state.distanceKm, 3),
      latency_ms: round(link.state.latencyMs, 4),
      queue_latency_ms: round(
        estimateQueueLatencyMs(
          link.state.queuedTrafficMb,
          link.state.linkBudget?.effective_capacity_mbps ?? link.state.bandwidthMbps,
        ),
        4,
      ),
      bandwidth_mbps: round(link.state.bandwidthMbps, 3),
      utilization_percent: round(link.state.utilizationPercent, 3),
      demand_traffic_mbps: round(link.state.demandTrafficMbps, 3),
      carried_traffic_mbps: round(link.state.carriedTrafficMbps, 3),
      queued_traffic_mb: round(link.state.queuedTrafficMb, 3),
      dropped_traffic_mb: round(link.state.droppedTrafficMb, 3),
      congestion_percent: round(link.state.congestionPercent, 3),
      snr_db: link.state.linkBudget ? round(link.state.linkBudget.snr_db, 3) : "",
      sinr_db: link.state.linkBudget ? round(link.state.linkBudget.sinr_db, 3) : "",
      capacity_mbps: link.state.linkBudget ? round(link.state.linkBudget.capacity_mbps, 3) : "",
      effective_capacity_mbps: link.state.linkBudget ? round(link.state.linkBudget.effective_capacity_mbps, 3) : "",
      fspl_db: link.state.linkBudget ? round(link.state.linkBudget.free_space_path_loss_db, 3) : "",
      received_power_dbm: link.state.linkBudget ? round(link.state.linkBudget.received_power_dbm, 3) : "",
      noise_power_dbm: link.state.linkBudget ? round(link.state.linkBudget.noise_power_dbm, 3) : "",
      interference_power_dbm: link.state.linkBudget ? round(link.state.linkBudget.interference_power_dbm, 3) : "",
      interference_count: link.state.linkBudget?.interference_count ?? "",
      channel_id: link.state.linkBudget?.channel_id ?? "",
      mcs_id: link.state.linkBudget?.mcs_id ?? "",
      packet_error_rate: link.state.linkBudget ? link.state.linkBudget.packet_error_rate : "",
      doppler_shift_hz: link.state.linkBudget ? round(link.state.linkBudget.doppler_shift_hz, 3) : "",
      availability_factor: link.state.linkBudget ? round(link.state.linkBudget.availability_factor, 5) : "",
      solar_interference_blocked: link.state.linkBudget?.solar_interference_blocked ?? "",
    })),
  );
}

export function routeSnapshotRows(slices: NetworkSlice[]): ExportRow[] {
  return slices.flatMap((slice) =>
    slice.routes.map((route) => {
      const latency = taskLatencyMetrics(route);
      return {
        slice_index: slice.index,
        time: slice.time,
        minute: slice.minute,
        task_id: route.task_id,
        source: route.source,
        target: route.target,
        algorithm: route.algorithm,
        status: route.status,
        task_type: route.taskType ?? "",
        hop_count: route.hopCount,
        distance_km: round(route.distanceKm, 3),
        latency_ms: round(route.latencyMs, 4),
        route_latency_ms: round(latency.routeLatencyMs, 4),
        queue_delay_ms: latency.queueDelayMs,
        queue_backlog_delay_ms: latency.queueBacklogDelayMs,
        timeout_ms: latency.timeoutMs,
        latency_capped: latency.latencyCapped,
        estimated_end_to_end_latency_ms: latency.estimatedEndToEndLatencyMs,
        delivery_ratio: latency.deliveryRatio,
        delivery_state: latency.deliveryState,
        delivered: latency.delivered,
        dropped: latency.dropped,
        traffic_mbps: round(route.trafficMbps, 3),
        priority: route.priority,
        carried_traffic_mbps: round(route.carriedTrafficMbps, 3),
        queued_traffic_mb: round(route.queuedTrafficMb, 3),
        dropped_traffic_mb: round(route.droppedTrafficMb, 3),
        task_telemetry_node_id: route.taskTelemetryNodeId ?? "",
        task_telemetry_generated_mb: round(route.taskTelemetryGeneratedMb, 3),
        path: route.path.join(" > "),
        link_ids: route.linkIds.join(" > "),
        reason: route.reason ?? "",
      };
    }),
  );
}

export function taskTraceRows(slices: NetworkSlice[], tasks: TaskTrafficRecord[]): ExportRow[] {
  return slices.flatMap((slice) => {
    const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
    const linksById = new Map(slice.links.map((link) => [link.id, link]));
    const routesByTask = new Map(slice.routes.map((route) => [route.task_id, route]));
    const constrainedLinks = slice.links.filter((link) => !link.state.isActive && link.state.restrictionReason);

    return tasks.filter((task) => taskActiveInSlice(task, slice.index)).map((task) => {
      const route = routesByTask.get(task.task_id);
      const linkSummary = route
        ? routeLinkSummary(route, linksById)
        : {
            bottleneck: undefined,
            maxDemandMbps: 0,
            maxCarriedMbps: 0,
            maxUtilizationPercent: 0,
            maxCongestionPercent: 0,
            maxQueuedMb: 0,
            maxDroppedMb: 0,
          };
      const impactedNodeIds =
        route && route.path.length > 0
          ? route.path
          : task.node_id
            ? [task.node_id]
            : task.source
              ? [task.source]
              : [];
      const impactedNodes = impactedNodeIds.map((nodeId) => nodesById.get(nodeId)).filter(Boolean) as NetworkSlice["nodes"];
      const latency = taskLatencyMetrics(route, task);

      return {
        slice_index: slice.index,
        time: slice.time,
        minute: slice.minute,
        task_id: task.task_id,
        task_type: task.task_type ?? "",
        start_slice: task.start_slice,
        duration_slices: task.duration_slices,
        source: task.source ?? "",
        target: task.target ?? "",
        node_id: task.node_id ?? "",
        status: route?.status ?? "missing",
        reason: route?.reason ?? "",
        routing_algorithm: route?.algorithm ?? slice.routingAlgorithm,
        traffic_mbps: route?.trafficMbps ?? task.traffic_mbps ?? 0,
        priority: route?.priority ?? task.priority ?? 0,
        carried_traffic_mbps: route ? round(route.carriedTrafficMbps, 3) : 0,
        queued_traffic_mb: route ? round(route.queuedTrafficMb, 3) : 0,
        dropped_traffic_mb: route ? round(route.droppedTrafficMb, 3) : 0,
        task_telemetry_node_id: route?.taskTelemetryNodeId ?? "",
        task_telemetry_generated_mb: route ? round(route.taskTelemetryGeneratedMb, 3) : 0,
        compute_units: task.compute_units,
        gpu_units: task.gpu_units ?? 0,
        memory_gb: task.memory_gb ?? 0,
        storage_gb: task.storage_gb ?? 0,
        hop_count: route?.hopCount ?? 0,
        distance_km: route ? round(route.distanceKm, 3) : 0,
        latency_ms: route ? round(route.latencyMs, 4) : 0,
        route_latency_ms: round(latency.routeLatencyMs, 4),
        queue_delay_ms: latency.queueDelayMs,
        queue_backlog_delay_ms: latency.queueBacklogDelayMs,
        timeout_ms: latency.timeoutMs,
        latency_capped: latency.latencyCapped,
        estimated_end_to_end_latency_ms: latency.estimatedEndToEndLatencyMs,
        delivery_ratio: latency.deliveryRatio,
        delivery_state: latency.deliveryState,
        delivered: latency.delivered,
        dropped: latency.dropped,
        latency_model: "route_latency_plus_queue_delay",
        path: route?.path.join(" > ") ?? "",
        link_ids: route?.linkIds.join(" > ") ?? "",
        bottleneck_link_id: linkSummary.bottleneck?.id ?? "",
        bottleneck_utilization_percent: linkSummary.bottleneck?.state.utilizationPercent ?? 0,
        bottleneck_capacity_mbps: linkSummary.bottleneck?.state.bandwidthMbps ?? 0,
        max_link_demand_mbps: round(linkSummary.maxDemandMbps, 3),
        max_link_carried_mbps: round(linkSummary.maxCarriedMbps, 3),
        max_link_utilization_percent: round(linkSummary.maxUtilizationPercent, 3),
        max_link_congestion_percent: round(linkSummary.maxCongestionPercent, 3),
        max_link_queue_mb: round(linkSummary.maxQueuedMb, 3),
        max_link_drop_mb: round(linkSummary.maxDroppedMb, 3),
        impacted_node_count: impactedNodeIds.length,
        max_path_cpu_percent: round(maxOf(impactedNodes.map((node) => node.resources.cpu_utilization)), 3),
        max_path_forwarding_mbps: round(maxOf(impactedNodes.map((node) => node.resources.forwarding_load_mbps)), 3),
        max_path_telemetry_buffer_mb: round(maxOf(impactedNodes.map((node) => node.resources.telemetry_buffer_mb)), 3),
        min_path_energy_wh: round(minOf(impactedNodes.map((node) => node.resources.energy_wh)), 3),
        constrained_link_count: constrainedLinks.length,
        polar_blocked_link_count: constrainedLinks.filter((link) => link.state.restrictionReason === "polar-region").length,
      };
    });
  });
}

export function businessLinkImpactRows(slices: NetworkSlice[], tasks: TaskTrafficRecord[]): ExportRow[] {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  return slices.flatMap((slice) => {
    const linksById = new Map(slice.links.map((link) => [link.id, link]));
    return slice.routes.flatMap((route) => {
      const task = taskById.get(route.task_id);
      if (!task || !taskActiveInSlice(task, slice.index) || route.status !== "routed") return [];
      return route.linkIds.flatMap((linkId, order) => {
        const link = linksById.get(linkId);
        if (!link) return [];
        return {
          slice_index: slice.index,
          time: slice.time,
          minute: slice.minute,
          task_id: task.task_id,
          task_type: task.task_type ?? "",
          link_order: order,
          link_id: link.id,
          link_kind: link.kind,
          source_node: link.source,
          target_node: link.target,
          route_traffic_mbps: round(route.trafficMbps, 3),
          route_priority: route.priority,
          route_carried_mbps: round(route.carriedTrafficMbps, 3),
          route_queued_mb: round(route.queuedTrafficMb, 3),
          route_dropped_mb: round(route.droppedTrafficMb, 3),
          route_task_telemetry_generated_mb: round(route.taskTelemetryGeneratedMb, 3),
          link_demand_mbps: round(link.state.demandTrafficMbps, 3),
          link_carried_mbps: round(link.state.carriedTrafficMbps, 3),
          link_bandwidth_mbps: round(link.state.bandwidthMbps, 3),
          utilization_percent: round(link.state.utilizationPercent, 3),
          congestion_percent: round(link.state.congestionPercent, 3),
          queued_traffic_mb: round(link.state.queuedTrafficMb, 3),
          dropped_traffic_mb: round(link.state.droppedTrafficMb, 3),
          latency_ms: round(link.state.latencyMs, 4),
          queue_latency_ms: round(
            estimateQueueLatencyMs(
              link.state.queuedTrafficMb,
              link.state.linkBudget?.effective_capacity_mbps ?? link.state.bandwidthMbps,
            ),
            4,
          ),
          distance_km: round(link.state.distanceKm, 3),
          link_status: link.state.status,
          is_active: link.state.isActive,
          restriction_reason: link.state.restrictionReason ?? "",
          sinr_db: link.state.linkBudget ? round(link.state.linkBudget.sinr_db, 3) : "",
          capacity_limit_mbps: link.state.linkBudget ? round(link.state.linkBudget.capacity_limit_mbps, 3) : "",
          shannon_capacity_mbps: link.state.linkBudget ? round(link.state.linkBudget.shannon_capacity_mbps, 3) : "",
        };
      });
    });
  });
}

export function businessNodeImpactRows(slices: NetworkSlice[], tasks: TaskTrafficRecord[]): ExportRow[] {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  return slices.flatMap((slice) => {
    const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
    return slice.routes.flatMap((route) => {
      const task = taskById.get(route.task_id);
      if (!task || !taskActiveInSlice(task, slice.index)) return [];
      const impactedNodeIds =
        route.path.length > 0
          ? route.path
          : task.node_id
            ? [task.node_id]
            : task.source
              ? [task.source]
              : [];

      return impactedNodeIds.flatMap((nodeId) => {
        const node = nodesById.get(nodeId);
        if (!node) return [];
        return {
          slice_index: slice.index,
          time: slice.time,
          minute: slice.minute,
          task_id: task.task_id,
          task_type: task.task_type ?? "",
          node_id: node.id,
          role: routeRole(route, node.id, task),
          plane: node.plane,
          slot: node.slot,
          latitude_deg: round(node.timeState.latitudeDeg, 6),
          longitude_deg: round(node.timeState.longitudeDeg, 6),
          in_sunlight: node.timeState.inSunlight,
          solar_exposure: round(node.timeState.solarExposure, 4),
          assigned_task_count: node.resources.assigned_task_count,
          cpu_percent: node.resources.cpu_utilization,
          compute_cpu_percent: node.resources.compute_cpu_percent,
          task_traffic_cpu_percent: node.resources.task_traffic_cpu_percent,
          forwarding_cpu_percent: node.resources.forwarding_cpu_percent,
          queue_cpu_percent: node.resources.queue_cpu_percent,
          gpu_percent: node.resources.gpu_utilization ?? "",
          memory_used_gb: node.resources.memory_used_gb,
          storage_used_gb: node.resources.storage_used_gb,
          ingress_traffic_mbps: node.resources.ingress_traffic_mbps,
          egress_traffic_mbps: node.resources.egress_traffic_mbps,
          transit_traffic_mbps: node.resources.transit_traffic_mbps,
          forwarding_load_mbps: node.resources.forwarding_load_mbps,
          queued_traffic_mb: node.resources.queued_traffic_mb,
          dropped_traffic_mb: node.resources.dropped_traffic_mb,
          cache_used_mb: node.resources.cache_used_mb,
          telemetry_generated_mb: node.resources.telemetry_generated_mb,
          task_telemetry_generated_mb:
            route.taskTelemetryNodeId === node.id ? round(route.taskTelemetryGeneratedMb, 3) : 0,
          telemetry_buffer_mb: node.resources.telemetry_buffer_mb,
          telemetry_downlinked_mb: node.resources.telemetry_downlinked_mb,
          communication_power_w: node.resources.communication_power_w,
          network_compute_power_w: node.resources.network_compute_power_w,
          load_power_w: node.resources.load_power_w,
          solar_power_w: node.resources.solar_power_w,
          net_power_w: node.resources.net_power_w,
          energy_wh: node.resources.energy_wh,
          state_of_charge: node.resources.state_of_charge,
          temperature_c: node.state.temperatureC,
          queue_depth: node.state.queueDepth,
        };
      });
    });
  });
}

export function experimentJson(context: ExperimentExportContext, slices: NetworkSlice[]) {
  return JSON.stringify(
    {
      metadata: experimentMetadata(context, slices),
      metrics: networkMetricRows(slices),
      slices,
    },
    null,
    2,
  );
}
