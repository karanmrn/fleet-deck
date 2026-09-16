import { describe, expect, it } from "vitest";
import { applyCost, findPrice, loadPriceTable, priceCost } from "../src/prices.js";
import type { UsageEvent } from "../src/types.js";

const table = loadPriceTable("prices.json");

function ev(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: "2026-09-15T00:00:00.000Z", source: "test", provider: "anthropic",
    model: "claude-fable-5-1", sessionId: "s", project: "p",
    inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null,
    costUsd: null, costSource: "unknown", estimated: false, partial: false,
    rawRef: "x:0", fileOffset: null, ...partial,
  };
}

describe("prices", () => {
  it("loads a versioned table with provenance", () => {
    expect(table.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const e of table.entries) {
      expect(e.source_url).toMatch(/^https?:\/\//);
      expect(e.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("matches exact and dated prefix variants", () => {
    expect(findPrice(table, "anthropic", "claude-sonnet-4.8")?.input_per_mtok).toBe(3.0);
    expect(findPrice(table, "anthropic", "claude-sonnet-4.8-20260101")?.output_per_mtok).toBe(15.0);
  });

  it("never crosses providers and never invents a match", () => {
    expect(findPrice(table, "openai", "claude-fable-5-1")).toBeNull();
    expect(findPrice(table, "anthropic", "no-such-model")).toBeNull();
    expect(findPrice(table, "anthropic", null)).toBeNull();
  });

  it("computes cost with cache defaults", () => {
    const entry = findPrice(table, "anthropic", "claude-fable-5-1")!;
    const cost = priceCost(ev({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }), entry);
    expect(cost).toBeCloseTo(15 + 75 + 1.5, 6);
  });

  it("logged cost always wins", () => {
    const e = applyCost(ev({ costUsd: 1.23, costSource: "reported" }), table);
    expect(e.costUsd).toBe(1.23);
    expect(e.costSource).toBe("reported");
  });

  it("prices a known model, marks price_list", () => {
    const e = applyCost(ev({ inputTokens: 1e6, outputTokens: 1e6 }), table);
    expect(e.costUsd).toBeCloseTo(90, 6);
    expect(e.costSource).toBe("price_list");
  });

  it("unknown model stays unknown - never zero", () => {
    const e = applyCost(ev({ provider: "mystery", model: "no-such-model" }), table);
    expect(e.costUsd).toBeNull();
    expect(e.costSource).toBe("unknown");
  });
});
