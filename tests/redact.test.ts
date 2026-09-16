import { describe, expect, it } from "vitest";
import { projectFolderName, shouldSkipFile, shouldSkipLine } from "../src/redact.js";

describe("redact", () => {
  it("never opens forbidden files", () => {
    expect(shouldSkipFile("/home/u/.env")).toBe(true);
    expect(shouldSkipFile("/home/u/keys.env")).toBe(true);
    expect(shouldSkipFile("/x/app-secret.json")).toBe(true);
    expect(shouldSkipFile("/x/credentials.txt")).toBe(true);
    expect(shouldSkipFile("/u/.claude/projects/p/s.jsonl")).toBe(false);
    expect(shouldSkipFile("/u/.gnhf/runs/run-1/gnhf.log")).toBe(false);
  });

  it("skips sensitive lines unread", () => {
    expect(shouldSkipLine('{"api_key":"abc"}')).toBe(true);
    expect(shouldSkipLine("Authorization: Bearer xyz")).toBe(true);
    expect(shouldSkipLine("token sk-abc123")).toBe(true);
    expect(shouldSkipLine('{"type":"assistant","usage":{"input_tokens":5}}')).toBe(false);
  });

  it("stores only the project folder name", () => {
    expect(projectFolderName("/Users/k/projects/fleet-deck")).toBe("fleet-deck");
    expect(projectFolderName("C:\\Users\\t\\proj")).toBe("proj");
    expect(projectFolderName(null)).toBe(null);
    expect(projectFolderName("")).toBe(null);
  });
});
