import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditEpochIndependence,
  buildEpochRecord,
} from "./experiments/externalEpochRegistry.mjs";

const dir = await mkdtemp(join(tmpdir(), "int-temerity-exp9-"));
try {
  const inputPath = join(dir, "input.json");
  const validationPath = join(dir, "validation.json");
  await writeFile(inputPath, JSON.stringify({
    generated_at: "2026-07-03T00:00:00.000Z",
    source_url: "https://celestrak.org/input",
    satellites: [{ epoch: "2026-07-02T00:00:00.000Z", norad_id: 1 }],
  }), "utf8");
  await writeFile(validationPath, JSON.stringify([
    { EPOCH: "2026-07-06T00:00:00.000", NORAD_CAT_ID: 1 },
    { EPOCH: "2026-07-06T02:00:00.000", NORAD_CAT_ID: 2 },
  ]), "utf8");

  const input = await buildEpochRecord({
    name: "model input",
    url: "https://celestrak.org/input",
    path: inputPath,
    role: "model-input",
    parserVersion: "test-v1",
  });
  const validation = await buildEpochRecord({
    name: "external validation",
    url: "https://celestrak.org/validation",
    path: validationPath,
    role: "external-validation",
    parserVersion: "test-v1",
    retrievedAt: "2026-07-06T03:00:00.000Z",
  });

  assert.match(input.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(input.sha256, validation.sha256);
  assert.equal(input.record_count, 1);
  assert.equal(validation.record_count, 2);
  assert.equal(validation.epoch_start, "2026-07-06T00:00:00.000Z");
  assert.equal(validation.epoch_end, "2026-07-06T02:00:00.000Z");
  assert.equal(auditEpochIndependence([input, validation]).ok, true);

  const duplicateAudit = auditEpochIndependence([
    input,
    { ...validation, sha256: input.sha256 },
  ]);
  assert.equal(duplicateAudit.ok, false);
  assert.ok(duplicateAudit.violations.some((message) => message.includes("same SHA-256")));
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("Experiment 9 epoch independence tests passed.");
