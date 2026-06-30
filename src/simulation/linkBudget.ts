import type {
  AdaptiveCodingConfig,
  LinkDopplerEndpointConfig,
  LinkDopplerState,
  LinkBudgetConfig,
  LinkBudgetState,
  LinkInterferenceModelConfig,
  LinkLossBreakdown,
  LinkNoiseEndpointConfig,
  LinkNoiseState,
  LinkPointingState,
  ModulationName,
} from "./types";

const SPEED_OF_LIGHT_M_PER_S = 299_792_458;
const SPEED_OF_LIGHT_KM_PER_S = SPEED_OF_LIGHT_M_PER_S / 1000;
const THERMAL_NOISE_DENSITY_DBM_PER_HZ = -174;

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function frequencyGhzFromWavelengthNm(wavelengthNm: number) {
  return SPEED_OF_LIGHT_M_PER_S / (wavelengthNm * 1e-9) / 1e9;
}

export function wattsToDbm(powerW: number) {
  return 10 * Math.log10(Math.max(powerW, 1e-12) * 1000);
}

export function dbmToMilliwatts(powerDbm: number) {
  return 10 ** (powerDbm / 10);
}

export function milliwattsToDbm(powerMw: number) {
  if (powerMw <= 0) return -999;
  return 10 * Math.log10(powerMw);
}

export function dbToLinear(db: number) {
  return 10 ** (db / 10);
}

export function linearToDb(value: number) {
  if (value <= 0) return -999;
  return 10 * Math.log10(value);
}

export function freeSpacePathLossDb(distanceKm: number, frequencyGhz: number) {
  if (distanceKm <= 0 || frequencyGhz <= 0) return 0;
  return 92.45 + 20 * Math.log10(distanceKm) + 20 * Math.log10(frequencyGhz);
}

export function noisePowerDbm(channelBandwidthMhz: number, noiseFigureDb: number) {
  const bandwidthHz = Math.max(channelBandwidthMhz, 1e-9) * 1e6;
  return THERMAL_NOISE_DENSITY_DBM_PER_HZ + 10 * Math.log10(bandwidthHz) + noiseFigureDb;
}

export function channelOffsetMhz(channelId: number, channelCount: number, spacingMhz: number) {
  const normalizedChannelCount = Math.max(Math.round(channelCount), 1);
  const normalizedChannelId = ((Math.round(channelId) % normalizedChannelCount) + normalizedChannelCount) % normalizedChannelCount;
  return (normalizedChannelId - (normalizedChannelCount - 1) / 2) * Math.max(spacingMhz, 0);
}

export function channelIsolationState(
  victimChannelId: number,
  interfererChannelId: number,
  model: LinkInterferenceModelConfig,
) {
  const channelDelta = Math.abs(Math.round(victimChannelId) - Math.round(interfererChannelId));
  if (channelDelta === 0) {
    return {
      channelDelta,
      isolationDb: model.coChannelIsolationDb,
      relation: "co-channel" as const,
      filtered: false,
    };
  }

  if (channelDelta > Math.max(model.maxAdjacentChannelSeparation, 0)) {
    return {
      channelDelta,
      isolationDb: Number.POSITIVE_INFINITY,
      relation: "filtered" as const,
      filtered: true,
    };
  }

  return {
    channelDelta,
    isolationDb: model.adjacentChannelIsolationDb + (channelDelta - 1) * model.adjacentChannelRollOffDbPerStep,
    relation: "adjacent-channel" as const,
    filtered: false,
  };
}

