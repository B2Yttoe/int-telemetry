function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function predictNetPowerFromObservableContext(context = {}, {
  averageLoadPowerW = 330,
  chargeEfficiency = 0.95,
  dischargeEfficiency = 0.95,
} = {}) {
  const generatedPowerW = Math.max(0, numberValue(context.solar_power_w, 0));
  const observableLoadPowerW = Math.max(
    0,
    numberValue(context.observable_load_power_w, averageLoadPowerW),
  );
  const surplus = generatedPowerW - observableLoadPowerW;
  return surplus >= 0
    ? surplus * chargeEfficiency
    : surplus / Math.max(dischargeEfficiency, 1e-6);
}

export function propagateEnergyPercent({
  previousPercent,
  context = {},
  stepHours,
  averageLoadPowerW = 330,
  chargeEfficiency = 0.95,
  dischargeEfficiency = 0.95,
} = {}) {
  const previous = numberValue(previousPercent, NaN);
  const hours = numberValue(stepHours, NaN);
  const batteryCapacityWh = numberValue(context.battery_capacity_wh, 1200);
  const minimumSoc = clamp(numberValue(context.min_state_of_charge, 0.2), 0, 0.8);
  if (!Number.isFinite(previous) || !Number.isFinite(hours) || hours <= 0 || batteryCapacityWh <= 0) return NaN;
  const netPowerW = predictNetPowerFromObservableContext(context, {
    averageLoadPowerW,
    chargeEfficiency,
    dischargeEfficiency,
  });
  return clamp(
    previous + (netPowerW * hours * 100) / batteryCapacityWh,
    minimumSoc * 100,
    100,
  );
}
