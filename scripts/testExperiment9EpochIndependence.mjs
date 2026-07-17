import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditEpochIndependence,
  buildEpochRecord,
} from "./experiments/externalEpochRegistry.mjs";

const dir = await mkdtemp(join(tmpdir(), "int-telemetry-exp9-"));
try {
  const inputPath = join(dir, "input.json");
  const validationPath = join(dir, "validation.json");
  const validationPath2 = join(dir, "validation-2.json");
  await writeFile(inputPath, JSON.stringify({
    generated_at: "2026-07-03T00:00:00.000Z",
    source_url: "https://celestrak.org/input",
    satellites: [{ epoch: "2026-07-02T00:00:00.000Z", norad_id: 1 }],
  }), "utf8");
  await writeFile(validationPath, JSON.stringify([
    { EPOCH: "2026-07-06T00:00:00.000", NORAD_CAT_ID: 1 },
    { EPOCH: "2026-07-06T02:00:00.000", NORAD_CAT_ID: 2 },
  ]), "utf8");
  await writeFile(validationPath2, JSON.stringify([
    { EPOCH: "2026-07-10T00:00:00.000", NORAD_CAT_ID: 1 },
    { EPOCH: "2026-07-10T02:00:00.000", NORAD_CAT_ID: 2 },
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
  const validation2 = await buildEpochRecord({
    name: "external validation 2",
    url: "https://celestrak.org/validation-2",
    path: validationPath2,
    role: "external-validation",
    parserVersion: "test-v1",
    retrievedAt: "2026-07-10T03:00:00.000Z",
  });

  assert.match(input.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(input.sha256, validation.sha256);
  assert.equal(input.record_count, 1);
  assert.equal(validation.record_count, 2);
  assert.equal(validation.epoch_start, "2026-07-06T00:00:00.000Z");
  assert.equal(validation.epoch_end, "2026-07-06T02:00:00.000Z");
  assert.equal(validation.epoch_median, "2026-07-06T01:00:00.000Z");
  assert.equal(auditEpochIndependence([input, validation]).ok, true);
  const multiEpochAudit = auditEpochIndependence([input, validation, validation2], { minimumValidationEpochs: 2 });
  assert.equal(multiEpochAudit.ok, true);
  assert.equal(multiEpochAudit.external_validation_count, 2);

  const insufficientAudit = auditEpochIndependence([input, validation], { minimumValidationEpochs: 2 });
  assert.equal(insufficientAudit.ok, false);
  assert.ok(insufficientAudit.violations.some((message) => message.includes("at least 2")));

  const duplicateValidationAudit = auditEpochIndependence([
    input,
    validation,
    { ...validation2, sha256: validation.sha256 },
  ], { minimumValidationEpochs: 2 });
  assert.equal(duplicateValidationAudit.ok, false);
  assert.ok(duplicateValidationAudit.violations.some((message) => message.includes("validation epochs use the same SHA-256")));

  const nonCausalEpochAudit = auditEpochIndependence([
    input,
    { ...validation, epoch_median: "2026-07-01T00:00:00.000Z" },
    validation2,
  ], { minimumValidationEpochs: 2 });
  assert.equal(nonCausalEpochAudit.ok, false);
  assert.ok(nonCausalEpochAudit.violations.some((message) => message.includes("not later than")));

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
