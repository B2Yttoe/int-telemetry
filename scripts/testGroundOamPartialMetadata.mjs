import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  const headers = rows[0] ?? [];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

const fixture = spawnSync(process.execPath, ["scripts/testProbeSelectiveMetadataSemantics.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (fixture.status !== 0) throw new Error(`fixture failed\n${fixture.stdout}\n${fixture.stderr}`);

const root = resolve("stage2-int/runs/tmp-selective-metadata-semantics-test");
const truthDir = join(root, "truth");
const stage2Dir = join(root, "stage2");
const result = spawnSync(process.execPath, [
  "stage2-int/tools/ground-oam-reconstructor.mjs",
  "--input", truthDir,
  "--stage2", stage2Dir,
  "--out", stage2Dir,
  "--hops", join(stage2Dir, "probe-int-hop-records-int-mc.csv"),
  "--reports", join(stage2Dir, "probe-int-reports-int-mc.csv"),
  "--stale-carry-over", "false",
  "--oam-prior-estimates", "false",
], { cwd: process.cwd(), encoding: "utf8" });
if (result.status !== 0) throw new Error(`OAM failed\n${result.stdout}\n${result.stderr}`);

const nodes = parseCsv(await readFile(join(stage2Dir, "ground-reconstructed-nodes.csv"), "utf8"));
const links = parseCsv(await readFile(join(stage2Dir, "ground-reconstructed-links.csv"), "utf8"));
const byNode = new Map(nodes.map((row) => [row.node_id, row]));
const byLink = new Map(links.map((row) => [row.link_id, row]));

assert.equal(byNode.get("A").observation_source, "unknown", "link-only metadata must not become a node observation");
assert.equal(byNode.get("A").cpu_percent_estimate, "", "omitted CPU must remain missing, not zero");
assert.equal(byNode.get("B").observation_source, "observed");
assert.equal(Number(byNode.get("B").cpu_percent_estimate), 30);
assert.equal(byNode.get("C").observation_source, "unknown", "forward-only hop must remain unknown");

assert.equal(byLink.get("L1").observation_source, "observed");
assert.equal(Number(byLink.get("L1").utilization_percent_estimate), 31);
assert.equal(byLink.get("L1").latency_ms_estimate, "", "omitted link latency must remain missing, not zero");
assert.equal(byLink.get("L2").observation_source, "observed");
assert.equal(Number(byLink.get("L2").latency_ms_estimate), 8);

console.log(JSON.stringify({
  ok: true,
  directly_observed_nodes: nodes.filter((row) => row.observation_source === "observed").map((row) => row.node_id),
  directly_observed_links: links.filter((row) => row.observation_source === "observed").map((row) => row.link_id),
  omitted_latency: byLink.get("L1").latency_ms_estimate,
}, null, 2));
