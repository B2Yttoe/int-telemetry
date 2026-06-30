import type { TaskTrafficRecord, TaskType, TrafficProfile, WalkerNetworkConfig } from "./types";

type ScenarioProfile = Exclude<TrafficProfile, "empty" | "uploaded">;

export interface TrafficDatasetValidation {
  accepted: number;
  warnings: string[];
  errors: string[];
}

const scenarioProfiles = new Set<TrafficProfile>([
  "low-load",
  "normal",
  "high-load",
  "hotspot",
  "burst",
  "long-duration",
]);

const validTaskTypes = new Set<TaskType>(["compute", "routing", "downlink", "telemetry", "mixed", "background", "burst"]);

const satelliteId = (plane: number, slot: number) =>
  `P${String(plane + 1).padStart(2, "0")}-S${String(slot + 1).padStart(2, "0")}`;

const providedField = (record: Record<string, unknown>, keys: string[]) =>
  keys.find((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");

function checkedNumericField(
  record: Record<string, unknown>,
  keys: string[],
  fallback: number,
  fieldName: string,
  errors: string[],
  options: { min?: number; integer?: boolean } = {},
) {
  const key = providedField(record, keys);
  if (!key) return fallback;

  const parsed = Number(record[key]);
  if (!Number.isFinite(parsed)) {
    errors.push(`${fieldName} is not a valid finite number`);
    return fallback;
  }

  const { min, integer } = options;
  if (min !== undefined && parsed < min) {
    errors.push(`${fieldName} must be >= ${min}`);
  }

  const value = integer ? Math.floor(parsed) : parsed;
  return min === undefined ? value : Math.max(min, value);
}

const textField = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).trim();
};

const taskTypeField = (value: unknown) => {
  const text = textField(value);
  return text ? text.toLowerCase() : undefined;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function sliceFromTimeField(value: unknown, fallback: number, errors?: string[]) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) errors?.push("start_slice/time must be >= 0");
    return Math.max(0, Math.floor(value));
  }

  const text = String(value).trim();
  const tMatch = /^T?(\d+)$/i.exec(text);
  if (tMatch) return Math.max(0, Number(tMatch[1]));

  const minuteMatch = /^(\d+(?:\.\d+)?)\s*(m|min|minute|minutes)$/i.exec(text);
  if (minuteMatch) return Math.max(0, Math.floor(Number(minuteMatch[1])));

  const parsed = Number(text);
  if (Number.isFinite(parsed)) {
    if (parsed < 0) errors?.push("start_slice/time must be >= 0");
    return Math.max(0, Math.floor(parsed));
  }

  errors?.push("start_slice/time is not a valid slice or minute value");
  return fallback;
}

function splitCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"' && inQuotes) {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

export function isScenarioTrafficProfile(profile: TrafficProfile): profile is ScenarioProfile {
  return scenarioProfiles.has(profile);
}

export function effectiveTrafficTasks(
  config: WalkerNetworkConfig,
  profile: TrafficProfile,
  uploadedTasks: TaskTrafficRecord[],
): TaskTrafficRecord[] {
  if (profile === "uploaded") return uploadedTasks;
  if (isScenarioTrafficProfile(profile)) return scenarioTrafficTasks(config, profile);
  return [];
}

