import assert from "node:assert/strict";
import { buildInfocomEvidenceMarkdown } from "./writeInfocomEvidenceSynthesis.mjs";

const markdown = buildInfocomEvidenceMarkdown({
  reference: { static_rows: [], comparison_rows: [] },
  multiSeed: { summary_rows: [] },
  reporting: { rows: [] },
  external: { evidence_status: "complete", claim_boundaries: {} },
});
assert.match(markdown, /原生 INT-MC 为什么不适应动态 LEO/);
assert.match(markdown, /固定采样预算/);
assert.match(markdown, /多种子/);
assert.match(markdown, /reporting path 中断/);
assert.match(markdown, /外部真实性/);
assert.match(markdown, /CPU、电量和队列/);
assert.match(markdown, /负结果/);

console.log("INFOCOM evidence synthesis tests passed.");
