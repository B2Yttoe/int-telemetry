import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
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

function boolValue(value) {
  return String(value).toLowerCase() === "true";
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
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function splitPath(value) {
  return String(value || "")
    .split(">")
    .map((item) => item.trim())
    .filter(Boolean);
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

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / Math.max(left.size + right.size - intersection, 1);
}

function normalizeVector(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  const avg = mean(finite);
  const variance = mean(finite.map((value) => (value - avg) ** 2));
  const std = Math.sqrt(variance) || 1;
  return values.map((value) => (Number.isFinite(value) ? (value - avg) / std : 0));
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => row.reduce((total, value, index) => total + value * vector[index], 0));
}

function dot(left, right) {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function norm(vector) {
  return Math.sqrt(dot(vector, vector));
}

function topEigenvectorsSymmetric(matrix, rank) {
  const size = matrix.length;
  if (size === 0) return [];
  const working = matrix.map((row) => [...row]);
  const vectors = [];

  for (let component = 0; component < Math.min(rank, size); component += 1) {
    let vector = Array.from({ length: size }, (_, index) => Math.cos((index + 1) * (component + 1)));
    let vectorNorm = norm(vector) || 1;
    vector = vector.map((value) => value / vectorNorm);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      let next = multiplyMatrixVector(working, vector);
      vectors.forEach((old) => {
        const projection = dot(next, old.vector);
        next = next.map((value, index) => value - projection * old.vector[index]);
      });
      vectorNorm = norm(next);
      if (vectorNorm < 1e-10) break;
      vector = next.map((value) => value / vectorNorm);
    }

    const mv = multiplyMatrixVector(working, vector);
    const eigenvalue = dot(vector, mv);
    if (!Number.isFinite(eigenvalue) || eigenvalue <= 1e-8) break;
    vectors.push({ vector, eigenvalue });

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        working[row][col] -= eigenvalue * vector[row] * vector[col];
      }
    }
  }

  return vectors;
}

function buildContactPlan({ linksBySlice, sliceIndexes, classThreshold }) {
  const classes = [];
  const perSlice = [];

  sliceIndexes.forEach((sliceIndex) => {
    const links = linksBySlice.get(sliceIndex) ?? [];
    const activeLinks = links.filter((link) => boolValue(link.is_active));
    const activeSet = new Set(activeLinks.map((link) => link.link_id));
    const signature = hashText([...activeSet].sort().join("|"));
    let contactClass = classes.find((item) => 1 - jaccard(item.prototypeActiveSet, activeSet) <= classThreshold);
    if (!contactClass) {
      contactClass = {
        class_id: `TC-${String(classes.length + 1).padStart(3, "0")}`,
        prototype_signature: signature,
        prototypeActiveSet: new Set(activeSet),
        slices: [],
      };
      classes.push(contactClass);
    }
    contactClass.slices.push(Number(sliceIndex));
    perSlice.push({
      slice_index: Number(sliceIndex),
      time: links[0]?.time ?? "",
      topology_class_id: contactClass.class_id,
      active_link_count: activeSet.size,
      active_intra_links: activeLinks.filter((link) => link.kind === "intra-plane").length,
      active_inter_links: activeLinks.filter((link) => link.kind === "inter-plane").length,
      signature,
      activeSet,
    });
  });

  return {
    perSlice,
    classes: classes.map((item) => ({
      class_id: item.class_id,
      prototype_signature: item.prototype_signature,
      slice_count: item.slices.length,
      slices: item.slices,
      prototype_active_links: item.prototypeActiveSet.size,
    })),
  };
}

