import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import {
  calibrateBusinessRates,
  comparePacketResults,
  normalizeMetadataBytes,
  repairPathAgainstLinks,
  runPacketReference,
  splitPath,
  validatePathAgainstLinks,
} from "./experiments/systemPacketValidation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "stage3-system-validation", "fixtures", "iridium-66-20slice");

function testPathHelpers() {
  assert.deepEqual(splitPath("A > B|C"), ["A", "B", "C"]);
  assert.deepEqual(normalizeMetadataBytes("96|32", 4, 8), [96, 32, 8, 8]);
  const links = [
    { slice_index: 0, link_id: "AB", source: "A", target: "B", is_active: true },
    { slice_index: 0, link_id: "BC", source: "B", target: "C", is_active: true },
  ];
  const repaired = repairPathAgainstLinks({ sliceIndex: 0, pathNodes: ["A", "C"], linkRows: links });
  assert.equal(repaired.valid, true);
  assert.deepEqual(repaired.path_nodes, ["A", "B", "C"]);
  assert.deepEqual(repaired.original_waypoint_indexes, [0, -1, 1]);
  assert.equal(repaired.repair_count, 1);
  assert.equal(repaired.inserted_transit_hops, 1);
}

function testBusinessCalibration() {
  const calibrated = calibrateBusinessRates({
    flows: [{ slice_index: 0, path_nodes: "A|B", raw_rate_mbps: 10 }],
    links: [{ slice_index: 0, source: "A", target: "B", data_rate_mbps: 10 }],
    targetP90Utilization: 0.6,
  });
  assert.equal(calibrated.raw_p90_utilization, 1);
  assert.equal(calibrated.calibration_scale, 0.6);
  assert.equal(calibrated.calibrated_p90_utilization, 0.6);
  assert.equal(calibrated.flows[0].base_rate_mbps, 6);
}

function tinyFixture() {
  const config = {
    slice_count: 1,
    slice_duration_s: 1,
    business_packet_bytes: 1200,
    probe_base_bytes: 128,
    probe_interval_ms: 50,
    ipv4_udp_overhead_bytes: 28,
    mtu_bytes: 1500,
    queue_packets: 100,
    report_timeout_s: 1,
  };
  return {
    config,
    nodes: [{ node_id: "A" }, { node_id: "B" }],
    links: [{
      slice_index: 0,
      link_id: "AB",
      source: "A",
      target: "B",
      is_active: true,
      data_rate_mbps: 10,
      delay_ms: 2,
      packet_error_rate: 0,
    }],
    businessFlows: [{
      flow_id: "business-0",
      path_nodes: "A|B",
      base_rate_mbps: 0.1,
      packet_size_bytes: 1200,
      start_s: 0.05,
      stop_s: 0.2,
    }],
    probeFlows: [
      {
        variant: "full-int",
        probe_id: "full-0",
        path_nodes: "A|B",
        metadata_bytes_by_hop: "800|800",
        base_packet_bytes: 128,
        interval_ms: 50,
        start_s: 0.1,
        stop_s: 0.2,
      },
      {
        variant: "leo-selective",
        probe_id: "selective-0",
        path_nodes: "A|B",
        metadata_bytes_by_hop: "100|0",
        base_packet_bytes: 128,
        interval_ms: 50,
        start_s: 0.1,
        stop_s: 0.2,
      },
    ],
  };
}

function testReferenceReplay() {
  const fixture = tinyFixture();
  const full = runPacketReference({ fixture, variant: "full-int", seed: 7 });
  const selective = runPacketReference({ fixture, variant: "leo-selective", seed: 7 });
  assert.ok(full.mtu_drop_packets > 0, "full metadata should trigger the MTU gate");
  assert.equal(full.report_delivery_ratio, 0);
  assert.equal(selective.report_delivery_ratio, 1);
  assert.ok(Number.isFinite(full.oam_time_average_aoi_ms));
  assert.ok(Number.isFinite(selective.oam_time_average_aoi_ms));
  assert.ok(full.oam_time_average_aoi_ms > selective.oam_time_average_aoi_ms,
    "successful selective reports should reduce time-average OAM AoI");
  assert.ok(Number.isFinite(selective.telemetry_queue_delay_p95_ms));
  assert.ok(full.planned_telemetry_network_bytes > selective.planned_telemetry_network_bytes);
  const compared = comparePacketResults([full, selective]);
  assert.ok(compared.find((row) => row.variant === "leo-selective")
    .telemetry_byte_reduction_vs_full_percent > 0);
}

