// no-mistakes adapter: read-only query of ~/.no-mistakes/state.sqlite,
// table agent_invocations - the richest structured usage source on the Mac.
// The live DB belongs to the shared daemon; we copy it to a temp file and
// query the copy so we never touch or lock the daemon's live database.
// Incremental via last seen rowid (not file offset).

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, toIso, txt } from "../util.js";
import { openSqliteReadonly } from "./sqlite.js";

const ID = "no_mistakes";
const STATE_KEY = "no_mistakes:last_rowid";

function dbPathFor(home: string): string {
  return join(home, ".no-mistakes", "state.sqlite");
}

export const noMistakesAdapter: Adapter = {
  id: ID,
  label: "no-mistakes",
  trust: "high",

  async detect(home): Promise<SourceStatus> {
    const found = existsSync(dbPathFor(home));
    return {
      id: ID,
      label: "no-mistakes",
      trust: "high",
      found,
      detail: found ? "~/.no-mistakes/state.sqlite" : "~/.no-mistakes/state.sqlite not found",
    };
  },

  async scan(ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const state: Record<string, string> = {};
    const notes: string[] = [];
    const { db, cleanup } = openSqliteReadonly(dbPathFor(ctx.home), { copy: true });
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_invocations'")
        .get() as Record<string, unknown> | undefined;
      if (!hasTable) {
        notes.push("agent_invocations table not found in state.sqlite");
        return { events, offsets: {}, state, filesScanned: 0, filesSkipped: 1, notes };
      }
      const lastRowid = Number(ctx.getState(STATE_KEY) ?? "0") || 0;
      const rows = db
        .prepare("SELECT rowid AS rid, * FROM agent_invocations WHERE rowid > ? ORDER BY rowid")
        .all(lastRowid) as Record<string, unknown>[];
      let maxRid = lastRowid;
      for (const row of rows) {
        const rid = Number(row.rid);
        if (Number.isFinite(rid) && rid > maxRid) maxRid = rid;
        const ts = toIso(row.completed_at) ?? toIso(row.started_at);
        if (!ts) continue;
        events.push({
          ts,
          source: ID,
          provider: txt(row.model_provider),
          model: txt(row.model),
          sessionId: txt(row.run_id),
          project: null,
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens),
          cacheReadTokens: num(row.cache_read_tokens),
          cacheWriteTokens: num(row.cache_creation_tokens),
          reasoningTokens: num(row.reasoning_tokens),
          costUsd: null,
          costSource: "unknown",
          listPriceEquivalentUsd: null,
          billing: null,
          estimated: false,
          partial: false,
          rawRef: `agent_invocations:${rid}`,
          fileOffset: null,
        });
      }
      if (maxRid > lastRowid) state[STATE_KEY] = String(maxRid);
    } finally {
      db.close();
      cleanup();
    }
    return { events, offsets: {}, state, filesScanned: 1, filesSkipped: 0, notes };
  },
};
