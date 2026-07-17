import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { writeProcessVisualizationJson } from "../stage2-int/tools/process-visualization-writer.mjs";
import { inspectProcessVisualizationJson } from "../stage2-int/tools/process-visualization-inspector.mjs";

const outputDir = resolve("stage2-int/runs/tmp-process-visualization-writer-test");
const outputPath = resolve(outputDir, "process.json");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const process = {
  schema_version: "test-v1",
  generated_at: "2026-07-10T00:00:00.000Z",
  summary: { slices: 3 },
  slices: Array.from({ length: 3 }, (_, sliceIndex) => ({
    slice_index: sliceIndex,
    hop_events: Array.from({ length: 20 }, (_, hopIndex) => ({
      hop_index: hopIndex,
      node_id: `P01-S${String(hopIndex + 1).padStart(2, "0")}`,
      metadata: "x".repeat(1024),
    })),
  })),
};

await writeProcessVisualizationJson(outputPath, process);
const restored = JSON.parse(await readFile(outputPath, "utf8"));
assert.deepEqual(restored, process, "streamed process visualization JSON must round-trip exactly");
const inspection = await inspectProcessVisualizationJson(outputPath, { streamThresholdBytes: 1 });
assert.equal(inspection.schema_version, process.schema_version);
assert.equal(inspection.slice_count, 3);
assert.equal(inspection.summary.slices, 3);
assert.equal(inspection.all_slices_have_oam_snapshots, false);

console.log(JSON.stringify({
  ok: true,
  slices: restored.slices.length,
  hop_events: restored.slices.reduce((total, slice) => total + slice.hop_events.length, 0),
}, null, 2));
