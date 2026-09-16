import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { primeAdapter } from "../src/adapters/prime.js";
import { gnhfAdapter } from "../src/adapters/gnhf.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { noMistakesAdapter } from "../src/adapters/no-mistakes.js";
import { cursorAdapter } from "../src/adapters/cursor.js";

const HOME = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "home");
const tmpDirs: string[] = [];

function ctx(stateMap: Record<string, string> = {}) {
  return { home: HOME, getOffset: () => 0, getState: (k: string) => stateMap[k] ?? null };
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

describe("claude_code", () => {
  it("reads assistant usage, skips sensitive lines", async () => {
    const out = await claudeCodeAdapter.scan(ctx());
    expect(out.events.length).toBe(3);
    const fable = out.events.find((e) => e.rawRef === "a1")!;
    expect(fable.inputTokens).toBe(10);
    expect(fable.outputTokens).toBe(100);
    expect(fable.cacheReadTokens).toBe(5000);
    expect(fable.cacheWriteTokens).toBe(200);
    expect(fable.reasoningTokens).toBe(40);
    expect(fable.provider).toBe("anthropic");
    expect(fable.sessionId).toBe("sess-1");
    expect(fable.project).toBe("fleet-deck");
    // api_key line skipped unread
    expect(out.events.some((e) => e.rawRef === "aBAD")).toBe(false);
  });
});

describe("prime", () => {
  it("keeps reported cost in USD", async () => {
    const out = await primeAdapter.scan(ctx());
    expect(out.events.length).toBe(2);
    const m1 = out.events[0]!;
    expect(m1.inputTokens).toBe(1000);
    expect(m1.outputTokens).toBe(200);
    expect(m1.cacheReadTokens).toBe(500);
    expect(m1.costUsd).toBeCloseTo(0.0016, 6);
    expect(m1.costSource).toBe("reported");
    expect(m1.provider).toBe("openrouter");
    expect(m1.model).toBe("moonshotai/kimi-k2.6");
    expect(m1.sessionId).toBe("prime-sess-1");
    expect(m1.project).toBe("some-project");
  });
});

describe("gnhf", () => {
  it("marks source-flagged estimates", async () => {
    const out = await gnhfAdapter.scan(ctx());
    expect(out.events.length).toBe(2);
    for (const e of out.events) {
      expect(e.estimated).toBe(true);
      expect(e.sessionId).toMatch(/^run-9#\d+$/);
    }
    const inputs = out.events.map((e) => e.inputTokens).sort();
    expect(inputs).toEqual([5000, 7000]);
  });
});

describe("codex", () => {
  it("derives deltas from cumulative counters", async () => {
    const out = await codexAdapter.scan(ctx());
    expect(out.events.length).toBe(1);
    const e = out.events[0]!;
    expect(e.inputTokens).toBe(3000);
    expect(e.cacheReadTokens).toBe(300);
    expect(e.outputTokens).toBe(150);
    expect(e.reasoningTokens).toBe(30);
    expect(e.estimated).toBe(true);
    expect(e.model).toBe("gpt-5.1-codex");
    expect(e.provider).toBe("openai");
    expect(Object.keys(out.state ?? {})[0]).toMatch(/^codex:cum:/);
  });

  it("emits nothing when cumulative state is stored", async () => {
    const first = await codexAdapter.scan(ctx());
    const stateKey = Object.keys(first.state ?? {})[0]!;
    const again = await codexAdapter.scan(ctx({ [stateKey]: first.state![stateKey]! }));
    expect(again.events.length).toBe(0);
  });
});

describe("no_mistakes", () => {
  it("reads agent_invocations incrementally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-nm-"));
    tmpDirs.push(dir);
    const home = join(dir, "home");
    const nm = join(home, ".no-mistakes");
    (await import("node:fs")).mkdirSync(nm, { recursive: true });
    const db = new DatabaseSync(join(nm, "state.sqlite"));
    db.exec(`CREATE TABLE agent_invocations (
      run_id TEXT, model_provider TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
      started_at TEXT, completed_at TEXT
    )`);
    db.exec(`INSERT INTO agent_invocations VALUES
      ('run-1','anthropic','claude-fable-5-1',1000,200,0,0,NULL,'2026-09-15T10:00:00','2026-09-15T10:05:00'),
      ('run-2','openai','gpt-5.1',500,100,50,0,10,'2026-09-15T11:00:00','2026-09-15T11:03:00')`);
    db.close();
    const c = { home, getOffset: () => 0, getState: () => null };
    const out = await noMistakesAdapter.scan(c);
    expect(out.events.length).toBe(2);
    expect(out.events[0]!.provider).toBe("anthropic");
    expect(out.events[1]!.reasoningTokens).toBe(10);
    expect(out.state?.["no_mistakes:last_rowid"]).toBe("2");
    // second scan with stored rowid -> nothing new
    const again = await noMistakesAdapter.scan({ ...c, getState: () => "2" });
    expect(again.events.length).toBe(0);
  });
});

describe("cursor", () => {
  it("records activity only, partial=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-cur-"));
    tmpDirs.push(dir);
    const home = join(dir, "home");
    const cur = join(home, ".cursor", "ai-tracking");
    (await import("node:fs")).mkdirSync(cur, { recursive: true });
    const db = new DatabaseSync(join(cur, "ai-code-tracking.db"));
    db.exec(`CREATE TABLE ai_code_hashes (model TEXT, conversationId TEXT, timestamp TEXT)`);
    db.exec(`INSERT INTO ai_code_hashes VALUES ('gpt-4o','conv-1','2026-09-15T12:00:00'),('gpt-4o','conv-2','2026-09-15T13:00:00')`);
    db.close();
    const out = await cursorAdapter.scan({ home, getOffset: () => 0, getState: () => null });
    expect(out.events.length).toBe(2);
    for (const e of out.events) {
      expect(e.partial).toBe(true);
      expect(e.inputTokens).toBeNull();
    }
  });
});
