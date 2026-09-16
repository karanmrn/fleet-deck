// Small shared helpers: timestamp normalization, numeric coercion,
// directory walking and offset-based JSONL reading.

import { open, stat } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { shouldSkipFile, shouldSkipLine } from "./redact.js";

// Safety valves for pathological files.
export const MAX_READ_BYTES = 256 * 1024 * 1024; // never read more than 256 MiB per scan pass
export const MAX_LINES = 200000;

/** Normalize a timestamp to ISO 8601 UTC. Accepts ISO strings and epoch
 *  numbers (seconds or milliseconds). Returns null on failure. */
export function toIso(ts: unknown): string | null {
  if (ts === null || ts === undefined) return null;
  try {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      const ms = ts < 1e12 ? ts * 1000 : ts;
      return new Date(ms).toISOString();
    }
    if (typeof ts === "string") {
      const text = ts.trim();
      if (!text) return null;
      // Naive "YYYY-MM-DD HH:MM:SS" (SQLite style) is treated as UTC.
      let normalized = text;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(text)) {
        normalized = text.replace(" ", "T") + "Z";
      }
      const ms = Date.parse(normalized);
      if (Number.isNaN(ms)) return null;
      return new Date(ms).toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

/** Coerce to a finite number, else null. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const v = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(v)) return null;
  return v;
}

/** Coerce to a short string, else null. Only for model/provider/id fields. */
export function txt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s.length > 256) return null;
  return s;
}

/** Yield absolute file paths under base up to maxDepth levels deep,
 *  skipping forbidden files and heavy/irrelevant directories. */
export function* walkFiles(
  base: string,
  maxDepth: number,
  predicate: (p: string) => boolean,
): Generator<string> {
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return;
  const stack: Array<[string, number]> = [[base, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [string, number];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          if (depth < maxDepth && entry.name !== ".git" && entry.name !== "node_modules") {
            stack.push([full, depth + 1]);
          }
        } else if (entry.isFile()) {
          if (shouldSkipFile(full)) continue;
          if (predicate(full)) yield full;
        }
      } catch {
        continue;
      }
    }
  }
}

export interface RawLine {
  text: string;
  /** Byte offset of the first byte of this line. */
  start: number;
  /** Byte offset one past the newline ending this line. */
  end: number;
}

export interface JsonlRead {
  lines: RawLine[];
  /** Byte offset to store for the next incremental scan. */
  nextOffset: number;
  /** true when the file shrank and the scan restarted at 0. */
  rotated: boolean;
  skippedSensitive: number;
}

/** Read newline-terminated lines from `offset` to EOF (capped at
 *  MAX_READ_BYTES). A trailing partial line (no newline yet) is left
 *  unconsumed so the next scan re-reads it once complete. */
export async function readLinesFromOffset(filePath: string, offset: number): Promise<JsonlRead> {
  const st = await stat(filePath);
  const rotated = offset > st.size;
  const start = rotated ? 0 : offset;
  const length = Math.min(st.size - start, MAX_READ_BYTES);
  const fh = await open(filePath, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }
  const lines: RawLine[] = [];
  let pos = 0;
  let skippedSensitive = 0;
  while (lines.length < MAX_LINES) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // trailing partial line stays unconsumed
    let text = buf.toString("utf8", pos, nl);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    const lineStart = start + pos;
    const lineEnd = start + nl + 1;
    pos = nl + 1;
    if (!text.trim()) continue;
    if (shouldSkipLine(text)) {
      skippedSensitive += 1;
      continue;
    }
    lines.push({ text, start: lineStart, end: lineEnd });
  }
  return { lines, nextOffset: start + pos, rotated, skippedSensitive };
}
