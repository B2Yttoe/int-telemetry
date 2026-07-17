import assert from "node:assert/strict";
import { decodeBigQueryRows, queryBigQuery } from "./collectExperiment14BV2MlabBigQuery.mjs";

const schema = { fields: [
  { name: "uuid", type: "STRING" },
  { name: "download_throughput_mbps", type: "FLOAT" },
  { name: "download_latency_ms", type: "FLOAT" },
] };
const rows = decodeBigQueryRows(schema, [
  { f: [{ v: "test-1" }, { v: "123.5" }, { v: "27.25" }] },
  { f: [{ v: "test-2" }, { v: null }, { v: "31" }] },
]);
assert.deepEqual(rows, [
  { uuid: "test-1", download_throughput_mbps: "123.5", download_latency_ms: "27.25" },
  { uuid: "test-2", download_throughput_mbps: "", download_latency_ms: "31" },
]);

const originalFetch = globalThis.fetch;
const requests = [];
const responses = [
  {
    jobComplete: false,
    jobReference: { projectId: "research-project", jobId: "job-1", location: "US" },
  },
  {
    jobComplete: true,
    jobReference: { projectId: "research-project", jobId: "job-1", location: "US" },
    schema,
    rows: [{ f: [{ v: "test-1" }, { v: "100" }, { v: "25" }] }],
    pageToken: "page-2",
    totalRows: "2",
    totalBytesProcessed: "1234",
    totalBytesBilled: "10000000",
    cacheHit: false,
  },
  {
    jobComplete: true,
    rows: [{ f: [{ v: "test-2" }, { v: "90" }, { v: "30" }] }],
  },
];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  return new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const result = await queryBigQuery({
    query: "SELECT 1",
    projectId: "research-project",
    token: "not-logged-test-token",
    protocol: {
      page_size: 10000,
      poll_timeout_ms: 10000,
      maximum_poll_attempts: 3,
      maximum_bytes_billed: "200000000000",
    },
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].uuid, "test-2");
  assert.equal(result.statistics.total_bytes_processed, "1234");
  assert.equal(requests.length, 3);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.useLegacySql, false);
  assert.equal(body.maximumBytesBilled, "200000000000");
  assert.match(requests[1].url, /queries\/job-1/);
  assert.match(requests[2].url, /pageToken=page-2/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Experiment 14B v2 M-Lab BigQuery collector tests passed.");
