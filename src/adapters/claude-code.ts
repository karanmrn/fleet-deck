// Claude Code adapter: ~/.claude/projects/<project-slug>/*.jsonl
// Assistant entries carry message.model and message.usage. Cache tokens
// dominate - stored in their own columns, never folded into input.
// Thinking tokens are part of output_tokens and are split out.
// One API response is logged as one line per content block, all with the
// same message.id, requestId and usage, so rawRef uses those ids.
// No logged cost - the price table fills it.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, toIso, txt } from "../util.js";
import { projectFolderName, shouldSkipFile } from "../redact.js";
import { readJsonlFromOffset } from "./jsonl.js";

const ID = "claude_code";

function listFiles(home: string): string[] {
  const base = join(home, ".claude", "projects");
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const slug of readdirSync(base, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const dir = join(base, slug.name);
    try {
      for (const f of readdirSync(dir)) {
        const file = join(dir, f);
        if (f.endsWith(".jsonl") && !shouldSkipFile(file)) out.push(file);
      }
    } catch {
      continue;
    }
  }
  return out.sort();
}

export const claudeCodeAdapter: Adapter = {
  id: ID,
  label: "Claude Code",
  trust: "high",

  async detect(home): Promise<SourceStatus> {
    const files = listFiles(home);
    return {
      id: ID,
      label: "Claude Code",
      trust: "high",
      found: files.length > 0,
      detail: files.length > 0 ? `${files.length} session files under ~/.claude/projects` : "~/.claude/projects not found",
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
      const slug = basename(dirname(file));
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

      for (const line of scan.lines) {
        const o = line.obj;
        if (o.type !== "assistant") continue;
        const msg = o.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const ts = toIso(o.timestamp);
        if (!ts) continue;
        const details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
        const output = num(usage.output_tokens);
        const thinking = num(details.thinking_tokens);
        const messageId = txt(msg?.id);
        const requestId = txt(o.requestId);
        events.push({
          ts,
          source: ID,
          provider: "anthropic",
          model: txt(msg?.model),
          sessionId: txt(o.sessionId) ?? basename(file, ".jsonl"),
          project: projectFolderName(txt(o.cwd)) ?? (slug || null),
          inputTokens: num(usage.input_tokens),
          outputTokens: output !== null && thinking !== null ? Math.max(0, output - thinking) : output,
          cacheReadTokens: num(usage.cache_read_input_tokens),
          cacheWriteTokens: num(usage.cache_creation_input_tokens),
          reasoningTokens: thinking,
          costUsd: null,
          costSource: "unknown",
          listPriceEquivalentUsd: null,
          billing: null,
          estimated: false,
          partial: false,
          rawRef: messageId || requestId
            ? `${messageId ?? ""}:${requestId ?? ""}`
            : txt(o.uuid) ?? `${basename(file)}:${line.start}`,
          fileOffset: line.end,
        });
      }
    }
    if (sensitive > 0) notes.push(`${sensitive} sensitive lines skipped unread`);
    if (unparsed > 0) notes.push(`${unparsed} unparseable lines skipped`);
    return { events, offsets, filesScanned, filesSkipped, notes };
  },
};
