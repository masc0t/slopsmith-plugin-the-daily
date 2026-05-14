# Prompt 03 — simulate_economy.py

## Goal

A standalone Python script that simulates N days of typical play and reports total tokens earned, total tokens spent (against a configurable shop catalog), and the day-by-day balance trajectory. Used to tune shop prices and grant rates against the target "complete the V1 cosmetic catalog in ~30 days of normal play."

## Read first

- `plans/adr/0002-solo-flex-completionist-shop.md`
- `plans/adr/0003-bank-as-partial-grant.md`
- `plans/03-tokens-shop-passport.md` (Token economy section, post-amendment)
- `preview.py` (existing pattern — imitate its arg parsing + output style)

## Files allowed to touch

- `simulate_economy.py` (new file at plugin root)

## Spec

CLI:

```bash
python simulate_economy.py --days 30 --completion-rate 0.85 --bank-rate 0.1
python simulate_economy.py --days 90 --completion-rate 0.7 --shop-strategy completionist
python simulate_economy.py --days 30 --json > snapshot.json
```

Args:

- `--days N` (default 30) — number of simulated days.
- `--completion-rate FLOAT` (default 0.85) — probability the user clears the boss on a given day.
- `--full-clear-rate FLOAT` (default 0.4) — conditional probability of full-clear given completion.
- `--bank-rate FLOAT` (default 0.0) — probability of banking at a rest node before boss clear.
- `--shop-strategy STR` (default `completionist`) — `completionist` (buy each cosmetic once when affordable, cheapest first) or `consumer` (spend any surplus on re-rolls/peeks).
- `--json` — emit machine-readable output instead of human table.

Token grant model (from ADR-0003 + plan 03):

- Per song completed: 2 tok at boss reconcile.
- Boss completed: 5 tok.
- Full map cleared: 5 tok bonus.
- First lane streak of 3 (once total): 10 tok.
- Lane streak milestone (every 7): 10 tok.
- Global streak milestone (every 7): 10 tok.

Bank model (ADR-0003): on a banking day, partial grant `2 * cleared_count` early; reconcile subtracts banked totals. Net cap unchanged across the day. So total tokens earned per completed day = `3 * cleared + 5 + bonuses`, regardless of whether banked.

V1 cosmetic catalog (from plan 03 amended):

```python
CATALOG = {
    "boss_reroll":     {"cost": 8,  "type": "consumable"},
    "lane_reroll":     {"cost": 12, "type": "consumable"},
    "flair_glow":      {"cost": 15, "type": "cosmetic"},
    "theme_papercraft":{"cost": 25, "type": "cosmetic"},
    "skin_neonsprint": {"cost": 20, "type": "cosmetic"},
    "calendar_pastel": {"cost": 10, "type": "cosmetic"},
    # 12 months of calendar art, but for V1 simulate only one slot
}
```

Output (default human format):

```
Simulating 30 days @ completion=0.85 full-clear=0.40 bank=0.00 strategy=completionist

Day  Cleared  Earned  Spent  Balance  Bought
  1    5       20       0      20    -
  2    5       20      15       5    flair_glow
  ...
 30    5       25      25      18    -

Totals:
  Days played:        30
  Days completed:     26 (87%)
  Tokens earned:      612
  Tokens spent:       82
  Final balance:      530
  Cosmetics owned:    4 / 4
  Days to full-cosmetic catalog: 18

Tuning notes:
  Target ~30 days for full cosmetic catalog. Current: 18 days. Catalog priced too cheap, OR earn rate too high.
```

`--json` output: `{days, params, daily: [{day, cleared, earned, spent, balance, bought}], totals: {...}}`.

Determinism: seed RNG from `--seed N` (default 42) so runs are reproducible.

## Verification

```bash
python simulate_economy.py --days 30
python simulate_economy.py --days 30 --json | python -c "import json, sys; d = json.load(sys.stdin); assert d['totals']['days_played'] == 30; print('OK')"
python simulate_economy.py --days 30 --seed 42
python simulate_economy.py --days 30 --seed 42  # second run, same output
```

The two `--seed 42` runs must produce identical balances day-by-day.

## Out of scope

- Do not touch `routes.py`, `preview.py`, or any other file.
- Do not connect to the real `the_daily.db` — simulate purely in memory.
- Do not implement passport stamps or lane-streak math — too detailed for V1 simulator. Just count completions, lane variety, and tokens.
- Do not write integration tests; the verification commands above suffice.
- Do not invent new cosmetic types. Stick to the catalog above.