export function calculateNoiseState(
  sunSeparationDeg: number,
  receiverBeamwidthDeg: number,
  config?: LinkNoiseEndpointConfig,
  enabled = true,
): LinkNoiseState {
  const referenceTemperatureK = Math.max(config?.receiverReferenceTemperatureK ?? 290, 1);
  const quietSkyTemperatureK = enabled ? Math.max(config?.quietSkyTemperatureK ?? 0, 0) : 0;
  const halfBeamDeg = Math.max(receiverBeamwidthDeg / 2, 0.001);
  const sunDiskEdgeDeg = Math.max(config?.sunAngularRadiusDeg ?? 0.27, 0);
  const normalizedSeparation = Math.max(sunSeparationDeg - sunDiskEdgeDeg, 0) / halfBeamDeg;
  const mainLobeCoupling = config?.mainLobeCoupling ?? 1;
  const sideLobeCoupling = config?.sideLobeCoupling ?? 0;
  const coupling = normalizedSeparation <= 1
    ? mainLobeCoupling
    : sideLobeCoupling / Math.max(normalizedSeparation * normalizedSeparation, 1);
  const sunNoiseTemperatureK = enabled ? Math.max(config?.sunNoiseTemperatureK ?? 0, 0) * Math.max(coupling, 0) : 0;
  const externalNoiseTemperatureK = quietSkyTemperatureK + sunNoiseTemperatureK;
  const systemNoiseTemperatureK = referenceTemperatureK + externalNoiseTemperatureK;
  const environmentalNoiseIncreaseDb = linearToDb(systemNoiseTemperatureK / referenceTemperatureK);
  const solarExclusionAngleDeg = enabled ? Math.max(config?.solarExclusionAngleDeg ?? 0, 0) : 0;
  const solarWarningAngleDeg = enabled
    ? Math.max(config?.solarWarningAngleDeg ?? solarExclusionAngleDeg, solarExclusionAngleDeg)
    : 0;
  const solarInterferenceMaxLossDb = enabled ? Math.max(config?.maxSolarInterferenceLossDb ?? 0, 0) : 0;
  const solarExclusionMarginDeg = sunSeparationDeg - solarExclusionAngleDeg;
  const solarInterferenceBlocked =
    enabled && solarExclusionAngleDeg > 0 && sunSeparationDeg <= solarExclusionAngleDeg;
  const solarWarningSpanDeg = Math.max(solarWarningAngleDeg - solarExclusionAngleDeg, 1e-9);
  const solarProximity =
    enabled && solarWarningAngleDeg > solarExclusionAngleDeg && sunSeparationDeg < solarWarningAngleDeg
      ? Math.max(0, Math.min((solarWarningAngleDeg - Math.max(sunSeparationDeg, solarExclusionAngleDeg)) / solarWarningSpanDeg, 1))
      : 0;
  const solarInterferenceLossDb = solarInterferenceBlocked
    ? solarInterferenceMaxLossDb
    : solarInterferenceMaxLossDb * solarProximity * solarProximity;

  return {
    sun_separation_deg: round(sunSeparationDeg, 3),
    sun_noise_temperature_k: round(sunNoiseTemperatureK, 2),
    sky_noise_temperature_k: round(quietSkyTemperatureK, 2),
    external_noise_temperature_k: round(externalNoiseTemperatureK, 2),
    receiver_reference_temperature_k: round(referenceTemperatureK, 2),
    system_noise_temperature_k: round(systemNoiseTemperatureK, 2),
    environmental_noise_increase_db: round(environmentalNoiseIncreaseDb, 4),
    noise_warning_increase_db: round(config?.warningNoiseIncreaseDb ?? Number.POSITIVE_INFINITY, 3),
    solar_exclusion_angle_deg: round(solarExclusionAngleDeg, 3),
    solar_warning_angle_deg: round(solarWarningAngleDeg, 3),
    solar_exclusion_margin_deg: round(solarExclusionMarginDeg, 3),
    solar_interference_loss_db: round(solarInterferenceLossDb, 4),
    solar_interference_blocked: solarInterferenceBlocked,
  };
}

export function shannonCapacityMbps(channelBandwidthMhz: number, snrDb: number, efficiency = 1) {
  const bandwidthHz = Math.max(channelBandwidthMhz, 0) * 1e6;
  const snrLinear = dbToLinear(snrDb);
  return (bandwidthHz * Math.log2(1 + snrLinear) * efficiency) / 1e6;
}

