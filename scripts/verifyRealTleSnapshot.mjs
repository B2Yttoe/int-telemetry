import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const args = process.argv.slice(2);
const fixturePath = resolve(argValue(args, "--fixture", "examples/tle/celestrak-mini-starlink.json"));
const snapshotPath = argValue(args, "--snapshot", "");

const entry = `
  import {
    buildRealTleSnapshotFromCelestrakJson,
    verifyRealTleSnapshot,
  } from "./src/simulation/realTleCatalog.ts";

  export { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot };
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "verify-real-tle-snapshot.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await writeFile(".tmp-verify-real-tle-snapshot.mjs", result.outputFiles[0].text, "utf8");
const moduleUrl = `${pathToFileURL(resolve(".tmp-verify-real-tle-snapshot.mjs")).href}?t=${Date.now()}`;
const { buildRealTleSnapshotFromCelestrakJson, verifyRealTleSnapshot } = await import(moduleUrl);
await rm(".tmp-verify-real-tle-snapshot.mjs", { force: true });

const snapshot = snapshotPath
  ? JSON.parse(await readFile(resolve(snapshotPath), "utf8"))
  : buildRealTleSnapshotFromCelestrakJson(JSON.parse(await readFile(fixturePath, "utf8")), {
      source: "celestrak",
      group: "STARLINK",
      sourceUrl: "fixture://celestrak-mini-starlink",
      downloadedAt: "2026-06-26T00:00:00.000Z",
      planes: 2,
      satellitesPerPlane: 2,
    });
const verification = verifyRealTleSnapshot(snapshot);

assert(verification.ok, `snapshot verification failed: ${verification.errors.join("; ")}`);
if (!snapshotPath) {
  assert(snapshot.catalog_count === 6, "full catalog count should be preserved");
  assert(snapshot.selected_count === 4, "selected simulation subset should contain 4 satellites");
  assert(snapshot.layout.planes === 2, "snapshot should expose 2 inferred planes");
  assert(snapshot.layout.satellites_per_plane === 2, "snapshot should expose 2 slots per plane");
}
assert(snapshot.satellites[0].satellite_id === "P01-S01", "internal satellite ids should follow project node ids");
assert(snapshot.satellites.every((record) => record.raw_omm), "records should preserve original OMM JSON");
assert(snapshot.satellites.every((record) => record.norad_id > 0), "NORAD IDs should be preserved");
assert(snapshot.mean_altitude_km > 300 && snapshot.mean_altitude_km < 1400, "mean altitude should be LEO-like");
assert(snapshot.fingerprint.length >= 8, "snapshot should have a reproducible fingerprint");

console.log(
  JSON.stringify(
    {
      ok: true,
      fixture: snapshotPath ? undefined : fixturePath,
      snapshot: snapshotPath ? resolve(snapshotPath) : undefined,
      selected_count: snapshot.selected_count,
      catalog_count: snapshot.catalog_count,
      layout: snapshot.layout,
      mean_altitude_km: snapshot.mean_altitude_km,
      fingerprint: snapshot.fingerprint,
    },
    null,
    2,
  ),
);
