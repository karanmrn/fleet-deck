// Export layer: turns the ledger into agent-readable payloads.
// --json for machines, --toon in the quota-axi house shape for everything else.

import type { Ledger } from "./ledger.js";
import { toToon, type ToonTable } from "./toon.js";
import { classifyModel, estimateEnergyKwh, ENERGY_METHOD, type ModelClass } from "./energy.js";

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function rowTokens(r: Row): number {
  return (
    num(r.input_tokens) +
    num(r.output_tokens) +
    num(r.cache_read_tokens) +
    num(r.cache_write_tokens) +
    num(r.reasoning_tokens)
  );
}

export interface EnergySummary {
  kwh: number;
  low: number;
  high: number;
  tokens: number;
  method: string;
}

export function computeEnergy(models: Row[]): EnergySummary {
  const byClass: Record<ModelClass, number> = { small: 0, mid: 0, frontier: 0 };
  let tokens = 0;
  for (const m of models) {
    const t = rowTokens(m);
    if (t <= 0) continue;
    tokens += t;
    byClass[classifyModel(typeof m.model === "string" ? m.model : null)] += t;
  }
  let kwh = 0;
  let low = 0;
  let high = 0;
  for (const cls of Object.keys(byClass) as ModelClass[]) {
    const est = estimateEnergyKwh(byClass[cls], cls);
    kwh += est.kwh;
    low += est.low;
    high += est.high;
  }
  return {
    kwh: Math.round(kwh * 1000) / 1000,
    low: Math.round(low * 1000) / 1000,
    high: Math.round(high * 1000) / 1000,
    tokens,
    method: ENERGY_METHOD,
  };
}

export function buildPayload(ledger: Ledger) {
  const totals = ledger.totals();
  const models = ledger.byModel();
  const days = ledger.byDay(30);
  const dayModel = ledger.byDayModel(30);
  const sources = ledger.bySource();
  const energy = computeEnergy(models);
  return {
    generatedAt: new Date().toISOString(),
    totals,
    models,
    days,
    dayModel,
    sources,
    energy,
  };
}

export function exportJson(ledger: Ledger): string {
  return JSON.stringify(buildPayload(ledger), null, 2);
}

function money2(v: unknown): number | string {
  return v === null || v === undefined ? "unknown" : Math.round(num(v) * 100) / 100;
}

function listEquiv(v: unknown): number | string {
  // null means "no subscription-billed usage" here, which is not unknown -
  // show a dash instead of "unknown".
  return v === null || v === undefined ? "-" : Math.round(num(v) * 100) / 100;
}

export function exportToon(ledger: Ledger): string {
  const payload = buildPayload(ledger);
  const t = payload.totals;

  const tables: ToonTable[] = [
    {
      name: "totals",
      fields: [
        "events", "sessions", "models", "sources",
        "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
        "reasoningTokens", "totalTokens", "costUsd", "listPriceEquivalentUsd",
      ],
      rows: [[
        t.events, t.sessions, t.models, t.sources,
        t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens,
        t.reasoningTokens, t.totalTokens,
        t.costUsd === null ? "unknown" : Math.round(t.costUsd * 100) / 100,
        t.listPriceEquivalentUsd === null ? "-" : Math.round(t.listPriceEquivalentUsd * 100) / 100,
      ]],
    },
    {
      name: "models",
      fields: ["provider", "model", "events", "sessions", "totalTokens", "costUsd", "listPriceEquivalentUsd", "flags"],
      rows: payload.models.map((m) => {
        const flags: string[] = [];
        if (num(m.any_estimated) > 0) flags.push("estimated");
        if (num(m.any_partial) > 0) flags.push("partial");
        if (num(m.unknown_cost_events) > 0) flags.push("cost_unknown");
        if (m.cost_usd === null && m.list_price_equivalent_usd !== null && m.list_price_equivalent_usd !== undefined) {
          flags.push("list_price");
        }
        // a model sold only inside a subscription has no price, which is not unknown
        const subscriptionOnly = m.cost_usd === null && (m.list_price_equivalent_usd ?? null) === null &&
          num(m.unknown_cost_events) === 0 && num(m.subscription_only_events) > 0;
        if (subscriptionOnly) flags.push("subscription_only");
        return [
          m.provider ?? "unknown",
          m.model ?? "unknown",
          num(m.events),
          num(m.sessions),
          rowTokens(m),
          subscriptionOnly ? "subscription" : money2(m.cost_usd),
          listEquiv(m.list_price_equivalent_usd),
          flags.join("+") || "-",
        ];
      }),
    },
    {
      name: "days",
      fields: ["day", "events", "sessions", "totalTokens", "costUsd"],
      rows: payload.days.map((d) => [
        d.day ?? "",
        num(d.events),
        num(d.sessions),
        rowTokens(d),
        d.cost_usd === null ? "unknown" : Math.round(num(d.cost_usd) * 100) / 100,
      ]),
    },
    {
      name: "sources",
      fields: ["source", "events", "sessions", "totalTokens", "costUsd"],
      rows: payload.sources.map((s) => [
        s.source ?? "",
        num(s.events),
        num(s.sessions),
        rowTokens(s),
        s.cost_usd === null ? "unknown" : Math.round(num(s.cost_usd) * 100) / 100,
      ]),
    },
    {
      name: "energy",
      fields: ["kwh", "low", "high", "tokens"],
      rows: [[payload.energy.kwh, payload.energy.low, payload.energy.high, payload.energy.tokens]],
    },
    {
      name: "note",
      fields: [],
      rows: [[`band x${5} both ways; cost "unknown" is never zero; estimated/partial flags come from the source; listPriceEquivalentUsd is the list-price equivalent for subscription-billed providers, not money spent`]],
    },
  ];

  return [
    `bin: fleet-deck`,
    `description: Local ledger of agent, model, token and cost usage`,
    `generatedAt: "${payload.generatedAt}"`,
    toToon(tables),
  ].join("\n");
}