function buildLeverageScores({ linksById, sliceIndexes, rank }) {
  const linkIds = [...linksById.keys()].sort();
  const latencyValues = [];
  const distanceValues = [];
  const capacityValues = [];

  linkIds.forEach((linkId) => {
    const bySlice = linksById.get(linkId);
    sliceIndexes.forEach((sliceIndex) => {
      const link = bySlice.get(sliceIndex);
      if (!link || !boolValue(link.is_active)) return;
      latencyValues.push(numberValue(link.latency_ms));
      distanceValues.push(numberValue(link.distance_km));
      capacityValues.push(numberValue(link.effective_capacity_mbps || link.capacity_mbps));
    });
  });

  const latencyNorm = normalizeVector(latencyValues);
  const distanceNorm = normalizeVector(distanceValues);
  const capacityNorm = normalizeVector(capacityValues);
  let cursor = 0;
  const rows = [];
  const transitionRate = new Map();

  linkIds.forEach((linkId) => {
    const bySlice = linksById.get(linkId);
    const values = [];
    let previousActive = null;
    let transitions = 0;
    sliceIndexes.forEach((sliceIndex) => {
      const link = bySlice.get(sliceIndex);
      const active = link ? boolValue(link.is_active) : false;
      if (previousActive !== null && previousActive !== active) transitions += 1;
      previousActive = active;
      if (!active) {
        values.push(0);
        return;
      }
      const value =
        1 +
        0.2 * (latencyNorm[cursor] ?? 0) +
        0.15 * (distanceNorm[cursor] ?? 0) -
        0.1 * (capacityNorm[cursor] ?? 0);
      cursor += 1;
      values.push(value);
    });
    transitionRate.set(linkId, transitions / Math.max(sliceIndexes.length - 1, 1));
    rows.push(values);
  });

  const columns = sliceIndexes.length;
  const covariance = Array.from({ length: columns }, () => Array.from({ length: columns }, () => 0));
  rows.forEach((row) => {
    for (let left = 0; left < columns; left += 1) {
      for (let right = left; right < columns; right += 1) {
        covariance[left][right] += row[left] * row[right];
      }
    }
  });
  for (let left = 0; left < columns; left += 1) {
    for (let right = 0; right < left; right += 1) {
      covariance[left][right] = covariance[right][left];
    }
  }

  const components = topEigenvectorsSymmetric(covariance, rank);
  const scores = new Map();
  const rawScores = rows.map((row) => {
    if (components.length === 0) return 1;
    return components.reduce((total, component) => {
      const projection = dot(row, component.vector);
      return total + (projection * projection) / Math.max(component.eigenvalue, 1e-8);
    }, 0);
  });
  const avgScore = mean(rawScores) || 1;
  rawScores.forEach((score, index) => {
    const linkId = linkIds[index];
    scores.set(linkId, {
      leverage: Math.max(0.05, score / avgScore),
      transition_rate: transitionRate.get(linkId) ?? 0,
    });
  });
  return scores;
}

function buildLinksById(links) {
  const map = new Map();
  links.forEach((link) => {
    if (!map.has(link.link_id)) map.set(link.link_id, new Map());
    map.get(link.link_id).set(String(link.slice_index), link);
  });
  return map;
}

function activeLinkIdsForPath(path, activeSet) {
  return splitPath(path.link_ids).filter((linkId, index, list) => linkId && activeSet.has(linkId) && list.indexOf(linkId) === index);
}

