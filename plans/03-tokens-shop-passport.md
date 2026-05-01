# Plan: Tokens, Cosmetic Shop, and Passport

> **Status: amended by ADR-0001 (recovery-code identity), ADR-0002 (solo-flex completionist shop), ADR-0003 (bank-as-partial-grant).** Inline corrections below mark where plan recommendations were superseded.

The persistent meta layer. Tokens are earned by playing dailies; spent on foresight, cosmetics, and quality-of-life. The Passport is a visual record of every daily walked, every lane mastered, every milestone hit.

**Hard rule**: tokens never buy anything that changes how a song plays. They buy *information*, *cosmetics*, and *re-rolls* of map structure (which song is at a node) — never of song behavior.

## Goal

- Daily play accrues tokens; the count visibly grows.
- A small shop screen rotates a curated set of buyable items.
- A passport screen shows the user's history at a glance — months of dailies as a single illustration.
- All three live across days; nothing about them resets.

## Token economy

### Earning

| Source                                 | Tokens |
|----------------------------------------|--------|
| Each song completed                    | 2      |
| Boss completed                         | 5      |
| Full map cleared (all optional nodes)  | 5 bonus|
| First lane streak of 3 (once total)    | 10     |
| Lane streak milestones (every 7)       | 10     |
| Global streak milestones (every 7)     | 10     |
| Elite cleared (per plan 01 future)     | 3      |

**Grant model: buffered, reconciled at boss clear.** No per-event writes during the day. Single `daily_token_ledger` row per day with `reason = "day_complete:{date}"`, idempotent on PK. Plan 02's Bank Progress action is the exception — it writes early and the boss reconcile subtracts banked totals (see ADR-0003). Multi-row days are expected when banking happens.

**"First lane streak of 3" fires once total across all lanes**, not once per lane. Otherwise sampling 5 lanes at depth 3 = 50 tokens for free. Resolved during grill; plan-as-originally-written was ambiguous.

Numbers are illustrative and need balancing against shop prices. Goal: ~10–15 tokens per day if you complete, ~25 if you go full-clear.

### Spending (V1 catalog, post-grill)

| Item                              | Cost | Effect                                                   |
|-----------------------------------|------|----------------------------------------------------------|
| Boss re-roll                      | 8    | Existing item, repriced.                                 |
| Lane re-roll (today)              | 12   | Re-rolls non-boss songs on a single lane.                |
| Profile flair pack                | 15   | Cosmetic — unlocks a flair set.                          |
| Alternate map theme               | 25   | Cosmetic — repaints the map.                             |
| Lane skin                         | 20   | Cosmetic — recolors one lane.                            |
| Calendar art (per month)          | 10   | Cosmetic — passport background for the current month.    |

**Dropped:** "Tomorrow modifier peek" (4 tok) and "Mystery event hint" (3 tok). Peeks live exclusively at treasure nodes — the shop sells no information consumables. See ADR-0002 amendment.

**Map shop nodes** offer a deterministic 3-item subset of the catalog at **10% discount**, seeded by `(date, node_id)`. Nav-screen shop is the full catalog at full price.

**Consumables execute on buy** — no inventory state, no `/use` endpoint. Buy = result. Cosmetics still inventory-stocked (ownership is permanent). See ADR-0002.

Numbers are starting points. Tune via `preview.py` simulating a typical week of token earn vs. spend. Target: ~30 days normal play to complete the cosmetic catalog (~460 tokens at ~15/day).

## Passport

The Passport is a single screen showing the user's full Daily history:

- A grid: rows = months, columns = days. Each cell = 1 day.
- Cell content = compact icon stack: lane glyph + boss-cleared check + small dot if any optional nodes cleared.
- Hovering a cell shows: day name, modifier, songs played, lane committed, boss song, streak at that point.
- Stamp shelf below the grid: lane mastery stamps (Sprint 10, Marathon 25, Drop 50), modifier stamps (one for each unique modifier seen), decade stamps, etc.
- Top strip: total dailies played, longest streak, current streak, total tokens earned (lifetime).

