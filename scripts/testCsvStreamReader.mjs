import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const directory = await mkdtemp(join(tmpdir(), "int-telemetry-csv-stream-"));
const path = join(directory, "fixture.csv");

try {
  await writeFile(path, '\ufeffid,label,note,unused\r\n1,"alpha,beta","line 1\nline 2",x\r\n2,"quoted ""value""",plain,y\r\n', "utf8");
  const rows = await readCsvStream(path, { columns: ["id", "label", "note"] });
  assert.deepEqual(rows, [
    { id: "1", label: "alpha,beta", note: "line 1\nline 2" },
    { id: "2", label: 'quoted "value"', note: "plain" },
  ]);
  console.log("CSV stream reader tests passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
