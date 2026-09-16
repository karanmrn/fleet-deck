# Contributing to fleet-deck

Thanks for helping. This project scans real homes, so correctness and privacy come before features.

## Ground rules (non-negotiable)

- **Redaction is absolute.** Never read `.env`, `keys.env`, or anything matching `*secret*` / `*credential*`. Skip any line containing `api_key`, `Authorization`, `Bearer`, or `sk-`. Store only numerics, model/provider names, timestamps, project folder names and file offsets — never message content.
- **Unknown cost is `null`, never zero.** A missing price is "unknown", not 0.
- **No network calls** in adapters, except the opt-in OpenRouter adapter (gated on `FLEET_DECK_OPENROUTER=1` + key).
- **Zero telemetry.** Nothing phones home.

## Dev setup

```bash
npm install
npm run build     # tsc -> dist/
npm run lint
npm test          # vitest
node dist/cli.js doctor
```

Requires Node.js >= 22.13 (uses `node:sqlite` unflagged).

## Adding a new source adapter

1. Copy an existing adapter in `src/adapters/` (e.g. `jsonl.ts` for a JSONL log).
2. Implement the `Adapter` interface from `src/types.ts`: `detect(home)` and `scan(ctx)`.
3. Store a stable `rawRef` per event (uuid / rowid / `file:offset`) so re-scans dedupe.
4. Register the adapter in `src/adapters/index.ts`.
5. Add a synthetic fixture under `tests/fixtures/home/` and a test in `tests/adapters.test.ts`. Never commit real logs.

## PRs

- Small, single-purpose commits. One adapter or one feature per commit.
- `npm run build`, `npm run lint` and `npm test` must pass.
- Never commit real log data — fixtures must be synthetic.
