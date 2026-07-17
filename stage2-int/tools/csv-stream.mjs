import { createReadStream } from "node:fs";

/**
 * Read CSV rows without materializing the complete file or an intermediate
 * cell matrix. Quoted commas, escaped quotes, and quoted newlines are kept.
 */
export async function readCsvStream(path, { columns = null } = {}) {
  const requested = columns ? new Set(columns) : null;
  const rows = [];
  let headers = null;
  let selectedByIndex = null;
  let row = null;
  let cell = "";
  let columnIndex = 0;
  let quoted = false;
  let pendingQuote = false;
  let skipLineFeed = false;
  let rowHasContent = false;

  const finishCell = () => {
    if (headers === null) {
      row.push(cell);
    } else {
      const header = selectedByIndex.get(columnIndex);
      if (header !== undefined) row[header] = cell;
    }
    cell = "";
    columnIndex += 1;
  };

  const finishRow = () => {
    finishCell();
    if (headers === null) {
      headers = row;
      if (headers[0]?.charCodeAt(0) === 0xfeff) headers[0] = headers[0].slice(1);
      selectedByIndex = new Map();
      headers.forEach((header, index) => {
        if (!requested || requested.has(header)) selectedByIndex.set(index, header);
      });
    } else if (rowHasContent) {
      rows.push(row);
    }
    row = headers === null ? [] : {};
    columnIndex = 0;
    rowHasContent = false;
  };

  row = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      let char = chunk[index];

      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          cell += '"';
          rowHasContent = true;
          continue;
        }
        quoted = false;
      }

      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === "\n") continue;
      }

      if (char === '"') {
        if (!quoted) {
          quoted = true;
        } else if (index + 1 < chunk.length) {
          if (chunk[index + 1] === '"') {
            cell += '"';
            rowHasContent = true;
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          pendingQuote = true;
        }
        continue;
      }

      if (!quoted && char === ",") {
        finishCell();
        continue;
      }

      if (!quoted && (char === "\n" || char === "\r")) {
        if (char === "\r") skipLineFeed = true;
        finishRow();
        continue;
      }

      cell += char;
      rowHasContent = true;
    }
  }

  if (pendingQuote) quoted = false;
  if (cell.length > 0 || columnIndex > 0 || rowHasContent) finishRow();
  return rows;
}
