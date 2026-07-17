function finite(value) {
  return Number.isFinite(Number(value));
}

export function validatePublicFixedAnchorMetadata({ protocol, measurement, anchor, probe }) {
  const checks = {
    measurement_id: Number(measurement.id) === Number(protocol.measurement.id),
    measurement_type: measurement.type === protocol.measurement.type,
    measurement_af: Number(measurement.af) === Number(protocol.measurement.address_family),
    measurement_interval: Number(measurement.interval) === Number(protocol.measurement.interval_seconds),
    measurement_ongoing: measurement.status?.name === "Ongoing" && measurement.stop_time == null,
    target_fqdn: measurement.target === protocol.measurement.target_fqdn,
    target_ipv4: measurement.target_ip === protocol.measurement.target_ipv4 &&
      Array.isArray(measurement.resolved_ips) && measurement.resolved_ips.includes(protocol.measurement.target_ipv4),
    anchor_id: Number(anchor.id) === Number(protocol.anchor.id),
    anchor_active: anchor.is_disabled === false && anchor.date_decommissioned == null,
    anchor_fqdn: anchor.fqdn === protocol.measurement.target_fqdn,
    anchor_ipv4: anchor.ip_v4 === protocol.measurement.target_ipv4,
    anchor_coordinates: finite(anchor.geometry?.coordinates?.[0]) && finite(anchor.geometry?.coordinates?.[1]),
    probe_id: Number(probe.id) === Number(protocol.source_probe.id),
    probe_asn: Number(probe.asn_v4) === Number(protocol.source_probe.asn),
    probe_public: !protocol.source_probe.require_public || probe.is_public === true,
    probe_connected: !protocol.source_probe.require_connected_at_collection || probe.status?.id === 1,
    probe_coordinates: finite(probe.geometry?.coordinates?.[0]) && finite(probe.geometry?.coordinates?.[1]),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export function normalizePublicFixedAnchorResults(results, { protocol, anchor, probe, startTime, endTime }) {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  return results
    .filter((result) => Number(result.msm_id) === Number(protocol.measurement.id))
    .filter((result) => Number(result.prb_id) === Number(protocol.source_probe.id))
    .filter((result) => result.type === protocol.measurement.type && Number(result.af) === protocol.measurement.address_family)
    .map((result) => {
      const timestamp = Number(result.timestamp) * 1000;
      return { result, timestamp };
    })
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp >= start && timestamp <= end)
    .filter(({ result }) => finite(result.min))
    .map(({ result, timestamp }) => ({
      uuid: `ripe-public-fixed-${result.msm_id}-${result.prb_id}-${result.timestamp}`,
      test_time: new Date(timestamp).toISOString(),
      timestamp: result.timestamp,
      measurement_id: result.msm_id,
      probe_id: result.prb_id,
      client_asn: probe.asn_v4,
      client_country_code: probe.country_code ?? "",
      lat: probe.geometry.coordinates[1],
      lon: probe.geometry.coordinates[0],
      probe_latitude_deg: probe.geometry.coordinates[1],
      probe_longitude_deg: probe.geometry.coordinates[0],
      server_id: `ripe-anchor-${anchor.id}`,
      anchor_id: anchor.id,
      server_city: anchor.city,
      server_country_code: anchor.country,
      server_latitude_deg: anchor.geometry.coordinates[1],
      server_longitude_deg: anchor.geometry.coordinates[0],
      server_target_ipv4: anchor.ip_v4,
      download_latency_ms: Number(result.min),
      external_rtt_ms: Number(result.min),
      sent_packets: result.sent ?? "",
      received_packets: result.rcvd ?? "",
      target_semantics: "fixed-ripe-atlas-anchor",
      source_provenance: "preregistered-public-ongoing-fixed-anchor-measurement",
    }));
}