Stamps are unlocks but not gated — they reveal automatically when you cross the threshold. No "claim" step.

## Data model

### Local SQLite

Local SQLite is the **source of truth**. Supabase mirrors via a 4-word recovery code as the lookup key — see ADR-0001.

```sql
-- Add tokens to existing daily_inventory
ALTER TABLE daily_inventory ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_inventory ADD COLUMN cosmetics TEXT NOT NULL DEFAULT '[]';  -- JSON array of {id, purchased_at} entries
ALTER TABLE daily_inventory ADD COLUMN equipped TEXT NOT NULL DEFAULT '{}';   -- JSON: { "flair": "...", "map_theme": "...", ... }
ALTER TABLE daily_inventory ADD COLUMN recovery_code TEXT;                    -- 4-word BIP39-style; gen on first launch

-- Stamps earned
CREATE TABLE IF NOT EXISTS daily_stamps (
    install_id TEXT NOT NULL,
    stamp_id TEXT NOT NULL,
    earned_date TEXT NOT NULL,
    PRIMARY KEY (install_id, stamp_id)
);

-- Token ledger (audit trail for debugging)
CREATE TABLE IF NOT EXISTS daily_token_ledger (
    install_id TEXT NOT NULL,
    date TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The ledger is for debugging only — if a user reports "my tokens disappeared" we can replay it. Never surfaced to UI. **Local-only — does not sync to Supabase mirror.**

### Cosmetic ids

Hard-coded server-side dict, similar to `MODIFIERS`:

```python
COSMETICS = {
    "flair_neon": {"type": "flair", "cost": 15, "name": "Neon", "css_class": "flair-neon"},
    "map_theme_papercraft": {"type": "map_theme", "cost": 25, "name": "Papercraft"},
    ...
}
```

Frontend reads `equipped` and applies the corresponding CSS class to the relevant container.

## Backend

### Endpoints

- `GET /api/plugins/the_daily/inventory` — returns `{tokens, cosmetics, equipped, stamps}`.
- `GET /api/plugins/the_daily/shop` — returns the static catalog plus an `affordable: bool` flag per item.
- `POST /api/plugins/the_daily/shop/buy {item_id}` — debits tokens, grants the item. Idempotent for cosmetics (re-buying an owned cosmetic is a no-op). For consumables (peeks, re-rolls), each buy stocks the inventory.
- `POST /api/plugins/the_daily/equip {slot, cosmetic_id}` — sets `equipped[slot]`. Validates ownership.
- `GET /api/plugins/the_daily/passport` — returns the grid: list of `{date, day_name, modifier, lane, boss_done, full_clear, streak_at}`.

### Token grants

Hook into existing completion flow. `_award_inventory_for_completion` already runs on `/mark`. Extend it to also grant tokens to `daily_inventory.tokens` and write a row to `daily_token_ledger`.

Stamp checks run after every grant — cheap query against `daily_completions` aggregates.

### Stamp definitions

V1 catalog = **14 stamps** (trimmed from full programmatic set to give early-game payoff):

| Category | V1 stamps | Earnable in |
|---|---|---|
| First-time milestones | "First Daily", "First Boss", "First Full Clear", "First Sign" | Day 1 |
| Streak | 3, 7, 30 | Within month |
| Lane × Sprint/Marathon/Drop only | 10 each (skip Flat, Decade for V1) | ~10 days each lane |
| Decade — Top 3 | 1970s, 1980s, 1990s only | Days they roll |
| Modifier | "Saw All Modifiers" once-only meta-stamp | Long-tail |

V2 layers on remaining lane stamps, all decades, per-modifier stamps.

**Art pipeline: programmatic SVG.** Three primitives: tier frame (bronze/silver/gold), glyph layer (lane emoji / decade / modifier icon), threshold ribbon. New stamp categories = new glyph mapping in JS, zero asset work.

```python
STAMPS = {
    "first_daily":      {"check": lambda agg: agg["completions"] >= 1, "name": "First Daily"},
    "lane_sprint_10":   {"check": lambda agg: agg["lane_clears"]["sprint"] >= 10, "name": "Sprint Master"},
    "decade_1980s":     ...,
    "streak_7":         ...,
    "modifier_seen_all": ...,
    ...
}
```

Mass-define stamps programmatically where possible (per-modifier, per-decade, per-lane × milestones) — V2 expansion.

## Frontend

### Token counter

- Small chip in the Daily nav header: `🪙 47`.
- Animates `+N` when granted.

### Shop screen

- New view in screen.html (`#ds-shop`). Reachable from the setlist screen (a button next to the leaderboard button) and from any shop node on the map.
- Item cards: icon, name, description, cost, [Buy] button (greyed if can't afford or already owned).
- Categories: Foresight / Re-rolls / Cosmetics. Tabs.

### Passport screen

- New view (`#ds-passport`). Reachable from a calendar icon in the nav.
- Grid layout: months stacked, days within months. Visual style matches the existing dark theme.
- Tooltip on cell hover shows the day's metadata.
- Stamp shelf below: scrollable horizontal strip of stamp tiles. Locked stamps show as silhouettes with progress (`Sprint Master 7 / 10`).

### Cosmetic application

- `flair` — appended to the user's leaderboard row (CSS class).
- `map_theme` — added as class on `<svg>` map container; CSS in screen.html overrides node colors.
- `lane_skin` — overrides `--lane-{name}` CSS variable on `<body>` or container.
- `calendar_art` — background image on Passport grid cells for the current month.

All cosmetic CSS lives in `static/cosmetics.css` (separate file, not inline in screen.html). All Daily UI wraps in `<div class="daily-root">` — equipped slots set classes on that root (`<div class="daily-root theme-papercraft skin-neonsprint flair-glow">`), keeping cosmetics scoped to the plugin and out of other Slopsmith plugins. New cosmetics ship as new CSS classes, no JS changes needed.

## Rollout

1. **Schema + ledger**: ship invisibly. Tokens accrue but no UI shows them.
2. **Token counter** in nav. Dummy +N animations on completion.
3. **Shop V1** — peeks and re-rolls only (no cosmetics). Validates the spend loop.
4. **Cosmetics V1** — flair + 1 map theme + 1 lane skin. Proves the equip pipeline.
5. **Passport V1** — read-only history grid + basic stamps (lane masteries, streak milestones).
6. **Passport V2** — modifier stamps, decade stamps, calendar art tier of cosmetics.

Each step is independent and shippable.

## Open questions

- **Tokens on Supabase?** **Resolved — recovery-code mirror (ADR-0001).** Local SQLite is source-of-truth; Supabase mirrors via 4-word recovery code shown once on first launch. Single-identity, last-write-wins. Push triggers on boss clear, shop purchase, equip change, stamp earn, app close (debounced 2s). Pull only on first paste of code or "force re-sync" button.
- **Catch-up tokens for existing users**: **Resolved — no catch-up grant.** Fresh start for everyone when feature lands. Power users start at 0 tokens like everyone else. Reasoning during grill: `2 × completions` for a 200-day power user = entire cosmetic catalog day-1, kills the shop loop the catch-up was meant to reward.
- **Pricing balance**: needs a `simulate_economy.py` that walks N days of typical play and sums earn/spend. Target: ~30 days normal play to complete cosmetic catalog. Build before shipping V1 of the shop.
- **Shop rotation**: **Resolved — no rotation, ever.** Solo-flex framing (ADR-0002) doesn't need FOMO. Static catalog dict in `routes.py`. Map shop node's deterministic 3-item discount subset is the only "rotation."
- **Refund button**: **Resolved — 60s refund window for cosmetics only.** Consumables execute on buy and can't be refunded (already revealed/used). `purchased_at` in `cosmetics` JSON, refund endpoint checks `now - purchased_at < 60`.
- **Passport export**: future — render the grid as a PNG/SVG share card. Out of scope for V1.
- **Banking from rest nodes** (plan 02) — see ADR-0003. Bank rows in ledger have `reason = "rest_bank"`; boss reconcile row has `reason = "day_complete:{date}"`. Multi-row days are expected when banking happens.