export function calculateDopplerState(
  relativeRadialVelocityKmS: number,
  frequencyGhz: number,
  config?: LinkDopplerEndpointConfig,
  enabled = true,
): LinkDopplerState {
  const frequencyHz = Math.max(frequencyGhz, 0) * 1e9;
  const dopplerShiftHz = enabled ? (frequencyHz * relativeRadialVelocityKmS) / SPEED_OF_LIGHT_KM_PER_S : 0;
  const absShiftHz = Math.abs(dopplerShiftHz);
  const compensationRangeHz = enabled ? (config?.compensationRangeHz ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const uncompensatedHz = Math.max(0, absShiftHz - compensationRangeHz);
  const trackingResidualHz = enabled
    ? Math.max(config?.residualFloorHz ?? 0, absShiftHz * (config?.residualFraction ?? 0))
    : 0;
  const residualHz = Math.min(absShiftHz, uncompensatedHz + trackingResidualHz);
  const maxResidualHz = config?.maxResidualHz ?? Number.POSITIVE_INFINITY;
  const warningResidualHz = config?.warningResidualHz ?? Number.POSITIVE_INFINITY;
  const maxLossDb = config?.maxDopplerLossDb ?? 0;
  const normalizedResidual = Number.isFinite(maxResidualHz) && maxResidualHz > 0
    ? Math.min(residualHz / maxResidualHz, 1)
    : 0;
  const dopplerLossDb = enabled ? maxLossDb * normalizedResidual * normalizedResidual : 0;

  return {
    relative_radial_velocity_km_s: round(relativeRadialVelocityKmS, 5),
    doppler_shift_hz: round(dopplerShiftHz, 2),
    doppler_shift_ppm: frequencyHz > 0 ? round((dopplerShiftHz / frequencyHz) * 1e6, 6) : 0,
    doppler_compensation_range_hz: Number.isFinite(compensationRangeHz) ? round(compensationRangeHz, 2) : 0,
    doppler_tracking_margin_hz: Number.isFinite(compensationRangeHz) ? round(compensationRangeHz - absShiftHz, 2) : 0,
    doppler_residual_hz: round(residualHz, 2),
    doppler_residual_ppm: frequencyHz > 0 ? round((residualHz / frequencyHz) * 1e6, 6) : 0,
    doppler_residual_margin_hz: Number.isFinite(maxResidualHz) ? round(maxResidualHz - residualHz, 2) : 0,
    doppler_warning_residual_hz: Number.isFinite(warningResidualHz) ? round(warningResidualHz, 2) : 0,
    doppler_loss_db: round(dopplerLossDb, 4),
  };
}

function erf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x));
  return sign * y;
}

function erfc(value: number) {
  return 1 - erf(value);
}

function qFunction(value: number) {
  return 0.5 * erfc(value / Math.SQRT2);
}

function modulationOrder(modulation: ModulationName) {
  if (modulation === "BPSK") return 2;
  if (modulation === "QPSK") return 4;
  if (modulation === "8PSK") return 8;
  if (modulation === "16QAM") return 16;
  if (modulation === "64QAM") return 64;
  return 2;
}

function estimateBitErrorRate(modulation: ModulationName, ebN0Db: number) {
  const ebN0 = dbToLinear(ebN0Db);
  if (modulation === "BPSK" || modulation === "QPSK") {
    return 0.5 * erfc(Math.sqrt(ebN0));
  }

  const order = modulationOrder(modulation);
  const bitsPerSymbol = Math.log2(order);
  if (modulation === "8PSK") {
    return Math.min(0.5, (2 / bitsPerSymbol) * qFunction(Math.sqrt(2 * bitsPerSymbol * ebN0) * Math.sin(Math.PI / order)));
  }

  const sqrtOrder = Math.sqrt(order);
  return Math.min(
    0.5,
    (4 / bitsPerSymbol) *
      (1 - 1 / sqrtOrder) *
      qFunction(Math.sqrt((3 * bitsPerSymbol * ebN0) / (order - 1))),
  );
}

function packetErrorRate(bitErrorRate: number, packetSizeBytes: number) {
  const bits = Math.max(1, packetSizeBytes * 8);
  const ber = Math.max(0, Math.min(bitErrorRate, 0.5));
  return 1 - Math.exp(bits * Math.log1p(-ber));
}

