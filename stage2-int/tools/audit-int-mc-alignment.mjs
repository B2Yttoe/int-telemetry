import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
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
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  const text = String(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return "";
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
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

function fieldPresence(rows, field) {
  if (rows.length === 0) return 0;
  const present = rows.filter((row) => row[field] !== undefined && row[field] !== "").length;
  return round(present / rows.length);
}

async function readCsv(path) {
  if (!path || !existsSync(path)) return [];
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function readText(path) {
  if (!path || !existsSync(path)) return "";
  return readFile(path, "utf8");
}

function resolveFromRun(runDir, path) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(runDir, path);
}

function sumField(rows, field) {
  return rows.reduce((total, row) => total + numberValue(row[field]), 0);
}

function modeStats({ mode, hops, reports, runReport, overheadBySlice = [], linkOverhead = [] }) {
  const packets = groupBy(hops, (row) => row.packet_id);
  const hopCounts = [...packets.values()].map((rows) => rows.length);
  return {
    mode,
    hop_records: hops.length,
    reports: reports.length,
    packets: packets.size,
    mean_hops_per_packet: round(mean(hopCounts)),
    max_hops_per_packet: hopCounts.length ? Math.max(...hopCounts) : 0,
    field_presence: {
      packet_id: fieldPresence(hops, "packet_id"),
      node_id: fieldPresence(hops, "node_id"),
      egress_link_id: fieldPresence(hops, "egress_link_id"),
      observed_queue_depth: fieldPresence(hops, "observed_queue_depth"),
      observed_link_latency_ms: fieldPresence(hops, "observed_link_latency_ms"),
      observed_link_queue_latency_ms: fieldPresence(hops, "observed_link_queue_latency_ms"),
      observed_link_utilization_percent: fieldPresence(hops, "observed_link_utilization_percent"),
      observed_link_capacity_mbps: fieldPresence(hops, "observed_link_capacity_mbps"),
      observed_link_queued_mb: fieldPresence(hops, "observed_link_queued_mb"),
      carried_traffic_mbps: fieldPresence(hops, "carried_traffic_mbps"),
    },
    overhead: runReport?.overhead ?? {},
    overhead_by_slice: {
      rows: overheadBySlice.length,
      total_int_bytes: round(sumField(overheadBySlice, "total_int_bytes")),
      total_telemetry_energy_wh: round(sumField(overheadBySlice, "total_telemetry_energy_wh"), 8),
      max_slice_int_bytes: round(Math.max(0, ...overheadBySlice.map((row) => numberValue(row.total_int_bytes)))),
    },
    link_overhead: {
      rows: linkOverhead.length,
      total_telemetry_link_bytes: round(sumField(linkOverhead, "total_telemetry_link_bytes")),
      max_link_telemetry_bytes: round(Math.max(0, ...linkOverhead.map((row) => numberValue(row.total_telemetry_link_bytes)))),
    },
    coverage: runReport?.coverage ?? {},
  };
}

function comparableRows(hops, mode) {
  return hops.map((row) => {
    const outputPort = row.egress_link_id || row.local_port_peer || "";
    const outputPortSource = row.egress_link_id ? "egress_link_id" : row.local_port_peer ? "local_port_peer" : "";
    return {
      measurement_mode: mode,
      packet_id: row.packet_id,
      probe_id: row.probe_id ?? "",
      task_id: row.task_id,
      slice_index: row.slice_index,
      time: row.time,
      hop_index: row.hop_index,
      int_mc_switch_id: row.node_id,
      node_id: row.node_id,
      int_mc_output_port_logical: outputPort,
      output_port_source: outputPortSource,
      ingress_link_id: row.ingress_link_id,
      egress_link_id: row.egress_link_id,
      previous_hop: row.previous_hop,
      next_hop: row.next_hop,
      int_mc_queue_depth: row.observed_queue_depth,
      queue_depth_source: "observed_queue_depth",
      int_mc_queue_latency_ms: row.observed_link_queue_latency_ms,
      queue_latency_source: "observed_link_queue_latency_ms",
      queue_latency_proxy_value: "",
      queue_latency_proxy_unit: "",
      int_mc_hop_latency_ms: row.observed_link_latency_ms,
      hop_latency_source: "observed_link_latency_ms",
      link_utilization_percent: row.observed_link_utilization_percent,
      link_capacity_mbps: row.observed_link_capacity_mbps,
      congestion_percent: row.observed_link_congestion_percent,
      link_status: row.observed_link_status,
      link_active: row.observed_link_active,
      carried_traffic_mbps: row.carried_traffic_mbps,
      demand_traffic_mbps: row.demand_traffic_mbps,
      observation_scope: row.observation_scope ?? "forwarding-hop",
      alignment_note: "queue latency is exported explicitly from the time-slice queue-drain estimate",
    };
  });
}

function analyzeIntMcSource(root) {
  const simpleIntPath = join(root, "mininet", "p4src", "simple_int.p4");
  const headersPath = join(root, "mininet", "p4src", "include", "headers.p4");
  const receivePath = join(root, "mininet", "packet_test", "receive_int.py");
  const sendPath = join(root, "mininet", "packet_test", "send_int.py");
  const headers = existsSync(headersPath) ? "" : "";
  return {
    root,
    found: existsSync(root),
    files: {
      simple_int_p4: simpleIntPath,
      headers_p4: headersPath,
      receive_int_py: receivePath,
      send_int_py: sendPath,
    },
    detected_features: {
      source_routing: false,
      p4_egress_int_insertion: false,
      switch_id: false,
      output_port: false,
      queue_depth: false,
      queue_latency: false,
      hop_latency: false,
      packet_receiver_extracts_hop_records: false,
    },
    headers,
  };
}

async function fillIntMcSourceAnalysis(root) {
  const analysis = analyzeIntMcSource(root);
  const [simpleInt, headers, receiveInt, sendInt] = await Promise.all([
    readText(analysis.files.simple_int_p4),
    readText(analysis.files.headers_p4),
    readText(analysis.files.receive_int_py),
    readText(analysis.files.send_int_py),
  ]);
  const source = `${simpleInt}\n${headers}\n${receiveInt}\n${sendInt}`;
  analysis.detected_features = {
    source_routing: /source_routes|SourceRoute|TYPE_SOURCE_ROUTING/.test(source),
    p4_egress_int_insertion: /add_int_metadata|hdr\.int_metadata\.push_front/.test(source),
    switch_id: /switch_id|swid/.test(source),
    output_port: /output_port|egress_port/.test(source),
    queue_depth: /queue_depth|queue_en_depth|queue_de_depth|deq_qdepth/.test(source),
    queue_latency: /queue_latency|deq_timedelta/.test(source),
    hop_latency: /hop_latency|egress_global_timestamp/.test(source),
    packet_receiver_extracts_hop_records: /sniff|PacketListField|INT_udp_results/.test(source),
  };
  return analysis;
}

const fieldMappings = [
  {
    int_mc_field: "source route stack",
    native_field: "probe path/link_ids",
    alignment: "direct",
    note: "Both systems drive INT packets along selected paths. The project stores paths in CSV instead of wire headers.",
  },
  {
    int_mc_field: "switch_id",
    native_field: "node_id",
    alignment: "direct",
    note: "Satellite node id is the logical switch id for comparison.",
  },
  {
    int_mc_field: "output_port",
    native_field: "egress_link_id or local_port_peer",
    alignment: "logical",
    note: "The project uses logical link ids instead of numeric P4 ports.",
  },
  {
    int_mc_field: "queue_depth",
    native_field: "observed_queue_depth",
    alignment: "direct",
    note: "Unit is simulation queue depth, not BMv2/Tofino hardware queue units.",
  },
  {
    int_mc_field: "queue_latency",
    native_field: "observed_link_queue_latency_ms",
    alignment: "direct",
    note: "Queue latency is exported as a per-hop queue-drain estimate: queued_traffic_mb * 8 * 1000 / effective_capacity_mbps.",
  },
  {
    int_mc_field: "hop_latency",
    native_field: "observed_link_latency_ms",
    alignment: "proxy-direct",
    note: "Project link latency is a model-level hop latency estimate, not a P4 ingress/egress timestamp delta.",
  },
  {
    int_mc_field: "pkts / txbytes",
    native_field: "overhead-by-slice CSV and link-overhead CSV",
    alignment: "proxy-direct",
    note: "The project exports time-slice INT bytes and per-link telemetry forwarding bytes; it remains a time-slice model, not a packet-level wire trace.",
  },
  {
    int_mc_field: "INT report / receiver output",
    native_field: "int-reports.csv and ground-delivered-reports.csv",
    alignment: "direct",
    note: "Both represent collected hop metadata delivered to the collector/OAM side.",
  },
];

function alignmentScore(mappings) {
  const weights = {
    direct: 1,
    "proxy-direct": 0.85,
    logical: 0.8,
    proxy: 0.55,
    partial: 0.45,
    missing: 0,
  };
  return round(mean(mappings.map((mapping) => weights[mapping.alignment] ?? 0)));
}

function buildMarkdown(report) {
  const lines = [
    "# INT-MC INT Alignment Audit",
    "",
    "本报告用于把本项目第二阶段的原生 INT 全网感知实现，与 INT-MC 原型中的 INT 数据采集部分对齐，方便后续做原生 INT、卫星化 INT-MC、改进采样算法之间的公平对比。",
    "",
    "## 结论",
    "",
    `- 对齐层级：${report.conclusion.alignment_level}`,
    `- 对齐评分：${report.conclusion.alignment_score}`,
    `- 是否适合做后续对比实验：${report.conclusion.ready_for_comparison ? "是" : "否"}`,
    "",
    "当前对齐是“遥测记录级/实验指标级”对齐，不是 P4 报文格式级对齐。也就是说，后续实验可以公平比较覆盖率、采样开销、hop 记录数、报告字节、重构误差和时延影响；如果要比较 P4 parser、wire header 或硬件队列时间戳，则还需要额外的逐包仿真或 P4 运行环境。",
    "",
    "## INT-MC 原型中的 INT 部分",
    "",
    `- 源码目录：${report.int_mc_source.root}`,
    `- 是否找到源码：${report.int_mc_source.found}`,
    "",
    "| 功能 | 检测结果 |",
    "|---|---|",
    ...Object.entries(report.int_mc_source.detected_features).map(([key, value]) => `| ${key} | ${value ? "yes" : "no"} |`),
    "",
    "## 字段对齐",
    "",
    "| INT-MC 字段/机制 | 本项目字段/机制 | 对齐状态 | 说明 |",
    "|---|---|---|---|",
    ...report.field_mappings.map((item) => `| ${item.int_mc_field} | ${item.native_field} | ${item.alignment} | ${item.note} |`),
    "",
    "## 本项目 INT 输出统计",
    "",
    "| 模式 | hop records | reports | packets | mean hops | max hops |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.native_modes.map((mode) =>
      `| ${mode.mode} | ${mode.hop_records} | ${mode.reports} | ${mode.packets} | ${mode.mean_hops_per_packet} | ${mode.max_hops_per_packet} |`,
    ),
    "",
    "## 后续对比实验的统一约束",
    "",
    "- 使用同一次第一阶段真值快照作为输入。",
    "- 原生 probe-int 与 INT-MC 改进版使用相同的时间片、业务数据集、链路状态和下传预算。",
    "- 统一统计 `hop_records`、`total_metadata_bytes`、`total_report_bytes`、`total_int_bytes`、覆盖率、重构误差和业务时延增量。",
    "- INT-MC 类方法的优势不应来自读取更多真值，而应来自更少采样和更强的 Ground OAM 重构。",
    "- 未观测对象必须保持 unknown 或 inferred，不能用第一阶段真值填充。",
    "",
    "## 仍需补齐",
    "",
    ...report.gaps.map((gap) => `- ${gap}`),
    "",
    "## 产物",
    "",
    `- JSON 报告：${report.outputs.json}`,
    `- probe-int 可比较 hop 表：${report.outputs.probe_comparable_hops_csv || "未生成"}`,
    `- traffic-int 可比较 hop 表：${report.outputs.traffic_comparable_hops_csv || "未生成"}`,
    "",
  ];
  return lines.join("\n");
}

