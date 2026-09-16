// Guard for the bundled fixtures: every model id the fixtures carry must
// resolve to a price in prices.json or be listed below on purpose. When a
// new fixture brings a model the table does not price, this test fails
// loudly instead of letting the cost silently become "unknown".

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
import { noMistakesAdapter } from "../src/adapters/no-mistakes.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { findPrice, loadPriceTable } from "../src/prices.js";

const HOME = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "home");
const tmpDirs: string[] = [];
const ADAPTERS = [claudeCodeAdapter, primeAdapter, gnhfAdapter, codexAdapter, noMistakesAdapter, cursorAdapter];

/** Model ids the fixtures carry that are deliberately not priced, as
 *  "provider|model" (COALESCE'd to "unknown" when null). Add an entry ONLY
 *  together with a comment saying why the model is not priced - a new
 *  unknown id should fail the test below, not be hidden here. Sources that
 *  log no model id at all (e.g. Cursor activity rows) would land here as
 *  "cursor|unknown". Empty today: every bundled fixture id is priced. */
const KNOWN_UNPRICED: ReadonlySet<string> = new Set<string>([
  // (none)
]);

function key(provider: unknown, model: unknown): string {
  return `${String(provider ?? "unknown")}|${String(model ?? "unknown")}`;
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

async function fixtureModelIds(): Promise<Array<{ provider: string | null; model: string | null }>> {
  const dir = mkdtempSync(join(tmpdir(), "fleetdeck-coverage-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "ledger.db");
  await runScan({ home: HOME, dbPath, adapters: ADAPTERS });
  const ledger = new Ledger(dbPath);
  try {
    const rows = ledger.byModel();
    return rows.map((r) => ({
      provider: typeof r.provider === "string" ? r.provider : null,
      model: typeof r.model === "string" ? r.model : null,
    }));
  } finally {
    ledger.close();
  }
}

describe("price-table coverage of bundled fixtures", () => {
  const table = loadPriceTable("prices.json");

  it("every fixture model id resolves to a price or is a known-unpriced allowlist entry", async () => {
    const seen = await fixtureModelIds();
    expect(seen.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const { provider, model } of seen) {
      if (KNOWN_UNPRICED.has(key(provider, model))) continue;
      if (findPrice(table, provider, model) === null) missing.push(key(provider, model));
    }
    expect(
      missing,
      `fixture model ids without a price in prices.json v${table.version} - ` +
        `add a verified entry or extend KNOWN_UNPRICED with a reason`,
    ).toEqual([]);
  });

  it("the allowlist only contains ids the fixtures actually produce", async () => {
    const seen = new Set((await fixtureModelIds()).map((r) => key(r.provider, r.model)));
    for (const entry of KNOWN_UNPRICED) {
      expect(seen.has(entry), `stale allowlist entry "${entry}" - no fixture row carries it`).toBe(true);
    }
  });
});
