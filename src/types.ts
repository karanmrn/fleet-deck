// Shared contracts for the fleet-deck ledger, adapters and exporters.

/** "subscription": the model has no token price because the vendor sells it
 *  only inside a subscription (a subscription_only price entry). */
export type CostSource = "reported" | "price_list" | "api" | "subscription" | "unknown";

export type TrustLevel = "high" | "best-effort" | "optional";

/** How a provider is paid on this machine. "usage" prices are real spend;
 *  "subscription" prices are what the same tokens would cost at list price
 *  (a list-price equivalent, not money leaving the account). */
export type BillingMode = "usage" | "subscription";

export interface UsageEvent {
  /** ISO 8601 timestamp of the usage event. */
  ts: string;
  /** Adapter id, e.g. "claude_code". */
  source: string;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  /** Project folder name only - never a full path. */
  project: string | null;
  /** The five token columns must not overlap: when a source counts cached or
   *  reasoning tokens inside input or output, the adapter subtracts them. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** null means unknown - never silently zero. */
  costUsd: number | null;
  costSource: CostSource;
  /** List-price equivalent in USD for subscription-billed providers.
   *  null for usage-billed providers and unknown models. */
  listPriceEquivalentUsd: number | null;
  /** Billing mode the source log itself proves (e.g. a Codex rollout on a
   *  ChatGPT Pro plan). null when the log says nothing; the machine config
   *  override always wins over this evidence. */
  billing: BillingMode | null;
  /** true when the source itself flags numbers as estimates (e.g. gnhf). */
  estimated: boolean;
  /** true when the source only yields model/activity, no tokens (cursor). */
  partial: boolean;
  /** Stable locator inside the source (uuid, rowid, path:offset) - never content.
   *  One rawRef per billed call, so repeated log lines of one call dedupe. */
  rawRef: string;
  /** Byte offset in the source file right after this event, when file-based. */
  fileOffset: number | null;
}

export interface AdapterContext {
  home: string;
  getOffset(path: string): number;
  getState(key: string): string | null;
}

export interface ScanOutcome {
  events: UsageEvent[];
  /** Absolute path -> byte offset consumed. */
  offsets: Record<string, number>;
  /** Non-offset adapter state (e.g. last sqlite rowid). */
  state?: Record<string, string>;
  filesScanned: number;
  filesSkipped: number;
  notes: string[];
}

export interface SourceStatus {
  id: string;
  label: string;
  trust: TrustLevel;
  found: boolean;
  detail: string;
}

export interface Adapter {
  id: string;
  label: string;
  trust: TrustLevel;
  detect(home: string): Promise<SourceStatus>;
  scan(ctx: AdapterContext): Promise<ScanOutcome>;
}

export function buildDedupeKey(source: string, sessionId: string | null, rawRef: string): string {
  return `${source}:${sessionId ?? "nosession"}:${rawRef}`;
}
