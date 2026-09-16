import { mkdtempSync, rmSync } from "node:fs";
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
    // 3 claude + 2 prime + 2 gnhf + 1 codex
    expect(report.totalInserted).toBe(8);
    expect(report.sources.every((s) => s.found)).toBe(true);
    expect(report.dbPath).toBe(dbPath);

    const ledger = new Ledger(dbPath);
    try {
      const t = ledger.totals();
      expect(t.events).toBe(8);
      // prime reported cost + price-table cost on priced models
      expect(t.costUsd).not.toBeNull();
      expect(t.costUsd!).toBeGreaterThan(0);
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
    } finally {
      ledger.close();
    }
  });
});
