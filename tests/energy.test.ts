import { describe, expect, it } from "vitest";
import { classifyModel, estimateEnergyKwh, ENERGY_BAND_FACTOR } from "../src/energy.js";

describe("energy", () => {
  it("classifies models into intensity classes", () => {
    expect(classifyModel("claude-opus-4.8")).toBe("frontier");
    expect(classifyModel("claude-fable-5-1")).toBe("frontier");
    expect(classifyModel("gpt-5.1-codex")).toBe("frontier");
    expect(classifyModel("claude-haiku-4.5")).toBe("small");
    expect(classifyModel("gpt-4o-mini")).toBe("small");
    expect(classifyModel("claude-sonnet-4-8")).toBe("mid");
    expect(classifyModel(null)).toBe("mid");
    expect(classifyModel("gpt-6-astra")).toBe("frontier");
    expect(classifyModel("gpt-5.6-terra")).toBe("frontier");
    expect(classifyModel("moonshotai/Kimi-K3")).toBe("frontier");
    expect(classifyModel("zai-org/GLM-5.3")).toBe("frontier");
    expect(classifyModel("deepseek-ai/DeepSeek-V4-Flash-0731")).toBe("small");
  });

  it("estimates kWh with the documented band", () => {
    const mid = estimateEnergyKwh(1_000_000, "mid");
    expect(mid.kwh).toBeCloseTo(0.3 * 1.2, 6);
    expect(mid.low).toBeCloseTo((0.3 * 1.2) / ENERGY_BAND_FACTOR, 6);
    expect(mid.high).toBeCloseTo(0.3 * 1.2 * ENERGY_BAND_FACTOR, 6);
    expect(estimateEnergyKwh(1_000_000, "small").kwh).toBeCloseTo(0.05 * 1.2, 6);
    expect(estimateEnergyKwh(1_000_000, "frontier").kwh).toBeCloseTo(1.0 * 1.2, 6);
  });
});
