import { open } from "node:fs/promises";

export async function writeProcessVisualizationJson(path, process) {
  const { slices = [], ...header } = process;
  const headerJson = JSON.stringify(header, null, 2);
  const headerWithoutClosingBrace = headerJson.slice(0, headerJson.lastIndexOf("}")).trimEnd();
  const handle = await open(path, "w");

  try {
    await handle.writeFile(headerWithoutClosingBrace);
    await handle.writeFile(`${Object.keys(header).length > 0 ? "," : ""}\n  \"slices\": [\n`);
    for (let index = 0; index < slices.length; index += 1) {
      if (index > 0) await handle.writeFile(",\n");
      await handle.writeFile(`    ${JSON.stringify(slices[index])}`);
    }
    await handle.writeFile("\n  ]\n}\n");
  } finally {
    await handle.close();
  }
}
