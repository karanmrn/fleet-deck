// Cursor adapter: ~/.cursor/ai-tracking/ai-code-tracking.db
// The local database has no token counts, so this adapter records model and
// activity only. Events are marked partial=true and contribute nothing to
// token or cost totals.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { toIso, txt } from "../util.js";
import { openSqliteReadonly } from "./sqlite.js";

const ID = "cursor";
const STATE_KEY = "cursor:last_rowid";

function dbPathFor(home: string): string {
  return join(home, ".cursor", "ai-tracking", "ai-code-tracking.db");
}

export const cursorAdapter: Adapter = {
  id: ID,
  label: "Cursor",
  trust: "best-effort",

  async detect(home): Promise<SourceStatus> {
    const found = existsSync(dbPathFor(home));
    return {
      id: ID,
      label: "Cursor",
      trust: "best-effort",
      found,
      detail: found
        ? "~/.cursor/ai-tracking/ai-code-tracking.db (activity only, no token counts)"
        : "~/.cursor/ai-tracking/ai-code-tracking.db not found",
    };
  },

  async scan(ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const state: Record<string, string> = {};
    const notes: string[] = ["activity only - Cursor does not log token counts locally"];
    const src = dbPathFor(ctx.home);
    const { db, cleanup, note } = openSqliteReadonly(src);
    if (note) notes.push(note);
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_code_hashes'")
        .get() as Record<string, unknown> | undefined;
      if (!hasTable) {
        notes.push("ai_code_hashes table not found");
        return { events, offsets: {}, state, filesScanned: 1, filesSkipped: 0, notes };
      }
      const lastRowid = Number(ctx.getState(STATE_KEY) ?? "0") || 0;
      const rows = db
        .prepare("SELECT rowid AS rid, * FROM ai_code_hashes WHERE rowid > ? ORDER BY rowid")
        .all(lastRowid) as Record<string, unknown>[];
      let maxRid = lastRowid;
      for (const row of rows) {
        const rid = Number(row.rid);
        if (Number.isFinite(rid) && rid > maxRid) maxRid = rid;
        const ts = toIso(row.timestamp) ?? toIso(row.createdAt);
        if (!ts) continue;
        events.push({
          ts,
          source: ID,
          provider: "cursor",
          model: txt(row.model),
          sessionId: txt(row.conversationId),
          project: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          costUsd: null,
          costSource: "unknown",
          estimated: false,
          partial: true,
          rawRef: `ai_code_hashes:${rid}`,
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
