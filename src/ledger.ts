// SQLite ledger at ~/.fleet-deck/ledger.db, built on node:sqlite.
//
// Why node:sqlite and not better-sqlite3: better-sqlite3 ships a native
// addon that must compile or download a prebuilt binary on install. That is
// fragile inside an npx cache and on machines without a toolchain. node:sqlite
// is built into Node 22.13+, so `npx fleet-deck` works with zero native deps.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { buildDedupeKey, type UsageEvent } from "./types.js";

export function defaultDbPath(): string {
  return join(homedir(), ".fleet-deck", "ledger.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  session_id TEXT,
  project TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd REAL,
  cost_source TEXT NOT NULL DEFAULT 'unknown',
  list_price_equivalent_usd REAL,
  estimated INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE,
  file_offset INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);

CREATE TABLE IF NOT EXISTS source_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const VIEWS = `
CREATE VIEW v_day_model AS
SELECT date(ts) AS day,
       COALESCE(provider, 'unknown') AS provider,
       COALESCE(model, 'unknown') AS model,
       source,
       COUNT(*) AS events,
       COUNT(DISTINCT session_id) AS sessions,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(cache_read_tokens) AS cache_read_tokens,
       SUM(cache_write_tokens) AS cache_write_tokens,
       SUM(reasoning_tokens) AS reasoning_tokens,
       SUM(cost_usd) AS cost_usd,
       SUM(list_price_equivalent_usd) AS list_price_equivalent_usd,
       MAX(estimated) AS any_estimated,
       MAX(partial) AS any_partial
FROM usage_events
GROUP BY day, provider, model, source;

CREATE VIEW v_day_source AS
SELECT date(ts) AS day,
       source,
       COUNT(*) AS events,
       COUNT(DISTINCT session_id) AS sessions,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(cache_read_tokens) AS cache_read_tokens,
       SUM(cache_write_tokens) AS cache_write_tokens,
       SUM(reasoning_tokens) AS reasoning_tokens,
       SUM(cost_usd) AS cost_usd,
       SUM(list_price_equivalent_usd) AS list_price_equivalent_usd
FROM usage_events
GROUP BY day, source;
`;

export interface Totals {
  events: number;
  sessions: number;
  models: number;
  providers: number;
  sources: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number | null; // null = nothing priced yet
  /** Sum of list-price equivalents (subscription-billed providers only).
   *  null = no subscription-billed model has a price. Never mixed into costUsd. */
  listPriceEquivalentUsd: number | null;
  estimatedEvents: number;
  partialEvents: number;
}

type Row = Record<string, unknown>;

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class Ledger {
  private db: DatabaseSync;

  constructor(dbPath: string = defaultDbPath()) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Upgrade ledgers written by older versions: add new columns, rebuild
   *  views (CREATE VIEW IF NOT EXISTS would keep stale definitions). */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(usage_events)").all() as Row[];
    if (!cols.some((c) => c.name === "list_price_equivalent_usd")) {
      this.db.exec("ALTER TABLE usage_events ADD COLUMN list_price_equivalent_usd REAL");
    }
    this.db.exec("DROP VIEW IF EXISTS v_day_model");
    this.db.exec("DROP VIEW IF EXISTS v_day_source");
    this.db.exec(VIEWS);
  }

  close(): void {
    this.db.close();
  }

  /** Insert events, skipping any whose dedupe key already exists.
   *  Returns how many were actually new. */
  insertEvents(events: UsageEvent[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        ts, source, provider, model, session_id, project,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, cost_usd, cost_source, list_price_equivalent_usd,
        estimated, partial, dedupe_key, file_offset
      ) VALUES (
        :ts, :source, :provider, :model, :sessionId, :project,
        :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens,
        :reasoningTokens, :costUsd, :costSource, :listPriceEquivalentUsd,
        :estimated, :partial, :dedupeKey, :fileOffset
      )
    `);
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        const result = stmt.run({
          ts: e.ts,
          source: e.source,
          provider: e.provider,
          model: e.model,
          sessionId: e.sessionId,
          project: e.project,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheReadTokens: e.cacheReadTokens,
          cacheWriteTokens: e.cacheWriteTokens,
          reasoningTokens: e.reasoningTokens,
          costUsd: e.costUsd,
          costSource: e.costSource,
          listPriceEquivalentUsd: e.listPriceEquivalentUsd,
          estimated: e.estimated ? 1 : 0,
          partial: e.partial ? 1 : 0,
          dedupeKey: buildDedupeKey(e.source, e.sessionId, e.rawRef),
          fileOffset: e.fileOffset,
        });
        inserted += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  getOffset(path: string): number {
    const row = this.db
      .prepare("SELECT value FROM source_state WHERE key = ?")
      .get(`offset:${path}`) as Row | undefined;
    const value = row ? Number(row.value) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  setOffset(path: string, offset: number): void {
    this.setState(`offset:${path}`, String(Math.max(0, Math.floor(offset))));
  }

  getState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM source_state WHERE key = ?")
      .get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO source_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  totals(): Totals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS events,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT model) AS models,
                COUNT(DISTINCT provider) AS providers,
                COUNT(DISTINCT source) AS sources,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(list_price_equivalent_usd) AS list_price_equivalent_usd,
                SUM(estimated) AS estimated_events,
                SUM(partial) AS partial_events
         FROM usage_events`,
      )
      .get() as Row;
    const input = n(row.input_tokens);
    const output = n(row.output_tokens);
    const cacheRead = n(row.cache_read_tokens);
    const cacheWrite = n(row.cache_write_tokens);
    const reasoning = n(row.reasoning_tokens);
    return {
      events: n(row.events),
      sessions: n(row.sessions),
      models: n(row.models),
      providers: n(row.providers),
      sources: n(row.sources),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      totalTokens: input + output + cacheRead + cacheWrite + reasoning,
      costUsd: nOrNull(row.cost_usd),
      listPriceEquivalentUsd: nOrNull(row.list_price_equivalent_usd),
      estimatedEvents: n(row.estimated_events),
      partialEvents: n(row.partial_events),
    };
  }

  /** Day x model x provider x source rollups, newest day first. */
  byDayModel(limitDays = 60): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM v_day_model
         WHERE day >= date('now', ?)
         ORDER BY day ASC, model ASC`,
      )
      .all(`-${limitDays} days`) as Row[];
  }

  byDay(limitDays = 60): Row[] {
    return this.db
      .prepare(
        `SELECT day,
                SUM(events) AS events,
                SUM(sessions) AS sessions,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(list_price_equivalent_usd) AS list_price_equivalent_usd
         FROM v_day_source
         WHERE day >= date('now', ?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(`-${limitDays} days`) as Row[];
  }

  byModel(): Row[] {
    return this.db
      .prepare(
        `SELECT COALESCE(provider, 'unknown') AS provider,
                COALESCE(model, 'unknown') AS model,
                COUNT(*) AS events,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(list_price_equivalent_usd) AS list_price_equivalent_usd,
                SUM(CASE WHEN cost_usd IS NULL AND list_price_equivalent_usd IS NULL
                         THEN 1 ELSE 0 END) AS unknown_cost_events,
                MAX(estimated) AS any_estimated,
                MAX(partial) AS any_partial
         FROM usage_events
         GROUP BY provider, model
         ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)
                 + COALESCE(SUM(cache_read_tokens),0) + COALESCE(SUM(cache_write_tokens),0)) DESC`,
      )
      .all() as Row[];
  }

  bySource(): Row[] {
    return this.db
      .prepare(
        `SELECT source,
                COUNT(*) AS events,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT model) AS models,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(list_price_equivalent_usd) AS list_price_equivalent_usd,
                MAX(estimated) AS any_estimated,
                MAX(partial) AS any_partial,
                MIN(ts) AS first_ts,
                MAX(ts) AS last_ts
         FROM usage_events
         GROUP BY source
         ORDER BY events DESC`,
      )
      .all() as Row[];
  }

  /** (provider, model) groups that carry rows priced (or left unknown) by
   *  the price table - the candidates for re-pricing on every scan. */
  priceableGroups(): Array<{ provider: string | null; model: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT provider, model
         FROM usage_events
         WHERE cost_source IN ('unknown', 'price_list')`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
      model: r.model === null || r.model === undefined ? null : String(r.model),
    }));
  }

  /** Recompute price-table cost for every row of one (provider, model)
   *  group, per-row, from the current rates. Never touches rows whose cost
   *  the source reported. rates=null demotes rows the table no longer
   *  prices back to unknown. Returns the number of rows updated. */
  repriceGroup(
    provider: string | null,
    model: string | null,
    rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | null,
    subscription: boolean,
  ): number {
    const match = "WHERE (provider IS ?) AND (model IS ?)";
    if (rates === null) {
      const r = this.db
        .prepare(
          `UPDATE usage_events
           SET cost_usd = NULL, list_price_equivalent_usd = NULL, cost_source = 'unknown'
           ${match} AND cost_source = 'price_list'`,
        )
        .run(provider, model);
      return Number(r.changes);
    }
    const usd = (
      `ROUND((COALESCE(input_tokens, 0) * ${rates.input}` +
      ` + COALESCE(output_tokens, 0) * ${rates.output}` +
      ` + COALESCE(cache_read_tokens, 0) * ${rates.cacheRead}` +
      ` + COALESCE(cache_write_tokens, 0) * ${rates.cacheWrite}` +
      ` + COALESCE(reasoning_tokens, 0) * ${rates.output}) / 1000000.0, 8)`
    );
    const sql = subscription
      ? `UPDATE usage_events SET cost_usd = NULL, list_price_equivalent_usd = ${usd}, cost_source = 'price_list' ${match} AND cost_source IN ('unknown', 'price_list')`
      : `UPDATE usage_events SET cost_usd = ${usd}, list_price_equivalent_usd = NULL, cost_source = 'price_list' ${match} AND cost_source IN ('unknown', 'price_list')`;
    const r = this.db.prepare(sql).run(provider, model);
    return Number(r.changes);
  }
}