function applyAdaptiveCoding(
  budget: LinkBudgetState,
  qualityDb: number,
  qualityLimitedCapacityMbps: number,
  config: LinkBudgetConfig,
  adaptiveCoding?: AdaptiveCodingConfig,
): LinkBudgetState {
  const availabilityFactor = Math.max(0, Math.min(budget.availability_factor, 1));
  const fallbackCapacity = Math.max(0, Math.min(qualityLimitedCapacityMbps, budget.capacity_limit_mbps));
  if (!adaptiveCoding?.enabled || adaptiveCoding.schemes.length === 0) {
    const effectiveCapacity = fallbackCapacity * availabilityFactor;
    return {
      ...budget,
      mcs_id: "ideal-shannon",
      modulation: "ideal",
      code_rate: 1,
      mcs_required_sinr_db: 0,
      mcs_margin_db: round(qualityDb, 2),
      raw_mcs_capacity_mbps: round(fallbackCapacity, 2),
      bit_error_rate: 0,
      packet_error_rate: 0,
      target_packet_error_rate: adaptiveCoding?.targetPacketErrorRate ?? 0,
      effective_capacity_mbps: round(effectiveCapacity, 2),
      capacity_mbps: round(effectiveCapacity, 2),
      spectral_efficiency_bps_hz: config.channelBandwidthMhz > 0 ? round(effectiveCapacity / config.channelBandwidthMhz, 3) : 0,
    };
  }

  const orderedSchemes = [...adaptiveCoding.schemes].sort(
    (a, b) => a.requiredSinrDb - b.requiredSinrDb || a.spectralEfficiencyBpsHz - b.spectralEfficiencyBpsHz,
  );
  const evaluatedSchemes = orderedSchemes.map((scheme) => {
    const ebN0Db = qualityDb - 10 * Math.log10(Math.max(scheme.spectralEfficiencyBpsHz, 1e-9)) + scheme.codingGainDb;
    const bitError = estimateBitErrorRate(scheme.modulation, ebN0Db);
    const packetError = packetErrorRate(bitError, adaptiveCoding.packetSizeBytes);
    return { scheme, bitError, packetError };
  });
  const feasibleSchemes = evaluatedSchemes.filter(({ scheme }) => qualityDb >= scheme.requiredSinrDb);
  const reliableSchemes = feasibleSchemes.filter(
    ({ packetError }) => packetError <= adaptiveCoding.targetPacketErrorRate,
  );
  const selectedEvaluation =
    reliableSchemes.sort((a, b) => a.scheme.spectralEfficiencyBpsHz - b.scheme.spectralEfficiencyBpsHz).at(-1) ??
    feasibleSchemes.sort((a, b) => a.packetError - b.packetError).at(0) ??
    evaluatedSchemes.sort((a, b) => a.packetError - b.packetError).at(0)!;
  const { scheme: selected, bitError, packetError } = selectedEvaluation;
  const rawMcsCapacityMbps = selected.spectralEfficiencyBpsHz * config.channelBandwidthMhz;
  const mcsLimitedCapacity = Math.min(rawMcsCapacityMbps, fallbackCapacity, budget.capacity_limit_mbps);
  const effectiveCapacity = Math.max(0, mcsLimitedCapacity * (1 - packetError) * availabilityFactor);

  return {
    ...budget,
    mcs_id: selected.id,
    modulation: selected.modulation,
    code_rate: round(selected.codeRate, 3),
    mcs_required_sinr_db: round(selected.requiredSinrDb, 2),
    mcs_margin_db: round(qualityDb - selected.requiredSinrDb, 2),
    raw_mcs_capacity_mbps: round(rawMcsCapacityMbps, 2),
    bit_error_rate: bitError,
    packet_error_rate: packetError,
    target_packet_error_rate: adaptiveCoding.targetPacketErrorRate,
    effective_capacity_mbps: round(effectiveCapacity, 2),
    capacity_mbps: round(effectiveCapacity, 2),
    spectral_efficiency_bps_hz: round(selected.spectralEfficiencyBpsHz, 3),
  };
}

