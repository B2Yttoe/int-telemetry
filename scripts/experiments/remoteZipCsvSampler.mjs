import { createHash } from "node:crypto";
import { createInflateRaw } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

function parseCsvRecord(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

class MaximumScoreHeap {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
  }

  push(item) {
    if (this.limit <= 0) return;
    if (this.items.length < this.limit) {
      this.items.push(item);
      this.#bubbleUp(this.items.length - 1);
      return;
    }
    if (item.score >= this.items[0].score) return;
    this.items[0] = item;
    this.#sinkDown(0);
  }

  #bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].score >= this.items[index].score) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  #sinkDown(startIndex) {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.items.length && this.items[left].score > this.items[largest].score) largest = left;
      if (right < this.items.length && this.items[right].score > this.items[largest].score) largest = right;
      if (largest === index) break;
      [this.items[index], this.items[largest]] = [this.items[largest], this.items[index]];
      index = largest;
    }
  }

  values() {
    return this.items.sort((left, right) => left.score.localeCompare(right.score)).map((item) => item.row);
  }
}

function rowObject(headers, values, selectedFields) {
  const selected = selectedFields ? new Set(selectedFields) : null;
  const row = {};
  headers.forEach((header, index) => {
    if (!selected || selected.has(header)) row[header] = values[index] ?? "";
  });
  return row;
}

async function zipMemberDataResponse(url, member) {
  const headerResponse = await fetch(url, {
    headers: { Range: `bytes=${member.local_header_offset}-${member.local_header_offset + 2047}` },
  });
  if (headerResponse.status !== 206) throw new Error(`ZIP local-header request returned HTTP ${headerResponse.status}`);
  const header = Buffer.from(await headerResponse.arrayBuffer());
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${member.name}`);
  const compressionMethod = header.readUInt16LE(8);
  const filenameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const filename = header.subarray(30, 30 + filenameLength).toString("utf8");
  if (filename !== member.name) throw new Error(`ZIP member mismatch: expected ${member.name}, found ${filename}`);
  if (compressionMethod !== member.compression_method) {
    throw new Error(`ZIP compression mismatch: expected ${member.compression_method}, found ${compressionMethod}`);
  }
  const dataStart = member.local_header_offset + 30 + filenameLength + extraLength;
  const dataEnd = dataStart + member.compressed_size - 1;
  const response = await fetch(url, { headers: { Range: `bytes=${dataStart}-${dataEnd}` } });
  if (response.status !== 206 || !response.body) throw new Error(`ZIP member request returned HTTP ${response.status}`);
  return { response, filename, compressionMethod, dataStart, dataEnd };
}

export async function sampleRemoteZipCsv({
  url,
  member,
  maximumRows,
  seed,
  keyField = "uuid",
  selectedFields,
  filter = () => true,
}) {
  const fetched = await zipMemberDataResponse(url, member);
  const compressedHash = createHash("sha256");
  const contentHash = createHash("sha256");
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  const source = Readable.fromWeb(fetched.response.body);
  source.on("data", (chunk) => {
    compressedHash.update(chunk);
    compressedBytes += chunk.length;
  });
  const decoded = fetched.compressionMethod === 8 ? source.pipe(createInflateRaw()) : source;
  decoded.on("data", (chunk) => {
    contentHash.update(chunk);
    uncompressedBytes += chunk.length;
  });
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  const heap = new MaximumScoreHeap(maximumRows);
  let headers = null;
  let scannedRows = 0;
  let matchingRows = 0;
  for await (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!headers) {
      headers = parseCsvRecord(line).map((field) => field.replace(/^\uFEFF/, ""));
      continue;
    }
    if (!line) continue;
    scannedRows += 1;
    const row = rowObject(headers, parseCsvRecord(line), selectedFields);
    if (!filter(row)) continue;
    matchingRows += 1;
    const key = row[keyField] || `${scannedRows}`;
    const score = createHash("sha256").update(`${seed}:${key}`).digest("hex");
    heap.push({ score, row });
  }
  if (compressedBytes !== member.compressed_size) {
    throw new Error(`ZIP member byte count mismatch: expected ${member.compressed_size}, received ${compressedBytes}`);
  }
  return {
    rows: heap.values(),
    metadata: {
      member_name: fetched.filename,
      local_header_offset: member.local_header_offset,
      compressed_bytes: compressedBytes,
      uncompressed_bytes: uncompressedBytes,
      compressed_sha256: compressedHash.digest("hex"),
      content_sha256: contentHash.digest("hex"),
      scanned_rows: scannedRows,
      matching_rows: matchingRows,
      retained_rows: Math.min(maximumRows, matchingRows),
      deterministic_sample_seed: seed,
      selected_fields: selectedFields ?? headers,
    },
  };
}

export { parseCsvRecord };
