import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateMlabExportEvidence } from "./auditExperiment14BV2MlabProvenance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "experiment14b-v2-mlab-"));
try {
  const queryPath = join(directory, "query.sql");
  const csvPath = join(directory, "export.csv");
  const metadataPath = join(directory, "metadata.json");
  const query = "SELECT * FROM `measurement-lab.ndt.unified_downloads`;\n";
  const header = "uuid,test_time,data_source,client_asn,client_city,client_country_code,lat,lon,server_id,server_city,server_country_code,server_latitude_deg,server_longitude_deg,download_throughput_mbps,download_latency_ms\n";
  const rows = Array.from({ length: 20 }, (_, index) =>
    `id-${index},2026-07-16T00:${String(index).padStart(2, "0")}:00.000Z,NDT7,14593,City,US,40,-74,server-${index},ServerCity,US,41,-73,100,30`,
  ).join("\n");
  await writeFile(queryPath, query, "utf8");
  await writeFile(csvPath, `${header}${rows}\n`, "utf8");
  const csv = await readFile(csvPath);
  const metadata = {
    official_table: "measurement-lab.ndt.unified_downloads",
    query_sha256: sha256(Buffer.from(query)),
    bigquery_job_id: "project:region.job-1",
    query_started_at: "2026-07-17T01:00:00.000Z",
    query_completed_at: "2026-07-17T01:01:00.000Z",
    exported_at: "2026-07-17T01:02:00.000Z",
    row_count: 20,
    source_csv_sha256: sha256(csv),
    source_url: "https://console.cloud.google.com/bigquery",
    license: "M-Lab open data",
    test_values_used_for_fit: 0,
    post_test_parameter_updates: 0
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const provenanceProtocol = JSON.parse(await readFile("scripts/experiments/experiment14b-v2-mlab-provenance-addendum.json", "utf8"));
  const v2Protocol = JSON.parse(await readFile("scripts/experiments/experiment14b-v2-protocol.json", "utf8"));
  const gp0 = { windows: {
    topology_start: "2026-07-16T00:00:00.000Z",
    topology_end: "2026-07-16T01:00:00.000Z",
    mlab_import_not_before: "2026-07-17T01:00:00.000Z"
  } };
  const valid = await validateMlabExportEvidence({ csvPath, metadataPath, queryPath, gp0, provenanceProtocol, v2Protocol });
  assert.equal(valid.passed, true);
  assert.equal(valid.eligible_rows, 20);

  metadata.source_csv_sha256 = "0".repeat(64);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const invalid = await validateMlabExportEvidence({ csvPath, metadataPath, queryPath, gp0, provenanceProtocol, v2Protocol });
  assert.equal(invalid.passed, false);
  assert.ok(invalid.failures.includes("source-csv-sha256-mismatch"));
  console.log("Experiment 14B v2 M-Lab provenance tests passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
