// Shared contracts for the fleet-deck ledger, adapters and exporters.

export type CostSource = "reported" | "price_list" | "api" | "unknown";

export type TrustLevel = "high" | "best-effort" | "optional";

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
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** null means unknown - never silently zero. */
  costUsd: number | null;
  costSource: CostSource;
  /** true when the source itself flags numbers as estimates (e.g. gnhf). */
  estimated: boolean;
  /** true when the source only yields model/activity, no tokens (cursor). */
  partial: boolean;
  /** Stable locator inside the source (uuid, rowid, path:offset) - never content. */
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
