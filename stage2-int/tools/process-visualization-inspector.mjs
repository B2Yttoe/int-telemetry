import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

function summarize(process) {
  const slices = Array.isArray(process.slices) ? process.slices : [];
  return {
    schema_version: process.schema_version,
    summary: process.summary ?? {},
    boundary: process.boundary ?? {},
    slice_count: slices.length,
    all_slices_have_oam_snapshots: slices.every(
      (slice) => slice.oam_reconstruction?.nodes?.length > 0 && slice.oam_reconstruction?.links?.length > 0,
    ),
  };
}

export async function inspectProcessVisualizationJson(path, { streamThresholdBytes = 256 * 1024 * 1024 } = {}) {
  const info = await stat(path);
  if (info.size < streamThresholdBytes) {
    return summarize(JSON.parse(await readFile(path, "utf8")));
  }

  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const headerLines = [];
  let readingSlices = false;
  let sliceCount = 0;
  let allSlicesHaveOamSnapshots = true;

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!readingSlices) {
      if (trimmed === '"slices": [') {
        readingSlices = true;
      } else {
        headerLines.push(line);
      }
      continue;
    }
    if (trimmed === "]" || trimmed === "],") break;
    if (!trimmed.startsWith("{")) continue;
    const slice = JSON.parse(trimmed.replace(/,$/, ""));
    sliceCount += 1;
    if (!(slice.oam_reconstruction?.nodes?.length > 0 && slice.oam_reconstruction?.links?.length > 0)) {
      allSlicesHaveOamSnapshots = false;
    }
  }

  if (!readingSlices) throw new Error(`Process visualization slices array not found: ${path}`);
  for (let index = headerLines.length - 1; index >= 0; index -= 1) {
    if (!headerLines[index].trim()) continue;
    headerLines[index] = headerLines[index].replace(/,\s*$/, "");
    break;
  }
  const header = JSON.parse(`${headerLines.join("\n")}\n}`);
  return {
    schema_version: header.schema_version,
    summary: header.summary ?? {},
    boundary: header.boundary ?? {},
    slice_count: sliceCount,
    all_slices_have_oam_snapshots: allSlicesHaveOamSnapshots,
  };
}
