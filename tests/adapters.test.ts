import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const fable = out.events.find((e) => e.rawRef === "msg_1:req_1")!;
    expect(fable.inputTokens).toBe(10);
    expect(fable.outputTokens).toBe(60);
    expect(fable.cacheReadTokens).toBe(5000);
    expect(fable.cacheWriteTokens).toBe(200);
    expect(fable.reasoningTokens).toBe(40);
    expect(fable.provider).toBe("anthropic");
    expect(fable.sessionId).toBe("sess-1");
    expect(fable.project).toBe("fleet-deck");
    // api_key line skipped unread
    expect(out.events.some((e) => e.rawRef === "aBAD")).toBe(false);
  });

  it("gives every content-block line of one API response the same rawRef", async () => {
    const out = await claudeCodeAdapter.scan(ctx());
    expect(out.events.map((e) => e.rawRef)).toEqual(["msg_1:req_1", "msg_1:req_1", "msg_2:req_2", "a3", "msg_syn:"]);
  });

  it("never opens files under a forbidden path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-cc-"));
    tmpDirs.push(dir);
    const project = join(dir, ".claude", "projects", "-Users-me-secret-santa");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "s.jsonl"),
      '{"type":"assistant","uuid":"x","timestamp":"2026-09-15T10:00:00.000Z","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n',
    );
    const out = await claudeCodeAdapter.scan({ home: dir, getOffset: () => 0, getState: () => null });
    expect(out.filesScanned).toBe(0);
    expect(out.events.length).toBe(0);
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
  it("emits one delta per token_count line with disjoint token columns", async () => {
    const out = await codexAdapter.scan(ctx());
    expect(out.events.length).toBe(2);
    const [first, second] = out.events;
    expect(first!.ts).toBe("2026-09-15T12:05:00.000Z");
    expect(first!.inputTokens).toBe(900);
    expect(first!.cacheReadTokens).toBe(100);
    expect(first!.outputTokens).toBe(40);
    expect(first!.reasoningTokens).toBe(10);
    expect(second!.ts).toBe("2026-09-16T09:10:00.000Z");
    expect(second!.inputTokens).toBe(1800);
    expect(second!.cacheReadTokens).toBe(200);
    expect(second!.outputTokens).toBe(80);
    expect(second!.reasoningTokens).toBe(20);
    for (const e of out.events) {
      expect(e.estimated).toBe(true);
      expect(e.model).toBe("gpt-5.1-codex");
      expect(e.provider).toBe("openai");
    }
    expect(Object.keys(out.state ?? {})[0]).toMatch(/^codex:cum:/);
  });

  it("emits nothing when offsets and cumulative state are stored", async () => {
    const first = await codexAdapter.scan(ctx());
    const again = await codexAdapter.scan({
      home: HOME,
      getOffset: (p: string) => first.offsets[p] ?? 0,
      getState: (k: string) => first.state?.[k] ?? null,
    });
    expect(again.events.length).toBe(0);
  });

  it("marks events from a ChatGPT Pro or Plus plan as subscription billing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-codex-"));
    tmpDirs.push(dir);
    const sessions = join(dir, ".codex", "sessions", "2026", "09", "15");
    mkdirSync(sessions, { recursive: true });
    const line = (ts: string, input: number, plan: string | null) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: input, output_tokens: 1 } },
          rate_limits: plan === null ? null : { limit_id: "codex", plan_type: plan },
        },
      }) + "\n";
    writeFileSync(join(sessions, "rollout-pro.jsonl"),
      line("2026-09-15T12:01:00.000Z", 100, "pro") + line("2026-09-15T12:02:00.000Z", 200, null));
    writeFileSync(join(sessions, "rollout-plus.jsonl"), line("2026-09-15T12:03:00.000Z", 100, "plus"));
    writeFileSync(join(sessions, "rollout-api.jsonl"), line("2026-09-15T12:04:00.000Z", 100, null));
    const out = await codexAdapter.scan({ home: dir, getOffset: () => 0, getState: () => null });
    const billing = Object.fromEntries(
      out.events.map((e) => [`${e.sessionId}@${e.ts.slice(11, 16)}`, e.billing]),
    );
    expect(billing).toEqual({
      "rollout-api@12:04": null,
      "rollout-plus@12:03": "subscription",
      "rollout-pro@12:01": "subscription",
      // a later line with rate_limits null keeps the plan the rollout proved
      "rollout-pro@12:02": "subscription",
    });
    const pro = Object.entries(out.state ?? {}).find(([k]) => k.endsWith("rollout-pro.jsonl"))!;
    expect(JSON.parse(pro[1]).plan).toBe("pro");
  });

  it("counts a counter that restarts from a lower value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-codex-"));
    tmpDirs.push(dir);
    const sessions = join(dir, ".codex", "sessions", "2026", "09", "15");
    mkdirSync(sessions, { recursive: true });
    const line = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
      }) + "\n";
    writeFileSync(
      join(sessions, "rollout-reset.jsonl"),
      line("2026-09-15T12:01:00.000Z", 5000, 50) + line("2026-09-15T12:02:00.000Z", 300, 3),
    );
    const out = await codexAdapter.scan({ home: dir, getOffset: () => 0, getState: () => null });
    expect(out.events.map((e) => [e.inputTokens, e.outputTokens])).toEqual([[5000, 50], [300, 3]]);
  });

  it("keeps the model on a later scan that starts mid-turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-codex-"));
    tmpDirs.push(dir);
    const sessions = join(dir, ".codex", "sessions", "2026", "09", "15");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "rollout-live.jsonl");
    const tokenLine = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
      }) + "\n";
    writeFileSync(
      file,
      JSON.stringify({ type: "turn_context", timestamp: "2026-09-15T12:00:00.000Z", payload: { model: "gpt-5.1-codex" } }) +
        "\n" +
        tokenLine("2026-09-15T12:01:00.000Z", 100, 10),
    );
    const offsets: Record<string, number> = {};
    const stored: Record<string, string> = {};
    const scanCtx = {
      home: dir,
      getOffset: (p: string) => offsets[p] ?? 0,
      getState: (k: string) => stored[k] ?? null,
    };
    const first = await codexAdapter.scan(scanCtx);
    Object.assign(offsets, first.offsets);
    Object.assign(stored, first.state);
    appendFileSync(file, tokenLine("2026-09-15T12:02:00.000Z", 300, 30));
    const second = await codexAdapter.scan(scanCtx);
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.model).toBe("gpt-5.1-codex");
    expect(second.events[0]!.inputTokens).toBe(200);
    expect(second.events[0]!.outputTokens).toBe(20);
  });
});

describe("no_mistakes", () => {
  it("reads agent_invocations incrementally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetdeck-nm-"));
    tmpDirs.push(dir);
    const home = join(dir, "home");
    const nm = join(home, ".no-mistakes");
    mkdirSync(nm, { recursive: true });
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
    mkdirSync(cur, { recursive: true });
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
