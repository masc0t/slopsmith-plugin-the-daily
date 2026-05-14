# Free-model prompt pack — The Daily plan-03 rollout

Each file in this directory is a self-contained prompt for a free coding model to implement one slice of the post-grill roadmap. Every prompt names exact files, exact verification commands, and an explicit out-of-scope list to keep weak models from drifting.

## Project state

The Daily plugin is **pre-release**. No production users, no shipped data. Schema migrations don't need to handle production balances or backfill. If anything tangles during a prompt, delete `the_daily.db` and let the next server start regenerate it from `_ensure_column` calls.

## How to use

Serial execution on the current branch (`map-mode`). One prompt at a time, in order:

1. Open opencode (or your free-model agent) in `plugins/the_daily/`.
2. Start a fresh session per prompt — do not reuse sessions, context bloats and the model drifts.
3. Paste the prompt file's contents verbatim as the first message.
4. Let the model implement. Approve tool calls as it edits the listed files.
5. Run the verification commands yourself before committing.
6. If verification fails: paste the failing output back, ask for a fix, re-verify.
7. `git commit` with a short subject mentioning the prompt id (`prompt 01: bip39 wordlist`).
8. Move to the next prompt.

No branches, no worktrees, no merge step. Each prompt's commit lands on `map-mode` directly.

## Order

Prompts are numbered in dependency order. Run 01 → 12.

| # | File | Touches | Depends on |
|---|---|---|---|
| 01 | `01-bip39-wordlist.md` | `static/bip39-4word.json` (new) | — |
| 02 | `02-cosmetics-css.md` | `static/cosmetics.css` (new), `screen.html` | — |
| 03 | `03-simulate-economy.md` | `simulate_economy.py` (new) | — |
| 04 | `04-stamp-svg-renderer.md` | `screen.js` (new section) | — |
| 05 | `05-recovery-code-backend.md` | `routes.py` | 01 |
| 06 | `06-supabase-mirror.md` | `routes.py` | 05 |
| 07 | `07-shop-endpoints.md` | `routes.py` | 06 |
| 08 | `08-passport-endpoint.md` | `routes.py` | — (independent of 05-07) |
| 09 | `09-remove-catchup.md` | `routes.py` | — (independent) |
| 10 | `10-recovery-code-frontend.md` | `screen.js`, `screen.html` | 05, 06 |
| 11 | `11-shop-frontend.md` | `screen.js`, `screen.html` | 02, 07 |
| 12 | `12-passport-frontend.md` | `screen.js`, `screen.html` | 04, 08 |

03 (simulate-economy) is a standalone tuning tool with no downstream consumers — could be deferred to whenever you actually want to tune prices, but running it in order is fine.

## ADR references

Every prompt cites the ADRs the free model must read first. ADRs live in `plans/adr/`:

- 0001 — recovery-code identity & local-primary mirror
- 0002 — solo-flex completionist shop (with peek-surface amendment)
- 0003 — bank-as-partial-grant
- 0004 — lane streak semantics

Plans live in `plans/01-04-*.md`. Each has a status header pointing at its ADRs.

## Verification

Every prompt includes verification commands. Free models often claim "done" prematurely — always run the verification before committing.

Common verifiers:

```bash
# Python parse check
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"

# JS parse check
node -c screen.js

# Pytest — run after backend changes
pytest tests/ -v

# SQLite schema check
sqlite3 the_daily.db ".schema TABLENAME"
```

## Out-of-scope guardrails

Every prompt has an "Out of scope" section. If the model edits files outside that list, reject the change and re-prompt with the boundary made bolder.

## If a prompt goes badly

- `git restore .` to throw away uncommitted changes from a bad run.
- `git restore <file>` to revert a single file.
- `git reset --hard HEAD` if the model committed something broken (use sparingly — only on the prompt's own commit, not on pre-existing work).

Each prompt is self-contained, so bailing on one and re-running it from a clean state is cheap.
