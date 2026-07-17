import assert from "node:assert/strict";
import {
  predictNetPowerFromObservableContext,
  propagateEnergyPercent,
} from "../stage2-int/tools/int-mc-energy-prior.mjs";

const shadowContext = {
  solar_power_w: 0,
  battery_capacity_wh: 1200,
  net_power_w: -9999,
  load_power_w: 9999,
};
const alteredHiddenTruth = {
  ...shadowContext,
  net_power_w: 9999,
  load_power_w: 1,
};

const shadowNet = predictNetPowerFromObservableContext(shadowContext);
assert.equal(
  predictNetPowerFromObservableContext(alteredHiddenTruth),
  shadowNet,
  "predictable power prior must ignore hidden net/load truth fields",
);
assert.ok(shadowNet < 0);

const sunlitNet = predictNetPowerFromObservableContext({ solar_power_w: 760, battery_capacity_wh: 1200 });
assert.ok(sunlitNet > 0);

const discharged = propagateEnergyPercent({
  previousPercent: 80,
  context: shadowContext,
  stepHours: 5 / 60,
});
const charged = propagateEnergyPercent({
  previousPercent: discharged,
  context: { solar_power_w: 760, battery_capacity_wh: 1200 },
  stepHours: 5 / 60,
});
assert.ok(discharged < 80);
assert.ok(charged > discharged);
assert.ok(discharged >= 20 && charged <= 100);

console.log(JSON.stringify({ ok: true, shadowNet, sunlitNet, discharged, charged }, null, 2));
