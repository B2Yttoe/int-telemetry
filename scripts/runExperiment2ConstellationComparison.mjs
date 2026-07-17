import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const PROFILE_CATALOG = [
  {
    id: "iridium-next-small",
    label: "Iridium NEXT 6x11",
    short_label: "Iridium 66",
    scale: "small",
    source_basis: "CelesTrak real Iridium NEXT snapshot",
  },
  {
    id: "telesat-1015-medium",
    label: "Telesat-1015 27x13",
    short_label: "Telesat 351",
    scale: "medium",
    source_basis: "Hypatia Telesat-1015 reference design + synthetic TLE",
  },
  {
    id: "starlink-main-large",
    label: "Starlink main shell 72x22",
    short_label: "Starlink 1584",
    scale: "large",
    source_basis: "CelesTrak Starlink-derived 72x22 snapshot",
  },
];

const METHOD_ORDER = [
  "traffic-int",
  "full-probe-int",
  "shortest-path-probe",
  "random-sampling-aggregate",
  "int-mc-selected-probe",
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, fallback.join(","));
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
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
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function methodSort(left, right) {
  const leftIndex = METHOD_ORDER.indexOf(left.method_id);
  const rightIndex = METHOD_ORDER.indexOf(right.method_id);
  return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPercent(value, digits = 2) {
  return `${(numberValue(value) * 100).toFixed(digits)}%`;
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1200)}`);
  }
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment2:constellations] ${label}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (lastLine && !lastLine.startsWith("{")) console.log(`  ${lastLine}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(parseLastJson(stdout, label));
    });
  });
}

function relativePath(from, target) {
  return relative(from, target).replaceAll("\\", "/");
}

function normalizeSummaryRow(row, profile, report, baselineDir) {
  const bytes = numberValue(row.total_telemetry_generated_bytes);
  const slices = numberValue(report.slice_count, 1);
  const nodes = numberValue(report.node_count, 1);
  const directCoverage = numberValue(row.active_link_direct_coverage || row.active_link_sample_coverage);
  const effectiveCoverage = numberValue(row.active_link_effective_coverage || row.active_link_sample_coverage);
  return {
    constellation_profile_id: profile.id,
    constellation_label: profile.label,
    constellation_short_label: profile.short_label,
    scale: profile.scale,
    source_basis: profile.source_basis,
    slice_count: slices,
    nodes_per_slice: nodes,
    active_link_sample_count: report.active_link_sample_count,
    method_id: row.method_id,
    method_label: row.method_label,
    method_family: row.method_family,
    node_sample_coverage: numberValue(row.node_sample_coverage),
    active_link_direct_coverage: directCoverage,
    active_link_effective_coverage: effectiveCoverage,
    coverage_gain_from_inference: round(Math.max(0, effectiveCoverage - directCoverage)),
    int_mc_inferred_rate_on_active: row.int_mc_inferred_rate_on_active ?? "",
    int_mc_utilization_inferred_mae: row.int_mc_utilization_inferred_mae ?? "",
    int_mc_latency_inferred_mae_ms: row.int_mc_latency_inferred_mae_ms ?? "",
    total_telemetry_generated_bytes: bytes,
    telemetry_bytes_per_slice: round(bytes / Math.max(slices, 1), 2),
    telemetry_bytes_per_node_slice: round(bytes / Math.max(slices * nodes, 1), 4),
    total_telemetry_energy_j: numberValue(row.total_telemetry_energy_j),
    telemetry_energy_j_per_slice: round(numberValue(row.total_telemetry_energy_j) / Math.max(slices, 1), 6),
    hop_records: numberValue(row.hop_records),
    coverage_per_mb: bytes > 0 ? round(effectiveCoverage / (bytes / 1e6), 6) : 0,
    notes: row.notes ?? "",
    baseline_report_html: join(baselineDir, "experiment2-native-int-baselines-report.html"),
    baseline_report_json: join(baselineDir, "experiment2-native-int-baselines-report.json"),
  };
}

