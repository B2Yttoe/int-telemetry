export type NodeMode = "nominal" | "warning" | "degraded";
export type LinkStatus = "up" | "warning" | "down";
export type LinkKind = "intra-plane" | "inter-plane";
export type LinkRestrictionReason =
  | "distance-threshold"
  | "polar-region"
  | "earth-occluded"
  | "antenna-range"
  | "pointing-switch"
  | "doppler-shift"
  | "solar-interference"
  | "link-budget"
  | "capacity-limit";
export type WalkerType = "star" | "delta";
export type CoordinateFrame = "ECI" | "ECEF";
export type InterPlaneDirection = "left" | "right" | "none";
export type NodeType = "satellite" | "HAPS" | "ground";
export type SimulationMode = "autonomous" | "operational";
export type TrafficProfile = "empty" | "low-load" | "normal" | "high-load" | "hotspot" | "burst" | "long-duration" | "uploaded";
export type TaskType = "compute" | "routing" | "downlink" | "telemetry" | "mixed" | "background" | "burst";
export type OrbitModel = "analytic-walker" | "tle-sgp4" | "real-tle-sgp4";
export type TleCatalogSource = "synthetic-walker" | "celestrak" | "space-track" | "file";
export type RoutingAlgorithm = "shortest-path";
export type RoutingStatus = "routed" | "unroutable" | "local" | "not-requested";
export type SatelliteOperationalStatus = "active" | "decaying" | "deorbited" | "backup";
export type AntennaType = "ISL" | "SGL" | "USER";
export type AntennaBand = "Ka" | "Ku" | "laser";
export type AntennaRole = "front" | "back" | "left" | "right" | "earth-facing" | "user-facing";
export type AntennaState = "idle" | "occupied" | "switching" | "fault";
export type GroundLinkStatus = "available" | "blocked" | "occupied";
export type ModulationName = "ideal" | "BPSK" | "QPSK" | "8PSK" | "16QAM" | "64QAM";

export interface Vector3Km {
  x: number;
  y: number;
  z: number;
}

export interface VelocityVectorKmS {
  vx: number;
  vy: number;
  vz: number;
}

export interface AntennaTemplateConfig {
  band: AntennaBand;
  gainDbi: number;
  beamwidthDeg: number;
  maxRangeKm: number;
  maxTxPowerW: number;
  bandwidthMbps: number;
  maxSimultaneousBeams: number;
  slewRateDegPerSec: number;
}

export interface LinkBudgetConfig {
  frequencyGhz: number;
  channelBandwidthMhz: number;
  noiseFigureDb: number;
  implementationLossDb: number;
  atmosphericLossDb: number;
  polarizationLossDb: number;
  pointingLossDb: number;
  capacityEfficiency: number;
  minSnrDb: number;
  warningMarginDb: number;
  minCapacityMbps: number;
  groundStationGainDbi?: number;
}

export interface LinkLossBreakdown {
  atmosphericLossDb: number;
  rainAttenuationDb: number;
  gaseousAttenuationDb: number;
  cloudAttenuationDb: number;
  scintillationLossDb: number;
  pointingLossDb: number;
}

export interface LinkInterferenceModelConfig {
  enabled: boolean;
  reuseChannelCount: number;
  channelSpacingMhz: number;
  coChannelIsolationDb: number;
  adjacentChannelIsolationDb: number;
  adjacentChannelRollOffDbPerStep: number;
  maxAdjacentChannelSeparation: number;
  polarizationIsolationDb: number;
  sideLobeSuppressionDb: number;
  frontBackSuppressionDb: number;
  selfInterferenceIsolationDb: number;
  offAxisRollOffDbPerDecade: number;
  minSideLobeGainDbi: number;
  minInterferencePowerDbm: number;
}

export interface ModulationCodingScheme {
  id: string;
  modulation: ModulationName;
  codeRate: number;
  spectralEfficiencyBpsHz: number;
  requiredSinrDb: number;
  codingGainDb: number;
}

