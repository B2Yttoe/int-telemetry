import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const protocol = JSON.parse(await readFile(resolve("scripts/experiments/experiment14b-v2-completion-addendum.json"), "utf8"));
const auditSource = await readFile(resolve("scripts/auditExperiment14BV2Completion.mjs"), "utf8");
assert.equal(protocol.ripe_source_equivalence.minimum_strict_pairs, 20);
assert.ok(protocol.ripe_source_equivalence.accepted.includes("project-created-fixed-ripe-anchor-measurement"));
assert.ok(protocol.ripe_source_equivalence.accepted.includes("pre-registered-public-ongoing-fixed-ripe-anchor-measurement"));
assert.ok(protocol.ripe_source_equivalence.rejected.includes("public-anycast-proxy"));
assert.ok(protocol.required_checks.includes("strict_metric_scores_complete"));
assert.equal(protocol.required_checks.length, 11);
assert.match(auditSource, /lock\.source_csv\?\.path/);
assert.match(auditSource, /if \(!records\.length\) return null/);

console.log("Experiment 14B v2 completion-audit protocol tests passed.");
