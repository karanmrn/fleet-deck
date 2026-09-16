// The skill installer (`npx skills add karanmrn/fleet-deck`) reads
// skills/<name>/SKILL.md, so that file owns the agent skill. The root
// SKILL.md is only a pointer. This test keeps the pointer honest and keeps
// the owner's JSON field list in step with the real export payload.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";
import { buildPayload } from "../src/export.js";

const OWNER = "skills/fleet-deck/SKILL.md";
const owner = readFileSync(OWNER, "utf8");
const pointer = readFileSync("SKILL.md", "utf8");
const tmpDirs: string[] = [];

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

/** Backticked field names listed in one "- `section`" bullet of the JSON payload shape. */
function documentedFields(section: string): Set<string> {
  const line = owner.split("\n").find((l) => l.startsWith(`- \`${section}\``));
  expect(line, `${OWNER} documents ${section}`).toBeTruthy();
  // The field list is the first sentence after the dash; later prose is not.
  const list = /^- `[^`]+` - (.*?)\.(?:\s|$)/.exec(line!)![1]!;
  return new Set([...list.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]!));
}

const TOKEN_COLUMNS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"];

describe("agent skill", () => {
  it("root SKILL.md is a pointer to the owner, not a second copy", () => {
    expect(pointer.split("\n").filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(3);
    expect(pointer).toContain(`(${OWNER})`);
    expect(pointer.startsWith("---")).toBe(false);
    expect(owner).toMatch(/^---\nname: fleet-deck\n/);
  });

  it("documents exactly the fields the JSON export carries", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-skill-"));
    tmpDirs.push(dir);
    const ledger = new Ledger(join(dir, "ledger.db"));
    try {
      ledger.insertEvents([{
        ts: new Date().toISOString(), source: "claude_code", provider: "anthropic",
        model: "claude-fable-5-1", sessionId: "s", project: "p",
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1,
        costUsd: 1, costSource: "price_list", listPriceEquivalentUsd: null, billing: null,
        estimated: false, partial: false, rawRef: "r", fileOffset: null,
      }]);
      const payload = buildPayload(ledger);
      const sections: Record<string, object> = {
        totals: payload.totals,
        "models[]": payload.models[0]!,
        "days[]": payload.days[0]!,
        "dayModel[]": payload.dayModel[0]!,
        "sources[]": payload.sources[0]!,
        energy: payload.energy,
      };
      for (const [section, sample] of Object.entries(sections)) {
        const actual = new Set(Object.keys(sample));
        // "the five token columns" stands in for the token keys in some rows.
        if (owner.split("\n").find((l) => l.startsWith(`- \`${section}\``))!.includes("the five token columns")) {
          for (const c of TOKEN_COLUMNS) actual.delete(c);
        }
        expect([...documentedFields(section)].sort(), `${OWNER} ${section} fields`).toEqual([...actual].sort());
      }
    } finally {
      ledger.close();
    }
  });
});