export interface AdaptiveCodingConfig {
  enabled: boolean;
  packetSizeBytes: number;
  targetPacketErrorRate: number;
  schemes: ModulationCodingScheme[];
}

export interface AntennaPointingModelConfig {
  enabled: boolean;
  acquisitionTimeSeconds: number;
  trackingLoopLagSeconds: number;
  minAvailableFraction: number;
  warningAvailableFraction: number;
  isl: {
    pointingJitterDeg: number;
  };
  sgl: {
    pointingJitterDeg: number;
  };
}

export interface LinkDopplerEndpointConfig {
  compensationRangeHz: number;
  residualFraction: number;
  residualFloorHz: number;
  maxResidualHz: number;
  warningResidualHz: number;
  maxDopplerLossDb: number;
}

export interface LinkDopplerModelConfig {
  enabled: boolean;
  isl: LinkDopplerEndpointConfig;
  sgl: LinkDopplerEndpointConfig;
}

export interface LinkNoiseEndpointConfig {
  receiverReferenceTemperatureK: number;
  quietSkyTemperatureK: number;
  sunNoiseTemperatureK: number;
  sunAngularRadiusDeg: number;
  mainLobeCoupling: number;
  sideLobeCoupling: number;
  warningNoiseIncreaseDb: number;
  solarExclusionAngleDeg: number;
  solarWarningAngleDeg: number;
  maxSolarInterferenceLossDb: number;
}

export interface LinkNoiseModelConfig {
  enabled: boolean;
  isl: LinkNoiseEndpointConfig;
  sgl: LinkNoiseEndpointConfig;
}

export interface LinkPointingState {
  source_pointing_error_deg: number;
  target_pointing_error_deg: number;
  source_slew_angle_deg: number;
  target_slew_angle_deg: number;
  switching_delay_s: number;
  availability_factor: number;
  dynamic_pointing_loss_db: number;
}

export interface LinkDopplerState {
  relative_radial_velocity_km_s: number;
  doppler_shift_hz: number;
  doppler_shift_ppm: number;
  doppler_compensation_range_hz: number;
  doppler_tracking_margin_hz: number;
  doppler_residual_hz: number;
  doppler_residual_ppm: number;
  doppler_residual_margin_hz: number;
  doppler_warning_residual_hz: number;
  doppler_loss_db: number;
}

export interface LinkNoiseState {
  sun_separation_deg: number;
  sun_noise_temperature_k: number;
  sky_noise_temperature_k: number;
  external_noise_temperature_k: number;
  receiver_reference_temperature_k: number;
  system_noise_temperature_k: number;
  environmental_noise_increase_db: number;
  noise_warning_increase_db: number;
  solar_exclusion_angle_deg: number;
  solar_warning_angle_deg: number;
  solar_exclusion_margin_deg: number;
  solar_interference_loss_db: number;
  solar_interference_blocked: boolean;
}

