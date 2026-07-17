import assert from "node:assert/strict";

const pilot = await import("./runImportanceAwareTelemetryPilot.mjs");

assert.equal(
  typeof pilot.maxNumberOrZero,
  "function",
  "the pilot must expose a stack-safe numeric maximum helper",
);

const ages = Array.from({ length: 250_000 }, (_, index) => index % 997);
ages[ages.length - 1] = 12345;

assert.equal(pilot.maxNumberOrZero(ages), 12345);
assert.equal(pilot.maxNumberOrZero([]), 0);

console.log(JSON.stringify({
  ok: true,
  samples: ages.length,
  maximum: pilot.maxNumberOrZero(ages),
}, null, 2));
