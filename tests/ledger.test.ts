import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";
import type { UsageEvent } from "../src/types.js";

const tmpDirs: string[] = [];

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
    } finally { ledger.close(); }
  });
});