export interface LinkBudgetState {
  frequency_ghz: number;
  channel_bandwidth_mhz: number;
  channel_id: number;
  channel_offset_mhz: number;
  capacity_limit_mbps: number;
  implementation_loss_db: number;
  atmospheric_loss_db: number;
  rain_attenuation_db: number;
  gaseous_attenuation_db: number;
  cloud_attenuation_db: number;
  scintillation_loss_db: number;
  polarization_loss_db: number;
  pointing_loss_db: number;
  base_pointing_loss_db: number;
  dynamic_pointing_loss_db: number;
  source_pointing_error_deg: number;
  target_pointing_error_deg: number;
  source_slew_angle_deg: number;
  target_slew_angle_deg: number;
  switching_delay_s: number;
  availability_factor: number;
  relative_radial_velocity_km_s: number;
  doppler_shift_hz: number;
  doppler_shift_ppm: number;
  doppler_compensation_range_hz: number;
  doppler_tracking_margin_hz: number;
  doppler_residual_hz: number;
  doppler_residual_ppm: number;
  doppler_residual_margin_hz: number;
  doppler_warning_residual_hz: number;
  doppler_loss_db: number;
  sun_separation_deg: number;
  sun_noise_temperature_k: number;
  sky_noise_temperature_k: number;
  external_noise_temperature_k: number;
  receiver_reference_temperature_k: number;
  system_noise_temperature_k: number;
  environmental_noise_increase_db: number;
  noise_warning_increase_db: number;
  solar_exclusion_angle_deg: number;
  solar_warning_angle_deg: number;
  solar_exclusion_margin_deg: number;
  solar_interference_loss_db: number;
  solar_interference_blocked: boolean;
  transmit_power_dbm: number;
  transmit_gain_dbi: number;
  receive_gain_dbi: number;
  free_space_path_loss_db: number;
  total_loss_db: number;
  received_power_dbm: number;
  noise_power_dbm: number;
  snr_db: number;
  link_margin_db: number;
  shannon_capacity_mbps: number;
  interference_power_dbm: number;
  interference_to_noise_db: number;
  sinr_db: number;
  sinr_margin_db: number;
  interference_limited_capacity_mbps: number;
  interference_count: number;
  co_channel_interference_count: number;
  adjacent_channel_interference_count: number;
  filtered_channel_interference_count: number;
  dominant_interferer_channel_delta?: number;
  dominant_interferer_id?: string;
  mcs_id: string;
  modulation: ModulationName;
  code_rate: number;
  mcs_required_sinr_db: number;
  mcs_margin_db: number;
  raw_mcs_capacity_mbps: number;
  bit_error_rate: number;
  packet_error_rate: number;
  target_packet_error_rate: number;
  effective_capacity_mbps: number;
  capacity_mbps: number;
  spectral_efficiency_bps_hz: number;
}

export interface TrafficModelConfig {
  normalFlowCount: number;
  normalFlowMinMbps: number;
  normalFlowMaxMbps: number;
  normalFlowDurationSlices: number;
  normalFlowComputeUnits: number;
  endpointCpuPercentPerGbps: number;
  endpointQueueDepthPerGbps: number;
  forwardingCpuPercentPerGbps: number;
  forwardingPowerWPerGbps: number;
  activeIslLinkPowerW: number;
  activeSglLinkPowerW: number;
  queueCpuPercentPerGb: number;
  queuePowerWPerGb: number;
  queueDepthPerQueuedMb: number;
  queueCarryoverRatio: number;
  linkQueueCapacityMb: number;
  cacheCapacityMb: number;
  telemetryGenerationMbPerSlice: number;
  telemetryCpuMbPerPercent: number;
  telemetryTrafficMbPerGbps: number;
  telemetryCongestionMbPerPercent: number;
  telemetryTaskSamplingRatio: number;
  downlinkTaskSamplingRatio: number;
  telemetryBufferCapacityMb: number;
}

export interface AntennaPointing {
  azimuthRangeDeg: [number, number];
  elevationRangeDeg: [number, number];
  description: string;
}

export interface SatelliteAntenna {
  antenna_id: string;
  satellite_id: string;
  type: AntennaType;
  role: AntennaRole;
  band: AntennaBand;
  gain_dbi: number;
  beamwidth_deg: number;
  max_range_km: number;
  max_tx_power_w: number;
  bandwidth_mbps: number;
  max_simultaneous_beams: number;
  pointing: AntennaPointing;
  slew_rate_deg_per_s: number;
  state: AntennaState;
  occupied_beams: number;
  target_ids: string[];
  link_ids: string[];
}

export interface GroundStationWeather {
  rainRateMmPerHour: number;
  rainHeightKm: number;
  gaseousZenithLossDb: number;
  cloudLiquidWaterKgPerM2: number;
  scintillationFadeDb: number;
}

export interface GroundStationWeatherSample extends GroundStationWeather {
  minute: number;
}

export interface GroundStation {
  ground_station_id: string;
  name: string;
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeKm: number;
  minElevationDeg?: number;
  weather?: GroundStationWeather;
  weatherTimeline?: GroundStationWeatherSample[];
}

