export const DEFAULT_GOAL_ALGORITHM = "int-mc";

function pct(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "-";
}

function check(label, passed, evidence) {
  return { label, passed: Boolean(passed), evidence };
}

export function buildGoalCoverageChecks({ algorithm, accuracy } = {}) {
  const primary = accuracy?.primary_probe_int ?? {};
  const probe = primary.metrics ?? {};
  if (algorithm === "int-mc") {
    const intMc = primary.int_mc_metrics ?? {};
    return [
      check("主遥测模式为 LEO-INT-MC", accuracy?.conclusion?.primary_mode === "leo-int-mc", accuracy?.conclusion?.primary_mode ?? ""),
      check("INT-MC 活动链路补全覆盖率 100%", intMc.active_link_completion_coverage === 1, pct(intMc.active_link_completion_coverage)),
      check("INT-MC 节点补全覆盖率 100%", intMc.node_completion_coverage === 1, pct(intMc.node_completion_coverage)),
      check("INT-MC unknown 链路样本为 0", intMc.unknown_link_samples === 0, String(intMc.unknown_link_samples ?? "")),
      check("准确率报告结论通过", accuracy?.conclusion?.pass === true, accuracy?.conclusion?.statement ?? ""),
    ];
  }
  const audit = primary.coverage_audit_summary ?? {};
  return [
    check("probe-int 节点覆盖率 100%", probe.node_sample_coverage === 1, pct(probe.node_sample_coverage)),
    check("probe-int 链路覆盖率 100%", probe.link_sample_coverage === 1, pct(probe.link_sample_coverage)),
    check("probe-int 活动链路覆盖率 100%", probe.active_link_sample_coverage === 1, pct(probe.active_link_sample_coverage)),
    check("probe-int unknown 样本为 0", probe.unknown_node_samples === 0 && probe.unknown_link_samples === 0, `${probe.unknown_node_samples}/${probe.unknown_link_samples}`),
    check("逐时间片全覆盖审计通过", probe.full_time_step_pass === true && audit.pass === true, `${audit.passed_slices}/${audit.slices}`),
    check("准确率报告结论通过", accuracy?.conclusion?.pass === true, accuracy?.conclusion?.statement ?? ""),
  ];
}
