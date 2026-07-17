import assert from "node:assert/strict";
import { buildCorrectedMlabQuery } from "./applyExperiment14BV2MlabQueryCorrection.mjs";

const query = buildCorrectedMlabQuery({
  windows: {
    topology_start: "2026-07-16T05:00:00.000Z",
    topology_end: "2026-07-16T07:00:00.000Z",
  },
});

assert.match(query, /FROM `measurement-lab\.ndt\.unified_downloads`/);
assert.match(query, /node\._Instruments = 'ndt7'/);
assert.doesNotMatch(query, /UNNEST\(node_instruments\)/);
assert.match(query, /client\.Network\.ASNumber = 14593/);
assert.match(query, /a\.TestTime >= TIMESTAMP\('2026-07-16T05:00:00\.000Z'\)/);
assert.match(query, /a\.TestTime < TIMESTAMP\('2026-07-16T07:00:00\.000Z'\)/);
assert.match(query, /date BETWEEN DATE\(TIMESTAMP\('2026-07-16T05:00:00\.000Z'\)\)/);
console.log("Experiment 14B v2 M-Lab query correction tests passed.");