async function testFrozenFixture() {
  assert.ok(existsSync(join(FIXTURE, "manifest.json")), "frozen Experiment 13 fixture is missing");
  const [manifest, config, links, business, probes] = await Promise.all([
    readFile(join(FIXTURE, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(FIXTURE, "config.json"), "utf8").then(JSON.parse),
    readCsvStream(join(FIXTURE, "links.csv")),
    readCsvStream(join(FIXTURE, "business-flows.csv")),
    readCsvStream(join(FIXTURE, "probe-flows.csv")),
  ]);
  assert.equal(manifest.fixture.node_count, 66);
  assert.equal(manifest.fixture.slice_count, 20);
  assert.equal(manifest.fixture.rejected_records, 0);
  assert.equal(config.comparison_control.policy,
    "same-probe-paths-same-intervals-different-per-hop-metadata-only");

  for (const row of [...business, ...probes]) {
    const validation = validatePathAgainstLinks({
      sliceIndex: row.slice_index,
      pathNodes: splitPath(row.path_nodes),
      linkRows: links,
    });
    assert.equal(validation.valid, true, `${row.flow_id ?? row.probe_id}: ${validation.failed_hop}`);
  }

  const fullRows = probes.filter((row) => row.variant === "full-int");
  const selectiveRows = probes.filter((row) => row.variant === "leo-selective");
  assert.equal(fullRows.length, selectiveRows.length);
  const selectiveByKey = new Map(selectiveRows.map((row) => [
    `${row.slice_index}|${row.probe_id.replace(/^leo-selective:/, "")}`,
    row,
  ]));
  for (const full of fullRows) {
    const key = `${full.slice_index}|${full.probe_id.replace(/^full-int:/, "")}`;
    const selective = selectiveByKey.get(key);
    assert.ok(selective, `missing selective peer for ${key}`);
    assert.equal(full.path_nodes, selective.path_nodes);
    assert.equal(full.interval_ms, selective.interval_ms);
    assert.ok(splitPath(full.metadata_bytes_by_hop).every((value) => Number(value) === 96));
    assert.equal(splitPath(full.metadata_bytes_by_hop).length, splitPath(full.path_nodes).length);
    assert.equal(splitPath(selective.metadata_bytes_by_hop).length, splitPath(selective.path_nodes).length);
    assert.ok(Number(selective.forward_only_hop_count) >= Number(selective.adapter_inserted_transit_hops));
  }
}

async function testStaticNs3Boundary() {
  const [source, reportSource] = await Promise.all([
    readFile(join(ROOT, "stage3-system-validation", "ns3", "scratch", "leo-int-system-validation.cc"), "utf8"),
    readFile(join(ROOT, "scripts", "experiments", "systemValidationReport.mjs"), "utf8"),
  ]);
  for (const token of [
    "PointToPointHelper",
    "RateErrorModel",
    "plannedTelemetryNetworkBytes",
    "m_mtuBytes",
    "OnDeviceQueueDequeue",
    "ComputeOamAoiMs",
  ]) {
    assert.ok(source.includes(token), `ns-3 source is missing ${token}`);
  }
  assert.equal(source.includes("SetLinkDown"), false, "unsupported point-to-point link API leaked in");
  assert.equal(/[瀹楠绯][^\n]{0,5}[為岃荤]/u.test(reportSource), false, "report source contains mojibake");
}

testPathHelpers();
testBusinessCalibration();
testReferenceReplay();
await testFrozenFixture();
await testStaticNs3Boundary();
console.log("Experiment 13 system validation tests passed.");
