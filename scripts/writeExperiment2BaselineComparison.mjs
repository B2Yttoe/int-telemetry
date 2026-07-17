import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const PROFILES = [
  { id: "iridium-next-small", label: "Iridium 66", fullLabel: "Iridium NEXT 6x11", scale: "small" },
  { id: "telesat-1015-medium", label: "Telesat 351", fullLabel: "Telesat-1015 27x13", scale: "medium" },
  { id: "starlink-main-large", label: "Starlink 1584", fullLabel: "Starlink main shell 72x22", scale: "large" },
];

const METHOD_ORDER = [
  "traffic-int",
  "full-probe-int",
  "shortest-path-probe",
  "random-sampling-aggregate",
  "int-mc-selected-probe",
  "leo-int-mc-enhanced",
];

const METHOD_LABELS = {
  "traffic-int": "业务流 INT",
  "full-probe-int": "全量探测 INT",
  "shortest-path-probe": "最短路径探测",
  "random-sampling-aggregate": "随机采样",
  "int-mc-selected-probe": "原生 INT-MC",
  "leo-int-mc-enhanced": "增强 LEO-INT-MC",
};

Object.assign(METHOD_LABELS, {
  "traffic-int": "\u4e1a\u52a1\u6d41 INT",
  "full-probe-int": "\u5168\u91cf\u63a2\u6d4b INT",
  "shortest-path-probe": "\u6700\u77ed\u8def\u5f84\u63a2\u6d4b",
  "random-sampling-aggregate": "\u968f\u673a\u91c7\u6837",
  "int-mc-selected-probe": "\u539f\u751f INT-MC",
  "leo-int-mc-enhanced": "\u589e\u5f3a LEO-INT-MC",
});

const METHOD_COLORS = {
  "traffic-int": "#0f766e",
  "full-probe-int": "#2563eb",
  "shortest-path-probe": "#9333ea",
  "random-sampling-aggregate": "#f59e0b",
  "int-mc-selected-probe": "#64748b",
  "leo-int-mc-enhanced": "#dc2626",
};

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
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

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

async function readCsv(path) {
  if (!existsSync(path)) return [];
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function numberValue(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : NaN;
}

function std(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length <= 1) return NaN;
  const avg = mean(usable);
  return Math.sqrt(mean(usable.map((value) => (value - avg) ** 2)));
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

function indexBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => map.set(keyFn(row), row));
  return map;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function methodLabel(methodId) {
  return METHOD_LABELS[methodId] ?? methodId;
}

function nativeMethodNotes(methodId) {
  const notes = {
    "traffic-int": "\u53ea\u6cbf\u4e1a\u52a1\u6d41\u8def\u5f84\u91c7\u96c6\uff0c\u5f00\u9500\u4f4e\uff0c\u4f46\u8986\u76d6\u4f9d\u8d56\u4e1a\u52a1\u5206\u5e03\u3002",
    "full-probe-int": "\u4e3b\u52a8\u63a2\u6d4b\u5168\u7f51\uff0c\u4f5c\u4e3a\u9ad8\u8986\u76d6\u4e0a\u754c\u3002",
    "shortest-path-probe": "\u4f7f\u7528\u6700\u77ed\u8def\u5f84\u964d\u4f4e\u63a2\u6d4b\u6210\u672c\uff0c\u4f46\u5bb9\u6613\u91cd\u590d\u8986\u76d6\u5c40\u90e8\u533a\u57df\u3002",
    "random-sampling-aggregate": "\u968f\u673a\u9009\u62e9\u63a2\u6d4b\u8def\u5f84\uff0c\u4f5c\u4e3a\u7a33\u5b9a\u6027\u8f83\u5f31\u7684\u5bf9\u7167\u57fa\u7ebf\u3002",
  };
  return notes[methodId] ?? "";
}

function normalizeDisplayFields(rows) {
  rows.forEach((row) => {
    row.method_label = methodLabel(row.method_id);
    if (row.method_group === "native-int-baseline") {
      row.notes = nativeMethodNotes(row.method_id);
    }
  });
  return rows;
}

function profileLabel(profileId) {
  return PROFILES.find((profile) => profile.id === profileId)?.label ?? profileId;
}

function profileSort(left, right) {
  return PROFILES.findIndex((profile) => profile.id === left.constellation_profile_id) -
    PROFILES.findIndex((profile) => profile.id === right.constellation_profile_id);
}

function methodSort(left, right) {
  return METHOD_ORDER.indexOf(left.method_id) - METHOD_ORDER.indexOf(right.method_id);
}

function formatPercent(value, digits = 2) {
  const number = numberValue(value, NaN);
  return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "-";
}

