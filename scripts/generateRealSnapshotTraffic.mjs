import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const snapshotPath = resolve(argValue(args, "--snapshot", "data/tle-snapshots/celestrak-starlink-main-550km-53deg-walker-47x14.json"));
const outPath = resolve(argValue(args, "--out", "examples/datasets/real-starlink-main-47x14-ml-48-traffic.csv"));
const slices = Number(argValue(args, "--slices", "48"));
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const planes = snapshot.layout.planes;
const slots = snapshot.layout.satellites_per_plane;

const nodeId = (plane, slot) => `P${String(((plane % planes) + planes) % planes + 1).padStart(2, "0")}-S${String(((slot % slots) + slots) % slots + 1).padStart(2, "0")}`;

const rows = [];
function add(row) {
  if (row.source && row.target && row.source === row.target) {
    const match = /^P(\d+)-S(\d+)$/.exec(row.target);
    if (match) {
      const targetPlane = Number(match[1]) - 1;
      const targetSlot = Number(match[2]) % slots;
      row.target = nodeId(targetPlane, targetSlot);
    }
  }
  rows.push({
    task_id: row.task_id,
    time: `T${String(row.start_slice).padStart(2, "0")}`,
    start_slice: row.start_slice,
    duration_slices: row.duration_slices,
    source: row.source ?? "",
    target: row.target ?? "",
    node_id: row.node_id ?? "",
    compute_units: row.compute_units ?? 0,
    gpu_units: row.gpu_units ?? 0,
    memory_gb: row.memory_gb ?? 0,
    storage_gb: row.storage_gb ?? 0,
    traffic_mbps: row.traffic_mbps ?? 0,
    priority: row.priority ?? 3,
    task_type: row.task_type,
  });
}

// Long-lived backbone and telemetry flows spread across the full shell.
for (let index = 0; index < 18; index += 1) {
  const sourcePlane = Math.floor((index * planes) / 18);
  const targetPlane = (sourcePlane + Math.floor(planes / 2) + (index % 5)) % planes;
  const sourceSlot = (index * 3) % slots;
  const targetSlot = (sourceSlot + Math.floor(slots / 2) + index) % slots;
  add({
    task_id: `REAL-LONG-${String(index + 1).padStart(2, "0")}`,
    start_slice: 0,
    duration_slices: slices,
    source: nodeId(sourcePlane, sourceSlot),
    target: nodeId(targetPlane, targetSlot),
    compute_units: 18 + (index % 4) * 4,
    memory_gb: 6 + (index % 3) * 2,
    storage_gb: 24 + (index % 5) * 8,
    traffic_mbps: 260 + (index % 6) * 90,
    priority: 2 + (index % 3),
    task_type: index % 3 === 0 ? "telemetry" : "background",
  });
}

// Periodic OAM/telemetry collection windows.
for (let start = 0; start < slices; start += 4) {
  for (let lane = 0; lane < 6; lane += 1) {
    const sourcePlane = (lane * 11 + start) % planes;
    const targetPlane = (sourcePlane + 9 + lane * 3) % planes;
    const sourceSlot = (start / 4 + lane * 2) % slots;
    const targetSlot = (sourceSlot + 7 + lane) % slots;
    add({
      task_id: `REAL-PER-${String(start).padStart(2, "0")}-${lane + 1}`,
      start_slice: start,
      duration_slices: 3,
      source: nodeId(sourcePlane, sourceSlot),
      target: nodeId(targetPlane, targetSlot),
      compute_units: 10 + lane * 2,
      memory_gb: 3 + lane,
      storage_gb: 12 + lane * 4,
      traffic_mbps: 180 + lane * 70,
      priority: lane < 2 ? 1 : 3,
      task_type: "telemetry",
    });
  }
}

// Multi-batch bursts around four event windows.
[6, 18, 30, 40].forEach((start, burstIndex) => {
  for (let lane = 0; lane < 12; lane += 1) {
    const sourcePlane = (burstIndex * 17 + lane * 5) % planes;
    const targetPlane = (sourcePlane + 16 + burstIndex * 3 + lane) % planes;
    const sourceSlot = (lane * 2 + burstIndex) % slots;
    const targetSlot = (sourceSlot + 5 + burstIndex + lane) % slots;
    add({
      task_id: `REAL-BURST-${String(start).padStart(2, "0")}-${String(lane + 1).padStart(2, "0")}`,
      start_slice: start,
      duration_slices: 4 + (lane % 3),
      source: nodeId(sourcePlane, sourceSlot),
      target: nodeId(targetPlane, targetSlot),
      compute_units: 24 + lane * 3,
      memory_gb: 8 + (lane % 5) * 2,
      storage_gb: 32 + (lane % 6) * 8,
      traffic_mbps: 520 + lane * 95,
      priority: lane < 3 ? 1 : lane < 8 ? 2 : 4,
      task_type: lane % 4 === 0 ? "burst" : "mixed",
    });
  }
});

// Local compute and cache pressure across representative planes.
for (let index = 0; index < 36; index += 1) {
  const plane = (index * 7) % planes;
  const slot = (index * 5) % slots;
  const durationSlices = 5 + (index % 4);
  add({
    task_id: `REAL-COMP-${String(index + 1).padStart(2, "0")}`,
    start_slice: (index * 3) % Math.max(1, slices - durationSlices),
    duration_slices: durationSlices,
    node_id: nodeId(plane, slot),
    compute_units: 36 + (index % 8) * 6,
    gpu_units: index % 5 === 0 ? 2 : 0,
    memory_gb: 10 + (index % 6) * 3,
    storage_gb: 48 + (index % 7) * 12,
    priority: 2 + (index % 3),
    task_type: "compute",
  });
}

const header = [
  "task_id",
  "time",
  "start_slice",
  "duration_slices",
  "source",
  "target",
  "node_id",
  "compute_units",
  "gpu_units",
  "memory_gb",
  "storage_gb",
  "traffic_mbps",
  "priority",
  "task_type",
];
const csv = [
  header.join(","),
  ...rows.map((row) => header.map((key) => row[key]).join(",")),
].join("\n");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${csv}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      snapshot: snapshotPath,
      out: outPath,
      tasks: rows.length,
      routedTasks: rows.filter((row) => row.source && row.target).length,
      localTasks: rows.filter((row) => row.node_id).length,
      totalTrafficMbps: rows.reduce((sum, row) => sum + Number(row.traffic_mbps || 0), 0),
      planes,
      satellitesPerPlane: slots,
      slices,
    },
    null,
    2,
  ),
);
