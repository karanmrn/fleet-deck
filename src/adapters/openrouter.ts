// OpenRouter adapter (OPTIONAL, OFF BY DEFAULT).
// The only adapter that touches the network. It activates ONLY when the user
// explicitly opts in: FLEET_DECK_OPENROUTER=1 plus a management key in
// FLEET_DECK_OPENROUTER_KEY, set at run time. No key - no requests, ever.
// Pulls /api/v1/activity (last 30 completed UTC days) and reconciles
// provider-side spend into the ledger as source=openrouter_api rows.

import type { Adapter, ScanOutcome, SourceStatus, UsageEvent } from "../types.js";
import { num, txt } from "../util.js";

const ID = "openrouter_api";
const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";

function isEnabled(): boolean {
  return (
    process.env.FLEET_DECK_OPENROUTER === "1" &&
    Boolean(process.env.FLEET_DECK_OPENROUTER_KEY)
  );
}

export const openrouterAdapter: Adapter = {
  id: ID,
  label: "OpenRouter API",
  trust: "optional",

  async detect(_home): Promise<SourceStatus> {
    if (!isEnabled()) {
      return {
        id: ID,
        label: "OpenRouter API",
        trust: "optional",
        found: false,
        detail: "disabled - set FLEET_DECK_OPENROUTER=1 and FLEET_DECK_OPENROUTER_KEY to opt in",
      };
    }
    return {
      id: ID,
      label: "OpenRouter API",
      trust: "optional",
      found: true,
      detail: "enabled via env - will query OpenRouter /activity",
    };
  },

  async scan(_ctx): Promise<ScanOutcome> {
    const events: UsageEvent[] = [];
    const notes: string[] = [];
    const key = process.env.FLEET_DECK_OPENROUTER_KEY as string;

    let res: Response;
    try {
      res = await fetch(ACTIVITY_URL, {
        headers: { Authorization: `Bearer ${key}` },
      });
    } catch (err) {
      notes.push(`network error: ${String(err)}`);
      return { events, offsets: {}, filesScanned: 0, filesSkipped: 0, notes };
    }

    if (!res.ok) {
      notes.push(`OpenRouter API returned ${res.status} - check the management key`);
      return { events, offsets: {}, filesScanned: 0, filesSkipped: 0, notes };
    }

    const payload = (await res.json()) as { data?: Record<string, unknown>[] };
    const rows = payload.data ?? [];

    for (const row of rows) {
      const date = txt(row.date);
      const model = txt(row.model);
      if (!date || !model) continue;
      const provider = txt(row.provider_name);
      const usage = num(row.usage);
      const completion = num(row.completion_tokens);
      const reasoning = num(row.reasoning_tokens);
      events.push({
        ts: `${date}T00:00:00.000Z`,
        source: ID,
        provider: provider ?? "openrouter",
        model,
        sessionId: null,
        project: null,
        inputTokens: num(row.prompt_tokens),
        outputTokens: completion !== null && reasoning !== null ? Math.max(0, completion - reasoning) : completion,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: reasoning,
        costUsd: usage,
        costSource: usage !== null ? "api" : "unknown",
        listPriceEquivalentUsd: null,
        estimated: false,
        partial: false,
        rawRef: `openrouter:${date}:${model}:${provider ?? "unknown"}`,
        fileOffset: null,
      });
    }
    notes.push(`${rows.length} daily activity rows pulled (30-day window)`);
    return { events, offsets: {}, filesScanned: 0, filesSkipped: 0, notes };
  },
};