export interface GroundLinkWindow {
  id: string;
  time: string;
  satellite_id: string;
  ground_station_id: string;
  ground_station_name: string;
  antenna_id: string;
  status: GroundLinkStatus;
  visible: boolean;
  elevationDeg: number;
  slantRangeKm: number;
  rainRateMmPerHour: number;
  cloudLiquidWaterKgPerM2: number;
  scintillationFadeDb: number;
  weatherSampleMinute: number;
  capacityMbps: number;
  reportCapacityMbps: number;
  linkBudget?: LinkBudgetState;
  reason?:
    | "below-elevation"
    | "antenna-range"
    | "antenna-occupied"
    | "pointing-switch"
    | "doppler-shift"
    | "solar-interference"
    | "link-budget"
    | "capacity-limit";
}

export interface WalkerNetworkConfig {
  constellation: {
    walkerType: WalkerType;
    shellId: string;
    planes: number;
    satellitesPerPlane: number;
    phasing: number;
    altitudeKm: number;
    inclinationDeg: number;
    earthRadiusKm: number;
    gravitationalParameterKm3S2: number;
  };
  time: {
    epochIso: string;
    slices: number;
    stepMinutes: number;
  };
  orbit: {
    model: OrbitModel;
    tleCatalog: {
      source: TleCatalogSource;
      noradBaseId: number;
      satelliteNamePrefix: string;
      cosparYear: number;
      cosparLaunchNumber: number;
      eccentricity: number;
      bstar: number;
    };
  };
  interPlane: {
    maxDistanceKm: number;
    warningMarginKm: number;
    maxLinksPerNode: number;
  };
  polarRegion: {
    enabled: boolean;
    latitudeDeg: number;
  };
  earthOcclusion: {
    enabled: boolean;
    clearanceKm: number;
  };
  nodeStateDefaults: Omit<SatelliteNodeState, "mode"> & {
    mode: NodeMode;
  };
  nodeResourceDefaults: Omit<NodeResourceState, "node_id">;
  operationalModel: {
    solarConstantWPerM2: number;
    solarArrayAreaM2: number;
    solarArrayEfficiency: number;
    batteryCapacityWh: number;
    basePowerW: number;
    communicationPowerW: number;
    computePowerW: number;
    payloadPowerW: number;
    chargeEfficiency: number;
    dischargeEfficiency: number;
    minStateOfCharge: number;
    cpuLoadPerComputeUnit: number;
    gpuLoadPerGpuUnit: number;
    memoryPercentPerGb: number;
    storagePercentPerGb: number;
    queueDepthPerTask: number;
    thermalRisePerCpuPercent: number;
    thermalRisePerGpuPercent: number;
    thermalRisePerCommunicationW: number;
    queueMemoryGbPerQueuedGb: number;
    telemetryMemoryGbPerBufferedGb: number;
    cacheStorageGbPerBufferedGb: number;
  };
  routing: {
    algorithm: RoutingAlgorithm;
  };
  trafficModel: TrafficModelConfig;
  antennaModel: {
    isl: AntennaTemplateConfig;
    sgl: AntennaTemplateConfig & {
      minElevationDeg: number;
      reportCapacityMbps: number;
    };
  };
  linkBudget: {
    isl: LinkBudgetConfig;
    sgl: LinkBudgetConfig;
  };
  interferenceModel: {
    isl: LinkInterferenceModelConfig;
    sgl: LinkInterferenceModelConfig & {
      groundAntennaBeamwidthDeg: number;
    };
  };
  pointingModel: AntennaPointingModelConfig;
  dopplerModel: LinkDopplerModelConfig;
  noiseModel: LinkNoiseModelConfig;
  atmosphericModel: {
    sgl: {
      enabled: boolean;
      rainSpecificAttenuationK: number;
      rainSpecificAttenuationAlpha: number;
      rainPathReductionReferenceKm: number;
      cloudSpecificAttenuationDbPerKgM2: number;
      minElevationForLossDeg: number;
    };
  };
  adaptiveCoding: {
    isl: AdaptiveCodingConfig;
    sgl: AdaptiveCodingConfig;
  };
  groundStations: GroundStation[];
  linkStateDefaults: Omit<SatelliteLinkState, "status" | "distanceKm" | "isActive" | "lineOfSight" | "restrictionReason"> & {
    status: LinkStatus;
    distanceKm: number;
  };
  stateProfiles: {
    nodeThermalWaveC: number;
    nodeLoadWavePercent: number;
    queueWaveDepth: number;
    linkUtilizationWavePercent: number;
    distanceLatencyDivisor: number;
  };
}