export function normalizeTaskRecord(record: Record<string, unknown>, index: number): TaskTrafficRecord {
  const startField = record.start_slice ?? record.slice ?? record.start ?? record.time;
  const normalizationErrors: string[] = [];

  const task: TaskTrafficRecord = {
    task_id: String(record.task_id ?? record.id ?? record.flow_id ?? `task-${index + 1}`),
    time: textField(record.time),
    start_slice: sliceFromTimeField(startField, 0, normalizationErrors),
    duration_slices: checkedNumericField(
      record,
      ["duration_slices", "duration", "duration_slice", "duration_time"],
      1,
      "duration_slices",
      normalizationErrors,
      { min: 1, integer: true },
    ),
    source: textField(record.source ?? record.src),
    target: textField(record.target ?? record.dst ?? record.destination),
    node_id: textField(record.node_id ?? record.node ?? record.satellite_id),
    compute_units: checkedNumericField(record, ["compute_units", "compute", "cpu"], 0, "compute_units", normalizationErrors, {
      min: 0,
    }),
    gpu_units: checkedNumericField(record, ["gpu_units", "gpu"], 0, "gpu_units", normalizationErrors, { min: 0 }),
    memory_gb: checkedNumericField(record, ["memory_gb", "memory", "mem_gb"], 0, "memory_gb", normalizationErrors, {
      min: 0,
    }),
    storage_gb: checkedNumericField(record, ["storage_gb", "storage", "disk_gb"], 0, "storage_gb", normalizationErrors, {
      min: 0,
    }),
    traffic_mbps: checkedNumericField(
      record,
      ["traffic_mbps", "traffic", "bandwidth_mbps"],
      0,
      "traffic_mbps",
      normalizationErrors,
      { min: 0 },
    ),
    priority: checkedNumericField(record, ["priority"], 0, "priority", normalizationErrors, { min: 0 }),
    task_type: taskTypeField(record.task_type ?? record.type ?? record.service_type),
  };

  if (normalizationErrors.length > 0) task.normalization_errors = normalizationErrors;
  return task;
}

export function parseCsvTasks(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line, index) => {
    const values = splitCsvLine(line);
    const record = Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex]]));
    return normalizeTaskRecord(record, index);
  });
}

export function parseTaskDataset(text: string, fileName: string) {
  if (fileName.toLowerCase().endsWith(".csv")) return parseCsvTasks(text);

  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => normalizeTaskRecord(row as Record<string, unknown>, index));
}