function buildReadableMarkdown(report) {
  const lines = [
    "# INT-MC INT Alignment Audit",
    "",
    "This report aligns the project's native Stage-2 full-network INT implementation with the INT data-collection part of the INT-MC prototype. It supports fair follow-up comparisons among native probe-int, satellite-adapted INT-MC, and improved sampling or reconstruction algorithms.",
    "",
    "## Conclusion",
    "",
    `- Alignment level: ${report.conclusion.alignment_level}`,
    `- Alignment score: ${report.conclusion.alignment_score}`,
    `- Ready for follow-up comparison: ${report.conclusion.ready_for_comparison ? "yes" : "no"}`,
    "",
    "The current alignment is at the telemetry-record and evaluation-metric level, not at the binary P4 packet-header level. Follow-up experiments can compare coverage, sampling overhead, hop records, report bytes, reconstruction error, and task-latency impact. P4 parser/deparser behavior, binary wire headers, and hardware queue timestamp fidelity remain outside this project unless a packet-level P4/ns-3 environment is added.",
    "",
    "## INT Part Detected In The INT-MC Prototype",
    "",
    `- Source root: ${report.int_mc_source.root}`,
    `- Source found: ${report.int_mc_source.found}`,
    "",
    "| Feature | Detected |",
    "|---|---|",
    ...Object.entries(report.int_mc_source.detected_features).map(([key, value]) => `| ${key} | ${value ? "yes" : "no"} |`),
    "",
    "## Field Alignment",
    "",
    "| INT-MC field/mechanism | Project field/mechanism | Alignment | Note |",
    "|---|---|---|---|",
    ...report.field_mappings.map((item) => `| ${item.int_mc_field} | ${item.native_field} | ${item.alignment} | ${item.note} |`),
    "",
    "## Native INT Output Statistics",
    "",
    "| Mode | hop records | reports | packets | mean hops | max hops |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.native_modes.map((mode) =>
      `| ${mode.mode} | ${mode.hop_records} | ${mode.reports} | ${mode.packets} | ${mode.mean_hops_per_packet} | ${mode.max_hops_per_packet} |`,
    ),
    "",
    "## Constraints For Fair Follow-Up Comparisons",
    "",
    "- Use the same Stage-1 truth snapshot as input.",
    "- Keep the same time slices, task dataset, link-state snapshot, downlink budget, hop metadata bytes, and report header bytes.",
    "- Compare `hop_records`, `total_metadata_bytes`, `total_report_bytes`, `total_int_bytes`, coverage, reconstruction error, and task-latency delta.",
    "- Any advantage of INT-MC-like methods must come from fewer measurements and stronger Ground OAM reconstruction, not from reading extra truth-state fields.",
    "- Unobserved objects must stay `unknown` or `inferred`; they must not be filled directly from Stage-1 truth.",
    "",
    "## Remaining Gaps",
    "",
    ...report.gaps.map((gap) => `- ${gap}`),
    "",
    "## Artifacts",
    "",
    `- JSON report: ${report.outputs.json}`,
    `- probe-int comparable hop table: ${report.outputs.probe_comparable_hops_csv || "not generated"}`,
    `- traffic-int comparable hop table: ${report.outputs.traffic_comparable_hops_csv || "not generated"}`,
    "",
  ];
  return lines.join("\n");
}