function formatNumber(value, digits = 3) {
  const number = numberValue(value, NaN);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function formatBytes(value) {
  const bytes = numberValue(value, NaN);
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes.toFixed(1)} B`;
}

function metricValue(primary, fallback = "") {
  const parsed = finiteNumber(primary);
  return parsed === null ? fallback : parsed;
}

function nativeRow({ row, detail }) {
  const methodId = row.method_id;
  return {
    constellation_profile_id: row.constellation_profile_id,
    constellation_short_label: row.constellation_short_label || profileLabel(row.constellation_profile_id),
    scale: row.scale,
    method_id: methodId,
    method_label: methodLabel(methodId),
    method_group: "native-int-baseline",
    source: "experiment2-native-baseline-rerun-final",
    slice_count: metricValue(row.slice_count),
    nodes_per_slice: metricValue(row.nodes_per_slice),
    node_sample_coverage: metricValue(detail.node_sample_coverage, metricValue(row.node_sample_coverage)),
    active_link_direct_coverage: metricValue(detail.active_link_direct_coverage, metricValue(row.active_link_direct_coverage)),
    active_link_effective_coverage: metricValue(detail.active_link_effective_coverage, metricValue(row.active_link_effective_coverage)),
    coverage_gain_from_inference: 0,
    int_mc_inferred_rate_on_active: "",
    utilization_inferred_mae: "",
    utilization_inferred_rmse: "",
    utilization_inferred_p95_ae: "",
    utilization_inferred_within_10_units_rate: "",
    utilization_inferred_high_f1: "",
    latency_inferred_mae_ms: "",
    cpu_mae: metricValue(detail.cpu_mae, ""),
    queue_depth_mae: metricValue(detail.queue_depth_mae, ""),
    energy_percent_mae: metricValue(detail.energy_percent_mae, ""),
    node_mode_accuracy: metricValue(detail.node_mode_accuracy, ""),
    link_status_accuracy: metricValue(detail.link_status_accuracy, ""),
    link_utilization_mae: metricValue(detail.link_utilization_mae, ""),
    link_latency_mae_ms: metricValue(detail.link_latency_mae_ms, ""),
    congestion_recall_global: metricValue(detail.congestion_recall_global, ""),
    total_telemetry_generated_bytes: metricValue(row.total_telemetry_generated_bytes),
    telemetry_bytes_per_slice: metricValue(row.telemetry_bytes_per_slice),
    telemetry_bytes_per_node_slice: metricValue(row.telemetry_bytes_per_node_slice),
    total_telemetry_energy_j: metricValue(row.total_telemetry_energy_j),
    telemetry_energy_j_per_slice: metricValue(row.telemetry_energy_j_per_slice),
    hop_records: metricValue(row.hop_records),
    selected_paths: "",
    notes: methodId === "traffic-int"
      ? "只沿业务路径采集，开销低但覆盖依赖业务分布。"
      : methodId === "full-probe-int"
        ? "主动探测全网，是高覆盖上界。"
        : methodId === "shortest-path-probe"
          ? "使用短路径降低探测成本，但容易重复覆盖局部区域。"
          : "随机选择探测路径，是稳定性较弱的对照基线。",
  };
}

function splitPath(value) {
  return String(value || "").split(/\s+>\s+/).map((item) => item.trim()).filter(Boolean);
}

function boolValue(value) {
  return String(value).toLowerCase() === "true";
}

function intMcPerSliceRows({ profile, groundDir, stage2Dir, methodId }) {
  return async () => {
    const links = await readCsv(join(groundDir, "ground-mc-reconstructed-links.csv"));
    const nodes = await readCsv(join(groundDir, "ground-mc-reconstructed-nodes.csv"));
    const probeSummary = await readCsv(join(stage2Dir, "probe-summary-int-mc.csv"));
    const hopRows = await readCsv(join(stage2Dir, "probe-int-hop-records-int-mc.csv"));
    const linksBySlice = groupBy(links, (row) => String(row.slice_index));
    const nodesBySlice = groupBy(nodes, (row) => String(row.slice_index));
    const probeBySlice = new Map(probeSummary.map((row) => [String(row.slice_index), row]));
    const hopsBySlice = groupBy(hopRows, (row) => String(row.slice_index));
    const sliceIndexes = [...new Set([...linksBySlice.keys(), ...nodesBySlice.keys(), ...probeBySlice.keys()])]
      .sort((left, right) => Number(left) - Number(right));
    return sliceIndexes.map((sliceIndex) => {
      const linkRows = linksBySlice.get(sliceIndex) ?? [];
      const nodeRows = nodesBySlice.get(sliceIndex) ?? [];
      const activeLinks = linkRows.filter((row) => row.contact_state === "active");
      const observedActive = activeLinks.filter((row) => boolValue(row.observed));
      const inferredActive = activeLinks.filter((row) => boolValue(row.inferred));
      const observedNodes = nodeRows.filter((row) => boolValue(row.observed));
      const inferredNodes = nodeRows.filter((row) => boolValue(row.inferred));
      const probe = probeBySlice.get(sliceIndex) ?? {};
      return {
        constellation_profile_id: profile.id,
        constellation_short_label: profile.label,
        scale: profile.scale,
        method_id: methodId,
        method_label: methodLabel(methodId),
        slice_index: Number(sliceIndex),
        time: activeLinks[0]?.time ?? nodeRows[0]?.time ?? "",
        truth_nodes: nodeRows.length,
        observed_nodes: observedNodes.length,
        node_coverage: round(observedNodes.length / Math.max(nodeRows.length, 1)),
        node_effective_coverage: round((observedNodes.length + inferredNodes.length) / Math.max(nodeRows.length, 1)),
        truth_active_links: activeLinks.length,
        observed_active_links: observedActive.length,
        completed_active_links: observedActive.length + inferredActive.length,
        inferred_active_links: inferredActive.length,
        active_link_direct_coverage: round(observedActive.length / Math.max(activeLinks.length, 1)),
        active_link_effective_coverage: round((observedActive.length + inferredActive.length) / Math.max(activeLinks.length, 1)),
        total_telemetry_generated_bytes: metricValue(probe.estimated_generated_telemetry_bytes, ""),
        total_telemetry_energy_j: metricValue(probe.estimated_total_telemetry_energy_j, ""),
        hop_records: (hopsBySlice.get(sliceIndex) ?? []).length,
      };
    });
  };
}

async function intMcRows({ enhancedRoot, comparisonRows, version, methodId, groundFolder, stage2Folder, methodGroup }) {
  const rows = [];
  const perSlice = [];
  for (const profile of PROFILES) {
    const comparison = comparisonRows.find((row) => row.constellation_profile_id === profile.id && row.version === version);
    if (!comparison) continue;
    const groundDir = join(enhancedRoot, profile.id, "ground-oam", groundFolder);
    const stage2Dir = join(enhancedRoot, profile.id, "stage2", stage2Folder);
    const evaluation = await readJson(join(groundDir, "int-mc-evaluation.json"));
    const sliceRows = await intMcPerSliceRows({ profile, groundDir, stage2Dir, methodId })();
    perSlice.push(...sliceRows);
    const utilization = evaluation.metrics?.utilization_percent ?? {};
    const latency = evaluation.metrics?.latency_ms ?? {};
    const cpu = evaluation.node_reconstruction?.metrics?.cpu_percent ?? {};
    const queue = evaluation.node_reconstruction?.metrics?.queue_depth ?? {};
    const energy = evaluation.node_reconstruction?.metrics?.energy_percent ?? {};
    rows.push({
      constellation_profile_id: profile.id,
      constellation_short_label: profile.label,
      scale: profile.scale,
      method_id: methodId,
      method_label: methodLabel(methodId),
      method_group: methodGroup,
      source: version === "before" ? "current-rerun-original-int-mc" : "current-enhanced-leo-int-mc",
      slice_count: metricValue(comparison.slice_count),
      nodes_per_slice: metricValue(comparison.nodes_per_slice),
      node_sample_coverage: metricValue(evaluation.node_reconstruction?.node_completion_coverage, 1),
      active_link_direct_coverage: metricValue(comparison.active_link_direct_coverage),
      active_link_effective_coverage: metricValue(comparison.active_link_effective_coverage),
      coverage_gain_from_inference: round(metricValue(comparison.active_link_effective_coverage, 0) - metricValue(comparison.active_link_direct_coverage, 0)),
      int_mc_inferred_rate_on_active: metricValue(comparison.int_mc_inferred_rate_on_active),
      utilization_inferred_mae: metricValue(comparison.utilization_inferred_mae),
      utilization_inferred_rmse: metricValue(comparison.utilization_inferred_rmse),
      utilization_inferred_p95_ae: metricValue(comparison.utilization_inferred_p95_ae),
      utilization_inferred_within_10_units_rate: metricValue(comparison.utilization_inferred_within_10_units_rate),
      utilization_inferred_high_f1: metricValue(comparison.utilization_inferred_high_f1, ""),
      latency_inferred_mae_ms: metricValue(comparison.latency_inferred_mae_ms),
      cpu_mae: metricValue(cpu.mae),
      queue_depth_mae: metricValue(queue.mae),
      energy_percent_mae: metricValue(energy.mae),
      node_mode_accuracy: metricValue(evaluation.node_reconstruction?.mode_accuracy_all_nodes),
      link_status_accuracy: metricValue(evaluation.reconstruction?.status_accuracy_all_links),
      link_utilization_mae: metricValue(utilization.mae),
      link_latency_mae_ms: metricValue(latency.mae),
      congestion_recall_global: metricValue(evaluation.metrics?.congestion_percent?.high_recall, ""),
      total_telemetry_generated_bytes: metricValue(comparison.total_telemetry_generated_bytes),
      telemetry_bytes_per_slice: round(metricValue(comparison.total_telemetry_generated_bytes, 0) / Math.max(metricValue(comparison.slice_count, 1), 1), 0),
      telemetry_bytes_per_node_slice: metricValue(comparison.telemetry_bytes_per_node_slice),
      total_telemetry_energy_j: metricValue(comparison.total_telemetry_energy_j),
      telemetry_energy_j_per_slice: round(metricValue(comparison.total_telemetry_energy_j, 0) / Math.max(metricValue(comparison.slice_count, 1), 1)),
      hop_records: metricValue(comparison.hop_records),
      selected_paths: metricValue(comparison.selected_paths),
      notes: version === "before"
        ? "原生 INT-MC 在当前 48 时间片数据上的重跑结果。"
        : "加入 LEO 时空先验、OAM 反馈、节点状态耦合和自适应 metadata 的增强方案。",
    });
  }
  return { rows, perSlice };
}

function stabilityRows(rows, perSliceRows) {
  const fullProbeByProfile = new Map(
    rows
      .filter((row) => row.method_id === "full-probe-int")
      .map((row) => [row.constellation_profile_id, metricValue(row.telemetry_bytes_per_node_slice)]),
  );
  const perSliceByMethod = groupBy(perSliceRows, (row) => `${row.constellation_profile_id}|${row.method_id}`);
  return rows.map((row) => {
    const sliceRows = perSliceByMethod.get(`${row.constellation_profile_id}|${row.method_id}`) ?? [];
    const direct = sliceRows.map((item) => numberValue(item.active_link_direct_coverage, NaN)).filter(Number.isFinite);
    const effective = sliceRows.map((item) => numberValue(item.active_link_effective_coverage, NaN)).filter(Number.isFinite);
    const node = sliceRows.map((item) => numberValue(item.node_coverage, NaN)).filter(Number.isFinite);
    const bytesPerNodeSlice = metricValue(row.telemetry_bytes_per_node_slice);
    const fullProbeBytes = fullProbeByProfile.get(row.constellation_profile_id);
    const effectiveCoverage = metricValue(row.active_link_effective_coverage);
    const directCoverage = metricValue(row.active_link_direct_coverage);
    return {
      ...row,
      active_link_direct_coverage_min: round(Math.min(...direct)),
      active_link_direct_coverage_std: round(std(direct)),
      active_link_effective_coverage_min: round(Math.min(...effective)),
      active_link_effective_coverage_std: round(std(effective)),
      node_sample_coverage_std: round(std(node)),
      telemetry_overhead_vs_full_probe: Number.isFinite(bytesPerNodeSlice) && Number.isFinite(fullProbeBytes) && fullProbeBytes > 0
        ? round(bytesPerNodeSlice / fullProbeBytes)
        : "",
      telemetry_saving_vs_full_probe: Number.isFinite(bytesPerNodeSlice) && Number.isFinite(fullProbeBytes) && fullProbeBytes > 0
        ? round(1 - bytesPerNodeSlice / fullProbeBytes)
        : "",
      effective_coverage_per_kb_per_node_slice: Number.isFinite(effectiveCoverage) && Number.isFinite(bytesPerNodeSlice) && bytesPerNodeSlice > 0
        ? round(effectiveCoverage / (bytesPerNodeSlice / 1024))
        : "",
      direct_to_effective_gap: Number.isFinite(effectiveCoverage) && Number.isFinite(directCoverage)
        ? round(effectiveCoverage - directCoverage)
        : "",
    };
  });
}

function conclusionRows(rows) {
  return PROFILES.map((profile) => {
    const profileRows = rows.filter((row) => row.constellation_profile_id === profile.id);
    const traffic = profileRows.find((row) => row.method_id === "traffic-int") ?? {};
    const full = profileRows.find((row) => row.method_id === "full-probe-int") ?? {};
    const random = profileRows.find((row) => row.method_id === "random-sampling-aggregate") ?? {};
    const original = profileRows.find((row) => row.method_id === "int-mc-selected-probe") ?? {};
    const enhanced = profileRows.find((row) => row.method_id === "leo-int-mc-enhanced") ?? {};
    const enhancedUtilDelta = metricValue(enhanced.utilization_inferred_mae, NaN) - metricValue(original.utilization_inferred_mae, NaN);
    const enhancedByteDelta = metricValue(enhanced.telemetry_bytes_per_node_slice, NaN) - metricValue(original.telemetry_bytes_per_node_slice, NaN);
    return {
      profile_id: profile.id,
      profile: profile.label,
      traffic_direct_coverage: metricValue(traffic.active_link_direct_coverage),
      traffic_bytes_per_node_slice: metricValue(traffic.telemetry_bytes_per_node_slice),
      random_direct_coverage: metricValue(random.active_link_direct_coverage),
      random_coverage_std: metricValue(random.active_link_direct_coverage_std),
      full_probe_direct_coverage: metricValue(full.active_link_direct_coverage),
      full_probe_bytes_per_node_slice: metricValue(full.telemetry_bytes_per_node_slice),
      original_int_mc_direct_coverage: metricValue(original.active_link_direct_coverage),
      original_int_mc_mae: metricValue(original.utilization_inferred_mae),
      original_bytes_per_node_slice: metricValue(original.telemetry_bytes_per_node_slice),
      enhanced_direct_coverage: metricValue(enhanced.active_link_direct_coverage),
      enhanced_effective_coverage: metricValue(enhanced.active_link_effective_coverage),
      enhanced_int_mc_mae: metricValue(enhanced.utilization_inferred_mae),
      enhanced_bytes_per_node_slice: metricValue(enhanced.telemetry_bytes_per_node_slice),
      enhanced_vs_full_probe_overhead: metricValue(enhanced.telemetry_overhead_vs_full_probe),
      enhanced_vs_original_mae_delta: round(enhancedUtilDelta),
      enhanced_vs_original_byte_delta: round(enhancedByteDelta),
      enhanced_cpu_mae: metricValue(enhanced.cpu_mae),
      enhanced_queue_mae: metricValue(enhanced.queue_depth_mae),
      enhanced_energy_mae: metricValue(enhanced.energy_percent_mae),
      conclusion: enhancedUtilDelta <= 0 && enhancedByteDelta <= 0
        ? "增强版同时降低利用率补全误差和遥测开销。"
        : enhancedUtilDelta <= 0
          ? "增强版降低补全误差，但遥测开销接近或略高于原生。"
          : "增强版改善节点状态和覆盖/开销折中，但利用率补全存在轻微代价。",
    };
  });
}

function chartScale(values, { minZero = true, log = false } = {}) {
  const usable = values.filter(Number.isFinite).filter((value) => !log || value > 0);
  if (usable.length === 0) return { min: 0, max: 1 };
  if (log) {
    return { min: Math.log10(Math.min(...usable) * 0.85), max: Math.log10(Math.max(...usable) * 1.15) };
  }
  const min = minZero ? 0 : Math.min(...usable);
  const max = Math.max(...usable);
  return { min, max: max === min ? max + 1 : max * 1.08 };
}

function svgGroupedBars({ rows, field, title, formatter = formatNumber, maxValue = null, width = 1120, height = 370 }) {
  const margin = { top: 44, right: 24, bottom: 92, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  const max = maxValue ?? Math.max(1e-9, ...values) * 1.08;
  const groupWidth = plotWidth / PROFILES.length;
  const barWidth = Math.max(10, Math.min(24, groupWidth / (METHOD_ORDER.length + 2)));
  const y = (value) => margin.top + plotHeight - (numberValue(value, 0) / max) * plotHeight;
  const bars = PROFILES.flatMap((profile, profileIndex) =>
    METHOD_ORDER.map((methodId, methodIndex) => {
      const row = rows.find((item) => item.constellation_profile_id === profile.id && item.method_id === methodId);
      const value = numberValue(row?.[field], NaN);
      if (!Number.isFinite(value)) return "";
      const x = margin.left + profileIndex * groupWidth + groupWidth / 2 - (METHOD_ORDER.length * barWidth) / 2 + methodIndex * barWidth;
      const top = y(value);
      return `<rect x="${x}" y="${top}" width="${barWidth - 2}" height="${Math.max(0, margin.top + plotHeight - top)}" rx="2" fill="${METHOD_COLORS[methodId]}"><title>${escapeHtml(profile.label)} / ${escapeHtml(methodLabel(methodId))}: ${escapeHtml(formatter(value))}</title></rect>`;
    }),
  ).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = max * ratio;
    const tickY = margin.top + plotHeight - ratio * plotHeight;
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(formatter(value))}</text>`;
  }).join("");
  const labels = PROFILES.map((profile, index) =>
    `<text x="${margin.left + index * groupWidth + groupWidth / 2}" y="${height - 50}" text-anchor="middle" font-size="12">${escapeHtml(profile.label)}</text>`,
  ).join("");
  const legend = METHOD_ORDER.map((methodId, index) => {
    const x = margin.left + (index % 3) * 280;
    const yLegend = height - 28 + Math.floor(index / 3) * 16;
    return `<rect x="${x}" y="${yLegend - 10}" width="10" height="10" fill="${METHOD_COLORS[methodId]}"></rect><text x="${x + 15}" y="${yLegend}" font-size="12">${escapeHtml(methodLabel(methodId))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">${escapeHtml(title)}</text>
    ${ticks}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    ${bars}
    ${labels}
    ${legend}
  </svg>`;
}

function svgCoverageCostScatter({ rows, yField, title, yFormatter = formatPercent, width = 1120, height = 430 }) {
  const margin = { top: 48, right: 34, bottom: 82, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = rows
    .map((row) => ({
      row,
      x: numberValue(row.telemetry_bytes_per_node_slice, NaN),
      y: numberValue(row[yField], NaN),
    }))
    .filter((point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y));
  const xScale = chartScale(points.map((point) => point.x), { log: true });
  const yMax = Math.max(1, ...points.map((point) => point.y)) * 1.03;
  const x = (value) => margin.left + ((Math.log10(value) - xScale.min) / Math.max(xScale.max - xScale.min, 1e-9)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const ticksX = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
    .filter((value) => Math.log10(value) >= xScale.min && Math.log10(value) <= xScale.max)
    .map((value) => {
      const tickX = x(value);
      return `<line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#edf2f7"></line><text x="${tickX}" y="${height - 48}" text-anchor="middle" font-size="11">${escapeHtml(formatBytes(value))}</text>`;
    }).join("");
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const tickY = y(ratio);
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(yFormatter(ratio))}</text>`;
  }).join("");
  const profileYOffset = new Map(PROFILES.map((profile, index) => [profile.id, (index - 1) * 7]));
  const circles = points.map((point) => {
    const row = point.row;
    const cx = x(point.x);
    const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="${METHOD_COLORS[row.method_id] ?? "#334155"}" opacity="0.88" stroke="#fff" stroke-width="1.5"><title>${escapeHtml(row.constellation_short_label)} / ${escapeHtml(row.method_label)}\n开销: ${escapeHtml(formatBytes(point.x))}/节点/片\n覆盖率: ${escapeHtml(yFormatter(point.y))}</title></circle>`;
  }).join("");
  const labels = points
    .filter((point) => ["traffic-int", "full-probe-int", "int-mc-selected-probe", "leo-int-mc-enhanced"].includes(point.row.method_id))
    .map((point) => {
      const row = point.row;
      const cx = x(point.x);
      const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
      return `<text x="${cx + 8}" y="${cy + 4}" font-size="10" fill="#334155">${escapeHtml(row.constellation_short_label.replace(" ", ""))}/${escapeHtml(methodLabel(row.method_id).replace(" INT", ""))}</text>`;
    }).join("");
  const legend = METHOD_ORDER.map((methodId, index) => {
    const xLegend = margin.left + (index % 3) * 275;
    const yLegend = height - 24 + Math.floor(index / 3) * 16;
    return `<circle cx="${xLegend}" cy="${yLegend - 4}" r="5" fill="${METHOD_COLORS[methodId]}"></circle><text x="${xLegend + 12}" y="${yLegend}" font-size="12">${escapeHtml(methodLabel(methodId))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">${escapeHtml(title)}</text>
    <text x="${margin.left}" y="41" font-size="12" fill="#64748b">横轴为遥测开销，采用对数刻度；越靠左上越优。</text>
    ${ticksX}
    ${ticksY}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    ${circles}
    ${labels}
    ${legend}
  </svg>`;
}

function svgCostErrorScatter({ rows, yField, title, yFormatter = (value) => formatNumber(value, 3), width = 1120, height = 430 }) {
  const margin = { top: 48, right: 34, bottom: 82, left: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = rows
    .map((row) => ({
      row,
      x: numberValue(row.telemetry_bytes_per_node_slice, NaN),
      y: numberValue(row[yField], NaN),
    }))
    .filter((point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y));
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="32" y="42" font-size="16" font-weight="700">${escapeHtml(title)}</text><text x="32" y="72" fill="#64748b">该指标没有可绘制数据。</text></svg>`;
  }
  const xScale = chartScale(points.map((point) => point.x), { log: true });
  const yMax = Math.max(0.001, ...points.map((point) => point.y)) * 1.12;
  const x = (value) => margin.left + ((Math.log10(value) - xScale.min) / Math.max(xScale.max - xScale.min, 1e-9)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const ticksX = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
    .filter((value) => Math.log10(value) >= xScale.min && Math.log10(value) <= xScale.max)
    .map((value) => {
      const tickX = x(value);
      return `<line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#edf2f7"></line><text x="${tickX}" y="${height - 48}" text-anchor="middle" font-size="11">${escapeHtml(formatBytes(value))}</text>`;
    }).join("");
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = yMax * ratio;
    const tickY = y(value);
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(yFormatter(value))}</text>`;
  }).join("");
  const profileYOffset = new Map(PROFILES.map((profile, index) => [profile.id, (index - 1) * 7]));
  const circles = points.map((point) => {
    const row = point.row;
    const cx = x(point.x);
    const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="${METHOD_COLORS[row.method_id] ?? "#334155"}" opacity="0.88" stroke="#fff" stroke-width="1.5"><title>${escapeHtml(row.constellation_short_label)} / ${escapeHtml(row.method_label)}\n开销: ${escapeHtml(formatBytes(point.x))}/节点/片\n误差: ${escapeHtml(yFormatter(point.y))}</title></circle>`;
  }).join("");
  const labels = points
    .filter((point) => ["int-mc-selected-probe", "leo-int-mc-enhanced"].includes(point.row.method_id))
    .map((point) => {
      const row = point.row;
      const cx = x(point.x);
      const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
      return `<text x="${cx + 8}" y="${cy + 4}" font-size="10" fill="#334155">${escapeHtml(row.constellation_short_label.replace(" ", ""))}/${escapeHtml(methodLabel(row.method_id).replace(" INT", ""))}</text>`;
    }).join("");
  const legend = METHOD_ORDER.map((methodId, index) => {
    const xLegend = margin.left + (index % 3) * 275;
    const yLegend = height - 24 + Math.floor(index / 3) * 16;
    return `<circle cx="${xLegend}" cy="${yLegend - 4}" r="5" fill="${METHOD_COLORS[methodId]}"></circle><text x="${xLegend + 12}" y="${yLegend}" font-size="12">${escapeHtml(methodLabel(methodId))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">${escapeHtml(title)}</text>
    <text x="${margin.left}" y="41" font-size="12" fill="#64748b">横轴为遥测开销，对数刻度；纵轴为误差，越靠左下越优。</text>
    ${ticksX}
    ${ticksY}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    ${circles}
    ${labels}
    ${legend}
  </svg>`;
}

function metricHtml(row, field, { percent = false, digits = 4, completion = false } = {}) {
  const value = numberValue(row[field], NaN);
  if (!Number.isFinite(value)) {
    if (completion && row.method_group === "native-int-baseline") return '<span class="na">不适用</span>';
    return '<span class="missing">未记录</span>';
  }
  return percent ? formatPercent(value) : formatNumber(value, digits);
}

function metricMarkdown(row, field, { percent = false, digits = 4, completion = false } = {}) {
  const value = numberValue(row[field], NaN);
  if (!Number.isFinite(value)) return completion && row.method_group === "native-int-baseline" ? "不适用" : "未记录";
  return percent ? formatPercent(value) : formatNumber(value, digits);
}

function comparisonTableRows(rows) {
  return rows
    .sort((left, right) => profileSort(left, right) || methodSort(left, right))
    .map((row) => `<tr data-profile="${escapeHtml(row.constellation_profile_id)}" data-method="${escapeHtml(row.method_id)}">
      <td>${escapeHtml(row.constellation_short_label)}</td>
      <td>${escapeHtml(row.method_label)}</td>
      <td>${formatPercent(row.node_sample_coverage)}</td>
      <td>${formatPercent(row.active_link_direct_coverage)}</td>
      <td>${formatPercent(row.active_link_effective_coverage)}</td>
      <td>${formatBytes(row.telemetry_bytes_per_node_slice)}</td>
      <td>${formatPercent(row.telemetry_overhead_vs_full_probe)}</td>
      <td>${metricHtml(row, "cpu_mae")}</td>
      <td>${metricHtml(row, "queue_depth_mae")}</td>
      <td>${metricHtml(row, "energy_percent_mae")}</td>
      <td>${metricHtml(row, "node_mode_accuracy", { percent: true })}</td>
      <td>${metricHtml(row, "link_status_accuracy", { percent: true })}</td>
      <td>${metricHtml(row, "link_utilization_mae")}</td>
      <td>${metricHtml(row, "utilization_inferred_mae", { completion: true })}</td>
      <td>${metricHtml(row, "utilization_inferred_p95_ae", { completion: true })}</td>
      <td>${metricHtml(row, "utilization_inferred_within_10_units_rate", { percent: true, completion: true })}</td>
      <td>${formatNumber(row.active_link_direct_coverage_std, 4)}</td>
      <td>${formatNumber(row.effective_coverage_per_kb_per_node_slice, 4)}</td>
    </tr>`).join("");
}

function keyFindingHtml(conclusions) {
  const rows = conclusions.map((item) => `<div class="card">
    <h3>${escapeHtml(item.profile)}</h3>
    <p>业务流 INT 直接覆盖 ${formatPercent(item.traffic_direct_coverage)}，全量探测 INT 直接覆盖 ${formatPercent(item.full_probe_direct_coverage)}。</p>
    <p>增强 LEO-INT-MC 有效覆盖 ${formatPercent(item.enhanced_effective_coverage)}，开销为 full probe 的 ${formatPercent(item.enhanced_vs_full_probe_overhead)}。</p>
    <p>原生 INT-MC 利用率补全 MAE ${formatNumber(item.original_int_mc_mae, 4)}，增强后 ${formatNumber(item.enhanced_int_mc_mae, 4)}。</p>
    <p><b>${escapeHtml(item.conclusion)}</b></p>
  </div>`).join("");
  return `<div class="grid">${rows}</div>`;
}

function buildHtml({ rows, conclusions, outputFiles, outputDir }) {
  const profileOptions = ['<option value="all">全部星座</option>', ...PROFILES.map((profile) => `<option value="${profile.id}">${profile.label}</option>`)].join("");
  const methodOptions = ['<option value="all">全部方法</option>', ...METHOD_ORDER.map((methodId) => `<option value="${methodId}">${methodLabel(methodId)}</option>`)].join("");
  const downloads = Object.entries(outputFiles)
    .map(([label, path]) => `<li><a href="${escapeHtml(relative(outputDir, path).replaceAll("\\", "/"))}">${escapeHtml(label)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>实验2：全基线对比</title>
  <style>
    body { margin:0; font-family: Arial, "Microsoft YaHei", sans-serif; color:#172033; background:#f6f8fb; }
    header { padding:26px 34px; background:#fff; border-bottom:1px solid #d8e0ea; position:sticky; top:0; z-index:4; }
    main { max-width:1280px; margin:0 auto; padding:24px 34px 44px; }
    h1 { margin:0 0 8px; font-size:28px; }
    h2 { margin:28px 0 12px; }
    h3 { margin:0 0 8px; }
    p { line-height:1.62; color:#475569; }
    .muted { color:#64748b; }
    .panel, .card { background:#fff; border:1px solid #d8e0ea; border-radius:8px; padding:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
    .chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .finding-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; }
    .finding { border-radius:8px; border:1px solid #d8e0ea; background:#fff; padding:14px; }
    .finding.good { background:#f1f8f2; border-color:#97c7aa; }
    .finding.warn { background:#fff8ed; border-color:#e0b065; }
    .filter-bar { display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin:12px 0; padding:12px; background:#fff; border:1px solid #d8e0ea; border-radius:8px; }
    .filter-bar label { display:grid; gap:5px; color:#475569; font-size:12px; font-weight:700; }
    .filter-bar select { min-width:180px; min-height:34px; border:1px solid #cbd5e1; border-radius:6px; padding:0 9px; background:#fff; color:#172033; font:inherit; }
    #tableCount { margin-left:auto; color:#64748b; font-size:12px; font-weight:700; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d8e0ea; }
    th, td { padding:8px 9px; border-bottom:1px solid #d8e0ea; text-align:right; font-size:12px; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align:left; }
    th { background:#eef3f8; }
    svg { width:100%; height:auto; display:block; }
    code { background:#eef3f8; border-radius:4px; padding:2px 5px; }
    .na { color:#64748b; font-weight:700; }
    .missing { color:#b06915; font-weight:700; }
    @media (max-width:980px) { header { position:static; } .grid, .chart-grid, .finding-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>实验2：全基线对比</h1>
    <div class="muted">三种正式星座规模：Iridium 66、Telesat 351、Starlink 1584；方法包括 traffic-int、full probe-int、shortest-path probe、random sampling、原生 INT-MC 和增强 LEO-INT-MC。</div>
  </header>
  <main>
    <div class="panel">
      <h2>实验目的</h2>
      <p>本实验用于比较不同 INT 遥测策略在动态 LEO 卫星网络中的覆盖率、遥测开销、状态重构误差和逐时间片稳定性。全量探测提供高覆盖上界；业务流 INT 和随机/最短路径探测作为弱基线；原生 INT-MC 与增强 LEO-INT-MC 用于比较矩阵补全类全网感知方法。</p>
    </div>
    ${keyFindingHtml(conclusions)}
    <h2>覆盖率-开销权衡</h2>
    <div class="chart-grid">
      <div class="panel">${svgCoverageCostScatter({ rows, yField: "active_link_effective_coverage", title: "有效覆盖率-遥测开销权衡图" })}</div>
      <div class="panel">${svgCoverageCostScatter({ rows, yField: "active_link_direct_coverage", title: "直接覆盖率-遥测开销权衡图" })}</div>
    </div>
    <h2>多维度指标对比</h2>
    <div class="chart-grid">
      <div class="panel">${svgGroupedBars({ rows, field: "active_link_direct_coverage", title: "活动链路直接覆盖率", formatter: formatPercent, maxValue: 1 })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "active_link_effective_coverage", title: "活动链路有效覆盖率", formatter: formatPercent, maxValue: 1 })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "telemetry_bytes_per_node_slice", title: "遥测开销：字节/节点/时间片", formatter: formatBytes })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "effective_coverage_per_kb_per_node_slice", title: "单位开销有效覆盖效率", formatter: (value) => formatNumber(value, 3) })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "utilization_inferred_mae", title: "INT-MC 利用率补全 MAE", formatter: (value) => formatNumber(value, 3) })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "active_link_direct_coverage_std", title: "逐时间片直接覆盖率波动 STD", formatter: (value) => formatNumber(value, 4) })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "cpu_mae", title: "节点 CPU MAE", formatter: (value) => formatNumber(value, 3) })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "energy_percent_mae", title: "节点电量 MAE", formatter: (value) => formatNumber(value, 3) })}</div>
    </div>
    <h2>实验结论</h2>
    <div class="finding-grid">
      <div class="finding good"><h3>1. traffic-int 开销低但覆盖不足</h3><p>业务流 INT 只沿真实业务路径携带 metadata，适合作为低开销对照，但其覆盖随业务热点漂移，不能独立完成全网状态感知。</p></div>
      <div class="finding warn"><h3>2. full probe-int 是覆盖上界，不是低开销方案</h3><p>全量主动探测在多数规模上直接覆盖最高，但遥测字节、报告和 Ground OAM 处理压力也最高，主要用于给其他方法提供上界参照。</p></div>
      <div class="finding warn"><h3>3. shortest-path 与 random sampling 缺少重构能力</h3><p>最短路径和随机采样可以减少部分探测成本，但没有矩阵补全/OAM 重构能力，容易出现局部重复覆盖或关键链路漏测。</p></div>
      <div class="finding good"><h3>4. 增强 LEO-INT-MC 更适合动态 LEO 场景</h3><p>增强方案在三种规模上均保持 100% 有效覆盖，并显著改善 CPU、队列、电量等节点状态重构。Iridium 与 Telesat 的开销低于原生 INT-MC；Starlink 的开销与原生非常接近，但节点状态和利用率补全更优。</p></div>
    </div>
    <div class="panel">
      <h3>边界说明</h3>
      <p>本实验不声称复刻真实运营商内部遥测数据。它证明的是：在第一阶段可控真值模型中，增强后的 LEO-INT-MC 能够在非全知 INT/OAM 视角下，以低于或接近原生 INT-MC 的遥测开销恢复全网节点和链路状态，并给后续算法实验提供统一对照基线。Telesat 的利用率补全 MAE 相比原生存在轻微代价，Starlink 的链路状态准确率和开销也存在极小幅差异，这是下一轮优化重点。</p>
    </div>
    <h2>综合对比表</h2>
    <div class="filter-bar">
      <label>星座筛选<select id="profileFilter">${profileOptions}</select></label>
      <label>方法筛选<select id="methodFilter">${methodOptions}</select></label>
      <span id="tableCount"></span>
    </div>
    <table id="comparisonTable">
      <thead><tr><th>星座</th><th>方法</th><th>节点覆盖</th><th>链路直接覆盖</th><th>链路有效覆盖</th><th>字节/节点/片</th><th>相对 full probe 开销</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>节点模式准确率</th><th>链路状态准确率</th><th>链路利用率 MAE</th><th>补全利用率 MAE</th><th>补全 P95 AE</th><th>10单位内比例</th><th>直接覆盖 STD</th><th>有效覆盖/KB</th></tr></thead>
      <tbody>${comparisonTableRows(rows)}</tbody>
    </table>
    <h2>输出文件</h2>
    <div class="panel"><ul>${downloads}</ul></div>
  </main>
  <script>
    function applyTableFilters() {
      const profile = document.getElementById("profileFilter").value;
      const method = document.getElementById("methodFilter").value;
      const rows = Array.from(document.querySelectorAll("#comparisonTable tbody tr"));
      let shown = 0;
      rows.forEach((row) => {
        const visible = (profile === "all" || row.dataset.profile === profile) && (method === "all" || row.dataset.method === method);
        row.style.display = visible ? "" : "none";
        if (visible) shown += 1;
      });
      document.getElementById("tableCount").textContent = shown + " / " + rows.length + " 行";
    }
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("profileFilter").addEventListener("change", applyTableFilters);
      document.getElementById("methodFilter").addEventListener("change", applyTableFilters);
      applyTableFilters();
    });
  </script>
</body>
</html>`;
}

function buildMarkdown({ rows, conclusions, outputFiles }) {
  return [
    "# 实验2：全基线对比",
    "",
    "本报告统一比较 `traffic-int`、`full probe-int`、`shortest-path probe`、`random sampling`、原生 `INT-MC` 和增强 `LEO-INT-MC`。",
    "",
    "## 关键结论",
    "",
    ...conclusions.map((row) =>
      `- ${row.profile}: 业务流 INT 直接覆盖 ${formatPercent(row.traffic_direct_coverage)}；增强 LEO-INT-MC 有效覆盖 ${formatPercent(row.enhanced_effective_coverage)}，开销为 full probe 的 ${formatPercent(row.enhanced_vs_full_probe_overhead)}，利用率补全 MAE 从 ${formatNumber(row.original_int_mc_mae, 4)} 变为 ${formatNumber(row.enhanced_int_mc_mae, 4)}。${row.conclusion}`,
    ),
    "",
    "## 综合表",
    "",
    "| 星座 | 方法 | 节点覆盖 | 链路直接覆盖 | 链路有效覆盖 | 字节/节点/片 | 相对 full probe 开销 | CPU MAE | 队列 MAE | 电量 MAE | 节点模式准确率 | 链路状态准确率 | 链路利用率 MAE | 补全利用率 MAE | 补全 P95 AE | 10单位内比例 | 直接覆盖 STD | 有效覆盖/KB |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows
      .sort((left, right) => profileSort(left, right) || methodSort(left, right))
      .map((row) => `| ${row.constellation_short_label} | ${row.method_label} | ${formatPercent(row.node_sample_coverage)} | ${formatPercent(row.active_link_direct_coverage)} | ${formatPercent(row.active_link_effective_coverage)} | ${formatBytes(row.telemetry_bytes_per_node_slice)} | ${formatPercent(row.telemetry_overhead_vs_full_probe)} | ${metricMarkdown(row, "cpu_mae")} | ${metricMarkdown(row, "queue_depth_mae")} | ${metricMarkdown(row, "energy_percent_mae")} | ${metricMarkdown(row, "node_mode_accuracy", { percent: true })} | ${metricMarkdown(row, "link_status_accuracy", { percent: true })} | ${metricMarkdown(row, "link_utilization_mae")} | ${metricMarkdown(row, "utilization_inferred_mae", { completion: true })} | ${metricMarkdown(row, "utilization_inferred_p95_ae", { completion: true })} | ${metricMarkdown(row, "utilization_inferred_within_10_units_rate", { percent: true, completion: true })} | ${formatNumber(row.active_link_direct_coverage_std, 4)} | ${formatNumber(row.effective_coverage_per_kb_per_node_slice, 4)} |`),
    "",
    "## 实验结论",
    "",
    "1. `traffic-int` 开销低但覆盖不足，不能独立支撑全网遥测。",
    "2. `full probe-int` 是覆盖率上界，但开销最高，更适合作为参照基线。",
    "3. `shortest-path probe` 与 `random sampling` 能减少部分开销，但缺少全网重构能力。",
    "4. 增强 `LEO-INT-MC` 在三种正式规模上保持 100% 有效覆盖，并在节点 CPU、队列、电量等重构指标上明显优于原生 INT-MC；个别利用率/链路状态指标仍存在轻微折中，需要作为下一轮优化点。",
    "",
    "## 输出文件",
    "",
    ...Object.entries(outputFiles).map(([label, path]) => `- ${label}: \`${path}\``),
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
const enhancedRoot = resolve(argValue(args, "--enhanced-root", "reports/experiment2-int-mc-oracle-free-replay"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment2-baseline-comparison-oracle-free-replay"));

const nativeSummaryPath = join(oldRoot, "experiment2-constellation-method-summary.csv");
const nativePerSlicePath = join(oldRoot, "experiment2-constellation-coverage-by-slice.csv");
const enhancedComparisonPath = join(enhancedRoot, "experiment2-int-mc-enhancement-comparison.csv");

requireFile(nativeSummaryPath, "native method summary");
requireFile(nativePerSlicePath, "native per-slice coverage");
requireFile(enhancedComparisonPath, "enhanced INT-MC comparison");

const nativeSummary = (await readCsv(nativeSummaryPath)).filter((row) => row.method_id !== "int-mc-selected-probe");
const nativePerSlice = (await readCsv(nativePerSlicePath)).filter((row) => row.method_id !== "int-mc-selected-probe");
const nativeDetails = [];
for (const profile of PROFILES) {
  const detailPath = join(oldRoot, profile.id, "experiment2", "experiment2-baseline-summary.csv");
  nativeDetails.push(...(await readCsv(detailPath)).map((row) => ({ ...row, constellation_profile_id: profile.id })));
}
const detailByKey = indexBy(nativeDetails, (row) => `${row.constellation_profile_id}|${row.method_id}`);
const nativeRows = nativeSummary.map((row) => nativeRow({
  row,
  detail: detailByKey.get(`${row.constellation_profile_id}|${row.method_id}`) ?? {},
}));

const enhancedComparisonRows = await readCsv(enhancedComparisonPath);
const originalIntMc = await intMcRows({
  enhancedRoot,
  comparisonRows: enhancedComparisonRows,
  version: "before",
  methodId: "int-mc-selected-probe",
  groundFolder: "int-mc-pass1",
  stage2Folder: "int-mc-pass1",
  methodGroup: "original-int-mc",
});
const enhancedIntMc = await intMcRows({
  enhancedRoot,
  comparisonRows: enhancedComparisonRows,
  version: "after",
  methodId: "leo-int-mc-enhanced",
  groundFolder: "int-mc-enhanced",
  stage2Folder: "int-mc-enhanced",
  methodGroup: "enhanced-int-mc",
});

const allRows = normalizeDisplayFields(stabilityRows([...nativeRows, ...originalIntMc.rows, ...enhancedIntMc.rows], [
  ...nativePerSlice,
  ...originalIntMc.perSlice,
  ...enhancedIntMc.perSlice,
]));
const allPerSliceRows = [...nativePerSlice, ...originalIntMc.perSlice, ...enhancedIntMc.perSlice];
const conclusions = conclusionRows(allRows);

const outputFiles = {
  "综合汇总 CSV": join(outputDir, "experiment2-comprehensive-baseline-summary.csv"),
  "逐时间片 CSV": join(outputDir, "experiment2-comprehensive-baseline-by-slice.csv"),
  "综合 JSON": join(outputDir, "experiment2-comprehensive-baseline-summary.json"),
  "Markdown 报告": join(outputDir, "experiment2-comprehensive-baseline-report.md"),
  "HTML 报告": join(outputDir, "experiment2-comprehensive-baseline-report.html"),
};

const payload = {
  schema_version: "experiment2-comprehensive-baseline-comparison-v2",
  generated_at: new Date().toISOString(),
  inputs: {
    native_baseline_root: oldRoot,
    enhanced_int_mc_root: enhancedRoot,
  },
  scope: {
    profiles: PROFILES,
    methods: METHOD_ORDER.map((method_id) => ({ method_id, method_label: methodLabel(method_id) })),
    note: "Only the three official constellation scales are included. Earlier development scales are excluded.",
  },
  conclusions,
  rows: allRows,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(outputFiles["综合汇总 CSV"], `\uFEFF${rowsToCsv(allRows)}`, "utf8"),
  writeFile(outputFiles["逐时间片 CSV"], `\uFEFF${rowsToCsv(allPerSliceRows)}`, "utf8"),
  writeFile(outputFiles["综合 JSON"], JSON.stringify(payload, null, 2), "utf8"),
  writeFile(outputFiles["Markdown 报告"], buildMarkdown({ rows: allRows, conclusions, outputFiles }), "utf8"),
  writeFile(outputFiles["HTML 报告"], `\uFEFF${buildHtml({ rows: allRows, conclusions, outputFiles, outputDir })}`, "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  rows: allRows.length,
  perSliceRows: allPerSliceRows.length,
  reportHtml: outputFiles["HTML 报告"],
  summaryCsv: outputFiles["综合汇总 CSV"],
}, null, 2));
