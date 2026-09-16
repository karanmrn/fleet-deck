---
name: fleet-deck
description: Read the user's local fleet-deck ledger of AI usage on this machine (agents, models, tokens, cost, sessions, electricity estimate). Use when the user asks which agents or models they run, how many tokens they used, what their AI usage costs, how usage trends over time, or how much electricity it uses.
---

# fleet-deck

fleet-deck keeps a local SQLite ledger of AI agent usage on this machine: models, tokens, cost, sessions, and an electricity estimate. It reads local agent logs (Claude Code, Codex CLI, Prime, no-mistakes, gnhf, Cursor) and, only when the user opts in, the OpenRouter activity API. It exports the ledger as JSON or TOON so that you (the agent) can read it.

## When to use this skill

- The user asks which agents or models they use, how many tokens they used, or what it costs.
- The user asks how their AI usage changes per day.
- The user asks about the electricity use of their AI usage.

## How to read the ledger

```bash
npx fleet-deck scan            # refresh the ledger from local logs
npx fleet-deck export --toon   # TOON (compact, preferred)
npx fleet-deck export --json   # JSON
```

Run from any directory. If `totals.events` is 0, run `npx fleet-deck scan` first. Add `--db PATH` to use a ledger that is not at `~/.fleet-deck/ledger.db`.

## JSON payload shape

- `generatedAt` - ISO 8601 time of the export.
- `totals` - `events`, `sessions`, `models`, `providers`, `sources`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, `costUsd`, `estimatedEvents`, `partialEvents`. `costUsd` is the sum of known costs only, or `null` when no event has a known cost.
- `models[]` - one row per provider and model: `provider`, `model`, `events`, `sessions`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `cost_usd`, `unknown_cost_events`, `any_estimated`, `any_partial`.
- `days[]` - last 30 days: `day`, `events`, `sessions`, the five token columns, `cost_usd`.
- `dayModel[]` - one row per day, provider, model and source: `day`, `provider`, `model`, `source`, `events`, `sessions`, the five token columns, `cost_usd`, `any_estimated`, `any_partial`.
- `sources[]` - one row per source: `source`, `events`, `sessions`, `models`, the five token columns, `cost_usd`, `any_estimated`, `any_partial`, `first_ts`, `last_ts`.
- `energy` - `kwh`, `low`, `high`, `tokens`, `method`.

The five token columns do not overlap. Total tokens = input + output + cache read + cache write + reasoning.

## TOON payload shape

Tables `totals`, `models`, `days`, `sources` and `energy` carry the same data in camelCase with a `totalTokens` column. In `models`, `flags` joins `estimated`, `partial` and `cost_unknown` with `+`, or is `-`. A cost of `unknown` is not zero.

## Reading rules

1. A `null` cost (`cost_usd`, `costUsd`) or `unknown` means the cost is not known. It is not zero. Say "unknown".
2. When `unknown_cost_events` is above 0, the cost of that row is a lower bound. Say so.
3. `any_estimated` or the `estimated` flag means that the source gives estimated token counts (gnhf runs, Codex cumulative counters). Say "estimated".
4. `any_partial` or the `partial` flag means that the source logs activity but no tokens (Cursor). Do not use it for token or cost numbers.
5. Always give electricity as a range: "between `low` and `high` kWh". Do not give `kwh` alone.
6. The ledger holds only numbers, model and provider names, timestamps, project folder names and file offsets. It holds no message content. Do not ask for message content.

## Common answers

- Cost: sort `models[]` by `cost_usd` and name each row that has `unknown_cost_events`.
- Trend: use `days[]` token totals and `sessions`.
- Agents in use: use `sources[]` with `first_ts` and `last_ts`.
