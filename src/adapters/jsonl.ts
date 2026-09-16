// Shared JSONL tail-reader for file-based adapters.
// Reads from a stored byte offset to EOF and parses complete lines only.
// Lines matching the redaction rules are skipped unread; a partial final
// line (no trailing newline) is left unconsumed for the next scan.

import { openSync, readSync, closeSync, statSync } from "node:fs";

import { shouldSkipLine } from "../redact.js";

export interface ParsedLine {
  obj: Record<string, unknown>;
  /** Byte offset of the first byte of this line. */
  start: number;
  /** Byte offset one past the newline ending this line. */
  end: number;
}

export interface JsonlScan {
  lines: ParsedLine[];
  nextOffset: number;
  /** true when the file shrank below the stored offset and was restarted. */
  truncated: boolean;
  skippedSensitive: number;
  unparsed: number;
}

export function readJsonlFromOffset(path: string, offset: number): JsonlScan {
  const size = statSync(path).size;
  let start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  let truncated = false;
  if (start > size) {
    start = 0;
    truncated = true;
  }
  const len = size - start;
  const fd = openSync(path, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const lines: ParsedLine[] = [];
  let skippedSensitive = 0;
  let unparsed = 0;
  let pos = 0;
  while (pos < len) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // incomplete final line: leave for next scan
    const text = buf.toString("utf8", pos, nl).trim();
    const lineStart = start + pos;
    const lineEnd = start + nl + 1;
    pos = nl + 1;
    if (!text) continue;
    if (shouldSkipLine(text)) {
      skippedSensitive += 1;
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      unparsed += 1;
      continue;
    }
    lines.push({ obj, start: lineStart, end: lineEnd });
  }
  return { lines, nextOffset: start + pos, truncated, skippedSensitive, unparsed };
}
