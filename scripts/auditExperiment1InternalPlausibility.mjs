import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const DEFAULT_OUT_DIR = "reports/experiment1-satellite-data-authenticity";
const DEFAULT_SOLAR_PEAK_POWER_W = 1361 * 2 * 0.28;
const DEFAULT_MIN_SOC = 0.2;

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function rel(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function round(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function numeric(row, key, fallback = Number.NaN) {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function boolish(value) {
  return value === true || value === "true" || value === "TRUE" || value === "1";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((item) => item.some((value) => value !== ""))
    .map((item) => Object.fromEntries(header.map((key, index) => [key, item[index] ?? ""])));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const text = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  await writeFile(path, `${text}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : Number.NaN;
}

function percentile(values, p) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return Number.NaN;
  const position = (clean.length - 1) * p;
  const left = Math.floor(position);
  const right = Math.min(clean.length - 1, left + 1);
  const ratio = position - left;
  return clean[left] * (1 - ratio) + clean[right] * ratio;
}

function median(values) {
  return percentile(values, 0.5);
}

function correlation(pairs) {
  const clean = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (clean.length < 3) return Number.NaN;
  const meanX = average(clean.map(([x]) => x));
  const meanY = average(clean.map(([, y]) => y));
  const numerator = clean.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const dx = Math.sqrt(clean.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0));
  const dy = Math.sqrt(clean.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0));
  return dx && dy ? numerator / (dx * dy) : Number.NaN;
}

function stats(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) {
    return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
  }
  return {
    count: clean.length,
    min: round(Math.min(...clean), 4),
    p50: round(percentile(clean, 0.5), 4),
    p95: round(percentile(clean, 0.95), 4),
    max: round(Math.max(...clean), 4),
    mean: round(average(clean), 4),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approxEqual(actual, expected, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function normalize(values) {
  const clean = values.filter(Number.isFinite);
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 1e-12) {
    return values.map(() => 0);
  }
  return values.map((value) => (Number.isFinite(value) ? (value - min) / (max - min) : 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function samplePush(samples, value, limit = 8) {
  if (samples.length < limit) samples.push(value);
}

function makeCheck({
  id,
  category,
  label,
  passed,
  severity = "hard",
  metric,
  threshold,
  checked = 0,
  violations = 0,
  evidence = {},
  samples = [],
  note = "",
}) {
  return {
    id,
    category,
    label,
    severity,
    passed: Boolean(passed),
    metric,
    threshold,
    checked,
    violations,
    pass_ratio: checked > 0 ? round((checked - violations) / checked, 6) : null,
    evidence,
    samples,
    note,
  };
}

function estimateBatteryCapacityWh(nodeRows) {
  const inferred = nodeRows
    .map((row) => {
      const energyWh = numeric(row, "energy_wh");
      const soc = numeric(row, "state_of_charge");
      return energyWh > 0 && soc > 0 ? energyWh / soc : Number.NaN;
    })
    .filter(Number.isFinite);
  const value = median(inferred);
  return Number.isFinite(value) ? value : 1200;
}

function estimateStepMinutes(nodeRows, metadata) {
  const metadataStep =
    Number.isFinite(Number(metadata.slice_count)) && Number(metadata.slice_count) > 1
      ? Number.NaN
      : Number.NaN;
  void metadataStep;
  const bySlice = new Map();
  for (const row of nodeRows) {
    const slice = numeric(row, "slice_index");
    if (!Number.isFinite(slice) || bySlice.has(slice)) continue;
    bySlice.set(slice, numeric(row, "minute"));
  }
  const minutes = [...bySlice.entries()].sort((a, b) => a[0] - b[0]).map(([, minute]) => minute);
  const diffs = [];
  for (let index = 1; index < minutes.length; index += 1) {
    const diff = minutes[index] - minutes[index - 1];
    if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
  }
  const step = median(diffs);
  return Number.isFinite(step) && step > 0 ? step : 5;
}

function inferSolarPeakPowerW(nodeRows) {
  const ratios = nodeRows
    .map((row) => {
      const exposure = numeric(row, "solar_exposure");
      const power = numeric(row, "solar_power_w");
      return exposure > 0.05 && power >= 0 ? power / exposure : Number.NaN;
    })
    .filter(Number.isFinite);
  const inferred = median(ratios);
  return Number.isFinite(inferred) && inferred > 0 ? inferred : DEFAULT_SOLAR_PEAK_POWER_W;
}

function checkRowCount(nodeRows, linkRows, routeRows, metadata) {
  const expectedNodeRows = Number(metadata.slice_count) * Number(metadata.node_count);
  const linkCountBySlice = new Map();
  for (const row of linkRows) {
    linkCountBySlice.set(row.slice_index, (linkCountBySlice.get(row.slice_index) ?? 0) + 1);
  }
  const linkCounts = [...linkCountBySlice.values()];
  const expectedLinkCount = Number(metadata.link_count);
  const minLinkCount = Math.min(...linkCounts);
  const maxLinkCount = Math.max(...linkCounts);
  const linkCountTolerance = Math.max(16, expectedLinkCount * 0.02);
  const linkCountViolations = linkCounts.filter((count) => Math.abs(count - expectedLinkCount) > linkCountTolerance).length;
  return [
    makeCheck({
      id: "node-row-count",
      category: "boundary",
      label: "节点状态行数等于 时间片数 × 节点数",
      passed: nodeRows.length === expectedNodeRows,
      metric: nodeRows.length,
      threshold: expectedNodeRows,
      checked: 1,
      violations: nodeRows.length === expectedNodeRows ? 0 : 1,
      evidence: { actual_node_rows: nodeRows.length, expected_node_rows: expectedNodeRows },
    }),
    makeCheck({
      id: "link-row-count",
      category: "boundary",
      label: "动态拓扑每个时间片均有完整链路快照",
      passed: linkCountBySlice.size === Number(metadata.slice_count) && linkCountViolations === 0,
      metric: `${minLinkCount}-${maxLinkCount}`,
      threshold: `${expectedLinkCount} ± ${round(linkCountTolerance, 3)}`,
      checked: linkCountBySlice.size,
      violations: linkCountViolations,
      evidence: {
        actual_link_rows: linkRows.length,
        slice_count_with_links: linkCountBySlice.size,
        expected_slices: Number(metadata.slice_count),
        metadata_reference_link_count: expectedLinkCount,
        min_links_per_slice: minLinkCount,
        max_links_per_slice: maxLinkCount,
      },
      note: "真实/TLE 动态拓扑下，部分轨间候选链路会因极区、距离和遮挡约束出现少量快照数量波动，因此这里检查每片快照完整性和合理波动范围，而不是静态乘法等式。",
    }),
    makeCheck({
      id: "route-records-present",
      category: "boundary",
      label: "实验业务路由记录存在",
      passed: routeRows.length > 0,
      metric: routeRows.length,
      threshold: "> 0",
      checked: 1,
      violations: routeRows.length > 0 ? 0 : 1,
      evidence: { route_rows: routeRows.length },
    }),
  ];
}

function checkCpu(nodeRows) {
  const samples = [];
  let componentViolations = 0;
  let boundViolations = 0;
  let idleRows = 0;
  let idleViolations = 0;
  const idleCpuValues = [];
  const activeCpuValues = [];
  const loadPairs = [];

  for (const row of nodeRows) {
    const cpu = numeric(row, "cpu_percent");
    const compute = numeric(row, "compute_cpu_percent", 0);
    const endpoint = numeric(row, "task_traffic_cpu_percent", 0);
    const forwarding = numeric(row, "forwarding_cpu_percent", 0);
    const queue = numeric(row, "queue_cpu_percent", 0);
    const expected = clamp(compute + endpoint + forwarding + queue, 0, 100);
    if (cpu < -0.01 || cpu > 100.01 || compute < -0.01 || endpoint < -0.01 || forwarding < -0.01 || queue < -0.01) {
      boundViolations += 1;
      samplePush(samples, { slice: row.slice_index, node_id: row.node_id, field: "cpu_bound", cpu, compute, endpoint, forwarding, queue });
    }
    if (!approxEqual(cpu, Math.round(expected), 1.1)) {
      componentViolations += 1;
      samplePush(samples, {
        slice: row.slice_index,
        node_id: row.node_id,
        field: "cpu_formula",
        actual: cpu,
        expected: round(expected, 3),
      });
    }

    const assignedTasks = numeric(row, "assigned_task_count", 0);
    const trafficMbps =
      numeric(row, "ingress_traffic_mbps", 0) +
      numeric(row, "egress_traffic_mbps", 0) +
      numeric(row, "transit_traffic_mbps", 0) +
      numeric(row, "forwarding_load_mbps", 0);
    const queuedMb = numeric(row, "queued_traffic_mb", 0);
    const workloadCpu = numeric(row, "workload_cpu_percent", 0);
    const active = assignedTasks > 0 || trafficMbps > 0.001 || queuedMb > 0.001 || workloadCpu > 0.001;
    const loadIndex = workloadCpu + trafficMbps / 100 + queuedMb / 10;
    loadPairs.push([loadIndex, cpu]);
    if (active) activeCpuValues.push(cpu);
    else {
      idleRows += 1;
      idleCpuValues.push(cpu);
      if (cpu > 0.5) {
        idleViolations += 1;
        samplePush(samples, { slice: row.slice_index, node_id: row.node_id, field: "idle_cpu", cpu, trafficMbps, queuedMb });
      }
    }
  }

  const activeMean = average(activeCpuValues);
  const idleMean = average(idleCpuValues);
  const loadCpuCorrelation = correlation(loadPairs);
  return [
    makeCheck({
      id: "cpu-bounds",
      category: "resource",
      label: "CPU 与分项 CPU 保持在 0-100% 合法范围",
      passed: boundViolations === 0,
      metric: boundViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: boundViolations,
      samples,
    }),
    makeCheck({
      id: "cpu-component-formula",
      category: "formula",
      label: "CPU 总利用率由计算、端点流量、转发、队列分项合成",
      passed: componentViolations === 0,
      metric: componentViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: componentViolations,
      samples,
      note: "公式：cpu = clip(compute_cpu + task_traffic_cpu + forwarding_cpu + queue_cpu, 0, 100)。",
    }),
    makeCheck({
      id: "idle-cpu-zero",
      category: "response",
      label: "空业务/无转发/无队列节点的 CPU 接近 0",
      passed: idleRows === 0 || idleViolations / idleRows <= 0.001,
      metric: idleRows > 0 ? round(idleViolations / idleRows, 6) : 0,
      threshold: "<= 0.001",
      checked: idleRows,
      violations: idleViolations,
      samples,
    }),
    makeCheck({
      id: "cpu-load-response",
      category: "response",
      label: "有任务或转发负载的节点 CPU 高于空闲节点",
      passed: activeCpuValues.length > 0 && Number.isFinite(activeMean) && Number.isFinite(idleMean) && activeMean > idleMean + 0.05,
      metric: round(activeMean - idleMean, 4),
      threshold: "> 0.05 percentage point",
      checked: nodeRows.length,
      violations: 0,
      evidence: {
        idle_rows: idleRows,
        active_rows: activeCpuValues.length,
        idle_cpu_mean: round(idleMean, 4),
        active_cpu_mean: round(activeMean, 4),
        load_cpu_correlation: round(loadCpuCorrelation, 4),
        cpu_percent_stats: stats(nodeRows.map((row) => numeric(row, "cpu_percent"))),
      },
      note: "该项不是外部真值，而是检查业务输入是否会驱动内部资源状态变化。",
    }),
  ];
}

function checkEnergy(nodeRows, { batteryCapacityWh, minSoc, stepMinutes, solarPeakPowerW }) {
  const samples = [];
  let boundViolations = 0;
  let socViolations = 0;
  let solarFormulaViolations = 0;
  let netPowerViolations = 0;
  let energyTransitionViolations = 0;
  let directionChecks = 0;
  let directionViolations = 0;
  let powerSavingRows = 0;
  let powerSavingViolations = 0;
  const sortedRowsByNode = new Map();
  const dtHours = stepMinutes / 60;
  const minEnergyWh = minSoc * batteryCapacityWh;

  for (const row of nodeRows) {
    const nodeId = row.node_id;
    if (!sortedRowsByNode.has(nodeId)) sortedRowsByNode.set(nodeId, []);
    sortedRowsByNode.get(nodeId).push(row);

    const energyWh = numeric(row, "energy_wh");
    const soc = numeric(row, "state_of_charge");
    const energyPercent = numeric(row, "energy_percent");
    if (energyWh < minEnergyWh - 0.6 || energyWh > batteryCapacityWh + 0.6 || soc < minSoc - 0.002 || soc > 1.002) {
      boundViolations += 1;
      samplePush(samples, { slice: row.slice_index, node_id: row.node_id, field: "energy_bound", energyWh, soc });
    }
    if (!approxEqual(soc, energyWh / batteryCapacityWh, 0.006) || !approxEqual(energyPercent, (energyWh / batteryCapacityWh) * 100, 1.2)) {
      socViolations += 1;
      samplePush(samples, {
        slice: row.slice_index,
        node_id: row.node_id,
        field: "soc_consistency",
        energyWh,
        soc,
        expected_soc: round(energyWh / batteryCapacityWh, 4),
        energyPercent,
      });
    }

    const exposure = numeric(row, "solar_exposure");
    const solarPower = numeric(row, "solar_power_w");
    const expectedSolar = exposure * solarPeakPowerW;
    if (!approxEqual(solarPower, expectedSolar, 1.2)) {
      solarFormulaViolations += 1;
      samplePush(samples, {
        slice: row.slice_index,
        node_id: row.node_id,
        field: "solar_power_formula",
        actual: solarPower,
        expected: round(expectedSolar, 2),
        exposure,
      });
    }

    const loadPower = numeric(row, "load_power_w");
    const netPower = numeric(row, "net_power_w");
    const expectedNetPower = 0.95 * Math.max(solarPower - loadPower, 0) - Math.max(loadPower - solarPower, 0) / 0.95;
    if (!approxEqual(netPower, expectedNetPower, 1.4)) {
      netPowerViolations += 1;
      samplePush(samples, {
        slice: row.slice_index,
        node_id: row.node_id,
        field: "net_power_formula",
        actual: netPower,
        expected: round(expectedNetPower, 2),
        solarPower,
        loadPower,
      });
    }

    const powerSaving = boolish(row.power_saving_mode);
    const canAcceptTasks = boolish(row.can_accept_tasks);
    if (soc <= minSoc + 0.001 || powerSaving) {
      powerSavingRows += 1;
      if (!powerSaving || canAcceptTasks) {
        powerSavingViolations += 1;
        samplePush(samples, { slice: row.slice_index, node_id: row.node_id, field: "power_saving_gate", soc, powerSaving, canAcceptTasks });
      }
    }
  }

  for (const rows of sortedRowsByNode.values()) {
    rows.sort((a, b) => numeric(a, "slice_index") - numeric(b, "slice_index"));
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      const previousEnergyWh = numeric(previous, "energy_wh");
      const currentEnergyWh = numeric(current, "energy_wh");
      const currentNetPowerW = numeric(current, "net_power_w");
      const expectedEnergyWh = clamp(previousEnergyWh + currentNetPowerW * dtHours, minEnergyWh, batteryCapacityWh);
      if (!approxEqual(currentEnergyWh, expectedEnergyWh, 0.7)) {
        energyTransitionViolations += 1;
        samplePush(samples, {
          slice: current.slice_index,
          node_id: current.node_id,
          field: "energy_transition",
          previousEnergyWh,
          currentNetPowerW,
          actual: currentEnergyWh,
          expected: round(expectedEnergyWh, 2),
        });
      }
      if (Math.abs(currentNetPowerW) > 20 && previousEnergyWh > minEnergyWh + 1 && previousEnergyWh < batteryCapacityWh - 1) {
        directionChecks += 1;
        const delta = currentEnergyWh - previousEnergyWh;
        if ((currentNetPowerW > 0 && delta < -0.25) || (currentNetPowerW < 0 && delta > 0.25)) {
          directionViolations += 1;
          samplePush(samples, { slice: current.slice_index, node_id: current.node_id, field: "energy_direction", currentNetPowerW, delta: round(delta, 4) });
        }
      }
    }
  }

  return [
    makeCheck({
      id: "battery-bounds",
      category: "resource",
      label: "电池能量限制在最小 SoC 与电池容量之间",
      passed: boundViolations === 0,
      metric: boundViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: boundViolations,
      evidence: {
        inferred_battery_capacity_wh: round(batteryCapacityWh, 3),
        min_soc: minSoc,
        min_energy_wh: round(minEnergyWh, 3),
        energy_wh_stats: stats(nodeRows.map((row) => numeric(row, "energy_wh"))),
      },
      samples,
    }),
    makeCheck({
      id: "soc-consistency",
      category: "formula",
      label: "SoC 与 energy_wh / E_bat,max 一致",
      passed: socViolations === 0,
      metric: socViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: socViolations,
      samples,
    }),
    makeCheck({
      id: "solar-power-formula",
      category: "formula",
      label: "太阳能发电由光照系数、太阳翼面积和效率决定",
      passed: solarFormulaViolations === 0,
      metric: solarFormulaViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: solarFormulaViolations,
      evidence: {
        inferred_solar_peak_power_w: round(solarPeakPowerW, 3),
        formula: "P_solar = exposure * I_sun * A_sa * eta_sa",
      },
      samples,
    }),
    makeCheck({
      id: "net-power-formula",
      category: "formula",
      label: "净功率由充放电效率、发电功率和负载功率决定",
      passed: netPowerViolations === 0,
      metric: netPowerViolations,
      threshold: 0,
      checked: nodeRows.length,
      violations: netPowerViolations,
      note: "公式：P_net = eta_ch*max(P_solar-P_load,0) - max(P_load-P_solar,0)/eta_dis。",
      samples,
    }),
    makeCheck({
      id: "energy-transition",
      category: "formula",
      label: "相邻时间片电池能量符合 E(t+Δt)=clip(E(t)+P_netΔt)",
      passed: energyTransitionViolations === 0,
      metric: energyTransitionViolations,
      threshold: 0,
      checked: Math.max(0, nodeRows.length - sortedRowsByNode.size),
      violations: energyTransitionViolations,
      evidence: { step_minutes: stepMinutes, dt_hours: round(dtHours, 6) },
      samples,
    }),
    makeCheck({
      id: "energy-direction",
      category: "response",
      label: "光照充电时电量上升，阴影放电时电量下降",
      passed: directionChecks === 0 || directionViolations / directionChecks <= 0.001,
      metric: directionChecks > 0 ? round(directionViolations / directionChecks, 6) : 0,
      threshold: "<= 0.001",
      checked: directionChecks,
      violations: directionViolations,
      samples,
    }),
    makeCheck({
      id: "power-saving-gate",
      category: "policy",
      label: "电量低于 SoC_min 或进入节能模式时不接受任务",
      passed: powerSavingViolations === 0,
      metric: powerSavingViolations,
      threshold: 0,
      checked: powerSavingRows,
      violations: powerSavingViolations,
      evidence: { power_saving_rows: powerSavingRows },
      samples,
      note: powerSavingRows === 0 ? "本次实验电量没有触发节能阈值，因此该项为门控逻辑存在性检查。" : "",
    }),
  ];
}

function checkLinksAndRoutes(linkRows, routeRows) {
  const linkBySliceId = new Map(linkRows.map((row) => [`${row.slice_index}|${row.link_id}`, row]));
  const samples = [];
  let inactiveTrafficViolations = 0;
  let utilizationViolations = 0;
  let queueLatencyViolations = 0;
  let routedLinkChecks = 0;
  let inactiveRouteViolations = 0;
  let routeLatencyViolations = 0;

  for (const row of linkRows) {
    const active = boolish(row.is_active);
    const bandwidth = numeric(row, "bandwidth_mbps");
    const carried = numeric(row, "carried_traffic_mbps", 0);
    const demand = numeric(row, "demand_traffic_mbps", 0);
    const queued = numeric(row, "queued_traffic_mb", 0);
    const dropped = numeric(row, "dropped_traffic_mb", 0);
    const utilization = numeric(row, "utilization_percent", 0);
    const queueLatency = numeric(row, "queue_latency_ms", 0);
    const effectiveCapacity = numeric(row, "effective_capacity_mbps", bandwidth);

    if (!active && Math.abs(carried) + Math.abs(demand) + Math.abs(queued) + Math.abs(dropped) + Math.abs(utilization) > 0.01) {
      inactiveTrafficViolations += 1;
      samplePush(samples, { slice: row.slice_index, link_id: row.link_id, field: "inactive_traffic", carried, demand, queued, dropped, utilization });
    }
    if (active && bandwidth > 0) {
      const expectedUtilization = demand > 0 ? Math.min(100, Math.max(0, (carried / bandwidth) * 100)) : 0;
      if (!approxEqual(utilization, Math.round(expectedUtilization), 1.2)) {
        utilizationViolations += 1;
        samplePush(samples, { slice: row.slice_index, link_id: row.link_id, field: "utilization", actual: utilization, expected: round(expectedUtilization, 3) });
      }
    }
    const expectedQueueLatency = effectiveCapacity > 0 ? (queued * 8 * 1000) / effectiveCapacity : 0;
    if (!approxEqual(queueLatency, expectedQueueLatency, 1.2)) {
      queueLatencyViolations += 1;
      samplePush(samples, { slice: row.slice_index, link_id: row.link_id, field: "queue_latency", actual: queueLatency, expected: round(expectedQueueLatency, 4), queued, effectiveCapacity });
    }
  }

  for (const route of routeRows) {
    if (route.status !== "routed") continue;
    const linkIds = String(route.link_ids ?? "")
      .split(" > ")
      .map((item) => item.trim())
      .filter(Boolean);
    const pathLatency = linkIds.reduce((sum, linkId) => {
      const link = linkBySliceId.get(`${route.slice_index}|${linkId}`);
      return sum + (link ? numeric(link, "latency_ms", 0) : 0);
    }, 0);
    for (const linkId of linkIds) {
      routedLinkChecks += 1;
      const link = linkBySliceId.get(`${route.slice_index}|${linkId}`);
      if (!link || !boolish(link.is_active)) {
        inactiveRouteViolations += 1;
        samplePush(samples, { slice: route.slice_index, task_id: route.task_id, field: "route_uses_inactive_link", linkId });
      }
    }
    const routeLatency = numeric(route, "route_latency_ms");
    if (!approxEqual(routeLatency, pathLatency, 0.8)) {
      routeLatencyViolations += 1;
      samplePush(samples, { slice: route.slice_index, task_id: route.task_id, field: "route_latency_sum", actual: routeLatency, expected: round(pathLatency, 4) });
    }
  }

  const droppedRows = routeRows.filter((row) => row.delivery_state === "dropped" || row.dropped === "true");
  const timeoutViolations = droppedRows.filter((row) => {
    const timeout = numeric(row, "timeout_ms");
    const estimated = numeric(row, "estimated_end_to_end_latency_ms");
    return Number.isFinite(timeout) && timeout > 0 && Number.isFinite(estimated) && estimated > timeout * 1.05;
  }).length;

  return [
    makeCheck({
      id: "inactive-link-has-no-traffic",
      category: "topology",
      label: "断开链路不承载业务、队列或利用率",
      passed: inactiveTrafficViolations === 0,
      metric: inactiveTrafficViolations,
      threshold: 0,
      checked: linkRows.length,
      violations: inactiveTrafficViolations,
      samples,
    }),
    makeCheck({
      id: "link-utilization-formula",
      category: "formula",
      label: "链路利用率由 carried_traffic / bandwidth 计算",
      passed: utilizationViolations === 0,
      metric: utilizationViolations,
      threshold: 0,
      checked: linkRows.length,
      violations: utilizationViolations,
      samples,
    }),
    makeCheck({
      id: "queue-latency-formula",
      category: "formula",
      label: "链路排队时延由 queued_traffic 和 effective_capacity 计算",
      passed: queueLatencyViolations === 0,
      metric: queueLatencyViolations,
      threshold: 0,
      checked: linkRows.length,
      violations: queueLatencyViolations,
      note: "公式：queue_latency_ms = queued_MB * 8 * 1000 / effective_capacity_Mbps。",
      samples,
    }),
    makeCheck({
      id: "routes-use-active-links",
      category: "topology",
      label: "已路由任务只使用当前时间片活动链路",
      passed: inactiveRouteViolations === 0,
      metric: inactiveRouteViolations,
      threshold: 0,
      checked: routedLinkChecks,
      violations: inactiveRouteViolations,
      samples,
    }),
    makeCheck({
      id: "route-latency-path-sum",
      category: "formula",
      label: "任务路由时延等于路径链路传播/处理时延求和",
      passed: routeLatencyViolations === 0,
      metric: routeLatencyViolations,
      threshold: 0,
      checked: routeRows.filter((row) => row.status === "routed").length,
      violations: routeLatencyViolations,
      samples,
    }),
    makeCheck({
      id: "dropped-task-latency-capping",
      category: "policy",
      label: "失败任务不再输出超过 timeout 的分钟级估计时延",
      passed: timeoutViolations === 0,
      metric: timeoutViolations,
      threshold: 0,
      checked: droppedRows.length,
      violations: timeoutViolations,
      note: "该项针对此前 p95 尾部时延偏高问题，区分 delivered、partial、dropped/timeout。",
      samples,
    }),
  ];
}

function buildSliceSeries(nodeRows, linkRows, routeRows) {
  const bySlice = new Map();
  const ensure = (slice) => {
    if (!bySlice.has(slice)) {
      bySlice.set(slice, {
        slice_index: slice,
        minute: 0,
        avg_cpu_percent: 0,
        avg_energy_wh: 0,
        avg_solar_exposure: 0,
        avg_net_power_w: 0,
        total_carried_traffic_mbps: 0,
        total_route_traffic_mbps: 0,
        active_link_count: 0,
        congested_link_count: 0,
        node_rows: 0,
        link_rows: 0,
        routed_tasks: 0,
      });
    }
    return bySlice.get(slice);
  };
  for (const row of nodeRows) {
    const slice = numeric(row, "slice_index", 0);
    const item = ensure(slice);
    item.minute = numeric(row, "minute", item.minute);
    item.avg_cpu_percent += numeric(row, "cpu_percent", 0);
    item.avg_energy_wh += numeric(row, "energy_wh", 0);
    item.avg_solar_exposure += numeric(row, "solar_exposure", 0);
    item.avg_net_power_w += numeric(row, "net_power_w", 0);
    item.node_rows += 1;
  }
  for (const row of linkRows) {
    const slice = numeric(row, "slice_index", 0);
    const item = ensure(slice);
    item.total_carried_traffic_mbps += numeric(row, "carried_traffic_mbps", 0);
    item.active_link_count += boolish(row.is_active) ? 1 : 0;
    item.congested_link_count += numeric(row, "congestion_percent", 0) > 0 ? 1 : 0;
    item.link_rows += 1;
  }
  for (const row of routeRows) {
    const slice = numeric(row, "slice_index", 0);
    const item = ensure(slice);
    if (row.status === "routed") {
      item.routed_tasks += 1;
      item.total_route_traffic_mbps += numeric(row, "traffic_mbps", 0);
    }
  }
  return [...bySlice.values()]
    .sort((a, b) => a.slice_index - b.slice_index)
    .map((item) => ({
      ...item,
      avg_cpu_percent: round(item.avg_cpu_percent / Math.max(item.node_rows, 1), 5),
      avg_energy_wh: round(item.avg_energy_wh / Math.max(item.node_rows, 1), 5),
      avg_solar_exposure: round(item.avg_solar_exposure / Math.max(item.node_rows, 1), 5),
      avg_net_power_w: round(item.avg_net_power_w / Math.max(item.node_rows, 1), 5),
    }));
}

function checkSystemResponses(sliceSeries, nodeRows, linkRows) {
  const cpuTrafficCorr = correlation(sliceSeries.map((row) => [row.total_route_traffic_mbps, row.avg_cpu_percent]));
  const solarNetCorr = correlation(sliceSeries.map((row) => [row.avg_solar_exposure, row.avg_net_power_w]));
  const queuePairs = linkRows.map((row) => [numeric(row, "queued_traffic_mb"), numeric(row, "queue_latency_ms")]);
  const queueLatencyCorr = correlation(queuePairs);
  const queuedRows = linkRows.filter((row) => numeric(row, "queued_traffic_mb", 0) > 0.001);
  const sunlightRows = nodeRows.filter((row) => numeric(row, "solar_exposure", 0) > 0.1);
  const darkRows = nodeRows.filter((row) => numeric(row, "solar_exposure", 0) <= 0.001);
  const avgNetPowerSunlight = average(sunlightRows.map((row) => numeric(row, "net_power_w")));
  const avgNetPowerDark = average(darkRows.map((row) => numeric(row, "net_power_w")));
  return [
    makeCheck({
      id: "slice-traffic-cpu-correlation",
      category: "response",
      label: "时间片总业务负载与平均 CPU 有正相关关系",
      passed: Number.isFinite(cpuTrafficCorr) && cpuTrafficCorr > 0.15,
      metric: round(cpuTrafficCorr, 4),
      threshold: "> 0.15",
      checked: sliceSeries.length,
      violations: 0,
      evidence: {
        max_slice_traffic_mbps: round(Math.max(...sliceSeries.map((row) => row.total_route_traffic_mbps)), 4),
        max_avg_cpu_percent: round(Math.max(...sliceSeries.map((row) => row.avg_cpu_percent)), 4),
      },
      note: "业务与 CPU 不要求逐点线性，因为路由路径、转发负载、任务计算量会共同影响节点状态。",
    }),
    makeCheck({
      id: "solar-net-power-correlation",
      category: "response",
      label: "光照暴露度与净功率正相关",
      passed:
        Number.isFinite(solarNetCorr) &&
        solarNetCorr > 0.7 &&
        Number.isFinite(avgNetPowerSunlight) &&
        Number.isFinite(avgNetPowerDark) &&
        avgNetPowerSunlight > avgNetPowerDark + 100,
      metric: round(solarNetCorr, 4),
      threshold: "corr > 0.7 and sunlight_net_power > dark_net_power + 100W",
      checked: sliceSeries.length,
      violations: 0,
      evidence: {
        sunlight_rows: sunlightRows.length,
        dark_rows: darkRows.length,
        avg_net_power_sunlight_w: round(avgNetPowerSunlight, 4),
        avg_net_power_dark_w: round(avgNetPowerDark, 4),
      },
      note: "净功率同时受光照和业务/通信负载影响，因此这里采用相关性加光照/阴影均值差的联合判据。",
    }),
    makeCheck({
      id: "queue-latency-response",
      category: "response",
      label: "有队列时，排队量与排队时延正相关",
      passed: queuedRows.length === 0 || (Number.isFinite(queueLatencyCorr) && queueLatencyCorr > 0.8),
      metric: queuedRows.length === 0 ? "not-applicable" : round(queueLatencyCorr, 4),
      threshold: "not-applicable or > 0.8",
      checked: queuedRows.length,
      violations: 0,
      note: queuedRows.length === 0 ? "本次业务未形成明显链路队列，因此该项不作为负面证据。" : "",
    }),
  ];
}

function lineChart(rows, series, { title = "", width = 920, height = 300 } = {}) {
  const margin = { left: 58, right: 28, top: 38, bottom: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const normalized = new Map(series.map((item) => [item.id, normalize(rows.map((row) => Number(row[item.id])))]));
  const x = (index) => margin.left + (index / Math.max(1, rows.length - 1)) * plotWidth;
  const y = (value) => margin.top + (1 - clamp(value, 0, 1)) * plotHeight;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((value) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" class="grid"/>`)
    .join("");
  const paths = series
    .map((item) => {
      const values = normalized.get(item.id) ?? [];
      const points = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
      return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  const legend = series
    .map(
      (item, index) =>
        `<g transform="translate(${margin.left + index * 210},${height - 17})"><rect width="14" height="4" fill="${item.color}"/><text x="22" y="4">${escapeHtml(item.label)}</text></g>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <title>${escapeHtml(title)}</title>
    <text x="${margin.left}" y="24" class="chart-title">${escapeHtml(title)}</text>
    ${grid}
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" class="axis"/>
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" class="axis"/>
    ${paths}
    ${legend}
  </svg>`;
}

function checkTable(checks) {
  return checks
    .map(
      (check) =>
        `<tr><td>${escapeHtml(check.id)}</td><td>${escapeHtml(check.category)}</td><td>${escapeHtml(check.label)}</td><td class="${check.passed ? "ok" : "bad"}">${check.passed ? "通过" : "需检查"}</td><td>${escapeHtml(check.metric)}</td><td>${escapeHtml(check.threshold)}</td><td>${check.checked}</td><td>${check.violations}</td></tr>`,
    )
    .join("");
}

function writeMarkdown({ outDir, metadata, summary, checks, outputs }) {
  const rows = checks
    .map(
      (check) =>
        `| ${check.id} | ${check.category} | ${check.passed ? "通过" : "需检查"} | ${check.metric ?? ""} | ${check.threshold ?? ""} | ${check.checked} | ${check.violations} |`,
    )
    .join("\n");
  return `# 实验 1 内部状态可信性审计

生成时间：${summary.generated_at}

实验目录：\`${rel(outDir)}\`

## 审计目的

CPU、队列、电池、电量、星上缓存这类数据在公开 Starlink/LEO 网络中通常不可直接获得。这个审计不把它们宣称为运营商内部真值，而是检查它们是否满足可复算的物理公式、边界条件、拓扑约束和业务响应关系。

换句话说，外部数据负责约束“轨道、拓扑壳层、业务时序、用户侧 RTT 量级”；本审计负责约束“外部不可观测的内部潜变量是否自洽且受输入驱动”。

## 核心结论

| 指标 | 数值 |
|---|---:|
| 审计检查项 | ${summary.check_count} |
| 通过项 | ${summary.passed_count} |
| 需检查项 | ${summary.failed_count} |
| 硬约束通过率 | ${summary.hard_pass_ratio} |
| 内部状态可信性分数 | ${summary.internal_plausibility_score} |
| 推断电池容量 | ${summary.inferred_battery_capacity_wh} Wh |
| 推断太阳翼峰值发电 | ${summary.inferred_solar_peak_power_w} W |
| 时间片长度 | ${summary.step_minutes} min |

## 关键公式

\`\`\`text
cpu = clip(compute_cpu + task_traffic_cpu + forwarding_cpu + queue_cpu, 0, 100)
P_solar = solar_exposure * I_sun * A_sa * eta_sa
P_net = eta_ch * max(P_solar - P_load, 0) - max(P_load - P_solar, 0) / eta_dis
E(t+dt) = clip(E(t) + P_net * dt, E_min, E_bat,max)
queue_latency_ms = queued_MB * 8 * 1000 / effective_capacity_Mbps
utilization = carried_traffic / bandwidth
route_latency = sum(link_latency on path)
\`\`\`

## 检查结果

| 检查项 | 类别 | 结果 | 指标 | 阈值 | 检查样本 | 违规样本 |
|---|---|---|---:|---:|---:|---:|
${rows}

## 如何解读

- 通过这些检查，说明内部状态不是无约束随机数，而是由任务、链路、光照、电池、队列等模型公式驱动。
- 如果某项失败，不能简单说模型全部失败，而要回到对应 CSV 样本查看是导出精度、公式口径还是模型缺陷。
- 本审计仍不能代替运营商真实内部遥测，只能作为“不可公开观测变量的合理性证据”。

## 输出文件

| 文件 | 说明 |
|---|---|
| \`${outputs.json}\` | 机器可读审计报告 |
| \`${outputs.md}\` | 本说明文档 |
| \`${outputs.html}\` | 可视化审计报告 |
| \`${outputs.checks_csv}\` | 每个检查项的表格 |
| \`${outputs.timeseries_csv}\` | 按时间片汇总的内部状态响应序列 |

## 输入规模

| 项目 | 数值 |
|---|---:|
| 时间片数 | ${metadata.slice_count} |
| 节点数 | ${metadata.node_count} |
| 单片链路数 | ${metadata.link_count} |
| 输入任务数 | ${metadata.dataset_task_count} |
| 路由任务数 | ${metadata.dataset_routed_task_count} |
`;
}

function writeHtml({ outDir, metadata, summary, checks, sliceSeries }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>实验 1 内部状态可信性审计</title>
  <style>
    :root { color-scheme: light; font-family: "Inter", "Segoe UI", Arial, sans-serif; color: #172033; background: #f5f7fb; }
    body { margin: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    h2 { margin-top: 28px; padding-top: 18px; border-top: 1px solid #dbe2ee; }
    p, li { line-height: 1.68; }
    .lead { color: #46546c; font-size: 17px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
    .card { background: white; border: 1px solid #dfe6f2; border-radius: 8px; padding: 14px; box-shadow: 0 8px 20px rgba(25, 40, 75, .05); }
    .card span { display: block; color: #66738a; font-size: 12px; }
    .card strong { display: block; margin-top: 8px; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; background: white; margin: 14px 0 22px; }
    th, td { border: 1px solid #dfe6f2; padding: 9px 10px; text-align: left; vertical-align: top; }
    th { background: #eef3fb; }
    .ok { color: #0f766e; font-weight: 700; }
    .bad { color: #b42318; font-weight: 700; }
    .panel { background: white; border: 1px solid #dfe6f2; border-radius: 8px; padding: 16px; margin: 16px 0; }
    code, pre { background: #eef2f7; border-radius: 6px; }
    code { padding: 2px 5px; }
    pre { padding: 14px; overflow: auto; }
    svg { width: 100%; height: auto; background: white; }
    .axis { stroke: #6f7d94; stroke-width: 1; }
    .gridline, .grid { stroke: #e5ebf5; stroke-width: 1; }
    .chart-title { font-weight: 700; font-size: 15px; fill: #172033; }
    text { font-size: 12px; fill: #34425d; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } main { padding: 22px 14px 48px; } }
  </style>
</head>
<body>
<main>
  <h1>实验 1 内部状态可信性审计</h1>
  <p class="lead">本页专门解决公开数据无法直接验证卫星 CPU、电池、队列、缓存等内部状态的问题。它不声称获得运营商内部真值，而是用可复算公式、物理边界和输入响应关系证明这些潜变量不是随机填充。</p>
  <section class="grid">
    <div class="card"><span>内部状态可信性分数</span><strong>${summary.internal_plausibility_score}</strong></div>
    <div class="card"><span>通过检查项</span><strong>${summary.passed_count}/${summary.check_count}</strong></div>
    <div class="card"><span>电池容量推断</span><strong>${summary.inferred_battery_capacity_wh} Wh</strong></div>
    <div class="card"><span>太阳翼峰值发电</span><strong>${summary.inferred_solar_peak_power_w} W</strong></div>
  </section>

  <h2>证据边界</h2>
  <p>外部公开数据能较强约束 TLE/SGP4 轨道、壳层分布、Cloudflare Radar 业务时序和 RIPE Atlas 用户侧 RTT。CPU、电量、队列长度、缓存、星上负载这类内部状态没有公开逐星真值，因此本审计采用“公式一致性 + 物理边界 + 业务响应 + 拓扑约束”的方式补强证据链。</p>

  <h2>核心公式</h2>
  <pre>cpu = clip(compute_cpu + task_traffic_cpu + forwarding_cpu + queue_cpu, 0, 100)
P_solar = solar_exposure * I_sun * A_sa * eta_sa
P_net = eta_ch * max(P_solar - P_load, 0) - max(P_load - P_solar, 0) / eta_dis
E(t+dt) = clip(E(t) + P_net * dt, E_min, E_bat,max)
queue_latency_ms = queued_MB * 8 * 1000 / effective_capacity_Mbps
route_latency = sum(link_latency on path)</pre>

  <h2>逐时间片响应</h2>
  <div class="panel">${lineChart(sliceSeries, [
    { id: "total_route_traffic_mbps", label: "业务输入", color: "#2563eb" },
    { id: "avg_cpu_percent", label: "平均 CPU", color: "#dc2626" },
    { id: "avg_solar_exposure", label: "平均光照", color: "#f59e0b" },
    { id: "avg_net_power_w", label: "平均净功率", color: "#16a34a" },
  ], { title: "归一化时间片响应：业务、CPU、光照与能量" })}</div>

  <h2>检查项</h2>
  <table>
    <thead><tr><th>ID</th><th>类别</th><th>检查内容</th><th>结果</th><th>指标</th><th>阈值</th><th>样本</th><th>违规</th></tr></thead>
    <tbody>${checkTable(checks)}</tbody>
  </table>

  <h2>实验规模</h2>
  <table><tbody>
    <tr><th>时间片数</th><td>${metadata.slice_count}</td><th>节点数</th><td>${metadata.node_count}</td></tr>
    <tr><th>单片链路数</th><td>${metadata.link_count}</td><th>输入任务数</th><td>${metadata.dataset_task_count}</td></tr>
    <tr><th>路由任务数</th><td>${metadata.dataset_routed_task_count}</td><th>数据指纹</th><td>${escapeHtml(metadata.truth_fingerprint)}</td></tr>
  </tbody></table>

  <h2>结论口径</h2>
  <p>通过该审计后，可以说：实验 1 的内部节点状态和链路状态满足模型公式、物理边界和业务响应约束，适合作为 INT/INT-MC 遥测算法评估的仿真真值。仍不能说：这些 CPU、电池和队列数值就是 Starlink 运营商内部遥测的逐点真值。</p>
</main>
</body>
</html>`;
}

const args = process.argv.slice(2);
const outDir = resolve(argValue(args, "--out", DEFAULT_OUT_DIR));
const truthDir = resolve(argValue(args, "--truth-dir", join(outDir, "stage1-truth")));

const requiredFiles = ["metadata.json", "nodes.csv", "links.csv", "routes.csv"].map((file) => join(truthDir, file));
for (const file of requiredFiles) {
  if (!existsSync(file)) throw new Error(`Required experiment-1 truth file not found: ${file}`);
}

const [metadata, nodeRows, linkRows, routeRows] = await Promise.all([
  readJson(join(truthDir, "metadata.json")),
  readCsv(join(truthDir, "nodes.csv")),
  readCsv(join(truthDir, "links.csv")),
  readCsv(join(truthDir, "routes.csv")),
]);

const batteryCapacityWh = estimateBatteryCapacityWh(nodeRows);
const stepMinutes = estimateStepMinutes(nodeRows, metadata);
const solarPeakPowerW = inferSolarPeakPowerW(nodeRows);
const minSoc = DEFAULT_MIN_SOC;
const sliceSeries = buildSliceSeries(nodeRows, linkRows, routeRows);
const checks = [
  ...checkRowCount(nodeRows, linkRows, routeRows, metadata),
  ...checkCpu(nodeRows),
  ...checkEnergy(nodeRows, { batteryCapacityWh, minSoc, stepMinutes, solarPeakPowerW }),
  ...checkLinksAndRoutes(linkRows, routeRows),
  ...checkSystemResponses(sliceSeries, nodeRows, linkRows),
];

const hardChecks = checks.filter((check) => check.severity === "hard");
const passedCount = checks.filter((check) => check.passed).length;
const hardPassedCount = hardChecks.filter((check) => check.passed).length;
const summary = {
  generated_at: new Date().toISOString(),
  schema: "int-telemetry-experiment1-internal-plausibility/v1",
  out_dir: rel(outDir),
  truth_dir: rel(truthDir),
  check_count: checks.length,
  passed_count: passedCount,
  failed_count: checks.length - passedCount,
  hard_check_count: hardChecks.length,
  hard_passed_count: hardPassedCount,
  hard_pass_ratio: round(hardPassedCount / Math.max(1, hardChecks.length), 6),
  internal_plausibility_score: round(passedCount / Math.max(1, checks.length), 6),
  inferred_battery_capacity_wh: round(batteryCapacityWh, 3),
  min_state_of_charge: minSoc,
  inferred_solar_peak_power_w: round(solarPeakPowerW, 3),
  step_minutes: round(stepMinutes, 4),
  external_unobservable_fields: [
    "cpu_percent",
    "energy_wh",
    "state_of_charge",
    "queue_depth",
    "queued_traffic_mb",
    "telemetry_buffer_mb",
    "cache_used_mb",
  ],
  interpretation:
    "These checks validate latent internal states by formula consistency, bounds, topology constraints, and input response. They do not claim operator-internal ground truth.",
};

const outputs = {
  json: rel(join(outDir, "experiment1-internal-state-plausibility.json")),
  md: rel(join(outDir, "experiment1-internal-state-plausibility.md")),
  html: rel(join(outDir, "experiment1-internal-state-plausibility.html")),
  checks_csv: rel(join(outDir, "experiment1-internal-state-checks.csv")),
  timeseries_csv: rel(join(outDir, "experiment1-internal-state-timeseries.csv")),
};

const report = {
  ...summary,
  metadata: {
    simulation_mode: metadata.simulation_mode,
    orbit_model: metadata.orbit_model,
    routing_algorithm: metadata.routing_algorithm,
    dataset_name: metadata.dataset_name,
    dataset_fingerprint: metadata.dataset_fingerprint,
    truth_fingerprint: metadata.truth_fingerprint,
    slice_count: metadata.slice_count,
    node_count: metadata.node_count,
    link_count: metadata.link_count,
    dataset_task_count: metadata.dataset_task_count,
    dataset_routed_task_count: metadata.dataset_routed_task_count,
  },
  checks,
  slice_series: sliceSeries,
  outputs,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "experiment1-internal-state-plausibility.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(join(outDir, "experiment1-internal-state-plausibility.md"), writeMarkdown({ outDir, metadata, summary, checks, outputs }), "utf8");
await writeFile(join(outDir, "experiment1-internal-state-plausibility.html"), writeHtml({ outDir, metadata, summary, checks, sliceSeries }), "utf8");
await writeCsv(
  join(outDir, "experiment1-internal-state-checks.csv"),
  checks.map((check) => ({
    id: check.id,
    category: check.category,
    label: check.label,
    severity: check.severity,
    passed: check.passed,
    metric: check.metric,
    threshold: check.threshold,
    checked: check.checked,
    violations: check.violations,
    pass_ratio: check.pass_ratio,
    note: check.note,
  })),
);
await writeCsv(join(outDir, "experiment1-internal-state-timeseries.csv"), sliceSeries);

console.log(
  JSON.stringify(
    {
      ok: true,
      schema: summary.schema,
      summary,
      outputs,
      failed_checks: checks.filter((check) => !check.passed).map((check) => check.id),
    },
    null,
    2,
  ),
);