export function calculateLinkBudget({
  distanceKm,
  txPowerW,
  txGainDbi,
  rxGainDbi,
  capacityLimitMbps,
  config,
  lossBreakdown,
  pointingState,
  dopplerState,
  noiseState,
  adaptiveCoding,
  channelId = 0,
  channelOffsetMhz = 0,
}: {
  distanceKm: number;
  txPowerW: number;
  txGainDbi: number;
  rxGainDbi: number;
  capacityLimitMbps: number;
  config: LinkBudgetConfig;
  lossBreakdown?: Partial<LinkLossBreakdown>;
  pointingState?: Partial<LinkPointingState>;
  dopplerState?: Partial<LinkDopplerState>;
  noiseState?: Partial<LinkNoiseState>;
  adaptiveCoding?: AdaptiveCodingConfig;
  channelId?: number;
  channelOffsetMhz?: number;
}): LinkBudgetState {
  const transmitPowerDbm = wattsToDbm(txPowerW);
  const channelFrequencyGhz = Math.max(config.frequencyGhz + channelOffsetMhz / 1000, 0.001);
  const freeSpaceLossDb = freeSpacePathLossDb(distanceKm, channelFrequencyGhz);
  const atmosphericLossDb = lossBreakdown?.atmosphericLossDb ?? config.atmosphericLossDb;
  const rainAttenuationDb = lossBreakdown?.rainAttenuationDb ?? 0;
  const gaseousAttenuationDb = lossBreakdown?.gaseousAttenuationDb ?? 0;
  const cloudAttenuationDb = lossBreakdown?.cloudAttenuationDb ?? 0;
  const scintillationLossDb = lossBreakdown?.scintillationLossDb ?? 0;
  const pointingLossDb = lossBreakdown?.pointingLossDb ?? config.pointingLossDb;
  const dynamicPointingLossDb = pointingState?.dynamic_pointing_loss_db ?? Math.max(0, pointingLossDb - config.pointingLossDb);
  const availabilityFactor = Math.max(0, Math.min(pointingState?.availability_factor ?? 1, 1));
  const dopplerLossDb = dopplerState?.doppler_loss_db ?? 0;
  const environmentalNoiseIncreaseDb = noiseState?.environmental_noise_increase_db ?? 0;
  const solarInterferenceLossDb = noiseState?.solar_interference_loss_db ?? 0;
  const totalLossDb =
    freeSpaceLossDb +
    config.implementationLossDb +
    atmosphericLossDb +
    config.polarizationLossDb +
    pointingLossDb +
    dopplerLossDb +
    solarInterferenceLossDb;
  const receivedPowerDbm = transmitPowerDbm + txGainDbi + rxGainDbi - totalLossDb;
  const noiseDbm = noisePowerDbm(config.channelBandwidthMhz, config.noiseFigureDb) + environmentalNoiseIncreaseDb;
  const snrDb = receivedPowerDbm - noiseDbm;
  const shannonCapacity = shannonCapacityMbps(
    config.channelBandwidthMhz,
    snrDb,
    config.capacityEfficiency,
  );
  const capacityMbps = Math.max(0, Math.min(shannonCapacity, capacityLimitMbps));

  const budget: LinkBudgetState = {
    frequency_ghz: round(channelFrequencyGhz, 4),
    channel_bandwidth_mhz: round(config.channelBandwidthMhz, 2),
    channel_id: Math.round(channelId),
    channel_offset_mhz: round(channelOffsetMhz, 2),
    capacity_limit_mbps: round(capacityLimitMbps, 2),
    implementation_loss_db: round(config.implementationLossDb, 2),
    atmospheric_loss_db: round(atmosphericLossDb, 2),
    rain_attenuation_db: round(rainAttenuationDb, 2),
    gaseous_attenuation_db: round(gaseousAttenuationDb, 2),
    cloud_attenuation_db: round(cloudAttenuationDb, 2),
    scintillation_loss_db: round(scintillationLossDb, 2),
    polarization_loss_db: round(config.polarizationLossDb, 2),
    pointing_loss_db: round(pointingLossDb, 2),
    base_pointing_loss_db: round(config.pointingLossDb, 2),
    dynamic_pointing_loss_db: round(dynamicPointingLossDb, 3),
    source_pointing_error_deg: round(pointingState?.source_pointing_error_deg ?? 0, 3),
    target_pointing_error_deg: round(pointingState?.target_pointing_error_deg ?? 0, 3),
    source_slew_angle_deg: round(pointingState?.source_slew_angle_deg ?? 0, 2),
    target_slew_angle_deg: round(pointingState?.target_slew_angle_deg ?? 0, 2),
    switching_delay_s: round(pointingState?.switching_delay_s ?? 0, 2),
    availability_factor: round(availabilityFactor, 4),
    relative_radial_velocity_km_s: round(dopplerState?.relative_radial_velocity_km_s ?? 0, 5),
    doppler_shift_hz: round(dopplerState?.doppler_shift_hz ?? 0, 2),
    doppler_shift_ppm: round(dopplerState?.doppler_shift_ppm ?? 0, 6),
    doppler_compensation_range_hz: round(dopplerState?.doppler_compensation_range_hz ?? 0, 2),
    doppler_tracking_margin_hz: round(dopplerState?.doppler_tracking_margin_hz ?? 0, 2),
    doppler_residual_hz: round(dopplerState?.doppler_residual_hz ?? 0, 2),
    doppler_residual_ppm: round(dopplerState?.doppler_residual_ppm ?? 0, 6),
    doppler_residual_margin_hz: round(dopplerState?.doppler_residual_margin_hz ?? 0, 2),
    doppler_warning_residual_hz: round(dopplerState?.doppler_warning_residual_hz ?? 0, 2),
    doppler_loss_db: round(dopplerLossDb, 4),
    sun_separation_deg: round(noiseState?.sun_separation_deg ?? 180, 3),
    sun_noise_temperature_k: round(noiseState?.sun_noise_temperature_k ?? 0, 2),
    sky_noise_temperature_k: round(noiseState?.sky_noise_temperature_k ?? 0, 2),
    external_noise_temperature_k: round(noiseState?.external_noise_temperature_k ?? 0, 2),
    receiver_reference_temperature_k: round(noiseState?.receiver_reference_temperature_k ?? 290, 2),
    system_noise_temperature_k: round(noiseState?.system_noise_temperature_k ?? 290, 2),
    environmental_noise_increase_db: round(environmentalNoiseIncreaseDb, 4),
    noise_warning_increase_db: round(noiseState?.noise_warning_increase_db ?? 0, 3),
    solar_exclusion_angle_deg: round(noiseState?.solar_exclusion_angle_deg ?? 0, 3),
    solar_warning_angle_deg: round(noiseState?.solar_warning_angle_deg ?? 0, 3),
    solar_exclusion_margin_deg: round(noiseState?.solar_exclusion_margin_deg ?? 180, 3),
    solar_interference_loss_db: round(solarInterferenceLossDb, 4),
    solar_interference_blocked: noiseState?.solar_interference_blocked ?? false,
    transmit_power_dbm: round(transmitPowerDbm, 2),
    transmit_gain_dbi: round(txGainDbi, 2),
    receive_gain_dbi: round(rxGainDbi, 2),
    free_space_path_loss_db: round(freeSpaceLossDb, 2),
    total_loss_db: round(totalLossDb, 2),
    received_power_dbm: round(receivedPowerDbm, 2),
    noise_power_dbm: round(noiseDbm, 2),
    snr_db: round(snrDb, 2),
    link_margin_db: round(snrDb - config.minSnrDb, 2),
    shannon_capacity_mbps: round(shannonCapacity, 2),
    interference_power_dbm: -999,
    interference_to_noise_db: -999,
    sinr_db: round(snrDb, 2),
    sinr_margin_db: round(snrDb - config.minSnrDb, 2),
    interference_limited_capacity_mbps: round(shannonCapacity, 2),
    interference_count: 0,
    co_channel_interference_count: 0,
    adjacent_channel_interference_count: 0,
    filtered_channel_interference_count: 0,
    mcs_id: "ideal-shannon",
    modulation: "ideal",
    code_rate: 1,
    mcs_required_sinr_db: 0,
    mcs_margin_db: round(snrDb, 2),
    raw_mcs_capacity_mbps: round(capacityMbps, 2),
    bit_error_rate: 0,
    packet_error_rate: 0,
    target_packet_error_rate: adaptiveCoding?.targetPacketErrorRate ?? 0,
    effective_capacity_mbps: round(capacityMbps, 2),
    capacity_mbps: round(capacityMbps, 2),
    spectral_efficiency_bps_hz: config.channelBandwidthMhz > 0 ? round(capacityMbps / config.channelBandwidthMhz, 3) : 0,
  };

  return applyAdaptiveCoding(budget, snrDb, shannonCapacity, config, adaptiveCoding);
}

