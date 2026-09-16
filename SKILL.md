---
name: fleet-deck
description: Read the athlete's local fleet-deck ledger (agents, models, tokens, cost, sessions, electricity) and use it to coach, plan, and answer questions about their AI usage. Use when the athlete asks what they've been running, what it costs, which models they use, or when you need their recent training/usage context.
---

# fleet-deck

fleet-deck keeps a local SQLite ledger of every AI agent session on this machine: models, tokens, cost, sessions, and an electricity estimate. It exports that ledger as JSON or TOON so you (the agent) can read it and coach from it.

## When to use this skill

- The athlete asks what agents/models they've been running, how much they spent, or how their usage is trending.
- You need their recent AI usage context to plan work or pace quota.
- They ask about electricity / environmental cost of their AI usage.

## How to read the ledger

```bash
npx fleet-deck export --toon   # TOON (compact, preferred)
npx fleet-deck export --json   # JSON
```

Run from any directory. If the ledger is empty, tell the athlete to run `npx fleet-deck scan` first.

## Payload shape

- `generatedAt`, `windowDays` — payload metadata.
- `totals` — events, sessions, models, sources, token splits (input/output/cacheRead/cacheWrite/reasoning), `totalTokens`, `costUsd` (may be `null` = unknown), `estimatedEvents`, `partialEvents`.
- `models[]` — per provider+model rollups: events, sessions, token splits, `costUsd` (may be `null`), flags `any_estimated`, `any_partial`, `unknown_cost_events`.
- `days[]` — last 30 days: events, sessions, token splits, costUsd per day.
- `dayModel[]` — day x model x provider x source rollup (drives the stacked chart).
- `sources[]` — per-source rollups with first/last timestamps.
- `energy` — `kwh`, `low`, `high`, `tokens`, `method`. Always quote as a range: "between low and high kWh". Never present the point estimate alone.

## Reading rules (non-negotiable)

1. `costUsd: null` means **unknown**, never zero. Say "unknown" out loud.
2. `estimated: true` means the source itself flagged the tokens as estimates (gnhf loop runs, codex cumulative deltas). Say "estimated".
3. `partial: true` means the source logs activity but no tokens (Cursor). Never count it in token/cost math.
4. Electricity is always a **range** (low–high). Never quote the point estimate alone.
5. The ledger contains only numerics, model/provider names, timestamps, project folder names and file offsets. There is no message content in it. Do not ask for message content.

## Coaching with the ledger

- Pace: compare `days[]` token totals against the athlete's quota windows (`npx fleet-deck quota` if quota-axi is installed).
- Cost review: `models[]` ranked by cost; call out `cost_unknown` flags rather than guessing.
- Adoption: `sources[]` shows which agents they actually run; `days[]` shows streaks and gaps.