function selectSlicePaths({
  slicePosition,
  slicePlan,
  candidatePaths,
  linksBySliceAndId,
  leverageScores,
  selectedLastSeen,
  algorithm,
  samplingRate,
  targetActiveLinkSamplingRate,
  minPaths,
  maxPaths,
  warmupSlices,
  windowSize,
}) {
  if (candidatePaths.length === 0) return { rows: [], summary: null };
  const activeLinks = [...slicePlan.activeSet];
  const activeSet = slicePlan.activeSet;
  const targetCoveredLinks = Math.ceil(activeLinks.length * targetActiveLinkSamplingRate);
  const basePathCount = Math.ceil(candidatePaths.length * samplingRate);
  const requestedPathCount = Math.max(minPaths, basePathCount);
  const selectedLimit = Math.min(maxPaths > 0 ? maxPaths : candidatePaths.length, candidatePaths.length);

  const scored = candidatePaths.map((path, index) => {
    const pathLinks = activeLinkIdsForPath(path, activeSet);
    const linkScores = pathLinks.map((linkId) => {
      const score = leverageScores.get(linkId) ?? { leverage: 1, transition_rate: 0 };
      const row = linksBySliceAndId.get(`${path.slice_index}|${linkId}`);
      const kindBonus = row?.kind === "inter-plane" ? 0.35 : row?.kind === "star-ground" ? 0.25 : 0;
      const stale = slicePosition - (selectedLastSeen.get(linkId) ?? -Infinity);
      const staleBonus = !Number.isFinite(stale) || stale > windowSize ? 0.75 : Math.max(0, stale / Math.max(windowSize, 1)) * 0.35;
      return score.leverage + score.transition_rate * 0.8 + kindBonus + staleBonus;
    });
    const lengthPenalty = Math.log2(Math.max(numberValue(path.path_link_count, pathLinks.length), 1) + 1) * 0.04;
    const diversity = pathLinks.filter((linkId) => !selectedLastSeen.has(linkId)).length / Math.max(pathLinks.length, 1);
    const warmupBoost = slicePosition < warmupSlices ? diversity * 2 : 0;
    return {
      path,
      index,
      pathLinks,
      score: mean(linkScores) + diversity * 0.6 + warmupBoost - lengthPenalty,
    };
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  const covered = new Set();

  for (const item of scored) {
    if (selected.length >= selectedLimit) break;
    const addsCoverage = item.pathLinks.some((linkId) => !covered.has(linkId));
    if (selected.length < requestedPathCount || (covered.size < targetCoveredLinks && addsCoverage)) {
      selected.push(item);
      item.pathLinks.forEach((linkId) => covered.add(linkId));
    }
  }

  selected.forEach((item) => item.pathLinks.forEach((linkId) => selectedLastSeen.set(linkId, slicePosition)));

  const rows = selected.map((item, index) => ({
    ...item.path,
    probe_id: `${algorithm}-${String(slicePlan.slice_index).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
    planning_algorithm: algorithm,
    source_candidate_probe_id: item.path.probe_id,
    source_candidate_algorithm: item.path.planning_algorithm,
    topology_class_id: slicePlan.topology_class_id,
    int_mc_score: round(item.score),
    sampling_rate: samplingRate,
    target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    selection_reason: slicePosition < warmupSlices ? "warmup-diversity" : "leverage-contact-plan",
  }));

  return {
    rows,
    summary: {
      slice_index: slicePlan.slice_index,
      time: slicePlan.time,
      topology_class_id: slicePlan.topology_class_id,
      candidate_paths: candidatePaths.length,
      selected_paths: rows.length,
      active_links: activeLinks.length,
      sampled_active_links: covered.size,
      active_link_sampling_coverage: round(covered.size / Math.max(activeLinks.length, 1)),
      mean_selected_score: round(mean(selected.map((item) => item.score))),
      warmup: slicePosition < warmupSlices,
    },
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const candidateAlgorithm = argValue(args, "--candidate-algorithm", "path-balance");
const algorithm = argValue(args, "--algorithm", "int-mc");
const samplingRate = numberArg(args, "--sampling-rate", 0.25);
const targetActiveLinkSamplingRate = numberArg(args, "--target-active-link-sampling-rate", samplingRate);
const warmupSlices = numberArg(args, "--warmup-slices", 3);
const windowSize = numberArg(args, "--window-size", 12);
const rank = numberArg(args, "--rank", 5);
const minPaths = numberArg(args, "--min-paths-per-slice", 1);
const maxPaths = numberArg(args, "--max-paths-per-slice", 0);
const topologyClassThreshold = numberArg(args, "--topology-class-threshold", 0.08);

const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const candidatePathsPath = resolve(
  argValue(args, "--candidate-paths", join(stage2Dir, `probe-paths-${candidateAlgorithm}.csv`)),
);

requireFile(linksPath, "links.csv");
requireFile(candidatePathsPath, "candidate probe paths");

const [links, candidatePaths] = await Promise.all([readCsv(linksPath), readCsv(candidatePathsPath)]);
const linksBySlice = groupBy(links, (link) => String(link.slice_index));
const pathsBySlice = groupBy(candidatePaths, (path) => String(path.slice_index));
const linksBySliceAndId = indexBy(links, (link) => `${link.slice_index}|${link.link_id}`);
const sliceIndexes = [...linksBySlice.keys()].sort((left, right) => Number(left) - Number(right));
const linksById = buildLinksById(links);
const contactPlan = buildContactPlan({ linksBySlice, sliceIndexes, classThreshold: topologyClassThreshold });
const leverageScores = buildLeverageScores({ linksById, sliceIndexes, rank });
const selectedLastSeen = new Map();
const selectedRows = [];
const summaryRows = [];

contactPlan.perSlice.forEach((slicePlan, slicePosition) => {
  const result = selectSlicePaths({
    slicePosition,
    slicePlan,
    candidatePaths: pathsBySlice.get(String(slicePlan.slice_index)) ?? [],
    linksBySliceAndId,
    leverageScores,
    selectedLastSeen,
    algorithm,
    samplingRate,
    targetActiveLinkSamplingRate,
    minPaths,
    maxPaths,
    warmupSlices,
    windowSize,
  });
  selectedRows.push(...result.rows);
  if (result.summary) summaryRows.push(result.summary);
});

const activeLinkSamples = summaryRows.reduce((total, row) => total + row.active_links, 0);
const sampledActiveLinkSamples = summaryRows.reduce((total, row) => total + row.sampled_active_links, 0);
const report = {
  schema_version: "stage2-leo-int-mc-path-selection-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    links_csv: linksPath,
    candidate_paths_csv: candidatePathsPath,
    candidate_algorithm: candidateAlgorithm,
  },
  planning_algorithm: algorithm,
  method: {
    origin: "INT-MC path leverage sampling adapted for predictable LEO contact plans",
    satellite_adaptations: [
      "contact-plan topology classes from active link masks",
      "active topology mask separated from unobserved telemetry mask",
      "deterministic warmup instead of random sampling",
      "rolling stale-link bonus for dynamic LEO links",
      "path selection runs on ground-side planning data, not on satellites",
    ],
    mininet_code_not_ported: true,
  },
  parameters: {
    sampling_rate: samplingRate,
    target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    warmup_slices: warmupSlices,
    window_size: windowSize,
    rank,
    min_paths_per_slice: minPaths,
    max_paths_per_slice: maxPaths,
    topology_class_threshold: topologyClassThreshold,
  },
  contact_plan: {
    slice_count: contactPlan.perSlice.length,
    topology_class_count: contactPlan.classes.length,
    classes: contactPlan.classes,
  },
  coverage: {
    candidate_paths: candidatePaths.length,
    selected_paths: selectedRows.length,
    active_link_samples: activeLinkSamples,
    sampled_active_link_samples: sampledActiveLinkSamples,
    active_link_sampling_coverage: round(sampledActiveLinkSamples / Math.max(activeLinkSamples, 1)),
    mean_selected_paths_per_slice: round(mean(summaryRows.map((row) => row.selected_paths))),
  },
  per_slice: summaryRows,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, `probe-paths-${algorithm}.csv`), rowsToCsv(selectedRows), "utf8"),
  writeFile(join(outputDir, `probe-summary-${algorithm}.csv`), rowsToCsv(summaryRows), "utf8"),
  writeFile(join(outputDir, `probe-coverage-${algorithm}.json`), JSON.stringify(report, null, 2), "utf8"),
  writeFile(join(outputDir, `int-mc-contact-plan-${algorithm}.json`), JSON.stringify(contactPlan, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  candidateAlgorithm,
  slices: contactPlan.perSlice.length,
  topologyClasses: contactPlan.classes.length,
  candidatePaths: candidatePaths.length,
  selectedPaths: selectedRows.length,
  activeLinkSamplingCoverage: report.coverage.active_link_sampling_coverage,
  samplingRate,
  rank,
  windowSize,
}, null, 2));

