# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Price table and billing

- `prices.json` model ids must be the exact strings the local logs carry (dashed Anthropic ids like `claude-opus-4-8`, vendor-prefixed Nebius/OpenRouter ids like `openai/gpt-5.6-luna`). `tests/price-coverage.test.ts` fails loudly when a bundled fixture id has no price; new unknown ids go there only with a reason, or get a priced entry.
- Billing mode resolves as: machine override in `~/.fleet-deck/config.json`, then log evidence on the event (`UsageEvent.billing`, e.g. a Codex ChatGPT plan), then `usage`. `prices.json` holds prices only; a model with no first-party token price is either `subscription_only` (with a `note`) or stays unknown - never a third-party rate. Subscription-billed costs are exported as `listPriceEquivalentUsd`, never `costUsd`. User docs: README "Billing mode".
- A `scan` re-prices existing ledger rows (`cost_source` `unknown`/`price_list`/`subscription`) against the current table, so price edits and billing flips need no ledger rebuild; reported costs are never touched.
- Commands: `npm test`, `npm run build`, `node dist/cli.js scan && node dist/cli.js export --json`.
