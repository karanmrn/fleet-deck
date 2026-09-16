import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });
import {
  applyCost, findPrice, loadBillingConfig, loadPriceTable, priceCost, resolveBilling,
} from "../src/prices.js";
import type { UsageEvent } from "../src/types.js";

const table = loadPriceTable("prices.json");

function ev(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: "2026-09-15T00:00:00.000Z", source: "test", provider: "anthropic",
    model: "claude-fable-5-1", sessionId: "s", project: "p",
    inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null,
    costUsd: null, costSource: "unknown", listPriceEquivalentUsd: null, billing: null,
    estimated: false, partial: false,
    rawRef: "x:0", fileOffset: null, ...partial,
  };
}

describe("prices", () => {
  it("loads a versioned table with provenance", () => {
    expect(table.version).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    for (const e of table.entries) {
      expect(e.source_url).toMatch(/^https?:\/\//);
      expect(e.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("uses the exact ids the logs carry (dashed Anthropic ids)", () => {
    for (const id of [
      "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5-1",
      "claude-haiku-4-5-20251001", "claude-sonnet-4-8",
    ]) {
      expect(findPrice(table, "anthropic", id)?.model).toBe(id);
    }
    expect(findPrice(table, "openai", "gpt-6-astra")?.model).toBe("gpt-6-astra");
    expect(findPrice(table, "openai", "gpt-5.6-luna")?.model).toBe("gpt-5.6-luna");
    expect(findPrice(table, "openai", "gpt-5.6-terra")?.model).toBe("gpt-5.6-terra");
    expect(findPrice(table, "openai", "gpt-5.6-sol")?.model).toBe("gpt-5.6-sol");
    expect(findPrice(table, "xai", "grok-4.6")?.model).toBe("grok-4.6");
    expect(findPrice(table, "openrouter", "openai/gpt-5.6-luna")?.model).toBe("openai/gpt-5.6-luna");
    expect(findPrice(table, "nebius", "moonshotai/Kimi-K3")?.model).toBe("moonshotai/Kimi-K3");
    expect(findPrice(table, "nebius", "zai-org/GLM-5.3")?.model).toBe("zai-org/GLM-5.3");
    expect(findPrice(table, "nebius", "deepseek-ai/DeepSeek-V4-Flash-0731")?.model)
      .toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });

  it("carries the verified Anthropic list prices", () => {
    expect(findPrice(table, "anthropic", "claude-fable-5-1")).toMatchObject({
      input_per_mtok: 10.0, output_per_mtok: 50.0,
      cache_read_per_mtok: 0.25, cache_write_per_mtok: 12.5,
    });
    expect(findPrice(table, "anthropic", "claude-opus-4-8")).toMatchObject({
      input_per_mtok: 5.0, output_per_mtok: 25.0,
      cache_read_per_mtok: 0.5, cache_write_per_mtok: 6.25,
    });
    expect(findPrice(table, "anthropic", "claude-opus-5")).toMatchObject({
      input_per_mtok: 5.0, output_per_mtok: 25.0,
    });
    expect(findPrice(table, "anthropic", "claude-sonnet-5")).toMatchObject({
      input_per_mtok: 2.0, output_per_mtok: 10.0,
    });
    expect(findPrice(table, "anthropic", "claude-haiku-4-5-20251001")).toMatchObject({
      input_per_mtok: 1.0, output_per_mtok: 5.0,
    });
  });

  it("matches exact and dated prefix variants", () => {
    expect(findPrice(table, "anthropic", "claude-sonnet-4-8")?.input_per_mtok).toBe(3.0);
    expect(findPrice(table, "anthropic", "claude-sonnet-4-8-20260101")?.output_per_mtok).toBe(15.0);
  });

  it("never gives a shorter logged model the price of a longer prefix entry", () => {
    expect(findPrice(table, "xai", "grok-4")).toBeNull();
    expect(findPrice(table, "openai", "gpt-5.1-codex-max")?.model).toBe("gpt-5.1-codex");
  });

  it("cites the pricing page of the provider that bills the row", () => {
    expect(findPrice(table, "openai", "gpt-5.6-luna")?.source_url).toBe("https://platform.openai.com/docs/pricing");
    expect(findPrice(table, "openrouter", "openai/gpt-5.6-luna")?.source_url).toBe("https://openrouter.ai/api/v1/models");
  });

  it("matches a log without a provider by model id alone, only when one provider prices it", () => {
    expect(findPrice(table, null, "grok-4.6")).toMatchObject({ provider: "xai", model: "grok-4.6" });
    const shared = {
      ...table,
      entries: [
        ...table.entries,
        { ...findPrice(table, "xai", "grok-4.6")!, provider: "openrouter" },
      ],
    };
    expect(findPrice(shared, null, "grok-4.6")).toBeNull();
    expect(findPrice(shared, "xai", "grok-4.6")?.provider).toBe("xai");
  });

  it("never crosses providers and never invents a match", () => {
    expect(findPrice(table, "openai", "claude-fable-5-1")).toBeNull();
    expect(findPrice(table, "anthropic", "no-such-model")).toBeNull();
    expect(findPrice(table, "anthropic", null)).toBeNull();
  });

  it("computes cost with cache defaults", () => {
    const entry = findPrice(table, "anthropic", "claude-fable-5-1")!;
    const cost = priceCost(ev({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }), entry);
    expect(cost).toBeCloseTo(10 + 50 + 0.25, 6);
  });

  it("logged cost always wins", () => {
    const e = applyCost(ev({ costUsd: 1.23, costSource: "reported" }), table);
    expect(e.costUsd).toBe(1.23);
    expect(e.costSource).toBe("reported");
    expect(e.listPriceEquivalentUsd).toBeNull();
  });

  it("prices a known model, marks price_list", () => {
    const e = applyCost(ev({ inputTokens: 1e6, outputTokens: 1e6 }), table);
    expect(e.costUsd).toBeCloseTo(60, 6);
    expect(e.costSource).toBe("price_list");
    expect(e.listPriceEquivalentUsd).toBeNull();
  });

  it("unknown model stays unknown - never zero", () => {
    const e = applyCost(ev({ provider: "mystery", model: "no-such-model" }), table);
    expect(e.costUsd).toBeNull();
    expect(e.listPriceEquivalentUsd).toBeNull();
    expect(e.costSource).toBe("unknown");
  });
});

describe("billing", () => {
  it("defaults every provider to usage with no overrides and no log evidence", () => {
    expect(resolveBilling({})).toEqual({});
    const e = applyCost(ev({ inputTokens: 1e6, outputTokens: 1e6 }), table, resolveBilling({}));
    expect(e.costUsd).toBeCloseTo(60, 6);
    expect(e.listPriceEquivalentUsd).toBeNull();
  });

  it("prices usage the log proves is a subscription as list-price equivalent", () => {
    const e = applyCost(
      ev({ provider: "openai", model: "gpt-6-astra", inputTokens: 1e6, outputTokens: 1e6, billing: "subscription" }),
      table,
      resolveBilling({}),
    );
    expect(e.costUsd).toBeNull();
    expect(e.listPriceEquivalentUsd).toBeCloseTo(10 + 50, 6);
  });

  it("lets the machine override win over log evidence", () => {
    const e = applyCost(
      ev({ provider: "openai", model: "gpt-6-astra", inputTokens: 1e6, outputTokens: 1e6, billing: "subscription" }),
      table,
      resolveBilling({ billing: { openai: "usage" } }),
    );
    expect(e.costUsd).toBeCloseTo(10 + 50, 6);
    expect(e.listPriceEquivalentUsd).toBeNull();
  });

  it("prices subscription-billed providers as list-price equivalent", () => {
    const billing = resolveBilling({ billing: { anthropic: "subscription" } });
    const e = applyCost(ev({ inputTokens: 1e6, outputTokens: 1e6 }), table, billing);
    expect(e.costUsd).toBeNull();
    expect(e.costSource).toBe("price_list");
    expect(e.listPriceEquivalentUsd).toBeCloseTo(60, 6);
  });

  it("keeps usage-billed cost out of the equivalent field", () => {
    const billing = resolveBilling({ billing: { anthropic: "subscription" } });
    const e = applyCost(
      ev({ provider: "openai", model: "gpt-6-astra", inputTokens: 1e6, outputTokens: 1e6 }),
      table,
      billing,
    );
    expect(e.costUsd).toBeCloseTo(10 + 50, 6);
    expect(e.listPriceEquivalentUsd).toBeNull();
  });

  it("reads overrides from a config file and fails loudly on garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-billing-"));
    tmpDirs.push(dir);
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ billing: { anthropic: "subscription" } }));
    expect(loadBillingConfig(cfg)).toEqual({ billing: { anthropic: "subscription" } });
    expect(loadBillingConfig(join(dir, "missing.json"))).toEqual({});
    writeFileSync(cfg, JSON.stringify({ billing: { anthropic: "subscripcion" } }));
    expect(() => loadBillingConfig(cfg)).toThrow(/usage.*subscription|subscription.*usage/);
  });
});
