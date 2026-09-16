import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScan } from "../src/scan.js";
import { Ledger } from "../src/ledger.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { primeAdapter } from "../src/adapters/prime.js";
import { gnhfAdapter } from "../src/adapters/gnhf.js";
import { codexAdapter } from "../src/adapters/codex.js";

const HOME = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "home");
const tmpDirs: string[] = [];
const ADAPTERS = [claudeCodeAdapter, primeAdapter, gnhfAdapter, codexAdapter];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleetdeck-scan-"));
  tmpDirs.push(dir);
  return join(dir, "ledger.db");
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

describe("runScan integration", () => {
  it("scans the fixture home into a fresh ledger", async () => {
    const dbPath = tmpDb();
    const report = await runScan({ home: HOME, dbPath, adapters: ADAPTERS });
    // 3 claude (4 lines, one API response logged twice) + 2 prime + 2 gnhf + 2 codex
    expect(report.totalInserted).toBe(9);
    expect(report.sources.every((s) => s.found)).toBe(true);
    expect(report.dbPath).toBe(dbPath);

    const ledger = new Ledger(dbPath);
    try {
      const t = ledger.totals();
      expect(t.events).toBe(9);
      // prime reported cost + price-table cost on priced models
      expect(t.costUsd).not.toBeNull();
      expect(t.costUsd!).toBeGreaterThan(0);
      expect(t.listPriceEquivalentUsd).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("is idempotent - a second scan inserts nothing", async () => {
    const dbPath = tmpDb();
    await runScan({ home: HOME, dbPath, adapters: ADAPTERS });
    const second = await runScan({ home: HOME, dbPath, adapters: ADAPTERS });
    expect(second.totalInserted).toBe(0);
  });

  it("applies the price table to known models", async () => {
    const dbPath = tmpDb();
    await runScan({ home: HOME, dbPath, adapters: [claudeCodeAdapter] });
    const ledger = new Ledger(dbPath);
    try {
      const rows = ledger.byModel();
      const fable = rows.find((r) => r.model === "claude-fable-5-1");
      expect(fable).toBeTruthy();
      expect(Number(fable.cost_usd)).toBeGreaterThan(0);
      const sonnet = rows.find((r) => r.model === "claude-sonnet-4-8");
      expect(sonnet).toBeTruthy();
      expect(Number(sonnet.cost_usd)).toBeGreaterThan(0);
    } finally {
      ledger.close();
    }
  });

  it("prices subscription-billed providers as list-price equivalent, not cost", async () => {
    const dbPath = tmpDb();
    const dir = dirname(dbPath);
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ billing: { anthropic: "subscription" } }));
    await runScan({ home: HOME, dbPath, adapters: ADAPTERS, billingConfigPath: cfg });
    const ledger = new Ledger(dbPath);
    try {
      const rows = ledger.byModel();
      const fable = rows.find((r) => r.model === "claude-fable-5-1")!;
      expect(fable).toBeTruthy();
      expect(Number(fable.list_price_equivalent_usd)).toBeGreaterThan(0);
      // spend stays apart: anthropic rows carry no cost, prime rows still do
      expect(fable.cost_usd).toBeNull();
      const t = ledger.totals();
      expect(t.listPriceEquivalentUsd).not.toBeNull();
      expect(t.listPriceEquivalentUsd!).toBeGreaterThan(0);
      expect(t.costUsd).not.toBeNull(); // prime reported cost only
      expect(t.costUsd!).toBeLessThan(t.listPriceEquivalentUsd!);
    } finally {
      ledger.close();
    }
  });

  it("re-prices ledger rows when the billing mode flips to subscription", async () => {
    const dbPath = tmpDb();
    await runScan({ home: HOME, dbPath, adapters: [claudeCodeAdapter] });
    const ledger = new Ledger(dbPath);
    let before: number | null = null;
    try {
      const fable = ledger.byModel().find((r) => r.model === "claude-fable-5-1")!;
      before = fable.cost_usd === null ? null : Number(fable.cost_usd);
    } finally {
      ledger.close();
    }
    expect(before).not.toBeNull();

    const cfg = join(dirname(dbPath), "config.json");
    writeFileSync(cfg, JSON.stringify({ billing: { anthropic: "subscription" } }));
    const report = await runScan({ home: HOME, dbPath, adapters: [claudeCodeAdapter], billingConfigPath: cfg });
    expect(report.repricedRows).toBeGreaterThan(0);
    const steady = await runScan({ home: HOME, dbPath, adapters: [claudeCodeAdapter], billingConfigPath: cfg });
    expect(steady.repricedRows).toBe(0);

    const again = new Ledger(dbPath);
    try {
      const fable = again.byModel().find((r) => r.model === "claude-fable-5-1")!;
      expect(fable.cost_usd).toBeNull();
      expect(Number(fable.list_price_equivalent_usd)).toBeCloseTo(before!, 6);
    } finally {
      again.close();
    }
  });
});
