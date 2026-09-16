// Versioned price table + cost engine.
// Cost preference: reported cost from the source log, then OpenRouter API
// rows, then this price table. Unknown models stay unknown - never zero.
//
// Billing modes: every provider is "usage" (list prices are pay-per-token
// spend) unless the source log proves a subscription (UsageEvent.billing)
// or ~/.fleet-deck/config.json overrides the provider; the override wins.
// Subscription price-table costs become listPriceEquivalentUsd (what the
// tokens would cost at list price), never costUsd, so the two never mix.
// A subscription_only entry marks a model the vendor sells only inside a
// subscription with no token price: its rows get cost_source "subscription"
// with no cost and no list-price equivalent, and are not "unknown".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BillingMode, UsageEvent } from "./types.js";

export interface PriceEntry {
  provider: string;
  model: string;
  match?: "exact" | "prefix";
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  /** true when the vendor sells the model only inside a subscription and
   *  publishes no token price. All four rates must then be null. */
  subscription_only?: boolean;
  /** Why the entry has no price. Required with subscription_only. */
  note?: string;
  source_url: string;
  captured_at: string;
}

export interface PriceTable {
  version: string;
  captured_at: string;
  entries: PriceEntry[];
}

export interface BillingConfig {
  billing?: Record<string, string>;
}

export function defaultPriceTablePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/prices.js at runtime, src/prices.ts under tsx - table sits at package root
  return join(here, "..", "prices.json");
}

export function defaultBillingConfigPath(home: string): string {
  return join(home, ".fleet-deck", "config.json");
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function billingMode(value: string, where: string): BillingMode {
  const v = norm(value);
  if (v !== "usage" && v !== "subscription") {
    throw new Error(`${where}: billing mode must be "usage" or "subscription" (got ${JSON.stringify(value)})`);
  }
  return v;
}

export function loadPriceTable(path: string = defaultPriceTablePath()): PriceTable {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PriceTable;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error("prices.json is missing an entries array");
  }
  for (const e of parsed.entries) {
    if (!e.subscription_only) continue;
    const rates = [e.input_per_mtok, e.output_per_mtok, e.cache_read_per_mtok, e.cache_write_per_mtok];
    if (rates.some((r) => r !== null) || !e.note) {
      throw new Error(`prices.json ${e.provider}/${e.model}: a subscription_only entry needs null rates and a note`);
    }
  }
  return parsed;
}

/** Machine-level overrides from ~/.fleet-deck/config.json. A missing file
 *  means "no overrides". An invalid file fails loudly. */
export function loadBillingConfig(path: string): BillingConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: BillingConfig;
  try {
    parsed = JSON.parse(raw) as BillingConfig;
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${String(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const billing = parsed.billing;
  if (billing === undefined) return parsed;
  if (billing === null || typeof billing !== "object" || Array.isArray(billing)) {
    throw new Error(`${path}: "billing" must be an object of provider -> "usage" | "subscription"`);
  }
  for (const [p, m] of Object.entries(billing)) {
    billingMode(m, `${path} billing["${p}"]`);
  }
  return parsed;
}

/** Machine config overrides keyed by normalised provider id. */
export function resolveBilling(config: BillingConfig): Record<string, BillingMode> {
  const out: Record<string, BillingMode> = {};
  for (const [p, m] of Object.entries(config.billing ?? {})) {
    out[norm(p)] = billingMode(m, `config billing["${p}"]`);
  }
  return out;
}

/** Effective billing mode for one provider: machine override, then the
 *  evidence the log carries, then "usage". */
export function billingFor(
  overrides: Record<string, BillingMode>,
  provider: string | null,
  evidence: BillingMode | null,
): BillingMode {
  return overrides[norm(provider)] ?? evidence ?? "usage";
}

/** Best match: exact provider+model, then provider-agnostic ("*") exact,
 *  then longest prefix match. A log without a provider matches by model id
 *  alone, but only when a single provider prices that id. */
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
  const providers = new Set<string>();
  for (const e of table.entries) {
    const ep = norm(e.provider);
    const em = norm(e.model);
    if (!em) continue;
    const isPrefix = e.match === "prefix";
    const modelHit = isPrefix ? m.startsWith(em) : m === em;
    if (!modelHit) continue;
    let score: number;
    if (ep === "*") score = 1;
    else if (!p || ep === p) score = 2;
    else continue;
    if (ep !== "*") providers.add(ep);
    if (isPrefix) score -= 0.5;
    if (score > bestScore || (score === bestScore && best !== null && em.length > norm(best.model).length)) {
      best = e;
      bestScore = score;
    }
  }
  if (!p && providers.size > 1) return null;
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

/** Per-Mtok rates with the same defaults priceCost applies. Used by the
 *  ledger to re-price existing rows in SQL. */
export function ratesFor(entry: PriceEntry): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: entry.input_per_mtok ?? 0,
    output: entry.output_per_mtok ?? 0,
    cacheRead: entry.cache_read_per_mtok ?? entry.input_per_mtok ?? 0,
    cacheWrite: entry.cache_write_per_mtok ?? entry.output_per_mtok ?? 0,
  };
}

/** Fill cost from the price table when the source did not report one.
 *  Logged cost always wins; unknown models stay unknown - never zero.
 *  For subscription-billed providers the price-table cost lands in
 *  listPriceEquivalentUsd and costUsd stays null. A subscription_only
 *  entry leaves both null with costSource "subscription". */
export function applyCost(
  event: UsageEvent,
  table: PriceTable,
  billing: Record<string, BillingMode> = {},
): UsageEvent {
  if (event.costUsd !== null) return event;
  const entry = findPrice(table, event.provider, event.model);
  if (!entry) {
    event.costSource = "unknown";
    event.costUsd = null;
    event.listPriceEquivalentUsd = null;
    return event;
  }
  if (entry.subscription_only) {
    event.costSource = "subscription";
    event.costUsd = null;
    event.listPriceEquivalentUsd = null;
    return event;
  }
  const cost = priceCost(event, entry);
  const mode = billingFor(billing, event.provider, event.billing);
  event.costSource = "price_list";
  if (mode === "subscription") {
    event.listPriceEquivalentUsd = cost;
    event.costUsd = null;
  } else {
    event.costUsd = cost;
    event.listPriceEquivalentUsd = null;
  }
  return event;
}
