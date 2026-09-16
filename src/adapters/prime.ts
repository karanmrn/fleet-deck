// Prime adapter: ~/.prime/agent/sessions/*.jsonl
// One file per session: a session header line, then event lines. Assistant
// message lines carry provider, model, timestamp and usage with cost already
// computed in USD - the best local cost source (cost_source=reported).

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, toIso, txt } from "../util.js";
import { projectFolderName, shouldSkipFile } from "../redact.js";
import { readJsonlFromOffset } from "./jsonl.js";

const ID = "prime";

function listFiles(home: string): string[] {
  const base = join(home, ".prime", "agent", "sessions");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(base, f))
      .filter((f) => !shouldSkipFile(f))
      .sort();
  } catch {
    return [];
  }
}

export const primeAdapter: Adapter = {
  id: ID,
  label: "Prime agent",
  trust: "high",

  async detect(home): Promise<SourceStatus> {
    const files = listFiles(home);
    return {
      id: ID,
      label: "Prime agent",
      trust: "high",
      found: files.length > 0,
      detail: files.length > 0 ? `${files.length} session files under ~/.prime/agent/sessions` : "~/.prime/agent/sessions not found",
    };
  },

  async scan(ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const offsets: Record<string, number> = {};
    const notes: string[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let sensitive = 0;
    let unparsed = 0;

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
      unparsed += scan.unparsed;
      if (scan.truncated) notes.push(`${basename(file)} shrank - restarted from 0`);
      offsets[file] = scan.nextOffset;

      let sessionId: string | null = basename(file, ".jsonl");
      let project: string | null = null;
      let curProvider: string | null = null;
      let curModel: string | null = null;

      for (const line of scan.lines) {
        const o = line.obj;
        const type = txt(o.type);
        if (type === "session") {
          sessionId = txt(o.id) ?? sessionId;
          project = projectFolderName(txt(o.cwd)) ?? project;
          continue;
        }
        if (type === "model_change") {
          const p = txt(o.provider);
          const m = txt(o.modelId);
          if (p) curProvider = p;
          if (m) curModel = m;
          continue;
        }
        if (type !== "message") continue;
        const msg = o.message as Record<string, unknown> | undefined;
        if (!msg || txt(msg.role) !== "assistant") continue;
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const ts = toIso(o.timestamp) ?? toIso(msg.timestamp);
        if (!ts) continue;
        const cost = usage.cost as Record<string, unknown> | undefined;
        const costTotal = num(cost?.total);
        events.push({
          ts,
          source: ID,
          provider: txt(msg.provider) ?? curProvider,
          model: txt(msg.model) ?? curModel,
          sessionId,
          project,
          inputTokens: num(usage.input),
          outputTokens: num(usage.output),
          cacheReadTokens: num(usage.cacheRead),
          cacheWriteTokens: num(usage.cacheWrite),
          reasoningTokens: null,
          costUsd: costTotal,
          costSource: costTotal !== null ? "reported" : "unknown",
          estimated: false,
          partial: false,
          rawRef: txt(o.id) ?? `${basename(file)}:${line.start}`,
          fileOffset: line.end,
        });
      }
    }
    if (sensitive > 0) notes.push(`${sensitive} sensitive lines skipped unread`);
    if (unparsed > 0) notes.push(`${unparsed} unparseable lines skipped`);
    return { events, offsets, filesScanned, filesSkipped, notes };
  },
};
