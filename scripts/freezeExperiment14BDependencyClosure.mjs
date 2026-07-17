import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = resolve(ROOT, "reports/experiment14b-prospective-external-validation/dependency-closure");
const MANIFEST_PATH = resolve(OUTPUT_DIRECTORY, "dependency-closure-freeze.json");
const SIDECAR_PATH = resolve(OUTPUT_DIRECTORY, "dependency-closure-freeze.sha256");
const RENAME_AMENDMENT_PATH = resolve(OUTPUT_DIRECTORY, "dependency-closure-project-rename-amendment.json");
const RENAME_AMENDMENT_SIDECAR_PATH = resolve(OUTPUT_DIRECTORY, "dependency-closure-project-rename-amendment.sha256");
const ENTRY_POINTS = [
  "scripts/runExperiment14BProspectiveValidation.mjs",
  "scripts/runExperiment14BGuarded.mjs",
  "scripts/runExperiment14BMlabMetricSpecific.mjs",
  "scripts/runExperiment14BSourceLifecycle.mjs",
  "scripts/runExperiment14BOrbitSourceFailover.mjs",
  "scripts/auditExperiment14BStrictEvidence.mjs",
  "scripts/testExperiment14BProspectiveValidation.mjs",
].map((path) => resolve(ROOT, path));
const EXPLICIT_RUNTIME_FILES = [
  "scripts/freezeExperiment14BDependencyClosure.mjs",
  "scripts/resumeExperiment14B.ps1",
  "scripts/experiments/experiment14b-protocol.json",
  "scripts/experiments/experiment14b-mlab-metric-specific-protocol.json",
  "scripts/experiments/experiment14b-source-lifecycle-protocol.json",
  "scripts/experiments/experiment14b-orbit-source-failover-protocol.json",
  "scripts/experiments/experiment14b-strict-completion-protocol.json",
  "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md",
  "src/simulation/realTleCatalog.ts",
  "src/config/walkerNetworkConfig.ts",
  "src/simulation/walker.ts",
  "src/simulation/antenna.ts",
  "src/simulation/tle.ts",
  "package.json",
  "package-lock.json",
].map((path) => resolve(ROOT, path));

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

async function fileRecord(path) {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  return {
    path: relative(ROOT, absolute).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function dependencyFiles() {
  const result = await build({
    entryPoints: ENTRY_POINTS,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    outdir: "dependency-closure-bundle",
    metafile: true,
    logLevel: "silent",
  });
  const files = new Set(EXPLICIT_RUNTIME_FILES);
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = resolve(ROOT, input);
    if (absolute.startsWith(`${ROOT}\\`) || absolute === ROOT) files.add(absolute);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

async function verify() {
  if (!(await exists(MANIFEST_PATH))) throw new Error("Experiment 14B dependency closure is not frozen");
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const expectedManifestHash = (await readFile(SIDECAR_PATH, "utf8")).trim();
  if (expectedManifestHash !== sha256(JSON.stringify(manifest))) throw new Error("Dependency closure manifest changed");
  let renameAmendment = null;
  if (await exists(RENAME_AMENDMENT_PATH)) {
    if (!(await exists(RENAME_AMENDMENT_SIDECAR_PATH))) throw new Error("Dependency closure rename amendment sidecar is missing");
    renameAmendment = JSON.parse(await readFile(RENAME_AMENDMENT_PATH, "utf8"));
    const expectedAmendmentHash = (await readFile(RENAME_AMENDMENT_SIDECAR_PATH, "utf8")).trim();
    if (expectedAmendmentHash !== sha256(JSON.stringify(renameAmendment))) {
      throw new Error("Dependency closure rename amendment changed");
    }
    if (renameAmendment.base_manifest_sha256 !== expectedManifestHash) {
      throw new Error("Dependency closure rename amendment does not reference the frozen manifest");
    }
  }
  const amendedFiles = new Map((renameAmendment?.files ?? []).map((file) => [file.path, file]));
  const changed = [];
  const acceptedByAmendment = [];
  for (const file of manifest.files) {
    const current = await fileRecord(resolve(ROOT, file.path));
    if (current.sha256 === file.sha256 && current.bytes === file.bytes) continue;
    const amended = amendedFiles.get(file.path);
    if (amended && current.sha256 === amended.sha256 && current.bytes === amended.bytes) {
      acceptedByAmendment.push(file.path);
      continue;
    }
    changed.push(file.path);
  }
  if (changed.length) throw new Error(`Experiment 14B dependency closure changed: ${changed.join(", ")}`);
  return { ...manifest, rename_amendment_files: acceptedByAmendment };
}

async function freeze() {
  if (await exists(MANIFEST_PATH)) return verify();
  const files = await Promise.all((await dependencyFiles()).map(fileRecord));
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(`${file.path}\0${file.sha256}\n`);
  const manifest = {
    schema: "int-telemetry-experiment14b-dependency-closure-freeze/v1",
    frozen_at: new Date().toISOString(),
    evidence_state_at_freeze: "fresh orbit, future Radar, and exact-anchor RIPE evidence incomplete",
    discovery: "esbuild transitive local-input metafile plus explicit runtime-generated and TypeScript model files",
    aggregate_sha256: aggregate.digest("hex"),
    file_count: files.length,
    files,
  };
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(SIDECAR_PATH, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

const verifyOnly = process.argv.includes("--verify-only");
const manifest = verifyOnly ? await verify() : await freeze();
console.log(JSON.stringify({
  status: "dependency-closure-verified",
  frozen_at: manifest.frozen_at,
  file_count: manifest.file_count,
  aggregate_sha256: manifest.aggregate_sha256,
  rename_amendment_files: manifest.rename_amendment_files?.length ?? 0,
}, null, 2));
