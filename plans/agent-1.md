# Agent 1 — Fix routes.py

Fix three bugs in `C:\Users\jimey\slopsmith\plugins\the_daily\routes.py`.

## Bug 1 — missing `@app.get` decorator on `get_mystery_event`

Around line 3719, the function `def get_mystery_event(node_id: str, request: Request):` is defined directly after the closing of `post_rest`, with no FastAPI decorator. Add `@app.get("/api/plugins/the_daily/mystery/{node_id}")` immediately above it. Confirm by checking `grep -n '@app\.' routes.py` shows the new decorator next to the function. The function body is correct — only the decorator is missing.

## Bug 2 — missing `CREATE TABLE` statements for `daily_stamps` and `daily_token_ledger`

The code at lines 542, 586, 3125, 3289 reads/writes `daily_stamps`; lines 605, 1778, 3179, 3296 read/write `daily_token_ledger`. Neither table is created. In the schema init block (around line 632, where the other `CREATE TABLE IF NOT EXISTS` statements live), add:

```sql
CREATE TABLE IF NOT EXISTS daily_stamps (
    install_id TEXT NOT NULL,
    stamp_id TEXT NOT NULL,
    earned_date TEXT NOT NULL,
    PRIMARY KEY (install_id, stamp_id)
);

CREATE TABLE IF NOT EXISTS daily_token_ledger (
    install_id TEXT NOT NULL,
    date TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

These are documented in `plans/03-tokens-shop-passport.md`.

## Bug 3 — token storage split-brain in `post_rest` bank action

Around line 3711, `post_rest` writes banked tokens by appending a string `"token:N"` to the items JSON array:

```python
items.append("token:{}".format(tokens))
UPDATE daily_inventory SET items = ?, ...
```

Every other code path uses the integer column `daily_inventory.tokens` (see lines 601, 1774, 3175). Change `post_rest` to do the same:

- `UPDATE daily_inventory SET tokens = tokens + ? WHERE install_id = ?`
- `INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, 'rest_bank')`

Remove the `items.append` line and the items-JSON `UPDATE`. Keep the `daily_node_actions` row that records the bank event.

## Verification

- `python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"` should succeed.
- `grep -n 'CREATE TABLE IF NOT EXISTS daily_stamps' routes.py` and same for `daily_token_ledger` should each return one match.
- `grep -n '@app.get.*mystery' routes.py` should show the decorator.
- `grep -n 'items.append("token' routes.py` should return nothing.

## Out of scope

Do not touch `screen.js`, `screen.html`, or any other file. Do not delete the scratch files at the repo root — the user will handle those.
