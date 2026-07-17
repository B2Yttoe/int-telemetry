import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCsv } from "./experiments/reportUtils.mjs";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node ${args.join(" ")} failed (${code})\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const root = await mkdtemp(join(tmpdir(), "int-telemetry-exp8-causal-"));
try {
  const baselineDir = join(root, "baseline");
  await runNode([
    "scripts/exportScenario.mjs",
    "--profile", "empty",
    "--constellation-profile", "iridium-next-small",
    "--slices", "1",
    "--out", baselineDir,
  ]);

  const baselineLinks = parseCsv(await readFile(join(baselineDir, "links.csv"), "utf8"));
  const target = baselineLinks.find((row) => row.kind === "inter-plane" && row.is_active === "true");
  assert.ok(target, "fixture requires one active inter-plane link");

  const tasksPath = join(root, "tasks.csv");
  await writeFile(
    tasksPath,
    [
      "task_id,start_slice,duration_slices,source,target,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type",
      `causal-route,0,1,${target.source},${target.target},0,0,0,0,10,1,routing`,
    ].join("\n"),
    "utf8",
  );
  const schedulePath = join(root, "outage-schedule.json");
  await writeFile(schedulePath, JSON.stringify({
    schema_version: "int-telemetry-controlled-link-outage/v1",
    reason: "experiment8-controlled-dynamicity",
    forced_down_link_ids_by_slice: { "0": [target.link_id] },
  }, null, 2), "utf8");

  const replayDir = join(root, "replay");
  await runNode([
    "scripts/exportScenario.mjs",
    "--tasks", tasksPath,
    "--constellation-profile", "iridium-next-small",
    "--slices", "1",
    "--link-outage-schedule", schedulePath,
    "--out", replayDir,
  ]);

  const replayLinks = parseCsv(await readFile(join(replayDir, "links.csv"), "utf8"));
  const replayRoutes = parseCsv(await readFile(join(replayDir, "routes.csv"), "utf8"));
  const forcedLink = replayLinks.find((row) => row.link_id === target.link_id);
  assert.equal(forcedLink?.is_active, "false", "controlled outage must be applied before routing");
  assert.equal(forcedLink?.restriction_reason, "experiment8-controlled-dynamicity");
  assert.equal(Number(forcedLink?.carried_traffic_mbps), 0);

  const activeById = new Map(replayLinks.map((row) => [row.link_id, row.is_active === "true"]));
  replayRoutes.forEach((route) => {
    String(route.link_ids || "").split(" > ").filter(Boolean).forEach((linkId) => {
      assert.equal(activeById.get(linkId), true, `route ${route.task_id} used inactive link ${linkId}`);
    });
  });
  assert.equal(
    replayRoutes.some((route) => String(route.link_ids || "").split(" > ").includes(target.link_id)),
    false,
    "rerouted tasks must not retain the forced-down link",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Experiment 8 causal Stage-1 replay test passed.");
