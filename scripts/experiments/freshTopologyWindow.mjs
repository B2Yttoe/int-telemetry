import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadGenerator() {
  const directory = await mkdtemp(join(tmpdir(), "int-temerity-topology-"));
  const bundlePath = join(directory, "fresh-topology-generator.mjs");
  try {
    const source = `
      import { walkerNetworkConfig } from ${JSON.stringify(resolve("src/config/walkerNetworkConfig.ts"))};
      import { generateWalkerNetwork } from ${JSON.stringify(resolve("src/simulation/walker.ts"))};

      export function generateCompactFreshTopology(snapshot, options) {
        const config = structuredClone(walkerNetworkConfig);
        config.time.epochIso = options.epochIso;
        config.time.slices = options.slices;
        config.time.stepMinutes = options.stepMinutes;
        config.constellation.planes = snapshot.layout.planes;
        config.constellation.satellitesPerPlane = snapshot.layout.satellites_per_plane;
        config.constellation.shellId = snapshot.shell_id || "fresh-public-gp-shell";
        config.constellation.altitudeKm = snapshot.mean_altitude_km;
        config.constellation.inclinationDeg = snapshot.mean_inclination_deg;
        config.orbit.model = "real-tle-sgp4";
        const slices = generateWalkerNetwork(config, {
          mode: options.mode,
          tasks: [],
          trafficProfile: options.trafficProfile,
          orbitModel: "real-tle-sgp4",
          routingAlgorithm: options.routingAlgorithm,
          tleCatalogSnapshot: snapshot,
        });
        return {
          schema: "int-temerity-fresh-topology-window/v1",
          generated_at: new Date().toISOString(),
          source_catalog_fingerprint: snapshot.fingerprint,
          epoch_iso: config.time.epochIso,
          slices: config.time.slices,
          step_minutes: config.time.stepMinutes,
          nodes: slices.flatMap((slice) => slice.nodes.map((node) => ({
            slice_index: slice.index,
            time: slice.time,
            node_id: node.id,
            latitude_deg: node.timeState.latitudeDeg,
            longitude_deg: node.timeState.longitudeDeg,
            altitude_km: node.timeState.altitudeKm,
          }))),
          links: slices.flatMap((slice) => slice.links.map((link) => ({
            slice_index: slice.index,
            time: slice.time,
            link_id: link.id,
            source: link.source,
            target: link.target,
            status: link.state.status,
            is_active: link.state.isActive,
            latency_ms: link.state.latencyMs,
            queue_latency_ms: 0,
            effective_capacity_mbps: link.state.linkBudget?.effective_capacity_mbps ?? link.state.bandwidthMbps,
            capacity_mbps: link.state.linkBudget?.capacity_mbps ?? link.state.bandwidthMbps,
            utilization_percent: link.state.utilizationPercent,
            packet_error_rate: link.state.linkBudget?.packet_error_rate ?? 0,
          }))),
        };
      }
    `;
    const result = await build({
      stdin: {
        contents: source,
        resolveDir: process.cwd(),
        sourcefile: "experiment14b-fresh-topology.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
    return {
      module: await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function generateFreshTopologyWindow(snapshot, options) {
  const loaded = await loadGenerator();
  try {
    return loaded.module.generateCompactFreshTopology(snapshot, options);
  } finally {
    await loaded.cleanup();
  }
}
