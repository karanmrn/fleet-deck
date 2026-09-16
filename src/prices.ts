// Versioned price table + cost engine.
// Cost preference: reported cost from the source log, then OpenRouter API
// rows, then this price table. Unknown models stay unknown - never zero.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { UsageEvent } from "./types.js";

export interface PriceEntry {
  provider: string;
  model: string;
  match?: "exact" | "prefix";
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  source_url: string;
  captured_at: string;
}

export interface PriceTable {
  version: string;
  captured_at: string;
  entries: PriceEntry[];
}

export function defaultPriceTablePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/prices.js at runtime, src/prices.ts under tsx - table sits at package root
  return join(here, "..", "prices.json");
}

export function loadPriceTable(path: string = defaultPriceTablePath()): PriceTable {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PriceTable;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error("prices.json is missing an entries array");
  }
  return parsed;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** Best match: exact provider+model, then provider-agnostic ("*") exact,
 *  then longest prefix match. */
export function findPrice(
  table: PriceTable,
  provider: string | null,
  model: string | null,
): PriceEntry | null {
  const p = norm(provider);
  const m = norm(model);
  if (!m) return null;
  let best: PriceEntry | null = null;
  let bestScore = -1;
  for (const e of table.entries) {
    const ep = norm(e.provider);
    const em = norm(e.model);
    if (!em) continue;
    const isPrefix = e.match === "prefix";
    const modelHit = isPrefix ? m.startsWith(em) : m === em;
    if (!modelHit) continue;
    let score: number;
    if (ep === "*") score = 1;
    else if (p && ep === p) score = 2;
    else continue;
    if (isPrefix) score -= 0.5;
    if (score > bestScore || (score === bestScore && best !== null && em.length > norm(best.model).length)) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

/** Price-table cost in USD. Cache reads default to the input rate, cache
 *  writes and reasoning tokens to the output rate when unpriced. */
export function priceCost(event: UsageEvent, entry: PriceEntry): number {
  const inRate = entry.input_per_mtok ?? 0;
  const outRate = entry.output_per_mtok ?? 0;
  const crRate = entry.cache_read_per_mtok ?? inRate;
  const cwRate = entry.cache_write_per_mtok ?? outRate;
  const usd =
    ((event.inputTokens ?? 0) * inRate +
      (event.outputTokens ?? 0) * outRate +
      (event.cacheReadTokens ?? 0) * crRate +
      (event.cacheWriteTokens ?? 0) * cwRate +
      (event.reasoningTokens ?? 0) * outRate) /
    1e6;
  return Math.round(usd * 1e8) / 1e8;
}

/** Fill cost from the price table when the source did not report one.
 *  Logged cost always wins; unknown models stay unknown - never zero. */
export function applyCost(event: UsageEvent, table: PriceTable): UsageEvent {
  if (event.costUsd !== null) return event;
  const entry = findPrice(table, event.provider, event.model);
  if (!entry) {
    event.costSource = "unknown";
    event.costUsd = null;
    return event;
  }
  event.costUsd = priceCost(event, entry);
  event.costSource = "price_list";
  return event;
}
