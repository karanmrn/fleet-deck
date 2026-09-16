// Small shared helpers: timestamp normalization, numeric coercion,
// and directory walking.

import * as fs from "node:fs";
import * as path from "node:path";

import { shouldSkipFile } from "./redact.js";

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
