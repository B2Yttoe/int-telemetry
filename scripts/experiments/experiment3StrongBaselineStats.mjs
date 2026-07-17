import { createHash } from "node:crypto";

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length > 0
    ? usable.reduce((total, value) => total + value, 0) / usable.length
    : 0;
}

function percentile(values, quantile) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (usable.length === 0) return 0;
  const position = Math.max(0, Math.min(1, quantile)) * (usable.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (position - lower);
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function splitPath(value) {
  return String(value ?? "")
    .split(/\s+>\s+|\s*\|\s*|\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededShuffle(rows, seed) {
  return [...rows].sort((left, right) => {
    const leftScore = stableHash(`${seed}|${left.slice_index}|${left.probe_id}|${left.path}|${left.link_ids}`);
    const rightScore = stableHash(`${seed}|${right.slice_index}|${right.probe_id}|${right.path}|${right.link_ids}`);
    return leftScore - rightScore || String(left.probe_id).localeCompare(String(right.probe_id));
  });
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

export function buildSeededPathPlan({
  candidatePaths,
  truthLinks,
  pathLinkBudgetBySlice,
  seed,
  algorithm,
}) {
  const activeBySlice = new Map();
  truthLinks.forEach((link) => {
    const sliceIndex = String(link.slice_index);
    if (!activeBySlice.has(sliceIndex)) activeBySlice.set(sliceIndex, new Set());
    if (["true", "1", "yes", "up"].includes(String(link.is_active).toLowerCase())) {
      activeBySlice.get(sliceIndex).add(link.link_id);
    }
  });
  const candidatesBySlice = groupBy(candidatePaths, (row) => String(row.slice_index));
  const selectedRows = [];
  const summaryRows = [];

  [...activeBySlice.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .forEach(([sliceIndex, activeLinks]) => {
      const budget = Math.max(1, Math.floor(numberValue(pathLinkBudgetBySlice.get(sliceIndex), 1)));
      const ordered = seededShuffle(candidatesBySlice.get(sliceIndex) ?? [], seed);
      const selected = [];
      const covered = new Set();
      let consumedPathLinks = 0;

      for (const candidate of ordered) {
        const linkIds = splitPath(candidate.link_ids);
        const pathLinks = Math.max(1, Math.floor(numberValue(candidate.path_link_count, linkIds.length)));
        if (selected.length > 0 && consumedPathLinks + pathLinks > budget) continue;
        selected.push(candidate);
        consumedPathLinks += pathLinks;
        linkIds.forEach((linkId) => {
          if (activeLinks.has(linkId)) covered.add(linkId);
        });
        if (consumedPathLinks >= budget) break;
      }

      selected.forEach((row, index) => {
        const path = splitPath(row.path);
        const linkIds = splitPath(row.link_ids);
        selectedRows.push({
          ...row,
          probe_id: `${algorithm}-${String(sliceIndex).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
          planning_algorithm: algorithm,
          source: path[0] ?? row.source ?? "",
          sink: path.at(-1) ?? row.sink ?? "",
          path_node_count: path.length,
          path_link_count: linkIds.length,
          covered_link_count: new Set(linkIds).size,
          path: path.join(" > "),
          link_ids: linkIds.join(" > "),
          experiment3_observation_seed: seed,
        });
      });

      summaryRows.push({
        slice_index: Number(sliceIndex),
        random_seed: seed,
        path_link_budget: budget,
        selected_paths: selected.length,
        selected_path_links: consumedPathLinks,
        budget_fill_ratio: round(consumedPathLinks / Math.max(budget, 1)),
        active_links: activeLinks.size,
        sampled_active_links: covered.size,
        planned_active_link_coverage: round(covered.size / Math.max(activeLinks.size, 1)),
      });
    });

  return { selectedRows, summaryRows };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapSeed(text) {
  const digest = createHash("sha256").update(String(text)).digest();
  return digest.readUInt32LE(0);
}

export function pairedMovingBlockBootstrap({
  pairs,
  blockLength = 4,
  iterations = 4000,
  seed = "experiment3-paired-block-bootstrap",
}) {
  const byRun = groupBy(pairs, (pair) => String(pair.run_id));
  const runSeries = [...byRun.values()]
    .map((rows) => rows
      .filter((row) => Number.isFinite(numberValue(row.delta, NaN)))
      .sort((left, right) => numberValue(left.slice_index) - numberValue(right.slice_index)))
    .filter((rows) => rows.length > 0);
  const observed = mean(runSeries.flatMap((rows) => rows.map((row) => numberValue(row.delta, NaN))));
  if (runSeries.length === 0) {
    return {
      paired_samples: 0,
      run_count: 0,
      block_length: blockLength,
      iterations,
      mean_delta: "",
      ci95_low: "",
      ci95_high: "",
      probability_improved: "",
    };
  }

  const random = mulberry32(bootstrapSeed(seed));
  const bootstrapMeans = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampledDeltas = [];
    runSeries.forEach((series) => {
      const needed = series.length;
      let sampledForRun = 0;
      while (sampledForRun < needed) {
        const start = Math.floor(random() * series.length);
        for (let offset = 0; offset < blockLength; offset += 1) {
          const source = series[(start + offset) % series.length];
          sampledDeltas.push(numberValue(source.delta, NaN));
          sampledForRun += 1;
          if (sampledForRun >= needed) break;
        }
      }
    });
    bootstrapMeans.push(mean(sampledDeltas));
  }

  return {
    paired_samples: runSeries.reduce((total, rows) => total + rows.length, 0),
    run_count: runSeries.length,
    block_length: blockLength,
    iterations,
    mean_delta: round(observed),
    ci95_low: round(percentile(bootstrapMeans, 0.025)),
    ci95_high: round(percentile(bootstrapMeans, 0.975)),
    probability_improved: round(bootstrapMeans.filter((value) => value < 0).length / bootstrapMeans.length),
  };
}

export function pairedWinTieLoss(pairs, epsilon = 1e-9) {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  pairs.forEach((pair) => {
    const delta = numberValue(pair.delta, NaN);
    if (!Number.isFinite(delta)) return;
    if (delta < -epsilon) wins += 1;
    else if (delta > epsilon) losses += 1;
    else ties += 1;
  });
  return { wins, ties, losses, total: wins + ties + losses };
}

export function hashObservationMask(rows, idField) {
  const projection = rows
    .map((row) => `${row.slice_index}|${row[idField]}|${String(row.observed).toLowerCase()}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(projection).digest("hex");
}
