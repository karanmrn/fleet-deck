// Electricity estimate with an explicit order-of-magnitude band.
// Method: kWh = (tokens / 1e6) x intensity(model_class) x PUE(1.2).
// Intensities follow published per-token estimates: small ~0.05, mid ~0.3,
// frontier ~1.0 kWh per million tokens. Band: x5 in both directions -
// the literature spans roughly an order of magnitude, so every figure is
// shown as a range. Sources: Epoch AI per-query energy analysis (Feb 2025)
// and Luccioni et al. per-token inference measurements.
// This is a conversation piece, not a meter reading.

export const ENERGY_METHOD =
  "kWh = tokens/1M x intensity x PUE 1.2; intensity 0.05/0.3/1.0 kWh per M tokens (small/mid/frontier), after Epoch AI (Feb 2025) and Luccioni et al. Figures carry a ~5x uncertainty band both ways.";

export const ENERGY_BAND_FACTOR = 5;

export type ModelClass = "small" | "mid" | "frontier";

const INTENSITY_KWH_PER_MTOK: Record<ModelClass, number> = {
  small: 0.05,
  mid: 0.3,
  frontier: 1.0,
};

const PUE = 1.2;

const FRONTIER_RE = /opus|fable|gpt-5|grok-4|o3|405b|kimi-k2/i;
const SMALL_RE = /haiku|mini|flash|small|8b|3b|lite/i;

export function classifyModel(model: string | null): ModelClass {
  const m = (model ?? "").toLowerCase();
  if (!m) return "mid";
  if (FRONTIER_RE.test(m)) return "frontier";
  if (SMALL_RE.test(m)) return "small";
  return "mid";
}

export interface EnergyEstimate {
  kwh: number;
  low: number;
  high: number;
  modelClass: ModelClass;
  tokens: number;
}

export function estimateEnergyKwh(tokens: number, modelClass: ModelClass): EnergyEstimate {
  const kwh = (tokens / 1e6) * INTENSITY_KWH_PER_MTOK[modelClass] * PUE;
  return {
    kwh: Math.round(kwh * 1000) / 1000,
    low: Math.round((kwh / ENERGY_BAND_FACTOR) * 1000) / 1000,
    high: Math.round(kwh * ENERGY_BAND_FACTOR * 1000) / 1000,
    modelClass,
    tokens,
  };
}

/** Total tokens on an event-like row, null-safe. */
export function eventTokens(e: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}): number {
  return (
    (e.inputTokens ?? 0) +
    (e.outputTokens ?? 0) +
    (e.cacheReadTokens ?? 0) +
    (e.cacheWriteTokens ?? 0) +
    (e.reasoningTokens ?? 0)
  );
}
