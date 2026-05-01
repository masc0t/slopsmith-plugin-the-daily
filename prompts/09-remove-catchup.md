# Prompt 09 — Remove catch-up grant logic

## Goal

Strip the catch-up token grant (`2 × total_completions`, one-shot on first inventory load) and the `daily_inventory.retroactive_granted` plumbing. The Daily plugin is pre-release — there are no production balances to preserve, so this is a clean deletion.

## Read first

- `plans/03-tokens-shop-passport.md` (Open questions section)

## Files allowed to touch

- `routes.py`
- Any test files exercising the catch-up logic

## Spec

### 1. Find references

```bash
grep -n "retroactive_granted\|retroactive\|catch.up\|catchup\|catch_up" routes.py
grep -rn "retroactive\|catch.up\|catchup\|catch_up" tests/
```

### 2. Delete

- The `_ensure_column(_conn, "daily_inventory", "retroactive_granted", ...)` line.
- Any function that grants `2 * completion_count` based on `retroactive_granted IS 0`.
- Any setter that flips `retroactive_granted = 1` after the one-shot grant.
- Any callsite invoking the catch-up logic.
- Any test exercising the catch-up path.

If the catch-up logic is intertwined with a function that does other work, narrow the edit to remove only the catch-up portion — leave the rest alone.

The dev's local `the_daily.db` may already have the column. Either delete the file (pre-release, fair game) or leave the stale column — no code reads it after this PR.

## Verification

```bash
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"
pytest tests/ -v
grep -n "retroactive" routes.py        # should match 0
grep -rn "retroactive" tests/          # should match 0
```

## Out of scope

- Do not edit `screen.js`, `screen.html`, or any other file. Backend-only PR.
- Do not write any new migration logic. This is a pure deletion PR.
