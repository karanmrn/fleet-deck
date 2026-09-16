// Guard for the bundled fixtures: every model id the fixtures carry must
// resolve to a price in prices.json, to a subscription_only entry (a model
// with no list price), or be listed below on purpose. When a
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
 *  "cursor|unknown". */
const KNOWN_UNPRICED: ReadonlySet<string> = new Set<string>([
  // Claude Code writes locally generated assistant messages (API errors,
  // interrupted turns) with this model id and zero tokens. No API call is
  // billed, so the id has no list price.
  "anthropic|<synthetic>",
]);

function key(provider: unknown, model: unknown): string {
  return `${String(provider ?? "unknown")}|${String(model ?? "unknown")}`;
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

interface FixtureModel {
  provider: string | null;
  model: string | null;
  cost_usd: unknown;
  list_price_equivalent_usd: unknown;
  unknown_cost_events: number;
  subscription_only_events: number;
}

async function fixtureModelIds(): Promise<FixtureModel[]> {
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
      cost_usd: r.cost_usd,
      list_price_equivalent_usd: r.list_price_equivalent_usd,
      unknown_cost_events: Number(r.unknown_cost_events),
      subscription_only_events: Number(r.subscription_only_events),
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

  it("covers a subscription-only model by its marker, not by a price or the allowlist", async () => {
    const seen = await fixtureModelIds();
    const spark = seen.find((r) => r.provider === "openai" && r.model === "gpt-5.3-codex-spark");
    expect(spark, "the Codex fixture carries gpt-5.3-codex-spark").toBeTruthy();
    expect(KNOWN_UNPRICED.has(key(spark!.provider, spark!.model))).toBe(false);
    const entry = findPrice(table, spark!.provider, spark!.model)!;
    expect(entry.subscription_only).toBe(true);
    expect(entry.note).toBeTruthy();
    expect([entry.input_per_mtok, entry.output_per_mtok, entry.cache_read_per_mtok, entry.cache_write_per_mtok])
      .toEqual([null, null, null, null]);
    expect(spark!.cost_usd).toBeNull();
    expect(spark!.list_price_equivalent_usd).toBeNull();
    expect(spark!.unknown_cost_events).toBe(0);
    expect(spark!.subscription_only_events).toBeGreaterThan(0);
  });

  it("the allowlist only contains ids the fixtures actually produce", async () => {
    const seen = new Set((await fixtureModelIds()).map((r) => key(r.provider, r.model)));
    for (const entry of KNOWN_UNPRICED) {
      expect(seen.has(entry), `stale allowlist entry "${entry}" - no fixture row carries it`).toBe(true);
    }
  });
});