function normalizePerSliceRow(row, profile) {
  return {
    constellation_profile_id: profile.id,
    constellation_short_label: profile.short_label,
    scale: profile.scale,
    method_id: row.method_id,
    method_label: row.method_label,
    slice_index: Number(row.slice_index),
    time: row.time,
    truth_nodes: numberValue(row.truth_nodes),
    observed_nodes: numberValue(row.observed_nodes),
    node_coverage: numberValue(row.node_coverage),
    truth_active_links: numberValue(row.truth_active_links),
    observed_active_links: numberValue(row.observed_active_links),
    completed_active_links: numberValue(row.completed_active_links),
    inferred_active_links: numberValue(row.inferred_active_links),
    active_link_direct_coverage: numberValue(row.active_link_direct_coverage || row.active_link_coverage),
    active_link_effective_coverage: numberValue(row.active_link_effective_coverage || row.active_link_coverage),
    total_telemetry_generated_bytes: numberValue(row.total_telemetry_generated_bytes),
    total_telemetry_energy_j: numberValue(row.total_telemetry_energy_j),
    hop_records: numberValue(row.hop_records),
  };
}

function svgGroupedBar({ rows, field, title, formatter, width = 980, height = 360, maxValue = null, logScale = false }) {
  const margin = { top: 44, right: 22, bottom: 86, left: 72 };
  const groups = [...new Set(rows.map((row) => row.constellation_short_label))];
  const series = METHOD_ORDER
    .map((methodId) => rows.find((row) => row.method_id === methodId))
    .filter(Boolean)
    .map((row) => ({ method_id: row.method_id, method_label: row.method_label }));
  const colors = ["#0f766e", "#2563eb", "#9333ea", "#f59e0b", "#dc2626"];
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  const rawMax = maxValue ?? Math.max(1e-9, ...values);
  const yValue = (value) => logScale ? Math.log10(Math.max(1, numberValue(value))) : numberValue(value);
  const yMax = logScale ? Math.log10(Math.max(1, rawMax)) : rawMax;
  const y = (value) => margin.top + plotHeight - (yValue(value) / Math.max(yMax, 1e-9)) * plotHeight;
  const groupWidth = plotWidth / Math.max(groups.length, 1);
  const barWidth = Math.max(8, groupWidth / Math.max(series.length, 1) * 0.68);
  const index = new Map(rows.map((row) => [`${row.constellation_short_label}|${row.method_id}`, row]));
  const bars = groups.flatMap((group, groupIndex) =>
    series.map((item, seriesIndex) => {
      const row = index.get(`${group}|${item.method_id}`) ?? {};
      const value = numberValue(row[field]);
      const x = margin.left + groupIndex * groupWidth + seriesIndex * (groupWidth / series.length) + (groupWidth / series.length - barWidth) / 2;
      const top = y(value);
      const barHeight = margin.top + plotHeight - top;
      return `<rect x="${x}" y="${top}" width="${barWidth}" height="${Math.max(0, barHeight)}" rx="2" fill="${colors[seriesIndex % colors.length]}"><title>${escapeHtml(group)} / ${escapeHtml(item.method_label)}: ${escapeHtml(formatter(value))}</title></rect>`;
    })
  ).join("");
  const labels = groups.map((group, index) => {
    const x = margin.left + index * groupWidth + groupWidth / 2;
    return `<text x="${x}" y="${height - 46}" text-anchor="middle" font-size="12">${escapeHtml(group)}</text>`;
  }).join("");
  const legend = series.map((item, index) => {
    const x = margin.left + (index % 3) * 265;
    const yLegend = height - 24 + Math.floor(index / 3) * 17;
    return `<rect x="${x}" y="${yLegend - 10}" width="10" height="10" fill="${colors[index % colors.length]}"></rect><text x="${x + 15}" y="${yLegend}" font-size="12">${escapeHtml(item.method_label)}</text>`;
  }).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = logScale ? 10 ** (yMax * ratio) : rawMax * ratio;
    const tickY = margin.top + plotHeight - ratio * plotHeight;
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#d8dee9" stroke-width="1"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(formatter(value))}</text>`;
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

function svgScatter({ rows, width = 980, height = 360 }) {
  const margin = { top: 44, right: 42, bottom: 58, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xValues = rows.map((row) => numberValue(row.telemetry_bytes_per_node_slice, NaN)).filter((value) => Number.isFinite(value) && value > 0);
  const xMin = Math.min(...xValues, 1);
  const xMax = Math.max(...xValues, 10);
  const lxMin = Math.floor(Math.log10(Math.max(1, xMin))) - 0.1;
  const lxMax = Math.ceil(Math.log10(Math.max(10, xMax))) + 0.1;
  const x = (value) => margin.left + ((Math.log10(Math.max(1, numberValue(value))) - lxMin) / Math.max(lxMax - lxMin, 0.1)) * plotWidth;
  const y = (value) => margin.top + plotHeight - numberValue(value) * plotHeight;
  const methodColors = new Map(METHOD_ORDER.map((methodId, index) => [methodId, ["#0f766e", "#2563eb", "#9333ea", "#f59e0b", "#dc2626"][index]]));
  const scaleRadius = new Map([
    ["small", 5],
    ["medium", 7],
    ["large", 9],
  ]);
  const points = rows.map((row) => {
    const cx = x(row.telemetry_bytes_per_node_slice);
    const cy = y(row.active_link_effective_coverage);
    const fill = methodColors.get(row.method_id) ?? "#475569";
    const label = `${row.constellation_short_label} / ${row.method_label}`;
    return `<circle cx="${cx}" cy="${cy}" r="${scaleRadius.get(row.scale) ?? 6}" fill="${fill}" opacity="0.86"><title>${escapeHtml(label)}; bytes/node-slice=${escapeHtml(row.telemetry_bytes_per_node_slice)}; coverage=${escapeHtml(formatPercent(row.active_link_effective_coverage))}</title></circle>`;
  }).join("");
  const xTicks = [];
  for (let tick = Math.ceil(lxMin); tick <= Math.floor(lxMax); tick += 1) {
    const value = 10 ** tick;
    const tickX = x(value);
    xTicks.push(`<line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#e2e8f0"></line><text x="${tickX}" y="${height - 28}" text-anchor="middle" font-size="11">${formatBytes(value)}</text>`);
  }
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
    const tickY = y(tick);
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${formatPercent(tick, 0)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Coverage overhead scatter">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">覆盖率-遥测开销权衡图（横轴按每节点每时间片字节对数缩放）</text>
    ${xTicks.join("")}
    ${yTicks}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    ${points}
    <text x="${margin.left + plotWidth / 2}" y="${height - 6}" text-anchor="middle" font-size="12">telemetry bytes / node / slice</text>
  </svg>`;
}

function svgHeatmap({ rows, width = 980 }) {
  const sortedRows = [...new Map(rows.map((row) => [`${row.constellation_short_label}|${row.method_id}`, row])).keys()]
    .map((key) => {
      const [profile, methodId] = key.split("|");
      return { profile, methodId, label: `${profile} / ${rows.find((row) => row.constellation_short_label === profile && row.method_id === methodId)?.method_label ?? methodId}` };
    })
    .sort((left, right) => PROFILE_CATALOG.findIndex((profile) => profile.short_label === left.profile) - PROFILE_CATALOG.findIndex((profile) => profile.short_label === right.profile) || METHOD_ORDER.indexOf(left.methodId) - METHOD_ORDER.indexOf(right.methodId));
  const slices = [...new Set(rows.map((row) => Number(row.slice_index)))].sort((a, b) => a - b);
  const margin = { top: 48, right: 22, bottom: 32, left: 225 };
  const cellW = Math.max(14, Math.min(42, (width - margin.left - margin.right) / Math.max(slices.length, 1)));
  const cellH = 24;
  const height = margin.top + sortedRows.length * cellH + margin.bottom;
  const index = new Map(rows.map((row) => [`${row.constellation_short_label}|${row.method_id}|${row.slice_index}`, row]));
  const color = (value) => {
    const v = Math.max(0, Math.min(1, numberValue(value)));
    const hue = 16 + v * 150;
    return `hsl(${hue}, 72%, ${88 - v * 42}%)`;
  };
  const cells = sortedRows.flatMap((rowKey, rowIndex) =>
    slices.map((slice, sliceIndex) => {
      const row = index.get(`${rowKey.profile}|${rowKey.methodId}|${slice}`);
      const value = numberValue(row?.active_link_effective_coverage);
      const x = margin.left + sliceIndex * cellW;
      const y = margin.top + rowIndex * cellH;
      return `<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${color(value)}"><title>${escapeHtml(rowKey.label)} T${String(slice).padStart(2, "0")}: ${formatPercent(value)}</title></rect>`;
    })
  ).join("");
  const rowLabels = sortedRows.map((row, index) =>
    `<text x="${margin.left - 8}" y="${margin.top + index * cellH + 16}" text-anchor="end" font-size="11">${escapeHtml(row.label)}</text>`
  ).join("");
  const colLabels = slices.map((slice, index) => {
    const x = margin.left + index * cellW + cellW / 2;
    return `<text x="${x}" y="${margin.top - 10}" text-anchor="middle" font-size="10">T${String(slice).padStart(2, "0")}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Per-slice coverage heatmap">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">逐时间片活动链路有效覆盖率热力图</text>
    ${colLabels}
    ${rowLabels}
    ${cells}
  </svg>`;
}

function buildHtmlReport({ summary, rows, perSliceRows, outputFiles, outputDir }) {
  const cards = PROFILE_CATALOG
    .filter((profile) => summary.profiles.includes(profile.id))
    .map((profile) => {
      const profileRows = rows.filter((row) => row.constellation_profile_id === profile.id);
      const intMc = profileRows.find((row) => row.method_id === "int-mc-selected-probe");
      const full = profileRows.find((row) => row.method_id === "full-probe-int");
      const gain = intMc ? numberValue(intMc.active_link_effective_coverage) - numberValue(intMc.active_link_direct_coverage) : 0;
      return `<div class="card">
        <div class="muted">${escapeHtml(profile.scale.toUpperCase())}</div>
        <h3>${escapeHtml(profile.short_label)}</h3>
        <p>${escapeHtml(profile.source_basis)}</p>
        <div class="metric">${profileRows[0]?.nodes_per_slice ?? "-"} nodes</div>
        <div class="small">INT-MC inference gain: ${formatPercent(gain)}</div>
        <div class="small">Full probe effective coverage: ${formatPercent(full?.active_link_effective_coverage)}</div>
      </div>`;
    }).join("");
  const tableRows = rows
    .sort((left, right) => PROFILE_CATALOG.findIndex((profile) => profile.id === left.constellation_profile_id) - PROFILE_CATALOG.findIndex((profile) => profile.id === right.constellation_profile_id) || methodSort(left, right))
    .map((row) => `<tr>
      <td>${escapeHtml(row.constellation_short_label)}</td>
      <td>${escapeHtml(row.method_label)}</td>
      <td>${formatPercent(row.node_sample_coverage)}</td>
      <td>${formatPercent(row.active_link_direct_coverage)}</td>
      <td>${formatPercent(row.active_link_effective_coverage)}</td>
      <td>${row.int_mc_inferred_rate_on_active === "" ? "-" : formatPercent(row.int_mc_inferred_rate_on_active)}</td>
      <td>${formatBytes(row.total_telemetry_generated_bytes)}</td>
      <td>${formatBytes(row.telemetry_bytes_per_node_slice)}</td>
      <td>${numberValue(row.total_telemetry_energy_j).toFixed(4)}</td>
      <td>${numberValue(row.hop_records).toLocaleString("en-US")}</td>
      <td>${escapeHtml(row.notes)}</td>
    </tr>`).join("");
  const intMcRows = rows
    .filter((row) => row.method_id === "int-mc-selected-probe")
    .map((row) => `<tr>
      <td>${escapeHtml(row.constellation_short_label)}</td>
      <td>${formatPercent(row.active_link_direct_coverage)}</td>
      <td>${formatPercent(row.active_link_effective_coverage)}</td>
      <td>${formatPercent(row.coverage_gain_from_inference)}</td>
      <td>${row.int_mc_utilization_inferred_mae === "" ? "-" : Number(row.int_mc_utilization_inferred_mae).toFixed(4)}</td>
      <td>${row.int_mc_latency_inferred_mae_ms === "" ? "-" : Number(row.int_mc_latency_inferred_mae_ms).toFixed(4)}</td>
      <td>${formatBytes(row.total_telemetry_generated_bytes)}</td>
    </tr>`).join("");
  const downloadRows = Object.entries(outputFiles)
    .map(([label, path]) => `<li><a href="${escapeHtml(relativePath(outputDir, path))}">${escapeHtml(label)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>实验2：三星座 INT 采样基线对比</title>
  <style>
    :root { color-scheme: light; --ink:#102033; --muted:#667085; --line:#d9e2ec; --bg:#f6f8fb; --card:#ffffff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, "Microsoft YaHei", sans-serif; color:var(--ink); background:var(--bg); }
    header { padding:30px 36px 18px; background:#ffffff; border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
    h1 { margin:0 0 8px; font-size:28px; }
    h2 { margin:26px 0 12px; font-size:21px; }
    h3 { margin:4px 0 8px; font-size:18px; }
    main { padding:22px 36px 42px; max-width:1280px; margin:0 auto; }
    .muted, .small { color:var(--muted); }
    .small { font-size:12px; line-height:1.45; }
    .cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .card, .panel { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    .metric { font-size:22px; font-weight:700; margin:8px 0; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .panel svg { width:100%; height:auto; display:block; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); }
    th, td { padding:9px 10px; border-bottom:1px solid var(--line); text-align:right; font-size:13px; vertical-align:top; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:last-child, td:last-child { text-align:left; }
    th { background:#eef3f8; font-weight:700; position:sticky; top:92px; z-index:2; }
    code { background:#eef3f8; padding:2px 5px; border-radius:4px; }
    ul { margin-top:8px; }
    @media (max-width: 900px) { .cards, .grid { grid-template-columns:1fr; } header { position:static; } th { position:static; } }
  </style>
</head>
<body>
  <header>
    <h1>实验2：三星座原生 INT 与 INT-MC 采样基线对比</h1>
    <div class="muted">生成时间：${escapeHtml(summary.generated_at)} ｜ 时间片：${summary.slices} ｜ 目标活动链路采样率：${formatPercent(summary.target_active_link_coverage)} ｜ 方法：traffic-int / full probe-int / shortest-path probe / random sampling / INT-MC selected probe</div>
  </header>
  <main>
    <section class="cards">${cards}</section>

    <h2>实验原则</h2>
    <div class="panel">
      <p>本实验固定第一阶段星座真值，只改变第二阶段遥测采样策略。采样层只能通过业务路径或 probe 路径获得节点与链路状态；第一阶段真值只用于实验后误差检验和覆盖率统计。</p>
      <p>为避免夸大 INT-MC，报告同时给出 <code>活动链路直接观测覆盖率</code> 和 <code>活动链路有效覆盖率</code>。前者表示 probe 实际采到多少活动链路，后者表示经过 Ground OAM / INT-MC 重构后可用于全网感知的活动链路比例。</p>
    </div>

    <h2>总体可视化</h2>
    <div class="grid">
      <div class="panel">${svgGroupedBar({ rows, field: "active_link_effective_coverage", title: "三种星座下的活动链路有效覆盖率", formatter: (value) => formatPercent(value), maxValue: 1 })}</div>
      <div class="panel">${svgGroupedBar({ rows, field: "telemetry_bytes_per_node_slice", title: "每节点每时间片遥测字节开销（log）", formatter: formatBytes, logScale: true })}</div>
    </div>
    <div class="panel" style="margin-top:16px">${svgScatter({ rows })}</div>
    <div class="panel" style="margin-top:16px">${svgHeatmap({ rows: perSliceRows })}</div>

    <h2>方法汇总表</h2>
    <table>
      <thead><tr><th>星座</th><th>方法</th><th>节点覆盖</th><th>活动链路直接观测</th><th>活动链路有效覆盖</th><th>INT-MC 推断占比</th><th>总遥测字节</th><th>字节/节点/片</th><th>能耗 J</th><th>Hop records</th><th>说明</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>

    <h2>INT-MC 诊断</h2>
    <table>
      <thead><tr><th>星座</th><th>直接观测</th><th>有效覆盖</th><th>补全带来的覆盖增益</th><th>利用率推断 MAE</th><th>时延推断 MAE(ms)</th><th>遥测字节</th></tr></thead>
      <tbody>${intMcRows}</tbody>
    </table>

    <h2>输出文件</h2>
    <div class="panel">
      <ul>${downloadRows}</ul>
    </div>
  </main>
</body>
</html>`;
}

function buildMarkdownReport({ summary, rows, outputFiles }) {
  const lines = [
    "# 实验2：三星座 INT 采样基线对比",
    "",
    `生成时间：${summary.generated_at}`,
    "",
    "## 实验目的",
    "",
    "将 traffic-int、full probe-int、shortest-path probe、random sampling 与 INT-MC selected probe 应用于小/中/大三个星座，形成可调试、可复现、可公平比较的原生 INT 基线结果。",
    "",
    "## 核心指标",
    "",
    "- 活动链路直接观测覆盖率：probe 或业务流实际经过并采集到的活动链路比例。",
    "- 活动链路有效覆盖率：直接观测链路加上 Ground OAM / INT-MC 可重构链路后的覆盖比例。",
    "- 遥测开销：INT metadata、report、probe 基础字节合计。",
    "- 单位规模开销：总遥测字节除以节点数和时间片数，便于跨星座比较。",
    "",
    "## 汇总",
    "",
    "| 星座 | 方法 | 直接观测 | 有效覆盖 | 字节/节点/片 | 总遥测字节 |",
    "|---|---|---:|---:|---:|---:|",
    ...rows
      .sort((left, right) => PROFILE_CATALOG.findIndex((profile) => profile.id === left.constellation_profile_id) - PROFILE_CATALOG.findIndex((profile) => profile.id === right.constellation_profile_id) || methodSort(left, right))
      .map((row) => `| ${row.constellation_short_label} | ${row.method_label} | ${formatPercent(row.active_link_direct_coverage)} | ${formatPercent(row.active_link_effective_coverage)} | ${formatBytes(row.telemetry_bytes_per_node_slice)} | ${formatBytes(row.total_telemetry_generated_bytes)} |`),
    "",
    "## 输出",
    "",
    ...Object.entries(outputFiles).map(([label, path]) => `- ${label}: \`${path}\``),
  ];
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const outputDir = resolve(argValue(args, "--out", "reports/experiment2-constellation-comparison"));
const selectedProfileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
const slices = Math.max(1, Math.floor(numberArg(args, "--slices", 48)));
const trafficProfile = argValue(args, "--traffic-profile", argValue(args, "--profile", "normal"));
const routing = argValue(args, "--routing", "congestion-aware-shortest-path");
const targetActiveLinkCoverage = Math.max(0.01, Math.min(1, numberArg(args, "--target-active-link-coverage", 0.25)));
const randomSeeds = argValue(args, "--random-seeds", "11,23,37");
const includeIntMc = argValue(args, "--include-int-mc", "true").toLowerCase() !== "false";
const intMcSamplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-sampling-rate", targetActiveLinkCoverage)));
const intMcTargetActiveLinkSamplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-target-active-link-sampling-rate", intMcSamplingRate)));
const intMcRank = Math.max(1, Math.floor(numberArg(args, "--int-mc-rank", 5)));
const intMcWindowSize = Math.max(1, Math.floor(numberArg(args, "--int-mc-window-size", 12)));
const intMcWarmupSlices = Math.max(1, Math.floor(numberArg(args, "--int-mc-warmup-slices", 6)));
const intMcIterations = Math.max(1, Math.floor(numberArg(args, "--int-mc-iterations", 12)));
const intMcMaxPathsPerSlice = Math.max(1, Math.floor(numberArg(args, "--int-mc-max-paths-per-slice", 12)));
const downlinkBudgetBytes = Math.max(0, Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000)));
const skipExisting = hasArg(args, "--skip-existing");

const selectedProfiles = selectedProfileIds.map((id) => {
  const profile = PROFILE_CATALOG.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown constellation profile: ${id}`);
  return profile;
});

await mkdir(outputDir, { recursive: true });
const allRows = [];
const allPerSliceRows = [];
const runOutputs = [];

for (const profile of selectedProfiles) {
  const profileDir = join(outputDir, profile.id);
  const truthDir = join(profileDir, "stage1-truth");
  const baselineDir = join(profileDir, "experiment2");
  await mkdir(profileDir, { recursive: true });

  const metadataPath = join(truthDir, "metadata.json");
  if (!skipExisting || !existsSync(metadataPath)) {
    await runNode(`export stage1 truth for ${profile.short_label}`, "scripts/exportScenario.mjs", [
      "--constellation-profile", profile.id,
      "--profile", trafficProfile,
      "--orbit", "real-tle-sgp4",
      "--mode", "operational",
      "--routing", routing,
      "--slices", String(slices),
      "--out", truthDir,
    ]);
  }

  const summaryPath = join(baselineDir, "experiment2-baseline-summary.csv");
  if (!skipExisting || !existsSync(summaryPath)) {
    await runNode(`run experiment2 baselines for ${profile.short_label}`, "scripts/runExperiment2NativeIntBaselines.mjs", [
      "--input", truthDir,
      "--out", baselineDir,
      "--target-active-link-coverage", String(targetActiveLinkCoverage),
      "--random-seeds", randomSeeds,
      "--downlink-budget-bytes", String(downlinkBudgetBytes),
      "--include-int-mc", String(includeIntMc),
      "--int-mc-sampling-rate", String(intMcSamplingRate),
      "--int-mc-target-active-link-sampling-rate", String(intMcTargetActiveLinkSamplingRate),
      "--int-mc-rank", String(intMcRank),
      "--int-mc-window-size", String(intMcWindowSize),
      "--int-mc-warmup-slices", String(intMcWarmupSlices),
      "--int-mc-iterations", String(intMcIterations),
      "--int-mc-max-paths-per-slice", String(intMcMaxPathsPerSlice),
    ]);
  }

  const reportJsonPath = join(baselineDir, "experiment2-native-int-baselines-report.json");
  const report = await readJson(reportJsonPath);
  const summaryRows = await readCsv(summaryPath);
  const perSliceRows = await readCsv(join(baselineDir, "experiment2-coverage-by-slice.csv"));
  const normalizedRows = summaryRows.map((row) => normalizeSummaryRow(row, profile, report, baselineDir));
  allRows.push(...normalizedRows);
  allPerSliceRows.push(...perSliceRows.map((row) => normalizePerSliceRow(row, profile)));
  runOutputs.push({
    constellation_profile_id: profile.id,
    constellation_short_label: profile.short_label,
    truth_dir: truthDir,
    baseline_dir: baselineDir,
    baseline_report_html: join(baselineDir, "experiment2-native-int-baselines-report.html"),
    baseline_report_json: reportJsonPath,
    method_count: normalizedRows.length,
    mean_effective_coverage: round(mean(normalizedRows.map((row) => numberValue(row.active_link_effective_coverage, NaN)).filter(Number.isFinite))),
    mean_bytes_per_node_slice: round(mean(normalizedRows.map((row) => numberValue(row.telemetry_bytes_per_node_slice, NaN)).filter(Number.isFinite)), 4),
  });
}

const summary = {
  schema_version: "experiment2-constellation-comparison-v1",
  generated_at: new Date().toISOString(),
  objective: "Apply native INT baselines and project INT-MC selected probe to small/medium/large LEO constellation profiles and generate fair visual comparison artifacts.",
  profiles: selectedProfiles.map((profile) => profile.id),
  slices,
  traffic_profile: trafficProfile,
  routing,
  target_active_link_coverage: targetActiveLinkCoverage,
  random_seeds: randomSeeds,
  include_int_mc: includeIntMc,
  int_mc_sampling_rate: intMcSamplingRate,
  int_mc_target_active_link_sampling_rate: intMcTargetActiveLinkSamplingRate,
  int_mc_max_paths_per_slice: intMcMaxPathsPerSlice,
  downlink_budget_bytes: downlinkBudgetBytes,
  outputs_by_profile: runOutputs,
};

const outputFiles = {
  summary_csv: join(outputDir, "experiment2-constellation-method-summary.csv"),
  per_slice_csv: join(outputDir, "experiment2-constellation-coverage-by-slice.csv"),
  summary_json: join(outputDir, "experiment2-constellation-method-summary.json"),
  report_md: join(outputDir, "experiment2-constellation-comparison.md"),
  report_html: join(outputDir, "experiment2-constellation-comparison.html"),
};

await Promise.all([
  writeFile(outputFiles.summary_csv, rowsToCsv(allRows), "utf8"),
  writeFile(outputFiles.per_slice_csv, rowsToCsv(allPerSliceRows), "utf8"),
  writeFile(outputFiles.summary_json, JSON.stringify({ ...summary, rows: allRows, per_slice: allPerSliceRows, output_files: outputFiles }, null, 2), "utf8"),
  writeFile(outputFiles.report_md, buildMarkdownReport({ summary, rows: allRows, outputFiles }), "utf8"),
  writeFile(outputFiles.report_html, buildHtmlReport({ summary, rows: allRows, perSliceRows: allPerSliceRows, outputFiles, outputDir }), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  reportHtml: outputFiles.report_html,
  reportMd: outputFiles.report_md,
  summaryCsv: outputFiles.summary_csv,
  perSliceCsv: outputFiles.per_slice_csv,
  profiles: runOutputs,
  methodRows: allRows.length,
  perSliceRows: allPerSliceRows.length,
}, null, 2));