const args = process.argv.slice(2);
const runDirArg = argValue(args, "--run", "");
const runDir = runDirArg ? resolve(runDirArg) : "";
const intMcRoot = resolve(argValue(args, "--int-mc-root", "E:/INT-MC-main/INT-MC-main"));
const manifestPath = runDir ? join(runDir, "int-experiment-manifest.json") : "";
const manifest = await readJson(manifestPath);
const algorithm = argValue(args, "--algorithm", manifest?.input?.algorithm ?? "path-balance");
const stage2Dir = runDir
  ? resolveFromRun(runDir, manifest?.outputs?.stage2_int_dir ?? join(runDir, "stage2-int"))
  : "";
const outputDir = resolve(argValue(args, "--out", runDir ? join(runDir, "int-mc-alignment") : "stage2-int/evaluation/int-mc-alignment"));

const trafficHopsPath = stage2Dir ? join(stage2Dir, "int-hop-records.csv") : "";
const trafficReportsPath = stage2Dir ? join(stage2Dir, "int-reports.csv") : "";
const trafficRunReportPath = stage2Dir ? join(stage2Dir, "coverage-report.json") : "";
const trafficOverheadBySlicePath = stage2Dir ? join(stage2Dir, "traffic-int-overhead-by-slice.csv") : "";
const trafficLinkOverheadPath = stage2Dir ? join(stage2Dir, "traffic-int-link-overhead.csv") : "";
const probeHopsPath = stage2Dir ? join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`) : "";
const probeReportsPath = stage2Dir ? join(stage2Dir, `probe-int-reports-${algorithm}.csv`) : "";
const probeRunReportPath = stage2Dir ? join(stage2Dir, `probe-int-run-report-${algorithm}.json`) : "";
const probeOverheadBySlicePath = stage2Dir ? join(stage2Dir, `probe-int-overhead-by-slice-${algorithm}.csv`) : "";
const probeLinkOverheadPath = stage2Dir ? join(stage2Dir, `probe-int-link-overhead-${algorithm}.csv`) : "";

const [
  intMcSource,
  trafficHops,
  trafficReports,
  trafficRunReport,
  trafficOverheadBySlice,
  trafficLinkOverhead,
  probeHops,
  probeReports,
  probeRunReport,
  probeOverheadBySlice,
  probeLinkOverhead,
  hopSchema,
  reportSchema,
  telemetryFields,
] = await Promise.all([
  fillIntMcSourceAnalysis(intMcRoot),
  readCsv(trafficHopsPath),
  readCsv(trafficReportsPath),
  readJson(trafficRunReportPath),
  readCsv(trafficOverheadBySlicePath),
  readCsv(trafficLinkOverheadPath),
  readCsv(probeHopsPath),
  readCsv(probeReportsPath),
  readJson(probeRunReportPath),
  readCsv(probeOverheadBySlicePath),
  readCsv(probeLinkOverheadPath),
  readJson("stage2-int/schemas/int-hop-record.schema.json"),
  readJson("stage2-int/schemas/int-report.schema.json"),
  readJson("stage2-int/config/telemetry-fields.json"),
]);

const nativeModes = [
  modeStats({
    mode: "traffic-int",
    hops: trafficHops,
    reports: trafficReports,
    runReport: trafficRunReport,
    overheadBySlice: trafficOverheadBySlice,
    linkOverhead: trafficLinkOverhead,
  }),
  modeStats({
    mode: `probe-int:${algorithm}`,
    hops: probeHops,
    reports: probeReports,
    runReport: probeRunReport,
    overheadBySlice: probeOverheadBySlice,
    linkOverhead: probeLinkOverhead,
  }),
];
const score = alignmentScore(fieldMappings);
const gaps = [
  "如果要和 INT-MC 的 queue_latency 做严格数值对比，需要在本项目 hop record 中显式导出每跳队列时延，而不是只用 queued MB 或链路拥塞 proxy。",
  "如果要和 INT-MC 的 pkts/txbytes 对齐，需要把时间片级业务量换算成 per-link/per-probe 的字节计数，或者保持当前 flow-level 开销指标并在论文中声明边界。",
  "如果要做 P4/Tofino 级复现，需要额外定义二进制 INT header、numeric output_port 和 parser/deparser 行为；当前项目适合算法级和遥测记录级对比。",
  "INT-MC 对比实验应固定相同的下传预算、hop metadata bytes、report header bytes 和时间片集合，避免开销指标不可比。",
];

const readableGaps = [
  "Strict pkts/txbytes comparison requires converting flow-level traffic into per-link or per-probe byte counters, or explicitly keeping the current flow-level overhead boundary in the paper.",
  "P4/Tofino-level reproduction would require binary INT headers, numeric output_port values, and parser/deparser behavior; the current project is aligned at algorithm and telemetry-record level.",
  "Follow-up INT-MC comparison experiments should fix the same downlink budget, hop metadata bytes, report header bytes, and time-slice set so overhead metrics remain comparable.",
];

const probeComparable = comparableRows(probeHops, `probe-int:${algorithm}`);
const trafficComparable = comparableRows(trafficHops, "traffic-int");
const outputs = {
  json: join(outputDir, "int-mc-alignment-report.json"),
  md: join(outputDir, "int-mc-alignment-report.md"),
  probe_comparable_hops_csv: probeComparable.length ? join(outputDir, `probe-int-mc-comparable-hops-${algorithm}.csv`) : "",
  traffic_comparable_hops_csv: trafficComparable.length ? join(outputDir, "traffic-int-mc-comparable-hops.csv") : "",
};

const report = {
  schema_version: "stage2-int-mc-alignment-audit-v1",
  generated_at: new Date().toISOString(),
  input: {
    run_dir: runDir,
    manifest_json: manifestPath,
    algorithm,
    stage2_int_dir: stage2Dir,
  },
  conclusion: {
    alignment_level: "telemetry-record-and-evaluation-metric",
    alignment_score: score,
    ready_for_comparison: score >= 0.7 && probeHops.length > 0,
  },
  int_mc_source: intMcSource,
  native_schema: {
    hop_record_required: hopSchema?.required ?? [],
    hop_record_properties: Object.keys(hopSchema?.properties ?? {}),
    report_required: reportSchema?.required ?? [],
    report_properties: Object.keys(reportSchema?.properties ?? {}),
    telemetry_fields: telemetryFields ?? null,
  },
  field_mappings: fieldMappings,
  native_modes: nativeModes,
  comparison_contract: {
    common_measurement_unit: "one hop record appended by one forwarding node on one INT packet/probe",
    common_report_unit: "one INT report generated at sink and delivered or dropped by Ground OAM downlink model",
    comparable_metrics: [
      "hop_records",
      "reports",
      "total_metadata_bytes",
      "total_report_bytes",
      "total_int_bytes",
      "total_telemetry_link_bytes",
      "max_slice_int_bytes",
      "max_link_telemetry_bytes",
      "node_sample_coverage",
      "link_sample_coverage",
      "active_link_sample_coverage",
      "direct_observation_rate_on_active",
      "inferred_rate_on_active",
      "reconstruction_mae_or_nmse",
      "delta_task_latency_ms",
    ],
    non_comparable_without_extra_modeling: [
      "binary wire header size",
      "hardware timestamp precision",
      "P4 parser/deparser correctness",
      "physical packet retransmission behavior",
    ],
  },
  gaps: readableGaps,
  outputs,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(outputs.json, JSON.stringify(report, null, 2), "utf8"),
  writeFile(outputs.md, buildReadableMarkdown(report), "utf8"),
  outputs.probe_comparable_hops_csv
    ? writeFile(outputs.probe_comparable_hops_csv, rowsToCsv(probeComparable), "utf8")
    : Promise.resolve(),
  outputs.traffic_comparable_hops_csv
    ? writeFile(outputs.traffic_comparable_hops_csv, rowsToCsv(trafficComparable), "utf8")
    : Promise.resolve(),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  alignmentScore: score,
  readyForComparison: report.conclusion.ready_for_comparison,
  trafficHopRecords: trafficHops.length,
  probeHopRecords: probeHops.length,
  report: outputs.json,
}, null, 2));
