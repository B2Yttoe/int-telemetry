import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadBundle() {
  const entry = `
    import { constellationProfiles } from "./src/config/constellationProfiles.ts";
    import { generateWalkerNetwork } from "./src/simulation/walker.ts";
    import { verifyRealTleSnapshot } from "./src/simulation/realTleCatalog.ts";
    export { constellationProfiles, generateWalkerNetwork, verifyRealTleSnapshot };
  `;

  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "verify-constellation-profiles.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });

  await mkdir(".tmp", { recursive: true });
  const bundlePath = ".tmp/verify-constellation-profiles.mjs";
  await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
  const mod = await import(`${pathToFileURL(resolve(bundlePath)).href}?t=${Date.now()}`);
  await rm(bundlePath, { force: true });
  return mod;
}

const { constellationProfiles, generateWalkerNetwork, verifyRealTleSnapshot } = await loadBundle();
const results = [];
let failed = false;

for (const profile of constellationProfiles) {
  const snapshotCheck = verifyRealTleSnapshot(profile.snapshot);
  const config = {
    ...profile.config,
    time: {
      ...profile.config.time,
      slices: 2,
    },
  };
  const expectedSatellites = profile.config.constellation.planes * profile.config.constellation.satellitesPerPlane;
  const slices = snapshotCheck.ok
    ? generateWalkerNetwork(config, {
        mode: "operational",
        trafficProfile: "empty",
        tasks: [],
        orbitModel: "real-tle-sgp4",
        routingAlgorithm: profile.config.routing.algorithm,
        tleCatalogSnapshot: profile.snapshot,
      })
    : [];
  const firstSlice = slices[0];
  const ok =
    snapshotCheck.ok &&
    profile.snapshot.selected_count === expectedSatellites &&
    firstSlice?.nodes.length === expectedSatellites &&
    slices.length === 2;

  if (!ok) failed = true;
  results.push({
    id: profile.id,
    label: profile.label,
    ok,
    scale: profile.scale,
    source: `${profile.snapshot.source}/${profile.snapshot.group}`,
    fingerprint: profile.snapshot.fingerprint,
    expected_satellites: expectedSatellites,
    snapshot_satellites: profile.snapshot.selected_count,
    generated_slices: slices.length,
    generated_nodes_per_slice: firstSlice?.nodes.length ?? 0,
    generated_links_per_slice: firstSlice?.links.length ?? 0,
    active_links_first_slice: firstSlice?.links.filter((link) => link.state.isActive).length ?? 0,
    mean_altitude_km: profile.snapshot.mean_altitude_km,
    mean_inclination_deg: profile.snapshot.mean_inclination_deg,
    errors: snapshotCheck.errors,
  });
}

console.log(JSON.stringify({ ok: !failed, profiles: results }, null, 2));
if (failed) process.exit(1);