export function applyInterferenceToLinkBudget(
  budget: LinkBudgetState,
  interferencePowerMw: number,
  interferenceCount: number,
  dominantInterfererId: string | undefined,
  config: LinkBudgetConfig,
  adaptiveCoding?: AdaptiveCodingConfig,
  interferenceBreakdown?: {
    coChannelCount: number;
    adjacentChannelCount: number;
    filteredChannelCount: number;
    dominantInterfererChannelDelta?: number;
  },
): LinkBudgetState {
  const signalMw = dbmToMilliwatts(budget.received_power_dbm);
  const noiseMw = dbmToMilliwatts(budget.noise_power_dbm);
  const interferenceMw = Math.max(0, interferencePowerMw);
  const sinrDb = linearToDb(signalMw / Math.max(noiseMw + interferenceMw, 1e-30));
  const interferenceCapacity = shannonCapacityMbps(
    config.channelBandwidthMhz,
    sinrDb,
    config.capacityEfficiency,
  );
  const updatedBudget = {
    ...budget,
    interference_power_dbm: round(milliwattsToDbm(interferenceMw), 2),
    interference_to_noise_db: round(linearToDb(interferenceMw / Math.max(noiseMw, 1e-30)), 2),
    sinr_db: round(sinrDb, 2),
    sinr_margin_db: round(sinrDb - config.minSnrDb, 2),
    interference_limited_capacity_mbps: round(interferenceCapacity, 2),
    interference_count: interferenceCount,
    co_channel_interference_count: interferenceBreakdown?.coChannelCount ?? 0,
    adjacent_channel_interference_count: interferenceBreakdown?.adjacentChannelCount ?? 0,
    filtered_channel_interference_count: interferenceBreakdown?.filteredChannelCount ?? 0,
    dominant_interferer_channel_delta: interferenceBreakdown?.dominantInterfererChannelDelta,
    dominant_interferer_id: dominantInterfererId,
  };

  return applyAdaptiveCoding(updatedBudget, sinrDb, interferenceCapacity, config, adaptiveCoding);
}

export function budgetStatus(
  budget: LinkBudgetState,
  config: LinkBudgetConfig,
): "up" | "warning" | "down" {
  if (budget.solar_interference_blocked) {
    return "down";
  }
  const qualityDb = budget.sinr_db ?? budget.snr_db;
  if (qualityDb < config.minSnrDb || budget.capacity_mbps < config.minCapacityMbps) {
    return "down";
  }
  if (budget.doppler_tracking_margin_hz < 0 || budget.doppler_residual_margin_hz < 0) {
    return "down";
  }
  if (budget.target_packet_error_rate > 0 && budget.packet_error_rate > budget.target_packet_error_rate) {
    return "warning";
  }
  if (
    budget.noise_warning_increase_db > 0 &&
    budget.environmental_noise_increase_db > budget.noise_warning_increase_db
  ) {
    return "warning";
  }
  if (
    budget.doppler_warning_residual_hz > 0 &&
    Math.abs(budget.doppler_residual_hz) > budget.doppler_warning_residual_hz
  ) {
    return "warning";
  }
  if (qualityDb < config.minSnrDb + config.warningMarginDb) {
    return "warning";
  }
  return "up";
}
