// Codex adapter: ~/.codex/sessions/**/rollout-*.jsonl
// `token_count` events carry cumulative `total_token_usage` per session;
// we emit deltas so summation is correct, and mark them estimated because
// the ledger relies on cumulative bookkeeping.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, toIso, txt, walkFiles } from "../util.js";
import { readJsonlFromOffset } from "./jsonl.js";

const ID = "codex";

interface Cum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

function listFiles(home: string): string[] {
  const base = join(home, ".codex", "sessions");
  if (!existsSync(base)) return [];
  return [...walkFiles(base, 4, (f) => basename(f).startsWith("rollout-") && f.endsWith(".jsonl"))].sort();
}

function readCum(v: unknown): Cum | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  return {
    input: num(r.input_tokens) ?? 0,
    cacheRead: num(r.cached_input_tokens) ?? 0,
    cacheWrite: num(r.cache_write_input_tokens) ?? 0,
    output: num(r.output_tokens) ?? 0,
    reasoning: num(r.reasoning_output_tokens) ?? 0,
  };
}

export const codexAdapter: Adapter = {
  id: ID,
  label: "Codex CLI",
  trust: "best-effort",

  async detect(home): Promise<SourceStatus> {
    const files = listFiles(home);
    return {
      id: ID,
      label: "Codex CLI",
      trust: "best-effort",
      found: files.length > 0,
      detail: files.length > 0
        ? `${files.length} rollout files under ~/.codex/sessions`
        : "~/.codex/sessions not found",
    };
  },

  async scan(ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const offsets: Record<string, number> = {};
    const state: Record<string, string> = {};
    const notes: string[] = [
      "token counts derived from cumulative counters (deltas); treated as estimated",
    ];
    let filesScanned = 0;
    let filesSkipped = 0;
    let sensitive = 0;

    for (const file of listFiles(ctx.home)) {
      let scan;
      try {
        scan = readJsonlFromOffset(file, ctx.getOffset(file));
      } catch {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      sensitive += scan.skippedSensitive;
      if (scan.truncated) notes.push(`${basename(file)} shrank; rescanned from start`);
      offsets[file] = scan.nextOffset;

      const stateKey = `codex:cum:${file}`;
      const prev: Cum = JSON.parse(ctx.getState(stateKey) ?? "null") ?? {
        input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
      };
      let latest: Cum = { ...prev };
      let model: string | null = null;
      let lastTs: string | null = null;
      let sawUsage = false;

      for (const line of scan.lines) {
        const o = line.obj;
        const type = txt(o.type);
        const payload = (o.payload ?? {}) as Record<string, unknown>;
        if (type === "turn_context") {
          const m = txt(payload.model);
          if (m) model = m;
          continue;
        }
        if (type !== "event_msg" || txt(payload.type) !== "token_count") continue;
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const cum = readCum(info.total_token_usage);
        if (cum) {
          latest = cum;
          sawUsage = true;
          lastTs = toIso(o.timestamp) ?? lastTs;
        }
      }

      if (!sawUsage) continue;
      const delta: Cum = {
        input: Math.max(0, latest.input - prev.input),
        cacheRead: Math.max(0, latest.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, latest.cacheWrite - prev.cacheWrite),
        output: Math.max(0, latest.output - prev.output),
        reasoning: Math.max(0, latest.reasoning - prev.reasoning),
      };
      state[stateKey] = JSON.stringify(latest);
      const hasDelta =
        delta.input + delta.cacheRead + delta.cacheWrite + delta.output + delta.reasoning > 0;
      if (!hasDelta) continue;

      events.push({
        ts: lastTs ?? new Date().toISOString(),
        source: ID,
        provider: "openai",
        model,
        sessionId: basename(file, ".jsonl"),
        project: null,
        inputTokens: delta.input,
        outputTokens: delta.output,
        cacheReadTokens: delta.cacheRead,
        cacheWriteTokens: delta.cacheWrite,
        reasoningTokens: delta.reasoning,
        costUsd: null,
        costSource: "unknown",
        estimated: true,
        partial: false,
        rawRef: `${basename(file)}:${scan.nextOffset}`,
        fileOffset: scan.nextOffset,
      });
    }
    if (sensitive > 0) notes.push(`${sensitive} sensitive lines skipped unread`);
    return { events, offsets, state, filesScanned, filesSkipped, notes };
  },
};
