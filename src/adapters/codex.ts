// Codex adapter: ~/.codex/sessions/**/rollout-*.jsonl
// `token_count` events carry cumulative `total_token_usage` per session;
// we emit one delta per token_count line so summation and day attribution
// are correct, and mark them estimated because the ledger relies on
// cumulative bookkeeping. A counter that goes down starts a new count.
// Cached tokens are part of input_tokens and
// reasoning tokens are part of output_tokens; both are split out.

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

interface CodexState extends Cum {
  model: string | null;
}

const ZERO: Cum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };

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
      const saved = JSON.parse(ctx.getState(stateKey) ?? "null") as Partial<CodexState> | null;
      let prev: Cum = { ...ZERO, ...saved };
      let model: string | null = saved?.model ?? null;
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
        if (!cum) continue;
        sawUsage = true;
        const base = cum.input < prev.input || cum.output < prev.output ? ZERO : prev;
        const delta: Cum = {
          input: Math.max(0, cum.input - base.input),
          cacheRead: Math.max(0, cum.cacheRead - base.cacheRead),
          cacheWrite: Math.max(0, cum.cacheWrite - base.cacheWrite),
          output: Math.max(0, cum.output - base.output),
          reasoning: Math.max(0, cum.reasoning - base.reasoning),
        };
        prev = cum;
        if (delta.input + delta.output <= 0) continue;
        const ts = toIso(o.timestamp);
        if (!ts) continue;

        events.push({
          ts,
          source: ID,
          provider: "openai",
          model,
          sessionId: basename(file, ".jsonl"),
          project: null,
          inputTokens: Math.max(0, delta.input - delta.cacheRead - delta.cacheWrite),
          outputTokens: Math.max(0, delta.output - delta.reasoning),
          cacheReadTokens: delta.cacheRead,
          cacheWriteTokens: delta.cacheWrite,
          reasoningTokens: delta.reasoning,
          costUsd: null,
          costSource: "unknown",
          estimated: true,
          partial: false,
          rawRef: `${basename(file)}:${line.start}`,
          fileOffset: line.end,
        });
      }

      if (sawUsage || model !== (saved?.model ?? null)) {
        const next: CodexState = { ...prev, model };
        state[stateKey] = JSON.stringify(next);
      }
    }
    if (sensitive > 0) notes.push(`${sensitive} sensitive lines skipped unread`);
    return { events, offsets, state, filesScanned, filesSkipped, notes };
  },
};
