import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

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

export async function verifyExperiment14BFreeze(outputDirectory) {
  const manifestPath = join(outputDirectory, "freeze-manifest.json");
  if (!(await exists(manifestPath))) {
    return { status: "not-frozen", output_directory: outputDirectory };
  }

  const manifest = await readJson(manifestPath);
  const sidecarPath = join(outputDirectory, "freeze-manifest.sha256");
  if (!(await exists(sidecarPath))) throw new Error("实验 14B 冻结清单校验文件缺失");
  const expectedManifestHash = (await readFile(sidecarPath, "utf8")).trim();
  const actualManifestHash = sha256(JSON.stringify(manifest));
  if (expectedManifestHash !== actualManifestHash) throw new Error("实验 14B 冻结清单在冻结后发生变化");

  const protocolPath = resolve(ROOT, "scripts/experiments/experiment14b-protocol.json");
  const currentProtocolHash = sha256(await readFile(protocolPath));
  if (currentProtocolHash !== manifest.hashes.protocol_sha256) throw new Error("实验 14B 协议在冻结后发生变化");
  const frozenProtocolPath = join(outputDirectory, "frozen-protocol.json");
  if (!(await exists(frozenProtocolPath)) || sha256(await readFile(frozenProtocolPath)) !== manifest.hashes.protocol_sha256) {
    throw new Error("实验 14B 冻结协议副本缺失或发生变化");
  }

  const aggregateFiles = [];
  const mismatches = [];
  for (const frozenFile of manifest.files ?? []) {
    const absolutePath = resolve(ROOT, frozenFile.path);
    if (!(await exists(absolutePath))) {
      mismatches.push(`${frozenFile.path}:missing`);
      continue;
    }
    const bytes = await readFile(absolutePath);
    const currentHash = sha256(bytes);
    if (currentHash !== frozenFile.sha256 || bytes.length !== frozenFile.bytes) {
      mismatches.push(`${frozenFile.path}:content`);
    }
    aggregateFiles.push({ absolutePath, sha256: currentHash });
  }
  const aggregate = createHash("sha256");
  for (const file of aggregateFiles.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))) {
    aggregate.update(`${file.absolutePath}\0${file.sha256}\n`);
  }
  const aggregateHashMatches = aggregate.digest("hex") === manifest.hashes.aggregate_code_and_config_sha256;
  const rootRelocationOnly = !aggregateHashMatches && mismatches.length === 0;
  if (!aggregateHashMatches && !rootRelocationOnly) {
    mismatches.push("aggregate-code-and-config-sha256");
  }
  if (mismatches.length) {
    throw new Error(`实验 14B 冻结代码或配置发生变化：${mismatches.join(", ")}`);
  }

  return {
    status: "freeze-integrity-verified",
    output_directory: outputDirectory,
    frozen_at: manifest.frozen_at,
    protocol_sha256: manifest.hashes.protocol_sha256,
    verified_files: manifest.files.length,
    aggregate_path_relocated: rootRelocationOnly,
  };
}

const args = process.argv.slice(2);
const outputDirectory = resolve(ROOT, argValue(args, "--out", "reports/experiment14b-prospective-external-validation"));
const before = await verifyExperiment14BFreeze(outputDirectory);
if (args.includes("--verify-only")) {
  console.log(JSON.stringify(before, null, 2));
  process.exit(0);
}

const runner = resolve(ROOT, "scripts/runExperiment14BProspectiveValidation.mjs");
const child = spawnSync(process.execPath, ["--expose-gc", runner, ...args], {
  cwd: ROOT,
  stdio: "inherit",
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);

const after = await verifyExperiment14BFreeze(outputDirectory);
if (after.status !== "freeze-integrity-verified") throw new Error("实验 14B 运行后未生成可验证的冻结清单");
console.log(JSON.stringify({ guard: after.status, verified_files: after.verified_files }, null, 2));
