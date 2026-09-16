// Scan orchestrator: runs adapters, applies the cost engine, dedups into
// the ledger, stores incremental offsets/state, then re-prices existing
// rows against the current price table so a prices.json edit or a billing
// change takes effect on the next scan without losing history.

import { homedir } from "node:os";

import type { Adapter, AdapterContext, ScanOutcome, SourceStatus } from "./types.js";
import { Ledger, defaultDbPath } from "./ledger.js";
import {
  applyCost,
  defaultBillingConfigPath,
  findPrice,
  loadBillingConfig,
  loadPriceTable,
  ratesFor,
  resolveBilling,
} from "./prices.js";

export interface SourceReport {
  id: string;
  label: string;
  trust: string;
  found: boolean;
  detail: string;
  filesScanned: number;
  filesSkipped: number;
  eventsSeen: number;
  eventsInserted: number;
  notes: string[];
}

export interface ScanReport {
  startedAt: string;
  finishedAt: string;
  dbPath: string;
  sources: SourceReport[];
  totalInserted: number;
  repricedRows: number;
}

export async function runScan(opts: {
  home?: string;
  dbPath?: string;
  billingConfigPath?: string;
  adapters: Adapter[];
  logger?: (msg: string) => void;
}): Promise<ScanReport> {
  const home = opts.home ?? homedir();
  const dbPath = opts.dbPath ?? defaultDbPath();
  const log = opts.logger ?? (() => {});
  const ledger = new Ledger(dbPath);
  const table = loadPriceTable();
  const configPath = opts.billingConfigPath ?? defaultBillingConfigPath(home);
  const config = loadBillingConfig(configPath);
  const billing = resolveBilling(table, config);
  for (const [provider, mode] of Object.entries(config.billing ?? {})) {
    log(`billing override from ${configPath}: ${provider}=${mode}`);
  }
  const startedAt = new Date().toISOString();
  const sources: SourceReport[] = [];
  let totalInserted = 0;

  try {
    for (const adapter of opts.adapters) {
      let status: SourceStatus;
      try {
        status = await adapter.detect(home);
      } catch (err) {
        sources.push({
          id: adapter.id, label: adapter.label, trust: adapter.trust,
          found: false, detail: `detect error: ${String(err)}`,
          filesScanned: 0, filesSkipped: 0, eventsSeen: 0, eventsInserted: 0, notes: [],
        });
        continue;
      }
      if (!status.found) {
        sources.push({
          id: adapter.id, label: adapter.label, trust: adapter.trust,
          found: false, detail: status.detail,
          filesScanned: 0, filesSkipped: 0, eventsSeen: 0, eventsInserted: 0, notes: [],
        });
        continue;
      }
      log(`scanning ${adapter.id}...`);
      const ctx: AdapterContext = {
        home,
        getOffset: (p) => ledger.getOffset(p),
        getState: (k) => ledger.getState(k),
      };
      let outcome: ScanOutcome;
      try {
        outcome = await adapter.scan(ctx);
      } catch (err) {
        sources.push({
          id: adapter.id, label: adapter.label, trust: adapter.trust,
          found: true, detail: `scan error: ${String(err)}`,
          filesScanned: 0, filesSkipped: 0, eventsSeen: 0, eventsInserted: 0,
          notes: [String(err)],
        });
        continue;
      }
      for (const e of outcome.events) applyCost(e, table, billing);
      const inserted = ledger.insertEvents(outcome.events);
      for (const [p, off] of Object.entries(outcome.offsets)) ledger.setOffset(p, off);
      for (const [k, v] of Object.entries(outcome.state ?? {})) ledger.setState(k, v);
      totalInserted += inserted;
      sources.push({
        id: adapter.id, label: adapter.label, trust: adapter.trust,
        found: true, detail: status.detail,
        filesScanned: outcome.filesScanned, filesSkipped: outcome.filesSkipped,
        eventsSeen: outcome.events.length, eventsInserted: inserted,
        notes: outcome.notes,
      });
    }

    // Reconcile: rows priced by an older table (or left unknown before a
    // model was added) follow the current prices.json and billing config.
    let repricedRows = 0;
    for (const g of ledger.priceableGroups()) {
      const entry = findPrice(table, g.provider, g.model);
      const subscription = billing[(g.provider ?? "").toLowerCase()] === "subscription";
      repricedRows += ledger.repriceGroup(
        g.provider,
        g.model,
        entry ? ratesFor(entry) : null,
        subscription,
      );
    }
    if (repricedRows > 0) {
      log(`repriced ${repricedRows} rows against prices.json v${table.version}`);
    }
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      dbPath,
      sources,
      totalInserted,
      repricedRows,
    };
  } finally {
    ledger.close();
  }
}
