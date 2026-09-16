// gnhf adapter: ~/.treehouse/<pool>/<n>/<proj>/.gnhf/runs/<run>/gnhf.log
// JSONL event log; agent:run:end events carry token counts that gnhf itself
// flags as estimated - that flag is preserved end to end.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, toIso, txt, walkFiles } from "../util.js";
import { readJsonlFromOffset } from "./jsonl.js";

const ID = "gnhf";

function listLogs(home: string): string[] {
  const base = join(home, ".treehouse");
  if (!existsSync(base)) return [];
  const files: string[] = [];
  for (const p of walkFiles(base, 6, (f) => f.endsWith("gnhf.log"))) {
    if (p.includes("/.gnhf/runs/")) files.push(p);
  }
  return files.sort();
}

export const gnhfAdapter: Adapter = {
  id: ID,
  label: "gnhf loops",
  trust: "best-effort",

  async detect(home): Promise<SourceStatus> {
    const files = listLogs(home);
    return {
      id: ID,
      label: "gnhf loops",
      trust: "best-effort",
      found: files.length > 0,
      detail: files.length > 0 ? `${files.length} gnhf.log files` : "no .gnhf/runs logs found",
    };
  },

  async scan(ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const offsets: Record<string, number> = {};
    const notes: string[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let sensitive = 0;

    for (const file of listLogs(ctx.home)) {
      let scan;
      try {
        scan = readJsonlFromOffset(file, ctx.getOffset(file));
      } catch {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      sensitive += scan.skippedSensitive;
      if (scan.truncated) notes.push(`${basename(file)} shrank - restarted from 0`);
      offsets[file] = scan.nextOffset;
      const runId = basename(dirname(file));

      for (const line of scan.lines) {
        const o = line.obj;
        if (txt(o.event) !== "agent:run:end") continue;
        const ts = toIso(o.timestamp);
        if (!ts) continue;
        const iteration = num(o.iteration);
        events.push({
          ts,
          source: ID,
          provider: txt(o.provider),
          model: txt(o.model),
          sessionId: iteration !== null ? `${runId}#${iteration}` : runId,
          project: null,
          inputTokens: num(o.inputTokens),
          outputTokens: num(o.outputTokens),
          cacheReadTokens: num(o.cacheReadTokens),
          cacheWriteTokens: num(o.cacheCreationTokens),
          reasoningTokens: null,
          costUsd: null,
          costSource: "unknown",
          listPriceEquivalentUsd: null,
          billing: null,
          estimated: o.estimated === true,
          partial: false,
          rawRef: `${basename(file)}:${line.start}`,
          fileOffset: line.end,
        });
      }
    }
    if (sensitive > 0) notes.push(`${sensitive} sensitive lines skipped unread`);
    return { events, offsets, filesScanned, filesSkipped, notes };
  },
};
