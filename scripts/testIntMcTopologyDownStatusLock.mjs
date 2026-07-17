import assert from "node:assert/strict";
import { resolveTopologyAwareStatusEstimate } from "../stage2-int/tools/int-mc-constraints.mjs";

assert.equal(resolveTopologyAwareStatusEstimate({
  contactActive: false,
  directlyObserved: true,
  observedStatus: "up",
  derivedStatus: "warning",
}), "down", "physical inactive mask must override an observed up status");

assert.equal(resolveTopologyAwareStatusEstimate({
  contactActive: false,
  directlyObserved: true,
  observedStatus: "warning",
  derivedStatus: "up",
}), "down", "physical inactive mask must override an observed warning status");

assert.equal(resolveTopologyAwareStatusEstimate({
  contactActive: true,
  directlyObserved: true,
  observedStatus: "warning",
  derivedStatus: "up",
}), "warning", "direct observation must remain locked when the physical mask is active");

assert.equal(resolveTopologyAwareStatusEstimate({
  contactActive: true,
  directlyObserved: false,
  observedStatus: "up",
  derivedStatus: "warning",
}), "warning", "an unobserved active link must use the reconstructed status");

console.log(JSON.stringify({ ok: true, cases: 4 }, null, 2));
