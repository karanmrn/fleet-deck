import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/ledger.js";
import { findPrice, loadPriceTable, ratesFor } from "../src/prices.js";
import type { UsageEvent } from "../src/types.js";

const tmpDirs: string[] = [];
const table = loadPriceTable("prices.json");

function freshLedger(): { ledger: Ledger; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleetdeck-test-"));
  tmpDirs.push(dir);
  const path = join(dir, "ledger.db");
  return { ledger: new Ledger(path), path };
}

function makeEvent(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: "2026-09-15T10:00:00.000Z",
    source: "claude_code", provider: "anthropic", model: "claude-fable-5-1",
    sessionId: "sess-1", project: "fleet-deck",
    inputTokens: 10, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0,
    reasoningTokens: null, costUsd: 0.01, costSource: "price_list",
    listPriceEquivalentUsd: null,
    billing: null,
    estimated: false, partial: false, rawRef: "uuid-1", fileOffset: 100,
    ...partial,
  };
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

describe("ledger", () => {
  it("inserts and dedupes on the same key", () => {
    const { ledger } = freshLedger();
    try {
      expect(ledger.insertEvents([makeEvent(), makeEvent({ rawRef: "uuid-2" })])).toBe(2);
      expect(ledger.insertEvents([makeEvent(), makeEvent({ rawRef: "uuid-2" })])).toBe(0);
      expect(ledger.totals().events).toBe(2);
    } finally { ledger.close(); }
  });

  it("backfills billing evidence on a row that had none, without counting it as new", () => {
    const { ledger } = freshLedger();
    try {
      expect(ledger.insertEvents([makeEvent()])).toBe(1);
      expect(ledger.insertEvents([makeEvent({ billing: "subscription" })])).toBe(0);
      expect(ledger.priceableGroups()).toEqual([
        { provider: "anthropic", model: "claude-fable-5-1", billing: "subscription" },
      ]);
    } finally { ledger.close(); }
  });

  it("forgets Codex read positions once when it adds the billing column", () => {
    const { ledger, path } = freshLedger();
    ledger.setOffset("/h/.codex/sessions/2026/09/15/rollout-a.jsonl", 99);
    ledger.setState("codex:cum:/h/.codex/sessions/2026/09/15/rollout-a.jsonl", "{}");
    ledger.setOffset("/h/.claude/projects/p/s.jsonl", 42);
    ledger.close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE usage_events DROP COLUMN billing");
    db.close();
    const upgraded = new Ledger(path);
    try {
      expect(upgraded.getOffset("/h/.codex/sessions/2026/09/15/rollout-a.jsonl")).toBe(0);
      expect(upgraded.getState("codex:cum:/h/.codex/sessions/2026/09/15/rollout-a.jsonl")).toBeNull();
      expect(upgraded.getOffset("/h/.claude/projects/p/s.jsonl")).toBe(42);
    } finally { upgraded.close(); }
    const steady = new Ledger(path);
    steady.setOffset("/h/.codex/sessions/2026/09/15/rollout-a.jsonl", 7);
    steady.close();
    const again = new Ledger(path);
    try {
      expect(again.getOffset("/h/.codex/sessions/2026/09/15/rollout-a.jsonl")).toBe(7);
    } finally { again.close(); }
  });

  it("remembers file offsets across instances", () => {
    const { ledger, path } = freshLedger();
    ledger.setOffset("/some/file.jsonl", 1234);
    ledger.close();
    const again = new Ledger(path);
    try {
      expect(again.getOffset("/some/file.jsonl")).toBe(1234);
      expect(again.getOffset("/never/seen.jsonl")).toBe(0);
    } finally { again.close(); }
  });

  it("rolls totals up without leaking nulls", () => {
    const { ledger } = freshLedger();
    try {
      ledger.insertEvents([
        makeEvent({ costUsd: null, costSource: "unknown" }),
        makeEvent({ rawRef: "uuid-2", costUsd: 0.5, costSource: "price_list" }),
      ]);
      const t = ledger.totals();
      expect(t.events).toBe(2);
      expect(t.totalTokens).toBe(10 + 100 + 500 + 10 + 100 + 500);
      expect(t.costUsd).toBeCloseTo(0.5, 6);
      expect(t.listPriceEquivalentUsd).toBeNull();
    } finally { ledger.close(); }
  });

  it("keeps usage-billed cost and list-price equivalent apart in totals", () => {
    const { ledger } = freshLedger();
    try {
      ledger.insertEvents([
        // usage-billed: real spend
        makeEvent({ rawRef: "u1", provider: "openai", model: "gpt-6-astra", costUsd: 2, costSource: "price_list" }),
        // subscription-billed: list-price equivalent, not spend
        makeEvent({ rawRef: "s1", costUsd: null, listPriceEquivalentUsd: 3, costSource: "price_list" }),
      ]);
      const t = ledger.totals();
      expect(t.costUsd).toBeCloseTo(2, 6);
      expect(t.listPriceEquivalentUsd).toBeCloseTo(3, 6);
    } finally { ledger.close(); }
  });

  it("re-prices existing rows per group and never touches reported cost", () => {
    const { ledger } = freshLedger();
    try {
      ledger.insertEvents([
        // stale price-list cost from an older table
        makeEvent({ rawRef: "p1", costUsd: 99, costSource: "price_list" }),
        // source-reported cost must survive re-pricing
        makeEvent({ rawRef: "r1", costUsd: 0.5, costSource: "reported" }),
        // unknown-cost row for a model the table prices
        makeEvent({ rawRef: "u1", provider: "openai", model: "gpt-6-astra", costUsd: null, costSource: "unknown" }),
      ]);
      const entry = findPrice(table, "anthropic", "claude-fable-5-1")!;
      const changed = ledger.repriceGroup("anthropic", "claude-fable-5-1", ratesFor(entry), false);
      expect(changed).toBe(1);
      expect(ledger.repriceGroup("anthropic", "claude-fable-5-1", ratesFor(entry), false)).toBe(0);
      expect(ledger.repriceGroup("anthropic", "claude-fable-5-1", ratesFor(entry), true)).toBe(1);
      expect(ledger.repriceGroup("anthropic", "claude-fable-5-1", ratesFor(entry), true)).toBe(0);
      expect(ledger.repriceGroup("anthropic", "claude-fable-5-1", ratesFor(entry), false)).toBe(1);

      const gpt = findPrice(table, "openai", "gpt-6-astra")!;
      ledger.repriceGroup("openai", "gpt-6-astra", ratesFor(gpt), false);

      const models = ledger.byModel();
      const fable = models.find((m) => m.model === "claude-fable-5-1")!;
      // re-priced row (10 in + 100 out + 500 cache-read @ 0.25/MTok) plus the
      // reported 0.5, which re-pricing must not touch
      expect(Number(fable.cost_usd)).toBeCloseTo((10 * 10 + 100 * 50 + 500 * 0.25) / 1e6 + 0.5, 8);
      expect(Number(fable.unknown_cost_events)).toBe(0);

      const astra = models.find((m) => m.model === "gpt-6-astra")!;
      expect(Number(astra.cost_usd)).toBeCloseTo((10 * 10 + 100 * 50 + 500 * 1) / 1e6, 8);

      // totals: the 0.5 reported cost is still inside the fable group sum
      const t = ledger.totals();
      expect(t.costUsd).toBeCloseTo(Number(fable.cost_usd) + Number(astra.cost_usd), 6);
    } finally { ledger.close(); }
  });

  it("demotes rows the table no longer prices back to unknown", () => {
    const { ledger } = freshLedger();
    try {
      ledger.insertEvents([makeEvent({ rawRef: "p1", costUsd: 99, costSource: "price_list" })]);
      const changed = ledger.repriceGroup("anthropic", "claude-fable-5-1", null, false);
      expect(changed).toBe(1);
      expect(ledger.repriceGroup("anthropic", "claude-fable-5-1", null, false)).toBe(0);
      const row = ledger.byModel()[0];
      expect(row.cost_usd).toBeNull();
      expect(Number(row.unknown_cost_events)).toBe(1);
    } finally { ledger.close(); }
  });

  it("migrates a v1 ledger by adding the equivalent column", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-mig-"));
    tmpDirs.push(dir);
    const path = join(dir, "old.db");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, source TEXT NOT NULL, provider TEXT,
        model TEXT, session_id TEXT, project TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        cost_usd REAL, cost_source TEXT NOT NULL DEFAULT 'unknown',
        estimated INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL UNIQUE, file_offset INTEGER
      )`);
    raw.prepare(
      `INSERT INTO usage_events (ts, source, provider, model, session_id, project,
         input_tokens, output_tokens, cost_usd, cost_source, estimated, partial, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run("2026-09-15T10:00:00.000Z", "claude_code", "anthropic", "claude-fable-5-1",
      "sess-1", "fleet-deck", 10, 100, 5, "price_list", "uuid-1");
    raw.close();
    const again = new Ledger(path);
    again.close();
    const schemaVersion = () => {
      const db = new DatabaseSync(path);
      try {
        return Number((db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
      } finally { db.close(); }
    };
    const migrated = schemaVersion();
    new Ledger(path).close();
    expect(schemaVersion()).toBe(migrated);
    const reopened = new Ledger(path);
    try {
      const t = reopened.totals();
      expect(t.events).toBe(1);
      expect(t.costUsd).toBeCloseTo(5, 6);
      expect(t.listPriceEquivalentUsd).toBeNull();
    } finally { reopened.close(); }
  });
});