export interface OrbitPosition {
  x: number;
  y: number;
  z: number;
  frame: CoordinateFrame;
  longitudeDeg: number;
  latitudeDeg: number;
  altitudeKm: number;
}

export interface GroundTrackPoint {
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface SatelliteOrbitElements {
  satelliteId: string;
  orbitModel: OrbitModel;
  noradId?: number;
  satelliteName?: string;
  cosparId?: string;
  shellId: string;
  walkerType: WalkerType;
  plane: number;
  slot: number;
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argumentOfPerigeeDeg: number;
  meanAnomalyDegAtEpoch: number;
  meanMotionRadPerSec: number;
  meanMotionRevPerDay?: number;
  orbitalPeriodMinutes: number;
  epochIso: string;
  tleLine1?: string;
  tleLine2?: string;
  bstar?: number;
  status?: SatelliteOperationalStatus;
}

export interface TleSatelliteRecord {
  satellite_id: string;
  norad_id: number;
  satellite_name: string;
  cospar_id: string;
  shell_id: string;
  plane_id: number;
  slot_id: number;
  tle_line1?: string;
  tle_line2?: string;
  epoch: string;
  inclination: number;
  raan: number;
  eccentricity: number;
  argument_of_perigee: number;
  mean_anomaly: number;
  mean_motion: number;
  bstar: number;
  status: SatelliteOperationalStatus;
  raw_omm?: Record<string, unknown>;
  source?: TleCatalogSource;
  source_url?: string;
  catalog_fingerprint?: string;
}

export interface RealTleCatalogSnapshot {
  schema: "int-temerity-real-tle-snapshot/v1";
  source: TleCatalogSource;
  group: string;
  format: "celestrak-gp-json" | "tle";
  source_url: string;
  downloaded_at: string;
  generated_at: string;
  fingerprint: string;
  shell_id: string;
  catalog_count: number;
  shell_count: number;
  selected_count: number;
  mean_altitude_km: number;
  mean_inclination_deg: number;
  mean_mean_motion_rev_per_day: number;
  layout: {
    planes: number;
    satellites_per_plane: number;
    selection_strategy: string;
    raan_cluster_threshold_deg: number;
  };
  satellites: TleSatelliteRecord[];
}

export interface SatelliteTimeState {
  time: string;
  satelliteId: string;
  eci: Vector3Km;
  ecef: Vector3Km;
  velocityEci: VelocityVectorKmS;
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeKm: number;
  orbitalVelocityKmS: number;
  groundTrack: GroundTrackPoint;
  eastWestDriftDeg: number;
  solarExposure: number;
  inSunlight: boolean;
  inEclipse: boolean;
}

export interface SatelliteNodeState {
  mode: NodeMode;
  batteryPercent: number;
  cpuLoadPercent: number;
  temperatureC: number;
  queueDepth: number;
}

export interface NodeResourceState {
  node_id: string;
  node_type: NodeType;
  cpu_capacity: number;
  gpu_capacity?: number;
  memory: number;
  storage: number;
  energy: number;
  energy_wh: number;
  battery_capacity_wh: number;
  state_of_charge: number;
  min_state_of_charge: number;
  solar_power_w: number;
  load_power_w: number;
  net_power_w: number;
  power_saving_mode: boolean;
  cpu_utilization: number;
  compute_cpu_percent: number;
  task_traffic_cpu_percent: number;
  forwarding_cpu_percent: number;
  queue_cpu_percent: number;
  gpu_utilization?: number;
  memory_utilization: number;
  storage_utilization: number;
  can_accept_tasks: boolean;
  assigned_task_count: number;
  workload_cpu_percent: number;
  workload_gpu_percent: number;
  workload_memory_gb: number;
  workload_storage_gb: number;
  memory_used_gb: number;
  storage_used_gb: number;
  ingress_traffic_mbps: number;
  egress_traffic_mbps: number;
  transit_traffic_mbps: number;
  forwarding_load_mbps: number;
  downlink_load_mbps: number;
  active_isl_links: number;
  active_sgl_links: number;
  link_occupancy_percent: number;
  base_power_w: number;
  payload_power_w: number;
  task_compute_power_w: number;
  network_compute_power_w: number;
  communication_power_w: number;
  queued_traffic_mb: number;
  dropped_traffic_mb: number;
  cache_used_mb: number;
  cache_utilization: number;
  telemetry_generated_mb: number;
  telemetry_buffer_mb: number;
  telemetry_downlinked_mb: number;
  telemetry_dropped_mb: number;
}

export interface TaskTrafficRecord {
  task_id: string;
  time?: string | number;
  start_slice: number;
  duration_slices: number;
  source?: string;
  target?: string;
  node_id?: string;
  compute_units: number;
  gpu_units?: number;
  memory_gb?: number;
  storage_gb?: number;
  traffic_mbps?: number;
  priority?: number;
  task_type?: TaskType | string;
  normalization_errors?: string[];
}

export interface NodeTaskLoad {
  taskCount: number;
  computeUnits: number;
  gpuUnits: number;
  memoryGb: number;
  storageGb: number;
  trafficMbps: number;
}

export interface SimulationInput {
  mode: SimulationMode;
  tasks: TaskTrafficRecord[];
  trafficProfile?: TrafficProfile;
  orbitModel?: OrbitModel;
  routingAlgorithm?: RoutingAlgorithm;
  tleCatalogSnapshot?: RealTleCatalogSnapshot;
}

export interface SatelliteNode {
  id: string;
  label: string;
  plane: number;
  slot: number;
  orbit: SatelliteOrbitElements;
  timeState: SatelliteTimeState;
  position: OrbitPosition;
  state: SatelliteNodeState;
  resources: NodeResourceState;
  antennas: SatelliteAntenna[];
  groundLinkWindows: GroundLinkWindow[];
  taskLoad: NodeTaskLoad;
  operationMode: SimulationMode;
}

export interface SatelliteLinkState {
  status: LinkStatus;
  bandwidthMbps: number;
  latencyMs: number;
  utilizationPercent: number;
  demandTrafficMbps: number;
  carriedTrafficMbps: number;
  queuedTrafficMb: number;
  droppedTrafficMb: number;
  congestionPercent: number;
  distanceKm: number;
  isActive: boolean;
  lineOfSight: boolean;
  linkBudget?: LinkBudgetState;
  restrictionReason?: LinkRestrictionReason;
}

export interface SatelliteLink {
  id: string;
  source: string;
  target: string;
  kind: LinkKind;
  interPlaneDirection: InterPlaneDirection;
  designCandidate: boolean;
  sourceAntennaId?: string;
  targetAntennaId?: string;
  state: SatelliteLinkState;
}

export interface RoutedTaskPath {
  task_id: string;
  source?: string;
  target?: string;
  algorithm: RoutingAlgorithm;
  status: RoutingStatus;
  path: string[];
  linkIds: string[];
  hopCount: number;
  distanceKm: number;
  latencyMs: number;
  trafficMbps: number;
  taskType?: TaskType | string;
  priority: number;
  carriedTrafficMbps: number;
  queuedTrafficMb: number;
  droppedTrafficMb: number;
  taskTelemetryNodeId?: string;
  taskTelemetryGeneratedMb: number;
  reason?: string;
}

export interface NetworkSlice {
  index: number;
  minute: number;
  time: string;
  orbitModel: OrbitModel;
  routingAlgorithm: RoutingAlgorithm;
  nodes: SatelliteNode[];
  links: SatelliteLink[];
  groundLinks: GroundLinkWindow[];
  routes: RoutedTaskPath[];
}
