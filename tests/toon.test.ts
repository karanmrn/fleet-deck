import { describe, expect, it } from "vitest";
import { toToon } from "../src/toon.js";

describe("toon", () => {
  it("emits the quota-axi house shape", () => {
    const out = toToon([
      { name: "models", fields: ["provider", "tokens"], rows: [["anthropic", 100], ["openai", 200]] },
    ]);
    expect(out).toBe("models[2]{provider,tokens}:\n  anthropic,100\n  openai,200");
  });

  it("quotes values with commas, spaces and quotes", () => {
    const out = toToon([
      { name: "t", fields: ["v"], rows: [["with, comma"], ['say "hi"'], ["plain"]] },
    ]);
    const rows = out.split("\n").slice(1);
    expect(rows[0]).toBe('  "with, comma"');
    expect(rows[1]).toBe('  "say ""hi"""');
    expect(rows[2]).toBe("  plain");
  });

  it("supports field-less tables", () => {
    const out = toToon([{ name: "note", fields: [], rows: [["hello"]] }]);
    expect(out).toBe("note[1]:\n  hello");
  });
});
