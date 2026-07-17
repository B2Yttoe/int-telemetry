import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
const AUDIT_DIRECTORY = join(REPORT, "strict-evidence");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-strict-completion-protocol.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/auditExperiment14BStrictEvidence.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileRecord(path) {
  const bytes = await readFile(path);
  return {
    path: relative(ROOT, path).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function freezeAudit() {
  const path = join(AUDIT_DIRECTORY, "strict-audit-freeze.json");
  if (await exists(path)) return verifyAuditFreeze();
  const manifest = {
    schema: "int-telemetry-experiment14b-strict-audit-freeze/v1",
    frozen_at: new Date().toISOString(),
    result_state_at_freeze: "prospective external windows incomplete",
    files: await Promise.all([SCRIPT_PATH, PROTOCOL_PATH].map(fileRecord)),
  };
  await writeJson(path, manifest);
  await writeFile(join(AUDIT_DIRECTORY, "strict-audit-freeze.sha256"), `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function verifyAuditFreeze() {
  const path = join(AUDIT_DIRECTORY, "strict-audit-freeze.json");
  if (!(await exists(path))) throw new Error("Strict completion audit is not frozen; run with --freeze first");
  const manifest = await readJson(path);
  const sidecar = (await readFile(join(AUDIT_DIRECTORY, "strict-audit-freeze.sha256"), "utf8")).trim();
  if (sidecar !== sha256(JSON.stringify(manifest))) throw new Error("Strict audit freeze manifest changed");
  const changed = [];
  for (const file of manifest.files) {
    const current = await fileRecord(resolve(ROOT, file.path));
    if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) changed.push(file.path);
  }
  if (changed.length) throw new Error(`Strict audit files changed after freeze: ${changed.join(", ")}`);
  return manifest;
}

function item(id, status, detail, evidence = null) {
  return { id, status, detail, evidence };
}

async function optionalJson(path) {
  return await exists(path) ? readJson(path) : null;
}

function runParentFreezeGuard() {
  const guard = resolve(ROOT, "scripts/runExperiment14BGuarded.mjs");
  const result = spawnSync(process.execPath, [guard, "--verify-only"], { cwd: ROOT, encoding: "utf8" });
  return {
    passed: result.status === 0 && result.stdout.includes("freeze-integrity-verified"),
    exit_code: result.status,
    output: (result.stdout || result.stderr).trim(),
  };
}

async function audit() {
  const freeze = await verifyAuditFreeze();
  const protocol = await readJson(PROTOCOL_PATH);
  const collection = await optionalJson(join(REPORT, "collection-status.json"));
  const results = await optionalJson(join(REPORT, "experiment14b-results.json"));
  const mlabMetadata = await optionalJson(join(REPORT, "mlab", "mlab-split-metadata.json"));
  const metricMetadata = await optionalJson(join(REPORT, "mlab-metric-specific", "latency-split-metadata.json"));
  const metricResult = await optionalJson(join(REPORT, "mlab-metric-specific", "metric-specific-result.json"));
  const radarMetadata = await optionalJson(join(REPORT, "radar", "radar-collection-metadata.json"));
  const ripeScore = await optionalJson(join(REPORT, "ripe-atlas", "ripe-rtt-score.json"));
  const checks = [];

  const parentGuard = runParentFreezeGuard();
  checks.push(item("parent-freeze-integrity", parentGuard.passed ? "pass" : "fail", parentGuard.passed ? "12 frozen parent files verified" : "Parent freeze integrity failed", parentGuard));

  const orbit = collection?.sources?.orbit_input;
  checks.push(item("fresh-orbit-age-gate", orbit?.input_ready === true && orbit?.freshness?.passed === true ? "pass" : "pending",
    orbit?.freshness?.passed ? "Selected shell passed median/P95 age gates" : "Waiting for a causally fresh GP acquisition and age gate", orbit?.freshness ?? orbit?.status));
  const futureOrbit = collection?.sources?.orbit_future_validation;
  checks.push(item("future-orbit-validation", futureOrbit?.status === "complete" ? "pass" : "pending",
    futureOrbit?.status === "complete" ? "Future GP comparison complete" : "Waiting for the future GP validation window", futureOrbit));

  const mlabOverlap = mlabMetadata?.train_test_uuid_overlap;
  checks.push(item("mlab-zero-uuid-overlap", mlabOverlap === 0 ? "pass" : mlabOverlap == null ? "pending" : "fail",
    mlabOverlap === 0 ? "Throughput train/test UUID overlap is zero" : "M-Lab throughput split is absent or overlaps", mlabOverlap));
  const mlabLeakage = mlabMetadata?.test_target_values_used_for_fit;
  checks.push(item("mlab-no-test-fit", mlabLeakage === 0 ? "pass" : mlabLeakage == null ? "pending" : "fail",
    mlabLeakage === 0 ? "Throughput test targets were not used for fitting" : "M-Lab fit leakage is absent or non-zero", mlabLeakage));
  checks.push(item("metric-specific-latency-split", metricMetadata?.train_test_uuid_overlap === 0 && metricMetadata?.test_target_values_used_for_fit === 0 ? "pass" : metricMetadata ? "fail" : "pending",
    metricMetadata ? "Latency-filtered split acquired with zero overlap and zero test fitting" : "Latency-specific split pending", metricMetadata));
  checks.push(item("metric-specific-blind-score", metricResult?.evidence_status === "metric-specific-blind-validation-complete" ? "pass" : "pending",
    metricResult ? metricResult.evidence_status : "Waiting for fresh parent topology before metric-specific scoring", metricResult?.sample_counts));

  const radar = collection?.sources?.radar;
  const radarPass = radar?.status === "complete" && results?.radar?.status === "complete" && radarMetadata?.timestamp_overlap === 0 && radarMetadata?.test_values_used_for_fit === 0;
  checks.push(item("prospective-radar", radarPass ? "pass" : "pending",
    radarPass ? "Future Radar test complete with zero timestamp overlap and zero test fitting" : "Future Radar window or API-backed collection is pending", { source: radar?.status, score: results?.radar?.status, metadata: radarMetadata }));

  const ripeSource = collection?.sources?.ripe_atlas;
  const ripeExact = ripeSource?.status === protocol.required.ripe_collection_semantics && results?.ripe_atlas?.status === "complete";
  checks.push(item("ripe-exact-anchor", ripeExact ? "pass" : "pending",
    ripeExact ? "Prospective RIPE measurement used a fixed geolocated anchor" : "A public anycast proxy is insufficient; exact-anchor measurement remains pending", { source: ripeSource?.status, score: results?.ripe_atlas?.status }));
  let ripePairs = [];
  const ripeCsv = join(REPORT, "ripe-atlas", "ripe-paired-rtt.csv");
  if (ripeExact && await exists(ripeCsv)) ripePairs = await readCsvStream(ripeCsv);
  const validExactPairs = ripePairs.filter((row) => row.status === "modeled" &&
    row.temporal_pairing === protocol.required.ripe_temporal_pairing &&
    row.server_location_source === protocol.required.ripe_server_location_source);
  const pairPass = Boolean(ripeExact && validExactPairs.length >= protocol.minimum_exact_ripe_pairs && ripeScore);
  checks.push(item("ripe-strict-pair-count", pairPass ? "pass" : "pending",
    pairPass ? `${validExactPairs.length} exact time/location/server pairs` : `Need at least ${protocol.minimum_exact_ripe_pairs} exact pairs`, { valid_exact_pairs: validExactPairs.length, score: ripeScore }));

  const ns3 = collection?.sources?.ns3_cross_validation;
  checks.push(item("ns3-system-cross-validation", ns3?.status === "complete" && ns3?.evidence_status === protocol.required.ns3_evidence_status ? "pass" : "pending",
    ns3?.status === "complete" ? "ns-3 core and stress combinations complete" : "ns-3 evidence pending", ns3));
  const boundaryPath = resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md");
  checks.push(item("internal-state-claim-boundary", await exists(boundaryPath) ? "pass" : "fail",
    await exists(boundaryPath) ? "CPU, energy, and queue claim boundary is documented" : "Claim-boundary document missing", relative(ROOT, boundaryPath)));

  const hasFailure = checks.some((check) => check.status === "fail");
  const allPass = checks.every((check) => check.status === "pass");
  const result = {
    schema: "int-telemetry-experiment14b-strict-evidence-audit/v1",
    generated_at: new Date().toISOString(),
    freeze: { frozen_at: freeze.frozen_at, protocol_sha256: sha256(await readFile(PROTOCOL_PATH)) },
    strict_evidence_status: hasFailure ? "failed" : allPass ? "strict-prospective-validation-complete" : "strict-prospective-validation-in-progress",
    passed: checks.filter((check) => check.status === "pass").length,
    pending: checks.filter((check) => check.status === "pending").length,
    failed: checks.filter((check) => check.status === "fail").length,
    checks,
    non_sufficient_evidence: protocol.non_sufficient_evidence,
  };
  await writeJson(join(AUDIT_DIRECTORY, "strict-completion-audit.json"), result);
  const rows = checks.map((check) => `| ${check.id} | ${check.status} | ${check.detail} |`).join("\n");
  const markdown = `# 实验 14B 严格完成审计\n\n- 状态：\`${result.strict_evidence_status}\`\n- 通过：${result.passed}\n- 待完成：${result.pending}\n- 失败：${result.failed}\n\n| 检查项 | 状态 | 说明 |\n|---|---|---|\n${rows}\n\n公共 anycast 代理、历史 M-Lab 代表性轨道相位和内部潜变量自洽均不能单独使本审计通过。\n`;
  await writeFile(join(AUDIT_DIRECTORY, "STRICT_COMPLETION_AUDIT.md"), markdown, "utf8");
  return result;
}

const args = process.argv.slice(2);
if (args.includes("--freeze")) {
  const frozen = await freezeAudit();
  console.log(JSON.stringify({ status: "strict-audit-frozen", frozen_at: frozen.frozen_at }, null, 2));
} else {
  const result = await audit();
  console.log(JSON.stringify({
    status: result.strict_evidence_status,
    passed: result.passed,
    pending: result.pending,
    failed: result.failed,
  }, null, 2));
  if (args.includes("--require-complete") && result.strict_evidence_status !== "strict-prospective-validation-complete") process.exit(1);
}
