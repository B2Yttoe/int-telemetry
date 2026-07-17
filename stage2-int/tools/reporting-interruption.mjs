function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableHash(value) {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function applyControlledReportingInterruptions(reports = [], { rate = 0, seed = "reporting-interruption" } = {}) {
  const requestedRate = clamp(Number(rate) || 0, 0, 1);
  const interruptedIndexes = new Set();
  const eligible = reports
    .map((report, index) => ({ report, index }))
    .filter(({ report }) =>
      String(report.reporting_status ?? "planned").toLowerCase() === "planned" &&
      String(report.status ?? "generated").toLowerCase() === "generated"
    )
    .map((entry) => ({
      ...entry,
      score: stableHash(`${seed}|${entry.report.slice_index ?? ""}|${entry.report.probe_id ?? entry.report.report_id ?? entry.index}`),
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index);
  const eligibleReports = eligible.length;
  eligible
    .slice(0, Math.round(eligibleReports * requestedRate))
    .forEach(({ index }) => interruptedIndexes.add(index));

  const stressedReports = reports.map((report, index) => interruptedIndexes.has(index)
    ? {
        ...report,
        reporting_status: "interrupted",
        status: "dropped",
        drop_reason: "controlled-reporting-path-interruption",
      }
    : { ...report });
  return {
    reports: stressedReports,
    summary: {
      requested_rate: requestedRate,
      eligible_reports: eligibleReports,
      interrupted_reports: interruptedIndexes.size,
      achieved_rate: eligibleReports > 0 ? interruptedIndexes.size / eligibleReports : 0,
      seed,
    },
  };
}
