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

export function exportToon(ledger: Ledger): string {
  const payload = buildPayload(ledger);
  const t = payload.totals;

  const tables: ToonTable[] = [
    {
      name: "totals",
      fields: [
        "events", "sessions", "models", "sources",
        "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
        "reasoningTokens", "totalTokens", "costUsd",
      ],
      rows: [[
        t.events, t.sessions, t.models, t.sources,
        t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens,
        t.reasoningTokens, t.totalTokens,
        t.costUsd === null ? "unknown" : Math.round(t.costUsd * 100) / 100,
      ]],
    },
    {
      name: "models",
      fields: ["provider", "model", "events", "sessions", "totalTokens", "costUsd", "flags"],
      rows: payload.models.map((m) => {
        const flags: string[] = [];
        if (num(m.any_estimated) > 0) flags.push("estimated");
        if (num(m.any_partial) > 0) flags.push("partial");
        if (num(m.unknown_cost_events) > 0) flags.push("cost_unknown");
        return [
          m.provider ?? "unknown",
          m.model ?? "unknown",
          num(m.events),
          num(m.sessions),
          rowTokens(m),
          m.cost_usd === null ? "unknown" : Math.round(num(m.cost_usd) * 100) / 100,
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
      rows: [[`band x${5} both ways; cost "unknown" is never zero; estimated/partial flags come from the source`]],
    },
  ];

  return [
    `bin: fleet-deck`,
    `description: Local ledger of agent, model, token and cost usage`,
    `generatedAt: "${payload.generatedAt}"`,
    toToon(tables),
  ].join("\n");
}
