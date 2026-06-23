# Solo-flex completionist shop, no rotation

## Status

accepted

## Context

Plan 03 introduces a token-spendable shop with two item categories: cosmetics (flair, map themes, lane skins, calendar art) and consumables (peeks, re-rolls). Of the cosmetic catalog, only flair is visible to other players (it appears next to leaderboard rows). Map themes, lane skins, and calendar art are seen exclusively by their owner. Slopsmith is a self-hosted single-player tool; the leaderboard is light social, not a core engagement loop.

## Decision

- **Shop framing is solo-flex, not social signaling.** The cosmetic payoff is intrinsic — the user dressing up their own map and passport — not social peacocking on a leaderboard.
- **Cosmetic catalog is finite and completionist.** Target ~23 items at ~20 tokens average, completable in roughly 30 days of normal play (~15 tokens/day earn rate). End-state: "I own everything."
- **No weekly rotation, no seasonal drops, no FOMO.** The static catalog dict in `routes.py` is the catalog. Full stop.
- **Consumables remain infinite.** The engaged player who has owned everything cosmetic still has re-rolls and peeks to spend on. Consumables execute on buy (no inventory) — relevant because most peeks are time-relative and stocking them is meaningless.
- **Map shop nodes pay rent.** Clicking a shop node on the map opens a deterministic 3-item offer (seeded by `(date, node_id)`) at a 10% discount. The nav button opens the full catalog at full price. This gives the shop node mechanical weight without inventing exclusive items.
- **Shop sells no information.** Peeks (`tomorrow_modifier`, `mystery_event_hint`, etc.) live exclusively at treasure nodes (plan 02), never in the shop catalog. The shop is for re-rolls and cosmetics only. Rationale: information consumables are inherently time-relative — banking a "tomorrow modifier peek" for next year is nonsense — and selling them at the shop creates a redundancy with treasure peeks that confuses both surfaces. Treasure node = the single foresight slot per day; shop = persistent dress-up and re-rolls.

## Considered alternatives

- **Treadmill catalog with weekly rotation.** Standard live-service hook. Rejected: contradicts solo-flex framing, adds scheduling infra, punishes async players who can't browse on rotation day.
- **Hybrid social-driven catalog with heavy flair investment.** Rejected: leaderboard is not the core loop, over-investing in flair variety would mis-prioritize against the passport which *is* the emotional destination.
- **Calendar-art-by-month gating** (each month's art unlocks only during that calendar month). Considered but rejected for V1: couples shop to the clock, punishes users who install mid-year and miss months. Tempting V2 if shop feels stale, but build on demand, not speculatively.
- **Map shop node = pure UI shortcut to the nav shop.** Rejected: makes shop node ludonarratively dead — every other map node has consequences, this one would not.

## Consequences

- The fully-completed user has a dead-end shop for cosmetics. Acceptable because consumables remain infinite and the passport — not the shop — is the persistent emotional surface.
- Pricing is permitted to be relaxed because there is no social pressure to chase items. `simulate_economy.py` only needs to confirm the ~30-day completion target, not balance against churn metrics.
- A future shift to social framing (e.g. if a Discord-OAuth V2 lands and leaderboard becomes more central) would require reopening this ADR. The cosmetic data shape supports either direction; only the catalog tuning and rotation policy would change.
