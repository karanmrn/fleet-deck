# fleet-deck

**Local ledger and dashboard of every AI agent, model, token and cost on your machine.**

`npx fleet-deck` scans the agent logs already sitting on your disk, normalises them into one local SQLite ledger, and opens a dashboard on localhost with charts of models, tokens per day, cost, sessions, provider quota windows and an electricity estimate.

Everything stays on your machine. Zero telemetry. The only feature that touches the network is the optional OpenRouter adapter — and it is off unless you explicitly enable it.

## Install & run

```sh
npx fleet-deck
```

That's it: it scans your local agent logs, then opens the dashboard at http://localhost:4173.

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; on 22.5–22.12 run with `node --experimental-sqlite`). No native dependencies, no database server, no sign-up.

## Commands

```
fleet-deck                scan, then open the dashboard
fleet-deck scan           scan local agent logs into the ledger
fleet-deck serve          open the dashboard (default http://localhost:4173)
fleet-deck export --json  print the ledger as JSON (for scripts/agents)
fleet-deck export --toon  print the ledger as TOON (quota-axi house shape)
fleet-deck quota          show provider quota windows (via quota-axi, if installed)
fleet-deck doctor         show which data sources were found on this machine
```

Options: `--port N` (dashboard port, default 4173), `--db PATH` (ledger location, default `~/.fleet-deck/ledger.db`).

## Data sources

| Source | Path scanned | Trust | What you get |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**.jsonl` | high | tokens (incl. cache + thinking), model, session, project |
| Prime | `~/.prime/agent/sessions/*.jsonl` | high | tokens + logged USD cost |
| no-mistakes | `~/.no-mistakes/state.sqlite` | high | tokens, model, run ids (rowid-incremental) |
| gnhf loops | `~/.treehouse/**/.gnhf/runs/*/gnhf.log` | best-effort | token counts, flagged *estimated* by the source |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | best-effort | deltas from cumulative token counters, estimated |
| Cursor | `~/.cursor/ai-tracking/ai-code-tracking.db` | best-effort | activity + model only — no tokens (marked `partial`) |
| OpenRouter API | network | optional, **off by default** | provider-side spend for the last 30 days |

The dashboard labels every figure with its trust level; `estimated` and `partial` rows are flagged in tables and never silently mixed into exact numbers.

### Optional: OpenRouter reconciliation

Off by default. To enable:

```sh
export FLEET_DECK_OPENROUTER=1
export FLEET_DECK_OPENROUTER_KEY=sk-or-...   # management key
fleet-deck scan
```

This is the only adapter that makes network requests, and only when explicitly enabled.

## Billing mode: usage vs subscription

By default every provider in `prices.json` is billed per token (`usage`): the cost column is what you would pay at list price. If you pay a provider by **subscription** — for example an Anthropic plan that includes Claude usage — those tokens cost you nothing marginal, and showing list prices as "cost" would be misleading.

fleet-deck never assumes a subscription. Declare it per provider in `~/.fleet-deck/config.json`:

```json
{
  "billing": {
    "anthropic": "subscription"
  }
}
```

Values are `"usage"` (default) or `"subscription"`. With a provider set to `subscription`:

- price-table costs for that provider are computed the same way, but exported and shown as **`listPriceEquivalentUsd`** — "what these tokens would have cost at list price" — never as cost;
- the dashboard shows them on a card labeled **"List-price equivalent"**, separate from the cost card;
- totals keep the two apart: `costUsd` sums only usage-billed and provider-reported spend, `listPriceEquivalentUsd` sums the equivalents;
- a `scan` re-prices existing ledger rows, so flipping a provider's mode or refreshing `prices.json` takes effect without rebuilding the ledger.

Remove the entry (or the file) to go back to usage billing for that provider.

## Dashboard

`fleet-deck serve` (or just `fleet-deck`) serves a server-rendered page on `http://localhost:4173` (localhost only, nothing leaves the machine):

- **Overview** — totals: tokens, cost, sessions, events, models, sources (+ a "List-price equivalent" card when a provider is billed by subscription)
- **Models in use** — per-model tokens/cost/sessions, with `estimated` / `partial` / `cost?` / `list-price` flags (a `list-price` row shows its list-price equivalent in the cost column)
- **Tokens per day** — stacked uPlot chart by model
- **Cost per day** — USD per day of usage-billed spend (unknown and subscription-only days are gaps, not zeros)
- **Sessions per day**
- **Provider quota windows** — live output of `quota-axi` if installed
- **Electricity** — kWh estimate with an explicit ±5× order-of-magnitude band and method note

Charts use [uPlot](https://github.com/leeoniya/uPlot), served from the local `node_modules` — the page makes zero requests to the outside internet.

## Export for agents

```sh
fleet-deck export --json   # machine-readable JSON
fleet-deck export --toon   # compact TOON, same shape quota-axi emits
```

Agents: see [SKILL.md](SKILL.md) for how to read the payload and its rules (unknown ≠ zero, estimated/partial flags, electricity as a range).

## Privacy

- Everything is read-only and local. The ledger lives at `~/.fleet-deck/ledger.db`.
- Redaction is hard-wired: files named `.env`/`keys.env`/`*secret*`/`*credential*` are never opened; lines containing `api_key`, `Authorization`, `Bearer` or `sk-` are skipped unread; only numerics, model/provider, timestamps, project folder name and file offsets are stored. Never message content.
- Zero telemetry. The only network call in the whole program is the optional OpenRouter adapter, off unless `FLEET_DECK_OPENROUTER=1` + key are set.

## Requirements

- Node.js ≥ 22.13 (`node:sqlite`; on 22.5–22.12: `node --experimental-sqlite`)
- Optional: [quota-axi](https://github.com/karanmrn/quota-axi) on PATH for the quota windows panel

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent-facing docs: [SKILL.md](SKILL.md).

## License

MIT — see [LICENSE](LICENSE).
