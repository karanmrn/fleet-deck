# Build methodology

This workflow adapts Michael Shimeles's Rasmic methodology to Fleet Deck.
It does not override the rules in [AGENTS.md](../../AGENTS.md).

## The four beats

1. **Isolate with `/new-feature`.** Start in a fresh worktree and task branch from
   `origin/main`. Verify that the current directory is your worktree before edits.
2. **Build with `/code-structure`.** Keep orchestration in `src/cli.ts` and
   `src/scan.ts`. Put reusable logic in the module that owns it. Use explicit inputs
   and structured returns from `src/types.ts`. See the repository map below.
3. **Prove with `/evidence-driven-testing`.** Capture the failing behavior before
   the fix and the working behavior after it. Run the local checks below. Use
   synthetic fixtures, CLI output pairs and dashboard captures as needed.
4. **Ship with `/before-and-after`, then `/greploop` or `/greploop-apps`.** Follow
   the completion list below for validation, PR evidence and review. Do not treat
   a local test pass as proof of remote CI or live provider behavior.

## Repository map and checks

- `package.json` defines the commands and requires Node.js >= 22.13.0.
  Run `npm run build`, `npm run lint` and `npm test`.
  [CONTRIBUTING.md](../../CONTRIBUTING.md) owns the development setup, privacy
  rules and adapter checklist. The CLI smoke run is in the root
  [Price table and billing](../../AGENTS.md#price-table-and-billing) section.
  Also check `node dist/cli.js doctor` and `node dist/cli.js export --toon`.
- `src/ledger.ts` owns the `node:sqlite` ledger at `~/.fleet-deck/ledger.db`.
  Use a task-owned database with `--db PATH` for experiments. Set `HOME` to a
  disposable copy of `tests/fixtures/home/` for smoke scans. Keep OpenRouter off
  with `FLEET_DECK_OPENROUTER=0`. Apply the same HOME and database to each smoke
  command. Do not scan a real home or publish real logs as test evidence.
- `src/adapters/index.ts` registers Claude Code, Prime, no-mistakes, gnhf, Codex,
  Cursor and the opt-in OpenRouter adapter. `src/types.ts` defines `Adapter` and
  `UsageEvent`. `src/adapters/jsonl.ts`, `src/adapters/sqlite.ts` and `src/redact.ts`
  own the shared source readers and redaction logic.
- `src/export.ts` builds the JSON and TOON payloads. `src/toon.ts` formats TOON.
  `src/cli.ts` exposes `export --json` and `export --toon`.
  [skills/fleet-deck/SKILL.md](../../skills/fleet-deck/SKILL.md) explains the payload.
- `src/server.ts` serves the dashboard at `http://localhost:4173`, with
  `/api/summary`, `/api/quota` and local uPlot assets. Start the built CLI with
  `node dist/cli.js serve --db PATH --port N` on a task-owned port.
  Use `chrome-devtools-axi` for browser evidence when the dashboard changes.
- `tests/adapters.test.ts`, `tests/scan.test.ts` and `tests/ledger.test.ts` cover
  ingestion and persistence. `tests/cli.test.ts` runs CLI and HTTP checks.
  `vitest.config.ts` supplies the `node:sqlite` test shim. The suite does not
  include a browser-rendering test, so HTTP success alone does not prove charts work.

### What local checks cannot prove

Synthetic fixtures cannot prove compatibility with every installed agent version
or reconcile real provider invoices. Cursor's local data has no token counts;
see `src/adapters/cursor.ts`. Live OpenRouter checks need explicit opt-in, a
management key and network access; see `src/adapters/openrouter.ts`. Live quota
checks need `quota-axi` and its provider access; see `src/quota.ts`.
Do not enable these services just to make a check pass. Report missing access and
untested behavior. GitHub CI and Greptile results require the remote services.

## Writing for humans

Run `/unslop` on text you add or change before you commit, post or send it.
This includes docs, comments, commit messages, PR text and the closing reply.
Use ASD-STE100 style: short sentences, concrete verbs and plain words.
Use a plain dash, never an em dash. Leave unchanged prose alone.

## Multi-agent rules

- Use one worktree and one branch per task and agent. Never commit to `main` or
  modify another agent's branch, worktree or uncommitted work.
- Before edits, check open PR files with `gh-axi pr list` and
  `gh-axi pr diff <n> --name-only`. Check for shared uncommitted work through the
  task coordinator. Stop and ask for direction if work overlaps.
- Never use plain `--force`. Use `--force-with-lease` only on your task branch
  when needed and only through the required push gate.
- Regenerate lockfiles to resolve conflicts. Do not merge them by hand.
- Worktrees share home directories, databases and ports. Use the isolated smoke
  setup above. Confirm that a dashboard port belongs to your process before use.
  Do not experiment on the shared ledger or source databases.
- Stop and report any conflict that you cannot resolve with confidence.

## Completing a task

1. Keep changes within the assigned scope. Preserve the privacy rules in
   `CONTRIBUTING.md` and the billing rules in root `AGENTS.md`.
2. Run the repository checks and relevant runtime checks above. Record failures,
   missing access and checks that you did not run.
3. Assemble before/after evidence. Use screenshots or video for dashboard changes
   and measured values or output pairs for CLI changes. For docs-only changes,
   explain the previous guidance and the new guidance. Do not invent runtime proof.
4. Run `/unslop`, commit with a clear message, rebase onto the latest
   `origin/main`, and rerun the checks on the final head.
5. Run no-mistakes validation on that head before any push or PR. In this fleet,
   only the pipeline push step may push. Outside the fleet, use
   `git push no-mistakes <branch>`. Never push directly to `origin`.
6. Open the PR with `gh-axi` or the pipeline PR step. Include what changed, test
   results, before/after evidence, risks and follow-up work in the body.
7. Run `/greploop` on the opened PR. Use `/greploop-apps` if the change exceeds
   Greptile's file-count limit. Continue until Greptile reports 5/5 with zero
   unresolved comments. Each fix cycle must commit and pass the push gate in
   step 5. Do not use the skill's default plain push command.
8. Report the PR URL and the actual local, CI and review results. A merge happens
   only on the captain's word. Keep the worktree until the PR is merged or closed.

## Skill sources

The source workflow is [Michael Shimeles's skills](https://github.com/michaelshimeles/skills),
with the [PubMax adaptation](https://github.com/Singularityszn/pubmax/blob/main/docs/agents/build-methodology.md)
as the reference. If a skill is unavailable, follow its steps above by hand.

- `new-feature`, `code-structure`, `evidence-driven-testing`, `before-and-after`,
  `greploop-apps`, `unslop`: `npx skills add michaelshimeles/skills -s "*"`.
- `greploop`: `npx skills add greptileai/skills@greploop`.