export function validateTaskDataset(tasks: TaskTrafficRecord[], config: WalkerNetworkConfig): TrafficDatasetValidation {
  const nodeIds = new Set<string>();
  for (let plane = 0; plane < config.constellation.planes; plane += 1) {
    for (let slot = 0; slot < config.constellation.satellitesPerPlane; slot += 1) {
      nodeIds.add(satelliteId(plane, slot));
    }
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  tasks.forEach((task, index) => {
    task.normalization_errors?.forEach((error) => {
      errors.push(`row ${index + 1} task ${task.task_id} input normalization error: ${error}`);
    });
  });

  tasks.forEach((task, index) => {
    const rowLabel = `第 ${index + 1} 行任务 ${task.task_id}`;
    if (seenIds.has(task.task_id)) warnings.push(`${rowLabel} 的 task_id 重复`);
    seenIds.add(task.task_id);

    if (task.start_slice >= config.time.slices) warnings.push(`${rowLabel} 的 start_slice 超出当前时间片范围`);
    if (task.start_slice + task.duration_slices > config.time.slices) {
      warnings.push(`${rowLabel} 的持续时间超过当前仿真窗口，超出部分不会生效`);
    }
    if ((task.traffic_mbps ?? 0) === 0 && task.compute_units === 0) {
      warnings.push(`${rowLabel} 没有业务流量或计算负载`);
    }

    const hasSource = Boolean(task.source);
    const hasTarget = Boolean(task.target);
    const hasNode = Boolean(task.node_id);
    const isRoutedTask = hasSource && hasTarget && !hasNode;
    const isLocalTask = hasNode && !hasSource && !hasTarget;

    if (!isRoutedTask && !isLocalTask) {
      errors.push(`${rowLabel} 的端点定义不明确：跨星路由任务必须提供 source 和 target，本地任务只能提供 node_id`);
    }
    if ((task.traffic_mbps ?? 0) > 0 && !isRoutedTask) {
      errors.push(`${rowLabel} 包含 traffic_mbps，但没有提供合法的 source/target 路由端点`);
    }

    const taskType = task.task_type ? String(task.task_type) : "";
    if (taskType && !validTaskTypes.has(taskType as TaskType)) {
      errors.push(`${rowLabel} task_type is not supported: ${taskType}`);
    }
    if (isRoutedTask && task.source === task.target) {
      errors.push(`${rowLabel} source and target must be different for routed traffic tasks`);
    }

    const endpointIds = [task.source, task.target, task.node_id].filter(Boolean) as string[];
    endpointIds.forEach((id) => {
      if (!nodeIds.has(id)) errors.push(`${rowLabel} 引用了不存在的节点：${id}`);
    });
  });

  return { accepted: tasks.length, warnings, errors };
}

function scenarioTask(
  profile: ScenarioProfile,
  index: number,
  config: WalkerNetworkConfig,
  options: {
    startSlice: number;
    durationSlices: number;
    sourcePlane: number;
    sourceSlot: number;
    targetPlane: number;
    targetSlot: number;
    trafficMbps: number;
    computeUnits: number;
    memoryGb: number;
    storageGb: number;
    priority: number;
    taskType: TaskTrafficRecord["task_type"];
  },
): TaskTrafficRecord {
  const { planes, satellitesPerPlane } = config.constellation;

  return {
    task_id: `${profile}-${String(index + 1).padStart(2, "0")}`,
    start_slice: clamp(Math.floor(options.startSlice), 0, Math.max(0, config.time.slices - 1)),
    duration_slices: Math.max(1, Math.floor(options.durationSlices)),
    source: satelliteId(options.sourcePlane % planes, options.sourceSlot % satellitesPerPlane),
    target: satelliteId(options.targetPlane % planes, options.targetSlot % satellitesPerPlane),
    compute_units: options.computeUnits,
    memory_gb: options.memoryGb,
    storage_gb: options.storageGb,
    traffic_mbps: options.trafficMbps,
    priority: options.priority,
    task_type: options.taskType,
  };
}

export function scenarioTrafficTasks(config: WalkerNetworkConfig, profile: ScenarioProfile): TaskTrafficRecord[] {
  const model = config.trafficModel;
  const { planes, satellitesPerPlane } = config.constellation;
  const halfPlanes = Math.max(1, Math.floor(planes / 2));
  const halfSlots = Math.max(1, Math.floor(satellitesPerPlane / 2));

  if (profile === "low-load") {
    return Array.from({ length: Math.max(8, Math.floor(model.normalFlowCount / 2)) }, (_, index) =>
      scenarioTask(profile, index, config, {
        startSlice: index % Math.max(1, Math.floor(config.time.slices / 2)),
        durationSlices: 4,
        sourcePlane: index % planes,
        sourceSlot: (index * 2) % satellitesPerPlane,
        targetPlane: (index + halfPlanes) % planes,
        targetSlot: (index * 2 + halfSlots) % satellitesPerPlane,
        trafficMbps: 45 + ((index * 23) % 120),
        computeUnits: 8,
        memoryGb: 0.25,
        storageGb: 0.5,
        priority: 1,
        taskType: "background",
      }),
    );
  }

  if (profile === "high-load") {
    return Array.from({ length: Math.max(model.normalFlowCount * 2, 48) }, (_, index) =>
      scenarioTask(profile, index, config, {
        startSlice: index % Math.max(1, Math.floor(config.time.slices / 2)),
        durationSlices: Math.max(8, model.normalFlowDurationSlices),
        sourcePlane: index % planes,
        sourceSlot: (index * 3 + Math.floor(index / planes)) % satellitesPerPlane,
        targetPlane: (index + halfPlanes + 1 + (index % 3)) % planes,
        targetSlot: (index * 5 + halfSlots) % satellitesPerPlane,
        trafficMbps: 620 + ((index * 137) % 980),
        computeUnits: 48,
        memoryGb: 1.25,
        storageGb: 2.5,
        priority: 2,
        taskType: "mixed",
      }),
    );
  }

  if (profile === "hotspot") {
    const hubPlane = Math.max(0, Math.floor(planes / 2));
    const hubSlot = Math.max(0, Math.floor(satellitesPerPlane / 2));
    return Array.from({ length: Math.max(model.normalFlowCount + 12, 36) }, (_, index) => {
      const sourcePlane = index % planes;
      const sourceSlot = (index * 3 + 1) % satellitesPerPlane;
      const initialTargetSlot = (hubSlot + (index % 3) - 1 + satellitesPerPlane) % satellitesPerPlane;
      const targetSlot =
        sourcePlane === hubPlane && sourceSlot === initialTargetSlot
          ? (initialTargetSlot + 1) % satellitesPerPlane
          : initialTargetSlot;

      return scenarioTask(profile, index, config, {
        startSlice: index % 6,
        durationSlices: 10,
        sourcePlane,
        sourceSlot,
        targetPlane: hubPlane,
        targetSlot,
        trafficMbps: 420 + ((index * 89) % 560),
        computeUnits: 28,
        memoryGb: 0.75,
        storageGb: 1.5,
        priority: 3,
        taskType: "routing",
      });
    });
  }

  if (profile === "burst") {
    const burstStart = Math.max(1, Math.floor(config.time.slices / 3));
    return Array.from({ length: Math.max(model.normalFlowCount + 16, 40) }, (_, index) =>
      scenarioTask(profile, index, config, {
        startSlice: burstStart + (index % 2),
        durationSlices: 2,
        sourcePlane: index % planes,
        sourceSlot: (index * 5) % satellitesPerPlane,
        targetPlane: (index + halfPlanes + 2) % planes,
        targetSlot: (index * 7 + halfSlots) % satellitesPerPlane,
        trafficMbps: 850 + ((index * 173) % 950),
        computeUnits: 18,
        memoryGb: 0.5,
        storageGb: 1,
        priority: 4,
        taskType: "burst",
      }),
    );
  }

  if (profile === "long-duration") {
    return Array.from({ length: model.normalFlowCount }, (_, index) =>
      scenarioTask(profile, index, config, {
        startSlice: index % 3,
        durationSlices: config.time.slices - (index % 3),
        sourcePlane: index % planes,
        sourceSlot: (index * 2 + Math.floor(index / planes)) % satellitesPerPlane,
        targetPlane: (index + halfPlanes + 1) % planes,
        targetSlot: (index * 3 + halfSlots) % satellitesPerPlane,
        trafficMbps: 160 + ((index * 59) % 320),
        computeUnits: 18,
        memoryGb: 0.6,
        storageGb: 1.2,
        priority: 2,
        taskType: "telemetry",
      }),
    );
  }

  return Array.from({ length: model.normalFlowCount }, (_, index) => {
    const sourcePlane = index % planes;
    const sourceSlot = (index * 3 + Math.floor(index / planes)) % satellitesPerPlane;
    const targetPlane = (sourcePlane + halfPlanes + 1 + (index % 3)) % planes;
    const targetSlot = (sourceSlot + halfSlots + (index % 2)) % satellitesPerPlane;
    const rateSpan = Math.max(0, model.normalFlowMaxMbps - model.normalFlowMinMbps);
    const trafficMbps = model.normalFlowMinMbps + ((index * 47) % Math.max(1, rateSpan + 1));
    const startSlice = index % Math.max(1, Math.min(config.time.slices, model.normalFlowDurationSlices));

    return scenarioTask(profile, index, config, {
      startSlice,
      durationSlices: Math.max(model.normalFlowDurationSlices, Math.ceil(config.time.slices / 2)),
      sourcePlane,
      sourceSlot,
      targetPlane,
      targetSlot,
      trafficMbps,
      computeUnits: model.normalFlowComputeUnits,
      memoryGb: 0.5,
      storageGb: 1,
      priority: 1,
      taskType: "mixed",
    });
  });
}
