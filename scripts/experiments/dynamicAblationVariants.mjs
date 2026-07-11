export const EXPERIMENT11_FULL_METHOD_ID = "full-enhanced";

export const EXPERIMENT11_VARIANT_IDS = Object.freeze([
  EXPERIMENT11_FULL_METHOD_ID,
  "without-topology-adaptation",
  "without-forecast-orbit-priors",
  "without-node-state-coupling",
  "without-energy-physics-prior",
  "without-tensor-traffic-context",
]);

const FULL_MECHANISMS = Object.freeze({
  adaptiveReuse: true,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
  adaptiveProbeBudget: false,
  metricTensorCoupling: true,
  nodeStateCoupling: true,
  nodeEnergyPhysicsPrior: true,
  jointStateCoupling: true,
  orbitGraphRegularization: true,
  orbitPeriodicPrior: true,
  orbitPeriodicPriorSlices: 19,
  oamQualityFeedback: false,
  businessHotspotMigrationPrior: true,
  stateTensorJointCompletion: true,
  multiObjectiveBudget: false,
  oamTargetAwareMetadata: false,
});

const VARIANT_DEFINITIONS = Object.freeze([
  {
    id: EXPERIMENT11_FULL_METHOD_ID,
    label: "完整增强版 LEO-INT-MC",
    disabledMechanisms: [],
  },
  {
    id: "without-topology-adaptation",
    label: "移除拓扑自适应",
    disabledMechanisms: ["adaptiveReuse", "incrementalTopologyRepair"],
  },
  {
    id: "without-forecast-orbit-priors",
    label: "移除预测与轨道先验",
    disabledMechanisms: ["forecastRiskScoring", "orbitGraphRegularization", "orbitPeriodicPrior"],
  },
  {
    id: "without-node-state-coupling",
    label: "移除节点状态耦合",
    disabledMechanisms: ["nodeStateCoupling", "jointStateCoupling"],
  },
  {
    id: "without-energy-physics-prior",
    label: "移除能量物理先验",
    disabledMechanisms: ["nodeEnergyPhysicsPrior"],
  },
  {
    id: "without-tensor-traffic-context",
    label: "移除张量与业务上下文",
    disabledMechanisms: [
      "metricTensorCoupling",
      "stateTensorJointCompletion",
      "businessHotspotMigrationPrior",
    ],
  },
]);

function buildMechanisms(disabledMechanisms) {
  const mechanisms = { ...FULL_MECHANISMS };
  for (const mechanism of disabledMechanisms) {
    mechanisms[mechanism] = false;
  }
  return Object.freeze(mechanisms);
}

export function buildExperiment11Variants() {
  return VARIANT_DEFINITIONS.map((definition) =>
    Object.freeze({
      id: definition.id,
      label: definition.label,
      ablation_group: definition.id === EXPERIMENT11_FULL_METHOD_ID ? "none" : definition.id,
      mechanisms: buildMechanisms(definition.disabledMechanisms),
    }),
  );
}
